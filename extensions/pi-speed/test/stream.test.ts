import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import speedExtension from "../src/index.ts";
import {
  parseStreamMeasurement,
  readStreamMeasurements,
  record,
  STREAM_ENTRY_TYPE,
} from "../src/measurement.ts";
import { registerStreamCollector, StreamObserver } from "../src/stream.ts";
import { createMockContext, createMockPi } from "./support.ts";

type Frame = { at: number; data: Record<string, unknown> };

function frame(frames: Frame[], index: number): Frame {
  const result = frames.at(index);
  assert.ok(result);
  return result;
}

function object(value: unknown): Record<string, unknown> {
  const result = record(value);
  assert.ok(result);
  return result;
}

function delta(frames: Frame[], index: number): Record<string, unknown> {
  const choices = frame(frames, index).data.choices;
  assert.ok(Array.isArray(choices));
  return object(object(choices[0]).delta);
}
const BASE_TIME = 1_780_000_000_000;
const usage = {
  input: 10,
  output: 600,
  reasoning: 350,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 610,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(api: string, overrides: object = {}) {
  return {
    role: "assistant",
    provider: api === "openai-codex-responses" ? "openai-codex" : "opencode-go",
    api,
    model: "model",
    responseId: "r1",
    timestamp: BASE_TIME,
    stopReason: "toolUse",
    content: [],
    usage,
    ...overrides,
  };
}

function responses(kind = "text"): Frame[] {
  const item =
    kind === "text"
      ? { type: "message", content: [] }
      : kind === "tool"
        ? { type: "function_call", arguments: "" }
        : { type: "custom_tool_call", input: "" };
  const finalItem =
    kind === "text"
      ? { type: "message", content: [{ type: "output_text", text: "helloworld" }] }
      : kind === "tool"
        ? { type: "function_call", arguments: "helloworld" }
        : { type: "custom_tool_call", input: "helloworld" };
  const delta =
    kind === "text"
      ? "response.output_text.delta"
      : kind === "tool"
        ? "response.function_call_arguments.delta"
        : "response.custom_tool_call_input.delta";
  return [
    { at: 0, data: { type: "response.created", response: { id: "r1" } } },
    { at: 100, data: { type: "response.reasoning_summary_text.delta", delta: "thinking" } },
    { at: 200, data: { type: "response.output_item.added", output_index: 0, item } },
    { at: 700, data: { type: delta, output_index: 0, delta: "hello" } },
    { at: 1_700, data: { type: delta, output_index: 0, delta: "world" } },
    { at: 8_000, data: { type: "response.output_item.done", output_index: 0, item: finalItem } },
    {
      at: 9_000,
      data: {
        type: "response.completed",
        response: {
          id: "r1",
          output: [finalItem],
          usage: { output_tokens: 600, output_tokens_details: { reasoning_tokens: 350 } },
        },
      },
    },
  ];
}

function completionFrames(custom = false): Frame[] {
  return [
    { at: 0, data: { id: "r1", choices: [{ delta: { reasoning_content: "thinking" } }] } },
    { at: 700, data: { id: "r1", choices: [{ delta: { content: "hello" } }] } },
    {
      at: 1_700,
      data: {
        id: "r1",
        choices: [
          {
            delta: {
              tool_calls: [
                custom ? { custom: { input: "world" } } : { function: { arguments: "world" } },
              ],
            },
          },
        ],
      },
    },
    {
      at: 9_000,
      data: {
        id: "r1",
        choices: [],
        usage: {
          completion_tokens: 600,
          completion_tokens_details: { reasoning_tokens: 350 },
        },
      },
    },
  ];
}

function anthropicFrames(): Frame[] {
  return [
    { at: 0, data: { type: "message_start", message: { id: "r1" } } },
    {
      at: 100,
      data: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    },
    {
      at: 200,
      data: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", input: {} },
      },
    },
    {
      at: 700,
      data: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "hello" },
      },
    },
    {
      at: 1_700,
      data: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "world" },
      },
    },
    { at: 8_000, data: { type: "content_block_stop", index: 1 } },
    {
      at: 9_000,
      data: {
        type: "message_delta",
        usage: { output_tokens: 600, output_tokens_details: { thinking_tokens: 350 } },
      },
    },
  ];
}

