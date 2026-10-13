import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { prioritizeModelsCommand } from "../src/autocomplete.ts";
import { chooseModel, ModelSelector, type SelectorResult } from "../src/selector.ts";
import { modelKey, rankModels } from "../src/sort.ts";
import { hasStaleLlamaCache, loadHistory, mutateHistory, parseHistory } from "../src/store.ts";

const models = [
  { provider: "z", id: "old" },
  { provider: "a", id: "new" },
  { provider: "a", id: "never" },
];

test("prioritizes /models for partial prefixes without displacing exact /model", () => {
  const items = [{ value: "model" }, { value: "models" }, { value: "compact" }];
  assert.deepEqual(
    prioritizeModelsCommand(items, "/m").map((item) => item.value),
    ["models", "model", "compact"],
  );
  assert.deepEqual(
    prioritizeModelsCommand(items, "/mo").map((item) => item.value),
    ["models", "model", "compact"],
  );
  assert.deepEqual(
    prioritizeModelsCommand(items, "/model").map((item) => item.value),
    ["model", "models", "compact"],
  );
});

test("sorts favorites before recent and deterministic never-used models", () => {
  const result = rankModels(models, {
    "z/old": { lastUsedAt: 100 },
    "a/new": { favorite: true, lastUsedAt: 1 },
    "a/never": { favorite: true },
  });
  assert.deepEqual(result.map(modelKey), ["a/new", "a/never", "z/old"]);
});

test("search keeps favorites primary while ranking fuzzy matches", () => {
  const result = rankModels(
    [
      { provider: "openai", id: "gpt-4", name: "Fast" },
      { provider: "anthropic", id: "claude", name: "GPT compatible" },
    ],
    { "openai/gpt-4": { favorite: true } },
    "gpt",
  );
  const first = result[0];
  assert.ok(first);
  assert.equal(modelKey(first), "openai/gpt-4");
});

test("malformed records are discarded but valid records survive", () => {
  const history = parseHistory({
    version: 1,
    models: {
      good: { favorite: true, hidden: true, lastUsedAt: 4, thinkingLevel: "high" },
      visible: { hidden: false },
      bad: "no",
      nan: { hidden: "true", lastUsedAt: "4", thinkingLevel: "extreme" },
    },
  });
  assert.deepEqual(history.models, {
    good: { favorite: true, hidden: true, lastUsedAt: 4, thinkingLevel: "high" },
    visible: { hidden: false },
  });
});

test("mutation reloads and preserves unavailable entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-"));
  const file = join(dir, "model-history.json");
  await writeFile(
    file,
    JSON.stringify({ version: 1, models: { "gone/id": { favorite: true, hidden: true } } }),
  );
  await mutateHistory((history) => {
    history.models["live/id"] = { lastUsedAt: 3 };
  }, file);
  assert.deepEqual((await loadHistory(file)).models, {
    "gone/id": { favorite: true, hidden: true },
    "live/id": { lastUsedAt: 3 },
  });
  assert.match(await readFile(file, "utf8"), /"version": 1/);
});

test("concurrent mutations are serialized without losing records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-"));
  const file = join(dir, "model-history.json");
  await Promise.all([
    mutateHistory((history) => {
      history.models.first = { thinkingLevel: "low" };
    }, file),
    mutateHistory((history) => {
      history.models.second = { thinkingLevel: "high" };
    }, file),
  ]);
  assert.deepEqual((await loadHistory(file)).models, {
    first: { thinkingLevel: "low" },
    second: { thinkingLevel: "high" },
  });
});

test("selector truncates every row to narrow terminal widths", () => {
  const selector = new ModelSelector({
    models: [{ provider: "provider", id: "a-very-long-model-id", name: "A long name" }],
    states: {},
    done: () => {},
  });
  for (const line of selector.render(3)) assert.ok(visibleWidth(line) <= 3);
});

test("selector scrolls to keep the highlighted model visible", () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ provider: "p", id: `${index}` }));
  const selector = new ModelSelector({ models: many, states: {}, done: () => {} });
  for (let index = 0; index < 18; index++) selector.handleInput("\x1b[B");
  const lines = selector.render(80);
  assert.ok(lines.some((line) => line.startsWith(">  [p] 8")));
  assert.ok(lines.some((line) => line.includes("(19/20)")));
});

