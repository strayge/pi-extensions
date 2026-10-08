// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2024-present Manaflow, Inc. and other contributors.
// Modified 2026-10-07 for pi-cmux; provenance and changes are documented in NOTICE.
// Repository-owned fork of cmux's generated Pi bridge (template v4).

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type HookExtra = Record<string, unknown>;
interface PendingCompletion {
  lastAssistantMessage?: string;
  notificationType: string;
  turnId: string;
  suppressNotification: boolean;
}

interface CompletionClaim extends PendingCompletion {
  context: PiExtensionContextSnapshot;
  queued: boolean;
  feedDelivered?: boolean;
  // Undefined is unsent; false also covers an in-flight or failed dispatch.
  notificationRouted?: boolean;
}

interface SessionState {
  activeTurnId?: string;
  pendingCompletion?: PendingCompletion;
  completionClaim?: CompletionClaim;
  workRevision: number;
  feedDeliveryFailed: boolean;
  stopped: boolean;
  pendingDialogs: number;
  toolCommands: Map<string, string>;
}
interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
  reason?: CommandFailureReason;
  timeoutMs: number;
  elapsedMs: number;
  surfaceUnavailable?: boolean;
}

interface PiExtensionContextSnapshot {
  readonly sessionId: string | null;
  readonly cwd: string;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function objectValue(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  const typed = value as Record<string, unknown>;
  for (const key of keys) {
    if (typed[key] !== undefined && typed[key] !== null) return typed[key];
  }
  return undefined;
}

function utf8Prefix(value: unknown, maximumBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.length > maximumBytes ? value.slice(0, maximumBytes) : value;
  const bytes = Buffer.from(candidate, "utf8");
  if (bytes.byteLength <= maximumBytes) return candidate;
  return bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

interface PiFeedProjectionState {
  remainingNodes: number;
  seen: WeakSet<object>;
}

function projectPiFeedValue(value: unknown, state: PiFeedProjectionState, depth = 0, preserveText = true): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return preserveText ? utf8Prefix(value, 512) : piFeedValueSummary(value);
  if (typeof value === "number") {
    return preserveText && Number.isFinite(value) ? value : piFeedValueSummary(value);
  }
  if (typeof value !== "object") return piFeedValueSummary(value);
  if (depth >= 4 || state.remainingNodes <= 0) return piFeedValueSummary(value);
  if (state.seen.has(value)) return { kind: "circular" };
  state.remainingNodes -= 1;
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      const retained = Math.min(value.length, 12);
      for (let index = 0; index < retained; index += 1) {
        try {
          out.push(projectPiFeedValue(value[index], state, depth + 1, preserveText));
        } catch (_) {
          out.push({ kind: "unavailable" });
        }
      }
      if (value.length > retained) out.push({ kind: "omitted", count: value.length - retained });
      return out;
    }
    const out: Record<string, unknown> = {};
    let scanned = 0;
    try {
      for (const key in value as Record<string, unknown>) {
        if (scanned >= 12) {
          out.cmux_truncated = true;
          break;
        }
        scanned += 1;
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const projectedKey = utf8Prefix(key, 128);
        if (!projectedKey) continue;
        try {
          out[projectedKey] = projectPiFeedValue(
            (value as Record<string, unknown>)[key],
            state,
            depth + 1,
            preserveText,
          );
        } catch (_) {
          out[projectedKey] = { kind: "unavailable" };
        }
      }
    } catch (_) {
      return piFeedValueSummary(value);
    }
    return out;
  } finally {
    state.seen.delete(value);
  }
}

function boundedPiFeedInput(payload: Record<string, unknown>, maximumBytes: number): string {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") <= maximumBytes) return serialized;

  const summaries = Array.isArray(payload.cmux_compacted_terminal_events)
    ? payload.cmux_compacted_terminal_events
    : [];
  const latest = summaries.length > 0 && typeof summaries[summaries.length - 1] === "object"
    ? summaries[summaries.length - 1] as Record<string, unknown>
    : undefined;
  const rawCount = payload.cmux_compacted_terminal_count;
  const totalCount = typeof rawCount === "number" && Number.isFinite(rawCount)
    ? Math.max(summaries.length, rawCount)
    : summaries.length;
  const rawOmitted = payload.cmux_compacted_terminal_omitted_count;
  const omittedCount = typeof rawOmitted === "number" && Number.isFinite(rawOmitted)
    ? Math.max(0, rawOmitted, totalCount - 1)
    : Math.max(0, totalCount - 1);
  const safe: Record<string, unknown> = {};
  for (const key of ["session_id", "cwd", "turn_id", "tool_call_id", "tool_name"] as const) {
    const value = utf8Prefix(payload[key], 256);
    if (value !== undefined) safe[key] = value;
  }
  for (const key of ["hook_event_name", "event"] as const) {
    const value = utf8Prefix(payload[key], 64);
    if (value !== undefined) safe[key] = value;
  }
  if (typeof payload.is_error === "boolean") safe.is_error = payload.is_error;
  if (latest) {
    const summary: Record<string, unknown> = {};
    for (const key of ["session_id", "cwd", "turn_id", "tool_call_id", "tool_name"] as const) {
      const value = utf8Prefix(latest[key] ?? payload[key], 256);
      if (value !== undefined) summary[key] = value;
    }
    if (typeof latest.is_error === "boolean") summary.is_error = latest.is_error;
    safe.cmux_compacted_terminal_count = totalCount;
    safe.cmux_compacted_terminal_omitted_count = omittedCount;
    safe.cmux_compacted_terminal_events = [summary];
  } else if (firstString(payload.hook_event_name, payload.event) === "PostToolUse") {
    safe.cmux_compacted_terminal_count = 1;
    safe.cmux_compacted_terminal_omitted_count = 0;
    safe.cmux_compacted_terminal_events = [piTerminalFeedSummary(payload)];
  } else if (payload.tool_input !== undefined) {
    safe.tool_input = piFeedValueSummary(payload.tool_input);
  }

  const compacted = JSON.stringify(safe);
  if (Buffer.byteLength(compacted, "utf8") <= maximumBytes) return compacted;
  const fallbackEvent = utf8Prefix(payload.hook_event_name, 64) || "PostToolUse";
  return JSON.stringify({
    session_id: utf8Prefix(payload.session_id, 128),
    hook_event_name: fallbackEvent,
    event: fallbackEvent,
    tool_call_id: "compacted-overflow",
    tool_name: "cmux_compacted_terminal_overflow",
    tool_input: fallbackEvent === "PostToolUse"
      ? { omitted_terminal_count: Math.max(1, totalCount) }
      : piFeedValueSummary(payload.tool_input),
  });
}

function resolveExecutable(name: string): string {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return name;
}

function looksLikePiExecutable(value: string): boolean {
  const base = path.basename(value).toLowerCase();
  return base === "pi" || base === "pi-coding-agent";
}

function looksLikePiScript(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const base = path.basename(normalized);
  return (
    normalized.includes("/@earendil-works/pi-coding-agent/") ||
    normalized.includes("/@mariozechner/pi-coding-agent/") ||
    normalized.includes("/packages/coding-agent/") ||
    ((base === "cli.js" || base === "cli.ts") &&
      (normalized.includes("pi-coding-agent") || normalized.includes("coding-agent")))
  );
}

interface NormalizedLaunchArgvCache {
  key: string;
  argv: string[];
}

let normalizedLaunchArgvCache: NormalizedLaunchArgvCache | undefined;

function normalizedLaunchArgv(): string[] {
  const raw = Array.isArray(process.argv) ? process.argv.map((value) => String(value)) : [];
  // Pi's argv and inherited PATH are stable for the lifetime of this extension.
  // Memoize executable discovery so every hook subprocess does not synchronously
  // stat the full PATH again. Keep the key dynamic for test harnesses and hosts
  // that deliberately rewrite process argv at runtime.
  const cacheKey = [process.env.PATH || "", ...raw].join("\0");
  if (normalizedLaunchArgvCache?.key === cacheKey) {
    return normalizedLaunchArgvCache.argv;
  }

  let argv: string[];
  if (raw.length === 0) {
    argv = [resolveExecutable("pi")];
  } else if (looksLikePiExecutable(raw[0]!)) {
    argv = raw;
  } else if (raw.length > 1 && looksLikePiScript(raw[1]!)) {
    argv = [resolveExecutable("pi"), ...raw.slice(2)];
  } else {
    argv = [resolveExecutable("pi"), ...raw.slice(1)];
  }
  normalizedLaunchArgvCache = { key: cacheKey, argv };
  return argv;
}

function base64NulSeparated(values: string[]): string {
  const bytes: Buffer[] = [];
  for (const value of values) {
    bytes.push(Buffer.from(String(value), "utf8"));
    bytes.push(Buffer.from([0]));
  }
  return Buffer.concat(bytes).toString("base64");
}

function secretLikeEnvKey(key: string): boolean {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION|COOKIE)/i.test(key);
}

function safePiEnvKey(key: string): boolean {
  return (
    key === "PI_CODING_AGENT_DIR" ||
    key === "PI_CONFIG_DIR" ||
    key === "PI_CODING_AGENT_SESSION_DIR" ||
    (key.startsWith("PI_CODING_AGENT_") && !secretLikeEnvKey(key))
  );
}

function safeNodeEnvKey(key: string): boolean {
  return (
    key === "NODE_ENV" ||
    key === "NODE_OPTIONS" ||
    key === "NODE_PATH" ||
    key === "NODE_NO_WARNINGS" ||
    key === "NODE_EXTRA_CA_CERTS"
  );
}

