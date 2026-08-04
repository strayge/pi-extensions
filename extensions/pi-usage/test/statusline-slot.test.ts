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
import type { UsageBucket, UsageReport } from "../src/types.ts";

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

test("the schema offers one field per display setting, in the same order", () => {
  const fields = usageSlotFields();
  assert.deepEqual(
    fields.map((field) => field.key),
    buildSettings().map((setting) => setting.id),
  );
  // `preset` first matters: it rewrites every other value when applied.
  assert.equal(fields[0]?.key, "preset");
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
