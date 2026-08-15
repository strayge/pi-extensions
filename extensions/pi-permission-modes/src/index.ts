/**
 * Permission Mode extension
 *
 * Switchable, data-driven permission modes (cycle with shift+tab or /perm). A MODE
 * is a JSON bundle of a sandbox profile + an allow/ask/deny permission policy +
 * UI metadata, defined in `schema.ts` (built-in defaults) and overridable in
 * `permission-mode.json`. The four shipped modes:
 *
 *   Default - confirm bash/edit/write; approved in-project bash runs sandboxed
 *             (writable), approved out-of-project runs UNSANDBOXED.
 *   Plan    - planning mode. In-project bash runs sandboxed READ-ONLY; reads are
 *             free; only Markdown create/edit is allowed in-project. Out-of-project
 *             access prompts. A system prompt steers the model to write a plan file.
 *   Build   - in-project reads/writes/bash run without confirmation; bash runs
 *             sandboxed. Prompts on out-of-project access or privilege escalation;
 *             approved out-of-project commands run UNSANDBOXED.
 *   YOLO    - never prompts, never sandboxes; full user permissions.
 *
 * The OS sandbox (@anthropic-ai/sandbox-runtime) is the real enforcement for
 * bash. If it's unavailable the sandboxed modes fall back to PROMPTING for
 * in-project bash and the TUI indicator shows a warning.
 *
 * This entry file is wiring only — flags, commands, shortcuts, the tool_call
 * dispatcher, the input/skill handler, and lifecycle. The logic lives in sibling
 * modules:
 *   schema.ts       mode definition types + plan prompt (defaults: permission-mode.defaults.json)
 *   resolve.ts      surface resolution engine (allow/ask/deny)
 *   bash-enforce.ts bash gate + exec plan (sandbox composition)
 *   bash-parse.ts   tree-sitter command extraction + heuristic fallback
 *   config-load.ts  layered permission-mode.json loader
 *   approvals.ts    session-scoped "Allow for session" store
 *   awareness.ts    sandbox-boundary system-prompt section (injected each turn)
 *   network.ts      live network session state (grants, denies, open toggle)
 *   paths.ts        out-of-project / protected-path predicates
 *   heuristics.ts   bash escape/privilege scan (tree-sitter fallback)
 *   sandbox.ts      SandboxController (runtime lifecycle, per-mode profile)
 *   status.ts       footer indicator   statusline-slot.ts  its placeable slots
 *   show-plan.ts    show_plan tool   plan-render.ts  its renderer
 *
 * Install (see README.md):
 *   pi install git:github.com/wynainfo/pi-permission-modes
 *   Linux also needs: bubblewrap, socat, ripgrep
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALLOW_ONCE, ALLOW_SESSION, askWithSession, DENY, SessionApprovals } from "./approvals.ts";
import { sandboxAwarenessPrompt } from "./awareness.ts";
import { bashExecPlan, bashGate, bashPromptTitle, bashSubject } from "./bash-enforce.ts";
import { analyzeBash } from "./bash-parse.ts";
import {
  isUnsafeDomain,
  loadModeConfig,
  loadStockDefaults,
  persistModeDomains,
  persistModeRule,
  persistProjectRule,
  projectGrantCount,
  stockDefaultsFile,
} from "./config-load.ts";
import type { PermState } from "./modes.ts";
import { type NetAskResult, NetworkSession, isHostAllowed, normalizeDomain } from "./network.ts";
import { isOutside, isProtectedWrite } from "./paths.ts";
import { decide, decideBashCommand, mostRestrictive, resolveSurface } from "./resolve.ts";
import { SandboxController } from "./sandbox.ts";
import {
  type Action,
  type ModeDef,
  PLAN_PROMPT_SENTINEL,
  type PermissionModeConfig,
  planModeSystemPrompt,
  type Surface,
  SURFACES,
} from "./schema.ts";
import { createShowPlanTool } from "./show-plan.ts";
import { statusSlots, updateStatus } from "./status.ts";
import { publishStatuslineItem } from "./statusline-slot.ts";

/** Built-in file tools whose `input.path` is gated against the matching surface. */
const FILE_TOOL_SURFACE: Record<string, Surface> = {
  read: "read",
  edit: "edit",
  write: "write",
  ls: "ls",
  grep: "grep",
  find: "find",
};

/** Tools with a dedicated branch in the dispatcher (not gated via the `tool` surface). */
const BUILTIN_HANDLED = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "ls",
  "grep",
  "find",
  "web_search",
  "show_plan",
  "request_network_access", // prompts on its own — gating it would double-prompt
]);

/** Our own tools that must never be hidden (show_plan is needed in Plan mode). */
const NEVER_HIDE = new Set(["show_plan"]);

const USER_DENIED_COMMAND_REASON =
  "Command denied by the user; it was not executed. Do not retry this command or an equivalent command. " +
  "Continue without it or report that permission was denied.";

function userDeniedToolReason(toolName: string): string {
  return toolName === "Agent"
    ? "Agent launch denied by the user; no subagent was started."
    : `Tool "${toolName}" denied by the user; it was not executed.`;
}

function bashRulePatterns(name: string, args: string[]): { narrow: string[]; broad: string[]; command: string } {
  const command = [name, ...args].join(" ").trim();
  const broad = [name, `${name} *`];
  const sub = args[0];
  if (!sub || sub.startsWith("-")) return { narrow: broad, broad, command };
  return { narrow: [`${name} ${sub}`, `${name} ${sub} *`], broad, command };
}

