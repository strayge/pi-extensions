import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { type AgentSession, estimateTokens, type SettingsManager } from "@earendil-works/pi-coding-agent";

export const SOFT_REMAINING_RATIO = 0.3;
export const SOFT_REMAINING_FLOOR = 32_000;
export const HARD_REMAINING_RATIO = 0.1;
export const HARD_REMAINING_FLOOR = 16_000;
export const RESERVE_RATIO = 0.02;
export const RESERVE_FLOOR = 4_000;
export const MIN_SUPPORTED_CONTEXT_WINDOW = 16_000;

export interface BudgetSnapshot {
  contextWindow: number;
  usedTokens: number;
  remaining: number;
  remainingPercent: number;
  softThreshold: number;
  hardThreshold: number;
  reserve: number;
  soft: boolean;
  hard: boolean;
}

export interface AttemptSnapshot {
  usedTokens: number;
  contextWindow: number;
}

/**
 * Keeps threshold arithmetic in one place so provider/session integrations only
 * decide which occupancy measurement is authoritative.
 */
export function snapshotBudget(contextWindow: number, usedTokens: number): BudgetSnapshot {
  const window = positiveInteger(contextWindow);
  const used = Math.max(0, Math.ceil(Number.isFinite(usedTokens) ? usedTokens : 0));
  const remaining = Math.max(0, window - used);
  const softThreshold = Math.ceil(Math.max(window * SOFT_REMAINING_RATIO, SOFT_REMAINING_FLOOR));
  const hardThreshold = Math.ceil(Math.max(window * HARD_REMAINING_RATIO, HARD_REMAINING_FLOOR));
  const reserve = Math.ceil(Math.max(window * RESERVE_RATIO, RESERVE_FLOOR));

  return {
    contextWindow: window,
    usedTokens: used,
    remaining,
    remainingPercent: (remaining / window) * 100,
    softThreshold,
    hardThreshold,
    reserve,
    soft: remaining <= softThreshold,
    hard: remaining <= hardThreshold,
  };
}

/** Leaves room for both the convergence notice and the context safety reserve. */
export function computeFinalCap(remaining: number, reserve: number, noticeTokens: number): number {
  return Math.max(0, Math.floor(remaining) - Math.ceil(reserve) - Math.max(0, Math.ceil(noticeTokens)));
}

/**
 * Failed output is added to the attempt's input snapshot exactly once. Provider
 * lifetime totals are intentionally not involved because compaction resets occupancy.
 */
export function shouldSuppressRetry(attempt: AttemptSnapshot, generatedTokens: number): boolean {
  const snapshot = snapshotBudget(
    attempt.contextWindow,
    attempt.usedTokens + Math.max(0, Math.ceil(generatedTokens)),
  );
  return snapshot.remaining <= snapshot.reserve;
}

/** Uses Pi's own fallback estimator over the transformed provider context. */
export function estimateRequestTokens(context: Context): number {
  const messageTokens = context.messages.reduce(
    (total, message) => total + estimateTokens(message as never),
    0,
  );
  const overhead = JSON.stringify({
    systemPrompt: context.systemPrompt ?? "",
    tools: context.tools ?? [],
  });
  return messageTokens + estimateTextTokens(overhead);
}

/** Generic messages avoid assumptions about the delegated task or agent type. */
export function buildSoftNotice(snapshot: BudgetSnapshot): string {
  return [
    `Context remaining: ${snapshot.remaining.toLocaleString("en-US")} tokens (${snapshot.remainingPercent.toFixed(1)}%).`,
    "Converge now: prioritize important unfinished work, avoid unnecessary expansion, and preserve room for a clear result.",
  ].join(" ");
}

export function buildHardNotice(snapshot: BudgetSnapshot, finalCap: number): string {
  return [
    `Context remaining: ${snapshot.remaining.toLocaleString("en-US")} tokens (${snapshot.remainingPercent.toFixed(1)}%).`,
    `Return the final result now within ${finalCap.toLocaleString("en-US")} output tokens.`,
    "Do not begin new work or call tools. State anything incomplete or uncertain explicitly.",
  ].join(" ");
}

/**
 * Provider SDK retries happen inside one Agent turn and are invisible to session
 * retry events. Force them off at the stream boundary for the whole child session.
 */
export function installProviderRetryGuard(session: AgentSession): void {
  const original = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => original(model, context, {
    ...options,
    maxRetries: 0,
  });
}

interface ContextBudgetRuntime {
  settingsManager: SettingsManager;
  promptActive: boolean;
  promptSignal?: AbortSignal;
  softNotice?: string;
  hardFinal: boolean;
  finalAttemptStarted: boolean;
  terminal: boolean;
}

const runtimes = new WeakMap<AgentSession, ContextBudgetRuntime>();

/**
 * Installs the minimal request-boundary guard once per retained child session.
 * The outgoing transformed context is the authority, so dynamic model/context
 * changes are checked immediately before provider dispatch.
 */
