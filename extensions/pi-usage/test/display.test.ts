import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  defaultDisplayConfig,
  loadDisplayConfig,
  matchingPreset,
  presetConfig,
  saveDisplayConfig,
  validateDisplayConfig,
} from "../src/config.ts";
import { showDisplayMenu } from "../src/display-menu.ts";
import { formatDuration } from "../src/duration.ts";
import { formatUsageReport, formatUsageStatusline } from "../src/format.ts";
import { isAtRisk, minutesToExhaustion, renderBar, windowElapsedFraction } from "../src/gauge.ts";
import type { UsageBucket, UsageReport } from "../src/types.ts";
import { createCustomSelectorHarness } from "./support.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching real escapes
  return value.replace(/\[[0-9;]*m/g, "");
}

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

test("durations drop the smaller unit once the larger one makes it noise", () => {
  const ladder: Array<[number, string]> = [
    [0.4, "<1m"],
    [7, "7m"],
    [59, "59m"],
    [60, "1h"],
    [72, "1h 12m"],
    [359, "5h 59m"],
    [360, "6h"],
    [431, "7h"],
    [1_439, "23h"],
    [1_440, "1d"],
    [1_920, "1d 8h"],
    [2_879, "1d 23h"],
    [2_880, "2d"],
    [6_120, "4d"],
  ];
  for (const [minutes, expected] of ladder) {
    assert.equal(formatDuration(minutes, true), expected, `${minutes}m`);
  }
  assert.equal(formatDuration(72, false), "1h12m");
  assert.equal(formatDuration(1_920, false), "1d8h");
  assert.equal(formatDuration(0, true), "");
  assert.equal(formatDuration(-5, true), "");
});

test("window arithmetic reads elapsed time and burn rate from a fixed window", () => {
  const bucket = codexBucket();
  assert.equal(windowElapsedFraction(bucket, NOW)?.toFixed(2), "0.36");

  // 41% burned over 108 minutes reaches 100% about 155 minutes from now, which
  // is inside the 192 minutes left in the window.
  assert.equal(Math.round(minutesToExhaustion(bucket, NOW) ?? 0), 155);
  assert.equal(isAtRisk(bucket, NOW), true);

  // 3% burned in the first 6 minutes still projects to a real number.
  const early = codexBucket({ used: 3, remaining: 97, resetsAt: (NOW + 294 * MINUTE) / 1000 });
  assert.equal(Math.round(minutesToExhaustion(early, NOW) ?? 0), 194);

  // 95% with five minutes to go outlasts its own window.
  const nearlyDone = codexBucket({ used: 95, remaining: 5, resetsAt: (NOW + 5 * MINUTE) / 1000 });
  assert.equal(isAtRisk(nearlyDone, NOW), false);
});

test("a lapsed window has no clock to read", () => {
  const lapsed = codexBucket({ resetsAt: (NOW - MINUTE) / 1000 });
  assert.equal(windowElapsedFraction(lapsed, NOW), undefined);
  assert.equal(minutesToExhaustion(lapsed, NOW), undefined);
  assert.equal(isAtRisk(lapsed, NOW), false);
});

test("the pace tick overwrites a cell instead of widening the bar", () => {
  assert.equal(renderBar(41, 12), "[█████░░░░░░░]");
  assert.equal(renderBar(41, 12, 0.36), "[████┃░░░░░░░]");
  assert.equal(renderBar(95, 12, 0.2), "[██┃████████░]");
  assert.equal(renderBar(95, 12, 0.98), "[███████████┃]");
  for (const marker of [-1, 0, 1, 2]) {
    assert.equal([...renderBar(50, 8, marker)].length, 10);
  }
});