function isPersistableBashAsk(
  mode: ModeDef,
  command: { name: string; args: string[]; command: string },
  scope: "global" | "project",
): boolean {
  if (resolveSurface(mode.permission.bash, command.command) !== "ask") return false;
  const targets = [command.command, command.name, ...command.args];
  const otherActions = targets.map((target) => resolveSurface(mode.permission.path, target));
  if (mode.projectOverlay) {
    otherActions.push(resolveSurface(mode.projectOverlay.bash, command.command));
    otherActions.push(...targets.map((target) => resolveSurface(mode.projectOverlay?.path, target)));
  }
  if (scope === "global" && mode.trustedProjectPermission) {
    otherActions.push(resolveSurface(mode.trustedProjectPermission.bash, command.command));
  }
  return otherActions.every((action) => action === undefined || action === "allow");
}

function filePolicySurfaces(surface: Surface, outside: boolean): Surface[] {
  const candidates: Surface[] = ["path"];
  if (outside) candidates.push("external_directory");
  candidates.push(surface);
  return candidates;
}

function fileAskSurfaces(mode: ModeDef, surface: Surface, target: string, outside: boolean): Surface[] {
  const asks = filePolicySurfaces(surface, outside).filter(
    (candidate) => resolveSurface(mode.permission[candidate], target) === "ask",
  );
  // Sparse custom modes fall back to ask when no layer matches. Persist that
  // boundary decision on the surface the prompt represents.
  return asks.length > 0 ? [...new Set(asks)] : [outside ? "external_directory" : surface];
}

function projectPolicyAllowsGlobalFileRule(mode: ModeDef, surface: Surface, target: string, outside: boolean): boolean {
  return [mode.projectOverlay, mode.trustedProjectPermission].every(
    (permission) =>
      !permission ||
      filePolicySurfaces(surface, outside).every((candidate) => {
        const action = resolveSurface(permission[candidate], target);
        return action === undefined || action === "allow";
      }),
  );
}

const isTrustedProject = (ctx: ExtensionContext): boolean =>
  typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();