test("favorite toggle retains the highlighted model after resorting", () => {
  const states = {
    "p/first": { lastUsedAt: 2 },
    "p/second": { lastUsedAt: 1 },
  };
  let result: unknown;
  const selector = new ModelSelector({
    models: [
      { provider: "p", id: "first" },
      { provider: "p", id: "second" },
    ],
    states,
    done: (value) => {
      result = value;
    },
  });
  selector.handleInput("\x1b[B");
  selector.handleInput("\x06");
  assert.ok(selector.render(80).some((line) => line.startsWith("> *[p] second")));
  selector.handleInput("\r");
  assert.deepEqual(result, {
    model: { provider: "p", id: "second" },
    favorites: { "p/second": true },
    hidden: {},
  });
});

test("hidden favorites are excluded unless All is requested", () => {
  const states = { "z/old": { favorite: true, hidden: true } };
  assert.deepEqual(rankModels(models, states).map(modelKey), ["a/never", "a/new"]);
  assert.deepEqual(rankModels(models, states, "", true).map(modelKey), [
    "z/old",
    "a/never",
    "a/new",
  ]);
});

test("hiding selects the next row, falls back at the end, and saves changes on Escape", () => {
  let result: unknown;
  const selector = new ModelSelector({
    models: ["a", "b", "c"].map((id) => ({ provider: "p", id })),
    states: {},
    done: (value) => {
      result = value;
    },
  });
  selector.handleInput("\x1b[B");
  selector.handleInput("\x04");
  assert.ok(selector.render(80).some((line) => line.startsWith(">  [p] c")));
  selector.handleInput("\x04");
  assert.ok(selector.render(80).some((line) => line.startsWith(">  [p] a")));
  selector.handleInput("\x04");
  assert.ok(selector.render(80).some((line) => line.includes("Tab shows all")));
  selector.handleInput("\x04");
  selector.handleInput("\x1b");
  assert.deepEqual(result, {
    favorites: {},
    hidden: { "p/a": true, "p/b": true, "p/c": true },
  });
});

test("switching views preserves search and selecting a hidden model does not unhide it", () => {
  const hidden = { provider: "p", id: "hidden" };
  const states = { "p/hidden": { favorite: true, hidden: true } };
  let result: unknown;
  const selector = new ModelSelector({
    models: [hidden, { provider: "p", id: "visible" }],
    states,
    done: (value) => {
      result = value;
    },
  });
  selector.handleInput("h");
  assert.ok(selector.render(80).some((line) => line.includes("No matching visible models")));
  selector.handleInput("\t");
  assert.ok(selector.render(80)[0]?.includes("All"));
  assert.ok(selector.render(80).some((line) => line.startsWith("> *[p] hidden")));
  selector.handleInput("\t");
  assert.ok(selector.render(80).some((line) => line.includes("No matching visible models")));
  selector.handleInput("\t");
  selector.handleInput("\r");
  assert.deepEqual(result, { model: hidden, favorites: {}, hidden: {} });
  assert.equal(states["p/hidden"].hidden, true);
});

