import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionCommandContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import modelsExtension from "../src/index.ts";
import { chooseModel } from "../src/selector.ts";
import { loadHistory, mutateHistory } from "../src/store.ts";

const marker = Symbol.for("pi-extensions:input-dialog");
const model = { provider: "p", id: "m" };

test("/models native selection, favorites, and visibility actions remain manual", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-manual-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const selected: unknown[] = [];
  modelsExtension({
    on() {},
    registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    },
    async setModel(value: unknown) {
      selected.push(value);
      return true;
    },
  } as never);
  await mutateHistory((history) => {
    history.models["p/m"] = { thinkingLevel: "high" };
  });
  const choices = [
    "[p] m",
    "Toggle favorite",
    "[p] m",
    "Hide model",
    "Show all models",
    "[p] m [hidden]",
    "Select",
    "Show all models",
    "[p] m [hidden]",
    "Unhide model",
    "[p] m",
    "Select",
  ];
  const titles: string[] = [];
  const context = {
    mode: "rpc",
    modelRegistry: { getAvailable: () => [model] },
    ui: {
      async select(title: string, _labels: string[], options?: ExtensionUIDialogOptions) {
        titles.push(title);
        assert.equal(Reflect.get(options ?? {}, marker), false);
        assert.equal(Reflect.get({ ...options }, marker), false);
        const choice = choices.shift();
        assert.ok(choice && _labels.includes(choice));
        return choice;
      },
    },
  } as never;
  await handler("", context);
  assert.equal((await loadHistory()).models["p/m"]?.favorite, true);
  assert.deepEqual(selected, []);
  await handler("", context);
  assert.equal((await loadHistory()).models["p/m"]?.hidden, true);
  assert.deepEqual(selected, []);
  await handler("", context);
  assert.deepEqual(selected, [model]);
  assert.equal((await loadHistory()).models["p/m"]?.hidden, true);
  await handler("", context);
  assert.deepEqual((await loadHistory()).models["p/m"], {
    favorite: true,
    hidden: false,
    thinkingLevel: "high",
  });
  await handler("", context);
  assert.deepEqual(selected, [model, model]);
  assert.deepEqual(titles, [
    "Select model",
    "Model action",
    "Select model",
    "Model action",
    "Select model",
    "Select model",
    "Model action",
    "Select model",
    "Select model",
    "Model action",
    "Select model",
    "Model action",
  ]);
});

test("closing the rich picker saves visibility and favorites without switching models", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-visibility-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await mutateHistory((history) => {
    history.models["p/m"] = { thinkingLevel: "high" };
  });
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  modelsExtension({
    on() {},
    registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    },
    async setModel() {
      assert.fail("Closing without a selection must not switch models");
    },
  } as never);
  await handler("", {
    mode: "tui",
    modelRegistry: { getAvailable: () => [model] },
    ui: {
      async custom() {
        return { favorites: { "p/m": true }, hidden: { "p/m": true } };
      },
    },
  } as never);
  assert.deepEqual((await loadHistory()).models["p/m"], {
    favorite: true,
    hidden: true,
    thinkingLevel: "high",
  });
});

test("the rich model selector remains unmarked", async () => {
  const result = { model };
  const context = {
    mode: "tui",
    ui: {
      async custom(factory: object) {
        assert.equal(Reflect.get(factory, marker), undefined);
        return result;
      },
    },
  } as never;
  assert.equal(await chooseModel(context, { models: [model], states: {} }), result);
});

test("stale llama.cpp models are omitted from both views without refreshing or changing preferences", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-expired-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const llama = { provider: "llama.cpp", id: "local" };
  const available = [model, llama];
  const checkedAt = Date.now() - 25 * 60 * 60 * 1000;
  await writeFile(
    join(dir, "models-store.json"),
    JSON.stringify({
      "llama.cpp": { models: [llama], checkedAt },
      p: { models: [model], checkedAt },
    }),
  );
  await mutateHistory((history) => {
    history.models["llama.cpp/local"] = { favorite: true, thinkingLevel: "high" };
  });
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  modelsExtension({
    on() {},
    registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    },
    async setModel() {
      assert.fail("Cancelling must not switch models");
    },
  } as never);
  const choices = ["Show all models", "[p] m", "Cancel"];
  await handler("", {
    mode: "rpc",
    modelRegistry: {
      getAvailable: () => available,
      async refresh() {
        assert.fail("Cache expiration must not trigger a refresh");
      },
    },
    ui: {
      async select(title: string, labels: string[]) {
        if (title === "Select model") {
          assert.ok(labels.includes("[p] m"));
          assert.ok(labels.every((label) => !label.startsWith("[llama.cpp]")));
        }
        const choice = choices.shift();
        assert.ok(choice && labels.includes(choice));
        return choice;
      },
    },
  } as never);
  assert.equal(choices.length, 0);
  assert.deepEqual(available, [model, llama]);
  assert.deepEqual((await loadHistory()).models["llama.cpp/local"], {
    favorite: true,
    thinkingLevel: "high",
  });
});
