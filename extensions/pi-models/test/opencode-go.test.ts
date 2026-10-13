import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { goAnnotations, parseGoAllowances, validateGoAllowances } from "../src/opencode-go.ts";
import { GoCatalogCache } from "../src/opencode-go-cache.ts";

const source = `
// Requests are per 5 hours; allowances are monthly.
export const goModels = [
  { id: "gpt-6-luna", name: "GPT 6 Luna", requests: 4230, allowance: 15, featured: true },
  {
    id: "deepseek-flash", name: "DeepSeek V4.1 Flash",
    requests: 34670, allowance: 80, baseRequests: 26000, bonus: true,
  },
  { id: "free", name: "Free", requests: Infinity, allowance: Infinity, limitedTime: true },
].sort((a, b) => a.requests - b.requests);
const plusLimits: Record<string, [number, number]> = { "gpt-6-luna": [16920, 60] };
export const goPlanModels = goModels.map(model => ({ ...model, plusAllowance: plusLimits[model.id]![1] }));
throw new Error("Downloaded code must not run");
`;
const catalog = parseGoAllowances(source);
const gpt = { provider: "opencode-go", id: "gpt-6-luna", name: "GPT-6 Luna" };
const deepseek = {
  provider: "opencode-go",
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
};

test("literal extraction tolerates provider formatting and metadata without executing its transformations", () => {
  assert.deepEqual(catalog, [
    { id: "gpt-6-luna", name: "GPT 6 Luna", requests: 4230, allowance: 15 },
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", requests: 34670, allowance: 80 },
    { id: "free", name: "Free", requests: null, allowance: null, limitedTime: true },
  ]);
  assert.deepEqual(validateGoAllowances(JSON.parse(JSON.stringify(catalog))), catalog);
});

test("unsupported source shapes and executable field values are rejected", () => {
  for (const invalid of [
    source.replace("allowance: 15", "allowance: getAllowance()"),
    source.replace("allowance: 15", "allowance: 15, allowance: 20"),
    source.replace("allowance: 15", "allowance: 0"),
    source.replace("requests: 4230", 'requests: "4230"'),
    source.replace('id: "gpt-6-luna"', '...other, id: "gpt-6-luna"'),
    source.replace('id: "deepseek-flash"', 'id: "gpt-6-luna"'),
    source.replace("goModels = [", "goModels = compute(["),
    "export const goModels = [];",
  ])
    assert.throws(() => parseGoAllowances(invalid));
});

test("monthly estimates use source Go values and safe ID or unique-name matching", () => {
  const models = [
    { ...gpt, name: "My custom name" },
    { ...deepseek, name: "deepseek_v4.1-flash" },
    { provider: "opencode-go", id: "free" },
    { ...gpt, provider: "another-provider" },
    { provider: "opencode-go", id: "unknown", name: "DeepSeek V41 Flash" },
    { provider: "opencode-go", id: "other", name: "DeepSeek V4.1 Pro" },
  ];
  assert.deepEqual(goAnnotations(models, catalog), {
    "opencode-go/gpt-6-luna": "$15/mo · ~21,150 req/mo",
    "opencode-go/deepseek-v4.1-flash": "$80/mo · ~173,350 req/mo",
    "opencode-go/free": "Unlimited (limited time)",
  });
});

test("ambiguous source or target names are not guessed", () => {
  const [gptEntry, deepseekEntry] = catalog;
  assert.ok(gptEntry && deepseekEntry);
  const duplicate = { ...deepseekEntry, id: "duplicate" };
  assert.deepEqual(goAnnotations([deepseek], [...catalog, duplicate]), {});
  assert.deepEqual(goAnnotations([deepseek, { ...deepseek, id: "custom" }], catalog), {});
  assert.ok(
    goAnnotations([gpt], [...catalog, { ...gptEntry, id: "another" }])["opencode-go/gpt-6-luna"],
  );
});

