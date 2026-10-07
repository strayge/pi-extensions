/**
 * `/usage` and the `usage` status: how much of the current account's quota is
 * left, for the provider the active model belongs to.
 *
 * Scoped deliberately to the *current* account. Auth is resolved before every
 * query and its fingerprint keys the cache, so a credential change is a cache
 * miss rather than a stale reading, and no report can be served across
 * accounts. A query that finishes after the model has moved on is discarded.
 */

import { randomUUID } from "node:crypto";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_FILE_NAME,
  configPath,
  defaultDisplayConfig,
  loadDisplayConfig,
  saveDisplayConfig,
} from "./config.ts";
import { awaitWithDeadline, errorMessage, sanitizeDisplayText, UsageCache } from "./core.ts";
import { showDisplayMenu } from "./display-menu.ts";
import { formatProviderState, formatUsageSegments, formatUsageStatusline } from "./format.ts";
import { loadHistory } from "./history.ts";
import { showUsageHistory } from "./history-menu.ts";
import { isCodexProvider } from "./providers/codex.ts";
import {
  adapterForProvider,
  isStaleExtensionContextError,
  queryProviderUsage,
  redeemCodexResetCredit,
  resolveUsageAuth,
} from "./query.ts";
import { PendingRedemptionStore, REDEMPTION_STATE_FILE_NAME } from "./redemption-store.ts";
import { sampleUsageReport } from "./sample.ts";
import {
  createUsageSnapshot,
  deriveUsageSnapshotIdentity,
  SNAPSHOT_ENTRY_TYPE,
} from "./snapshot.ts";
import { SPEED_RANGES, showSpeedReport, speedRange } from "./speed.ts";
import { registerSpeedStatus } from "./speed-status.ts";
import { applyUsageSlotOptions, usageSlotDefaults, usageSlotFields } from "./statusline-schema.ts";
import { publishStatuslineItem, registerStatuslineSlot } from "./statusline-slot.ts";
import type {
  CodexResetCreditRedemption,
  PiModel,
  ProviderUsageState,
  UsageDisplayConfig,
  UsageProviderAdapter,
  UsageReport,
  UsageSnapshotIdentity,
} from "./types.ts";

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const FAILURE_BACKOFF_MS = 30_000;
/** Enough for a few rotating credentials; keeps the map from growing forever. */
const MAX_REMEMBERED_FAILURES = 8;
const STATUS_KEY = "usage";

const REFRESH = "Refresh usage";
const USE_RESET = "Use one reset…";
const RETRY_RESET = "Retry using reset…";
const HISTORY = "Statistics";
const DISPLAY = "Display options…";
const CLOSE = "Close";

type QueryOutcome = {
  state: ProviderUsageState;
  fingerprint?: string;
  accountKey?: string;
  identity?: UsageSnapshotIdentity;
};

type LoaderResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

type HistoryOperations = {
  load: typeof loadHistory;
  show: typeof showUsageHistory;
};

