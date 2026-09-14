import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createModelProgressWatchdog,
  MODEL_PROGRESS_CONTINUATION_PROMPT,
  MODEL_PROGRESS_RECOVERY_FAILURE,
  MODEL_PROGRESS_TIMEOUT_FAILURE,
} from "../src/model-progress-watchdog.js";

const MINUTE = 60_000;

function createSession() {
  const listeners = new Set<(event: any) => void>();
  let settlePrompt: ((value?: void | PromiseLike<void>) => void) | undefined;
  const session = {
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    prompt: vi.fn((_: string) => {
      emit({ type: "turn_start" });
      return new Promise<void>((resolve) => {
        settlePrompt = resolve;
      });
    }),
    abort: vi.fn(() => {
      settlePrompt?.();
      return Promise.resolve();
    }),
  };
  const emit = (event: any) => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    session,
    emit,
    settle: () => settlePrompt?.(),
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("model progress watchdog", () => {
  it("does not prompt or recover when cancellation already won", async () => {
    const harness = createSession();
    const controller = new AbortController();
    controller.abort();
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      signal: controller.signal,
      isHardTurnLimitAborted: () => false,
    });

    await watchdog.prompt("must not start");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.session.abort).not.toHaveBeenCalled();
    expect(watchdog.getMetadata(false)).toBeUndefined();
    watchdog.cleanup();
  });

  it("allocates no subscription or timer when disabled", async () => {
    const harness = createSession();
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 0,
      isHardTurnLimitAborted: () => false,
    });

    const prompting = watchdog.prompt("start");
    expect(harness.session.subscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(harness.session.abort).not.toHaveBeenCalled();
    harness.settle();
    await prompting;
    watchdog.cleanup();
    expect(harness.session.prompt).toHaveBeenCalledTimes(1);
  });

  it("aborts initial silence and continues once in the same session", async () => {
    const harness = createSession();
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      isHardTurnLimitAborted: () => false,
    });

    const prompting = watchdog.prompt("start");
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(harness.session.abort).toHaveBeenCalledTimes(1);
    expect(harness.session.prompt).toHaveBeenNthCalledWith(2, MODEL_PROGRESS_CONTINUATION_PROMPT);
    harness.emit({ type: "message_end", message: { role: "assistant" } });
    harness.settle();
    await prompting;

    expect(watchdog.getFailure()).toBeUndefined();
    expect(watchdog.getMetadata(true)).toEqual({
      timeoutMinutes: 1,
      timeoutCount: 1,
      recoveryAttempted: true,
      recovered: true,
    });
    watchdog.cleanup();
  });

  it.each(["text_delta", "thinking_delta", "toolcall_delta"])(
    "resets the silence window for a %s update",
    async (eventType) => {
      const harness = createSession();
      const watchdog = createModelProgressWatchdog({
        session: harness.session as never,
        timeoutMinutes: 1,
        isHardTurnLimitAborted: () => false,
      });
      const prompting = watchdog.prompt("start");

      await vi.advanceTimersByTimeAsync(MINUTE - 1);
      harness.emit({ type: "message_update", assistantMessageEvent: { type: eventType } });
      await vi.advanceTimersByTimeAsync(MINUTE - 1);
      expect(harness.session.abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.session.abort).toHaveBeenCalledTimes(1);

      harness.emit({ type: "message_end", message: { role: "assistant" } });
      harness.settle();
      await prompting;
      watchdog.cleanup();
    },
  );

  it("disarms after assistant message_end while tools run and re-arms on the next turn", async () => {
    const harness = createSession();
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      isHardTurnLimitAborted: () => false,
    });
    const prompting = watchdog.prompt("start");

    harness.emit({ type: "message_end", message: { role: "assistant" } });
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(harness.session.abort).not.toHaveBeenCalled();
    harness.emit({ type: "turn_start" });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(harness.session.abort).toHaveBeenCalledTimes(1);

    harness.emit({ type: "message_end", message: { role: "assistant" } });
    harness.settle();
    await prompting;
    watchdog.cleanup();
  });

  it("fails recovery when its prompt resolves without an assistant completion", async () => {
    const harness = createSession();
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      isHardTurnLimitAborted: () => false,
    });

    const prompting = watchdog.prompt("start");
    await vi.advanceTimersByTimeAsync(MINUTE);
    // abort() settles the first prompt; resolve the continuation as if an input
    // hook handled it before any provider turn began.
    harness.settle();
    await prompting;

    expect(watchdog.getFailure()).toBe(MODEL_PROGRESS_RECOVERY_FAILURE);
    expect(watchdog.getMetadata(true)?.recovered).toBe(false);
    watchdog.cleanup();
  });

  it("leaves a resolved provider error for the runner to report after recovery", async () => {
    const harness = createSession();
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      isHardTurnLimitAborted: () => false,
    });

    const prompting = watchdog.prompt("start");
    await vi.advanceTimersByTimeAsync(MINUTE);
    harness.emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "provider overloaded" },
    });
    harness.settle();
    await prompting;

    expect(watchdog.getFailure()).toBeUndefined();
    expect(watchdog.getMetadata(false)?.recovered).toBe(false);
    watchdog.cleanup();
  });

  it("fails an unexplained aborted recovery instead of marking it recovered", async () => {
    const harness = createSession();
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      isHardTurnLimitAborted: () => false,
    });

    const prompting = watchdog.prompt("start");
    await vi.advanceTimersByTimeAsync(MINUTE);
    harness.emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
    harness.settle();
    await prompting;

    expect(watchdog.getFailure()).toBe(MODEL_PROGRESS_RECOVERY_FAILURE);
    expect(watchdog.getMetadata(true)?.recovered).toBe(false);
    watchdog.cleanup();
  });

  it("returns a stable terminal failure after the second timeout", async () => {
    const harness = createSession();
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      isHardTurnLimitAborted: () => false,
    });
    const prompting = watchdog.prompt("start");

    await vi.advanceTimersByTimeAsync(MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await prompting;

    expect(harness.session.abort).toHaveBeenCalledTimes(2);
    expect(harness.session.prompt).toHaveBeenCalledTimes(2);
    expect(watchdog.getFailure()).toBe(MODEL_PROGRESS_TIMEOUT_FAILURE);
    expect(watchdog.getMetadata(false)).toEqual({
      timeoutMinutes: 1,
      timeoutCount: 2,
      recoveryAttempted: true,
      recovered: false,
    });
    watchdog.cleanup();
  });

  it("suppresses recovery when external cancellation wins after timeout", async () => {
    const harness = createSession();
    const controller = new AbortController();
    harness.session.abort.mockImplementation(() => {
      controller.abort();
      harness.settle();
      return Promise.resolve();
    });
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      signal: controller.signal,
      isHardTurnLimitAborted: () => false,
    });

    const prompting = watchdog.prompt("start");
    await vi.advanceTimersByTimeAsync(MINUTE);
    await prompting;

    expect(harness.session.prompt).toHaveBeenCalledTimes(1);
    expect(watchdog.getMetadata(false)?.recoveryAttempted).toBe(false);
    watchdog.cleanup();
  });

  it("suppresses recovery when a hard turn-limit abort wins", async () => {
    const harness = createSession();
    let hardAborted = false;
    harness.session.abort.mockImplementation(() => {
      hardAborted = true;
      harness.settle();
      return Promise.resolve();
    });
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      isHardTurnLimitAborted: () => hardAborted,
    });

    const prompting = watchdog.prompt("start");
    await vi.advanceTimersByTimeAsync(MINUTE);
    await prompting;

    expect(harness.session.prompt).toHaveBeenCalledTimes(1);
    watchdog.cleanup();
  });

  it("cleanup removes listeners and timers after success and thrown errors", async () => {
    const harness = createSession();
    const watchdog = createModelProgressWatchdog({
      session: harness.session as never,
      timeoutMinutes: 1,
      isHardTurnLimitAborted: () => false,
    });
    const prompting = watchdog.prompt("start");
    harness.settle();
    await prompting;
    watchdog.cleanup();
    expect(harness.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const failing = createSession();
    failing.session.prompt.mockImplementation(async () => {
      failing.emit({ type: "turn_start" });
      throw new Error("provider failed");
    });
    const failingWatchdog = createModelProgressWatchdog({
      session: failing.session as never,
      timeoutMinutes: 1,
      isHardTurnLimitAborted: () => false,
    });
    await expect(failingWatchdog.prompt("start")).rejects.toThrow("provider failed");
    failingWatchdog.cleanup();
    expect(failing.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
