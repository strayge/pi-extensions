import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TUI, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import {
  CACHE_GAP_BUCKETS,
  deriveHistoryRange,
  type LiveQuotaContext,
  type LoadedHistory,
  type NormalizedCall,
  type NormalizedSnapshot,
} from "../src/history.ts";
import {
  createHistoryMenuState,
  createHistoryTuiComponent,
  HISTORY_PANEL_HEIGHT,
  HISTORY_RANGES,
  HISTORY_TABS,
  renderUsageHistory,
  sanitizeArtifactLabel,
  showUsageHistory,
  updateHistoryMenuState,
} from "../src/history-menu.ts";
import type { UsageSnapshot } from "../src/types.ts";

const NOW = Date.UTC(2026, 8, 12, 12);
initTheme("dark", false);

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: regression assertions need visible text
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function call(
  key: string,
  ageHours: number,
  provider: string,
  model: string,
  values: Partial<NormalizedCall["usage"]> = {},
): NormalizedCall {
  return {
    key,
    provider,
    model,
    timestamp: NOW - ageHours * 60 * 60_000,
    timestampFidelity: "embedded",
    preciseTimestamp: true,
    conversationId: `conversation-${provider}-${model}`,
    source: { kind: "session", id: `source-${key}`, sessionId: `session-${key}` },
    lineageId: `lineage-${key}`,
    content: [],
    usage: {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      totalTokens: 180,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
      ...values,
    },
  };
}

function snapshot(
  observationId: string,
  providerId: string,
  providerName: string,
  identityId: string,
  capturedAt: number,
  used: number,
): NormalizedSnapshot {
  const value: UsageSnapshot = {
    version: 1,
    observationId,
    identity: { kind: "account", id: identityId },
    modelId: "model",
    report: {
      providerId,
      providerName,
      capturedAt,
      source: "test",
      semantics: { kind: "consumer-subscription", label: "Subscription" },
      buckets: [
        {
          id: "window",
          label: "Five-hour window",
          unit: "percent",
          used,
          remaining: 100 - used,
          limit: 100,
          windowMinutes: 300,
        },
      ],
      metrics: [],
    },
  };
  return { snapshot: value, source: { kind: "session", id: `snapshot-${observationId}` } };
}

function fixture(): LoadedHistory {
  const calls = [
    call("a1", 0.5, "provider-a", "model-one"),
    call("a2", 0.49, "provider-a", "model-one", {
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 115,
    }),
    call("b1", 20, "provider-b", "model-with-a-very-long-name"),
    call("old", 6 * 24, "provider-a", "old-model"),
  ];
  const first = calls[0];
  const second = calls[1];
  if (first && second) second.conversationId = first.conversationId;
  return {
    now: NOW,
    calls,
    snapshots: [
      snapshot("a-1", "provider-a", "Provider A", "identity-a", NOW - 60 * 60_000, 10),
      snapshot("a-2", "provider-a", "Provider A", "identity-a", NOW, 30),
      snapshot("a-3", "provider-a", "Provider A", "identity-b", NOW - 30 * 60_000, 15),
      snapshot("b-1", "provider-b", "Provider B", "identity-c", NOW - 21 * 60 * 60_000, 20),
      snapshot("b-2", "provider-b", "Provider B", "identity-c", NOW - 19 * 60 * 60_000, 40),
    ],
    warnings: [{ code: "malformed-jsonl", message: "One historical source was malformed" }],
    subagents: [{ id: "agent", timestamps: [NOW - 1000] }],
  };
}

function liveContext(): LiveQuotaContext {
  return {
    providerId: "provider-a",
    providerName: "Provider A (live)",
    identity: { kind: "account", id: "identity-a" },
    report: {
      providerId: "provider-a",
      providerName: "Provider A (live)",
      capturedAt: NOW,
      source: "live",
      semantics: { kind: "consumer-subscription", label: "Subscription" },
      buckets: [
        {
          id: "window",
          label: "Five-hour window",
          unit: "percent",
          used: 90,
          remaining: 10,
          limit: 100,
          windowMinutes: 300,
        },
        {
          id: "live-extra",
          label: "Live extra",
          unit: "percent",
          used: 45,
          remaining: 55,
          limit: 100,
        },
      ],
      metrics: [],
    },
  };
}

function text(state = createHistoryMenuState(), width = 120, height = 80): string {
  return renderUsageHistory(fixture(), state, width, height).lines.join("\n");
}

test("defaults to Models and the rolling 1d range without an update timestamp", () => {
  const state = createHistoryMenuState();
  const output = text(state);
  assert.equal(state.tab, "Models");
  assert.equal(state.range, "1d");
  assert.deepEqual(HISTORY_TABS, ["Models", "Cache", "Quotas"]);
  assert.match(output, /› Tabs\s+\[Models\]\s+Cache\s+Quotas/);
  assert.match(output, /Range\s+\[1d\]\s+2d\s+3d\s+5d\s+7d\s+14d\s+30d/);
  assert.doesNotMatch(output, /Overview/);
  assert.match(output.split("\n").at(-1) ?? "", /Esc back/);
  assert.doesNotMatch(output, /Updated|timestamp/i);
});

test("all tabs and ranges select through their documented keys", () => {
  const history = fixture();
  for (let index = 0; index < HISTORY_RANGES.length; index += 1) {
    const state = updateHistoryMenuState(
      history,
      createHistoryMenuState(),
      String(index + 1),
      100,
      30,
    );
    assert.equal(state.range, HISTORY_RANGES[index]?.label);
  }
  let state = createHistoryMenuState();
  for (const expected of HISTORY_TABS.slice(1)) {
    state = updateHistoryMenuState(history, state, "\x1b[C", 100, 30);
    assert.equal(state.tab, expected);
  }
  state = updateHistoryMenuState(history, state, "\t", 100, 30);
  assert.equal(state.tab, "Models");
  state = updateHistoryMenuState(history, state, "\x1b[Z", 100, 30);
  assert.equal(state.tab, "Quotas");
});

test("arrow navigation cycles only Tabs and Range", () => {
  const history = fixture();
  let state = createHistoryMenuState();
  state = updateHistoryMenuState(history, state, "\x1b[B", 100, 30);
  assert.equal(state.navigationRow, "Range");
  state = updateHistoryMenuState(history, state, "\x1b[C", 100, 30);
  assert.equal(state.range, "2d");
  state = updateHistoryMenuState(history, state, "\x1b[B", 100, 30);
  assert.equal(state.navigationRow, "Tabs");
  state = updateHistoryMenuState(history, state, "\x1b[D", 100, 30);
  assert.equal(state.tab, "Quotas");
  assert.equal("quotaProvider" in state, false);
  assert.equal("quotaProviderKey" in state, false);
});

test("inline component owns a fixed compact viewport independent of terminal height", () => {
  const history = fixture();
  for (let index = 0; index < 20; index += 1)
    history.calls.push(call(`extra-${index}`, 1, "provider", `model-${index}`));
  const component = createHistoryTuiComponent(
    { history, signal: new AbortController().signal },
    { fg: (_tone, value) => value, bold: (value) => value } as never,
    () => {},
    () => {},
  );
  component.handleInput?.("\x1b[C");
  component.handleInput?.("\x1b[B");

  const first = component.render(50);
  const second = component.render(50);
  assert.deepEqual(second, first);
  assert.ok(first.length <= HISTORY_PANEL_HEIGHT);
  assert.ok(first.length < 30);
  assert.match(first.at(-1) ?? "", /Esc back/);

  for (let index = 0; index < 500; index += 1) component.handleInput?.("\x1b[1;5B");
  const state = component.getState();
  const bottom = renderUsageHistory(history, state, 50, HISTORY_PANEL_HEIGHT, {
    padToHeight: false,
  });
  assert.equal(state.scrollOffset, bottom.maxScroll);
  assert.ok(component.render(50).length <= HISTORY_PANEL_HEIGHT);
});

test("short inline History panels do not pad to their logical viewport", () => {
  const history = fixture();
  history.calls = [];
  history.snapshots = [];
  history.warnings = [];
  history.subagents = [];
  const component = createHistoryTuiComponent(
    { history, signal: new AbortController().signal },
    { fg: (_tone, value) => value, bold: (value) => value } as never,
    () => {},
    () => {},
  );
  const rendered = component.render(60);
  const expected = renderUsageHistory(history, createHistoryMenuState(), 60, HISTORY_PANEL_HEIGHT, {
    padToHeight: false,
  }).lines;
  assert.deepEqual(rendered, expected);
  assert.ok(rendered.length <= HISTORY_PANEL_HEIGHT);
  assert.match(rendered.at(-1) ?? "", /Esc back/);
});

test("inline panels separate visible content from help without exceeding logical height", () => {
  const rendered = renderUsageHistory(
    fixture(),
    createHistoryMenuState(),
    60,
    HISTORY_PANEL_HEIGHT,
    { padToHeight: false },
  );
  const footer = rendered.lines.findIndex((line) => line.includes("↑↓ rows"));
  assert.ok(footer > 0);
  assert.equal(rendered.lines[footer - 1], "");
  assert.ok(rendered.lines.length <= HISTORY_PANEL_HEIGHT);
  assert.ok(rendered.viewportLines > 0);
});

test("24x5 keeps content and prioritizes the blank before footer help", () => {
  const rendered = renderUsageHistory(fixture(), createHistoryMenuState(), 24, 5);
  assert.deepEqual(rendered.lines, [
    "› Tabs Models",
    "  Range 1d",
    "provider-a/model-one",
    "",
    "↑↓ ←→ Ctrl+↑↓ Esc",
  ]);
  assert.equal(rendered.viewportLines, 1);
});

test("scrolling and state changes clamp the viewport", () => {
  const history = fixture();
  let state = { ...createHistoryMenuState(), tab: "Cache" as const };
  for (let index = 0; index < 50; index += 1) {
    state = updateHistoryMenuState(history, state, "\x1b[6~", 36, 8);
  }
  const bottom = renderUsageHistory(history, state, 36, 8);
  assert.equal(state.scrollOffset, bottom.maxScroll);
  state = updateHistoryMenuState(history, state, "1", 36, 8);
  assert.equal(state.scrollOffset, 0);
  state = { ...state, scrollOffset: 999 };
  state = updateHistoryMenuState(history, state, "x", 36, 8);
  assert.equal(state.scrollOffset, renderUsageHistory(history, state, 36, 8).maxScroll);
});