test("visibility toggles in All dim the row, keep the cursor clear, and preserve preferences", () => {
  const states = { "p/a": { favorite: true, lastUsedAt: 99 } };
  let result: unknown;
  const selector = new ModelSelector({
    models: ["a", "b"].map((id) => ({ provider: "p", id })),
    states,
    current: "p/a",
    theme: {
      fg: (color, text) => (color === "dim" ? `\x1b[2m${text}\x1b[22m` : text),
    },
    done: (value) => {
      result = value;
    },
  });
  selector.handleInput("\t");
  selector.handleInput("\x04");
  const hiddenRow = selector.render(80).find((line) => line.startsWith(">"));
  assert.ok(hiddenRow);
  assert.ok(hiddenRow.startsWith("> \x1b[2m*[p] a ✓\x1b[22m"));
  assert.ok(!hiddenRow.includes("[hidden]"));
  for (const width of [1, 3, 20, 80]) {
    for (const line of selector.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  selector.handleInput("\x04");
  const visibleRow = selector.render(80).find((line) => line.startsWith(">"));
  assert.ok(visibleRow);
  assert.ok(visibleRow.startsWith("> *[p] a ✓"));
  assert.ok(!visibleRow.includes("\x1b[2m"));
  selector.handleInput("\x1b");
  assert.deepEqual(result, { favorites: {}, hidden: { "p/a": false } });
  assert.deepEqual(states["p/a"], { favorite: true, lastUsedAt: 99, hidden: false });
});

test("allowance suffixes are dim, preserve selection markers, and fit narrow widths", () => {
  const selector = new ModelSelector({
    models: [{ provider: "opencode-go", id: "gpt", name: "GPT 6 Luna" }],
    states: {},
    current: "opencode-go/gpt",
    annotations: { "opencode-go/gpt": "$15/mo · ~21,150 req/mo" },
    theme: { fg: (color, text) => (color === "dim" ? `\x1b[2m${text}\x1b[22m` : text) },
  });
  const row = selector.render(100).find((line) => line.startsWith(">"));
  assert.ok(row?.startsWith(">  [opencode-go] GPT 6 Luna ✓\x1b[2m  $15/mo"));
  for (const width of [1, 3, 20, 50, 100]) {
    for (const line of selector.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  selector.handleInput("\t");
  selector.handleInput("\x04");
  assert.ok(
    selector
      .render(100)
      .some((line) => line.startsWith("> \x1b[2m") && line.includes("~21,150 req/mo")),
  );
});

test("the picker opens before annotations arrive and does not render after disposal", async () => {
  let resolveRefresh!: (value: Record<string, string>) => void;
  const refresh = new Promise<Record<string, string>>((resolve) => {
    resolveRefresh = resolve;
  });
  let selector!: ModelSelector;
  let renders = 0;
  const context = {
    mode: "tui",
    ui: {
      custom(
        factory: (
          tui: object,
          theme: object,
          keys: object,
          done: (result: SelectorResult) => void,
        ) => ModelSelector,
      ) {
        return new Promise<SelectorResult>((resolve) => {
          selector = factory(
            {
              requestRender() {
                renders++;
              },
            },
            { fg: (_color: string, text: string) => text },
            {},
            resolve,
          );
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  const pending = chooseModel(context, {
    models: [{ provider: "opencode-go", id: "gpt", name: "GPT 6 Luna" }],
    states: {},
    refreshAnnotations: () => refresh,
  });
  assert.ok(selector.render(100).some((line) => line.includes("GPT 6 Luna")));
  assert.ok(selector.render(100).every((line) => !line.includes("req/mo")));
  resolveRefresh({ "opencode-go/gpt": "$15/mo · ~21,150 req/mo" });
  await refresh;
  assert.equal(renders, 1);
  assert.ok(selector.render(100).some((line) => line.includes("~21,150 req/mo")));
  selector.handleInput("\r");
  assert.equal((await pending).model?.id, "gpt");
  selector.dispose();
  selector.setAnnotations({});
  assert.equal(renders, 1);
});

test("only confirmed llama.cpp caches older than 24 hours expire", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "models-store.json");
  const now = Date.UTC(2026, 9, 13);
  const maxAge = 24 * 60 * 60 * 1000;
  assert.equal(await hasStaleLlamaCache(dir, now), false);
  const cases: [unknown, boolean][] = [
    [now - maxAge - 1, true],
    [now - maxAge, false],
    [now - maxAge + 1, false],
    [now + maxAge, false],
    [undefined, false],
    ["invalid", false],
  ];
  for (const [checkedAt, expected] of cases) {
    await writeFile(file, JSON.stringify({ "llama.cpp": { checkedAt } }));
    assert.equal(await hasStaleLlamaCache(dir, now), expected, `checkedAt=${String(checkedAt)}`);
  }
  await writeFile(file, JSON.stringify({ anthropic: { checkedAt: now - maxAge - 1 } }));
  assert.equal(await hasStaleLlamaCache(dir, now), false);
  await writeFile(file, "{invalid json");
  assert.equal(await hasStaleLlamaCache(dir, now), false);
});
