import assert from "node:assert/strict";
import test from "node:test";
import { presetConfig } from "../src/config.ts";
import { formatUsageReport, formatUsageStatusline } from "../src/format.ts";
import {
  enrichCodexResetCreditExpirations,
  normalizeCodexBackendPayload,
} from "../src/providers/codex.ts";
import { normalizeOpenCodeGoUsagePayload } from "../src/providers/opencode-go.ts";
import { normalizeOpenRouterKeyPayload } from "../src/providers/openrouter.ts";

test("OpenCode Go adapter normalizes all usage windows and reset times", () => {
  const capturedAt = Date.parse("2026-08-12T00:00:00Z");
  const report = normalizeOpenCodeGoUsagePayload(
    {
      usage: {
        rolling: { status: "ok", percent: 41, resetsAt: "2026-08-12T04:00:00Z" },
        weekly: { status: "ok", percent: 39, resetsAt: "2026-08-14T00:00:00+00:00" },
        monthly: { status: "ok", percent: 12.5, resetsAt: "2026-09-01T00:00:00Z" },
      },
    },
    capturedAt,
  );

  assert.equal(report.providerId, "opencode-go");
  assert.deepEqual(report.semantics, {
    kind: "api-key",
    label: "OpenCode Go usage windows",
  });
  assert.deepEqual(report.buckets[0], {
    id: "rolling",
    label: "Rolling",
    used: 41,
    remaining: 59,
    limit: 100,
    unit: "percent",
    resetsAt: Date.parse("2026-08-12T04:00:00Z") / 1_000,
  });
  assert.match(
    formatUsageReport(report, "current", presetConfig("full"), capturedAt),
    /Rolling limit:/,
  );
  assert.match(
    formatUsageStatusline(report, undefined, presetConfig("full"), capturedAt),
    /^opencode-go rolling \[███░░░░░\] 41% 4h · weekly/,
  );
});

test("OpenCode Go adapter rejects incomplete or invalid usage windows", () => {
  assert.throws(
    () =>
      normalizeOpenCodeGoUsagePayload(
        { usage: { rolling: { status: "ok", percent: 10, resetsAt: "2026-08-12T04:00:00Z" } } },
        0,
      ),
    /weekly usage window is missing/,
  );
  assert.throws(
    () =>
      normalizeOpenCodeGoUsagePayload(
        {
          usage: {
            rolling: { status: "ok", percent: 101, resetsAt: "2026-08-12T04:00:00Z" },
            weekly: { status: "ok", percent: 20, resetsAt: "2026-08-14T00:00:00Z" },
            monthly: { status: "ok", percent: 30, resetsAt: "2026-09-01T00:00:00Z" },
          },
        },
        0,
      ),
    /rolling usage percent/,
  );
  assert.throws(
    () =>
      normalizeOpenCodeGoUsagePayload(
        {
          usage: {
            rolling: { status: "ok", percent: 10, resetsAt: "2026-08-12" },
            weekly: { status: "ok", percent: 20, resetsAt: "2026-08-14T00:00:00Z" },
            monthly: { status: "ok", percent: 30, resetsAt: "2026-09-01T00:00:00Z" },
          },
        },
        0,
      ),
    /rolling reset time/,
  );
});

test("OpenRouter adapter normalizes documented per-key spend limits without claiming subscription quota", () => {
  const report = normalizeOpenRouterKeyPayload(
    {
      data: {
        label: "Production key",
        limit: 100,
        limit_remaining: 74.5,
        limit_reset: "monthly",
        usage: 25.5,
        usage_daily: 1.25,
        usage_weekly: 8,
        usage_monthly: 25.5,
        is_free_tier: false,
      },
    },
    1_000,
  );

  assert.equal(report.providerId, "openrouter");
  assert.deepEqual(report.semantics, { kind: "api-key", label: "API-key spend limits" });
  assert.equal(report.accountLabel, "Production key");
  assert.deepEqual(report.buckets[0], {
    id: "key-limit",
    label: "Key limit",
    used: 25.5,
    remaining: 74.5,
    limit: 100,
    unit: "usd",
    period: "monthly",
  });
  assert.deepEqual(
    report.metrics.map((metric) => [metric.id, metric.value]),
    [
      ["usage-daily", 1.25],
      ["usage-weekly", 8],
      ["usage-monthly", 25.5],
      ["usage-total", 25.5],
    ],
  );
  assert.match(formatUsageReport(report, "current"), /OpenRouter Usage · Current/);
  assert.match(formatUsageReport(report, "current"), /API-key spend limits/);
  assert.equal(formatUsageStatusline(report), "openrouter [██░░░░░░] $25.50 used");
  assert.equal(
    formatUsageStatusline(report, undefined, presetConfig("legacy")),
    "openrouter $74.50 left",
  );
});