test("narrow Cache max-scroll ends on content before the footer separator", () => {
  const rendered = renderUsageHistory(
    fixture(),
    { ...createHistoryMenuState(), tab: "Cache", scrollOffset: 999 },
    36,
    8,
  );
  assert.equal(rendered.scrollOffset, rendered.maxScroll);
  assert.deepEqual(rendered.lines, [
    "› Tabs      Models   [Cache]",
    "            Quotas",
    "  Range     [1d]   2d   3d   5d   7d",
    "            14d   30d",
    "1h+   :    —  ",
    "",
    "↑↓ rows · ←→ change · Ctrl+↑↓ scroll",
    "Esc back",
  ]);
});

test("History formatting uses token millions, spaced thousands, exact money, and integer cache percentages", () => {
  const history = fixture();
  history.calls = [
    call("formatted", 1, "provider-a", "model-one", {
      input: 1_200_000,
      cacheRead: 2_040_500,
      cacheWrite: 0,
      output: 12_345,
      totalTokens: 3_252_845,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2.176 },
    }),
  ];
  const models = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Models" },
    80,
    100,
  ).lines.join("\n");
  assert.match(models, /Input: 1\.20 M/);
  assert.match(models, /Cache read: 2\.04 M/);
  assert.match(models, /Cache write: 0\.00 M/);
  assert.match(models, /Output: 0\.01 M/);
  assert.match(models, /Total tokens: 3\.25 M/);
  assert.match(models, /Recorded cost: \$2\.18/);

  const cache = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    100,
    100,
  ).lines.join("\n");
  assert.match(cache, /Cached input share: 63%/);
  assert.doesNotMatch(cache, /63\.\d+%/);

  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const bucket = view.quotas.providers[0]?.identities[0]?.buckets[0];
  assert.ok(bucket);
  bucket.latestPercentage = 39.4;
  bucket.observedPeak = 57.4;
  bucket.observedConsumption = 18.4;
  bucket.capacity = {
    observedConsumedPercent: 18.4,
    estimated100PercentTokens: 3_241_000,
    estimated100PercentCost: 2.176,
    lowerBound: false,
    warnings: [],
  };
  const quotas = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { view },
  ).lines.join("\n");
  assert.match(quotas, /18% consumed/);
  assert.doesNotMatch(quotas, /over 0 resets|(?:18|39|57)\.\d+%/);
  assert.match(quotas, /100% ≈ \$2\.18/);
  assert.doesNotMatch(quotas, /\$2\.18 cost/);
  assert.doesNotMatch(quotas, /3\.24 M tokens/);

  bucket.capacity.lowerBound = true;
  const lowerBound = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    120,
    100,
    { view },
  ).lines.join("\n");
  assert.match(lowerBound, /100% ≥ \$2\.18 \(lower bound\)/);
  assert.doesNotMatch(lowerBound, /3\.24 M tokens/);

  for (const unavailableCost of [Number.NaN, Number.MAX_SAFE_INTEGER]) {
    bucket.capacity.estimated100PercentCost = unavailableCost;
    const withoutCost = renderUsageHistory(
      history,
      { ...createHistoryMenuState(), tab: "Quotas" },
      120,
      100,
      { view },
    ).lines.join("\n");
    assert.match(withoutCost, /100% ≥ 3\.24 M tokens \(lower bound\)/);
    assert.doesNotMatch(withoutCost, /\$|— cost/);
  }
});

test("Quotas lead with historical consumption, use reset grammar, and show one capacity unit", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const bucket = view.quotas.providers[0]?.identities[0]?.buckets[0];
  assert.ok(bucket);
  bucket.observedConsumption = 188;
  bucket.observedResets = 1;
  bucket.capacity = {
    observedConsumedPercent: 188,
    estimated100PercentTokens: 17_910_000,
    lowerBound: false,
    warnings: [],
  };

  const output = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { view },
  ).lines.join("\n");
  assert.match(output, /Five-hour window: 188% consumed · over 1 reset · 100% ≈ 17\.91 M tokens/);
  assert.doesNotMatch(output, /latest|peak|Empirical estimates may include/);
});

test("Quotas compact names, aligned percentages, details, and indented warnings", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const firstProvider = view.quotas.providers[0];
  const secondProvider = view.quotas.providers[1];
  const firstIdentity = firstProvider?.identities[0];
  const secondIdentity = secondProvider?.identities[0];
  const firstBucket = firstIdentity?.buckets[0];
  const secondBucket = secondIdentity?.buckets[0];
  assert.ok(firstProvider && secondProvider && firstIdentity && secondIdentity);
  assert.ok(firstBucket && secondBucket);

  firstProvider.providerId = "openai-codex";
  firstProvider.providerName = "OpenAI Codex";
  firstBucket.latest = {
    ...firstBucket.latest,
    groupId: "codex",
    windowMinutes: 10_080,
  };
  firstBucket.observedConsumption = 58;
  firstBucket.observedResets = 1;
  firstBucket.capacity = {
    observedConsumedPercent: 58,
    estimated100PercentTokens: 1_000,
    estimated100PercentCost: 650.61,
    lowerBound: false,
    warnings: [],
  };
  firstBucket.capacityWarnings = ["late usage is missing from the capacity interval"];
  firstProvider.identities = [{ ...firstIdentity, buckets: [firstBucket] }];

  secondProvider.providerId = "opencode-go";
  secondProvider.providerName = "OpenCode Go";
  secondBucket.label = "Weekly";
  secondBucket.latest = { ...secondBucket.latest, label: "Weekly" };
  secondBucket.observedConsumption = 0;
  secondBucket.observedResets = 0;
  secondBucket.latestPercentage = 1;
  secondBucket.capacity = undefined;
  secondBucket.capacityWarnings = ["late usage is missing from the capacity interval"];
  secondProvider.identities = [{ ...secondIdentity, buckets: [secondBucket] }];
  view.quotas.providers = [firstProvider, secondProvider];

  const state = { ...createHistoryMenuState(), tab: "Quotas" as const };
  const normal = renderUsageHistory(history, state, 100, 100, {
    view,
    padToHeight: false,
  }).lines.join("\n");
  assert.match(
    normal,
    /OpenAI Codex\nWeekly: 58% consumed · over 1 reset · 100% ≈ \$650\.61\n {2}late usage is missing from the capacity interval\n\nOpenCode Go\nWeekly: {2}0% consumed\n {2}late usage is missing from the capacity interval/,
  );
  assert.doesNotMatch(normal, /⚠|over 0 resets/);

  firstBucket.observedConsumption = 100;
  const hundred = renderUsageHistory(history, state, 100, 100, {
    view,
    padToHeight: false,
  }).lines.join("\n");
  assert.match(hundred, /Weekly: 100% consumed/);
  assert.doesNotMatch(hundred, /Weekly: {2,}100%/);
  firstBucket.observedConsumption = 58;

  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const theme = new Theme(colors as never, colors as never, "truecolor");
  for (let width = 1; width <= 240; width += 1) {
    const options = { view, padToHeight: false };
    const plain = renderUsageHistory(history, state, width, 10_000, options).lines;
    const themed = renderUsageHistory(history, state, width, 10_000, { ...options, theme }).lines;
    assert.deepEqual(themed.map(stripAnsi), plain, `quota layout differs at width ${width}`);
    assert.ok(plain.every((line) => visibleWidth(line) <= width));
    assert.ok(plain.every((line) => !line.includes("\u001b")));
    assert.ok(themed.every((line) => visibleWidth(line) <= width));
    assert.equal(
      themed.some((line) => line.length > 0 && stripAnsi(line).length === 0),
      false,
      `theme-only quota row at width ${width}`,
    );
  }

  const narrow = renderUsageHistory(history, state, 24, 10_000, {
    view,
    padToHeight: false,
  }).lines.join("\n");
  const unwrappedNarrow = narrow.replaceAll("\n", " ");
  for (const fragment of [
    "58% consumed",
    "over 1 reset",
    "100% ≈ $650.61",
    "late usage is missing",
  ])
    assert.match(unwrappedNarrow, new RegExp(fragment.replace(/[.$]/g, "\\$&")));
  assert.ok(
    narrow
      .split("\n")
      .filter((line) => /late|usage|missing|capacity|interval/.test(line))
      .every((line) => line.startsWith("  ")),
  );

  const themedNormal = renderUsageHistory(history, state, 100, 100, {
    view,
    theme,
    padToHeight: false,
  }).lines;
  assert.ok(themedNormal.some((line) => line.includes(theme.fg("dim", "Weekly:"))));
  assert.ok(themedNormal.some((line) => line.includes("58% consumed")));
  assert.ok(
    themedNormal.some((line) =>
      line.includes(theme.fg("dim", "  late usage is missing from the capacity interval")),
    ),
  );
});

