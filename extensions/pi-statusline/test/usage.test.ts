import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectUsage } from "../src/usage.ts";

function context(entries: unknown[]): ExtensionContext {
  return {
    sessionManager: { getEntries: () => entries },
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