test("OpenRouter adapter keeps unlimited keys meaningful and sanitizes account labels", () => {
  const report = normalizeOpenRouterKeyPayload(
    {
      data: {
        label: "main\u001b[31m\nkey",
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        usage: 12.75,
        usage_daily: 0,
        usage_weekly: 2,
        usage_monthly: 4,
        is_free_tier: true,
      },
    },
    2_000,
  );

  assert.equal(report.accountLabel, "main key");
  assert.deepEqual(report.buckets, []);
  assert.equal(formatUsageStatusline(report), "openrouter $12.75 used");
  assert.match(formatUsageReport(report, "configured"), /OpenRouter Usage · Configured/);
  assert.match(formatUsageReport(report, "configured"), /No per-key spend cap/);
});

test("OpenRouter adapter distinguishes unlimited keys from incomplete capped responses", () => {
  const unlimited = normalizeOpenRouterKeyPayload(
    {
      data: {
        label: "unlimited",
        limit: null,
        limit_remaining: null,
        usage: 5,
      },
    },
    2_500,
  );
  const unlimitedText = formatUsageReport(unlimited, "current");
  assert.equal(unlimitedText.match(/No per-key spend cap/g)?.length, 1);

  const incomplete = normalizeOpenRouterKeyPayload(
    {
      data: {
        label: "capped",
        limit: 100,
        limit_remaining: null,
        limit_reset: "monthly",
        usage: 5,
      },
    },
    2_750,
  );
  assert.equal(incomplete.buckets[0]?.limit, 100);
  assert.equal(incomplete.buckets[0]?.remaining, undefined);
  assert.match(formatUsageReport(incomplete, "current"), /used unavailable/i);
  assert.match(
    formatUsageReport(incomplete, "current", presetConfig("legacy")),
    /remaining unavailable/i,
  );
  assert.doesNotMatch(formatUsageReport(incomplete, "current"), /No per-key spend cap/);
});

test("OpenRouter adapter rejects malformed or empty documented responses", () => {
  assert.throws(() => normalizeOpenRouterKeyPayload({}, 0), /data/);
  assert.throws(
    () => normalizeOpenRouterKeyPayload({ data: { label: "empty" } }, 0),
    /no displayable usage data/,
  );
});

test("Codex adapter preserves credit availability without a numeric balance", () => {
  const report = normalizeCodexBackendPayload(
    {
      credits: { has_credits: true, unlimited: false },
    },
    2_900,
  );
  assert.deepEqual(report.metrics, [{ id: "credits", label: "Credits", value: "available" }]);
  assert.match(formatUsageReport(report, "current"), /Credits:\s+available/);
  assert.equal(formatUsageStatusline(report), "codex credits available");
});

test("Codex adapter preserves explicit credit unavailability without rate-limit windows", () => {
  const report = normalizeCodexBackendPayload({ credits: { has_credits: false } }, 2_950);
  assert.deepEqual(report.metrics, [{ id: "credits", label: "Credits", value: "none" }]);
  assert.match(formatUsageReport(report, "current"), /Credits:\s+none/);
  assert.equal(formatUsageStatusline(report), "codex no credits");
});

