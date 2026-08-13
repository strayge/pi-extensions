import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { prioritizeModelsCommand } from "../src/autocomplete.ts";
import { ModelSelector } from "../src/selector.ts";
import { modelKey, rankModels } from "../src/sort.ts";
import { loadHistory, mutateHistory, parseHistory } from "../src/store.ts";

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
      good: { favorite: true, lastUsedAt: 4, thinkingLevel: "high" },
      bad: "no",
      nan: { lastUsedAt: "4", thinkingLevel: "extreme" },
    },
  });
  assert.deepEqual(history.models, {
    good: { favorite: true, lastUsedAt: 4, thinkingLevel: "high" },
  });
});

test("mutation reloads and preserves unavailable entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-"));
  const file = join(dir, "model-history.json");
  await writeFile(file, JSON.stringify({ version: 1, models: { "gone/id": { favorite: true } } }));
  await mutateHistory((history) => {
    history.models["live/id"] = { lastUsedAt: 3 };
  }, file);
  assert.deepEqual((await loadHistory(file)).models, {
    "gone/id": { favorite: true },
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
  });
});