test("Quotas add selected-range model dollar averages without replacing aggregate capacity", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const provider = view.quotas.providers[0];
  const identity = provider?.identities[0];
  const bucket = identity?.buckets[0];
  assert.ok(provider && identity && bucket);
  provider.providerId = "openai-codex";
  provider.providerName = "OpenAI Codex";
  provider.identities = [identity];
  bucket.latest = { ...bucket.latest, groupId: "codex", windowMinutes: 10_080 };
  bucket.capacity = {
    observedConsumedPercent: 20,
    estimated100PercentTokens: 1_000,
    estimated100PercentCost: 200,
    lowerBound: false,
    warnings: [],
  };
  bucket.modelEstimates = [
    {
      model: "gpt-supported",
      recordedCost: 48,
      sampleCost: 12.6,
      observedConsumedPercent: 10.5,
      intervals: 4,
      estimated100PercentCost: 120,
    },
    {
      model: "gpt-insufficient",
      recordedCost: 3,
      sampleCost: 1,
      observedConsumedPercent: 0,
      intervals: 1,
    },
  ];

  const state = { ...createHistoryMenuState(), tab: "Quotas" as const };
  for (const range of ["1d", "7d"] as const) {
    const output = renderUsageHistory(history, { ...state, range }, 120, 100, {
      view,
      padToHeight: false,
    }).lines.join("\n");
    assert.match(output, /Weekly: 20% consumed · 100% ≈ \$200\.00/);
    assert.ok(output.includes(`Historical ${range} model averages · API-equivalent dollars`));
    assert.match(output, /gpt-supported: recorded \$48\.00 · weekly 100% ≈ \$120\.00/);
    assert.match(output, /sample \$12\.60 \/ 10\.5 pp · 4 intervals \(≤15m\)/);
    assert.match(output, /gpt-insufficient: recorded \$3\.00 · weekly 100% insufficient data/);
    assert.match(output, /sample \$1\.00 \/ 0 pp · 1 interval \(≤15m\)\n/);
    assert.equal(output.match(/Historical .* model averages/g)?.length, 1);
    assert.doesNotMatch(output, /weak evidence|identity-[abc]|lifetime|permanent/i);
  }
  for (const tab of ["Models", "Cache"] as const) {
    const output = renderUsageHistory(history, { ...state, tab }, 120, 100, { view }).lines.join(
      "\n",
    );
    assert.doesNotMatch(output, /model averages|API-equivalent|gpt-supported|insufficient data/);
  }

  for (const consumed of [1, 2, 3]) {
    bucket.modelEstimates[0].observedConsumedPercent = consumed;
    const output = renderUsageHistory(history, state, 120, 100, {
      view,
      padToHeight: false,
    }).lines.join("\n");
    assert.equal(output.includes("weekly 100% ≈ $120.00 · weak evidence"), consumed < 3);
    assert.doesNotMatch(output, /insufficient data · weak evidence/);
  }

  bucket.capacity = undefined;
  bucket.current = undefined;
  bucket.historicalBoundary = undefined;
  bucket.latest = { ...bucket.latest, used: 0, remaining: 100 };
  bucket.latestPercentage = 0;
  bucket.observedPeak = 0;
  bucket.observedConsumption = 0;
  bucket.observations = [];
  const zeroQuota = renderUsageHistory(history, state, 120, 100, { view }).lines.join("\n");
  assert.match(zeroQuota, /gpt-insufficient: recorded \$3\.00 · weekly 100% insufficient data/);
});

test("per-model quota rows sanitize model IDs and stay width-safe with real theme", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const provider = view.quotas.providers[0];
  const identity = provider?.identities[0];
  const bucket = identity?.buckets[0];
  assert.ok(provider && identity && bucket);
  provider.providerId = "openai";
  provider.identities = [identity];
  bucket.latest = { ...bucket.latest, groupId: "codex", windowMinutes: 10_080 };
  bucket.modelEstimates = [
    {
      model: `模型👩‍💻\x1b[31mRED\x1b[0m\x1b]8;;https://evil.invalid\x07LINK\x1b]8;;\x07\r\n\t${"x".repeat(200)}`,
      recordedCost: 10,
      sampleCost: 2,
      observedConsumedPercent: 0.5,
      intervals: 2,
      estimated100PercentCost: 400,
    },
    {
      model: "gpt-no-samples",
      recordedCost: 0,
      sampleCost: 0,
      observedConsumedPercent: 0,
      intervals: 0,
    },
  ];
  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const theme = new Theme(colors as never, colors as never, "truecolor");
  const state = { ...createHistoryMenuState(), tab: "Quotas" as const };
  for (const width of [1, 2, 3, 10, 24, 80, 120]) {
    const options = { view, padToHeight: false };
    const plain = renderUsageHistory(history, state, width, 10_000, options).lines;
    const themed = renderUsageHistory(history, state, width, 10_000, { ...options, theme }).lines;
    assert.deepEqual(themed.map(stripAnsi), plain, `model rows differ at width ${width}`);
    assert.ok(plain.every((line) => visibleWidth(line) <= width));
    assert.ok(themed.every((line) => visibleWidth(line) <= width));
    const output = plain.join("\n");
    for (const forbidden of ["\x1b", "https://evil", "\r", "\t"])
      assert.equal(output.includes(forbidden), false);
    assert.doesNotMatch(output, /x{100}|identity-[abc]/);
    if (width === 120) {
      assert.match(output, /weekly 100% ≈\s+\$400\.00/);
      assert.match(output, /sample \$2\.00 \/ 0\.5 pp · 2 intervals \(≤15m\)/);
      assert.match(output, /gpt-no-samples: recorded \$0\.00 · weekly 100% insufficient data/);
      assert.match(output, /sample \$0\.00 \/ 0 pp · 0 intervals \(≤15m\)/);
    }
  }
});

test("Quotas present every visible identity with anonymous account numbering", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const provider = view.quotas.providers[0];
  const secondBucket = provider?.identities[1]?.buckets[0];
  assert.ok(secondBucket);
  secondBucket.label = "Second account limit";
  secondBucket.latest = { ...secondBucket.latest, label: "Second account limit" };
  provider.identities[0] = {
    ...provider.identities[0],
    identity: { kind: "account", id: "private-hash-one" },
  };
  provider.identities[1] = {
    ...provider.identities[1],
    identity: { kind: "account", id: "private-hash-two" },
  };
  for (const [index, item] of history.snapshots.entries()) {
    item.snapshot.report.accountLabel = `Private Account Label ${index + 1}`;
  }

  const output = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { view },
  ).lines.join("\n");
  assert.match(output, /Provider A\nAccount 1\nFive-hour window/);
  assert.match(output, /Account 2\nSecond account limit/);
  assert.match(output, /Provider B\nFive-hour window/);
  assert.doesNotMatch(output, /private-hash|identity-[abc]|Private Account Label|Subscription/);
});

test("Cache cells preserve compact counts while dimming only count text", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const row = view.cache.rows[0];
  assert.ok(row);
  row.gaps["<1m"] = { samples: 17_652, percentage: 98 };
  row.gaps["1–5m"] = { samples: 1_000, percentage: 50 };
  row.gaps["5–10m"] = { samples: 2_000_000, percentage: undefined };

  const plain = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    140,
    100,
    { view },
  ).lines;
  const plainRow = plain.find((line) => line.includes("provider-a/model-one"));
  assert.ok(plainRow);
  assert.match(plainRow, / 98% 17\.7k/);
  assert.match(plainRow, / 50% 1k {3}/);
  assert.match(plainRow, / {3}— 2M {3}/);
  assert.equal(plainRow.includes("\x1b"), false);

  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const realTheme = new Theme(colors as never, colors as never, "truecolor");
  const themed = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    140,
    100,
    { view, theme: realTheme },
  ).lines;
  const themedRow = themed.find((line) => line.includes("provider-a/model-one"));
  assert.ok(themedRow);
  assert.equal(visibleWidth(themedRow), visibleWidth(plainRow));
  assert.ok(themedRow.includes(` 98% ${realTheme.fg("dim", "17.7k")}`));
  assert.ok(themed.every((line) => visibleWidth(line) <= 140));
});

test("plain Cache values align counts and percentages in wide and narrow layouts", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const row = view.cache.rows[0];
  assert.ok(row);
  row.gaps["<1m"] = { samples: 92, percentage: 0 };
  row.gaps["1–5m"] = { samples: 17_652, percentage: 98 };
  row.gaps["5–10m"] = { samples: 8, percentage: 100 };
  row.gaps["10–30m"] = { samples: 0, percentage: undefined };

  const wideExpected = ["    0% 92   ", "   98% 17.7k", "  100% 8    ", "     —      "];
  const narrowExpected = ["  0% 92   ", " 98% 17.7k", "100% 8    ", "   —      "];
  const wide = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    140,
    100,
    { view },
  ).lines;
  const wideHeader = wide.find((line) => line.startsWith("Provider/model"));
  const wideRow = wide.find((line) => line.includes("provider-a/model-one"));
  assert.ok(wideHeader && wideRow);
  for (const [index, value] of wideExpected.entries()) {
    const start = 37 + index * (value.length + 1);
    assert.equal(wideRow.slice(start, start + value.length), value);
    const bucket = CACHE_GAP_BUCKETS[index] as string;
    assert.equal(wideHeader.indexOf(bucket, start) + bucket.length, start + 6);
  }
  assert.ok(wide.every((line) => visibleWidth(line) <= 140));

  const narrow = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    80,
    100,
    { view },
  ).lines;
  for (const [bucket, value] of CACHE_GAP_BUCKETS.slice(0, 4).map((bucket, index) => [
    bucket,
    narrowExpected[index],
  ])) {
    assert.ok(narrow.includes(`${bucket.padEnd(6)}: ${value}`));
  }
  assert.ok(narrow.every((line) => visibleWidth(line) <= 80));

  const compact = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    16,
    100,
    { view },
  ).lines;
  assert.ok(compact.includes("<1m: 0% 92"));
  assert.ok(compact.includes("1–5m: 98% 17.7k"));
  assert.ok(compact.includes("10–30m: —"));
  assert.ok(compact.every((line) => visibleWidth(line) <= 16));
});

test("real-theme Cache values retain plain alignment with normal padding and percentages", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const row = view.cache.rows[0];
  assert.ok(row);
  row.gaps["<1m"] = { samples: 92, percentage: 0 };
  row.gaps["1–5m"] = { samples: 7, percentage: 98 };
  row.gaps["5–10m"] = { samples: 8, percentage: 100 };
  row.gaps["10–30m"] = { samples: 0, percentage: undefined };

  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const realTheme = new Theme(colors as never, colors as never, "truecolor");
  for (const width of [140, 80]) {
    const plain = renderUsageHistory(
      history,
      { ...createHistoryMenuState(), tab: "Cache" },
      width,
      100,
      { view },
    ).lines;
    const themed = renderUsageHistory(
      history,
      { ...createHistoryMenuState(), tab: "Cache" },
      width,
      100,
      { view, theme: realTheme },
    ).lines;
    assert.deepEqual(themed.map(stripAnsi), plain);
    assert.ok(themed.some((line) => line.includes(`  0% ${realTheme.fg("dim", "92")}`)));
    assert.ok(themed.some((line) => line.includes(` 98% ${realTheme.fg("dim", "7")} `)));
    assert.ok(themed.some((line) => line.includes(`100% ${realTheme.fg("dim", "8")} `)));
    const emptyLine = themed.find((line) => stripAnsi(line).includes("   —   "));
    assert.ok(emptyLine);
    assert.ok(emptyLine.includes("   —   "));
    assert.ok(themed.every((line) => visibleWidth(line) <= width));
  }
});

