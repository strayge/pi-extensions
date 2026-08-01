/**
 * Per-session state the statusline tracks itself because pi does not expose it:
 * turn count, in-flight tools, streaming state, and the git working tree.
 */

import type { GitStatus } from "./git-status.ts";

export interface RuntimeState {
  turnCount: number;
  /** Tool name -> number of concurrent calls in flight. */
  activeTools: Map<string, number>;
  isStreaming: boolean;
  gitStatus?: GitStatus;
  sessionStartedAt: number;
}

export function createRuntime(): RuntimeState {
  return {
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    sessionStartedAt: Date.now(),
  };
}

export function resetRuntime(runtime: RuntimeState): void {
  runtime.turnCount = 0;
  runtime.activeTools.clear();
  runtime.isStreaming = false;
  runtime.gitStatus = undefined;
  runtime.sessionStartedAt = Date.now();
}

export function toolStarted(runtime: RuntimeState, name: string): void {
  runtime.activeTools.set(name, (runtime.activeTools.get(name) ?? 0) + 1);
}

export function toolEnded(runtime: RuntimeState, name: string): void {
  const count = (runtime.activeTools.get(name) ?? 0) - 1;
  if (count > 0) runtime.activeTools.set(name, count);
  else runtime.activeTools.delete(name);
}
