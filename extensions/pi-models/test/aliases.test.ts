import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadAliases, parseAliases } from "../src/aliases.ts";
import modelsExtension from "../src/index.ts";
import { loadHistory, mutateHistory, type ThinkingLevel } from "../src/store.ts";

test("aliases require command names, exact model identifiers, and supported thinking levels", () => {
  const result = parseAliases({
    aliases: {
      fast: { model: "provider/model" },
      deep: { model: "provider/nested/model", thinkingLevel: "max" },
      quiet: { model: "provider/model", thinkingLevel: "off" },
      "/bad": { model: "provider/model" },
      models: { model: "provider/model" },
      model: { model: "provider/model" },
      reload: { model: "provider/model" },
      missing: { model: "model" },
      empty: { model: "provider/" },
      whitespace: { model: "provider/model name" },
      array: [],
      invalid: { model: "provider/model", thinkingLevel: "extreme" },
    },
  });
  assert.deepEqual(result.aliases, [
    { name: "fast", provider: "provider", modelId: "model", thinkingLevel: undefined },
    { name: "deep", provider: "provider", modelId: "nested/model", thinkingLevel: "max" },
    { name: "quiet", provider: "provider", modelId: "model", thinkingLevel: "off" },
  ]);
  assert.equal(result.errors.length, 9);
  for (const value of [null, [], {}, { aliases: [] }]) {
    assert.equal(parseAliases(value).aliases.length, 0);
    assert.equal(parseAliases(value).errors.length, 1);
  }
});

test("missing config is optional, while unreadable or malformed config reports errors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-aliases-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "pi-models.json");
  assert.deepEqual(loadAliases(file), { aliases: [], errors: [] });
  await writeFile(file, "{");
  assert.equal(loadAliases(file).errors.length, 1);
  assert.equal(loadAliases(dir).errors.length, 1);
  await writeFile(file, JSON.stringify({ aliases: { fast: { model: "p/m" } } }));
  assert.equal(loadAliases(file).aliases[0]?.name, "fast");
});

test("alias commands preserve remembered thinking unless explicitly overridden", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-alias-commands-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    join(dir, "pi-models.json"),
    JSON.stringify({
      aliases: {
        remembered: { model: "p/target" },
        deep: { model: "p/target", thinkingLevel: "high" },
        quiet: { model: "p/target", thinkingLevel: "off" },
        missing: { model: "p/missing", thinkingLevel: "max" },
        invalid: { model: "no-provider" },
      },
    }),
  );
  await mutateHistory((history) => {
    history.models["p/target"] = { thinkingLevel: "low", hidden: true };
  });
  const settingsPath = join(dir, "settings.json");
  const settings = '{"defaultProvider":"original","defaultModel":"original"}';
  await writeFile(settingsPath, settings);
  const target = { provider: "p", id: "target" };
  let currentModel = { provider: "p", id: "original" };
  let level: ThinkingLevel = "max";
  let authenticated = true;
  const selected: unknown[] = [];
  const messages: { text: string; type: string }[] = [];
  type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  type Hook = (event: never, ctx: ExtensionCommandContext) => Promise<void> | void;
  const commands = new Map<string, Handler>();
  const hooks = new Map<string, Hook>();
  const pending: Promise<void>[] = [];
  const context = {
    mode: "rpc",
    get model() {
      return currentModel;
    },
    get thinkingLevel() {
      return level;
    },
    modelRegistry: {
      find(provider: string, id: string) {
        return provider === target.provider && id === target.id ? target : undefined;
      },
    },
    ui: {
      notify(text: string, type: string) {
        messages.push({ text, type });
      },
    },
  } as unknown as ExtensionCommandContext;
  modelsExtension({
    on(name: string, hook: Hook) {
      hooks.set(name, hook);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command.handler);
    },
    async setModel(model: typeof target) {
      if (!authenticated) return false;
      selected.push(model);
      currentModel = model;
      await hooks.get("model_select")?.({ model } as never, context);
      return true;
    },
    getThinkingLevel: () => level,
    setThinkingLevel(next: ThinkingLevel) {
      level = next;
      pending.push(
        Promise.resolve(hooks.get("thinking_level_select")?.({ level } as never, context)),
      );
    },
  } as never);
  await hooks.get("session_start")?.({} as never, context);
  assert.deepEqual([...commands.keys()], ["remembered", "deep", "quiet", "missing", "models"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "warning");
  assert.match(messages[0]?.text ?? "", /Alias \/invalid/);
  messages.length = 0;

  await commands.get("remembered")?.("", context);
  assert.equal(level, "low");
  await commands.get("deep")?.("", context);
  assert.equal(level, "high");
  await commands.get("quiet")?.("", context);
  assert.equal(level, "off");
  await Promise.all(pending);
  const history = await loadHistory();
  assert.equal(history.models["p/target"]?.thinkingLevel, "off");
  assert.equal(history.models["p/target"]?.hidden, true);
  assert.equal(typeof history.models["p/target"]?.lastUsedAt, "number");
  assert.equal(history.models["p/original"]?.thinkingLevel, "max");
  assert.deepEqual(selected, [target, target, target]);
  assert.equal(messages.length, 0);

  await commands.get("missing")?.("", context);
  authenticated = false;
  await commands.get("deep")?.("", context);
  assert.equal(level, "off");
  assert.equal(selected.length, 3);
  assert.deepEqual(
    messages.map(({ type }) => type),
    ["error", "error"],
  );
  assert.match(messages[0]?.text ?? "", /Unknown model: p\/missing/);
  assert.match(messages[1]?.text ?? "", /authentication/);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
});
