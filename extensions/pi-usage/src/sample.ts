/**
 * A stand-in report for the display-options preview.
 *
 * The preview has to work when the provider is unsupported or the query failed
 * — which is exactly when someone might be adjusting settings — so it falls back
 * to this instead of showing nothing.
 */

import type { UsageReport } from "./types.ts";

const MINUTE_SECONDS = 60;

export function sampleUsageReport(now: number = Date.now()): UsageReport {
  const epoch = Math.floor(now / 1000);
  return {
    providerId: "openai-codex",
    providerName: "OpenAI Codex",
    capturedAt: now,
    source: "sample",
    semantics: { kind: "consumer-subscription", label: "ChatGPT subscription limits" },
    buckets: [
      {
        id: "codex:primary",
        label: "Primary limit",
        groupId: "codex",
        groupLabel: "Codex",
        used: 41,
        remaining: 59,
        limit: 100,
        unit: "percent",
        windowMinutes: 300,
        resetsAt: epoch + 192 * MINUTE_SECONDS,
      },
      {
        id: "codex:secondary",
        label: "Secondary limit",
        groupId: "codex",
        groupLabel: "Codex",
        used: 39,
        remaining: 61,
        limit: 100,
        unit: "percent",
        windowMinutes: 10_080,
        resetsAt: epoch + 6_120 * MINUTE_SECONDS,
      },
    ],
    metrics: [],
  };
}
