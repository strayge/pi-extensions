import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { isAbortError, isStaleExtensionContextError } from "./core.ts";
import { loadHistory } from "./history.ts";
import { SPEED_RANGES, showSpeedReport, speedRange } from "./speed.ts";
import { registerSpeedStatus } from "./speed-status.ts";
import { registerStreamCollector } from "./stream.ts";

type LoaderResult<T> = { ok: true; value: T } | { ok: false; error: unknown };
type HistoryLoader = typeof loadHistory;

/** Escape must cancel the same history read as supersession and shutdown. */
async function runWithLoader<T>(
  ctx: ExtensionCommandContext,
  label: string,
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
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
}

export default function speedExtension(pi: ExtensionAPI, load: HistoryLoader = loadHistory): void {
  let speedController: AbortController | undefined;

  pi.registerCommand("speed", {
    description: "Show historical output streaming speed and descriptive cohort changes",
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
          (signal) => load(ctx, { signal }),
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

  pi.on("session_shutdown", () => {
    speedController?.abort();
  });
  registerStreamCollector(pi);
  registerSpeedStatus(pi);
}