test("Cache narrow rows share label, count, and percentage columns at width 129", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const row = view.cache.rows[0];
  assert.ok(row);
  for (const [index, bucket] of CACHE_GAP_BUCKETS.entries()) {
    row.gaps[bucket] = {
      samples: index === 0 ? Number.MAX_SAFE_INTEGER : index + 1,
      percentage: (index + 1) * 11,
    };
  }

  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const realTheme = new Theme(colors as never, colors as never, "truecolor");
  const plain = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    129,
    100,
    { view },
  ).lines;
  const themed = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    129,
    100,
    { view, theme: realTheme },
  ).lines;

  assert.deepEqual(themed.map(stripAnsi), plain);
  assert.equal(
    plain.some((line) => line.startsWith("Provider/model")),
    false,
  );
  const bucketLines = plain.filter((line) =>
    CACHE_GAP_BUCKETS.some((bucket) => line.startsWith(bucket)),
  );
  assert.equal(bucketLines.length, CACHE_GAP_BUCKETS.length * view.cache.rows.length);
  const firstRowLines = bucketLines.slice(0, CACHE_GAP_BUCKETS.length);
  assert.deepEqual(
    firstRowLines.map((line) => line.indexOf(":")),
    [6, 6, 6, 6, 6, 6],
  );
  assert.deepEqual(
    firstRowLines.map((line) => line.indexOf("%")),
    [11, 11, 11, 11, 11, 11],
  );
  assert.deepEqual(
    firstRowLines.map((line) => line.slice(13).search(/\S/) + 13),
    [13, 13, 13, 13, 13, 13],
  );
  assert.ok(themed.some((line) => line.includes(realTheme.fg("dim", "9 007 199 254.7M"))));
  assert.ok(plain.every((line) => visibleWidth(line) <= 129));
  assert.ok(themed.every((line) => visibleWidth(line) <= 129));
});

test("Cache huge counts use narrow rows at width 130 without swapping bucket values", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const row = view.cache.rows[0];
  assert.ok(row);
  for (const [index, bucket] of CACHE_GAP_BUCKETS.entries()) {
    row.gaps[bucket] = {
      samples: index === 0 ? Number.MAX_SAFE_INTEGER : index + 1,
      percentage: (index + 1) * 11,
    };
  }

  const lines = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    130,
    100,
    { view },
  ).lines;
  assert.equal(
    lines.some((line) => line.startsWith("Provider/model")),
    false,
  );
  for (const [index, bucket] of CACHE_GAP_BUCKETS.entries()) {
    const count = index === 0 ? "9 007 199 254.7M" : String(index + 1);
    const percentage = `${(index + 1) * 11}%`.padStart(4);
    assert.ok(lines.includes(`${bucket.padEnd(6)}: ${percentage} ${count.padEnd(16)}`));
  }
  assert.ok(lines.every((line) => visibleWidth(line) <= 130));
});

test("Cache plain and themed rendering have exhaustive tiny-width parity", () => {
  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const realTheme = new Theme(colors as never, colors as never, "truecolor");

  for (const hugeCounts of [false, true]) {
    const history = fixture();
    const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
    for (const row of view.cache.rows) {
      for (const [index, bucket] of CACHE_GAP_BUCKETS.entries()) {
        row.gaps[bucket] = {
          samples:
            index === 3 ? 0 : hugeCounts && index === 0 ? Number.MAX_SAFE_INTEGER : index + 92,
          percentage: [0, 98, 100, undefined, 44, 5][index],
        };
      }
    }

    for (let width = 1; width <= 240; width += 1) {
      const options = { view, padToHeight: false };
      const plain = renderUsageHistory(
        history,
        { ...createHistoryMenuState(), tab: "Cache" },
        width,
        10_000,
        options,
      ).lines;
      const themed = renderUsageHistory(
        history,
        { ...createHistoryMenuState(), tab: "Cache" },
        width,
        10_000,
        { ...options, theme: realTheme },
      ).lines;

      assert.deepEqual(
        themed.map((line) => stripAnsi(line)),
        plain.map((line) => stripAnsi(line)),
        `${hugeCounts ? "huge" : "ordinary"} counts differ at width ${width}`,
      );
      assert.equal(
        themed.some((line) => line.length > 0 && stripAnsi(line).length === 0),
        false,
        `theme-only row at width ${width}`,
      );
      assert.ok(plain.every((line) => visibleWidth(line) <= width));
      assert.ok(themed.every((line) => visibleWidth(line) <= width));
    }
  }
});

test("Cache dynamic wide table is used at its exact measured boundary", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const row = view.cache.rows[0];
  assert.ok(row);
  row.gaps["<1m"] = { samples: 12_345_678_901, percentage: 42 };

  const exactWidth = 138;
  const exact = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    exactWidth,
    100,
    { view },
  ).lines;
  const header = exact.find((line) => line.startsWith("Provider/model"));
  const wideRow = exact.find((line) => line.startsWith("provider-a/model-one"));
  assert.ok(header && wideRow);
  assert.equal(visibleWidth(header), exactWidth);
  assert.equal(visibleWidth(wideRow), exactWidth);
  assert.match(wideRow, / 42% 12 345\.7M/);

  const below = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    exactWidth - 1,
    100,
    { view },
  ).lines;
  assert.equal(
    below.some((line) => line.startsWith("Provider/model")),
    false,
  );
  assert.ok(below.includes("<1m   :  42% 12 345.7M"));
  assert.ok(below.every((line) => visibleWidth(line) <= exactWidth - 1));
});

test("TUI caches one aggregation per range across render, tab, and scroll changes", () => {
  const history = fixture();
  let derivations = 0;
  const component = createHistoryTuiComponent(
    {
      history,
      signal: new AbortController().signal,
      deriveRange: (...args) => {
        derivations += 1;
        return deriveHistoryRange(...args);
      },
    },
    { fg: (_tone, value) => value, bold: (value) => value } as never,
    () => {},
    () => {},
    () => 20,
  );

  component.render(80);
  component.render(80);
  component.handleInput?.("\x1b[C");
  component.render(80);
  component.handleInput?.("\x1b[B");
  component.render(80);
  assert.equal(derivations, 1);

  component.handleInput?.("2");
  component.render(80);
  assert.equal(derivations, 2);
});

test("wide rows fit long ASCII and Unicode labels without losing numeric fields", () => {
  const history = fixture();
  history.calls = [
    call("long", 1, `provider-${"x".repeat(100)}`, `模型${"界".repeat(50)}`, {
      input: 1_200_000,
      cacheRead: 3_400_000,
      cacheWrite: 5_600_000,
      output: 7_800_000,
      totalTokens: 18_000_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.8765 },
    }),
  ];
  const models = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Models" },
    140,
    100,
  ).lines.join("\n");
  for (const value of ["1", "1.20 M", "3.40 M", "5.60 M", "7.80 M", "18.00 M", "$9.88"])
    assert.match(models, new RegExp(`(?:^|\\s)${value.replace("$", "\\$")}(?:\\s|$)`));

  const cache = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    140,
    100,
  ).lines.join("\n");
  for (const bucket of CACHE_GAP_BUCKETS)
    assert.match(cache, new RegExp(bucket.replace(/[+]/g, "\\+")));

  history.snapshots = [snapshot("wide-quota", "provider-a", "Provider A", "identity-a", NOW, 37)];
  const quotaBucket = history.snapshots[0]?.snapshot.report.buckets[0];
  assert.ok(quotaBucket);
  quotaBucket.label = `Quota ${"界".repeat(80)}`;
  const quotas = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    140,
    100,
  ).lines.join("\n");
  assert.match(quotas, /0% consumed/);
  assert.doesNotMatch(quotas, /over 0 resets/);
});

test("Cache always includes every bucket and sample count for every model", () => {
  const output = text({ ...createHistoryMenuState(), tab: "Cache" }, 48, 100);
  assert.match(output, /provider-a\/model-one/);
  for (const bucket of ["<1m", "1–5m", "5–10m", "10–30m", "30–60m", "1h+"]) {
    assert.match(output, new RegExp(bucket.replace(/[+]/g, "\\+")));
  }
  assert.match(output, /<1m {3}: \d+% 1/);
  assert.ok(output.includes("1–5m  :    —  "));
  assert.doesNotMatch(output, /— 0(?:\s|$)/);
});

test("source details stay hidden while concise warnings remain visible", () => {
  const output = text();
  assert.match(output, /Some historical records were malformed/);
  assert.doesNotMatch(output, /⚠/);
  assert.doesNotMatch(output, /source-|lineage-|observationId|capturedAt/);
});

test("warnings are sanitized and scoped to affected sections", () => {
  const history = fixture();
  history.warnings = [
    { code: "unreadable-source", message: "EACCES /home/private/session.jsonl" },
    { code: "malformed-snapshot", message: "bad quota at /home/private/session.jsonl:9" },
    { code: "imprecise-gap-timing", message: "raw timing diagnostic" },
  ];
  const models = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Models" },
    100,
    100,
  ).lines.join("\n");
  assert.match(models, /Some historical data could not be read/);
  assert.doesNotMatch(models, /quota observations|EACCES|\/home\/private|raw timing/i);

  const cache = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Cache" },
    100,
    100,
  ).lines.join("\n");
  assert.match(cache, /excluded from cache gaps/);
  assert.doesNotMatch(cache, /unreadable|quota observations|raw timing/i);

  const quotas = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
  ).lines.join("\n");
  assert.match(quotas, /Some quota observations were malformed/);
  assert.doesNotMatch(quotas, /unreadable|\/home\/private/i);
});