test("Codex reset-credit details normalize available expirations without retaining raw fields", () => {
  const primary = normalizeCodexBackendPayload(
    { rate_limit_reset_credits: { available_count: 6 } },
    3_000,
  );
  const expiresAt = "2027-07-17T12:34:56.789Z";
  const report = enrichCodexResetCreditExpirations(primary, {
    available_count: 6,
    credits: [
      {
        id: "credit-id",
        status: "available",
        expires_at: expiresAt,
        title: "private-title",
        description: "private-description",
        profile: { name: "private-profile" },
      },
      { status: "available", expires_at: null },
      { status: "available" },
      { status: "available", expires_at: "not-a-date" },
      { status: "available", expires_at: "2027-02-30T00:00:00Z" },
      { status: "redeemed", expires_at: "2026-01-01T00:00:00Z" },
      "malformed-row",
    ],
  });

  assert.deepEqual(report.metrics[0]?.resetExpirations, [
    { kind: "dated", expiresAt: Math.floor(Date.parse(expiresAt) / 1_000) },
    { kind: "never" },
    { kind: "unknown" },
    { kind: "unknown" },
    { kind: "unknown" },
    { kind: "unknown" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(report),
    /credit-id|private-title|private-description|private-profile/,
  );
});

test("Codex reset-credit detail counts supersede summaries and cap or pad rows", () => {
  const primary = normalizeCodexBackendPayload(
    { rate_limit_reset_credits: { available_count: 3 } },
    3_100,
  );
  const lower = enrichCodexResetCreditExpirations(primary, {
    available_count: 1,
    credits: [
      { status: "available", expires_at: null },
      { status: "available", expires_at: null },
    ],
  });
  assert.equal(lower.metrics[0]?.value, 1);
  assert.deepEqual(lower.metrics[0]?.resetExpirations, [{ kind: "never" }]);

  const higher = enrichCodexResetCreditExpirations(primary, {
    available_count: 4,
    credits: [{ status: "available", expires_at: null }],
  });
  assert.equal(higher.metrics[0]?.value, 4);
  assert.deepEqual(higher.metrics[0]?.resetExpirations, [
    { kind: "never" },
    { kind: "unknown" },
    { kind: "unknown" },
    { kind: "unknown" },
  ]);
});

test("Codex reset-credit detail falls back to the summary count when its count is invalid", () => {
  const primary = normalizeCodexBackendPayload(
    { rate_limit_reset_credits: { available_count: 2 } },
    3_200,
  );
  for (const available_count of [undefined, "invalid", -1, 1.5]) {
    const report = enrichCodexResetCreditExpirations(primary, {
      available_count,
      credits: [{ status: "available", expires_at: null }],
    });
    assert.equal(report.metrics[0]?.value, 2);
    assert.deepEqual(report.metrics[0]?.resetExpirations, [{ kind: "never" }, { kind: "unknown" }]);
  }
});

test("Codex reset-credit detail ignores counts too large to normalize safely", () => {
  const primary = normalizeCodexBackendPayload(
    { rate_limit_reset_credits: { available_count: 2 } },
    3_250,
  );
  const report = enrichCodexResetCreditExpirations(primary, {
    available_count: Number.MAX_SAFE_INTEGER,
    credits: [],
  });

  assert.equal(report, primary);
  assert.equal(report.metrics[0]?.value, 2);
  assert.equal(report.metrics[0]?.resetExpirations, undefined);
});

test("Codex reset-credit detail represents a newer zero count with an empty collection", () => {
  const primary = normalizeCodexBackendPayload(
    { rate_limit_reset_credits: { available_count: 2 } },
    3_300,
  );
  const report = enrichCodexResetCreditExpirations(primary, {
    available_count: 0,
    credits: [{ status: "available", expires_at: null }],
  });

  assert.equal(report.metrics[0]?.value, 0);
  assert.deepEqual(report.metrics[0]?.resetExpirations, []);
});

test("Codex adapter preserves windows, credits, and model-specific statusline buckets", () => {
  const report = normalizeCodexBackendPayload(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 60, limit_window_seconds: 18_000, reset_at: 100 },
        secondary_window: { used_percent: 80, limit_window_seconds: 604_800 },
      },
      credits: { has_credits: true, unlimited: false, balance: "12" },
      rate_limit_reset_credits: { available_count: 2 },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3 Codex Spark",
          metered_feature: "gpt-5.3-codex-spark",
          rate_limit: {
            primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
          },
        },
      ],
    },
    3_000,
  );

  assert.equal(report.providerId, "openai-codex");
  assert.deepEqual(report.semantics, {
    kind: "consumer-subscription",
    label: "ChatGPT subscription limits",
  });
  assert.equal(report.buckets.length, 3);
  assert.equal(report.metrics.find((metric) => metric.id === "reset-credits")?.value, 2);
  const usageReport = formatUsageReport(report, "current");
  assert.match(usageReport, /5h limit:/);
  assert.match(usageReport, /Weekly limit:/);
  assert.doesNotMatch(usageReport, /GPT-5\.3 Codex Spark/);
  const sparkModel = {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    provider: "openai-codex",
  };
  // No reset timestamp on this bucket, so there is no countdown to show.
  assert.equal(formatUsageStatusline(report, sparkModel), "codex spark [█░░░░░░░] 10%");
  assert.equal(
    formatUsageStatusline(report, sparkModel, presetConfig("legacy")),
    "codex spark 90% 5h",
  );
  const openaiReport = { ...report, providerId: "openai", providerName: "OpenAI" };
  assert.match(formatUsageReport(openaiReport, "current"), /OpenAI Usage · Current/);
  assert.doesNotMatch(formatUsageReport(openaiReport, "current"), /GPT-5\.3 Codex Spark/);
  assert.equal(
    formatUsageStatusline(openaiReport, { ...sparkModel, provider: "openai" }),
    "codex spark [█░░░░░░░] 10%",
  );
});