export function installContextBudgetGuard(session: AgentSession, settingsManager: SettingsManager): void {
  if (runtimes.has(session)) return;
  const runtime: ContextBudgetRuntime = {
    settingsManager,
    promptActive: false,
    hardFinal: false,
    finalAttemptStarted: false,
    terminal: false,
  };
  runtimes.set(session, runtime);

  const originalStream = session.agent.streamFunction;
  const dispatchHardFinal = (
    model: Parameters<typeof originalStream>[0],
    context: Parameters<typeof originalStream>[1],
    options: Parameters<typeof originalStream>[2],
    snapshot: BudgetSnapshot,
  ): ReturnType<typeof originalStream> => {
    makeTerminal(runtime, session);
    runtime.hardFinal = true;
    const provisionalNotice = buildHardNotice(snapshot, snapshot.remaining);
    const noticeTokens = estimateTextTokens(provisionalNotice) + 16;
    const cap = computeFinalCap(snapshot.remaining, snapshot.reserve, noticeTokens);
    if (cap === 0) {
      return terminalErrorStream(model, "Context budget has no safe room for a final provider attempt.");
    }
    runtime.finalAttemptStarted = true;
    const notice = buildHardNotice(snapshot, cap);
    const cappedModel = {
      ...model,
      maxTokens: model.maxTokens > 0 ? Math.min(model.maxTokens, cap) : cap,
    };
    session.setActiveToolsByName([]);
    return originalStream(
      cappedModel,
      {
        ...context,
        messages: [
          ...context.messages,
          { role: "user", content: notice, timestamp: Date.now() },
        ],
        tools: [],
      },
      options,
    );
  };

  session.agent.streamFunction = (model, context, options) => {
    const providerOptions = { ...options, maxRetries: 0 };
    if (!runtime.promptActive) {
      return originalStream(model, context, providerOptions);
    }
    if (runtime.terminal) {
      const reason = runtime.finalAttemptStarted
        ? "Context-terminal session blocked an additional provider attempt."
        : "Context-terminal session cannot dispatch provider requests.";
      return terminalErrorStream(model, reason, true);
    }
    const cancelled = runtime.promptSignal?.aborted || options?.signal?.aborted || session.agent.signal?.aborted;
    if (cancelled) {
      return terminalErrorStream(model, "Subagent prompt was cancelled before provider dispatch.", true);
    }
    if (session.isCompacting) {
      return originalStream(model, context, providerOptions);
    }

    const snapshot = snapshotBudget(model.contextWindow, estimateRequestTokens(context));
    if (model.contextWindow <= MIN_SUPPORTED_CONTEXT_WINDOW) {
      makeTerminal(runtime, session);
      return terminalErrorStream(
        model,
        `Model context window (${model.contextWindow.toLocaleString("en-US")} tokens) is too small for guarded subagent execution.`,
      );
    }

    if (snapshot.hard) {
      return dispatchHardFinal(model, context, providerOptions, snapshot);
    }

    if (runtime.softNotice) {
      const warnedContext = appendNotice(context, runtime.softNotice);
      const warnedSnapshot = snapshotBudget(model.contextWindow, estimateRequestTokens(warnedContext));
      if (warnedSnapshot.hard) {
        return dispatchHardFinal(model, context, providerOptions, snapshot);
      }
      return originalStream(model, warnedContext, providerOptions);
    }

    if (snapshot.soft) {
      const notice = buildSoftNotice(snapshot);
      const warnedContext = appendNotice(context, notice);
      const warnedSnapshot = snapshotBudget(model.contextWindow, estimateRequestTokens(warnedContext));
      if (warnedSnapshot.hard) {
        return dispatchHardFinal(model, context, providerOptions, snapshot);
      }
      runtime.softNotice = notice;
      return originalStream(model, warnedContext, providerOptions);
    }

    return originalStream(model, context, providerOptions);
  };

  session.subscribe((event) => {
    if (event.type === "agent_end" && runtime.terminal) session.clearQueue();
  });

  const priorStop = session.agent.shouldStopAfterTurn;
  session.agent.shouldStopAfterTurn = async (context, signal) => {
    if (await priorStop?.(context, signal)) return true;
    return runtime.hardFinal;
  };

  const priorBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (runtime.hardFinal) {
      return { block: true, reason: "Context finalization does not permit tool calls." };
    }
    return priorBeforeToolCall?.(context, signal);
  };
}

export function beginContextBudgetPrompt(session: AgentSession, signal?: AbortSignal): void {
  const runtime = runtimes.get(session);
  if (!runtime) return;
  if (runtime.terminal) throw new Error("This subagent session is terminal because its context budget was exhausted.");
  runtime.promptActive = true;
  runtime.promptSignal = signal;
  runtime.softNotice = undefined;
  runtime.hardFinal = false;
  runtime.finalAttemptStarted = false;
}

export function finishContextBudgetPrompt(session: AgentSession): { terminal: boolean } {
  const runtime = runtimes.get(session);
  if (!runtime) return { terminal: false };
  runtime.promptActive = false;
  runtime.promptSignal = undefined;
  if (runtime.terminal) session.clearQueue();
  return { terminal: runtime.terminal };
}

export function isContextBudgetTerminal(session: AgentSession): boolean {
  return runtimes.get(session)?.terminal ?? false;
}

function estimateTextTokens(text: string): number {
  return estimateTokens({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  });
}

function appendNotice(context: Context, notice: string): Context {
  return {
    ...context,
    messages: [
      ...context.messages,
      { role: "user", content: notice, timestamp: Date.now() },
    ],
  };
}

function makeTerminal(runtime: ContextBudgetRuntime, session: AgentSession): void {
  runtime.terminal = true;
  runtime.settingsManager.applyOverrides({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  session.clearQueue();
}

/** Creates a provider-free terminal response for pre-dispatch guard failures. */
export function terminalErrorStream(model: Model<Api>, message: string, aborted = false): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const stopReason = aborted ? "aborted" : "error";
  const response: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: message,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: response });
    stream.push({ type: "error", reason: stopReason, error: response });
  });
  return stream;
}

function positiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`contextWindow must be a positive number, got ${value}`);
  }
  return Math.ceil(value);
}