export default async function (pi: ExtensionAPI) {
  // The engine starts on the shipped stock defaults (permission-mode.defaults.json);
  // session_start reloads the merged config (stock + global full-authority +
  // project trust-aware) from permission-mode.json.
  let config: PermissionModeConfig = loadStockDefaults();
  let modeName = config.defaultMode;
  // True when the current mode was auto-picked as the headless-child safety
  // fallback (no --perm flag, session entry, or forwarded env). The mode's
  // POLICY fully applies, but its systemPrompt is not injected — a planning
  // prompt steering a headless worker to write plan files and ask about shift+tab
  // would misdirect it — and the fallback isn't exported to child processes
  // as if it were an explicit choice (children re-derive their own fallback).
  let fallbackMode = false;
  const root = process.cwd();

  const currentMode = (): ModeDef => config.modes[modeName] ?? config.modes[config.defaultMode];

  const sandbox = new SandboxController();
  // toolCallIds the user explicitly approved to run OUTSIDE the sandbox.
  const approvedUnsandboxed = new Set<string>();
  // "Allow for session" memory, keyed per-mode.
  const approvals = new SessionApprovals();
  // Live network state: session domain grants/denies and the open toggle. The
  // sandbox-runtime proxy consults it (via net.decide) for every host outside
  // the allowlist, so changes apply instantly — no sandbox re-init.
  const net = new NetworkSession();
  let notifiedProjectGrants = false;
  // Statusline slots, so the two chips can be placed independently. The mode
  // slot reuses the `perm` status key, which is what makes a statusline render
  // the slot instead of also listing the key. Both ask for a placement rather
  // than accepting the catch-all, where one item's color covers every entry and
  // all four modes would look alike.
  const publishModeSlot = publishStatuslineItem(pi, {
    id: "perm",
    defaultPlacement: { side: "left", order: 10 },
  });
  const publishNetworkSlot = publishStatuslineItem(pi, {
    id: "perm-network",
    defaultPlacement: { side: "left", order: 20 },
  });
  // Latest UI-capable context, for prompts that fire OUTSIDE an event handler
  // (the network ask callback runs mid-bash, driven by the proxy).
  let uiCtx: ExtensionContext | undefined;

  /** Paint the footer chip and republish both slots from the same state. */
  const refreshStatus = (ctx: ExtensionContext, mode: ModeDef = currentMode()): void => {
    const slots = statusSlots(updateStatus(ctx, mode, sandbox, net.open));
    publishModeSlot(slots.mode.text, slots.mode.color);
    publishNetworkSlot(slots.network?.text, slots.network?.color);
  };

  /** Prompt the user about a blocked host (the connection waits meanwhile). */
  const askNetHost = async (host: string, port: number | undefined): Promise<NetAskResult> => {
    const ctx = uiCtx;
    if (!ctx?.hasUI || currentMode().sandbox.askOnBlockedHost === false) return "dismiss";
    const target = port !== undefined ? `${host}:${port}` : host;
    const choice = await ctx.ui.select(`Network: bash wants to reach ${target} (not in the allowlist) — allow?`, [
      "Allow for session",
      "Allow forever",
      "Deny",
    ]);
    if (choice === "Allow for session") return "allow-session";
    if (choice === "Allow forever") {
      try {
        const file = persistModeDomains(getAgentDir(), modeName, [host]);
        config = loadModeConfig(ctx.cwd, getAgentDir(), (m) => ctx.ui.notify(m, "warning"), isTrustedProject(ctx));
        ctx.ui.notify(`permission-mode: always allow ${host} in ${currentMode().label} — saved to ${file}`, "info");
      } catch (e) {
        ctx.ui.notify(`permission-mode: could not save domain: ${e}`, "error");
      }
      return "allow-forever";
    }
    if (choice === "Deny") return "deny";
    return "dismiss"; // dismissed prompt: deny this request, but don't remember
  };

  /** Prompt to allow an `ask`, honoring session grants (a target list requires
   * every entry to be granted; granting remembers all). Returns true to allow.
   * When `onForever` is given, a fourth "Allow forever" option persists the rule. */
  const promptAllow = (
    ctx: ExtensionContext,
    surface: Surface,
    target: string | string[],
    title: string,
    onForever?: () => void | Promise<void>,
  ): Promise<boolean> =>
    askWithSession(
      { hasUI: ctx.hasUI, select: (t, o) => ctx.ui.select(t, o) },
      approvals,
      modeName,
      surface,
      target,
      title,
      onForever,
    );

  /** "Allow forever": persist `<mode>.permission.<surface>.<key> = allow` to the
   * global config and hot-reload so it applies now and in future sessions. */
  const learnForever = (ctx: ExtensionContext, surface: Surface, key: string) => () => {
    try {
      const file = persistModeRule(getAgentDir(), modeName, surface, key, "allow");
      config = loadModeConfig(ctx.cwd, getAgentDir(), (m) => ctx.ui.notify(m, "warning"), isTrustedProject(ctx));
      ctx.ui.notify(`permission-mode: always allow ${surface} "${key}" in ${currentMode().label} — saved to ${file}`, "info");
    } catch (e) {
      ctx.ui.notify(`permission-mode: could not save rule: ${e}`, "error");
    }
  };

  const localBash = createBashTool(root);

  pi.registerFlag("perm", {
    description: `Start in permission mode: ${config.cycleOrder.join(" | ")}`,
    type: "string",
    default: "",
  });
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for the sandboxed modes (heuristics + prompts only)",
    type: "boolean",
    default: false,
  });

  // Hide a mode's `hideTools` from the model (pre-exposure), restoring the rest.
  const applyToolVisibility = () => {
    const hide = new Set((currentMode().hideTools ?? []).filter((n) => !NEVER_HIDE.has(n)));
    const all = pi.getAllTools().map((t) => t.name);
    pi.setActiveTools(hide.size ? all.filter((n) => !hide.has(n)) : all);
  };

  /**
   * Announcing is for switches the user made themselves: the footer carries the
   * mode at all times, so a notice would be noise on every launch — the lifecycle
   * handlers pass `announce: false`.
   */
  const setMode = async (
    name: string,
    ctx: ExtensionContext,
    opts: { persist?: boolean; viaFallback?: boolean; announce?: boolean } = {},
  ) => {
    const { persist = true, viaFallback = false, announce = true } = opts;
    if (!config.modes[name]) return;
    uiCtx = ctx;
    modeName = name;
    fallbackMode = viaFallback;
    // Forward to child pi processes (e.g. subagents) via inherited env. The child
    // adopts it on session_start unless an explicit --perm flag overrides. The
    // implicit headless fallback is NOT forwarded: a child with no explicit mode
    // derives the same safe fallback itself (and skips the systemPrompt too).
    if (!viaFallback) process.env.PI_PERMISSION_MODE = modeName;
    const m = currentMode();
    await sandbox.applyProfile(m.sandbox); // re-init runtime if the profile changed
    applyToolVisibility();
    refreshStatus(ctx, m);
    if (announce) ctx.ui.notify(`Permission mode: ${m.label}`, "info");
    if (persist) pi.appendEntry<PermState>("perm-mode", { mode: modeName });
  };

  /** The most restrictive built-in-style mode for a headless child without a
   * forwarded mode: a read-only sandboxed mode if any, else the default. */
  const safeChildMode = (): string => {
    const ro = config.cycleOrder.find((n) => config.modes[n]?.sandbox.enabled && !config.modes[n]?.sandbox.writable);
    const sandboxed = config.cycleOrder.find((n) => config.modes[n]?.sandbox.enabled);
    return ro ?? sandboxed ?? config.defaultMode;
  };

  const cycle = async (ctx: ExtensionContext) => {
    const order = config.cycleOrder;
    const idx = order.indexOf(modeName);
    await setMode(order[(idx + 1) % order.length], ctx);
  };

  /**
   * Resolve which mode to start in:
   *   1. explicit --perm flag, then 2. persisted session entry (resume),
   *   3. PI_PERMISSION_MODE env (forwarded from a parent / user-set),
   *   4. headless child with none of the above → most restrictive (never YOLO),
   *      flagged as `fallback` (policy applies, systemPrompt is not injected),
   *   5. the current/default mode.
   */
  const pickMode = (ctx: ExtensionContext, useFlag: boolean): { name: string; fallback: boolean } => {
    let resolved: string | undefined;
    if (useFlag) {
      const flag = String(pi.getFlag("perm") ?? "").toLowerCase();
      if (config.modes[flag]) resolved = flag;
    }
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "perm-mode") {
        const data = entry.data as PermState | undefined;
        if (data?.mode && config.modes[data.mode]) resolved = data.mode;
      }
    }
    if (!resolved) {
      const env = process.env.PI_PERMISSION_MODE;
      if (env && config.modes[env]) resolved = env;
    }
    if (!resolved && !ctx.hasUI) return { name: safeChildMode(), fallback: true }; // headless child, no forwarded mode
    return { name: resolved ?? modeName, fallback: false };
  };

  pi.registerShortcut("shift+tab", {
    description: `Cycle permission mode (${config.cycleOrder.join(" -> ")})`,
    handler: async (ctx) => cycle(ctx),
  });
  pi.registerCommand("perm", {
    description: `Set or cycle permission mode: /perm [${config.cycleOrder.join("|")}|init [-p]|allow [-p|-g] [surface] <pattern>|clear-approvals]`,
    handler: async (args, ctx) => {
      const raw = args.trim();
      const arg = raw.toLowerCase();
      if (arg === "clear-approvals") {
        approvals.clearAll();
        return ctx.ui.notify("permission-mode: cleared session approvals", "info");
      }
      if (arg === "init" || arg === "init -p") {
        // Scaffold an editable copy of the stock defaults at the global path.
        const project = arg === "init -p";
        const dest = project
          ? path.join(ctx.cwd, CONFIG_DIR_NAME, "permission-mode.json")
          : path.join(getAgentDir(), "permission-mode", "permission-mode.json");
        if (existsSync(dest)) {
          return ctx.ui.notify(`permission-mode: ${dest} already exists — edit it directly`, "warning");
        }
        try {
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(
            dest,
            project
              ? `${JSON.stringify({ $schema: "https://raw.githubusercontent.com/wynainfo/pi-permission-modes/main/schemas/permission-mode.schema.json", modes: {} }, null, 2)}\n`
              : readFileSync(stockDefaultsFile(), "utf-8"),
          );
          return ctx.ui.notify(`permission-mode: wrote ${dest} — edit it to customize your modes`, "info");
        } catch (e) {
          return ctx.ui.notify(`permission-mode: could not write ${dest}: ${e}`, "error");
        }
      }
      if (arg.startsWith("allow ") || arg === "allow") {
        const match = /^allow(?:\s+(-p|-g))*(?:\s+([\s\S]*))?$/i.exec(raw);
        if (!match) return ctx.ui.notify("permission-mode: usage: /perm allow [-p|-g] [surface] <pattern>", "warning");
        let project = false;
        let global = false;
        const flags = raw.match(/^allow(?:\s+(-p|-g))*/i)?.[0] ?? "allow";
        for (const flag of flags.match(/-p|-g/gi) ?? []) {
          if (flag.toLowerCase() === "-p") project = true;
          if (flag.toLowerCase() === "-g") global = true;
        }
        const rest = (match[2] ?? "").trim().split(/\s+/).filter(Boolean);
        const surface = rest.length > 1 && SURFACES.includes(rest[0] as Surface) ? (rest.shift() as Surface) : "bash";
        const pattern = rest.join(" ").trim();
        if (!pattern || (project && global)) {
          return ctx.ui.notify("permission-mode: usage: /perm allow [-p|-g] [surface] <pattern>", "warning");
        }
        if (project && !isTrustedProject(ctx)) {
          return ctx.ui.notify("permission-mode: project allows require a trusted project", "warning");
        }
        try {
          const file = project
            ? persistProjectRule(ctx.cwd, modeName, surface, pattern, "allow")
            : persistModeRule(getAgentDir(), modeName, surface, pattern, "allow");
          config = loadModeConfig(ctx.cwd, getAgentDir(), (m) => ctx.ui.notify(m, "warning"), isTrustedProject(ctx));
          return ctx.ui.notify(`permission-mode: allowed ${surface} "${pattern}" — saved to ${file}`, "info");
        } catch (e) {
          return ctx.ui.notify(`permission-mode: could not save rule: ${e}`, "error");
        }
      }
      if (config.modes[arg]) await setMode(arg, ctx);
      else await cycle(ctx);
    },
  });
  const networkEnforcing = () => currentMode().sandbox.enabled && sandbox.ready;

  const toggleNetwork = async (ctx: ExtensionContext) => {
    uiCtx = ctx;
    if (!networkEnforcing()) {
      return ctx.ui.notify("permission-mode: network is not filtered in this mode/state — nothing to toggle", "info");
    }
    net.open = !net.open;
    refreshStatus(ctx);
    ctx.ui.notify(
      net.open
        ? "Network: OPEN for this session — domain filtering disabled (alt+n or /net restrict to re-enable)"
        : "Network: filtered — domain allowlist active",
      net.open ? "warning" : "info",
    );
  };

  pi.registerShortcut("alt+n", {
    description: "Toggle network filtering for this session (filtered <-> open)",
    handler: toggleNetwork,
  });

  pi.registerCommand("net", {
    description: "Network sandbox: /net [status|allow <domain…>|open|restrict|reset]",
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const m = currentMode();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "status").toLowerCase();
      if (sub === "open") {
        if (!net.open) return toggleNetwork(ctx);
        return ctx.ui.notify("permission-mode: network is already open for this session", "info");
      }
      if (sub === "restrict") {
        if (net.open) return toggleNetwork(ctx);
        return ctx.ui.notify("permission-mode: network filtering is already active", "info");
      }
      if (sub === "reset") {
        net.clear();
        refreshStatus(ctx, m);
        return ctx.ui.notify("permission-mode: cleared session network grants/denies; filtering restored", "info");
      }
      if (sub === "allow") {
        const domains = [...new Set(parts.slice(1).map(normalizeDomain).filter((d): d is string => d !== undefined))];
        const safe = domains.filter((d) => !isUnsafeDomain(d));
        if (safe.length === 0) {
          return ctx.ui.notify("permission-mode: usage: /net allow <domain> [domain…] — concrete hosts or *.sub wildcards", "warning");
        }
        net.grant(safe);
        const dropped = domains.length - safe.length;
        return ctx.ui.notify(
          `permission-mode: allowed for this session: ${safe.join(", ")}${dropped ? ` (${dropped} overly-broad pattern(s) rejected)` : ""}`,
          "info",
        );
      }
      // status (default)
      const state = !networkEnforcing()
        ? "OPEN — nothing filters in this mode/state"
        : net.open
          ? "OPEN for this session (/net restrict or alt+n to re-enable filtering)"
          : "filtered (alt+n or /net open to disable)";
      return ctx.ui.notify(
        [
          `Network (${m.label}): ${state}`,
          `Mode allowlist: ${m.sandbox.network?.allowedDomains?.join(", ") || "(none)"}`,
          `Session grants: ${net.grants().join(", ") || "(none)"}`,
          `Session denies: ${net.denies().join(", ") || "(none)"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show the active mode's sandbox status and configuration",
    handler: async (_args, ctx) => {
      const m = currentMode();
      if (!m.sandbox.enabled) {
        return ctx.ui.notify(`${m.label}: sandbox disabled for this mode (bash runs unsandboxed)`, "info");
      }
      if (sandbox.disabled) return ctx.ui.notify("Sandbox disabled via --no-sandbox", "info");
      if (!sandbox.ready) return ctx.ui.notify(`Sandbox unavailable: ${sandbox.warn ?? "unknown"}`, "warning");
      const c = sandbox.effectiveConfig(m.sandbox);
      ctx.ui.notify(
        [
          `Sandbox: ACTIVE for ${m.label} (${m.sandbox.writable ? "project-writable" : "read-only"})`,
          "",
          `Network: ${net.open ? "OPEN for this session (alt+n)" : "filtered (alt+n)"}`,
          `Network allowed: ${c.network?.allowedDomains?.join(", ") || "(none)"}`,
          `Session grants: ${net.grants().join(", ") || "(none)"}`,
          `Deny read:  ${c.filesystem?.denyRead?.join(", ") || "(none)"}`,
          `Allow write: ${c.filesystem?.allowWrite?.join(", ") || "(none)"}`,
          `Deny write:  ${c.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  // Replace built-in bash so the sandbox can wrap it. Sandboxing is recomputed at
  // run time from the active mode's profile: disabled (YOLO), approved escapes,
  // and the degraded fallback run unsandboxed; non-writable modes run read-only.
  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, _ctx) {
      const approved = approvedUnsandboxed.delete(id); // user granted an escape
      const m = currentMode();
      const plan = bashExecPlan(m.sandbox.enabled, m.sandbox.writable, sandbox.ready, approved);
      const ops = plan.sandboxed ? sandbox.bashOps({ readOnly: plan.readOnly }) : null;
      if (!ops) return localBash.execute(id, params, signal, onUpdate);
      const sandboxed = createBashTool(root, { operations: ops });
      return sandboxed.execute(id, params, signal, onUpdate);
    },
  });

  // Plan Mode helper: render a written plan file to the user (display-only).
  pi.registerTool(await createShowPlanTool(root));

  // Model-initiated network grants: ask the user to allow domains outside the
  // sandbox allowlist (batch-capable, so one prompt covers an install that
  // needs several hosts). Grants land in the session state the ask callback
  // reads — no sandbox re-init. Available in every mode; when nothing filters
  // (YOLO, degraded, /net open) it says so instead of prompting.
  pi.registerTool({
    name: "request_network_access",
    label: "Request network access",
    description:
      "Ask the user to allow bash network access to one or more domains outside the sandbox allowlist. " +
      "Use it when a blocked host stops you (downloads, installs, API troubleshooting), or to get every needed " +
      "domain approved up front before a command that hits several hosts. Accepts exact hosts (api.example.com) " +
      "and subdomain wildcards (*.example.com).",
    parameters: Type.Object({
      domains: Type.Array(Type.String({ description: "Domain or subdomain wildcard, e.g. api.example.com or *.example.com" }), {
        description: "The domains to request access to",
      }),
      reason: Type.String({ description: "One short line: why access is needed" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
      const { domains = [], reason = "" } = params as { domains?: string[]; reason?: string };
      const m = currentMode();
      if (!m.sandbox.enabled || !sandbox.ready || net.open) {
        return text("Network is not filtered right now — no grant needed, just run the command.");
      }
      const normalized = [...new Set(domains.map(normalizeDomain).filter((d): d is string => d !== undefined))];
      const rejected = normalized.filter(isUnsafeDomain);
      const modeList = m.sandbox.network?.allowedDomains ?? [];
      const covered = (d: string) =>
        modeList.includes(d) || net.grants().includes(d) || (!d.startsWith("*.") && (isHostAllowed(d, modeList) || net.isGranted(d)));
      const need = normalized.filter((d) => !isUnsafeDomain(d) && !covered(d));
      const rejectedNote = rejected.length ? ` Rejected as overly broad: ${rejected.join(", ")}.` : "";
      if (need.length === 0) {
        return text(
          rejected.length && normalized.length === rejected.length
            ? `No grantable domains.${rejectedNote} Use a concrete host or a *.sub wildcard.`
            : `Already allowed — just run the command.${rejectedNote}`,
        );
      }
      const pctx = ctx ?? uiCtx;
      if (!pctx?.hasUI) return text("Denied: no interactive user available to approve network access.");
      const choice = await pctx.ui.select(
        `Model requests network access to ${need.join(", ")} — ${reason.trim() || "no reason given"}. Allow?`,
        ["Allow for session", "Allow forever", "Deny"],
      );
      if (choice !== "Allow for session" && choice !== "Allow forever") {
        return text(
          `Denied by the user: ${need.join(", ")}. Don't retry these hosts — work within the allowlist or ask the user how to proceed.${rejectedNote}`,
        );
      }
      net.grant(need);
      let saved = "";
      if (choice === "Allow forever") {
        try {
          const file = persistModeDomains(getAgentDir(), modeName, need);
          config = loadModeConfig(pctx.cwd, getAgentDir(), (msg) => pctx.ui.notify(msg, "warning"), isTrustedProject(pctx));
          saved = ` (saved permanently for ${currentMode().label})`;
          pctx.ui.notify(`permission-mode: always allow ${need.join(", ")} in ${currentMode().label} — saved to ${file}`, "info");
        } catch (e) {
          pctx.ui.notify(`permission-mode: could not save domains: ${e}`, "error");
        }
      }
      return text(`Granted${saved}: ${need.join(", ")}. Retry the blocked command now.${rejectedNote}`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    config = loadModeConfig(
      ctx.cwd,
      getAgentDir(),
      (m) => (ctx.hasUI ? ctx.ui.notify(m, "warning") : console.error(m)),
      isTrustedProject(ctx),
    );
    if (!notifiedProjectGrants && isTrustedProject(ctx)) {
      const grants = projectGrantCount(ctx.cwd, getAgentDir());
      if (grants > 0) {
        notifiedProjectGrants = true;
        if (ctx.hasUI) ctx.ui.notify(`permission-mode: honoring ${grants} project grants from ${CONFIG_DIR_NAME}/permission-mode.json`, "info");
      }
    }
    if (!config.modes[modeName]) modeName = config.defaultMode;
    // Resolve the start mode BEFORE init so the sandbox initializes with the
    // right profile, then setMode reconciles status (applyProfile is a no-op).
    const picked = pickMode(ctx, true);
    modeName = picked.name;
    await sandbox.init({
      cwd: ctx.cwd,
      noSandbox: pi.getFlag("no-sandbox") === true,
      hasUI: ctx.hasUI,
      notify: (m) => (ctx.hasUI ? ctx.ui.notify(m, "warning") : console.warn(m)),
      profile: currentMode().sandbox,
      // Live network gate: the proxy consults session state for every host
      // outside the allowlist; unknown hosts prompt via askNetHost.
      askHost: (host, port) => net.decide(host, port, askNetHost),
      drainBlockedHosts: () => net.drainBlocked(),
    });
    await setMode(picked.name, ctx, { persist: false, viaFallback: picked.fallback, announce: false });
  });
  pi.on("session_tree", async (_event, ctx) => {
    uiCtx = ctx;
    const picked = pickMode(ctx, false);
    await setMode(picked.name, ctx, { persist: false, viaFallback: picked.fallback, announce: false });
  });
  pi.on("session_shutdown", async () => {
    approvals.clearAll(); // session-scoped grants don't outlive the session
    net.clear(); // network grants/denies and the open toggle are session-scoped too
    await sandbox.reset();
  });

  // Drop any unconsumed escape grant once the tool call resolves.
  pi.on("tool_execution_end", async (event) => {
    approvedUnsandboxed.delete(event.toolCallId);
  });

  // Inject the sandbox-awareness section and the active mode's system prompt
  // (if any). The handler runs each turn and reads the live mode + sandbox
  // state, so it auto-updates when the mode changes. The "@plan" sentinel
  // resolves to the date-stamped Plan-mode prompt. A mode picked as the
  // implicit headless fallback keeps the FACTUAL awareness section (boundary
  // knowledge helps a worker avoid failing commands) but skips the mode's
  // STEERING systemPrompt, which would misdirect a headless worker.
  pi.on("before_agent_start", async (event) => {
    applyToolVisibility(); // keep hidden tools hidden as the tool set evolves
    const m = currentMode();
    const parts: string[] = [];
    const effectiveFilesystem = sandbox.effectiveConfig(m.sandbox).filesystem;
    const awarenessMode = {
      ...m,
      sandbox: {
        ...m.sandbox,
        allowWrite: effectiveFilesystem?.allowWrite,
        denyWrite: effectiveFilesystem?.denyWrite,
        denyRead: effectiveFilesystem?.denyRead,
      },
    };
    const aware = sandboxAwarenessPrompt(awarenessMode, {
      active: sandbox.ready && !sandbox.disabled,
      reason: sandbox.disabled ? "disabled via --no-sandbox" : sandbox.warn,
      networkOpen: net.open,
      sessionDomains: net.grants(),
    });
    if (aware) parts.push(aware);
    const sp = m.systemPrompt;
    if (sp && !fallbackMode) {
      parts.push(sp === PLAN_PROMPT_SENTINEL ? planModeSystemPrompt(new Date().toISOString().slice(0, 10)) : sp);
    }
    if (parts.length === 0) return undefined;
    return { systemPrompt: [event.systemPrompt, ...parts].join("\n\n") };
  });

  // Skill gating: skills aren't tools — they're invoked via `/skill:<name>` text,
  // so intercept the input before expansion and resolve the `skill` surface.
  pi.on("input", async (event, ctx) => {
    const match = /^\/skill:([\w-]+)/.exec(event.text.trim());
    if (!match) return undefined;
    const name = match[1];
    const action = decide(currentMode(), "skill", name);
    if (action === "deny") {
      if (ctx.hasUI) ctx.ui.notify(`Skill "${name}" blocked in ${currentMode().label}`, "warning");
      return { action: "handled" as const };
    }
    if (
      action === "ask" &&
      !(await promptAllow(ctx, "skill", name, `Skill "${name}" — first use in ${currentMode().label}; allow?`, learnForever(ctx, "skill", name)))
    ) {
      return { action: "handled" as const };
    }
    return undefined; // allow → continue to expansion
  });

  pi.on("tool_call", async (event, ctx) => {
    uiCtx = ctx;
    const { toolName } = event;
    const m = currentMode();
    // `input` is a discriminated union across tools; view it loosely (custom
    // tools surface as Record<string, unknown> anyway) and guard each field.
    const input = event.input as Record<string, unknown>;
    const inPath = typeof input.path === "string" ? input.path : undefined;

    // Hard backstop: never write to protected paths (file tools aren't sandboxed),
    // unless the mode explicitly trusts everything (YOLO). Matched lexically AND
    // on the symlink-resolved canonical path, so a link can't smuggle the write.
    if (!m.bypassProtectedPaths && (toolName === "edit" || toolName === "write") && inPath !== undefined) {
      if (isProtectedWrite(root, inPath)) {
        if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${inPath}`, "warning");
        return { block: true, reason: `Path "${inPath}" is protected` };
      }
    }

    // Bash.
    if (toolName === "bash") {
      const command = String(input.command ?? "");
      // Real AST when available: judge each (possibly nested) command against the
      // bash surface AND the cross-cutting path gate (joined string + each token,
      // see decideBashCommand), most-restrictive across the chain; detect
      // escapes/privilege.
      const analysis = await analyzeBash(command, root);
      let action: Action;
      if (analysis.commands.length > 0) {
        action = analysis.commands
          .map((c) => decideBashCommand(m, c.name, c.args) ?? "allow")
          .reduce<Action>((a, b) => mostRestrictive(a, b) ?? "allow", "allow");
      } else {
        action = decide(m, "bash", command);
      }
      // Confirm rather than trust an `allow` derived from an incomplete command
      // list when containment is expected. An explicitly unsandboxed mode keeps
      // its policy authoritative: in particular, YOLO must never prompt.
      if (analysis.unparsed && m.sandbox.enabled) action = mostRestrictive(action, "ask") ?? "ask";
      const extracted = analysis.commands.map((c) => ({ ...bashRulePatterns(c.name, c.args), name: c.name, args: c.args }));
      const keyed = !analysis.unparsed && extracted.length > 0;
      const policyAsks = keyed ? extracted.filter((c) => decideBashCommand(m, c.name, c.args) === "ask") : [];
      const approvalTargets = policyAsks.length > 0 ? policyAsks : extracted;
      const pending = keyed
        ? approvalTargets.filter((c) => !approvals.has(modeName, "bash", c.command))
        : [];
      const sessionApproved = keyed ? pending.length === 0 : approvals.has(modeName, "bash", command);
      if (sessionApproved && action === "ask") action = "allow";
      if (action !== "deny" && sessionApproved) {
        // Escape approvals must mark each new tool call so the replacement bash
        // tool runs this invocation outside the sandbox without prompting again.
        if (analysis.outsideReason) approvedUnsandboxed.add(event.toolCallId);
        return undefined;
      }
      const gate = bashGate(
        action,
        analysis.outsideReason,
        m.sandbox.enabled,
        sandbox.ready,
        bashSubject([...new Set(pending.map((c) => c.name))]),
      );
      if (gate.kind === "block") return { block: true, reason: gate.reason };
      if (gate.kind === "prompt") {
        const baseTitle = analysis.unparsed ? `${gate.title} (script could not be fully parsed)` : gate.title;
        const commandsToAllow = keyed ? pending.map((c) => c.command) : [command];
        const title = bashPromptTitle(baseTitle, commandsToAllow);
        const persistenceBase =
          !analysis.unparsed &&
          !analysis.outsideReason &&
          (sandbox.ready || !m.sandbox.enabled) &&
          policyAsks.length > 0;
        const globalEligible = persistenceBase && policyAsks.every((c) => isPersistableBashAsk(m, c, "global"));
        const projectEligible =
          persistenceBase && isTrustedProject(ctx) && policyAsks.every((c) => isPersistableBashAsk(m, c, "project"));
        const persistCommands = policyAsks;
        const broadLabel = [...new Set(persistCommands.map((candidate) => candidate.name))].join(", ");
        const broadPatterns = persistCommands.flatMap((candidate) => candidate.broad);
        const persistentChoices: Array<{ label: string; project: boolean; patterns: string[] }> = [];
        const addPersistentChoices = (commandLabel: string, patterns: string[]) => {
          if (projectEligible) {
            persistentChoices.push({ label: `Always allow for project: ${commandLabel}`, project: true, patterns });
          }
          if (globalEligible) persistentChoices.push({ label: `Always allow: ${commandLabel}`, project: false, patterns });
        };
        if (persistCommands.length === 1) {
          addPersistentChoices(persistCommands[0].narrow[1], persistCommands[0].narrow);
          if (persistCommands[0].broad[1] !== persistCommands[0].narrow[1]) {
            addPersistentChoices(persistCommands[0].broad[1], persistCommands[0].broad);
          }
        } else if (persistCommands.length > 1) {
          addPersistentChoices(broadLabel, broadPatterns);
        }

        if (!ctx.hasUI) return { block: true, reason: gate.reason };
        const choice = await ctx.ui.select(title, [
          ALLOW_ONCE,
          ALLOW_SESSION,
          ...persistentChoices.map((candidate) => candidate.label),
          DENY,
        ]);
        if (choice === ALLOW_SESSION) {
          for (const c of keyed ? approvalTargets : [{ command, narrow: [command], broad: [command] }]) {
            const patterns = keyed ? c.narrow : [command];
            for (const pattern of patterns) approvals.remember(modeName, "bash", pattern);
          }
        } else {
          const selected = persistentChoices.find((candidate) => candidate.label === choice);
          if (selected) {
            try {
              for (const pattern of [...new Set(selected.patterns)]) {
                if (selected.project) persistProjectRule(ctx.cwd, modeName, "bash", pattern, "allow");
                else persistModeRule(getAgentDir(), modeName, "bash", pattern, "allow");
                approvals.remember(modeName, "bash", pattern);
              }
              config = loadModeConfig(ctx.cwd, getAgentDir(), (msg) => ctx.ui.notify(msg, "warning"), isTrustedProject(ctx));
            } catch (e) {
              ctx.ui.notify(`permission-mode: could not save rule: ${e}`, "error");
              return { block: true, reason: gate.reason };
            }
          } else if (choice !== ALLOW_ONCE) {
            return { block: true, reason: USER_DENIED_COMMAND_REASON };
          }
        }
        if (gate.onApproveUnsandboxed) approvedUnsandboxed.add(event.toolCallId);
      }
      return undefined;
    }

    // File tools (read/edit/write/ls/grep/find).
    const surface = FILE_TOOL_SURFACE[toolName];
    if (surface && inPath !== undefined) {
      const path = inPath;
      const outside = isOutside(root, path);
      const action = decide(m, surface, path, { isOutside: outside });
      if (action === "deny") {
        // Friendly message for the Plan-mode "Markdown only" case (read-only mode).
        if ((surface === "edit" || surface === "write") && !m.sandbox.writable) {
          if (ctx.hasUI) ctx.ui.notify(`${m.label} allows editing Markdown files only: ${path}`, "warning");
          return { block: true, reason: `${m.label} allows editing Markdown files only` };
        }
        return { block: true, reason: `Path "${path}" is blocked by ${m.label}` };
      }
      if (action === "ask") {
        const title = outside ? `Outside project — allow ${toolName}? (${path})` : `Allow ${toolName}? (${path})`;
        const reason = outside ? "Access outside project blocked" : "blocked";
        if (!outside) {
          if (!(await promptAllow(ctx, surface, path, title))) return { block: true, reason };
          return undefined;
        }

        if (approvals.has(modeName, surface, path)) return undefined;
        if (!ctx.hasUI) return { block: true, reason };
        const persistentChoices: Array<{ label: string; project: boolean }> = [];
        if (isTrustedProject(ctx)) {
          persistentChoices.push({ label: `Always allow for project: ${path}`, project: true });
        }
        if (projectPolicyAllowsGlobalFileRule(m, surface, path, outside)) {
          persistentChoices.push({ label: `Always allow: ${path}`, project: false });
        }
        const choice = await ctx.ui.select(title, [
          ALLOW_ONCE,
          ALLOW_SESSION,
          ...persistentChoices.map((candidate) => candidate.label),
          DENY,
        ]);
        if (choice === ALLOW_SESSION) {
          approvals.remember(modeName, surface, path);
        } else {
          const selected = persistentChoices.find((candidate) => candidate.label === choice);
          if (selected) {
            try {
              for (const askSurface of fileAskSurfaces(m, surface, path, outside)) {
                if (selected.project) persistProjectRule(ctx.cwd, modeName, askSurface, path, "allow");
                else persistModeRule(getAgentDir(), modeName, askSurface, path, "allow");
              }
              approvals.remember(modeName, surface, path);
              config = loadModeConfig(ctx.cwd, getAgentDir(), (msg) => ctx.ui.notify(msg, "warning"), isTrustedProject(ctx));
            } catch (e) {
              ctx.ui.notify(`permission-mode: could not save rule: ${e}`, "error");
              return { block: true, reason };
            }
          } else if (choice !== ALLOW_ONCE) {
            return { block: true, reason };
          }
        }
      }
      return undefined; // allow
    }

    // web_search.
    if (toolName === "web_search") {
      const action = decide(m, "web_search", String(input.query ?? "(empty)"));
      if (action === "deny") return { block: true, reason: `web search blocked by ${m.label}` };
      // Session approval is surface-wide ("allow web search this session").
      if (action === "ask" && !(await promptAllow(ctx, "web_search", "*", "Allow web search?"))) {
        return { block: true, reason: "web search blocked" };
      }
      return undefined;
    }

    // Custom / extension tools (incl. any MCP-as-tool): gate by tool name. An
    // unknown tool prompts first-use (allow once/session/forever/deny).
    if (!BUILTIN_HANDLED.has(toolName)) {
      const action = decide(m, "tool", toolName);
      if (action === "deny") return { block: true, reason: `Tool "${toolName}" blocked by ${m.label}` };
      if (
        action === "ask" &&
        !(await promptAllow(ctx, "tool", toolName, `Tool "${toolName}" — first use in ${m.label}; allow?`, learnForever(ctx, "tool", toolName)))
      ) {
        return {
          block: true,
          reason: ctx.hasUI
            ? userDeniedToolReason(toolName)
            : `Tool "${toolName}" requires approval, but no interactive user is available.`,
        };
      }
    }

    return undefined;
  });
}