export default function usageExtension(
  pi: ExtensionAPI,
  history: HistoryOperations = { load: loadHistory, show: showUsageHistory },
) {
  // Mirrors every status write onto the statusline slot bus. No placement hint
  // is sent: without one the slot lands wherever plain statuses land today, and
  // a user who wants it elsewhere names it in their statusline config.
  const publishSlot = publishStatuslineItem(pi, { id: STATUS_KEY });
  const cache = new UsageCache(CACHE_TTL_MS);
  const failures = new Map<string, { until: number; message: string }>();
  const pendingRedemptions = new PendingRedemptionStore();

  // Re-read at session start, so an edit to usage.json lands on the next
  // session without a restart.
  let display: UsageDisplayConfig = defaultDisplayConfig();
  let displayWarnings: string[] = [];
  const reloadDisplayConfig = () => {
    try {
      const loaded = loadDisplayConfig();
      display = loaded.config;
      displayWarnings = loaded.warnings;
    } catch (error) {
      display = defaultDisplayConfig();
      displayWarnings = [errorMessage(error)];
    }
  };
  reloadDisplayConfig();

  let sessionActive = false;
  let snapshotWarningShown = false;
  /** What the status shows and which model it describes, so a refresh for that
   * same model can leave it standing instead of blinking through "checking". */
  let shown: { text: string | undefined; model: string | undefined } = {
    text: undefined,
    model: undefined,
  };
  /** The last reading, kept so the statusline can re-render it under different
   *  options without a query — `render` is called on every paint. */
  let latest: { report: UsageReport; model: PiModel | undefined } | undefined;

  /**
   * Offer the display options to a statusline that can edit them.
   *
   * `render` is pure and synchronous by contract — it draws the last reading,
   * never queries — because the statusline calls it on every paint and again
   * for each keypress in its layout editor, with values the user has not
   * committed yet. Substituting the sample report while previewing is what makes
   * that editor usable before the first query has come back.
   */
  const statuslineSlot = registerStatuslineSlot(pi, {
    id: STATUS_KEY,
    version: 1,
    fields: usageSlotFields(),
    defaults: () => usageSlotDefaults(display),
    render: (options, env) => {
      const report = latest?.report ?? (env.preview ? sampleUsageReport() : undefined);
      if (!report) return undefined;
      return formatUsageSegments(
        report,
        latest?.model,
        applyUsageSlotOptions(display, options),
        Date.now(),
      );
    },
    // The statusline owns the values; this keeps `usage.json` in step so the
    // `/usage` report and a stock pi footer agree with what the bar shows.
    onOptions: (options) => {
      const next = applyUsageSlotOptions(display, options);
      display = next;
      try {
        saveDisplayConfig(next);
      } catch {
        // A read-only config directory costs the persistence, not the session:
        // the values are still live, and the statusline holds its own copy.
      }
    },
  });
  /** Monotonic: only the newest refresh may publish its result. */
  let refreshId = 0;
  let refreshController: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** The open menu, if any, so shutdown can close it. Only one can be open. */
  let menuController: AbortController | undefined;
  let speedController: AbortController | undefined;

  const clearRefreshTimer = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };

  const safeSetStatus = (
    ctx: ExtensionContext,
    value: string | undefined,
    model?: PiModel,
  ): boolean => {
    try {
      ctx.ui.setStatus(STATUS_KEY, value);
      publishSlot(value);
      shown = { text: value, model: modelIdentity(model) };
      return true;
    } catch (error) {
      if (isStaleExtensionContextError(error)) return false;
      throw error;
    }
  };

  /**
   * Opens a refresh without disturbing a reading the user is already looking
   * at: overwriting it with "checking" made the entry flicker on every turn,
   * since a cache hit puts the same text back a frame later. A first run or a
   * model change has nothing worth keeping, so those still say "checking".
   *
   * Rewriting the unchanged value keeps this a probe for a stale context, which
   * is what the caller checks before spending a query.
   */
  const markChecking = (ctx: ExtensionContext, model: PiModel): boolean =>
    shown.text !== undefined && shown.model === modelIdentity(model)
      ? safeSetStatus(ctx, shown.text, model)
      : safeSetStatus(ctx, "checking");

  const cancelRefresh = () => {
    refreshId += 1;
    refreshController?.abort();
    refreshController = undefined;
    clearRefreshTimer();
  };

  const scheduleRefresh = (ctx: ExtensionContext, model: PiModel) => {
    clearRefreshTimer();
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (sessionActive) startRefresh(ctx, model, true);
    }, CACHE_TTL_MS);
    refreshTimer.unref?.();
  };

  const rememberFailure = (key: string, message: string) => {
    const now = Date.now();
    for (const [candidate, failure] of failures) {
      if (failure.until <= now) failures.delete(candidate);
    }
    while (failures.size >= MAX_REMEMBERED_FAILURES) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
    failures.set(key, { until: now + FAILURE_BACKOFF_MS, message });
  };

  const recentFailure = (key: string): string | undefined => {
    const failure = failures.get(key);
    if (!failure) return undefined;
    if (failure.until > Date.now()) return failure.message;
    failures.delete(key);
    return undefined;
  };

  const redemptionIdFor = (accountKey: string): string =>
    pendingRedemptions.getOrCreate(accountKey, randomUUID());

  const state = (
    adapter: UsageProviderAdapter,
    status: "auth-unavailable" | "query-failed",
    message: string,
  ): ProviderUsageState => ({
    providerId: adapter.id,
    providerName: adapter.displayName,
    displayState: "current",
    status,
    message,
  });

  /**
   * Resolve auth, then answer from cache or the provider.
   *
   * The order matters: the fingerprint comes from freshly resolved auth, so a
   * report fetched for another account can never be served for this one.
   */
  const queryUsage = async (
    ctx: ExtensionContext,
    model: PiModel | undefined,
    force: boolean,
    signal: AbortSignal,
  ): Promise<QueryOutcome> => {
    const adapter = adapterForProvider(model?.provider);
    if (!adapter) {
      const providerId = model?.provider ?? "none";
      return {
        state: {
          providerId,
          providerName: providerDisplayName(ctx, providerId),
          displayState: "current",
          status: "unsupported",
          message: model
            ? `Usage reporting is not supported for ${providerDisplayName(ctx, providerId)}.`
            : "No model is selected.",
        },
      };
    }

    const startedAt = Date.now();
    let auth: Awaited<ReturnType<typeof resolveUsageAuth>>;
    try {
      auth = await awaitWithDeadline(
        resolveUsageAuth(ctx, adapter),
        signal,
        DEFAULT_TIMEOUT_MS,
        `resolving ${adapter.displayName} runtime auth`,
      );
    } catch (error) {
      if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
      const status = isTimeoutError(error) ? "query-failed" : "auth-unavailable";
      return { state: state(adapter, status, errorMessage(error)) };
    }

    if (!auth) {
      return {
        state: state(
          adapter,
          "auth-unavailable",
          `No runtime credential is configured for ${adapter.displayName}.`,
        ),
      };
    }

    const identity = deriveUsageSnapshotIdentity(adapter.id, auth);
    const resolvedAuth = {
      fingerprint: auth.fingerprint,
      accountKey: auth.accountKey,
      identity,
    };
    const ready = (report: Parameters<typeof formatUsageStatusline>[0]): QueryOutcome => ({
      state: {
        providerId: adapter.id,
        providerName: adapter.displayName,
        displayState: "current",
        status: "ready",
        report,
      },
      ...resolvedAuth,
    });

    if (!force) {
      const cached = cache.get(adapter.id, auth.fingerprint);
      if (cached) return ready(cached);

      const failed = recentFailure(`${adapter.id}:${auth.fingerprint}`);
      if (failed) {
        return {
          state: state(adapter, "query-failed", failed),
          ...resolvedAuth,
        };
      }
    }

    let report: UsageReport;
    try {
      const remainingMs = Math.max(1, DEFAULT_TIMEOUT_MS - (Date.now() - startedAt));
      report = await queryProviderUsage(adapter, auth, signal, remainingMs);
    } catch (error) {
      if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
      const message = errorMessage(error);
      rememberFailure(`${adapter.id}:${auth.fingerprint}`, message);
      return {
        state: state(adapter, "query-failed", message),
        ...resolvedAuth,
      };
    }

    signal.throwIfAborted();
    cache.set(adapter.id, auth.fingerprint, report);
    failures.delete(`${adapter.id}:${auth.fingerprint}`);
    if (modelIdentity(ctx.model) === modelIdentity(model)) {
      try {
        pi.appendEntry(SNAPSHOT_ENTRY_TYPE, createUsageSnapshot(report, auth));
      } catch (error) {
        if (isStaleExtensionContextError(error)) throw error;
        // History failure must not turn a valid provider reading into a query failure.
        if (!snapshotWarningShown) {
          snapshotWarningShown = true;
          ctx.ui.notify("Could not save usage snapshot to the session.", "warning");
        }
      }
    }
    return ready(report);
  };

  const publishStatus = (ctx: ExtensionContext, outcome: QueryOutcome, model: PiModel) => {
    if (outcome.state.status === "unsupported") {
      clearRefreshTimer();
      latest = undefined;
      safeSetStatus(ctx, undefined);
      return false;
    }
    if (outcome.state.status !== "ready") {
      const label =
        outcome.state.status === "auth-unavailable" ? "auth unavailable" : "usage error";
      return safeSetStatus(ctx, label, model);
    }
    // Kept for the statusline's own renderer, which redraws this reading under
    // whatever options its config carries.
    latest = { report: outcome.state.report, model };
    return safeSetStatus(ctx, formatUsageStatusline(outcome.state.report, model, display), model);
  };

  const refreshStatus = async (
    ctx: ExtensionContext,
    model: PiModel | undefined,
    force: boolean,
  ) => {
    if (!model || !adapterForProvider(model.provider)) {
      cancelRefresh();
      safeSetStatus(ctx, undefined);
      return;
    }

    refreshId += 1;
    const id = refreshId;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;

    try {
      if (!markChecking(ctx, model)) return;
      const outcome = await queryUsage(ctx, model, force, controller.signal);
      // A newer refresh, a shutdown, or a model change since we started: the
      // answer describes a state the user has already left.
      if (id !== refreshId || !sessionActive || controller.signal.aborted) return;
      if (modelIdentity(ctx.model) !== modelIdentity(model)) return;
      if (publishStatus(ctx, outcome, model)) scheduleRefresh(ctx, model);
    } finally {
      if (refreshController === controller) refreshController = undefined;
    }
  };

  const startRefresh = (ctx: ExtensionContext, model: PiModel | undefined, force: boolean) => {
    void refreshStatus(ctx, model, force).catch((error) => {
      if (isStaleExtensionContextError(error) || isAbortError(error)) return;
      safeSetStatus(ctx, "usage error");
    });
  };

  /** Runs one query behind an abortable loader so Escape cancels it. */
  const runWithLoader = async <T>(
    ctx: ExtensionCommandContext,
    label: string,
    parentSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> => {
    if (ctx.mode !== "tui") return operation(parentSignal);
    const result = await ctx.ui.custom<LoaderResult<T> | null>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, label);
      let finished = false;
      const finish = (value: LoaderResult<T> | null) => {
        if (finished) return;
        finished = true;
        done(value);
      };
      loader.onAbort = () => finish(null);
      const signal = AbortSignal.any([parentSignal, loader.signal]);
      void operation(signal)
        .then((value) => finish({ ok: true, value }))
        .catch((error) => {
          if (isAbortError(error)) finish(null);
          else finish({ ok: false, error });
        });
      return loader;
    });
    if (!result) return undefined;
    if (!result.ok) throw result.error;
    return result.value;
  };

  const displayConfigPath = (): string => {
    try {
      return configPath();
    } catch {
      return CONFIG_FILE_NAME;
    }
  };

  /**
   * Adopt a display change: persist it, then repaint the live status so the
   * effect is visible behind the dialog rather than only on the next refresh.
   */
  const applyDisplayConfig = (
    ctx: ExtensionCommandContext,
    next: UsageDisplayConfig,
    outcome: QueryOutcome | undefined,
    model: PiModel | undefined,
  ): UsageDisplayConfig => {
    display = next;
    try {
      saveDisplayConfig(next);
    } catch (error) {
      ctx.ui.notify(`Could not save usage display options: ${errorMessage(error)}`, "warning");
    }
    statuslineSlot.refresh();
    if (outcome && model && modelIdentity(ctx.model) === modelIdentity(model)) {
      publishStatus(ctx, outcome, model);
    }
    return display;
  };

  const showMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!ctx.hasUI) {
      ctx.ui.notify("/usage requires an interactive Pi mode.", "warning");
      return;
    }

    // The command owns the account question while it is open; a background
    // refresh landing mid-menu would redraw under the user.
    cancelRefresh();
    menuController?.abort();
    const controller = new AbortController();
    menuController = controller;

    try {
      let force = false;
      let outcome: QueryOutcome | undefined;
      while (!controller.signal.aborted) {
        const model = ctx.model;
        if (!outcome) {
          outcome = await runWithLoader(
            ctx,
            force ? "Refreshing usage…" : "Checking usage…",
            controller.signal,
            (signal) => queryUsage(ctx, model, force, signal),
          );
          force = false;
          if (!outcome) return;
          // The menu still shows what it fetched, but a query that outlived the
          // model it was for must not overwrite the status of the current one.
          if (model && modelIdentity(ctx.model) === modelIdentity(model)) {
            publishStatus(ctx, outcome, model);
          }
        }

        const availableResets = availableResetCredits(outcome);
        const expectedFingerprint = outcome.fingerprint;
        const expectedAccountKey = outcome.accountKey;
        const pendingRedemption =
          expectedAccountKey && pendingRedemptions.available
            ? pendingRedemptions.get(expectedAccountKey)
            : undefined;
        const resetAction = pendingRedemption
          ? RETRY_RESET
          : availableResets > 0 && expectedAccountKey && pendingRedemptions.available
            ? USE_RESET
            : undefined;
        const action = await ctx.ui.select(
          formatProviderState(outcome.state, display),
          [HISTORY, REFRESH, ...(resetAction ? [resetAction] : []), DISPLAY, CLOSE],
          { signal: controller.signal },
        );
        if (action === REFRESH) {
          force = true;
          outcome = undefined;
          continue;
        }
        if (resetAction && action === resetAction && expectedFingerprint && expectedAccountKey) {
          const retrying = resetAction === RETRY_RESET;
          const confirmed = await ctx.ui.confirm(
            retrying ? "Retry using a saved reset?" : "Use one saved reset?",
            retrying
              ? "The previous outcome is unknown. Retry the same idempotent request without risking a second reset?"
              : `Codex will choose and consume one of ${availableResets} saved resets for the current account. This cannot be undone.`,
            { signal: controller.signal },
          );
          if (!confirmed || controller.signal.aborted) continue;

          let requestId: string;
          try {
            // Reserve before asynchronous auth preflight. Concurrent sessions
            // that confirmed from the same snapshot then share one logical
            // redemption even if one reaches the backend first.
            requestId = redemptionIdFor(expectedAccountKey);
          } catch (error) {
            ctx.ui.notify(`Could not use a reset: ${errorMessage(error)}`, "warning");
            continue;
          }

          let startedAccountKey: string | undefined;
          try {
            const result = await runWithLoader(
              ctx,
              retrying ? "Retrying reset…" : "Using reset…",
              controller.signal,
              async (signal) => {
                const startedAt = Date.now();
                const currentModel = ctx.model;
                const adapter = adapterForProvider(currentModel?.provider);
                if (
                  !adapter ||
                  !isCodexProvider(adapter.id) ||
                  modelIdentity(currentModel) !== modelIdentity(model)
                ) {
                  return { kind: "account-changed" as const };
                }
                const auth = await awaitWithDeadline(
                  resolveUsageAuth(ctx, adapter),
                  signal,
                  DEFAULT_TIMEOUT_MS,
                  "resolving OpenAI Codex runtime auth",
                );
                if (!auth) return { kind: "auth-unavailable" as const };
                if (
                  auth.accountKey !== expectedAccountKey ||
                  modelIdentity(ctx.model) !== modelIdentity(model)
                ) {
                  return { kind: "account-changed" as const };
                }

                const remainingMs = Math.max(1, DEFAULT_TIMEOUT_MS - (Date.now() - startedAt));
                startedAccountKey = expectedAccountKey;
                const response = await redeemCodexResetCredit(auth, requestId, signal, remainingMs);
                return {
                  kind: "response" as const,
                  accountKey: expectedAccountKey,
                  requestId,
                  response,
                };
              },
            );
            if (!result) {
              if (controller.signal.aborted) return;
              if (startedAccountKey) {
                ctx.ui.notify(
                  "Reset outcome is unknown. Retry from this menu to reuse the same safe request.",
                  "warning",
                );
              }
              continue;
            }
            if (result.kind === "account-changed") {
              ctx.ui.notify(
                "The active Codex model or account changed. Usage will be refreshed before a reset can be used.",
                "warning",
              );
              force = true;
              outcome = undefined;
              continue;
            }
            if (result.kind === "auth-unavailable") {
              ctx.ui.notify("OpenAI Codex authorization is no longer available.", "warning");
              force = true;
              outcome = undefined;
              continue;
            }

            try {
              pendingRedemptions.delete(result.accountKey, result.requestId);
            } catch (error) {
              ctx.ui.notify(
                `Reset completed, but ${REDEMPTION_STATE_FILE_NAME} could not be updated: ${errorMessage(error)}`,
                "warning",
              );
            }
            for (const providerId of ["openai", "openai-codex"]) {
              cache.clearProvider(providerId);
              failures.delete(`${providerId}:${expectedFingerprint}`);
            }
            latest = undefined;
            statuslineSlot.refresh();
            safeSetStatus(ctx, "checking", model);
            notifyRedemptionOutcome(ctx, result.response);
            force = true;
            outcome = undefined;
            continue;
          } catch (error) {
            if (controller.signal.aborted) return;
            ctx.ui.notify(
              startedAccountKey
                ? `Reset outcome is unknown: ${errorMessage(error)} Retry to reuse the same safe request.`
                : `Could not use a reset: ${errorMessage(error)}`,
              "warning",
            );
            continue;
          }
        }
        if (action === HISTORY) {
          try {
            const loaded = await runWithLoader(
              ctx,
              "Loading usage history…",
              controller.signal,
              (signal) => history.load(ctx, { signal }),
            );
            if (!loaded) {
              if (controller.signal.aborted) return;
              continue;
            }
            const live =
              outcome.state.status === "ready"
                ? {
                    providerId: outcome.state.providerId,
                    providerName: outcome.state.providerName,
                    identity: outcome.identity,
                    report: outcome.state.report,
                  }
                : undefined;
            await history.show(ctx, { history: loaded, live, signal: controller.signal });
          } catch (error) {
            if (controller.signal.aborted || isAbortError(error)) return;
            ctx.ui.notify("Could not load usage history.", "warning");
          }
          continue;
        }
        if (action !== DISPLAY) return;
        await showDisplayMenu(ctx, {
          config: display,
          save: (next) => applyDisplayConfig(ctx, next, outcome, model),
          report: outcome.state.status === "ready" ? outcome.state.report : undefined,
          model,
          signal: controller.signal,
          configPath: displayConfigPath(),
        });
      }
    } finally {
      controller.abort();
      const stillOwnsMenu = menuController === controller;
      if (stillOwnsMenu) menuController = undefined;
      // The menu already published what it found, so only the cadence needs
      // re-arming — querying again here would repeat what just landed. A menu
      // superseded by another invocation no longer owns that cadence.
      const model = ctx.model;
      if (stillOwnsMenu && sessionActive && model && adapterForProvider(model.provider)) {
        scheduleRefresh(ctx, model);
      }
    }
  };

  pi.registerCommand("speed", {
    description: "Show historical model request speed and descriptive cohort changes",
    handler: async (args, ctx) => {
      const argument = args.trim();
      const preset = speedRange(argument);
      if (argument && !preset) {
        ctx.ui.notify(
          `/speed accepts: ${SPEED_RANGES.join(", ")}, or no argument to open the 1d report.`,
          "warning",
        );
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/speed requires an interactive Pi mode.", "warning");
        return;
      }
      speedController?.abort();
      const controller = new AbortController();
      speedController = controller;
      try {
        const range = preset ?? "1d";
        const loaded = await runWithLoader(
          ctx,
          "Loading model speed history…",
          controller.signal,
          (signal) => history.load(ctx, { signal }),
        );
        if (!loaded || controller.signal.aborted) return;
        await showSpeedReport(ctx, loaded, range, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error) || isStaleExtensionContextError(error))
          return;
        ctx.ui.notify("Could not load model speed history.", "warning");
      } finally {
        controller.abort();
        if (speedController === controller) speedController = undefined;
      }
    },
  });

  pi.registerCommand("usage", {
    description: "Show usage for the current runtime account",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify(
          "/usage does not accept arguments; choose an action from its menu.",
          "warning",
        );
        return;
      }
      try {
        await showMenu(ctx);
      } catch (error) {
        if (isStaleExtensionContextError(error) || isAbortError(error)) return;
        throw error;
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    sessionActive = true;
    snapshotWarningShown = false;
    reloadDisplayConfig();
    // The file may have changed since the last session, and a statusline that
    // asked for our schema before this ran would be holding the older defaults.
    statuslineSlot.refresh();
    for (const warning of displayWarnings) {
      ctx.ui.notify(`${CONFIG_FILE_NAME}: ${warning}`, "warning");
    }
    displayWarnings = [];
    if (pendingRedemptions.loadError) {
      ctx.ui.notify(
        `${REDEMPTION_STATE_FILE_NAME}: ${pendingRedemptions.loadError}; reset redemption is disabled`,
        "warning",
      );
    }
    startRefresh(ctx, ctx.model, false);
  });
  pi.on("session_tree", (_event, ctx) => {
    startRefresh(ctx, ctx.model, false);
  });
  pi.on("model_select", (event, ctx) => {
    startRefresh(ctx, event.model, false);
  });
  pi.on("turn_start", (_event, ctx) => {
    startRefresh(ctx, ctx.model, false);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    sessionActive = false;
    cancelRefresh();
    // Leaves an open /usage dialog waiting on a session that is gone.
    menuController?.abort();
    speedController?.abort();
    cache.clear();
    failures.clear();
    safeSetStatus(ctx, undefined);
  });
  registerSpeedStatus(pi);
}