test("a successful fetch persists unlimited sentinels and fresh caches avoid requests", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-go-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "cache.json");
  let requests = 0;
  const cache = new GoCatalogCache(file, async () => {
    requests++;
    return new Response(source, { headers: { etag: '"catalog-v1"' } });
  });
  await cache.load();
  assert.equal(requests, 0);
  assert.deepEqual(cache.annotations([gpt]), {});
  await cache.refresh();
  assert.equal(cache.annotations([gpt])["opencode-go/gpt-6-luna"], "$15/mo · ~21,150 req/mo");
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.etag, '"catalog-v1"');
  assert.equal(persisted.models[2].requests, null);
  assert.deepEqual(await readdir(dir), ["cache.json"]);
  const reloaded = new GoCatalogCache(file, async () => {
    assert.fail("Fresh cache must not fetch");
  });
  await reloaded.load();
  await reloaded.refresh();
  assert.deepEqual(reloaded.annotations([gpt]), cache.annotations([gpt]));
  assert.equal(requests, 1);
});

test("stale caches are revalidated conditionally and a 304 clears the stale marker", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-go-304-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "cache.json");
  await writeFile(
    file,
    JSON.stringify({ version: 1, checkedAt: 0, etag: '"v1"', models: catalog }),
  );
  const cache = new GoCatalogCache(file, async (_url, options) => {
    assert.equal(new Headers(options?.headers).get("If-None-Match"), '"v1"');
    return new Response(null, { status: 304 });
  });
  await cache.load();
  assert.match(cache.annotations([gpt])["opencode-go/gpt-6-luna"] ?? "", /\[stale\]$/);
  await cache.refresh();
  assert.equal(cache.annotations([gpt])["opencode-go/gpt-6-luna"], "$15/mo · ~21,150 req/mo");
  assert.ok(JSON.parse(await readFile(file, "utf8")).checkedAt > 0);
});

test("offline or incompatible refreshes keep the last good cache and back off", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-go-failed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const fail of ["network", "schema", "http"]) {
    const file = join(dir, `${fail}.json`);
    const saved = JSON.stringify({ version: 1, checkedAt: 0, models: catalog });
    await writeFile(file, saved);
    let requests = 0;
    const cache = new GoCatalogCache(file, async () => {
      requests++;
      if (fail === "network") throw new Error("Offline");
      return new Response(fail === "schema" ? "export const models = [];" : "Unavailable", {
        status: fail === "http" ? 503 : 200,
      });
    });
    await cache.load();
    await cache.refresh();
    await cache.refresh();
    assert.equal(requests, 1);
    assert.match(cache.annotations([gpt])["opencode-go/gpt-6-luna"] ?? "", /\[stale\]$/);
    assert.equal(await readFile(file, "utf8"), saved);
  }
});

test("invalid persisted catalogs do not publish annotations or reuse their etag", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-go-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "cache.json");
  await writeFile(
    file,
    JSON.stringify({ version: 1, checkedAt: 0, etag: '"bad"', models: [{ id: "bad" }] }),
  );
  const cache = new GoCatalogCache(file, async (_url, options) => {
    assert.equal(new Headers(options?.headers).has("If-None-Match"), false);
    return new Response(source);
  });
  await cache.load();
  assert.deepEqual(cache.annotations([gpt]), {});
  await cache.refresh();
  assert.ok(cache.annotations([gpt])["opencode-go/gpt-6-luna"]);
});

test("concurrent refreshes share a request and shutdown aborts it without publishing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-go-abort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cache = new GoCatalogCache(join(dir, "cache.json"), async (_url, options) => {
    started();
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("Aborted")), {
        once: true,
      });
    });
  });
  const pending = cache.refresh();
  assert.equal(cache.refresh(), pending);
  await start;
  cache.dispose();
  await pending;
  assert.deepEqual(cache.annotations([gpt]), {});
  assert.deepEqual(await readdir(dir), []);
});