test("the statusline separates equal percentages by the time left", () => {
  const panic = codexReport([
    codexBucket({ used: 95, remaining: 5, resetsAt: (NOW + 240 * MINUTE) / 1000 }),
  ]);
  const fine = codexReport([
    codexBucket({ used: 95, remaining: 5, resetsAt: (NOW + 5 * MINUTE) / 1000 }),
  ]);

  assert.equal(
    formatUsageStatusline(panic, undefined, defaultDisplayConfig(), NOW),
    "codex [██┃█████] 95% 4h",
  );
  assert.equal(
    formatUsageStatusline(fine, undefined, defaultDisplayConfig(), NOW),
    "codex [███████┃] 95% 5m",
  );
  // The legacy preset cannot tell them apart, which is why it is not the default.
  assert.equal(
    formatUsageStatusline(panic, undefined, presetConfig("legacy"), NOW),
    formatUsageStatusline(fine, undefined, presetConfig("legacy"), NOW),
  );
});

test("presets render the documented statusline shapes", () => {
  const report = codexReport([
    codexBucket(),
    codexBucket({
      id: "codex:secondary",
      label: "Secondary limit",
      used: 39,
      remaining: 61,
      windowMinutes: 10_080,
      resetsAt: (NOW + 6_120 * MINUTE) / 1000,
    }),
  ]);
  const render = (preset: "legacy" | "minimal" | "compact" | "full") =>
    formatUsageStatusline(report, undefined, presetConfig(preset), NOW);

  assert.equal(render("legacy"), "codex 59% 5h 61% wk");
  assert.equal(render("minimal"), "codex 41% 3h 12m");
  assert.equal(render("compact"), "codex [███┃░░░░] 41% 3h 12m");
  assert.equal(render("full"), "codex 5h [███┃░░░░] 41% 3h 12m · wk [███┃░░░░] 39% 4d");
});

test("auto buckets stay narrow until a second window is on track to run out", () => {
  const calmWeekly = codexBucket({
    id: "codex:secondary",
    used: 39,
    remaining: 61,
    windowMinutes: 10_080,
    resetsAt: (NOW + 6_120 * MINUTE) / 1000,
  });
  const hotWeekly = codexBucket({
    id: "codex:secondary",
    used: 95,
    remaining: 5,
    windowMinutes: 10_080,
    resetsAt: (NOW + 4_000 * MINUTE) / 1000,
  });

  assert.equal(isAtRisk(calmWeekly, NOW), false);
  assert.equal(isAtRisk(hotWeekly, NOW), true);
  assert.equal(
    formatUsageStatusline(codexReport([codexBucket(), calmWeekly]), undefined, undefined, NOW),
    "codex [███┃░░░░] 41% 3h 12m",
  );
  assert.match(
    formatUsageStatusline(codexReport([codexBucket(), hotWeekly]), undefined, undefined, NOW) ?? "",
    /95% 2d$/,
  );
});

test("a lapsed window drops the countdown instead of naming a state", () => {
  const report = codexReport([
    codexBucket({ used: 0, remaining: 100, resetsAt: (NOW - MINUTE) / 1000 }),
  ]);
  assert.equal(
    formatUsageStatusline(report, undefined, defaultDisplayConfig(), NOW),
    "codex [░░░░░░░░] 0%",
  );
  // The report has room to say why the countdown is missing.
  assert.match(
    formatUsageReport(report, "current", defaultDisplayConfig(), NOW),
    /no active window/,
  );
});

test("the report carries both clock forms and the projection", () => {
  const report = codexReport([
    codexBucket({ used: 95, remaining: 5, resetsAt: (NOW + 240 * MINUTE) / 1000 }),
  ]);
  const text = formatUsageReport(report, "current", defaultDisplayConfig(), NOW);
  assert.match(text, /95% used/);
  assert.match(text, /\(in 4h\)/);
  assert.match(text, /empty in ~3m/);

  // Silent when the quota outlasts the window.
  const calm = codexReport([
    codexBucket({ used: 95, remaining: 5, resetsAt: (NOW + 5 * MINUTE) / 1000 }),
  ]);
  assert.doesNotMatch(formatUsageReport(calm, "current", defaultDisplayConfig(), NOW), /empty in/);
});

