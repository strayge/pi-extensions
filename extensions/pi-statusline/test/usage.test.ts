import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectUsage } from "../src/usage.ts";

function context(entries: unknown[]): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => "test-session",
      getLeafId: () => null,
      getEntryCount: () => entries.length,
      getEntries: () => entries,
    },
  } as unknown as ExtensionContext;
}

test("standalone usage entries contribute tokens and cost", () => {
  const totals = collectUsage(
    context([
      {
        type: "usage",
        kind: "cache_warm",
        provider: "openai-codex",
        model: "gpt-5",
        usage: {
          input: 0,
          output: 1,
          cacheRead: 1000,
          cacheWrite: 0,
          cost: { total: 0.03 },
        },
      },
    ]),
  );

  assert.deepEqual(totals, {
    input: 0,
    output: 1,
    cacheRead: 1000,
    cacheWrite: 0,
    cost: 0.03,
  });
});

test("background usage does not replace the latest assistant cache hit rate", () => {
  const totals = collectUsage(
    context([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 20,
            output: 10,
            cacheRead: 80,
            cacheWrite: 0,
            cost: { total: 0.5 },
          },
        },
      },
      {
        type: "usage",
        kind: "cache_warm",
        usage: {
          input: 100,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.1 },
        },
      },
    ]),
  );

  assert.deepEqual(totals, {
    input: 120,
    output: 11,
    cacheRead: 80,
    cacheWrite: 0,
    cost: 0.6,
    latestCacheHitRate: 80,
  });
});

test("unchanged paints reuse totals without copying or scanning session entries", () => {
  const entries = [{ type: "usage", usage: { input: 10, cost: { total: 1 } } }];
  const ctx = context(entries);
  let scans = 0;
  ctx.sessionManager.getEntries = () => {
    scans++;
    return entries as ReturnType<typeof ctx.sessionManager.getEntries>;
  };

  const first = collectUsage(ctx);
  assert.equal(collectUsage(ctx), first);
  assert.equal(collectUsage({ ...ctx }), first);
  assert.equal(scans, 1);

  entries.push({ type: "usage", usage: { input: 20, cost: { total: 2 } } });
  const updated = collectUsage(ctx);
  assert.equal(updated.input, 30);
  assert.equal(updated.cost, 3);
  assert.equal(scans, 2);
  assert.equal(collectUsage(ctx), updated);
  assert.equal(scans, 2);
});

test("leaf and session changes invalidate cached totals even at the same entry count", () => {
  const entries = [{ type: "usage", usage: { input: 10, cost: { total: 1 } } }];
  const ctx = context(entries);
  const first = collectUsage(ctx);
  ctx.sessionManager.getLeafId = () => "another-branch";
  const branched = collectUsage(ctx);
  assert.notEqual(branched, first);
  assert.deepEqual(branched, first);

  ctx.sessionManager.getSessionId = () => "another-session";
  entries[0] = { type: "usage", usage: { input: 50, cost: { total: 5 } } };
  const switched = collectUsage(ctx);
  assert.equal(switched.input, 50);
  assert.equal(switched.cost, 5);
  assert.notEqual(switched, branched);
});

test("public snapshot fallback detects appends even when navigation restores the cached leaf", () => {
  const entries = [{ type: "usage", usage: { input: 10 } }];
  const ctx = {
    sessionManager: {
      getSessionId: () => "test-session",
      getLeafId: () => "original-leaf",
      getEntries: () => entries,
    },
  } as unknown as ExtensionContext;
  const first = collectUsage(ctx);
  assert.equal(collectUsage(ctx), first);
  entries.push({ type: "usage", usage: { input: 20 } });
  const updated = collectUsage(ctx);
  assert.notEqual(updated, first);
  assert.equal(updated.input, 30);
});

test("distinct session managers never share a cached total", () => {
  const first = context([{ type: "usage", usage: { input: 10 } }]);
  const second = context([{ type: "usage", usage: { input: 20 } }]);
  assert.equal(collectUsage(first).input, 10);
  assert.equal(collectUsage(second).input, 20);
  assert.equal(collectUsage(first).input, 10);
});