function safeCmuxEnvKey(key: string): boolean {
  if (key.startsWith("CMUX_TEST_PI_")) return !secretLikeEnvKey(key);
  if (key.startsWith("CMUX_AGENT_LAUNCH_")) return !secretLikeEnvKey(key);
  if (key === "CMUX_AGENT_HOOK_STATE_DIR") return true;
  if (key === "CMUX_PI_CMUX_BIN" || key === "CMUX_PI_HOOKS_DISABLED") return true;
  if (key === "CMUX_PI_HOOK_TIMEOUT_MS") return true;
  if (key === "CMUX_SURFACE_ID" || key === "CMUX_WORKSPACE_ID" || key === "CMUX_WINDOW_ID") return true;
  if (key === "CMUX_PANE_ID" || key === "CMUX_TAB_ID" || key === "CMUX_PANEL_ID") return true;
  if (key === "CMUX_SOCKET" || key === "CMUX_SOCKET_PATH") return true;
  if (key === "CMUX_BUNDLE_ID" || key === "CMUX_BUNDLED_CLI_PATH") return true;
  if (key === "CMUX_CLI_SENTRY_DISABLED" || key === "CMUX_DEBUG_LOG") return true;
  return false;
}

function shouldPreserveEnvKey(key: string): boolean {
  if (safeCmuxEnvKey(key)) return true;
  if (safePiEnvKey(key)) return true;
  if (safeNodeEnvKey(key)) return true;
  if (key === "PATH" || key === "HOME" || key === "PWD" || key === "SHELL") return true;
  if (key === "USER" || key === "LOGNAME" || key === "TMPDIR" || key === "TZ") return true;
  if (key === "LANG" || key.startsWith("LC_")) return true;
  if (key === "TERM" || key === "TERM_PROGRAM" || key === "TERM_PROGRAM_VERSION" || key === "COLORTERM") return true;
  if (key === "SSH_AUTH_SOCK") return true;
  if (key.startsWith("PI_") || key.startsWith("NODE_")) return !secretLikeEnvKey(key);
  return false;
}

export function hookEnvironment(cwd: string, includeSocketPassword = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (shouldPreserveEnvKey(key)) env[key] = value;
  }
  // The parent suppresses cmux's stock bridge, not this fork's CLI commands.
  delete env.CMUX_PI_HOOKS_DISABLED;
  // Only cmux CLI children need the socket credential; keep it out of the generic allowlist.
  if (includeSocketPassword) {
    const socketPassword = process.env.CMUX_SOCKET_PASSWORD;
    if (socketPassword) env.CMUX_SOCKET_PASSWORD = socketPassword;
  }
  if (!env.CMUX_AGENT_LAUNCH_ARGV_B64) {
    const argv = normalizedLaunchArgv();
    env.CMUX_AGENT_LAUNCH_KIND = "pi";
    env.CMUX_AGENT_LAUNCH_EXECUTABLE = argv[0] || resolveExecutable("pi");
    env.CMUX_AGENT_LAUNCH_ARGV_B64 = base64NulSeparated(argv);
    env.CMUX_AGENT_LAUNCH_CWD = cwd || process.cwd();
  }
  return env;
}

function eventName(subcommand: string): string {
  switch (subcommand) {
    case "session-start":
      return "SessionStart";
    case "prompt-submit":
      return "UserPromptSubmit";
    case "stop":
      return "Stop";
    case "notification":
      return "Notification";
    default:
      return subcommand;
  }
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
  }
  return parts.join("\n") || null;
}

interface AssistantCompletion {
  lastAssistantMessage?: string;
  suppressNotification: boolean;
}

function assistantCompletionFrom(event: unknown): AssistantCompletion {
  const messagesValue = objectValue(event, ["messages"]);
  const messages = Array.isArray(messagesValue) ? messagesValue : [];
  let suppressNotification = false;
  let inspectedLatestAssistant = false;
  // Resolve text and interruption metadata in one reverse pass. agent_end may
  // carry a large message array, so notification support must not rescan it.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const typed = message as {
      role?: unknown;
      content?: unknown;
      stopReason?: unknown;
      cmuxSuppressNotification?: unknown;
    };
    if (typed.role !== "assistant") continue;
    if (!inspectedLatestAssistant) {
      // Input extensions may normalize an abort to `stop` to keep Pi's UI quiet;
      // the marker preserves the interruption intent across that normalization.
      suppressNotification = typed.stopReason === "aborted" || typed.cmuxSuppressNotification === true;
      inspectedLatestAssistant = true;
    }
    const text = firstString(textFromContent(typed.content));
    if (text) return { lastAssistantMessage: text, suppressNotification };
  }
  return { suppressNotification };
}

const childExtensionUIMarker = Symbol.for("pi-subagents:child-extension-ui");
const subagentManagerKey = Symbol.for("pi-subagents:manager");

interface PiSubagentManager {
  hasRunning(): boolean;
  waitForAll(): Promise<void>;
}

function subagentManager(): PiSubagentManager | undefined {
  return (globalThis as unknown as Record<symbol, PiSubagentManager | undefined>)[subagentManagerKey];
}

function isChildSession(ctx: ExtensionContext): boolean {
  return (ctx.ui as unknown as Record<symbol, unknown>)[childExtensionUIMarker] === true;
}

function sessionIdFrom(ctx: ExtensionContext): string | null {
  if (isChildSession(ctx)) return null;
  return firstString(ctx.sessionManager.getSessionId());
}

function cwdFrom(ctx: ExtensionContext): string {
  return firstString(ctx.cwd, process.cwd()) || process.cwd();
}

function snapshotContext(ctx: ExtensionContext): PiExtensionContextSnapshot {
  return {
    sessionId: sessionIdFrom(ctx),
    cwd: cwdFrom(ctx),
  };
}

function stateFor(sessionStates: Map<string, SessionState>, sessionId: string): SessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      workRevision: 0,
      feedDeliveryFailed: false,
      stopped: false,
      pendingDialogs: 0,
      toolCommands: new Map(),
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

function eventTurnId(event: unknown): string | null {
  return firstString(
    objectValue(event, ["turn_id", "turnId", "turnID"])
  );
}

function beginTurn(sessionStates: Map<string, SessionState>, sessionId: string, event: unknown): string {
  const state = stateFor(sessionStates, sessionId);
  state.completionClaim = undefined;
  state.pendingCompletion = undefined;
  state.workRevision += 1;
  const turnId = currentTurnId(sessionStates, sessionId, event);
  state.stopped = false;
  return turnId;
}

function currentTurnId(sessionStates: Map<string, SessionState>, sessionId: string, event: unknown): string {
  const state = stateFor(sessionStates, sessionId);
  // cmux retains completion receipts across extension reloads. A local counter
  // reuses receipt keys; allocate once and retain the UUID through continuations.
  const turnId = eventTurnId(event) || state.activeTurnId || randomUUID();
  state.activeTurnId = turnId;
  return turnId;
}

function finishTurn(sessionStates: Map<string, SessionState>, sessionId: string, event: unknown): string {
  const state = stateFor(sessionStates, sessionId);
  const turnId = currentTurnId(sessionStates, sessionId, event);
  state.activeTurnId = undefined;
  state.pendingCompletion = undefined;
  state.completionClaim = undefined;
  state.stopped = true;
  return turnId;
}

function settleTurn(
  state: SessionState,
  context: PiExtensionContextSnapshot,
): CompletionClaim | undefined {
  if (state.stopped) return undefined;
  if (state.completionClaim) return state.completionClaim;
  const completion = state.pendingCompletion;
  if (!completion) return undefined;
  state.activeTurnId = undefined;
  state.pendingCompletion = undefined;
  // Reservation is not delivery: retain progress until Stop is dispatched or
  // actual new work invalidates the claim.
  state.completionClaim = {
    ...completion,
    context,
    queued: false,
  };
  return state.completionClaim;
}

async function warn(
  _ctx: PiExtensionContextSnapshot | null,
  message: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const payload = {
    source: "cmux-pi-extension",
    level: "warning",
    message,
    hook_name: "extension",
    reason: "extension-error",
    ...details,
  };
  await runPiHookDiagnosticWrite(() => appendPiHookDiagnostic(payload));
}

function cmuxExecutable(): string {
  return process.env.CMUX_PI_CMUX_BIN || "cmux";
}
type CommandFailureReason = "timeout" | "nonzero-exit" | "spawn-error" | "cancelled";
type CommandTerminationReason = "timeout" | "cancelled";

// Loaded repositories have produced successful 9s+ lifecycle hooks. Leave
// headroom above that observed tail without allowing a stuck child to block a
// session's serialized control queue indefinitely.
const defaultPiHookTimeoutMilliseconds = 15_000;
const maximumPiHookTimeoutMilliseconds = 60_000;
// Feed's CLI owns a four-second end-to-end deadline. Give the wrapper enough
// headroom that the child reports that outcome itself instead of being killed
// mid-deadline. Keep this strictly later than the dispatcher's 4.5-second drain
// deadline, while lifecycle tuning still cannot pin the shared Feed pool.
const maximumPiFeedCommandTimeoutMilliseconds = 5_000;
// Diagnostics are best effort and may hold a serialized hook queue only briefly.
const piHookDiagnosticWriteDeadlineMilliseconds = 100;