test("switching every field off hides the entry rather than claiming a failure", () => {
  const config = defaultDisplayConfig();
  config.statusline.fields = [];
  assert.equal(
    formatUsageStatusline(codexReport([codexBucket()]), undefined, config, NOW),
    undefined,
  );

  // A report with no windows at all is a different thing, and still says so.
  const creditsOnly: UsageReport = {
    ...codexReport([]),
    metrics: [{ id: "credits", label: "Credits", value: "available" }],
  };
  assert.equal(
    formatUsageStatusline(creditsOnly, undefined, defaultDisplayConfig(), NOW),
    "codex credits available",
  );
});

test("the settings panel changes the row under the cursor and leaves it there", () => {
  initTheme("dark", false);
  let config = defaultDisplayConfig();
  let factory: unknown;
  const ctx = {
    mode: "tui",
    ui: { custom: (candidate: unknown) => (factory = candidate) },
  } as never;

  void showDisplayMenu(ctx, {
    config,
    save: (next) => {
      config = next;
      return next;
    },
    signal: new AbortController().signal,
    configPath: "usage.json",
  });

  const harness = createCustomSelectorHarness(factory, 90);
  const rowFor = (lines: string[], label: string) =>
    lines.find((line) => stripAnsi(line).includes(label)) ?? "";

  // Down to "Show", then cycle its value.
  harness.handleInput("[B");
  const afterCycle = harness.handleInput("\r");

  assert.equal(config.value, "remaining");
  // The cursor stays on the row that was changed rather than jumping to the top.
  assert.match(stripAnsi(rowFor(afterCycle, "Show")), /→\s+Show/);
  assert.doesNotMatch(stripAnsi(rowFor(afterCycle, "Preset")), /→\s+Preset/);
  // Diverging from the preset is reflected without rewriting the other rows.
  assert.match(stripAnsi(rowFor(afterCycle, "Preset")), /custom/);
  assert.match(stripAnsi(rowFor(afterCycle, "Buckets")), /auto/);

  // A second press cycles the same row back, not a neighbouring one.
  harness.handleInput("\r");
  assert.equal(config.value, "used");
  assert.equal(matchingPreset(config), "compact");
});

test("config validation keeps what it understands and reports the rest", () => {
  const { config, warnings } = validateDisplayConfig({
    version: 2,
    preset: "minimal",
    value: "sideways",
    statusline: { fields: ["bar", "nonsense", "bar", "reset"], barWidth: 500, buckets: "auto" },
    report: "not an object",
  });

  assert.deepEqual(config.statusline.fields, ["bar", "reset"]);
  assert.equal(config.statusline.barWidth, 40);
  assert.equal(config.statusline.buckets, "auto");
  assert.equal(config.value, "used");
  assert.deepEqual(config.report.fields, presetConfig("minimal").report.fields);
  assert.equal(warnings.length, 4);
  assert.equal(config.preset, "custom");
});

test("a config naming only a preset tracks that preset", () => {
  const { config, warnings } = validateDisplayConfig({ preset: "full" });
  assert.deepEqual(config, presetConfig("full"));
  assert.deepEqual(warnings, []);
  assert.equal(matchingPreset(config), "full");
});

test("config round-trips through disk and falls back when the file is unusable", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-config-"));
  const path = join(dir, "usage.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(loadDisplayConfig(path).config, defaultDisplayConfig());
  assert.equal(loadDisplayConfig(path).fromFile, false);

  const wanted = { ...presetConfig("minimal"), value: "remaining" as const };
  saveDisplayConfig(wanted, path);
  const loaded = loadDisplayConfig(path);
  assert.equal(loaded.fromFile, true);
  // Stored as `custom`: the value no longer matches the preset it started from.
  assert.deepEqual(loaded.config, { ...wanted, preset: "custom" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).preset, "custom");
  // Padding around a separator has to survive the round trip.
  assert.equal(loaded.config.statusline.separator, " · ");

  writeFileSync(path, "{ not json");
  const broken = loadDisplayConfig(path);
  assert.deepEqual(broken.config, defaultDisplayConfig());
  assert.equal(broken.warnings.length, 1);
});
