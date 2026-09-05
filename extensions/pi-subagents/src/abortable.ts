/**
 * abortable.ts — race a promise against an AbortSignal without cancelling the
 * underlying work.
 *
 * Used by the `get_subagent_result` wait paths (top-level and nested): pressing
 * Esc cancels only the caller's wait; the background child keeps running and its
 * result stays unconsumed. The listener is removed on every settle path so the
 * signal accumulates no handlers, and a late settlement of the wrapped promise
 * after an abort is absorbed as a no-op (no unhandled rejection).
 */

import type { AgentRecord } from "./types.js";

/** Await a promise until it settles or the caller cancels, without aborting the underlying work. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Treat the record's terminal status as authoritative when a manager promise is
 * orphaned after completion bookkeeping has already finished.
 */
export async function waitForTerminalRecord(
  record: Pick<AgentRecord, "status" | "promise">,
  signal?: AbortSignal,
  pollMs = 50,
): Promise<void> {
  while (record.status === "queued" || record.status === "running") {
    const delay = new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    const completion = record.promise;
    await abortable(
      completion ? Promise.race([completion.then(() => undefined), delay]) : delay,
      signal,
    );
  }
}
