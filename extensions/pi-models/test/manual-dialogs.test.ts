import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionCommandContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import modelsExtension from "../src/index.ts";
import { chooseModel } from "../src/selector.ts";
import { loadHistory } from "../src/store.ts";

const marker = Symbol.for("pi-extensions:input-dialog");
const model = { provider: "p", id: "m" };

test("/models native selection and favorite actions are manual without changing their results", async (t) => {
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
  const choices = ["[p] m", "Toggle favorite", "[p] m", "Select"];
  const titles: string[] = [];
  const context = {
    mode: "rpc",
    modelRegistry: { getAvailable: () => [model] },
    ui: {
      async select(title: string, _labels: string[], options?: ExtensionUIDialogOptions) {
        titles.push(title);
        assert.equal(Reflect.get(options ?? {}, marker), false);
        assert.equal(Reflect.get({ ...options }, marker), false);
        return choices.shift();
      },
    },
  } as never;
  await handler("", context);
  assert.equal((await loadHistory()).models["p/m"]?.favorite, true);
  assert.deepEqual(selected, []);
  await handler("", context);
  assert.deepEqual(selected, [model]);
  assert.deepEqual(titles, ["Select model", "Model action", "Select model", "Model action"]);
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