function googleFrames(): Frame[] {
  return [
    {
      at: 0,
      data: {
        responseId: "r1",
        candidates: [{ content: { parts: [{ thought: true, text: "thinking" }] } }],
      },
    },
    {
      at: 700,
      data: {
        responseId: "r1",
        candidates: [
          { content: { parts: [{ text: "hello", thoughtSignature: "not-reasoning" }] } },
        ],
      },
    },
    {
      at: 1_700,
      data: {
        responseId: "r1",
        candidates: [{ content: { parts: [{ functionCall: { name: "tool", args: { x: 1 } } }] } }],
      },
    },
    {
      at: 9_000,
      data: {
        responseId: "r1",
        usageMetadata: { candidatesTokenCount: 250, thoughtsTokenCount: 350 },
      },
    },
  ];
}

function collect(api: string, frames: Frame[], overrides: object = {}) {
  const observer = new StreamObserver();
  const final = message(api, overrides);
  for (const frame of frames) observer.observe({ ...final, data: frame.data }, frame.at);
  return observer.finish(final);
}

for (const [name, api, frames] of [
  ["Codex text", "openai-codex-responses", responses()],
  ["Responses function", "openai-responses", responses("tool")],
  ["Responses custom tool", "openai-responses", responses("custom")],
  ["Completions mixed text/tools", "openai-completions", completionFrames()],
  ["Completions custom tool", "openai-completions", completionFrames(true)],
  ["Anthropic tool", "anthropic-messages", anthropicFrames()],
  ["Gemini mixed text/tool", "google-generative-ai", googleFrames()],
] as const) {
  test(`${name} measures first/last payloads, not startup, reasoning, or terminal events`, () => {
    const sample = collect(api, frames);
    assert.equal(sample?.outputTokens, 250);
    assert.equal(sample?.totalOutputTokens, 600);
    assert.equal(sample?.durationMs, 1_000);
    assert.equal(sample?.chunks, 2);
  });
}

test("Codex response.done and Completions choice-level usage retain provider accounting", () => {
  const codex = responses();
  frame(codex, -1).data.type = "response.done";
  assert.ok(collect("openai-codex-responses", codex));
  const frames = completionFrames();
  const final = frame(frames, -1).data;
  final.choices = [{ usage: final.usage }];
  delete final.usage;
  assert.ok(collect("openai-completions", frames));
});

test("missing reasoning counts are unknown, while explicit zero is valid", () => {
  for (const [api, make] of [
    ["openai-responses", responses],
    ["openai-completions", completionFrames],
    ["anthropic-messages", anthropicFrames],
  ] as const) {
    const frames = make();
    const final = frame(frames, -1).data;
    const raw = object(record(final.response)?.usage ?? final.usage);
    const field =
      api === "openai-completions" ? "completion_tokens_details" : "output_tokens_details";
    delete raw[field];
    assert.equal(collect(api, frames), undefined);
    raw[field] = api === "anthropic-messages" ? { thinking_tokens: 0 } : { reasoning_tokens: 0 };
    assert.equal(collect(api, frames)?.outputTokens, 600);
  }
});

test("refusal deltas are output arrivals and undelivered prediction tokens are not output", () => {
  const refusals = completionFrames();
  frame(refusals, 1).data.choices = [{ delta: { refusal: "cannot " } }];
  frame(refusals, 2).data.choices = [{ delta: { refusal: "help" } }];
  assert.equal(collect("openai-completions", refusals)?.outputTokens, 250);
  for (const key of ["rejected_prediction_tokens", "audio_tokens"]) {
    const frames = completionFrames();
    const details = object(object(frame(frames, -1).data.usage).completion_tokens_details);
    details[key] = 100;
    assert.equal(collect("openai-completions", frames), undefined);
    details[key] = 0;
    assert.ok(collect("openai-completions", frames));
  }
});

test("usage must cover the last payload, not just an earlier partial count", () => {
  const frames = completionFrames();
  const accounting = frame(frames, -1).data.usage;
  delete frame(frames, -1).data.usage;
  frame(frames, 1).data.usage = accounting;
  assert.equal(collect("openai-completions", frames), undefined);
  frame(frames, 2).data.usage = accounting;
  assert.ok(collect("openai-completions", frames));
});