test("warnings and quota names are dim without changing text or layout", () => {
  const history = fixture();
  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const theme = new Theme(colors as never, colors as never, "truecolor");
  const state = createHistoryMenuState();
  const plain = renderUsageHistory(history, state, 100, 100).lines;
  const themed = renderUsageHistory(history, state, 100, 100, { theme }).lines;
  assert.deepEqual(themed.map(stripAnsi), plain);
  const warning = themed.find((line) =>
    stripAnsi(line).startsWith("Some historical records were malformed"),
  );
  assert.ok(warning);
  assert.ok(warning.includes(theme.fg("dim", "Some historical records were malformed")));

  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const bucket = view.quotas.providers[0]?.identities[0]?.buckets[0];
  assert.ok(bucket);
  bucket.capacityWarnings = ["late usage is missing from the capacity interval"];
  const quotaState = { ...state, tab: "Quotas" as const };
  const plainQuotas = renderUsageHistory(history, quotaState, 100, 100, { view }).lines;
  const themedQuotas = renderUsageHistory(history, quotaState, 100, 100, { view, theme }).lines;
  assert.deepEqual(themedQuotas.map(stripAnsi), plainQuotas);
  assert.ok(themedQuotas.some((line) => line.includes(theme.fg("dim", "Five-hour window:"))));
  assert.ok(
    themedQuotas.some((line) =>
      line.includes(theme.fg("dim", "  late usage is missing from the capacity interval")),
    ),
  );
  assert.ok(themedQuotas.every((line) => !stripAnsi(line).includes("⚠")));
  assert.ok(themedQuotas.every((line) => visibleWidth(line) <= 100));
});

test("live-only buckets show raw current percentage without historical fields", () => {
  const history = fixture();
  history.snapshots = [];
  const live: LiveQuotaContext = {
    providerId: "live-provider",
    providerName: "Live Provider",
    identity: { kind: "account", id: "live-account" },
    report: {
      providerId: "live-provider",
      providerName: "Live Provider",
      capturedAt: NOW,
      source: "live",
      semantics: { kind: "api-key", label: "API" },
      buckets: [
        {
          id: "window",
          label: "Current window",
          unit: "count",
          used: 40,
          remaining: 60,
          limit: 100,
        },
      ],
      metrics: [],
    },
  };
  const quotas = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { live },
  ).lines.join("\n");
  assert.match(quotas, /40% used/);
  assert.doesNotMatch(quotas, /raw state|latest|peak|consumed|resets|Empirical 100%/i);
});

test("artifact labels strip terminal controls and are length-bounded without changing grouping", () => {
  const history = fixture();
  const hostile = `before\x1b[31mRED\x1b[0m\x1b]8;;https://evil.invalid\x07LINK\x1b]8;;\x07\n\tend${"x".repeat(200)}`;
  history.calls = [call("hostile", 1, hostile, "model\rname")];
  history.snapshots = [snapshot("hostile", "quota-provider", hostile, "a".repeat(24), NOW, 10)];
  const hostileSnapshot = history.snapshots[0];
  const hostileBucket = hostileSnapshot?.snapshot.report.buckets[0];
  assert.ok(hostileSnapshot && hostileBucket);
  hostileSnapshot.snapshot.report.accountLabel = hostile;
  hostileBucket.label = hostile;

  assert.ok(sanitizeArtifactLabel(hostile).length <= 80);
  assert.equal(history.calls[0]?.provider, hostile);
  for (const tab of HISTORY_TABS) {
    const output = renderUsageHistory(
      history,
      { ...createHistoryMenuState(), tab },
      120,
      200,
    ).lines.join("\n");
    for (const forbidden of [String.fromCharCode(27), "https://evil", "\r", "\t"])
      assert.equal(output.includes(forbidden), false);
    assert.doesNotMatch(output, /x{100}/);
  }
});

test("Unicode wrapping retains every grapheme in unbroken multi-column routes", () => {
  const history = fixture();
  history.calls = [call("unicode", 1, "供給者", "模型👩‍💻終端")];
  const lines = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Models" },
    5,
    200,
  ).lines;
  assert.ok(lines.every((line) => visibleWidth(line) <= 5));
  assert.ok(lines.join("").includes("供給者/模型👩‍💻終端"));
});

test("narrow tall terminals wrap selector values without hiding the selection", () => {
  const lines = renderUsageHistory(fixture(), createHistoryMenuState(), 10, 80).lines;
  assert.ok(lines.every((line) => visibleWidth(line) <= 10));
  const output = lines.join("\n");
  assert.match(output, /\[1d\]/);
  assert.match(output, /\[Models\]/);
  assert.match(output, /Ctrl\+↑↓/);
  assert.equal(lines.find((line) => line.includes("[1d]"))?.startsWith("["), true);
  assert.equal(lines.find((line) => line.includes("[Models]"))?.startsWith("["), true);
});

test("real-theme ANSI selectors trim spacing before styling at width 10", () => {
  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const realTheme = new Theme(colors as never, colors as never, "truecolor");
  const lines = renderUsageHistory(fixture(), createHistoryMenuState(), 10, 80, {
    theme: realTheme,
  }).lines;
  assert.ok(lines.every((line) => visibleWidth(line) <= 10));
  assert.ok(lines.some((line) => line.includes("[Models]")));
});

test("tiny terminals stay height-bounded and retain selected controls and core actions", () => {
  for (const [width, height] of [
    [24, 8],
    [10, 5],
    [24, 3],
  ] as const) {
    const lines = renderUsageHistory(fixture(), createHistoryMenuState(), width, height).lines;
    assert.ok(lines.length <= height, `${width}x${height} rendered ${lines.length} lines`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const output = lines.join("\n");
    assert.match(output, /1d/);
    if (width >= 24) assert.match(output, /Models/);
    assert.match(output, /Esc/);
    assert.match(output, /←→/);
  }
});

test("tiny Quotas uses every spare footer row before dropping actionable keys", () => {
  const lines = renderUsageHistory(
    fixture(),
    { ...createHistoryMenuState(), tab: "Quotas" },
    10,
    5,
  ).lines;
  assert.equal(lines.length, 5);
  assert.ok(lines.every((line) => visibleWidth(line) <= 10));
  assert.match(lines.join("\n"), /↑↓ ←→ Esc\nCtrl\+↑↓/);
  assert.match(lines.join("\n"), /Provider A/);
});

test("widths 7–9 remove footer separators before dropping Quotas actions", () => {
  for (const width of [7, 8, 9]) {
    const lines = renderUsageHistory(
      fixture(),
      { ...createHistoryMenuState(), tab: "Quotas" },
      width,
      5,
    ).lines;
    assert.equal(lines.length, 5);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const footer = lines.slice(-2).join("");
    for (const key of ["Esc", "←→", "↑↓", "Ctrl+↑↓"])
      assert.match(footer, new RegExp(key.replace("+", "\\+")));
  }
});

test("boundary-only quota state is historical and retains capacity warnings", () => {
  const history = fixture();
  history.calls = [call("boundary-call", 23.52, "provider-a", "model-one")];
  history.snapshots = [
    snapshot(
      "boundary",
      "provider-a",
      "Provider A",
      "identity-a",
      NOW - 24 * 60 * 60_000 - 60_000,
      25,
    ),
  ];
  const output = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
  ).lines.join("\n");
  assert.match(output, /25% used/);
  assert.doesNotMatch(output, /raw state|now/);
  assert.match(output, / {2}quota samples do not cover both activity boundaries/);
  assert.doesNotMatch(output, /⚠/);
});

test("quota titles are deterministic, readable, unique, sanitized, and private", () => {
  const history = fixture();
  history.snapshots = history.snapshots.filter(
    (item) =>
      item.snapshot.report.providerId === "provider-a" &&
      item.snapshot.identity.id === "identity-a",
  );
  for (const item of history.snapshots) {
    const used = item.snapshot.report.buckets[0]?.used ?? 0;
    item.snapshot.report.buckets = [
      {
        id: "primary-a",
        label: "Primary",
        groupId: "secret-alpha-id",
        groupLabel: "Alpha\u001b]52;c;credential\u0007",
        unit: "percent",
        used,
      },
      {
        id: "primary-b",
        label: "Primary",
        groupId: "secret-beta-id",
        groupLabel: "Beta",
        unit: "percent",
        used: used + 1,
      },
      {
        id: "shared-a",
        label: "Shared",
        groupId: "secret-shared-a",
        groupLabel: "Shared",
        unit: "percent",
        used: used + 2,
      },
      {
        id: "shared-b",
        label: "Shared",
        groupId: "secret-shared-b",
        unit: "percent",
        used: used + 3,
      },
      { id: "shared-suffix", label: "Shared (2)", unit: "percent", used: used + 4 },
      { id: "solo", label: "Solo", unit: "percent", used: used + 5 },
    ];
  }
  const render = () =>
    renderUsageHistory(
      history,
      { ...createHistoryMenuState(), tab: "Quotas" },
      100,
      100,
    ).lines.join("\n");
  const first = render();
  assert.equal(render(), first);
  const lines = first.split("\n");
  for (const title of [
    "Alpha · Primary",
    "Beta · Primary",
    "Shared",
    "Shared (3)",
    "Shared (2)",
    "Solo",
  ]) {
    assert.equal(lines.filter((line) => line.startsWith(`${title}:`)).length, 1);
  }
  assert.doesNotMatch(first, /secret|credential|groupId/);
  assert.equal(first.includes("\u001b"), false);
});

