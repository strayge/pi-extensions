import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAnthropicUsagePayload } from "../src/providers/anthropic.ts";

const capturedAt = Date.parse("2026-08-12T00:00:00Z");

test("Anthropic flat windows retain their timing and structured windows replace matching IDs", () => {
  const report = normalizeAnthropicUsagePayload(
    {
      five_hour: { utilization: 12, resets_at: "2026-08-12T04:00:00Z" },
      seven_day: { utilization: 34, resets_at: "2026-08-14T02:00:00+02:00" },
      seven_day_opus: { utilization: 56 },
      seven_day_sonnet: { percent: 78 },
      limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Opus" } }, percent: 60 }],
    },
    capturedAt,
  );

  assert.equal(report.providerId, "anthropic");
  assert.equal(report.providerName, "Anthropic");
  assert.equal(report.source, "anthropic-oauth-usage");
  assert.equal(report.capturedAt, capturedAt);
  assert.deepEqual(report.semantics, {
    kind: "consumer-subscription",
    label: "Claude subscription limits",
  });
  assert.deepEqual(report.buckets, [
    {
      id: "five_hour",
      label: "5h",
      used: 12,
      remaining: 88,
      limit: 100,
      unit: "percent",
      windowMinutes: 300,
      resetsAt: Date.parse("2026-08-12T04:00:00Z") / 1000,
    },
    {
      id: "seven_day",
      label: "Weekly",
      used: 34,
      remaining: 66,
      limit: 100,
      unit: "percent",
      windowMinutes: 10080,
      resetsAt: Date.parse("2026-08-14T00:00:00Z") / 1000,
    },
    {
      id: "weekly:opus",
      label: "Weekly (Opus)",
      used: 60,
      remaining: 40,
      limit: 100,
      unit: "percent",
      windowMinutes: 10080,
    },
    {
      id: "weekly:sonnet",
      label: "Weekly (Sonnet)",
      used: 78,
      remaining: 22,
      limit: 100,
      unit: "percent",
      windowMinutes: 10080,
    },
  ]);
  assert.deepEqual(report.metrics, []);
});

test("Anthropic structured-only windows ignore unknown kinds and keep session first", () => {
  const payload = {
    five_hour: null,
    seven_day: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      { kind: "future-kind", percent: "private-invalid-value", resets_at: "not-a-date" },
      { kind: "weekly_scoped", scope: { model: { display_name: "Sonnet" } }, utilization: 25 },
      { kind: "weekly_all", percent: 50 },
      { kind: "session", utilization: 0, resets_at: null },
    ],
  };
  const report = normalizeAnthropicUsagePayload(payload, capturedAt);
  assert.deepEqual(
    report.buckets.map((bucket) => bucket.id),
    ["five_hour", "seven_day", "weekly:sonnet"],
  );
  assert.deepEqual(report.buckets[0], {
    id: "five_hour",
    label: "Session",
    used: 0,
    remaining: 100,
    limit: 100,
    unit: "percent",
  });
  assert.equal(report.buckets[1]?.windowMinutes, 10080);
  assert.equal(report.buckets[2]?.modelKeys, undefined);
  const replacement = normalizeAnthropicUsagePayload(
    {
      ...payload,
      five_hour: { utilization: 99, resets_at: "2026-08-12T04:00:00Z" },
      seven_day: { utilization: 99 },
    },
    capturedAt,
  );
  assert.deepEqual(replacement.buckets, report.buckets);
});

test("Anthropic accepts zero flat utilization, null optional fields and fractional reset seconds", () => {
  const report = normalizeAnthropicUsagePayload(
    {
      five_hour: { utilization: 0, percent: null, resets_at: null },
      seven_day: { utilization: null, percent: 100, resets_at: "2026-08-14T00:00:00.789Z" },
      limits: null,
      extra_usage: null,
    },
    capturedAt,
  );
  assert.equal(report.buckets[0]?.used, 0);
  assert.equal(report.buckets[0]?.remaining, 100);
  assert.equal(report.buckets[0]?.resetsAt, undefined);
  assert.equal(report.buckets[1]?.remaining, 0);
  assert.equal(report.buckets[1]?.resetsAt, Date.parse("2026-08-14T00:00:00Z") / 1000);
});

test("Anthropic sanitizes scoped names and keeps distinct surface limits separate", () => {
  const report = normalizeAnthropicUsagePayload(
    {
      limits: [
        {
          kind: "weekly_scoped",
          scope: {
            model: { display_name: "\u001b[31mOpus\u001b[0m" },
            surface: { display_name: "Claude\nCode\u0007" },
          },
          percent: 10,
        },
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Opus" }, surface: { display_name: "Web" } },
          percent: 20,
        },
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Opus" }, surface: { display_name: null } },
          percent: 30,
        },
      ],
    },
    capturedAt,
  );
  assert.deepEqual(
    report.buckets.map(({ id, label }) => ({ id, label })),
    [
      { id: "weekly:opus:claude code", label: "Weekly (Opus · Claude Code)" },
      { id: "weekly:opus:web", label: "Weekly (Opus · Web)" },
      { id: "weekly:opus", label: "Weekly (Opus)" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(report), /\\u001b|\\u0007/);
});

