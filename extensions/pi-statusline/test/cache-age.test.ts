import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COLD_AFTER_MINUTES,
  isCacheCold,
  lastResponseFromEntries,
  nextColdTransition,
} from "../src/cache-age.ts";
import { createRuntime, type RuntimeState } from "../src/runtime.ts";
import type { ContextItemConfig } from "../src/types.ts";

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const MINUTE = 60_000;

function runtimeAt(lastResponseAt?: number): RuntimeState {
  return { ...createRuntime(), lastResponseAt };
}

function context(item: Partial<ContextItemConfig> = {}): ContextItemConfig {
  return { type: "context", ...item };
}

/** A session whose entries are shaped the way pi writes them. */
function ctxWithEntries(entries: unknown[]): ExtensionContext {
  return { sessionManager: { getEntries: () => entries } } as unknown as ExtensionContext;
}

function messageEntry(role: string, timestamp: string) {
  return { type: "message", id: role + timestamp, parentId: null, timestamp, message: { role } };
}

test("an item that never asked to be marked is never cold", () => {
  const ancient = runtimeAt(NOW - 30 * 24 * 60 * MINUTE);
  assert.equal(isCacheCold(context(), ancient, NOW), false);
  assert.equal(isCacheCold(context({ coldStyle: "off" }), ancient, NOW), false);
  assert.equal(isCacheCold(context({ coldStyle: "symbol" }), ancient, NOW), true);
});

test("the idle allowance defaults to an hour and is measured inclusively", () => {
  const item = context({ coldStyle: "symbol" });
  const at = (minutesIdle: number) => isCacheCold(item, runtimeAt(NOW - minutesIdle * MINUTE), NOW);

  assert.equal(DEFAULT_COLD_AFTER_MINUTES, 60);
  assert.equal(at(0), false);
  assert.equal(at(59.9), false);
  assert.equal(at(60), true);
});

test("no response behind the session means nothing to have gone cold", () => {
  assert.equal(isCacheCold(context({ coldStyle: "both" }), runtimeAt(undefined), NOW), false);
  assert.equal(
    nextColdTransition([context({ coldStyle: "both" })], runtimeAt(undefined), NOW),
    undefined,
  );
});

test("the next transition is the soonest deadline still ahead", () => {
  const runtime = runtimeAt(NOW - 10 * MINUTE);
  const items = [
    context({ coldStyle: "symbol", coldAfterMinutes: 60 }),
    context({ coldStyle: "color", coldAfterMinutes: 30 }),
    // Off, so it never comes due however short its allowance.
    context({ coldAfterMinutes: 1 }),
  ];

  assert.equal(nextColdTransition(items, runtime, NOW), NOW + 20 * MINUTE);
});

test("a deadline already behind us needs no wake-up", () => {
  const runtime = runtimeAt(NOW - 90 * MINUTE);
  assert.equal(nextColdTransition([context({ coldStyle: "symbol" })], runtime, NOW), undefined);

  // One item still pending is enough to arm the timer for it alone.
  const mixed = [
    context({ coldStyle: "symbol", coldAfterMinutes: 60 }),
    context({ coldStyle: "symbol", coldAfterMinutes: 120 }),
  ];
  assert.equal(nextColdTransition(mixed, runtime, NOW), NOW + 30 * MINUTE);
});

test("a resumed session takes its starting point from the newest assistant message", () => {
  const ctx = ctxWithEntries([
    messageEntry("user", "2026-01-01T10:00:00.000Z"),
    messageEntry("assistant", "2026-01-01T10:00:09.000Z"),
    messageEntry("user", "2026-01-01T11:00:00.000Z"),
    messageEntry("assistant", "2026-01-01T11:00:07.000Z"),
    // Tool results land after the response that asked for them, and are not one.
    messageEntry("toolResult", "2026-01-01T11:00:20.000Z"),
    { type: "model_change", id: "m", parentId: null, timestamp: "2026-01-01T11:05:00.000Z" },
  ]);

  assert.equal(lastResponseFromEntries(ctx), Date.parse("2026-01-01T11:00:07.000Z"));
});

test("a session with no responses on disk leaves the starting point unset", () => {
  assert.equal(lastResponseFromEntries(ctxWithEntries([])), undefined);
  assert.equal(
    lastResponseFromEntries(ctxWithEntries([messageEntry("user", "2026-01-01T10:00:00.000Z")])),
    undefined,
  );
  // An unparseable timestamp is skipped rather than turned into a NaN deadline.
  assert.equal(
    lastResponseFromEntries(ctxWithEntries([messageEntry("assistant", "not-a-date")])),
    undefined,
  );
});

test("a session manager that cannot answer costs the marker, not the session", () => {
  assert.equal(lastResponseFromEntries({} as ExtensionContext), undefined);
  const throwing = {
    sessionManager: {
      getEntries: () => {
        throw new Error("stale extension ctx");
      },
    },
  } as unknown as ExtensionContext;
  assert.equal(lastResponseFromEntries(throwing), undefined);
});