test("Quotas hides zero-only OpenCode Go histories and their capacity warnings", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const template = view.quotas.providers[0]?.identities[0]?.buckets[0];
  assert.ok(template);
  const bucket = (
    id: string,
    label: string,
    options: { groupId?: string; used?: number; warning?: string; windowMinutes?: number } = {},
  ) => ({
    ...template,
    id,
    label,
    latest: {
      id,
      label,
      unit: "percent" as const,
      ...(options.groupId === undefined ? {} : { groupId: options.groupId }),
      ...(options.used === undefined ? {} : { used: options.used }),
      ...(options.windowMinutes === undefined ? {} : { windowMinutes: options.windowMinutes }),
      resetsAt: NOW / 1_000 + 3600,
    },
    observations:
      options.used === undefined
        ? []
        : [
            {
              capturedAt: NOW,
              raw: { id, label, unit: "percent" as const, used: options.used },
            },
          ],
    historicalBoundary: undefined,
    current: undefined,
    latestPercentage: undefined,
    observedPeak: undefined,
    observedConsumption: 0,
    observedResets: 0,
    capacity: undefined,
    capacityWarnings: options.warning ? [options.warning] : [],
  });
  const baseProvider = view.quotas.providers[0];
  const identity = baseProvider?.identities[0];
  assert.ok(baseProvider && identity);
  view.quotas.providers = [
    {
      ...baseProvider,
      providerId: "openai-codex",
      providerName: "Codex",
      identities: [
        {
          ...identity,
          buckets: [
            bucket("codex:primary", "Primary limit", {
              groupId: "codex",
              used: 10,
              windowMinutes: 10_080,
            }),
            bucket("codex:secondary", "Secondary", {
              groupId: "codex",
              warning: "empty warning",
            }),
            bucket("gpt-5.3-codex-spark:primary", "Spark", {
              groupId: "gpt-5.3-codex-spark",
              used: 10,
            }),
          ],
        },
        { ...identity, identity: { kind: "account", id: "empty" }, buckets: [] },
      ],
    },
    {
      ...baseProvider,
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      identities: [
        {
          ...identity,
          buckets: [
            bucket("primary", "Primary", { used: 35 }),
            {
              ...bucket("rolling", "Rolling", {
                warning: "late usage is missing from the capacity interval",
              }),
              latest: {
                id: "rolling",
                label: "Rolling",
                unit: "percent" as const,
                remaining: 100,
                limit: 100,
                resetsAt: NOW / 1_000 + 3600,
              },
              observations: [
                {
                  capturedAt: NOW - 60_000,
                  percentage: 0,
                  raw: {
                    id: "rolling",
                    label: "Rolling",
                    unit: "percent" as const,
                    used: 0,
                    remaining: 100,
                    limit: 100,
                  },
                },
                {
                  capturedAt: NOW,
                  percentage: 0,
                  raw: {
                    id: "rolling",
                    label: "Rolling",
                    unit: "percent" as const,
                    used: 0,
                    remaining: 100,
                    limit: 100,
                  },
                },
              ],
              latestPercentage: 0,
              observedPeak: 0,
            },
            {
              ...bucket("monthly", "Monthly", {
                warning: "late usage is missing from the capacity interval",
              }),
              latest: {
                id: "monthly",
                label: "Monthly",
                unit: "percent" as const,
                remaining: 100,
                limit: 100,
                resetsAt: NOW / 1_000 + 3600,
              },
              observations: [
                {
                  capturedAt: NOW,
                  percentage: 0,
                  raw: {
                    id: "monthly",
                    label: "Monthly",
                    unit: "percent" as const,
                    remaining: 100,
                    limit: 100,
                  },
                },
              ],
              current: {
                capturedAt: NOW,
                percentage: 0,
                raw: {
                  id: "monthly",
                  label: "Monthly",
                  unit: "percent" as const,
                  used: 0,
                  remaining: 100,
                  limit: 100,
                },
              },
              latestPercentage: 0,
              observedPeak: 0,
            },
          ],
        },
      ],
    },
    {
      ...baseProvider,
      providerId: "empty-provider",
      providerName: "Empty Provider",
      identities: [{ ...identity, buckets: [bucket("empty", "Empty")] }],
    },
  ];

  const codex = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { view },
  ).lines.join("\n");
  assert.match(codex, /Codex\nWeekly[\s\S]*used 10 percent/);
  assert.match(codex, /OpenCode Go\nPrimary[\s\S]*used 35 percent/);
  assert.doesNotMatch(
    codex,
    /Weekly limit|Secondary|Spark|empty warning|Rolling|Monthly|late usage is missing from the capacity interval|Empty Provider/,
  );
  assert.doesNotMatch(codex, /Quotas ·|\(1\/2\)|Providers/);
  assert.equal(view.quotas.providers.length, 3);
  assert.equal(view.quotas.providers[0]?.identities.length, 2);
  assert.equal(view.quotas.providers[1]?.identities[0]?.buckets.length, 3);
  const openaiProvider = view.quotas.providers[0];
  assert.ok(openaiProvider);
  openaiProvider.providerId = "openai";
  openaiProvider.providerName = "OpenAI";
  const openai = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { view },
  ).lines.join("\n");
  assert.match(openai, /OpenAI\nWeekly[\s\S]*used 10 percent/);
  assert.doesNotMatch(openai, /Spark|Secondary/);
});

test("legacy Codex bucket fallback accepts only an explicit codex bucket id", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const provider = view.quotas.providers[0];
  const identity = provider?.identities[0];
  const template = identity?.buckets[0];
  assert.ok(provider && identity && template);
  provider.providerId = "openai-codex";
  identity.buckets = [
    {
      ...template,
      id: "codex:primary",
      latest: { ...template.latest, id: "codex:primary", groupId: undefined },
    },
    {
      ...template,
      id: "spark:primary",
      label: "Spark",
      latest: { ...template.latest, id: "spark:primary", groupId: undefined },
    },
  ];
  const output = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { view },
  ).lines.join("\n");
  assert.match(output, /Five-hour window/);
  assert.doesNotMatch(output, /Spark/);
});

test("non-normalizable quota keeps useful raw values on one compact line", () => {
  const history = fixture();
  history.calls = [];
  const first = snapshot("raw-1", "provider-a", "Provider A", "identity-a", NOW - 60_000, 0);
  const second = snapshot("raw-2", "provider-a", "Provider A", "identity-a", NOW, 0);
  first.snapshot.report.buckets = [
    { id: "credits", label: "Credits", unit: "usd", used: 1_212, remaining: 8 },
  ];
  second.snapshot.report.buckets = [
    { id: "credits", label: "Credits", unit: "usd", used: 1_515, remaining: 5 },
  ];
  history.snapshots = [first, second];
  const live: LiveQuotaContext = {
    providerId: "provider-a",
    providerName: "Provider A",
    identity: { kind: "account", id: "identity-a" },
    report: {
      providerId: "provider-a",
      providerName: "Provider A",
      capturedAt: NOW,
      source: "live",
      semantics: { kind: "api-key", label: "API" },
      buckets: [{ id: "credits", label: "Credits", unit: "usd", used: 1_818, remaining: 2 }],
      metrics: [],
    },
  };
  const output = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    120,
    100,
    { live },
  ).lines.join("\n");
  assert.match(
    output,
    /Credits: current used \$1 818\.00, remaining \$2\.00 · latest used \$1 515\.00, remaining \$5\.00/,
  );
  assert.doesNotMatch(output, /raw state|latest: —|peak|consumption|reset| usd/i);
});

test("mixed normalized and raw quota history retains only unavailable raw records", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const bucket = view.quotas.providers[0]?.identities[0]?.buckets[0];
  assert.ok(bucket);
  const latest = bucket.observations.at(-1);
  assert.ok(latest);
  latest.percentage = undefined;
  latest.raw = { id: bucket.id, label: bucket.label, unit: "count", used: 333 };
  bucket.latest = latest.raw;
  bucket.latestPercentage = undefined;
  bucket.current = {
    capturedAt: NOW,
    raw: { id: bucket.id, label: bucket.label, unit: "usd", remaining: 1_818 },
  };
  bucket.historicalBoundary = {
    capturedAt: NOW - HISTORY_RANGES[0].durationMs,
    raw: { id: bucket.id, label: bucket.label, unit: "count", limit: 12_345.5 },
  };

  const output = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    160,
    100,
    { view },
  ).lines.join("\n");
  assert.ok((output.match(new RegExp(bucket.label, "g"))?.length ?? 0) >= 1);
  assert.match(output, /20% consumed/);
  assert.doesNotMatch(output, /over 0 resets/);
  assert.doesNotMatch(output, /— latest|peak/);
  assert.match(
    output,
    /current remaining \$1 818\.00 · latest used 333 count · boundary limit 12 345\.5 count/,
  );
  assert.doesNotMatch(output, /used 10 percent|remaining 90 percent/);
});

test("capacity-retained quotas omit unusable current, latest, and boundary raw states", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const provider = view.quotas.providers[0];
  const identity = provider?.identities[0];
  const bucket = identity?.buckets[0];
  assert.ok(provider && identity && bucket);
  const oversizedUsd = Number.MAX_SAFE_INTEGER / 100 + 1;
  bucket.label = "Capacity only";
  bucket.unit = "usd";
  bucket.latest = { id: bucket.id, label: bucket.label, unit: "usd" };
  bucket.observations = [
    {
      capturedAt: NOW,
      raw: { id: bucket.id, label: bucket.label, unit: "usd", remaining: oversizedUsd },
    },
  ];
  bucket.current = {
    capturedAt: NOW,
    raw: { id: bucket.id, label: bucket.label, unit: "usd", used: oversizedUsd },
  };
  bucket.historicalBoundary = {
    capturedAt: NOW - 1,
    raw: { id: bucket.id, label: bucket.label, unit: "usd", limit: oversizedUsd },
  };
  bucket.latestPercentage = undefined;
  bucket.observedPeak = undefined;
  bucket.observedConsumption = 0;
  bucket.observedResets = 0;
  bucket.capacity = {
    observedConsumedPercent: 1,
    estimated100PercentTokens: 1_000,
    lowerBound: false,
    warnings: [],
  };
  bucket.capacityWarnings = [];
  view.quotas.providers = [{ ...provider, identities: [{ ...identity, buckets: [bucket] }] }];

  const output = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    120,
    100,
    { view },
  ).lines.join("\n");
  assert.match(output, /Capacity only: 100% ≈ 1 000 tokens/);
  assert.doesNotMatch(output, /current|latest|boundary|no numeric|used —|remaining —|limit —/i);
});

