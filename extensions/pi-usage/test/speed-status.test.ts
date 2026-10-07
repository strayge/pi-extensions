import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { registerSpeedStatus } from "../src/speed-status.ts";
import { createMockContext, createMockPi } from "./support.ts";

type Assistant = Extract<SessionMessageEntry["message"], { role: "assistant" }>;
const START = Date.parse("2026-09-12T12:00:00Z");
const MODEL = { provider: "provider", id: "model" };
const USAGE = {
  input: 1_000,
  output: 100,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(overrides: Partial<Assistant> = {}, end = START + 1_000): SessionMessageEntry {
  return {
    id: "assistant",
    parentId: null,
    type: "message",
    timestamp: new Date(end).toISOString(),
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

function setup(entries: SessionEntry[] = []) {
  const mock = createMockPi();
  registerSpeedStatus(mock.pi);
  let branch = entries;
  const context = createMockContext({
    hasUI: true,
    model: MODEL,
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => assert.fail("speed must not read abandoned branches"),
    },
    modelRegistry: new Proxy({}, { get: () => assert.fail("speed must not resolve auth") }),
  });
  return {
    ...context,
    ...mock,
    setBranch: (next: SessionEntry[]) => {
      branch = next;
    },
    fire: (name: string, event: object = {}) => {
      for (const handler of mock.events.get(name) ?? []) handler(event, context.ctx);
    },
  };
}

test("session status pools efforts for the exact current model and uses median per-request speed", () => {
  const entries = [
    ...[1, 3, 5, 7].map((seconds, index) =>
      assistant({ thinkingLevel: index % 2 ? "high" : "low" }, START + seconds * 1_000),
    ),
    assistant({ model: "other" }),
    assistant({ provider: "other" }),
    { ...assistant(), type: "usage" } as unknown as SessionEntry,
  ];
  const state = setup(entries);
  state.fire("session_start");
  assert.equal(state.statuses.get("speed"), "26.7 tok/s");
  assert.equal(state.statuses.size, 1);
  assert.deepEqual(state.entries, []);
  assert.deepEqual(state.sentMessages, []);
  assert.deepEqual(state.sentUserMessages, []);
  assert.deepEqual(state.notifications, []);
});

test("only successful assistant requests with finite positive output and elapsed time count", () => {
  const invalid: SessionEntry[] = [
    ...(["error", "aborted", "length", undefined] as const).map((stopReason) =>
      assistant({ stopReason } as Partial<Assistant>),
    ),
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((output) =>
      assistant({ usage: { ...USAGE, output } }),
    ),
    ...[-1, Number.NaN, Number.POSITIVE_INFINITY, undefined].map((timestamp) =>
      assistant({ timestamp } as Partial<Assistant>),
    ),
    assistant({}, START),
    assistant({}, START - 1),
    { ...assistant(), timestamp: "invalid" },
    assistant({ usage: undefined } as unknown as Partial<Assistant>),
    { ...assistant(), message: { role: "user", content: "hi", timestamp: START } },
  ];
  const state = setup(invalid);
  state.fire("session_start");
  assert.equal(state.statuses.get("speed"), undefined);
  state.setBranch([...invalid, assistant(), assistant({ stopReason: "toolUse" }, START + 2_000)]);
  state.fire("turn_end");
  assert.equal(state.statuses.get("speed"), "75.0 tok/s");
});

test("persisted request endpoints exclude later tool time and repeated events do not duplicate samples", () => {
  const first = assistant();
  const state = setup([first]);
  state.fire("session_start");
  assert.equal(state.statuses.get("speed"), "100.0 tok/s");
  const second = assistant({ stopReason: "toolUse" }, START + 4_000);
  state.setBranch([first, second]);
  state.fire("tool_execution_start");
  assert.equal(state.statuses.get("speed"), "62.5 tok/s");
  state.fire("tool_execution_start");
  state.fire("turn_end");
  assert.equal(state.statuses.get("speed"), "62.5 tok/s");
  assert.equal(state.events.has("message_end"), false);
});

test("tree navigation, model changes, and session replacement immediately replace or hide the value", () => {
  const first = assistant();
  const other = assistant({ model: "other" }, START + 2_000);
  const state = setup([first, other]);
  state.fire("session_start", { reason: "resume" });
  assert.equal(state.statuses.get("speed"), "100.0 tok/s");
  state.fire("model_select", { model: { ...MODEL, id: "other" } });
  assert.equal(state.statuses.get("speed"), "50.0 tok/s");
  state.fire("model_select", { model: { ...MODEL, provider: "other" } });
  assert.equal(state.statuses.get("speed"), undefined);
  state.fire("model_select", { model: MODEL });
  assert.equal(state.statuses.get("speed"), "100.0 tok/s");
  state.setBranch([other]);
  state.fire("session_tree");
  assert.equal(state.statuses.get("speed"), undefined);
  state.setBranch([first]);
  state.fire("session_tree");
  assert.equal(state.statuses.get("speed"), "100.0 tok/s");
  state.fire("session_shutdown");
  assert.equal(state.statuses.get("speed"), undefined);
  state.setBranch([]);
  state.fire("session_start", { reason: "new" });
  assert.equal(state.statuses.get("speed"), undefined);
  state.setBranch([first]);
  state.fire("session_start", { reason: "reload" });
  assert.equal(state.statuses.get("speed"), "100.0 tok/s");
});

test("speed is an independent placeable slot, replays after late loading, and clears stale values", () => {
  const state = setup([assistant()]);
  const published: unknown[] = [];
  const cleared: unknown[] = [];
  state.pi.events.on("statusline:publish", (value) => published.push(value));
  state.pi.events.on("statusline:clear", (value) => cleared.push(value));
  state.fire("session_start");
  assert.deepEqual(published, [{ id: "speed", text: "100.0 tok/s" }]);
  state.pi.events.emit("statusline:request", {});
  assert.equal(published.length, 2);
  state.fire("turn_end");
  assert.equal(published.length, 2);
  state.fire("session_shutdown");
  assert.deepEqual(cleared, [{ id: "speed" }]);
  state.pi.events.emit("statusline:request", {});
  assert.equal(published.length, 2);
});

test("missing models and non-UI sessions do not inspect history or show a value", () => {
  const mock = createMockPi();
  registerSpeedStatus(mock.pi);
  for (const hasUI of [true, false]) {
    const { ctx, statuses } = createMockContext({
      hasUI,
      model: hasUI ? undefined : MODEL,
      sessionManager: { getBranch: () => assert.fail("must not inspect branch") },
    });
    mock.events.get("session_start")?.[0]?.({}, ctx);
    assert.equal(statuses.get("speed"), undefined);
  }
});
