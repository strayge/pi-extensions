import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { STREAM_ENTRY_TYPE } from "../src/measurement.ts";
import { registerSpeedStatus } from "../src/speed-status.ts";
import { createMockContext, createMockPi } from "./support.ts";

type Assistant = Extract<SessionMessageEntry["message"], { role: "assistant" }>;
const START = Date.parse("2026-09-12T12:00:00Z");
const MODEL = { provider: "provider", id: "model" };
const USAGE = {
  input: 1_000,
  output: 1_000,
  reasoning: 500,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let nextId = 0;

function assistant(overrides: Partial<Assistant> = {}): SessionMessageEntry {
  return {
    id: `assistant-${nextId++}`,
    parentId: null,
    type: "message",
    timestamp: new Date(START + 60_000).toISOString(),
    message: {
      role: "assistant",
      provider: MODEL.provider,
      model: MODEL.id,
      api: "openai-responses",
      content: [],
      timestamp: START,
      stopReason: "stop",
      usage: USAGE,
      ...overrides,
    },
  };
}

function annotation(
  entry: SessionMessageEntry,
  durationMs = 1_000,
  overrides: object = {},
): SessionEntry {
  const message = entry.message as Assistant;
  return {
    type: "custom",
    id: `timing-${entry.id}`,
    parentId: entry.id,
    timestamp: new Date(START + 120_000).toISOString(),
    customType: STREAM_ENTRY_TYPE,
    data: {
      version: 1,
      entryId: entry.id,
      provider: message.provider,
      model: message.model,
      api: message.api,
      messageTimestamp: message.timestamp,
      outputTokens: 500,
      totalOutputTokens: 1_000,
      durationMs,
      chunks: 3,
      ...overrides,
    },
  };
}

function setup(entries: SessionEntry[] = [], allEntries = entries) {
  const mock = createMockPi();
  registerSpeedStatus(mock.pi);
  let branch = entries;
  let all = allEntries;
  const context = createMockContext({
    hasUI: true,
    model: MODEL,
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => branch,
      getEntries: () => all,
    },
    modelRegistry: new Proxy({}, { get: () => assert.fail("speed must not resolve auth") }),
  });
  return {
    ...context,
    ...mock,
    setBranch: (next: SessionEntry[], stored = next) => {
      branch = next;
      all = stored;
    },
    fire: (name: string, event: object = {}) => {
      for (const handler of mock.events.get(name) ?? []) handler(event, context.ctx);
    },
  };
}

test("session status pools efforts for the exact model and takes median non-reasoning stream rates", () => {
  const entries = [1, 3, 5, 7].flatMap((seconds, index) => {
    const entry = assistant({ thinkingLevel: index % 2 ? "high" : "low" });
    return [entry, annotation(entry, seconds * 1_000)];
  });
  for (const overrides of [{ model: "other" }, { provider: "other" }]) {
    const entry = assistant(overrides);
    entries.push(entry, annotation(entry));
  }
  const state = setup(entries);
  state.fire("session_start");
  assert.equal(state.statuses.get("speed"), "133.3 tok/s");
  assert.equal(state.statuses.size, 1);
  assert.deepEqual(state.entries, []);
  assert.deepEqual(state.sentMessages, []);
  assert.deepEqual(state.sentUserMessages, []);
  assert.deepEqual(state.notifications, []);
});

test("session status uses only the newest ten measured requests", () => {
  const entries: SessionEntry[] = [];
  const add = (count: number, durationMs: number, data: object = {}) => {
    for (let i = 0; i < count; i += 1) {
      const entry = assistant();
      entries.push(entry, annotation(entry, durationMs, data));
    }
  };
  add(10, 1_000);
  add(5, 4_000);
  // Excluded calls must not take slots in the window.
  add(5, 1_000, { outputTokens: 249 });
  const state = setup(entries);
  state.fire("session_start");
  assert.equal(state.statuses.get("speed"), "312.5 tok/s");
});

test("legacy request timestamps never supply a fallback and failed or invalid measurements stay hidden", () => {
  const invalid: SessionEntry[] = [assistant()];
  for (const stopReason of ["error", "aborted", "length", undefined] as const) {
    const entry = assistant({ stopReason } as Partial<Assistant>);
    invalid.push(entry, annotation(entry));
  }
  for (const data of [
    { outputTokens: 249 },
    { durationMs: 999 },
    { durationMs: Number.NaN },
    { chunks: 1 },
    { version: 2 },
    { provider: "other" },
    { messageTimestamp: START - 1 },
    { totalOutputTokens: 999 },
  ]) {
    const entry = assistant();
    invalid.push(entry, annotation(entry, 1_000, data));
  }
  const state = setup(invalid);
  state.fire("session_start");
  assert.equal(state.statuses.get("speed"), undefined);
  const first = assistant();
  const second = assistant({ stopReason: "toolUse" });
  state.setBranch([...invalid, first, annotation(first), second, annotation(second, 2_000)]);
  state.fire("turn_end");
  assert.equal(state.statuses.get("speed"), "375.0 tok/s");
});

test("annotations below a selected ancestor remain usable without counting abandoned assistant branches", () => {
  const shared = assistant();
  const abandoned = assistant();
  const all = [shared, abandoned, annotation(shared), annotation(abandoned, 4_000)];
  const state = setup([shared], all);
  state.fire("session_start", { reason: "reload" });
  assert.equal(state.statuses.get("speed"), "500.0 tok/s");
  state.setBranch([abandoned], all);
  state.fire("session_tree");
  assert.equal(state.statuses.get("speed"), "125.0 tok/s");
  state.setBranch([], all);
  state.fire("session_tree");
  assert.equal(state.statuses.get("speed"), undefined);
});