test("Anthropic extra usage reports enablement and percentages without financial assumptions", () => {
  const enabled = normalizeAnthropicUsagePayload(
    { extra_usage: { is_enabled: true, utilization: 0, used_credits: 25, monthly_limit: 100 } },
    capturedAt,
  );
  assert.deepEqual(enabled.metrics, [
    { id: "extra_usage", label: "Extra usage", value: "enabled" },
  ]);
  assert.deepEqual(enabled.buckets, [
    {
      id: "extra_usage",
      label: "Extra usage",
      used: 0,
      remaining: 100,
      limit: 100,
      unit: "percent",
    },
  ]);
  const disabled = normalizeAnthropicUsagePayload(
    { extra_usage: { is_enabled: false, utilization: 40, used_credits: 25, monthly_limit: 100 } },
    capturedAt,
  );
  assert.deepEqual(disabled.metrics, [
    { id: "extra_usage", label: "Extra usage", value: "disabled" },
  ]);
  assert.deepEqual(disabled.buckets, []);
  const noPercent = normalizeAnthropicUsagePayload(
    { extra_usage: { is_enabled: true, utilization: null } },
    capturedAt,
  );
  assert.deepEqual(noPercent.metrics, enabled.metrics);
  assert.deepEqual(noPercent.buckets, []);
});

test("Anthropic rejects fieldless and malformed recognized data without leaking server values", () => {
  const malformed: unknown[] = [
    null,
    [],
    "private-server-value",
    {},
    { error: { message: "private-server-value" } },
    { five_hour: null, limits: [{ kind: "unknown" }] },
    { extra_usage: { used_credits: 10, monthly_limit: 100 } },
    { five_hour: "private-server-value" },
    { five_hour: {} },
    { seven_day: { utilization: null } },
    { limits: {} },
    { limits: [null] },
    { limits: [{ kind: "session" }] },
    { limits: [{ kind: "weekly_all", percent: "private-server-value" }] },
    { extra_usage: [] },
    { extra_usage: { is_enabled: "private-server-value" } },
  ];
  for (const payload of malformed) {
    assert.throws(
      () => normalizeAnthropicUsagePayload(payload, capturedAt),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Anthropic /);
        assert.doesNotMatch(error.message, /private-server-value/);
        return true;
      },
    );
  }
});

test("Anthropic rejects invalid percentages even when another recognized value is valid", () => {
  for (const value of [-1, 101, NaN, Infinity, -Infinity, "20", true, {}, []]) {
    for (const payload of [
      { five_hour: { utilization: value } },
      { seven_day: { utilization: 10, percent: value } },
      { extra_usage: { is_enabled: true, utilization: value } },
      { extra_usage: { is_enabled: false, utilization: value } },
    ]) {
      assert.throws(() => normalizeAnthropicUsagePayload(payload, capturedAt), /usage percent/);
    }
  }
});

test("Anthropic rejects invalid timestamps and timestamps without an explicit timezone", () => {
  for (const resets_at of [
    "private-server-value",
    "2026-08-12",
    "2026-08-12T04:00:00",
    "2026-08-12 04:00:00Z",
    "2026-02-30T04:00:00Z",
    "2026-13-12T04:00:00Z",
    "2026-08-12T25:00:00Z",
    "2026-08-12T04:00:00+02:60",
    123,
  ]) {
    assert.throws(
      () =>
        normalizeAnthropicUsagePayload({ five_hour: { utilization: 0, resets_at } }, capturedAt),
      /Anthropic reset time/,
    );
  }
});

test("Anthropic rejects missing, malformed and sanitized-empty known scopes", () => {
  for (const scope of [
    undefined,
    null,
    {},
    { model: "private-server-value" },
    { model: {} },
    { model: { display_name: 5 } },
    { model: { display_name: "\u001b[31m\n\u0007" } },
    { model: { display_name: "Opus" }, surface: "private-server-value" },
    { model: { display_name: "Opus" }, surface: { display_name: 5 } },
    { model: { display_name: "Opus" }, surface: { display_name: "\t" } },
  ]) {
    assert.throws(
      () =>
        normalizeAnthropicUsagePayload(
          { limits: [{ kind: "weekly_scoped", scope, percent: 10 }] },
          capturedAt,
        ),
      /Anthropic .*scope/,
    );
  }
});
