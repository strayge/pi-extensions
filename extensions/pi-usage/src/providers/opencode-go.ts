import type { UsageBucket, UsageReport } from "../types.ts";

const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const;
type OpenCodeGoWindowKey = (typeof WINDOW_KEYS)[number];

const WINDOW_LABELS: Record<OpenCodeGoWindowKey, string> = {
  rolling: "Rolling",
  weekly: "Weekly",
  monthly: "Monthly",
};

const OFFSET_ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Converts the provider's complete three-window response into the shared quota
 * shape. The endpoint is strict: a partial response is unsafe to display as a
 * complete account snapshot, so malformed windows are rejected together.
 */
export function normalizeOpenCodeGoUsagePayload(payload: unknown, capturedAt: number): UsageReport {
  const root = asObject(payload);
  const usage = asObject(root?.usage);
  if (!usage) throw new Error("OpenCode Go usage response did not contain an object of windows.");

  const buckets = WINDOW_KEYS.map((key) => normalizeWindow(key, usage[key]));
  return {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    capturedAt,
    source: "opencode-go-usage",
    semantics: { kind: "api-key", label: "OpenCode Go usage windows" },
    buckets,
    metrics: [],
  };
}

function normalizeWindow(key: OpenCodeGoWindowKey, value: unknown): UsageBucket {
  const window = asObject(value);
  if (window?.status !== "ok") {
    throw new Error(`OpenCode Go ${key} usage window is missing or not ok.`);
  }

  const percent = window.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`OpenCode Go ${key} usage percent must be a number from 0 to 100.`);
  }

  const resetsAt = window.resetsAt;
  if (typeof resetsAt !== "string" || !isValidOffsetIsoTimestamp(resetsAt)) {
    throw new Error(`OpenCode Go ${key} reset time must be an offset-qualified ISO timestamp.`);
  }
  const resetTime = Date.parse(resetsAt);
  if (!Number.isFinite(resetTime)) {
    throw new Error(`OpenCode Go ${key} reset time is invalid.`);
  }

  return {
    id: key,
    label: WINDOW_LABELS[key],
    used: percent,
    remaining: 100 - percent,
    limit: 100,
    unit: "percent",
    resetsAt: Math.floor(resetTime / 1_000),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isValidOffsetIsoTimestamp(value: string): boolean {
  const match = OFFSET_ISO_TIMESTAMP.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? undefined : Number(match[7]);
  const offsetMinute = match[8] === undefined ? undefined : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [0, 31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (offsetHour === undefined || offsetHour <= 23) &&
    (offsetMinute === undefined || offsetMinute <= 59)
  );
}
