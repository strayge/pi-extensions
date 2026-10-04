import { sanitizeDisplayText } from "../core.ts";
import type {
  CodexBackendPayload,
  CodexResetCreditsPayload,
  ResetCreditExpiration,
  UsageBucket,
  UsageMetric,
  UsageReport,
} from "../types.ts";

const MAX_NORMALIZED_RESET_CREDITS = 4_096;

/** Pi's current and legacy ChatGPT logins share the same quota endpoints. */
export function isCodexProvider(
  providerId: string | undefined,
): providerId is "openai" | "openai-codex" {
  return providerId === "openai" || providerId === "openai-codex";
}

export function normalizeCodexBackendPayload(
  payload: CodexBackendPayload,
  capturedAt: number,
): UsageReport {
  const buckets: UsageBucket[] = [];
  normalizeRateLimitGroup(buckets, "codex", "Codex", payload.rate_limit, false);

  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : [];
  for (const item of additional) {
    const value = asObject(item);
    const id = asString(value?.metered_feature) ?? asString(value?.limit_name);
    if (!value || !id) continue;
    try {
      normalizeRateLimitGroup(
        buckets,
        id,
        asString(value.limit_name) ?? id,
        value.rate_limit,
        true,
      );
    } catch {
      // Optional provider-specific buckets must not hide otherwise useful primary data.
    }
  }

  const metrics: UsageMetric[] = [];
  const credits = asObject(payload.credits);
  if (credits?.has_credits === true) {
    if (credits.unlimited === true) {
      metrics.push({ id: "credits", label: "Credits", value: "unlimited" });
    } else {
      const balance = asNumber(credits.balance);
      if (balance !== undefined) {
        metrics.push({ id: "credits", label: "Credits", value: balance, unit: "count" });
      } else {
        metrics.push({ id: "credits", label: "Credits", value: "available" });
      }
    }
  } else if (credits?.has_credits === false) {
    metrics.push({ id: "credits", label: "Credits", value: "none" });
  }
  const resetCredits = asObject(payload.rate_limit_reset_credits);
  const resetCount = asNonnegativeInteger(resetCredits?.available_count);
  if (resetCount !== undefined) {
    metrics.push({
      id: "reset-credits",
      label: "Usage limit resets",
      value: resetCount,
      unit: "count",
    });
  }
  if (buckets.length === 0 && metrics.length === 0) {
    throw new Error("Codex usage endpoint returned no displayable usage data.");
  }

  const planType = asString(payload.plan_type);
  return {
    providerId: "openai-codex",
    providerName: "OpenAI Codex",
    capturedAt,
    source: "codex-pi-auth",
    semantics: {
      kind: "consumer-subscription",
      label: "ChatGPT subscription limits",
    },
    buckets,
    metrics,
    ...(planType ? { notes: [`Plan: ${planType}`] } : {}),
  };
}

export function enrichCodexResetCreditExpirations(
  report: UsageReport,
  payload: CodexResetCreditsPayload,
): UsageReport {
  const metricIndex = report.metrics.findIndex((metric) => metric.id === "reset-credits");
  if (metricIndex < 0) return report;

  const metric = report.metrics[metricIndex];
  const summaryCount = asValidNonnegativeInteger(metric?.value);
  if (!metric || summaryCount === undefined) return report;

  const count = asValidNonnegativeInteger(payload.available_count) ?? summaryCount;
  // A 64 KiB response cannot carry this many minimally shaped credit rows, so
  // larger counts are not usable as detail enrichment.
  if (count > MAX_NORMALIZED_RESET_CREDITS) return report;

  const resetExpirations: ResetCreditExpiration[] = [];
  const rows = Array.isArray(payload.credits) ? payload.credits : [];
  for (const raw of rows) {
    if (resetExpirations.length >= count) break;
    const row = asObject(raw);
    if (row?.status !== "available") continue;
    resetExpirations.push(normalizeResetCreditExpiration(row.expires_at));
  }
  while (resetExpirations.length < count) resetExpirations.push({ kind: "unknown" });

  const metrics = [...report.metrics];
  metrics[metricIndex] = { ...metric, value: count, resetExpirations };
  return { ...report, metrics };
}

function normalizeResetCreditExpiration(value: unknown): ResetCreditExpiration {
  if (value === null) return { kind: "never" };
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    hasValidCalendarDate(value)
  ) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return { kind: "dated", expiresAt: Math.floor(parsed / 1000) };
  }
  return { kind: "unknown" };
}

function hasValidCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= daysInMonth;
}

function normalizeRateLimitGroup(
  buckets: UsageBucket[],
  groupId: string,
  groupLabel: string,
  raw: unknown,
  optional: boolean,
): void {
  if (raw === undefined || raw === null) return;
  const details = asObject(raw);
  if (!details) {
    if (optional) return;
    throw new Error("Codex rate limit was not an object.");
  }
  addWindow(buckets, groupId, groupLabel, "primary", details.primary_window);
  addWindow(buckets, groupId, groupLabel, "secondary", details.secondary_window);
}

function addWindow(
  buckets: UsageBucket[],
  groupId: string,
  groupLabel: string,
  position: "primary" | "secondary",
  raw: unknown,
): void {
  if (raw === undefined || raw === null) return;
  const value = asObject(raw);
  if (!value) throw new Error("Codex rate-limit window was not an object.");
  const used = asNumber(value.used_percent);
  if (used === undefined) return;
  const seconds = asNumber(value.limit_window_seconds);
  const resetsAt = asNumber(value.reset_at);
  buckets.push({
    id: `${groupId}:${position}`,
    label: position === "primary" ? "Primary limit" : "Secondary limit",
    groupId,
    groupLabel,
    modelKeys: [groupId, groupLabel],
    used,
    remaining: 100 - clampPercent(used),
    limit: 100,
    unit: "percent",
    ...(seconds !== undefined && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeDisplayText(value, 160) || undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asNonnegativeInteger(value: unknown): number | undefined {
  const parsed = asNumber(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed)) return undefined;
  return Math.max(0, parsed);
}

function asValidNonnegativeInteger(value: unknown): number | undefined {
  const parsed = asNumber(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