test("mixed-unit current raw quota values use the current state's unit", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const provider = view.quotas.providers[0];
  const identity = provider?.identities[0];
  const bucket = identity?.buckets[0];
  assert.ok(provider && identity && bucket);
  bucket.label = "Mixed current";
  bucket.unit = "usd";
  bucket.latest = { id: bucket.id, label: bucket.label, unit: "usd" };
  bucket.observations = [];
  bucket.historicalBoundary = undefined;
  bucket.current = {
    capturedAt: NOW,
    raw: {
      id: bucket.id,
      label: bucket.label,
      unit: "count",
      used: Number.MAX_SAFE_INTEGER,
    },
  };
  bucket.latestPercentage = undefined;
  bucket.observedPeak = undefined;
  bucket.observedConsumption = 0;
  bucket.observedResets = 0;
  bucket.capacity = undefined;
  bucket.capacityWarnings = [];
  view.quotas.providers = [{ ...provider, identities: [{ ...identity, buckets: [bucket] }] }];

  const validCount = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    120,
    100,
    { view },
  ).lines.join("\n");
  assert.match(validCount, /Mixed current: current used 9 007 199 254 740 991 count/);

  bucket.unit = "count";
  bucket.latest = { id: bucket.id, label: bucket.label, unit: "count" };
  bucket.current.raw = {
    id: bucket.id,
    label: bucket.label,
    unit: "usd",
    used: Number.MAX_SAFE_INTEGER / 100 + 1,
  };
  const oversizedUsd = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    120,
    100,
    { view },
  ).lines.join("\n");
  assert.match(oversizedUsd, /No quota observations in range/);
  assert.doesNotMatch(oversizedUsd, /Mixed current|current used —/);
});

test("mixed-unit historical observations and boundaries use their own units", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const provider = view.quotas.providers[0];
  const identity = provider?.identities[0];
  const bucket = identity?.buckets[0];
  assert.ok(provider && identity && bucket);
  const rawCount = {
    id: bucket.id,
    label: "Mixed history",
    unit: "count" as const,
    used: Number.MAX_SAFE_INTEGER,
  };
  bucket.label = rawCount.label;
  bucket.unit = "usd";
  bucket.latest = { id: bucket.id, label: bucket.label, unit: "usd" };
  bucket.observations = [{ capturedAt: NOW, raw: rawCount }];
  bucket.historicalBoundary = { capturedAt: NOW - 1, raw: rawCount };
  bucket.current = undefined;
  bucket.latestPercentage = undefined;
  bucket.observedPeak = undefined;
  bucket.observedConsumption = 0;
  bucket.observedResets = 0;
  bucket.capacity = undefined;
  bucket.capacityWarnings = [];
  view.quotas.providers = [{ ...provider, identities: [{ ...identity, buckets: [bucket] }] }];

  const validCount = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    120,
    100,
    { view },
  ).lines.join("\n");
  assert.match(validCount, /latest used 9 007 199 254 740 991 count/);
  assert.match(validCount, /boundary used 9 007 199 254 740 991 count/);

  const oversizedUsd = {
    id: bucket.id,
    label: bucket.label,
    unit: "usd" as const,
    used: Number.MAX_SAFE_INTEGER / 100 + 1,
  };
  bucket.unit = "count";
  bucket.latest = { id: bucket.id, label: bucket.label, unit: "count" };
  bucket.observations = [{ capturedAt: NOW, raw: oversizedUsd }];
  bucket.historicalBoundary = { capturedAt: NOW - 1, raw: oversizedUsd };
  const hidden = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    120,
    100,
    { view },
  ).lines.join("\n");
  assert.match(hidden, /No quota observations in range/);
  assert.doesNotMatch(hidden, /Mixed history|used —/);
});

test("mixed-unit derived used validates limit and remaining with the raw state's unit", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const provider = view.quotas.providers[0];
  const identity = provider?.identities[0];
  const bucket = identity?.buckets[0];
  assert.ok(provider && identity && bucket);
  bucket.label = "Mixed derived";
  bucket.unit = "usd";
  bucket.latest = { id: bucket.id, label: bucket.label, unit: "usd" };
  bucket.observations = [];
  bucket.historicalBoundary = undefined;
  bucket.current = {
    capturedAt: NOW,
    raw: {
      id: bucket.id,
      label: bucket.label,
      unit: "count",
      remaining: Number.MAX_SAFE_INTEGER - 1,
      limit: Number.MAX_SAFE_INTEGER,
    },
  };
  bucket.latestPercentage = undefined;
  bucket.observedPeak = undefined;
  bucket.observedConsumption = 0;
  bucket.observedResets = 0;
  bucket.capacity = undefined;
  bucket.capacityWarnings = [];
  view.quotas.providers = [{ ...provider, identities: [{ ...identity, buckets: [bucket] }] }];

  const validCount = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    140,
    100,
    { view },
  ).lines.join("\n");
  assert.match(validCount, /Mixed derived/);
  assert.match(validCount, /remaining 9 007 199 254 740 990, limit 9 007 199 254 740 991 count/);

  bucket.unit = "count";
  bucket.latest = { id: bucket.id, label: bucket.label, unit: "count" };
  bucket.current.raw = {
    id: bucket.id,
    label: bucket.label,
    unit: "usd",
    remaining: 0,
    limit: Number.MAX_SAFE_INTEGER / 100 + 1,
  };
  const hidden = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    140,
    100,
    { view },
  ).lines.join("\n");
  assert.match(hidden, /No quota observations in range/);
  assert.doesNotMatch(hidden, /Mixed derived|limit —/);
});

test("oversized finite percentages do not create normalized quota shells or terms", () => {
  const history = fixture();
  const view = deriveHistoryRange(history, HISTORY_RANGES[0].durationMs);
  const provider = view.quotas.providers[0];
  const identity = provider?.identities[0];
  const bucket = identity?.buckets[0];
  assert.ok(provider && identity && bucket);
  const raw = { id: bucket.id, label: "Oversized", unit: "percent" as const };
  bucket.label = raw.label;
  bucket.latest = raw;
  bucket.observations = [{ capturedAt: NOW, raw, percentage: Number.MAX_VALUE }];
  bucket.current = { capturedAt: NOW, raw, percentage: Number.MAX_VALUE };
  bucket.historicalBoundary = { capturedAt: NOW - 1, raw, percentage: Number.MAX_VALUE };
  bucket.latestPercentage = Number.MAX_VALUE;
  bucket.observedPeak = Number.MAX_VALUE;
  bucket.observedConsumption = 0;
  bucket.observedResets = 0;
  bucket.capacity = undefined;
  bucket.capacityWarnings = [];
  view.quotas.providers = [{ ...provider, identities: [{ ...identity, buckets: [bucket] }] }];

  const hidden = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { view },
  ).lines.join("\n");
  assert.match(hidden, /No quota observations in range/);
  assert.doesNotMatch(hidden, /Oversized|— latest|— peak|0% used/);

  bucket.capacity = {
    observedConsumedPercent: 1,
    estimated100PercentTokens: 1_000,
    lowerBound: false,
    warnings: [],
  };
  const capacityOnly = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { view },
  ).lines.join("\n");
  assert.match(capacityOnly, /Oversized[\s\S]*100% ≈ 1 000 tokens/);
  assert.doesNotMatch(capacityOnly, /— latest|— peak|0% used/);

  const observation = bucket.observations[0];
  assert.ok(observation);
  observation.percentage = 0;
  bucket.current.percentage = 0;
  bucket.historicalBoundary.percentage = 0;
  bucket.latestPercentage = 0;
  bucket.observedPeak = 0;
  bucket.capacity = undefined;
  const zero = renderUsageHistory(
    history,
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { view },
  ).lines.join("\n");
  assert.match(zero, /No quota observations in range/);
  assert.doesNotMatch(zero, /Oversized|latest|peak|0%/);
});

test("overflowed totals and capacities render placeholders without numeric artifacts", () => {
  const history = fixture();
  history.calls = [
    call("huge-cost", 0.75, "provider-a", "model-one", {
      cost: {
        input: Number.MAX_VALUE,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: Number.MAX_VALUE,
      },
    }),
    call("tiny-movement", 0.25, "provider-a", "model-one", {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }),
  ];
  history.snapshots = [
    snapshot("tiny-start", "provider-a", "Provider A", "identity-a", NOW - 60 * 60_000, 0),
    snapshot("tiny-end", "provider-a", "Provider A", "identity-a", NOW, Number.MIN_VALUE),
  ];

  for (const tab of HISTORY_TABS) {
    const output = renderUsageHistory(
      history,
      { ...createHistoryMenuState(), tab },
      140,
      100,
    ).lines.join("\n");
    assert.doesNotMatch(output, /Infinity|NaN|\d(?:e[+-]?\d+)/i);
    if (tab === "Models") assert.match(output, /provider-a\/model-one[\s\S]*\s—(?:\n|$)/);
    if (tab === "Quotas") {
      assert.doesNotMatch(output, /100% [≈≥]|— tokens|Empirical 100%/);
    }
  }
});

test("stale live values and live-only buckets render separately from observed history", () => {
  const live = liveContext();
  const quotas = renderUsageHistory(
    fixture(),
    { ...createHistoryMenuState(), tab: "Quotas" },
    100,
    100,
    { live },
  ).lines.join("\n");
  assert.match(quotas, /20% consumed/);
  assert.doesNotMatch(quotas, /over 0 resets/);
  assert.match(quotas, /Live extra/);
  assert.match(quotas, /45% used/);
});

test("Ctrl+Up applies immediately after a resize clamps an old scroll offset", () => {
  const history = fixture();
  const state = { ...createHistoryMenuState(), tab: "Cache" as const, scrollOffset: 999 };
  const resized = renderUsageHistory(history, state, 36, 8);
  assert.ok(resized.maxScroll > 0);
  const next = updateHistoryMenuState(history, state, "\x1b[1;5A", 36, 8);
  assert.equal(next.scrollOffset, resized.maxScroll - 1);
});