function piHookTimeoutMilliseconds(
  rawValue: string | undefined = process.env.CMUX_PI_HOOK_TIMEOUT_MS,
): number {
  const normalized = rawValue?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return defaultPiHookTimeoutMilliseconds;
  const parsed = Number(normalized);
  if (parsed >= maximumPiHookTimeoutMilliseconds) return maximumPiHookTimeoutMilliseconds;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultPiHookTimeoutMilliseconds;
}

function piCommandTimeoutMilliseconds(
  args: string[],
  rawValue: string | undefined = process.env.CMUX_PI_HOOK_TIMEOUT_MS,
): number {
  const configured = piHookTimeoutMilliseconds(rawValue);
  return args[0] === "hooks" && args[1] === "feed"
    ? Math.min(configured, maximumPiFeedCommandTimeoutMilliseconds)
    : configured;
}

function commandFailureReason(
  status: number | null,
  error: unknown,
  terminationReason?: CommandTerminationReason,
): CommandFailureReason | undefined {
  if (terminationReason) return terminationReason;
  if (status === 0) return undefined;
  if (status !== null && status !== 0) return "nonzero-exit";
  return "spawn-error";
}

function boundedPiHookName(value: string): string {
  return utf8Prefix(value, 128) || "unknown";
}

function piHookName(args: string[]): string {
  if (args[0] === "hooks" && args[1] === "pi") {
    return boundedPiHookName(firstString(args[2]) || "unknown");
  }
  if (args[0] === "hooks" && args[1] === "feed") {
    const eventIndex = args.indexOf("--event");
    const eventName = eventIndex >= 0 ? firstString(args[eventIndex + 1]) : null;
    return boundedPiHookName(eventName ? `feed:${eventName}` : "feed");
  }
  if (args[0] === "--json" && args[1] === "surface" && args[2] === "resume") {
    return boundedPiHookName(`surface-resume-${firstString(args[3]) || "unknown"}`);
  }
  return "cmux-command";
}