test("Gemini candidate counts do not require a separate thoughts count", () => {
  const frames = googleFrames();
  frame(frames, -1).data.usageMetadata = { candidatesTokenCount: 600 };
  assert.equal(collect("google-generative-ai", frames)?.outputTokens, 600);
});

test("filters reject undersized output, short/buffered streams, and invalid accounting", () => {
  for (const reasoning of [351, 601, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const frames = completionFrames();
    object(object(frame(frames, -1).data.usage).completion_tokens_details).reasoning_tokens =
      reasoning;
    assert.equal(collect("openai-completions", frames), undefined);
  }
  for (const last of [700, 710, 1_699]) {
    const frames = completionFrames();
    frame(frames, 2).at = last;
    assert.equal(collect("openai-completions", frames), undefined);
  }
  for (const stopReason of ["length", "aborted", "error", "deferred", undefined]) {
    assert.equal(collect("openai-completions", completionFrames(), { stopReason }), undefined);
  }
  assert.equal(
    collect("openai-completions", completionFrames(), { usage: { ...usage, output: 601 } }),
    undefined,
  );
  const single = googleFrames().filter((_, index) => index !== 1);
  assert.equal(collect("google-generative-ai", single), undefined);
});

test("interleaved or simultaneous reasoning/output is excluded, but trailing reasoning adds no time", () => {
  const frames = completionFrames();
  frames.splice(2, 0, {
    at: 1_000,
    data: {
      id: "r1",
      choices: [
        { delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }] } },
      ],
    },
  });
  assert.equal(collect("openai-completions", frames), undefined);
  const trailing = completionFrames();
  trailing.splice(3, 0, frame(frames, 2));
  frame(trailing, 3).at = 2_000;
  assert.ok(collect("openai-completions", trailing));
  const mixed = completionFrames();
  delta(mixed, 1).reasoning_content = "also thinking";
  assert.equal(collect("openai-completions", mixed), undefined);
});

test("response completion backfills and unsupported generated modalities never acquire invented timing", () => {
  const frames = responses("tool");
  frames.splice(4, 1);
  assert.equal(collect("openai-responses", frames), undefined);
  const audio = completionFrames();
  delta(audio, 1).audio = { data: "audio" };
  assert.equal(collect("openai-completions", audio), undefined);
  const unknown = responses();
  object(frame(unknown, 2).data.item).type = "image_generation_call";
  assert.equal(collect("openai-responses", unknown), undefined);
});

test("multiple payloads in one raw frame count as one arrival", () => {
  const frames = completionFrames();
  delta(frames, 1).tool_calls = [{ function: { arguments: "more" } }];
  assert.equal(collect("openai-completions", frames)?.chunks, 2);
});

test("changed response IDs, repeated starts, routes, and backwards clocks invalidate a request", () => {
  const frames = completionFrames();
  frame(frames, 2).data.id = "r2";
  assert.equal(collect("openai-completions", frames), undefined);
  const retry = responses();
  retry.splice(4, 0, { at: 1_000, data: { type: "response.created", response: { id: "r1" } } });
  assert.equal(collect("openai-codex-responses", retry), undefined);
  const backwards = completionFrames();
  frame(backwards, 2).at = 699;
  assert.equal(collect("openai-completions", backwards), undefined);
  const observer = new StreamObserver();
  const final = message("openai-completions");
  for (const [index, frame] of completionFrames().entries()) {
    observer.observe(
      { ...final, provider: index === 2 ? "other" : final.provider, data: frame.data },
      frame.at,
    );
  }
  assert.equal(observer.finish(final), undefined);
});