test("wide, narrow, and ANSI-styled renderings retain data within visible width", () => {
  const history = fixture();
  const ansiTheme = {
    fg: (_color: string, value: string) => `\x1b[31m${value}\x1b[0m`,
    bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
  };
  for (const width of [24, 36, 80, 140]) {
    for (const tab of HISTORY_TABS) {
      const state = { ...createHistoryMenuState(), tab };
      const lines = renderUsageHistory(history, state, width, 200, {
        theme: ansiTheme as never,
      }).lines;
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `${tab} exceeded ${width}`,
      );
      const output = lines.join("\n");
      if (tab === "Models") assert.match(output, /model-one/);
      if (tab === "Cache") assert.match(output, /1h\+/);
      if (tab === "Quotas") assert.match(output, /consumed/);
      for (const key of ["↑↓ rows", "←→ change", "Ctrl+↑↓ scroll", "Esc back"]) {
        assert.match(output, new RegExp(key.replace("+", "\\+")));
      }
    }
  }
});

test("focused history leaves the host component tree untouched", async () => {
  const host = new TuiMainScreen({ columns: 50, rows: 16, hideCursor() {}, write() {} } as never);
  const transcript = new Text("transcript", 0, 0);
  host.addChild(transcript);
  const originalChildren = [...host.children];

  await showUsageHistory(
    {
      mode: "tui",
      ui: {
        custom: async (
          factory: (
            tui: TUI,
            theme: unknown,
            keys: unknown,
            done: () => void,
          ) => { handleInput?: (data: string) => void; dispose?: () => void },
        ) => {
          let closed = false;
          const component = factory(
            host,
            { fg: (_tone: string, value: string) => value, bold: (value: string) => value },
            {},
            () => {
              closed = true;
            },
          );
          assert.deepEqual(host.children, originalChildren);
          component.handleInput?.("\x1b");
          assert.equal(closed, true);
          component.dispose?.();
        },
      },
    } as never,
    { history: fixture(), signal: new AbortController().signal },
  );

  assert.deepEqual(host.children, originalChildren);
});

test("history cancellation closes normally and removes its abort listener", async () => {
  const cancelled = new AbortController();
  const host = new TuiMainScreen({ columns: 40, rows: 10, hideCursor() {}, write() {} } as never);
  host.addChild(new Text("underlying cancellation content", 0, 0));
  const originalChildren = [...host.children];

  await showUsageHistory(
    {
      mode: "tui",
      ui: {
        custom: (
          factory: (
            tui: TUI,
            theme: unknown,
            keys: unknown,
            done: () => void,
          ) => { dispose?: () => void },
        ) =>
          new Promise<void>((resolve) => {
            let component: { dispose?: () => void };
            component = factory(
              host,
              { fg: (_tone: string, value: string) => value, bold: (value: string) => value },
              {},
              () => {
                component.dispose?.();
                resolve();
              },
            );
            assert.equal(getEventListeners(cancelled.signal, "abort").length, 1);
            assert.deepEqual(host.children, originalChildren);
            cancelled.abort();
          }),
      },
    } as never,
    { history: fixture(), signal: cancelled.signal },
  );

  assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
  assert.deepEqual(host.children, originalChildren);
});

test("TUI history invokes an inline custom panel with no overlay options", async () => {
  const history = fixture();
  for (let index = 0; index < 20; index += 1)
    history.calls.push(call(`overlay-${index}`, 1, "provider", `model-${index}`));
  let customOptions: unknown = "not called";
  await showUsageHistory(
    {
      mode: "tui",
      ui: {
        custom: async (
          factory: (
            tui: unknown,
            theme: unknown,
            keys: unknown,
            done: () => void,
          ) => {
            render: (width: number) => string[];
            handleInput?: (data: string) => void;
          },
          options: unknown,
        ) => {
          customOptions = options;
          let closed = false;
          const mockTui = { requestRender() {} };
          const component = factory(
            mockTui,
            { fg: (_tone: string, value: string) => value, bold: (value: string) => value },
            {},
            () => {
              closed = true;
            },
          );
          component.handleInput?.("\x1b[C");
          const before = component.render(60);
          component.handleInput?.("\x1b[6~");
          const after = component.render(60);
          assert.ok(before.length <= HISTORY_PANEL_HEIGHT);
          assert.ok(after.length <= HISTORY_PANEL_HEIGHT);
          component.handleInput?.("\x1b");
          assert.equal(closed, true);
        },
      },
    } as never,
    { history, signal: new AbortController().signal },
  );
  assert.equal(customOptions, undefined);
});

test("Quotas shows all providers in TUI and non-TUI output without a provider selector", async () => {
  const history = fixture();
  history.calls = [];
  history.snapshots = [
    snapshot("long-a", "provider-a", `Provider A ${"a".repeat(60)}`, "identity-a", NOW, 10),
    snapshot("long-b", "provider-b", `Provider B ${"b".repeat(60)}`, "identity-b", NOW, 20),
    snapshot("long-c", "provider-c", `Provider C ${"c".repeat(60)}`, "identity-c", NOW, 30),
  ];
  history.warnings = [{ code: "malformed-snapshot", message: "malformed quota source details" }];
  const quotaState = { ...createHistoryMenuState(), tab: "Quotas" as const };
  const tui = renderUsageHistory(history, quotaState, 100, 200).lines.join("\n");
  for (const provider of ["Provider A", "Provider B", "Provider C"])
    assert.match(tui, new RegExp(provider));
  assert.doesNotMatch(tui, /^(?:›\s*)?Providers\b/m);

  const choices = ["Tab: Quotas", "Back"];
  const screens: string[] = [];
  const actionSets: string[][] = [];
  await showUsageHistory(
    {
      mode: "rpc",
      ui: {
        select: async (title: string, actions: string[]) => {
          screens.push(title);
          actionSets.push(actions);
          return choices.shift();
        },
      },
    } as never,
    { history, signal: new AbortController().signal },
  );

  const quotas = screens[1] ?? "";
  for (const provider of ["Provider A", "Provider B", "Provider C"])
    assert.match(quotas, new RegExp(provider));
  assert.match(quotas, /Five-hour window[\s\S]*0% consumed/);
  assert.match(quotas, /Some quota observations were malformed/);
  assert.doesNotMatch(quotas, /⚠/);
  assert.doesNotMatch(quotas, /^(?:›\s*)?(?:Tabs|Range|Providers|Quotas)\b/m);
  assert.doesNotMatch(quotas, /over 0 resets|↑↓|←→|Ctrl\+↑↓|Esc back/);
  assert.ok(quotas.split("\n").every((line) => visibleWidth(line) <= 100));
  assert.ok(
    actionSets.every((actions) =>
      actions.every((action) => !/^(?:Provider|Account):/.test(action)),
    ),
  );
});

test("narrow quota reports retain colliding sanitized provider headings safely", () => {
  const history = fixture();
  history.calls = [];
  history.snapshots = [
    snapshot("same-a", "provider-a", "Shared\nProvider", "identity-a", NOW, 10),
    snapshot("same-b", "provider-b", "Shared\tProvider", "identity-b", NOW, 20),
  ];
  history.warnings = [];
  const state = { ...createHistoryMenuState(), tab: "Quotas" as const };
  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const themes = [undefined, new Theme(colors as never, colors as never, "truecolor")];

  for (const theme of themes) {
    const width16 = renderUsageHistory(history, state, 16, 100, { theme }).lines;
    const width16Output = stripAnsi(width16.join("\n"));
    assert.ok(width16.every((line) => visibleWidth(line) <= 16));
    assert.equal(width16Output.match(/Shared/g)?.length, 2);
    assert.doesNotMatch(width16Output, /Providers|\[Shared/);

    const width2 = renderUsageHistory(history, state, 2, 100, { theme }).lines;
    assert.ok(width2.every((line) => visibleWidth(line) <= 2));
    assert.equal(stripAnsi(width2.join("\n")).match(/\[\]/g)?.length, 2);

    const width1 = renderUsageHistory(history, state, 1, 100, { theme }).lines;
    assert.ok(width1.every((line) => visibleWidth(line) <= 1));
    assert.equal(stripAnsi(width1.join("\n")).match(/\[/g)?.length, 2);
  }
});

test("plain tiny rendering stays ANSI-free", () => {
  for (const tab of HISTORY_TABS) {
    for (let width = 1; width <= 10; width += 1) {
      const lines = renderUsageHistory(
        fixture(),
        { ...createHistoryMenuState(), tab },
        width,
        100,
      ).lines;
      assert.ok(lines.every((line) => !line.includes("\u001b")));
    }
  }
});

test("tiny selectors remain width-safe with only two selected rows", () => {
  const colors = new Proxy<Record<string, string>>(
    { accent: "#88ccff", dim: "#777777" },
    { get: (target, key: string) => target[key] ?? "#ffffff" },
  );
  const themes = [undefined, new Theme(colors as never, colors as never, "truecolor")];

  for (const theme of themes) {
    for (const width of [1, 2, 3]) {
      const lines = renderUsageHistory(fixture(), createHistoryMenuState(), width, 100, { theme });
      const plain = lines.lines.map(stripAnsi);
      assert.ok(lines.lines.every((line) => visibleWidth(line) <= width));
      assert.equal(plain.filter((line) => line.startsWith("[")).length, 2);
    }
  }
});

test("non-TUI action loop changes tab and range before Back", async () => {
  const choices = ["Tab: Cache", "Range: 7d", "Back"];
  const screens: string[] = [];
  await showUsageHistory(
    {
      mode: "rpc",
      ui: {
        select: async (title: string) => {
          screens.push(title);
          return choices.shift();
        },
      },
    } as never,
    { history: fixture(), signal: new AbortController().signal },
  );
  assert.equal(screens.length, 3);
  assert.ok(screens.every((screen) => screen.split("\n").length < 100));
  assert.match(screens[0] ?? "", /^provider-a\/model-one/);
  assert.match(screens[1] ?? "", /^Cached input share/);
  assert.match(screens[2] ?? "", /old-model/);
  assert.doesNotMatch(screens.join("\n"), /^(?:Models|Cache|Quotas)$/m);
});