function expandedPiHookLogPath(value: string, home: string | undefined = process.env.HOME): string {
  if (value === "~") return home || value;
  if (value.startsWith("~/") && home) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function isOwnedRegularPiHookFile(metadata: fs.Stats): boolean {
  return metadata.isFile()
    && typeof process.getuid === "function"
    && metadata.uid === process.getuid();
}

let activePiHookDiagnosticWrite: Promise<void> | undefined;

async function runPiHookDiagnosticWrite(operation: () => Promise<void>): Promise<void> {
  // Retain at most one file operation. If it stalls after the caller's deadline,
  // later diagnostics are dropped instead of accumulating promises or handles.
  if (activePiHookDiagnosticWrite) return;
  let tracked: Promise<void>;
  tracked = Promise.resolve()
    .then(operation)
    .catch(() => {})
    .finally(() => {
      if (activePiHookDiagnosticWrite === tracked) activePiHookDiagnosticWrite = undefined;
    });
  activePiHookDiagnosticWrite = tracked;

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      tracked,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, piHookDiagnosticWriteDeadlineMilliseconds);
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

function piHookDiagnosticPath(
  environment: Record<string, string | undefined> = process.env,
  lastDebugLogPathFile = "/tmp/cmux-last-debug-log-path",
  fallbackLogPath = "/tmp/cmux-debug.log",
): string {
  const explicit = firstString(environment.CMUX_DEBUG_LOG);
  if (explicit) return expandedPiHookLogPath(explicit, environment.HOME);

  const socketPath = firstString(environment.CMUX_SOCKET_PATH, environment.CMUX_SOCKET);
  if (socketPath) {
    const socketName = path.basename(socketPath);
    if (socketName.startsWith("cmux-debug-") && socketName.endsWith(".sock")) {
      return path.join("/tmp", `${socketName.slice(0, -".sock".length)}.log`);
    }
  }

  let pointerDescriptor: number | undefined;
  try {
    // The shared pointer is untrusted: inspect a nonblocking descriptor and
    // bound the read so a special or oversized file cannot stall Pi.
    pointerDescriptor = fs.openSync(
      lastDebugLogPathFile,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    if (isOwnedRegularPiHookFile(fs.fstatSync(pointerDescriptor))) {
      const pointerContents = Buffer.alloc(4096);
      const bytesRead = fs.readSync(
        pointerDescriptor,
        pointerContents,
        0,
        pointerContents.byteLength,
        0,
      );
      const lastPath = firstString(pointerContents.subarray(0, bytesRead).toString("utf8"));
      if (lastPath) return expandedPiHookLogPath(lastPath, environment.HOME);
    }
  } catch (_) {
  } finally {
    if (pointerDescriptor !== undefined) {
      try { fs.closeSync(pointerDescriptor); } catch (_) {}
    }
  }
  return fallbackLogPath;
}

async function appendPiHookDiagnostic(
  payload: Record<string, unknown>,
  environment: Record<string, string | undefined> = process.env,
  lastDebugLogPathFile = "/tmp/cmux-last-debug-log-path",
  fallbackLogPath = "/tmp/cmux-debug.log",
): Promise<void> {
  let line: string;
  try {
    line = JSON.stringify({ timestamp: new Date().toISOString(), ...payload });
  } catch (_) {
    line = JSON.stringify({
      timestamp: new Date().toISOString(),
      source: "cmux-pi-extension",
      level: "warning",
      message: "failed to serialize Pi hook diagnostic",
      hook_name: "extension",
      reason: "serialization-error",
      timeout_ms: piHookTimeoutMilliseconds(),
      elapsed_ms: 0,
    });
  }
  try {
    // Read/write permits checking the existing JSONL boundary, while O_NONBLOCK
    // keeps special files such as a FIFO from stalling Pi's lifecycle queue.
    const flags = fs.constants.O_RDWR
      | fs.constants.O_APPEND
      | fs.constants.O_CREAT
      | fs.constants.O_NONBLOCK
      | fs.constants.O_NOFOLLOW;
    const handle = await fs.promises.open(
      piHookDiagnosticPath(environment, lastDebugLogPathFile, fallbackLogPath),
      flags,
      0o600,
    );
    try {
      const metadata = await handle.stat();
      // cmux diagnostics are files; drop device, socket, and pipe destinations.
      if (!isOwnedRegularPiHookFile(metadata)) return;
      let prefix = "";
      if (metadata.size > 0) {
        const trailingByte = Buffer.alloc(1);
        const { bytesRead } = await handle.read(trailingByte, 0, 1, metadata.size - 1);
        if (bytesRead !== 1 || trailingByte[0] !== 0x0a) prefix = "\n";
      }
      await handle.writeFile(`${prefix}${line}\n`, "utf8");
    } finally {
      try { await handle.close(); } catch (_) {}
    }
  } catch (_) {}
}

function commandFailureDetails(
  args: string[],
  result: CommandResult,
): Record<string, unknown> {
  return {
    hook_name: piHookName(args),
    reason: result.reason || commandFailureReason(result.status, result.error) || "spawn-error",
    timeout_ms: result.timeoutMs,
    elapsed_ms: result.elapsedMs,
    status: result.status,
    stderr_available: result.stderr.trim().length > 0,
    error_available: result.error !== undefined,
  };
}
interface PiFeedCommand {
  readonly args: string[];
  readonly cwd: string;
  readonly payload: Record<string, unknown>;
  readonly context: PiExtensionContextSnapshot;
  readonly terminal: boolean;
  readonly onFailure?: () => void;
}

interface PiCommandCancellation {
  cancelled: boolean;
  cancel?: () => void;
}

function piFeedValueSummary(value: unknown): Record<string, unknown> {
  if (value === null) return { kind: "null" };
  if (typeof value === "string") return { kind: "text", length: value.length };
  if (typeof value === "boolean" || typeof value === "number") return { kind: typeof value };
  if (Array.isArray(value)) return { kind: "array" };
  return { kind: typeof value };
}

function piTerminalFeedSummary(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["session_id", "turn_id", "tool_call_id", "tool_name", "cwd"] as const) {
    const value = payload[key];
    if (typeof value === "string") summary[key] = value.slice(0, 2048);
  }
  if (typeof payload.is_error === "boolean") summary.is_error = payload.is_error;
  if (payload.tool_result !== undefined) summary.tool_result = piFeedValueSummary(payload.tool_result);
  return summary;
}

export class PiCmuxCommandDispatcher {
  private static readonly surfaceUnavailableExitCode = 69;
  private static readonly maxPendingFeedCommands = 8;
  private static readonly maxQueuedFeedCommands = 32;
  private static readonly maxActiveFeedCommands = 2;
  private static readonly maxCompactedTerminalSummaries = 64;
  // Leave headroom for the feed.push envelope under the relay's 16 KiB frame limit.
  private static readonly maxFeedInputBytes = 12 * 1024;
  // The app may spend three seconds committing acknowledged Feed ingress and the
  // CLI owns a four-second end-to-end deadline. Observe that outcome before the
  // extension classifies a terminal delivery as failed.
  private static readonly feedDrainDeadlineMs = 4500;
  private controlQueues = new Map<string | null, Promise<void>>();
  private pendingFeedCommands = new Map<string, PiFeedCommand>();
  private pendingFeedKeysBySession = new Map<string | null, string[]>();
  private priorityFeedCommands = new Map<string | null, PiFeedCommand[]>();
  private feedDrainWaiters = new Map<string, Array<() => void>>();
  private feedSessionQueue: Array<string | null> = [];
  private scheduledFeedSessions = new Set<string | null>();
  private unavailableSessions = new Set<string>();
  private activeFeeds = new Map<string | null, {
    cancellation: PiCommandCancellation;
    command: PiFeedCommand;
  }>();
  canDispatch(sessionId: string | null): boolean {
    return !sessionId || !this.unavailableSessions.has(sessionId);
  }
  releaseSession(sessionId: string): void {
    this.unavailableSessions.delete(sessionId);
  }

  run(
    args: string[],
    cwd: string,
    input: string | undefined,
    context: PiExtensionContextSnapshot,
  ): Promise<CommandResult> {
    const sessionId = context.sessionId;
    const previous = this.controlQueues.get(sessionId) || Promise.resolve();
    const scheduled = previous.then(() => this.execute(args, cwd, input, context));
    let tail: Promise<void>;
    tail = scheduled
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.controlQueues.get(sessionId) === tail) this.controlQueues.delete(sessionId);
      });
    this.controlQueues.set(sessionId, tail);
    return scheduled;
  }
  enqueueFeed(key: string, command: PiFeedCommand): void {
    const sessionId = command.context.sessionId;
    if (!this.canDispatch(sessionId)) {
      if (command.terminal) command.onFailure?.();
      return;
    }
    const existing = this.pendingFeedCommands.get(key);
    if (existing) {
      // Once a completion is pending for a tool, never replace it with a late start event.
      if (existing.terminal && !command.terminal) return;
    } else {
      if (this.queuedFeedCount(sessionId) >= PiCmuxCommandDispatcher.maxPendingFeedCommands) {
        if (!command.terminal) return;
        if (!this.evictPendingStartForCompletion(sessionId)) {
          if (!this.compactPendingCompletion(command)) command.onFailure?.();
          return;
        }
      }
      if (this.totalQueuedFeedCount() >= PiCmuxCommandDispatcher.maxQueuedFeedCommands) {
        if (!command.terminal) return;
        if (!this.evictAnyPendingStart()) {
          if (!this.compactPendingCompletion(command)) command.onFailure?.();
          return;
        }
      }
    }
    // Reinsert coalesced entries so per-session order reflects event arrival.
    this.removePendingFeed(key);
    this.appendPendingFeed(key, command);
    this.scheduleFeed(sessionId);
  }
  async finishFeedForSession(sessionId: string): Promise<void> {
    for (const key of [...(this.pendingFeedKeysBySession.get(sessionId) || [])]) {
      const command = this.removePendingFeed(key);
      if (command?.terminal) this.appendPriorityFeed(command);
    }
    const active = this.activeFeeds.get(sessionId);
    if (active && !active.command.terminal) {
      active.cancellation.cancelled = true;
      active.cancellation.cancel?.();
    }
    this.scheduleFeed(sessionId);
    await this.waitForFeedDrainUntilDeadline(sessionId);
  }
  private queuedFeedCount(sessionId: string | null): number {
    return (this.pendingFeedKeysBySession.get(sessionId)?.length || 0)
      + (this.priorityFeedCommands.get(sessionId)?.length || 0);
  }

  private totalQueuedFeedCount(): number {
    let count = this.pendingFeedCommands.size;
    for (const commands of this.priorityFeedCommands.values()) count += commands.length;
    return count;
  }
  private appendPendingFeed(key: string, command: PiFeedCommand): void {
    const sessionId = command.context.sessionId;
    const keys = this.pendingFeedKeysBySession.get(sessionId) || [];
    keys.push(key);
    this.pendingFeedKeysBySession.set(sessionId, keys);
    this.pendingFeedCommands.set(key, command);
  }

  private removePendingFeed(key: string): PiFeedCommand | undefined {
    const command = this.pendingFeedCommands.get(key);
    if (!command) return undefined;
    this.pendingFeedCommands.delete(key);
    const sessionId = command.context.sessionId;
    const keys = this.pendingFeedKeysBySession.get(sessionId) || [];
    const index = keys.indexOf(key);
    if (index >= 0) keys.splice(index, 1);
    if (keys.length) this.pendingFeedKeysBySession.set(sessionId, keys);
    else this.pendingFeedKeysBySession.delete(sessionId);
    return command;
  }

  private appendPriorityFeed(command: PiFeedCommand): void {
    const sessionId = command.context.sessionId;
    const commands = this.priorityFeedCommands.get(sessionId) || [];
    commands.push(command);
    this.priorityFeedCommands.set(sessionId, commands);
  }

  private takeNextFeed(sessionId: string | null): PiFeedCommand | undefined {
    const priority = this.priorityFeedCommands.get(sessionId);
    const command = priority?.shift();
    if (priority && !priority.length) this.priorityFeedCommands.delete(sessionId);
    if (command) return command;
    const key = this.pendingFeedKeysBySession.get(sessionId)?.[0];
    return key === undefined ? undefined : this.removePendingFeed(key);
  }

  private waitForFeedDrain(sessionId: string): Promise<void> {
    if (!this.hasFeedWork(sessionId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.feedDrainWaiters.get(sessionId) || [];
      waiters.push(resolve);
      this.feedDrainWaiters.set(sessionId, waiters);
    });
  }

  private waitForFeedDrainUntilDeadline(sessionId: string): Promise<void> {
    if (!this.hasFeedWork(sessionId)) return Promise.resolve();
    const drained = this.waitForFeedDrain(sessionId);
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(() => {
        this.failTerminalFeedForSession(sessionId);
        this.discardFeedForSession(sessionId);
        finish();
      }, PiCmuxCommandDispatcher.feedDrainDeadlineMs);
      void drained.then(finish);
    });
  }

  private hasFeedWork(sessionId: string): boolean {
    return this.activeFeeds.has(sessionId) || this.queuedFeedCount(sessionId) > 0;
  }

  private resolveDrainedFeedSession(sessionId: string): void {
    if (this.hasFeedWork(sessionId)) return;
    const waiters = this.feedDrainWaiters.get(sessionId) || [];
    this.feedDrainWaiters.delete(sessionId);
    for (const resolve of waiters) resolve();
  }

  private evictPendingStartForCompletion(sessionId: string | null): boolean {
    for (const key of this.pendingFeedKeysBySession.get(sessionId) || []) {
      if (!this.pendingFeedCommands.get(key)?.terminal) {
        this.removePendingFeed(key);
        return true;
      }
    }
    return false;
  }

  private failTerminalFeedForSession(sessionId: string): void {
    const active = this.activeFeeds.get(sessionId)?.command;
    if (active?.terminal) active.onFailure?.();
    for (const command of this.priorityFeedCommands.get(sessionId) || []) {
      if (command.terminal) command.onFailure?.();
    }
    for (const key of this.pendingFeedKeysBySession.get(sessionId) || []) {
      const command = this.pendingFeedCommands.get(key);
      if (command?.terminal) command.onFailure?.();
    }
  }

  private evictAnyPendingStart(): boolean {
    for (const [key, command] of this.pendingFeedCommands) {
      if (!command.terminal) {
        this.removePendingFeed(key);
        return true;
      }
    }
    return false;
  }

  private compactPendingCompletion(command: PiFeedCommand): boolean {
    const sessionId = command.context.sessionId;
    const keys = this.pendingFeedKeysBySession.get(sessionId) || [];
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      const pending = this.pendingFeedCommands.get(key);
      if (!pending) continue;
      if (!pending.terminal) continue;
      this.pendingFeedCommands.set(key, this.compactedTerminalCommand(pending, command));
      return true;
    }
    const priority = this.priorityFeedCommands.get(sessionId) || [];
    for (let index = priority.length - 1; index >= 0; index -= 1) {
      const pending = priority[index]!;
      if (!pending.terminal) continue;
      priority[index] = this.compactedTerminalCommand(pending, command);
      return true;
    }
    return false;
  }

  private compactedTerminalCommand(existing: PiFeedCommand, incoming: PiFeedCommand): PiFeedCommand {
    const existingPayload = { ...existing.payload };
    const incomingPayload = incoming.payload;
    const existingSummaries = Array.isArray(existingPayload.cmux_compacted_terminal_events)
      ? existingPayload.cmux_compacted_terminal_events
      : [piTerminalFeedSummary(existingPayload)];
    const incomingSummaries = Array.isArray(incomingPayload.cmux_compacted_terminal_events)
      ? incomingPayload.cmux_compacted_terminal_events
      : [piTerminalFeedSummary(incomingPayload)];
    const existingCount = this.compactedTerminalCount(existingPayload, existingSummaries.length);
    const incomingCount = this.compactedTerminalCount(incomingPayload, incomingSummaries.length);
    const combined = [...existingSummaries, ...incomingSummaries];
    const summaryLimit = PiCmuxCommandDispatcher.maxCompactedTerminalSummaries;
    const summaries = combined.length <= summaryLimit
      ? combined
      : [...combined.slice(0, summaryLimit / 2), ...combined.slice(-summaryLimit / 2)];
    const totalCount = existingCount + incomingCount;
    delete existingPayload.tool_input;
    delete existingPayload.tool_result;
    existingPayload.cmux_compacted_terminal_count = totalCount;
    existingPayload.cmux_compacted_terminal_omitted_count = Math.max(0, totalCount - summaries.length);
    existingPayload.cmux_compacted_terminal_events = summaries;
    return { ...existing, payload: existingPayload };
  }

  private compactedTerminalCount(payload: Record<string, unknown>, fallback: number): number {
    const count = payload.cmux_compacted_terminal_count;
    return typeof count === "number" && Number.isFinite(count) && count >= fallback ? count : fallback;
  }
  private discardFeedForSession(sessionId: string): void {
    for (const key of this.pendingFeedKeysBySession.get(sessionId) || []) {
      this.pendingFeedCommands.delete(key);
    }
    this.pendingFeedKeysBySession.delete(sessionId);
    this.priorityFeedCommands.delete(sessionId);
    this.scheduledFeedSessions.delete(sessionId);
    this.feedSessionQueue = this.feedSessionQueue.filter((queued) => queued !== sessionId);
    const active = this.activeFeeds.get(sessionId);
    if (active) {
      active.cancellation.cancelled = true;
      active.cancellation.cancel?.();
    }
    this.resolveDrainedFeedSession(sessionId);
  }
  private scheduleFeed(sessionId: string | null): void {
    if (sessionId && !this.canDispatch(sessionId)) {
      this.failTerminalFeedForSession(sessionId);
      this.discardFeedForSession(sessionId);
      return;
    }
    if (!this.activeFeeds.has(sessionId) && this.queuedFeedCount(sessionId) > 0 &&
        !this.scheduledFeedSessions.has(sessionId)) {
      this.scheduledFeedSessions.add(sessionId);
      this.feedSessionQueue.push(sessionId);
    }
    this.startScheduledFeeds();
  }

  private startScheduledFeeds(): void {
    while (this.activeFeeds.size < PiCmuxCommandDispatcher.maxActiveFeedCommands) {
      const sessionId = this.feedSessionQueue.shift();
      if (sessionId === undefined) return;
      this.scheduledFeedSessions.delete(sessionId);
      if (this.activeFeeds.has(sessionId)) continue;
      const command = this.takeNextFeed(sessionId);
      if (!command) {
        if (sessionId) this.resolveDrainedFeedSession(sessionId);
        continue;
      }
      const cancellation: PiCommandCancellation = { cancelled: false };
      this.activeFeeds.set(sessionId, { cancellation, command });
      const input = boundedPiFeedInput(command.payload, PiCmuxCommandDispatcher.maxFeedInputBytes);
      void this.execute(command.args, command.cwd, input, command.context, cancellation)
      .then((result) => {
        if (result.ok && command.context.sessionId) {
          rememberSurfaceTarget(this, command.context.sessionId, result);
        }
        if (result.surfaceUnavailable) {
          const sessionId = command.context.sessionId;
          if (sessionId) {
            this.failTerminalFeedForSession(sessionId);
            this.discardFeedForSession(sessionId);
          }
        } else if (result.reason === "timeout") {
          const sessionId = command.context.sessionId;
          if (sessionId) {
            this.failTerminalFeedForSession(sessionId);
            this.discardFeedForSession(sessionId);
          }
        } else if (!result.ok && command.terminal && !result.surfaceUnavailable && !cancellation.cancelled) {
          command.onFailure?.();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.activeFeeds.get(sessionId)?.cancellation === cancellation) this.activeFeeds.delete(sessionId);
        this.scheduleFeed(sessionId);
        if (sessionId) this.resolveDrainedFeedSession(sessionId);
      });
    }
  }

  private async execute(
    args: string[],
    cwd: string,
    input: string | undefined,
    context: PiExtensionContextSnapshot,
    cancellation?: PiCommandCancellation,
  ): Promise<CommandResult> {
    const sessionId = context.sessionId;
    if (!this.canDispatch(sessionId)) {
      return this.surfaceUnavailableResult();
    }

    const result = await this.spawnCmux(args, cwd, input, cancellation);
    const surfaceUnavailable = this.isSurfaceResolutionFailure(result);
    let shouldLogFailure = true;
    if (surfaceUnavailable && sessionId) {
      // Claim synchronously so overlapping Feed/control failures emit one diagnostic.
      shouldLogFailure = !this.unavailableSessions.has(sessionId);
      this.unavailableSessions.add(sessionId);
    }
    if (!result.ok && result.reason !== "cancelled" && shouldLogFailure) {
      await warn(context, "cmux hook command failed", {
        ...commandFailureDetails(args, result),
        ...(surfaceUnavailable ? { surface_unavailable: true, dispatch_disabled: true } : {}),
      });
    }
    if (surfaceUnavailable) {
      return { ...result, surfaceUnavailable: true };
    }
    return result;
  }

  private spawnCmux(
    args: string[],
    cwd: string,
    input?: string,
    cancellation?: PiCommandCancellation,
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      const startedAt = performance.now();
      const timeoutMs = piCommandTimeoutMilliseconds(args);
      let settled = false;
      let stdout = "";
      let stderr = "";
      let inputError: unknown;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let terminateGrace: ReturnType<typeof setTimeout> | null = null;
      let forceSettleTimeout: ReturnType<typeof setTimeout> | null = null;
      let terminationError: Error | undefined;
      let terminationReason: CommandTerminationReason | undefined;

      const appendOutput = (current: string, chunk: unknown): string => {
        const limit = 1024 * 1024;
        if (current.length >= limit) return current;
        return current + String(chunk).slice(0, limit - current.length);
      };
      const settle = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (terminateGrace) clearTimeout(terminateGrace);
        if (forceSettleTimeout) clearTimeout(forceSettleTimeout);
        if (cancellation) cancellation.cancel = undefined;
        resolve(result);
      };
      const elapsedMilliseconds = (): number => (
        Math.max(0, Math.round(performance.now() - startedAt))
      );
      const terminatedResult = (): CommandResult => ({
        ok: false,
        status: null,
        stdout,
        stderr,
        error: terminationError,
        reason: commandFailureReason(null, terminationError, terminationReason),
        timeoutMs,
        elapsedMs: elapsedMilliseconds(),
      });

      try {
        const child = spawn(cmuxExecutable(), args, {
          env: hookEnvironment(cwd, true),
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout = appendOutput(stdout, chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr = appendOutput(stderr, chunk);
        });
        child.stdin.on("error", (error) => {
          inputError = error;
        });
        const beginTermination = (reason: CommandTerminationReason, error: Error) => {
          if (terminationError) return;
          terminationError = error;
          terminationReason = reason;
          child.stdin.destroy();
          try {
            child.kill("SIGTERM");
          } catch (_) {}
          terminateGrace = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch (_) {}
            forceSettleTimeout = setTimeout(() => {
              child.stdout.destroy();
              child.stderr.destroy();
              child.unref();
              settle(terminatedResult());
            }, 250);
          }, 250);
        };
        child.on("error", (error) => {
          settle(terminationError ? terminatedResult() : {
            ok: false,
            status: null,
            stdout,
            stderr,
            error,
            reason: commandFailureReason(null, error),
            timeoutMs,
            elapsedMs: elapsedMilliseconds(),
          });
        });
        child.on("close", (code) => {
          if (terminationError) {
            settle(terminatedResult());
            return;
          }
          const status = typeof code === "number" ? code : null;
          const error = inputError;
          const reason = commandFailureReason(status, error);
          settle({
            ok: reason === undefined,
            status,
            stdout,
            stderr,
            error,
            reason,
            timeoutMs,
            elapsedMs: elapsedMilliseconds(),
          });
        });
        if (cancellation) {
          cancellation.cancel = () => beginTermination("cancelled", new Error("cmux feed command cancelled"));
          if (cancellation.cancelled) cancellation.cancel();
        }
        timeout = setTimeout(() => {
          beginTermination("timeout", new Error(`cmux command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdin.end(input);
      } catch (error) {
        settle({
          ok: false,
          status: null,
          stdout,
          stderr,
          error,
          reason: commandFailureReason(null, error),
          timeoutMs,
          elapsedMs: elapsedMilliseconds(),
        });
      }
    });
  }

  private isSurfaceResolutionFailure(result: CommandResult): boolean {
    return !result.ok && result.status === PiCmuxCommandDispatcher.surfaceUnavailableExitCode;
  }

  private surfaceUnavailableResult(): CommandResult {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      timeoutMs: piHookTimeoutMilliseconds(),
      elapsedMs: 0,
      surfaceUnavailable: true,
    };
  }
}

function runPiGitCommand(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      cwd,
      env: hookEnvironment(cwd),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (output.length < 4096) output += String(chunk).slice(0, 4096 - output.length);
    });
    child.on("error", () => resolve(null));
    child.on("close", (status) => resolve(status === 0 ? output.trim() || null : null));
  });
}

function piToolCommand(event: unknown): string | null {
  const args = objectValue(event, ["args", "input"]);
  return firstString(
    objectValue(event, ["command", "cmd"]),
    objectValue(args, ["command", "cmd"]),
  );
}

function piPullRequestAction(command: string): string | null {
  const match = /\bgh\s+pr\s+(create|merge|close|reopen|ready|edit|view|checkout)\b/i.exec(command);
  return match?.[1]?.toLowerCase() || null;
}

function piGitMetadataCommand(command: string): boolean {
  return /\b(?:git\s+(?:checkout|switch|branch|commit|pull|rebase|reset)|gh\s+pr\s+)/i.test(command);
}

function piSidebarTargetArgs(dispatcher: PiCmuxCommandDispatcher, sessionId: string): string[] | null {
  const target = surfaceTargetArgs(dispatcher, sessionId);
  if (!target) return null;
  return target.map((value) => value === "--surface" ? "--panel" : value);
}

function piQuestionLike(value: string | undefined): boolean {
  if (!value) return false;
  return /[?？]\s*$/.test(value.trim());
}

async function publishPiWorkspaceMetadata(
  dispatcher: PiCmuxCommandDispatcher,
  context: PiExtensionContextSnapshot,
  sessionId: string,
): Promise<void> {
  if (process.env.PI_CMUX_DISABLED === "1") return;
  const target = piSidebarTargetArgs(dispatcher, sessionId);
  if (!target) return;

  await dispatcher.run(
    ["report_pwd", context.cwd, `--path=${context.cwd}`, ...target],
    context.cwd,
    undefined,
    context,
  );
  const branch = await runPiGitCommand(context.cwd, ["branch", "--show-current"]);
  if (!branch) {
    await dispatcher.run(
      ["clear_git_branch", ...target],
      context.cwd,
      undefined,
      context,
    );
    return;
  }
  await dispatcher.run(
    ["report_git_branch", branch, "--status=unknown", ...target],
    context.cwd,
    undefined,
    context,
  );
}

async function publishPiPullRequestHint(
  dispatcher: PiCmuxCommandDispatcher,
  context: PiExtensionContextSnapshot,
  sessionId: string,
  action: string,
): Promise<void> {
  if (process.env.PI_CMUX_DISABLED === "1") return;
  const target = piSidebarTargetArgs(dispatcher, sessionId);
  if (!target) return;
  await dispatcher.run(
    ["report_pr_action", action, ...target],
    context.cwd,
    undefined,
    context,
  );
}

async function publishPiQuestion(
  dispatcher: PiCmuxCommandDispatcher,
  context: PiExtensionContextSnapshot,
  turnId: string,
): Promise<void> {
  if (process.env.PI_CMUX_DISABLED === "1") return;
  const sessionId = context.sessionId;
  if (!sessionId) return;
  await sendHook(dispatcher, "notification", context, {
    hook_event_name: "questionAsked",
    event: "questionAsked",
    // Keep Pi's prompt text inside Pi. cmux needs only the semantic wait
    // signal; the host localizes the notification body.
    message: "needs_input",
    notification: { type: "question" },
    turn_id: turnId,
  });
}

async function publishPiApprovalResponse(
  dispatcher: PiCmuxCommandDispatcher,
  context: PiExtensionContextSnapshot,
  turnId: string,
  idleDialog: boolean,
): Promise<void> {
  if (process.env.PI_CMUX_DISABLED === "1") return;
  const sessionId = context.sessionId;
  if (!sessionId) return;
  await sendHook(dispatcher, "approval-response", context, {
    turn_id: turnId,
    cmux_pi_idle_dialog: idleDialog,
  });
}

interface PiUIDialogLifecycle {
  context: PiExtensionContextSnapshot;
  turnId: string;
  resolveTurn: boolean;
  workRevision: number;
  state: SessionState;
}

const inputDialogMarker = Symbol.for("pi-extensions:input-dialog");

function dialogMarker(value: unknown): unknown {
  return value == null ? undefined : (value as Record<symbol, unknown>)[inputDialogMarker];
}

function installPiUIDialogHooks(
  dispatcher: PiCmuxCommandDispatcher,
  sessionStates: Map<string, SessionState>,
  context: ExtensionContext,
  enqueueLifecycleTask: (
    sessionId: string,
    context: PiExtensionContextSnapshot,
    operation: () => Promise<unknown> | unknown,
  ) => Promise<void>,
  onDialogResolved: () => void,
): (() => void) | undefined {
  if (process.env.PI_CMUX_DISABLED === "1" || !context.hasUI || isChildSession(context)) return undefined;
  const ui = context.ui as ExtensionContext["ui"] & Record<symbol, unknown>;
  const patchKey = Symbol.for("cmux.pi.cmux-dialog-hooks");
  if (ui[patchKey]) return undefined;

  const originals = { confirm: ui.confirm, select: ui.select, input: ui.input, custom: ui.custom };
  let active = true;
  let cohort: PiUIDialogLifecycle | undefined;
  const receipts = new Set<PiUIDialogLifecycle>();
  const valid = (dialog: PiUIDialogLifecycle): boolean => active
    && sessionStates.get(dialog.context.sessionId!) === dialog.state;
  const acquire = (): PiUIDialogLifecycle | undefined => {
    if (!active) return undefined;
    const current = snapshotContext(context);
    const sessionId = current.sessionId;
    if (!sessionId) return undefined;
    const state = sessionStates.get(sessionId);
    if (!state) return undefined;
    const dialog = {
      context: current,
      turnId: state.activeTurnId || state.completionClaim?.turnId || randomUUID(),
      resolveTurn: state.activeTurnId !== undefined || state.completionClaim !== undefined,
      workRevision: state.workRevision,
      state,
    };
    receipts.add(dialog);
    state.pendingDialogs += 1;
    if (!cohort) {
      cohort = dialog;
      void enqueueLifecycleTask(sessionId, current, () => {
        if (valid(dialog)) return publishPiQuestion(dispatcher, current, dialog.turnId);
      });
    }
    return dialog;
  };
  const release = (dialog: PiUIDialogLifecycle | undefined) => {
    if (!dialog || !receipts.delete(dialog)) return;
    dialog.state.pendingDialogs -= 1;
    if (!valid(dialog)) return;
    if (receipts.size > 0) return;
    const first = cohort!;
    cohort = undefined;
    const { context: current, state, turnId } = first;
    void enqueueLifecycleTask(current.sessionId!, current, () => {
      if (!valid(first)) return;
      return publishPiApprovalResponse(
        dispatcher,
        current,
        turnId,
        // An idle form may outlive even a fully settled newer work turn.
        !first.resolveTurn && first.workRevision === state.workRevision
          && context.isIdle() && !state.activeTurnId && !state.completionClaim
          && !subagentManager()?.hasRunning(),
      );
    });
    onDialogResolved();
  };
  const invoke = <T>(tracked: boolean, operation: () => Promise<T>): Promise<T> => {
    if (!tracked || !active) return operation();
    const dialog = acquire();
    try {
      return Promise.resolve(operation()).finally(() => release(dialog));
    } catch (error) {
      release(dialog);
      throw error;
    }
  };
  const wrappers: typeof originals = {
    confirm: (...args) => invoke(dialogMarker(args[2]) !== false, () => originals.confirm.apply(ui, args)),
    select: (...args) => invoke(dialogMarker(args[2]) !== false, () => originals.select.apply(ui, args)),
    input: (...args) => invoke(dialogMarker(args[2]) !== false, () => originals.input.apply(ui, args)),
    custom: <T>(...args: Parameters<typeof ui.custom<T>>) => invoke(
      dialogMarker(args[0]) === true,
      () => originals.custom.call(ui, ...args) as Promise<T>,
    ),
  };
  Object.assign(ui, wrappers);
  ui[patchKey] = wrappers;

  return () => {
    if (!active) return;
    active = false;
    for (const receipt of receipts) receipt.state.pendingDialogs -= 1;
    receipts.clear();
    cohort = undefined;
    for (const method of ["confirm", "select", "input", "custom"] as const) {
      if (ui[method] === wrappers[method]) Object.assign(ui, { [method]: originals[method] });
    }
    if (ui[patchKey] === wrappers) delete ui[patchKey];
  };
}
async function sendHook(
  dispatcher: PiCmuxCommandDispatcher,
  subcommand: string,
  context: PiExtensionContextSnapshot,
  extra: HookExtra = {},
): Promise<boolean> {
  if (process.env.PI_CMUX_DISABLED === "1") return true;
  const sessionId = context.sessionId;
  if (!sessionId) return true;
  const target = surfaceTargetArgs(dispatcher, sessionId);
  if (!target) return !firstString(process.env.CMUX_PANEL_ID);

  const cwd = context.cwd;
  const payload: HookExtra = {
    session_id: sessionId,
    cwd,
    hook_event_name: eventName(subcommand),
    event: eventName(subcommand),
    ...extra,
  };
  const result = await dispatcher.run(
    ["hooks", "pi", subcommand, ...target],
    cwd,
    JSON.stringify(payload),
    context,
  );
  if (result.ok) rememberSurfaceTarget(dispatcher, sessionId, result);
  return result.ok;
}

const resolvedSurfaceTargets = new WeakMap<PiCmuxCommandDispatcher, Map<string, string[]>>();

function surfaceTargetsFor(dispatcher: PiCmuxCommandDispatcher): Map<string, string[]> {
  let targets = resolvedSurfaceTargets.get(dispatcher);
  if (!targets) {
    targets = new Map();
    resolvedSurfaceTargets.set(dispatcher, targets);
  }
  return targets;
}

function surfaceTargetArgs(dispatcher: PiCmuxCommandDispatcher, sessionId: string): string[] | null {
  const resolved = surfaceTargetsFor(dispatcher).get(sessionId);
  if (resolved) return [...resolved];
  const surfaceId = firstString(process.env.CMUX_SURFACE_ID);
  if (!surfaceId) return null;
  const args: string[] = [];
  const workspaceId = firstString(process.env.CMUX_WORKSPACE_ID);
  if (workspaceId) args.push("--workspace", workspaceId);
  args.push("--surface", surfaceId);
  return args;
}

function rememberSurfaceTarget(
  dispatcher: PiCmuxCommandDispatcher,
  sessionId: string,
  result: CommandResult,
): void {
  const payload = parseJSONOutput(result);
  const workspaceId = firstString(payload?.workspace_id);
  const surfaceId = firstString(payload?.surface_id);
  if (!workspaceId || !surfaceId) return;
  surfaceTargetsFor(dispatcher).set(
    sessionId,
    ["--workspace", workspaceId, "--surface", surfaceId],
  );
}

function releaseSessionRuntime(
  dispatcher: PiCmuxCommandDispatcher,
  sessionStates: Map<string, SessionState>,
  sessionId: string,
): void {
  dispatcher.releaseSession(sessionId);
  sessionStates.delete(sessionId);
  surfaceTargetsFor(dispatcher).delete(sessionId);
}

function parseJSONOutput(result: CommandResult): Record<string, unknown> | null {
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch (_) {
    return null;
  }
}

async function clearResumeBinding(
  dispatcher: PiCmuxCommandDispatcher,
  context: PiExtensionContextSnapshot,
  sessionId: string,
): Promise<void> {
  if (process.env.PI_CMUX_DISABLED === "1") return;
  const target = surfaceTargetArgs(dispatcher, sessionId);
  if (!target) return;
  const cwd = context.cwd;
  await dispatcher.run([
    "--json",
    "surface",
    "resume",
    "clear",
    ...target,
    "--checkpoint-id",
    sessionId,
    "--source",
    "agent-hook",
  ], cwd, undefined, context);
}

type PiFeedEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop";

const subagentToolNames = new Set([
  "subagent",
  "team_spawn",
  "superpowers_dispatch",
  // Mirrors the "Task" entry above: spawn-tool names seen across
  // Claude-compatible harnesses. Claude Code renamed its own spawn tool
  // "Task" -> "Agent" in 2.x and both spellings remain in use, and the
  // /subagent/i fallback below matches neither.
  "Task",
  "Agent",
]);

function isSubagentTool(event: unknown): boolean {
  const toolName = firstString(objectValue(event, ["toolName", "tool_name", "name"]));
  return toolName !== null && (subagentToolNames.has(toolName) || /subagent/i.test(toolName));
}

function isTerminalFeedEvent(eventName: PiFeedEventName): boolean {
  return eventName === "PostToolUse" || eventName === "SubagentStop";
}

function prepareFeedDispatch(
  dispatcher: PiCmuxCommandDispatcher,
  sessionStates: Map<string, SessionState>,
  eventName: PiFeedEventName,
  context: PiExtensionContextSnapshot,
  event: unknown,
): (() => void) | undefined {
  if (process.env.PI_CMUX_DISABLED === "1") return undefined;
  const sessionId = context.sessionId;
  if (!sessionId) return undefined;
  if (!dispatcher.canDispatch(sessionId)) return undefined;
  const state = stateFor(sessionStates, sessionId);
  if (state.stopped || state.completionClaim) return undefined;
  const cwd = context.cwd;
  const toolCallId = firstString(objectValue(event, ["toolCallId", "tool_call_id", "id"]));
  const toolName = firstString(objectValue(event, ["toolName", "tool_name", "name"]));
  const turnId = currentTurnId(sessionStates, sessionId, event);
  const toolInput = objectValue(event, ["args", "input"]);
  const terminal = isTerminalFeedEvent(eventName);
  const toolResult = terminal
    ? objectValue(event, ["result", "details", "content"])
    : undefined;
  const isError = terminal ? objectValue(event, ["isError", "is_error"]) : undefined;
  return () => {
    const target = surfaceTargetArgs(dispatcher, sessionId);
    if (!target) return;

    // Pi invokes tool lifecycle handlers on its UI event loop. Keep those
    // callbacks lightweight by traversing and bounding tool payloads only in
    // the already-detached lifecycle task.
    const projectionState: PiFeedProjectionState = { remainingNodes: 48, seen: new WeakSet() };
    const payload: HookExtra = {
      session_id: utf8Prefix(sessionId, 256),
      cwd: utf8Prefix(cwd, 2048),
      hook_event_name: eventName,
      event: eventName,
      turn_id: utf8Prefix(turnId, 256),
    };
    const boundedToolCallId = utf8Prefix(toolCallId, 256);
    if (boundedToolCallId !== undefined) payload.tool_call_id = boundedToolCallId;
    const boundedToolName = utf8Prefix(toolName, 256);
    if (boundedToolName !== undefined) payload.tool_name = boundedToolName;
    if (toolInput !== undefined) payload.tool_input = projectPiFeedValue(toolInput, projectionState);
    if (toolResult !== undefined) {
      payload.tool_result = projectPiFeedValue(toolResult, projectionState, 0, false);
    }
    if (isError !== undefined) payload.is_error = projectPiFeedValue(isError, projectionState);
    dispatcher.enqueueFeed(`${sessionId}:${toolCallId || toolName || "unknown"}`, {
      args: ["hooks", "feed", "--source", "pi", "--event", eventName, ...target],
      cwd,
      payload,
      context,
      terminal,
      onFailure: () => { state.feedDeliveryFailed = true; },
    });
  };
}

async function warnFeedDeliveryDropped(
  context: PiExtensionContextSnapshot,
  sessionId: string,
): Promise<void> {
  await warn(context, "cmux feed delivery dropped", {
    session_id: sessionId,
    hook_name: "feed",
    reason: "dispatch-dropped",
  });
}

async function publishPendingCompletion(
  dispatcher: PiCmuxCommandDispatcher,
  state: SessionState,
  sessionId: string,
  completion: CompletionClaim,
  ownsClaim: () => boolean,
  canPublish: () => boolean,
): Promise<void> {
  if (!canPublish()) return;
  const context = completion.context;
  if (completion.feedDelivered === undefined) {
    await dispatcher.finishFeedForSession(sessionId);
    if (!ownsClaim()) return;
    completion.feedDelivered = !state.feedDeliveryFailed;
    state.feedDeliveryFailed = false;
    if (!completion.feedDelivered) await warnFeedDeliveryDropped(context, sessionId);
  }
  if (!canPublish()) return;
  if (!completion.suppressNotification && completion.feedDelivered && completion.notificationRouted === undefined) {
    completion.notificationRouted = false;
    completion.notificationRouted = await sendHook(dispatcher, "notification", context, {
      // cmux scans notification bodies before completion signals, so answer
      // text mentioning approvals or errors can override the settled state.
      message: completion.notificationType === "question"
        ? completion.lastAssistantMessage || "Waiting for input"
        : "Task completed",
      turn_id: completion.turnId,
      notification: { type: completion.notificationType },
    });
  }
  if (!canPublish()) return;
  const stopPayload: HookExtra = {
    last_assistant_message: completion.lastAssistantMessage,
    turn_id: completion.turnId,
  };
  // Preserve intentional suppression and the routed result across deferred retries.
  if (completion.suppressNotification || completion.notificationRouted) stopPayload.cmux_notification_routed = true;
  state.stopped = true;
  state.completionClaim = undefined;
  await sendHook(dispatcher, "stop", context, stopPayload);
}

// A stalled lifecycle hook may run for its full configured timeout while Pi
// keeps emitting tool events. Bound the pending tasks a session can stack
// behind it so bursts cannot pin unbounded event payloads: droppable Feed
// preparation is shed first and surfaces as a dropped delivery at completion.
const maximumPiLifecycleBacklogTasks = 32;

interface PiLifecycleQueue {
  enqueue(
    sessionId: string,
    context: PiExtensionContextSnapshot,
    operation: () => Promise<unknown> | unknown,
  ): Promise<void>;
  tryEnqueue(
    sessionId: string,
    context: PiExtensionContextSnapshot,
    operation: () => Promise<unknown> | unknown,
  ): boolean;
}

function createPiLifecycleQueue(): PiLifecycleQueue {
  const tails = new Map<string, Promise<void>>();
  const pendingCounts = new Map<string, number>();
  const enqueue = (
    sessionId: string,
    context: PiExtensionContextSnapshot,
    operation: () => Promise<unknown> | unknown,
  ): Promise<void> => {
    pendingCounts.set(sessionId, (pendingCounts.get(sessionId) || 0) + 1);
    const previous = tails.get(sessionId) || Promise.resolve();
    let tracked: Promise<void>;
    tracked = previous
      .then(operation)
      .then(() => undefined)
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : undefined;
        return warn(context, "cmux lifecycle task failed", {
          hook_name: "lifecycle-task",
          reason: "extension-error",
          error_available: error !== undefined,
          error_message: utf8Prefix(errorMessage, 512),
        });
      })
      .finally(() => {
        const remaining = (pendingCounts.get(sessionId) || 1) - 1;
        if (remaining > 0) pendingCounts.set(sessionId, remaining);
        else pendingCounts.delete(sessionId);
        if (tails.get(sessionId) === tracked) tails.delete(sessionId);
      });
    tails.set(sessionId, tracked);
    return tracked;
  };
  return {
    enqueue,
    tryEnqueue(sessionId, context, operation) {
      if ((pendingCounts.get(sessionId) || 0) >= maximumPiLifecycleBacklogTasks) return false;
      void enqueue(sessionId, context, operation);
      return true;
    },
  };
}

export default function cmuxPiSessionExtension(pi: ExtensionAPI) {
  const dispatcher = new PiCmuxCommandDispatcher();
  const sessionStates = new Map<string, SessionState>();
  const lifecycleTasks = createPiLifecycleQueue();
  let restorePiUIDialogHooks: (() => void) | undefined;
  let unsubscribeSubagentStarted: (() => void) | undefined;
  const waitingForSubagents = new WeakSet<SessionState>();

  const enqueueLifecycleTask = (
    sessionId: string,
    context: PiExtensionContextSnapshot,
    operation: () => Promise<unknown> | unknown,
  ): Promise<void> => lifecycleTasks.enqueue(sessionId, context, operation);

  const publishCompletionWhenIdle = (ctx: ExtensionContext): void => {
    const context = snapshotContext(ctx);
    const sessionId = context.sessionId;
    if (!sessionId || !ctx.isIdle()) return;
    const state = sessionStates.get(sessionId);
    if (!state || (!state.pendingCompletion && !state.completionClaim)
      || state.stopped || state.pendingDialogs > 0) return;
    const manager = subagentManager();
    if (manager?.hasRunning()) {
      if (waitingForSubagents.has(state)) return;
      waitingForSubagents.add(state);
      // Waiting is detached: awaiting here would hold up Pi's own settlement.
      void manager.waitForAll().then(() => {
        waitingForSubagents.delete(state);
        if (sessionStates.get(sessionId) === state) {
          publishCompletionWhenIdle(ctx);
        }
      }).catch((error) => {
        waitingForSubagents.delete(state);
        void warn(context, "cmux subagent settlement wait failed", {
          error_message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    const completion = settleTurn(state, context);
    if (!completion || completion.queued) return;
    const ownsClaim = () => sessionStates.get(sessionId) === state && state.completionClaim === completion;
    const canPublish = () => ownsClaim() && ctx.isIdle()
      && state.pendingDialogs === 0 && !subagentManager()?.hasRunning();
    completion.queued = true;
    void enqueueLifecycleTask(sessionId, completion.context, async () => {
      try {
        await publishPendingCompletion(dispatcher, state, sessionId, completion, ownsClaim, canPublish);
      } finally {
        completion.queued = false;
        // A receipt can release after publication returns but before queued is
        // cleared. Recheck so that close's skipped retry is not lost.
        if (ownsClaim()) publishCompletionWhenIdle(ctx);
      }
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (isChildSession(ctx)) return;
    unsubscribeSubagentStarted?.();
    unsubscribeSubagentStarted = pi.events.on("subagents:started", () => {
      const context = snapshotContext(ctx);
      const sessionId = context.sessionId;
      if (!sessionId || !ctx.isIdle()) return;
      const state = stateFor(sessionStates, sessionId);
      if (state.activeTurnId) return;
      // Scheduled and @handle spawns can start without a parent model turn.
      const turnId = beginTurn(sessionStates, sessionId, {});
      state.pendingCompletion = {
        notificationType: "completed",
        turnId,
        suppressNotification: false,
      };
      enqueueLifecycleTask(sessionId, context, () => (
        sendHook(dispatcher, "prompt-submit", context, { turn_id: turnId })
      ));
      publishCompletionWhenIdle(ctx);
    });
    const context = snapshotContext(ctx);
    const sessionId = context.sessionId;
    if (sessionId) {
      // Invalidate detached waits belonging to the previous session activation.
      sessionStates.delete(sessionId);
      const state = stateFor(sessionStates, sessionId);
      state.pendingCompletion = undefined;
      state.feedDeliveryFailed = false;
      state.stopped = false;
      state.toolCommands.clear();
    }
    restorePiUIDialogHooks?.();
    restorePiUIDialogHooks = installPiUIDialogHooks(
      dispatcher,
      sessionStates,
      ctx,
      enqueueLifecycleTask,
      () => publishCompletionWhenIdle(ctx),
    );
    if (!sessionId) return;
    enqueueLifecycleTask(sessionId, context, async () => {
      await sendHook(dispatcher, "session-start", context);
      await publishPiWorkspaceMetadata(dispatcher, context, sessionId);
    });
  });

  pi.on("before_agent_start", (event, ctx) => {
    const context = snapshotContext(ctx);
    const sessionId = context.sessionId;
    if (!sessionId) return;
    const turnId = beginTurn(sessionStates, sessionId, event);
    enqueueLifecycleTask(sessionId, context, () => (
      sendHook(dispatcher, "prompt-submit", context, { prompt: event.prompt, turn_id: turnId })
    ));
  });

  pi.on("agent_start", (event, ctx) => {
    const context = snapshotContext(ctx);
    const sessionId = context.sessionId;
    if (!sessionId) return;
    // Idle sendMessage({ triggerTurn: true }) skips before_agent_start.
    // Normal prompts, retries, and queued continuations already own a turn;
    // keep that ID and its pending completion until agent_settled claims it.
    if (stateFor(sessionStates, sessionId).activeTurnId) return;
    const turnId = beginTurn(sessionStates, sessionId, event);
    enqueueLifecycleTask(sessionId, context, () => (
      sendHook(dispatcher, "prompt-submit", context, { turn_id: turnId })
    ));
  });

  const enqueueFeed = (
    eventName: PiFeedEventName,
    event: unknown,
    ctx: ExtensionContext,
  ): void => {
    const context = snapshotContext(ctx);
    const sessionId = context.sessionId;
    if (!sessionId) return;
    const dispatch = prepareFeedDispatch(dispatcher, sessionStates, eventName, context, event);
    if (!dispatch) return;
    if (!lifecycleTasks.tryEnqueue(sessionId, context, dispatch)) {
      // A shed completion must fail visibly instead of reporting delivery.
      if (isTerminalFeedEvent(eventName)) stateFor(sessionStates, sessionId).feedDeliveryFailed = true;
    }
  };

  pi.on("tool_execution_start", (event, ctx) => {
    const context = snapshotContext(ctx);
    const sessionId = context.sessionId;
    const toolCallId = firstString(objectValue(event, ["toolCallId", "tool_call_id", "id"]));
    const command = piToolCommand(event);
    if (sessionId && toolCallId && command) {
      stateFor(sessionStates, sessionId).toolCommands.set(toolCallId, command);
    }
    enqueueFeed(isSubagentTool(event) ? "SubagentStart" : "PreToolUse", event, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    enqueueFeed(isSubagentTool(event) ? "SubagentStop" : "PostToolUse", event, ctx);
    const context = snapshotContext(ctx);
    const sessionId = context.sessionId;
    const toolCallId = firstString(objectValue(event, ["toolCallId", "tool_call_id", "id"]));
    const state = sessionId ? stateFor(sessionStates, sessionId) : undefined;
    const command = piToolCommand(event)
      || (toolCallId ? state?.toolCommands.get(toolCallId) : undefined);
    if (toolCallId) state?.toolCommands.delete(toolCallId);
    if (sessionId && command && piGitMetadataCommand(command)) {
      const action = piPullRequestAction(command);
      enqueueLifecycleTask(sessionId, context, async () => {
        await publishPiWorkspaceMetadata(dispatcher, context, sessionId);
        if (action) await publishPiPullRequestHint(dispatcher, context, sessionId, action);
      });
    }
  });

  pi.on("session_before_compact", (event, ctx) => {
    enqueueFeed("PreCompact", event, ctx);
  });

  pi.on("session_compact", (event, ctx) => {
    enqueueFeed("PostCompact", event, ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    const context = snapshotContext(ctx);
    const sessionId = context.sessionId;
    if (!sessionId) return;
    const state = stateFor(sessionStates, sessionId);
    const assistantCompletion = assistantCompletionFrom(event);
    // Preserve the latest low-level result until Pi confirms no automatic work remains.
    state.pendingCompletion = {
      lastAssistantMessage: assistantCompletion.lastAssistantMessage || state.pendingCompletion?.lastAssistantMessage,
      notificationType: piQuestionLike(assistantCompletion.lastAssistantMessage) ? "question" : (firstString(objectValue(event, ["stopReason", "reason", "terminationReason"])) || "completed"),
      turnId: currentTurnId(sessionStates, sessionId, event),
      suppressNotification: assistantCompletion.suppressNotification,
    };
  });

  pi.on("agent_settled", (_event, ctx) => {
    publishCompletionWhenIdle(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (isChildSession(ctx)) return;
    unsubscribeSubagentStarted?.();
    unsubscribeSubagentStarted = undefined;
    const context = snapshotContext(ctx);
    const sessionId = context.sessionId;
    if (!sessionId) {
      restorePiUIDialogHooks?.();
      restorePiUIDialogHooks = undefined;
      return;
    }
    const state = stateFor(sessionStates, sessionId);
    const completion = state.completionClaim;
    let stopPayload: HookExtra | undefined;
    if (!state.stopped) {
      const turnId = completion?.turnId || currentTurnId(sessionStates, sessionId, event);
      finishTurn(sessionStates, sessionId, { turn_id: turnId });
      stopPayload = {
        turn_id: turnId,
        terminationReason: firstString(objectValue(event, ["reason"])) || "session_shutdown",
      };
    }
    state.completionClaim = undefined;
    restorePiUIDialogHooks?.();
    restorePiUIDialogHooks = undefined;
    await enqueueLifecycleTask(sessionId, context, async () => {
      const ownsState = () => sessionStates.get(sessionId) === state;
      if (!ownsState()) return;
      await dispatcher.finishFeedForSession(sessionId);
      if (!ownsState()) return;
      const feedDelivered = !state.feedDeliveryFailed;
      state.feedDeliveryFailed = false;
      if (!feedDelivered) await warnFeedDeliveryDropped(context, sessionId);
      if (!ownsState()) return;
      if (stopPayload) {
        // An in-flight notification may finish after shutdown invalidates its
        // completion claim but before this ordered shutdown job dispatches Stop.
        if (completion?.notificationRouted || completion?.suppressNotification) stopPayload.cmux_notification_routed = true;
        await sendHook(dispatcher, "stop", context, stopPayload);
      }
      if (!ownsState()) return;
      try {
        await clearResumeBinding(dispatcher, context, sessionId);
      } finally {
        if (ownsState()) releaseSessionRuntime(dispatcher, sessionStates, sessionId);
      }
    });
  });
}