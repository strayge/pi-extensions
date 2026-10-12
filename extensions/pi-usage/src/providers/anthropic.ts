import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageMetric, UsageReport } from "../types.ts";

export function normalizeAnthropicUsagePayload(payload: unknown, capturedAt: number): UsageReport {
  const data = asObject(payload);
  if (!data) throw new Error("Anthropic usage response was not an object.");

  const windows = new Map<string, UsageBucket>();
  for (const [field, id, label, windowMinutes] of [
    ["five_hour", "five_hour", "5h", 300],
    ["seven_day", "seven_day", "Weekly", 10080],
    ["seven_day_opus", "weekly:opus", "Weekly (Opus)", 10080],
    ["seven_day_sonnet", "weekly:sonnet", "Weekly (Sonnet)", 10080],
  ] as const) {
    const raw = data[field];
    if (raw == null) continue;
    windows.set(id, { ...normalizeWindow(raw, id, label), windowMinutes });
  }

  if (data.limits != null) {
    if (!Array.isArray(data.limits)) {
      throw new Error("Anthropic usage limits were not an array.");
    }
    for (const raw of data.limits) {
      const entry = asObject(raw);
      if (!entry) throw new Error("Anthropic usage limit was not an object.");
      switch (entry.kind) {
        case "session":
          windows.set("five_hour", normalizeWindow(entry, "five_hour", "Session"));
          break;
        case "weekly_all":
          windows.set("seven_day", {
            ...normalizeWindow(entry, "seven_day", "Weekly"),
            windowMinutes: 10080,
          });
          break;
        case "weekly_scoped": {
          const scope = asObject(entry.scope);
          const model = scopeName(scope?.model);
          const surfaceScope = asObject(scope?.surface);
          if (scope?.surface != null && !surfaceScope) {
            throw new Error("Anthropic usage surface scope was not an object.");
          }
          const surface = surfaceScope?.display_name == null ? undefined : scopeName(surfaceScope);
          const id = `weekly:${model.toLowerCase()}${surface ? `:${surface.toLowerCase()}` : ""}`;
          const label = `Weekly (${model}${surface ? ` · ${surface}` : ""})`;
          windows.set(id, { ...normalizeWindow(entry, id, label), windowMinutes: 10080 });
          break;
        }
      }
    }
  }

  const buckets = [...windows.values()].sort((left, right) => order(left.id) - order(right.id));
  const metrics: UsageMetric[] = [];
  if (data.extra_usage != null) {
    const extra = asObject(data.extra_usage);
    if (!extra) throw new Error("Anthropic extra usage was not an object.");
    if (extra.is_enabled != null && typeof extra.is_enabled !== "boolean") {
      throw new Error("Anthropic extra usage enabled flag was not a boolean.");
    }
    const used = optionalPercent(extra.utilization);
    if (typeof extra.is_enabled === "boolean") {
      metrics.push({
        id: "extra_usage",
        label: "Extra usage",
        value: extra.is_enabled ? "enabled" : "disabled",
      });
    }
    if (extra.is_enabled === true && used !== undefined) {
      buckets.push(percentBucket("extra_usage", "Extra usage", used));
    }
  }

  if (buckets.length === 0 && metrics.length === 0) {
    throw new Error("Anthropic usage response returned no displayable usage data.");
  }
  return {
    providerId: "anthropic",
    providerName: "Anthropic",
    capturedAt,
    source: "anthropic-oauth-usage",
    semantics: { kind: "consumer-subscription", label: "Claude subscription limits" },
    buckets,
    metrics,
  };
}

function normalizeWindow(raw: unknown, id: string, label: string): UsageBucket {
  const value = asObject(raw);
  if (!value) throw new Error("Anthropic usage window was not an object.");
  const utilization = optionalPercent(value.utilization);
  const percent = optionalPercent(value.percent);
  const used = utilization ?? percent;
  if (used === undefined) throw new Error("Anthropic usage window had no utilization percent.");
  const resetsAt = resetTime(value.resets_at);
  return {
    ...percentBucket(id, label, used),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function percentBucket(id: string, label: string, used: number): UsageBucket {
  return { id, label, used, remaining: 100 - used, limit: 100, unit: "percent" };
}

function optionalPercent(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("Anthropic usage percent must be a finite number between 0 and 100.");
  }
  return value;
}

function resetTime(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(
      value,
    )
  ) {
    throw new Error("Anthropic reset time must be an ISO date-time with an explicit timezone.");
  }
  const parsed = Date.parse(value);
  const calendarDate = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (
    !Number.isFinite(parsed) ||
    !Number.isFinite(calendarDate) ||
    new Date(calendarDate).toISOString().slice(0, 10) !== value.slice(0, 10)
  ) {
    throw new Error("Anthropic reset time was not a valid ISO date-time.");
  }
  return Math.floor(parsed / 1000);
}

function scopeName(raw: unknown): string {
  const value = asObject(raw)?.display_name;
  const name = typeof value === "string" ? sanitizeDisplayText(value, 80) : "";
  if (!name) throw new Error("Anthropic scoped usage requires a nonempty scope display name.");
  return name;
}

function order(id: string): number {
  return id === "five_hour" ? 0 : id === "seven_day" ? 1 : 2;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