test("tool execution and repeated refreshes neither change stream duration nor duplicate samples", () => {
  const first = assistant();
  const second = assistant({ stopReason: "toolUse" });
  const state = setup([first, annotation(first)]);
  state.fire("session_start");
  assert.equal(state.statuses.get("speed"), "500.0 tok/s");
  state.setBranch([first, annotation(first), second, annotation(second, 4_000)]);
  state.fire("tool_execution_start");
  state.fire("tool_execution_start");
  state.fire("turn_end");
  assert.equal(state.statuses.get("speed"), "312.5 tok/s");
  assert.equal(state.events.has("message_end"), false);
});

test("model changes, shutdown, and resume immediately replace or hide the status", () => {
  const first = assistant();
  const other = assistant({ model: "other" });
  const entries = [first, annotation(first), other, annotation(other, 2_000)];
  const state = setup(entries);
  state.fire("session_start", { reason: "resume" });
  assert.equal(state.statuses.get("speed"), "500.0 tok/s");
  state.fire("model_select", { model: { ...MODEL, id: "other" } });
  assert.equal(state.statuses.get("speed"), "250.0 tok/s");
  state.fire("model_select", { model: { ...MODEL, provider: "other" } });
  assert.equal(state.statuses.get("speed"), undefined);
  state.fire("session_shutdown");
  state.setBranch([]);
  state.fire("session_start", { reason: "new" });
  assert.equal(state.statuses.get("speed"), undefined);
  state.setBranch(entries);
  state.fire("session_start", { reason: "reload" });
  assert.equal(state.statuses.get("speed"), "500.0 tok/s");
});

test("speed remains an independent replayable slot and clears stale values", () => {
  const entry = assistant();
  const state = setup([entry, annotation(entry)]);
  const published: unknown[] = [];
  const cleared: unknown[] = [];
  state.pi.events.on("statusline:publish", (value) => published.push(value));
  state.pi.events.on("statusline:clear", (value) => cleared.push(value));
  state.fire("session_start");
  assert.deepEqual(published, [{ id: "speed", text: "500.0 tok/s", owner: "test-session" }]);
  state.pi.events.emit("statusline:request", { owner: "test-session" });
  state.fire("turn_end");
  assert.equal(published.length, 2);
  state.fire("session_shutdown");
  assert.deepEqual(cleared, [{ id: "speed", owner: "test-session" }]);
  state.pi.events.emit("statusline:request", { owner: "test-session" });
  assert.equal(published.length, 2);
});

test("shared-bus requests replay only the owning session's speed", () => {
  const mock = createMockPi();
  registerSpeedStatus(mock.pi);
  registerSpeedStatus(mock.pi);
  const contexts = ["parent-session", "child-session"].map((owner, index) => {
    const entry = assistant();
    const entries = [entry, annotation(entry, (index + 1) * 1_000)];
    return createMockContext({
      hasUI: true,
      model: MODEL,
      sessionManager: {
        getSessionId: () => owner,
        getBranch: () => entries,
        getEntries: () => entries,
      },
    }).ctx;
  });
  const published: unknown[] = [];
  const cleared: unknown[] = [];
  mock.pi.events.on("statusline:publish", (value) => published.push(value));
  mock.pi.events.on("statusline:clear", (value) => cleared.push(value));
  mock.pi.events.emit("statusline:request", {});
  assert.deepEqual(published, []);
  for (const [index, ctx] of contexts.entries()) {
    mock.events.get("session_start")?.[index]?.({}, ctx);
  }
  const parent = { id: "speed", text: "500.0 tok/s", owner: "parent-session" };
  const child = { id: "speed", text: "250.0 tok/s", owner: "child-session" };
  assert.deepEqual(published, [parent, child]);
  mock.pi.events.emit("statusline:request", {});
  assert.deepEqual(published, [parent, child]);
  mock.pi.events.emit("statusline:request", { owner: "parent-session" });
  assert.deepEqual(published, [parent, child, parent]);
  mock.pi.events.emit("statusline:request", { owner: "child-session" });
  assert.deepEqual(published, [parent, child, parent, child]);
  for (const [index, ctx] of contexts.entries()) {
    mock.events.get("session_shutdown")?.[index]?.({}, ctx);
  }
  assert.deepEqual(cleared, [
    { id: "speed", owner: "parent-session" },
    { id: "speed", owner: "child-session" },
  ]);
});

test("missing models and non-UI sessions do not inspect history", () => {
  const mock = createMockPi();
  registerSpeedStatus(mock.pi);
  for (const hasUI of [true, false]) {
    const { ctx, statuses } = createMockContext({
      hasUI,
      model: hasUI ? undefined : MODEL,
      sessionManager: {
        getSessionId: () => "test-session",
        getBranch: () => assert.fail("must not inspect branch"),
        getEntries: () => assert.fail("must not inspect annotations"),
      },
    });
    mock.events.get("session_start")?.[0]?.({}, ctx);
    assert.equal(statuses.get("speed"), undefined);
  }
});

test("stale contexts suppress status writes", () => {
  const mock = createMockPi();
  registerSpeedStatus(mock.pi);
  const { ctx } = createMockContext({
    hasUI: true,
    model: MODEL,
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => [],
      getEntries: () => [],
    },
    ui: {
      setStatus: () => {
        throw new Error("This extension ctx is stale after session replacement or reload");
      },
    },
  });
  assert.doesNotThrow(() => mock.events.get("session_start")?.[0]?.({}, ctx));
  const staleOwnerContext = createMockContext({ hasUI: true }).ctx;
  Object.defineProperty(staleOwnerContext, "sessionManager", {
    get: () => {
      throw new Error("This extension ctx is stale after session replacement or reload");
    },
  });
  assert.doesNotThrow(() => mock.events.get("session_shutdown")?.[0]?.({}, staleOwnerContext));
});
