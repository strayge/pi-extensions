import assert from "node:assert/strict";
import test from "node:test";
import type { BackendInfo, ModelOptions, TranscribeModel } from "transcribe-cpp";
import { TranscribeCppBackend } from "../src/transcription.ts";
import { deferred, nextTurn } from "./helpers.ts";

type RuntimeLoader = NonNullable<ConstructorParameters<typeof TranscribeCppBackend>[1]>;
type TestRuntime = Awaited<ReturnType<RuntimeLoader>>;

class TestOutOfMemory extends Error {}

const accelerator: BackendInfo = {
  name: "Vulkan0",
  description: "Test GPU",
  kind: "vulkan",
  deviceType: "gpu",
  deviceId: "0000:01:00.0",
  memoryTotal: 12_000_000_000,
  memoryFree: 1_000_000_000,
  index: 0,
};

const cpu: BackendInfo = {
  name: "CPU",
  description: "Test CPU",
  kind: "cpu",
  deviceType: "cpu",
  deviceId: null,
  memoryTotal: 16_000_000_000,
  memoryFree: 8_000_000_000,
  index: 1,
};

function fakeModel(dispose: () => void = () => {}): TranscribeModel {
  return { dispose } as unknown as TranscribeModel;
}

function runtime(options: {
  load: (path: string, modelOptions?: ModelOptions) => Promise<TranscribeModel>;
  devices?: BackendInfo[];
}): TestRuntime {
  return {
    TranscribeModel: { load: options.load },
    OutOfMemory: TestOutOfMemory,
    getAvailableBackends: () => options.devices ?? [accelerator, cpu],
    setLogHandler: () => {},
  } as unknown as TestRuntime;
}

/** Native text may only be inspected once feed has finished computing. */
function streamingBackend() {
  const gate = deferred();
  let hypothesis = "";
  let feeding = false;
  let resets = 0;
  let disposals = 0;
  const model = {
    capabilities: { supportsStreaming: true, languages: ["en"] },
    createSession() {
      return {
        async stream() {
          return {
            async feed() { feeding = true; await gate.promise; feeding = false; },
            get text() {
              assert.equal(feeding, false);
              return { full: hypothesis };
            },
            async finalize() {},
            get snapshot() { return { text: " final result ", language: "en" }; },
            reset() { resets++; },
          };
        },
        dispose() { disposals++; },
      };
    },
    dispose() {},
  } as unknown as TranscribeModel;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({ async load() { return model; } }));
  return {
    backend, gate,
    hypothesis(text: string) { hypothesis = text; },
    get resets() { return resets; },
    get disposals() { return disposals; },
  };
}

test("native feeds publish changed full hypotheses after awaiting compute, including revisions and empty text", async () => {
  const h = streamingBackend();
  const partials: string[] = [];
  const stream = (await h.backend.startStream({ onPartial: (text) => partials.push(text) }))!;
  h.hypothesis("a tentative phrase");
  const feed = stream.feed(Float32Array.of(1));
  await nextTurn();
  assert.deepEqual(partials, []);
  h.gate.resolve();
  await feed;
  await stream.feed(Float32Array.of(2));
  h.hypothesis("a revision");
  await stream.feed(Float32Array.of(3));
  h.hypothesis("");
  await stream.feed(Float32Array.of(4));
  assert.deepEqual(partials, ["a tentative phrase", "a revision", ""]);
  assert.equal(await stream.finalize(), "final result");
  assert.equal(h.resets, 1);
  assert.equal(h.disposals, 1);
  await h.backend.dispose();
});

test("a partial observer failure cannot fail inference or final disposal", async () => {
  const h = streamingBackend();
  h.gate.resolve();
  h.hypothesis("hello");
  const stream = (await h.backend.startStream({ onPartial() { throw new Error("observer failed"); } }))!;
  await stream.feed(Float32Array.of(1));
  assert.equal(await stream.finalize(), "final result");
  stream.reset();
  assert.equal(h.resets, 1);
  assert.equal(h.disposals, 1);
  await h.backend.dispose();
});

test("reset during native feed suppresses a late hypothesis", async () => {
  const h = streamingBackend();
  const partials: string[] = [];
  const stream = (await h.backend.startStream({ onPartial: (text) => partials.push(text) }))!;
  h.hypothesis("late");
  const feed = stream.feed(Float32Array.of(1));
  stream.reset();
  h.gate.resolve();
  await feed;
  assert.deepEqual(partials, []);
  assert.equal(h.disposals, 1);
  await h.backend.dispose();
});

test("an accelerator out-of-memory load retries on the exact CPU device", async () => {
  const calls: Array<{ path: string; options?: ModelOptions }> = [];
  const model = fakeModel();
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    async load(path, options) {
      calls.push({ path, options });
      if (!options) throw new TestOutOfMemory("GPU allocation failed");
      return model;
    },
  }));

  await backend.prepare();

  assert.deepEqual(calls, [
    { path: "model.gguf", options: undefined },
    { path: "model.gguf", options: { device: cpu } },
  ]);
  await backend.dispose();
});

test("a non-memory model-load failure is not retried", async () => {
  const failure = new Error("invalid model");
  let loads = 0;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    async load() {
      loads += 1;
      throw failure;
    },
  }));

  await assert.rejects(backend.prepare(), (error) => error === failure);
  assert.equal(loads, 1);
  await backend.dispose();
});

test("an out-of-memory failure is preserved when no CPU device is available", async () => {
  const failure = new TestOutOfMemory("GPU allocation failed");
  let loads = 0;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    devices: [accelerator],
    async load() {
      loads += 1;
      throw failure;
    },
  }));

  await assert.rejects(backend.prepare(), (error) => error === failure);
  assert.equal(loads, 1);
  await backend.dispose();
});

test("a CPU-only out-of-memory failure is not retried", async () => {
  const failure = new TestOutOfMemory("CPU allocation failed");
  let loads = 0;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    devices: [cpu],
    async load() {
      loads += 1;
      throw failure;
    },
  }));

  await assert.rejects(backend.prepare(), (error) => error === failure);
  assert.equal(loads, 1);
  await backend.dispose();
});