function availableResetCredits(outcome: QueryOutcome): number {
  if (
    outcome.state.status !== "ready" ||
    !isCodexProvider(outcome.state.providerId) ||
    !outcome.fingerprint
  ) {
    return 0;
  }
  const value = outcome.state.report.metrics.find((metric) => metric.id === "reset-credits")?.value;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function notifyRedemptionOutcome(
  ctx: ExtensionCommandContext,
  outcome: CodexResetCreditRedemption,
): void {
  if (outcome.code === "reset") {
    const windows =
      outcome.windowsReset > 0
        ? ` ${outcome.windowsReset} usage ${outcome.windowsReset === 1 ? "window was" : "windows were"} reset.`
        : "";
    ctx.ui.notify(`Used one saved reset.${windows}`, "info");
    return;
  }
  if (outcome.code === "already_redeemed") {
    ctx.ui.notify("That redemption had already completed. Usage will be refreshed.", "info");
    return;
  }
  if (outcome.code === "nothing_to_reset") {
    ctx.ui.notify(
      "No eligible usage window can be reset right now; no reset was consumed.",
      "warning",
    );
    return;
  }
  ctx.ui.notify("No saved reset is available for this account.", "warning");
}

function providerDisplayName(ctx: ExtensionContext, providerId: string): string {
  try {
    return sanitizeDisplayText(ctx.modelRegistry.getProviderDisplayName(providerId), 80);
  } catch {
    return sanitizeDisplayText(providerId, 80);
  }
}

function modelIdentity(model: PiModel | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
