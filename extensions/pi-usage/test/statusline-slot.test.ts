/**
 * The statusline slot: the option schema offered to a statusline that can edit
 * it, and the segments the quota is drawn with.
 *
 * The schema is generated from the same `buildSettings()` the `/usage` menu
 * reads, so most of what matters here is that a value set from the statusline
 * lands exactly where the same value set in `/usage` would.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { defaultDisplayConfig, presetConfig } from "../src/config.ts";
import { buildSettings } from "../src/display-menu.ts";
import { formatUsageSegments, formatUsageStatusline } from "../src/format.ts";
import {
  applyUsageSlotOptions,
  usageSlotDefaults,
  usageSlotFields,
} from "../src/statusline-schema.ts";
import { publishStatuslineItem, registerStatuslineSlot } from "../src/statusline-slot.ts";
import type { UsageBucket, UsageReport } from "../src/types.ts";
import { createMockContext, createMockPi } from "./support.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function codexBucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    id: "codex:primary",
    label: "Primary limit",
    groupId: "codex",
    groupLabel: "Codex",
    used: 41,
    remaining: 59,
    limit: 100,
    unit: "percent",
    windowMinutes: 300,
    resetsAt: (NOW + 192 * MINUTE) / 1000,
    ...overrides,
  };
}

function codexReport(buckets: UsageBucket[]): UsageReport {
  return {
    providerId: "openai-codex",
    providerName: "OpenAI Codex",
    capturedAt: NOW,
    source: "test",
    semantics: { kind: "consumer-subscription", label: "ChatGPT subscription limits" },
    buckets,
    metrics: [],
  };
}

test("published text follows the calling session, including unchanged values", () => {
  const mock = createMockPi();
  const { ctx } = createMockContext();
  const { ctx: otherCtx } = createMockContext({
    sessionManager: { getSessionId: () => "other-session" },
  });
  const published: unknown[] = [];
  const cleared: unknown[] = [];
  mock.eventBus.on("statusline:publish", (data) => published.push(data));
  mock.eventBus.on("statusline:clear", (data) => cleared.push(data));
  const publish = publishStatuslineItem(mock.pi, { id: "usage" });

  publish(ctx, "42%");
  publish(ctx, "42%");
  assert.deepEqual(published, [{ id: "usage", text: "42%", owner: "test-session" }]);

  publish(otherCtx, "42%");
  assert.deepEqual(published[1], { id: "usage", text: "42%", owner: "other-session" });
  mock.eventBus.emit("statusline:request", { owner: "test-session" });
  mock.eventBus.emit("statusline:request", {});
  assert.equal(published.length, 2);
  mock.eventBus.emit("statusline:request", { owner: "other-session" });
  assert.deepEqual(published[2], published[1]);

  publish(otherCtx, undefined);
  publish(otherCtx, undefined);
  assert.deepEqual(cleared, [{ id: "usage", owner: "other-session" }]);
  mock.eventBus.emit("statusline:request", { owner: "other-session" });
  assert.equal(published.length, 3);
  assert.equal(cleared.length, 1);
});

test("uninitialized helpers ignore unstamped requests and options", () => {
  const mock = createMockPi();
  const messages: unknown[] = [];
  for (const channel of [
    "statusline:publish",
    "statusline:clear",
    "statusline:register",
    "statusline:unregister",
  ]) {
    mock.eventBus.on(channel, (data) => messages.push(data));
  }
  let optionCalls = 0;
  publishStatuslineItem(mock.pi, { id: "usage" });
  const slot = registerStatuslineSlot(mock.pi, {
    id: "usage",
    version: 1,
    fields: [],
    onOptions: () => {
      optionCalls += 1;
    },
  });
  mock.eventBus.emit("statusline:request", {});
  mock.eventBus.emit("statusline:options", { id: "usage", instances: [{ options: {} }] });
  slot.dispose();
  assert.equal(optionCalls, 0);
  assert.deepEqual(messages, []);
});

test("registration waits for refresh and replays only for its current owner", () => {
  const mock = createMockPi();
  const { ctx } = createMockContext();
  const registered: unknown[] = [];
  const unregistered: unknown[] = [];
  mock.eventBus.on("statusline:register", (data) => registered.push(data));
  mock.eventBus.on("statusline:unregister", (data) => unregistered.push(data));
  const definition = { id: "usage", version: 1, fields: [] };
  const slot = registerStatuslineSlot(mock.pi, definition);
  assert.deepEqual(registered, []);

  slot.refresh(ctx);
  assert.deepEqual(registered, [{ ...definition, defaults: undefined, owner: "test-session" }]);
  mock.eventBus.emit("statusline:request", { owner: "other-session" });
  mock.eventBus.emit("statusline:request", {});
  assert.equal(registered.length, 1);
  mock.eventBus.emit("statusline:request", { owner: "test-session" });
  assert.deepEqual(registered[1], registered[0]);

  const { ctx: otherCtx } = createMockContext({
    sessionManager: { getSessionId: () => "other-session" },
  });
  slot.refresh(otherCtx);
  assert.deepEqual(registered[2], {
    ...definition,
    defaults: undefined,
    owner: "other-session",
  });
  slot.dispose();
  assert.deepEqual(unregistered, [{ id: "usage", owner: "other-session" }]);
  mock.eventBus.emit("statusline:request", { owner: "other-session" });
  assert.equal(registered.length, 3);
});

test("only own-session options update config and re-announce its defaults", () => {
  const mock = createMockPi();
  const { ctx } = createMockContext();
  const registered: unknown[] = [];
  const received: unknown[] = [];
  let width = 8;
  mock.eventBus.on("statusline:register", (data) => registered.push(data));
  const definition = { id: "usage", version: 1, fields: [] };
  const slot = registerStatuslineSlot(mock.pi, {
    ...definition,
    defaults: () => ({ width }),
    onOptions: (options, instances) => {
      received.push({ options, instances });
      width = Number(options.width);
    },
  });
  slot.refresh(ctx);
  const instances = [{ options: { width: 12 } }, { options: { width: 20 } }];
  mock.eventBus.emit("statusline:options", { id: "usage", owner: "other-session", instances });
  mock.eventBus.emit("statusline:options", { id: "usage", instances });
  assert.deepEqual(received, []);
  assert.equal(registered.length, 1);

  mock.eventBus.emit("statusline:options", { id: "usage", owner: "test-session", instances });
  assert.deepEqual(received, [
    { options: { width: 12 }, instances: [{ width: 12 }, { width: 20 }] },
  ]);
  assert.deepEqual(registered[1], {
    ...definition,
    defaults: { width: 12 },
    owner: "test-session",
  });
  slot.dispose();
  mock.eventBus.emit("statusline:options", { id: "usage", owner: "test-session", instances });
  assert.equal(received.length, 1);
  assert.equal(registered.length, 2);
});

test("layout demand is owner-scoped and never treated as a saved option change", () => {
  const mock = createMockPi();
  const { ctx } = createMockContext();
  const received: unknown[] = [];
  let saves = 0;
  const slot = registerStatuslineSlot(mock.pi, {
    id: "usage",
    version: 1,
    fields: [],
    onInstances: (instances) => received.push(instances),
    onOptions: () => {
      saves += 1;
    },
  });
  const message = {
    owner: "test-session",
    id: "usage",
    instances: [{ options: { provider: "anthropic" } }],
  };
  mock.eventBus.emit("statusline:instances", message);
  slot.refresh(ctx);
  mock.eventBus.emit("statusline:instances", { ...message, owner: "other-session" });
  mock.eventBus.emit("statusline:instances", { ...message, id: "other-slot" });
  assert.deepEqual(received, []);
  mock.eventBus.emit("statusline:instances", message);
  mock.eventBus.emit("statusline:instances", { ...message, instances: [] });
  assert.deepEqual(received, [[{ provider: "anthropic" }], []]);
  assert.equal(saves, 0);
  slot.dispose();
  mock.eventBus.emit("statusline:instances", message);
  assert.equal(received.length, 2);
});

test("provider selection precedes the existing display settings without changing their order", () => {
  const fields = usageSlotFields();
  assert.deepEqual(
    fields.slice(0, 2).map((field) => field.key),
    ["provider", "hide-when-current"],
  );
  assert.deepEqual(
    fields.slice(2).map((field) => field.key),
    buildSettings().map((setting) => setting.id),
  );
  assert.equal(fields[2]?.key, "preset");
});

test("every field is a kind the statusline editor can actually edit", () => {
  for (const field of usageSlotFields()) {
    assert.ok(["string", "number", "boolean", "enum"].includes(field.kind), field.key);
    if (field.kind === "enum") assert.ok((field.options?.length ?? 0) > 0, field.key);
    if (field.kind === "number") {
      assert.equal(typeof field.min, "number");
      assert.equal(typeof field.max, "number");
    }
  }
});

test("declared defaults are the producer's own current values", () => {
  const defaults = usageSlotDefaults(presetConfig("full"));
  assert.equal(defaults.provider, "current");
  assert.equal(defaults["hide-when-current"], false);
  assert.equal(defaults.preset, "full");
  assert.equal(defaults.buckets, "all");
  assert.equal(defaults["bar-width"], 8);
  // Toggles arrive as booleans, not as the menu's "on"/"off" strings.
  assert.equal(defaults["reset-time"], true);
  assert.equal(defaults["pace-marker"], true);
});

test("a slot option reaches exactly as far as the same change in /usage", () => {
  const start = presetConfig("compact");
  const setting = buildSettings().find((candidate) => candidate.id === "reset-time");
  assert.ok(setting);

  const throughMenu = setting.apply(start, "off");
  const throughSlot = applyUsageSlotOptions(start, { "reset-time": false });

  assert.deepEqual(throughSlot, throughMenu);
  // And that reach covers both surfaces, as the menu's own toggle does.
  assert.equal(throughSlot.statusline.fields.includes("reset"), false);
  assert.equal(throughSlot.report.fields.includes("reset"), false);
});

test("unset options leave the producer's config exactly as it was", () => {
  const start = presetConfig("minimal");
  assert.deepEqual(applyUsageSlotOptions(start, {}), start);
});

test("a preset option is applied before the keys it would overwrite", () => {
  const applied = applyUsageSlotOptions(defaultDisplayConfig(), {
    preset: "minimal",
    "bar-width": 20,
  });

  assert.equal(applied.statusline.barWidth, 20);
  // The rest of `minimal` survived, so the width was layered on top of it.
  assert.equal(applied.statusline.buckets, "primary");
});

test("the bar width from a slot is clamped like the menu's own", () => {
  const applied = applyUsageSlotOptions(defaultDisplayConfig(), { "bar-width": 999 });
  assert.equal(applied.statusline.barWidth, 40);
});

test("segments join back into exactly the plain statusline string", () => {
  const report = codexReport([codexBucket()]);
  for (const preset of ["legacy", "minimal", "compact", "full"] as const) {
    const config = presetConfig(preset);
    const segments = formatUsageSegments(report, undefined, config, NOW) ?? [];
    assert.equal(
      segments.map((segment) => segment.text).join(""),
      formatUsageStatusline(report, undefined, config, NOW),
      preset,
    );
  }
});

test("only the quota carries a color, and only once it is worth one", () => {
  const calm = formatUsageSegments(codexReport([codexBucket({ used: 41, remaining: 59 })]));
  assert.deepEqual(
    calm?.filter((segment) => segment.color),
    [],
  );

  const hot = formatUsageSegments(
    codexReport([codexBucket({ used: 95, remaining: 5 })]),
    undefined,
    defaultDisplayConfig(),
    NOW,
  );
  const colored = hot?.filter((segment) => segment.color) ?? [];
  assert.ok(colored.length > 0);
  for (const segment of colored) assert.equal(segment.color, "error");
  // The countdown is not part of the warning: it is not what ran out.
  assert.equal(
    hot?.some((segment) => segment.text.includes("h") && segment.color !== undefined),
    false,
  );
});

test("the alert reads consumption whichever way the percentage is worded", () => {
  const spent = codexReport([codexBucket({ used: 95, remaining: 5 })]);
  const used = formatUsageSegments(spent, undefined, presetConfig("compact"), NOW);
  const remaining = formatUsageSegments(
    spent,
    undefined,
    { ...presetConfig("compact"), value: "remaining" },
    NOW,
  );

  assert.equal(
    used?.some((segment) => segment.color === "error"),
    true,
  );
  assert.equal(
    remaining?.some((segment) => segment.color === "error"),
    true,
  );
});
