import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelProgressWatchdogMetadata } from "./types.js";

export const MODEL_PROGRESS_TIMEOUT_FAILURE =
  "The agent stopped making model progress after two watchdog timeouts.";

export const MODEL_PROGRESS_RECOVERY_FAILURE =
  "The watchdog continuation ended without a successful assistant response.";

export const MODEL_PROGRESS_CONTINUATION_PROMPT =
  "The previous model response stopped making progress and was interrupted. Continue the same task from where you left off, avoid repeating completed work, and finish with the required final answer.";

type AssistantOutcome = "completed" | "error" | "aborted";

interface ActivePrompt {
  timedOut: boolean;
  assistantOutcome?: AssistantOutcome;
}

export interface ModelProgressWatchdog {
  prompt(text: string): Promise<void>;
  getFailure(): string | undefined;
  getMetadata(recovered: boolean): ModelProgressWatchdogMetadata | undefined;
  cleanup(): void;
}

/**
 * Bounds silent child-model waits while leaving tool execution and session ownership to the caller.
 */
export function createModelProgressWatchdog(options: {
  session: AgentSession;
  timeoutMinutes: number;
  signal?: AbortSignal;
  isHardTurnLimitAborted: () => boolean;
}): ModelProgressWatchdog {
  const { session, timeoutMinutes, signal, isHardTurnLimitAborted } = options;
  const timeoutMs = timeoutMinutes * 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activePrompt: ActivePrompt | undefined;
  let timeoutCount = 0;
  let recoveryAttempted = false;
  let terminalFailure: string | undefined;
  let cleanedUp = false;

  const disarm = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = () => {
    if (cleanedUp || timeoutMs <= 0 || activePrompt === undefined || activePrompt.timedOut) return;
    disarm();
    timer = setTimeout(() => {
      timer = undefined;
      const prompt = activePrompt;
      if (cleanedUp || prompt === undefined || prompt.timedOut) return;
      prompt.timedOut = true;
      timeoutCount++;
      if (timeoutCount >= 2) terminalFailure = MODEL_PROGRESS_TIMEOUT_FAILURE;
      try {
        void Promise.resolve(session.abort()).catch(() => {});
      } catch {
        // The timed prompt still owns settlement; a synchronous abort failure
        // must not let the timer callback crash the parent process.
      }
    }, timeoutMs);
    timer.unref?.();
  };

  const unsubscribe = timeoutMs > 0
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "turn_start") arm();
        if (event.type === "message_update") arm();
        if (event.type === "message_end" && event.message.role === "assistant") {
          disarm();
          if (activePrompt !== undefined) {
            const stopReason = event.message.stopReason;
            activePrompt.assistantOutcome = stopReason === "error"
              ? "error"
              : stopReason === "aborted"
                ? "aborted"
                : "completed";
          }
        }
      })
    : () => {};

  const cancelled = () => signal?.aborted === true || isHardTurnLimitAborted();

  return {
    async prompt(text: string): Promise<void> {
      // Cancellation can win before the runner reaches its first prompt (for
      // example, a queued invocation whose parent stopped meanwhile). Never
      // enter the child session in that case: there is no prompt to recover.
      if (cancelled()) return;

      let nextPrompt = text;
      let isRecoveryPrompt = false;
      for (;;) {
        const promptState: ActivePrompt = { timedOut: false };
        activePrompt = promptState;
        let promptError: unknown;
        try {
          await session.prompt(nextPrompt);
        } catch (error) {
          promptError = error;
        } finally {
          disarm();
          if (activePrompt === promptState) activePrompt = undefined;
        }

        if (!promptState.timedOut) {
          if (promptError !== undefined) throw promptError;
          if (isRecoveryPrompt
            && promptState.assistantOutcome !== "completed"
            && promptState.assistantOutcome !== "error") {
            terminalFailure = MODEL_PROGRESS_RECOVERY_FAILURE;
          }
          return;
        }
        if (terminalFailure !== undefined) return;
        if (cancelled()) {
          if (promptError !== undefined) throw promptError;
          return;
        }

        recoveryAttempted = true;
        isRecoveryPrompt = true;
        nextPrompt = MODEL_PROGRESS_CONTINUATION_PROMPT;
        if (cancelled()) {
          if (promptError !== undefined) throw promptError;
          return;
        }
      }
    },

    getFailure: () => terminalFailure,

    getMetadata(recovered: boolean): ModelProgressWatchdogMetadata | undefined {
      if (timeoutCount === 0) return undefined;
      return {
        timeoutMinutes,
        timeoutCount,
        recoveryAttempted,
        recovered: recovered && recoveryAttempted && terminalFailure === undefined,
      };
    },

    cleanup(): void {
      if (cleanedUp) return;
      cleanedUp = true;
      activePrompt = undefined;
      disarm();
      unsubscribe();
    },
  };
}
