import type { Context } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  beginContextBudgetPrompt,
  buildHardNotice,
  buildSoftNotice,
  computeFinalCap,
  estimateRequestTokens,
  finishContextBudgetPrompt,
  installContextBudgetGuard,
  installProviderRetryGuard,
  shouldSuppressRetry,
  snapshotBudget,
  terminalErrorStream,
} from "../src/context-budget.js";

describe("context budget policy", () => {
  it("uses the fixed soft and hard floors for ordinary windows", () => {
    const snapshot = snapshotBudget(200_000, 140_000);

    expect(snapshot.softThreshold).toBe(60_000);
    expect(snapshot.hardThreshold).toBe(20_000);
    expect(snapshot.remaining).toBe(60_000);
    expect(snapshot.soft).toBe(true);
    expect(snapshot.hard).toBe(false);
  });

  it("gives hard finalization precedence when both thresholds are crossed", () => {
    const snapshot = snapshotBudget(100_000, 90_000);

    expect(snapshot.soft).toBe(true);
    expect(snapshot.hard).toBe(true);
    expect(snapshot.reserve).toBe(4_000);
  });

  it("subtracts notice and reserve from the final cap", () => {
    expect(computeFinalCap(12_000, 4_000, 175)).toBe(7_825);
    expect(computeFinalCap(4_000, 4_000, 175)).toBe(0);
  });

  it("suppresses only attempts that exhaust reserve headroom", () => {
    expect(shouldSuppressRetry({ contextWindow: 100_000, usedTokens: 40_000 }, 30_000)).toBe(false);
    expect(shouldSuppressRetry({ contextWindow: 100_000, usedTokens: 94_000 }, 2_000)).toBe(true);
  });

  it("estimates the complete outgoing request shape", () => {
    const small: Context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    };
    const withTool: Context = {
      ...small,
      tools: [{ name: "lookup", description: "A detailed lookup tool", parameters: { type: "object" } as any }],
    };

    expect(estimateRequestTokens(withTool)).toBeGreaterThan(estimateRequestTokens(small));
    expect(estimateRequestTokens({ messages: [{ role: "user", content: "😀".repeat(100), timestamp: 1 }] }))
      .toBeGreaterThan(estimateRequestTokens({ messages: [{ role: "user", content: "x".repeat(100), timestamp: 1 }] }));
  });

  it("renders remaining context in both notices", () => {
    const snapshot = snapshotBudget(100_000, 90_000);

    expect(buildSoftNotice(snapshot)).toContain("10,000 tokens (10.0%)");
    expect(buildHardNotice(snapshot, 5_500)).toContain("5,500 output tokens");
  });

  it("forces provider retries off at the session stream boundary", () => {
    const original = vi.fn(() => ({ marker: true }));
    const session = { agent: { streamFunction: original } } as any;
    installProviderRetryGuard(session);

    const result = session.agent.streamFunction({ id: "m" }, { messages: [] }, { maxRetries: 9, temperature: 0 });

    expect(result).toEqual({ marker: true });
    expect(original).toHaveBeenCalledWith(
      { id: "m" },
      { messages: [] },
      { maxRetries: 0, temperature: 0 },
    );
  });

  it("creates a terminal error stream without invoking a provider", async () => {
    const stream = terminalErrorStream({ api: "test", provider: "test", id: "model" } as any, "guarded");
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: "guarded" });
  });

  it("caps and terminates an actual outgoing hard request", async () => {
    const original = vi.fn(() => ({ marker: true }));
    const applyOverrides = vi.fn();
    let listener: ((event: any) => void) | undefined;
    const session = {
      agent: { streamFunction: original, shouldStopAfterTurn: undefined, beforeToolCall: undefined, signal: undefined },
      isCompacting: false,
      clearQueue: vi.fn(),
      setActiveToolsByName: vi.fn(),
      subscribe: vi.fn((next: (event: any) => void) => {
        listener = next;
        return () => {};
      }),
    } as any;
    installContextBudgetGuard(session, { applyOverrides } as any);
    beginContextBudgetPrompt(session);

    const context = contextAtTokens(90_000, true);
    const model = { api: "test", provider: "test", id: "m", contextWindow: 100_000, maxTokens: 20_000 } as any;
    session.agent.streamFunction(model, context, { maxRetries: 5 });

    const [cappedModel, guardedContext, options] = original.mock.calls[0];
    const snapshot = snapshotBudget(model.contextWindow, estimateRequestTokens(context));
    const provisionalNotice = buildHardNotice(snapshot, snapshot.remaining);
    const expectedCap = computeFinalCap(
      snapshot.remaining,
      snapshot.reserve,
      estimateTokens({
        role: "user",
        content: [{ type: "text", text: provisionalNotice }],
        timestamp: 0,
      }) + 16,
    );
    expect(cappedModel.maxTokens).toBe(expectedCap);
    expect(cappedModel.maxTokens).toBeGreaterThan(0);
    expect(cappedModel.maxTokens).toBeLessThan(10_000);
    expect(guardedContext.tools).toEqual([]);
    expect(guardedContext.messages.at(-1).content).toContain("Return the final result now");
    expect(options.maxRetries).toBe(0);
    expect(applyOverrides).toHaveBeenCalledWith({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    expect(await session.agent.shouldStopAfterTurn({}, undefined)).toBe(true);

    session.agent.streamFunction(model, context, { signal: AbortSignal.abort() });
    expect(original).toHaveBeenCalledTimes(1);
    listener?.({ type: "agent_end" });
    expect(session.clearQueue).toHaveBeenCalled();
    expect(finishContextBudgetPrompt(session)).toEqual({ terminal: true });
  });

  it("promotes a soft request to hard when the soft notice crosses the boundary", () => {
    const original = vi.fn(() => ({ marker: true }));
    const session = guardedSession(original);
    installContextBudgetGuard(session as any, { applyOverrides: vi.fn() } as any);
    beginContextBudgetPrompt(session as any);

    const context = contextAtTokens(83_999, true);
    const model = { api: "test", provider: "test", id: "m", contextWindow: 100_000, maxTokens: 20_000 } as any;

    session.agent.streamFunction(model, context, {});

    expect(snapshotBudget(100_000, estimateRequestTokens(context)).hard).toBe(false);
    expect(original.mock.calls[0][0].maxTokens).toBeLessThan(20_000);
    expect(original.mock.calls[0][1].tools).toEqual([]);
    expect(finishContextBudgetPrompt(session as any)).toEqual({ terminal: true });
  });

  it("reinjects the soft warning on every subsequent request", () => {
    const original = vi.fn(() => ({ marker: true }));
    const session = guardedSession(original);
    installContextBudgetGuard(session as any, { applyOverrides: vi.fn() } as any);
    beginContextBudgetPrompt(session as any);
    const model = { api: "test", provider: "test", id: "m", contextWindow: 100_000, maxTokens: 20_000 } as any;
    const context = contextAtTokens(70_000);

    session.agent.streamFunction(model, context, {});
    session.agent.streamFunction(model, context, {});

    expect(original).toHaveBeenCalledTimes(2);
    for (const call of original.mock.calls) {
      expect(call[1].messages.at(-1).content).toContain("Converge now");
    }
    expect(finishContextBudgetPrompt(session as any)).toEqual({ terminal: false });
  });

  it("does not dispatch when reserve and notice leave no safe final cap", async () => {
    const original = vi.fn();
    const session = guardedSession(original);
    installContextBudgetGuard(session as any, { applyOverrides: vi.fn() } as any);
    beginContextBudgetPrompt(session as any);

    const stream = session.agent.streamFunction(
      { api: "test", provider: "test", id: "m", contextWindow: 100_000, maxTokens: 20_000 } as any,
      contextAtTokens(99_000),
      {},
    );
    for await (const _event of stream) { /* consume terminal response */ }

    expect(original).not.toHaveBeenCalled();
    expect(await stream.result()).toMatchObject({ stopReason: "error" });
  });

  it("lets cancellation win without making the session terminal", () => {
    const original = vi.fn(() => ({ marker: true }));
    const applyOverrides = vi.fn();
    const session = guardedSession(original);
    installContextBudgetGuard(session as any, { applyOverrides } as any);
    beginContextBudgetPrompt(session as any);

    session.agent.streamFunction(
      { api: "test", provider: "test", id: "m", contextWindow: 100_000, maxTokens: 20_000 } as any,
      contextAtTokens(99_000),
      { signal: AbortSignal.abort() },
    );

    expect(original).not.toHaveBeenCalled();
    expect(applyOverrides).not.toHaveBeenCalled();
    expect(finishContextBudgetPrompt(session as any)).toEqual({ terminal: false });
  });
});

function contextAtTokens(target: number, withTool = false): Context {
  const tools = withTool
    ? [{ name: "lookup", description: "lookup", parameters: { type: "object" } as any }]
    : undefined;
  let chars = target * 4;
  let context: Context = { messages: [{ role: "user", content: "x".repeat(chars), timestamp: 1 }], tools };
  for (let attempt = 0; attempt < 4; attempt++) {
    const difference = target - estimateRequestTokens(context);
    if (Math.abs(difference) <= 1) break;
    chars = Math.max(0, chars + difference * 4);
    context = { messages: [{ role: "user", content: "x".repeat(chars), timestamp: 1 }], tools };
  }
  return context;
}

function guardedSession(streamFunction: (...args: any[]) => any) {
  return {
    agent: { streamFunction, shouldStopAfterTurn: undefined, beforeToolCall: undefined, signal: undefined },
    isCompacting: false,
    clearQueue: vi.fn(),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
}