function runtime(wholeExtension = false) {
  const mock = createMockPi();
  const manager = SessionManager.inMemory("/speed-fixture");
  let now = 0;
  const { ctx, statuses } = createMockContext({
    sessionManager: manager,
    hasUI: wholeExtension,
    model: { provider: "opencode-go", id: "model" },
  });
  const pi = mock.pi as ExtensionAPI;
  const original = pi.appendEntry;
  pi.appendEntry = (customType: string, data: unknown) => {
    original(customType, data);
    manager.appendCustomEntry(customType, data);
  };
  if (wholeExtension) speedExtension(mock.pi);
  else registerStreamCollector(mock.pi, () => now);
  const fire = (name: string, event: object = {}) => {
    for (const handler of mock.events.get(name) ?? []) handler(event, ctx);
  };
  const stream = () => {
    for (const frame of completionFrames()) {
      now = frame.at;
      fire("provider_stream_event", { ...message("openai-completions"), data: frame.data });
    }
  };
  return {
    ...mock,
    fire,
    stream,
    manager,
    statuses,
    get now() {
      return now;
    },
  };
}

test("collector writes once at turn_end, never at message_end, including non-interactive sessions", () => {
  const state = runtime();
  state.fire("session_start");
  state.fire("turn_start", { turnIndex: 0 });
  state.stream();
  const final = message("openai-completions");
  state.fire("message_end", { message: final });
  assert.equal(state.entries.length, 0);
  const id = state.manager.appendMessage(final as never);
  state.fire("turn_end", { turnIndex: 0, messageEntryId: id });
  state.fire("turn_end", { turnIndex: 0, messageEntryId: id });
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0]?.customType, STREAM_ENTRY_TYPE);
  const measurement = parseStreamMeasurement(state.entries[0]?.data);
  assert.equal(measurement?.entryId, id);
  assert.equal(measurement?.durationMs, 1_000);
  assert.equal(JSON.stringify(measurement).includes("hello"), false);
  assert.deepEqual(state.sentMessages, []);
  assert.deepEqual(state.sentUserMessages, []);
});

test("shutdown/reload and mismatched persisted messages discard pending measurements", () => {
  for (const action of ["shutdown", "reload", "mutation", "missing-entry", "wrong-turn"]) {
    const state = runtime();
    state.fire("session_start");
    state.fire("turn_start", { turnIndex: 0 });
    state.stream();
    const final = message("openai-completions");
    state.fire("message_end", { message: final });
    if (action === "shutdown") state.fire("session_shutdown");
    if (action === "reload") state.fire("session_start");
    const id = state.manager.appendMessage(
      action === "mutation" ? ({ ...final, model: "other" } as never) : (final as never),
    );
    state.fire("turn_end", {
      turnIndex: action === "wrong-turn" ? 1 : 0,
      messageEntryId: action === "missing-entry" ? "absent" : id,
    });
    assert.deepEqual(state.entries, [], action);
  }
});

test("failed attempts and following successful turns cannot share a stream window", () => {
  const state = runtime();
  state.fire("session_start");
  state.fire("turn_start", { turnIndex: 0 });
  state.stream();
  const failed = message("openai-completions", { stopReason: "aborted" });
  state.fire("message_end", { message: failed });
  state.fire("turn_end", {
    turnIndex: 0,
    messageEntryId: state.manager.appendMessage(failed as never),
  });
  state.fire("turn_start", { turnIndex: 0 });
  const final = message("openai-completions");
  state.fire("message_end", { message: final });
  state.fire("turn_end", {
    turnIndex: 0,
    messageEntryId: state.manager.appendMessage(final as never),
  });
  assert.deepEqual(state.entries, []);
});

test("whole extension publishes the just-persisted measurement and restores it on reload", (t) => {
  let state: ReturnType<typeof runtime>;
  t.mock.method(performance, "now", () => state.now);
  state = runtime(true);
  state.fire("session_start");
  state.fire("turn_start", { turnIndex: 0 });
  state.stream();
  const final = message("openai-completions");
  state.fire("message_end", { message: final });
  const id = state.manager.appendMessage(final as never);
  state.fire("turn_end", { turnIndex: 0, messageEntryId: id });
  assert.equal(state.statuses.get("speed"), "250.0 tok/s");
  assert.equal(readStreamMeasurements(state.manager.getEntries()).size, 1);
  state.fire("session_shutdown");
  assert.equal(state.statuses.get("speed"), undefined);
  state.fire("session_start", { reason: "reload" });
  assert.equal(state.statuses.get("speed"), "250.0 tok/s");
});
