import { defaultDisplayConfig } from "./config.ts";
import { formatDuration } from "./duration.ts";
import {
  bucketPercent,
  bucketPercentOfLimit,
  clampPercent,
  isAtRisk,
  minutesToExhaustion,
  minutesUntilReset,
  paceMarkerPosition,
  renderBar,
} from "./gauge.ts";
import type {
  ProviderUsageState,
  UsageBucket,
  UsageDisplayConfig,
  UsageDisplayState,
  UsageMetric,
  UsageModel,
  UsageReport,
  UsageStatuslineOptions,
  UsageSurfaceOptions,
} from "./types.ts";

const VALUE_COLUMN = 29;
const REPORT_SEPARATOR = " · ";
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatUsageReport(
  report: UsageReport,
  displayState: UsageDisplayState,
  config: UsageDisplayConfig = defaultDisplayConfig(),
  now: number = Date.now(),
): string {
  const stateLabel = displayState === "current" ? "Current" : "Configured";
  const lines = [`${report.providerName} Usage · ${stateLabel}`];
  if (report.accountLabel) lines.push(`Account: ${report.accountLabel}`);
  lines.push(`Semantics: ${report.semantics.label}`, "");

  if (report.providerId === "openai-codex") formatCodexReport(lines, report, config, now);
  else if (report.providerId === "openrouter") formatOpenRouterReport(lines, report, config);
  else if (report.providerId === "opencode-go") formatOpenCodeGoReport(lines, report, config, now);
  else formatGenericReport(lines, report, config);

  if (report.notes) {
    for (const note of report.notes) lines.push(note);
  }
  return lines.join("\n").trimEnd();
}

/**
 * A run of statusline text sharing one color, named from the statusline's
 * palette. Only the quota itself is ever tinted: a bar and a percentage say
 * nothing about urgency on their own.
 */
export interface UsageSegment {
  text: string;
  color?: "warning" | "error";
}

/**
 * The statusline value, split so a statusline that understands segments can
 * tint the quota without touching the rest.
 *
 * Joining the segments with nothing reproduces `formatUsageStatusline` exactly;
 * that function is defined that way, so the two cannot drift.
 */
export function formatUsageSegments(
  report: UsageReport,
  model?: UsageModel,
  config: UsageDisplayConfig = defaultDisplayConfig(),
  now: number = Date.now(),
): UsageSegment[] | undefined {
  if (report.providerId === "openai-codex") return codexSegments(report, config, now, model);
  if (report.providerId === "openrouter") return openRouterSegments(report, config, now);
  if (report.providerId === "opencode-go") return openCodeGoSegments(report, config, now);
  return undefined;
}

export function formatUsageStatusline(
  report: UsageReport,
  model?: UsageModel,
  config: UsageDisplayConfig = defaultDisplayConfig(),
  now: number = Date.now(),
): string | undefined {
  const segments = formatUsageSegments(report, model, config, now);
  if (!segments) return undefined;
  const text = segments.map((segment) => segment.text).join("");
  return text.length > 0 ? text : undefined;
}

/**
 * How close this window is to being spent, whichever way the user reads it.
 *
 * Always measured as consumption: `remaining` flips what the number says, not
 * whether running out is worth a warning.
 */
function bucketAlert(bucket: UsageBucket): UsageSegment["color"] {
  const share = bucketPercentOfLimit(bucket, "used");
  if (share === undefined) return undefined;
  if (share >= 90) return "error";
  if (share >= 70) return "warning";
  return undefined;
}

/** Interleave single spaces, the way the parts of a cell have always joined. */
function spaced(parts: UsageSegment[]): UsageSegment[] {
  return parts.flatMap((part, index) => (index === 0 ? [part] : [{ text: " " }, part]));
}

export function formatProviderState(
  state: ProviderUsageState,
  config: UsageDisplayConfig = defaultDisplayConfig(),
  now: number = Date.now(),
): string {
  if (state.status === "ready")
    return formatUsageReport(state.report, state.displayState, config, now);
  const status =
    state.status === "auth-unavailable"
      ? "Authentication unavailable"
      : state.status === "unsupported"
        ? "Unsupported"
        : "Query failed";
  return `${state.providerName}\n${status}: ${state.message}`;
}

function formatCodexReport(
  lines: string[],
  report: UsageReport,
  config: UsageDisplayConfig,
  now: number,
): void {
  let previousGroup: string | undefined;
  for (const bucket of report.buckets) {
    const group = bucket.groupId ?? bucket.id;
    if (group !== previousGroup && group !== "codex") {
      lines.push(`${bucket.groupLabel ?? group} limit:`);
    }
    previousGroup = group;
    const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
    const label = `${formatWindowLabel(bucket.windowMinutes, fallback, false)} limit:`;
    lines.push(`${label.padEnd(VALUE_COLUMN)}${formatReportCell(bucket, config, now)}`);
  }
  for (const metric of report.metrics) {
    if (metric.id === "reset-credits") {
      lines.push(
        `${"Usage limit resets:".padEnd(VALUE_COLUMN)}${formatResetCredits(metric, config, now)}`,
      );
    } else if (metric.id === "credits") {
      lines.push(
        `${"Credits:".padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
      );
    }
  }
}

function formatResetCredits(metric: UsageMetric, config: UsageDisplayConfig, now: number): string {
  const available = `${metric.value} available`;
  if (metric.value === 0 || metric.resetExpirations === undefined) return available;

  const dated = new Map<number, number>();
  let never = 0;
  let unknown = 0;
  for (const expiration of metric.resetExpirations) {
    if (expiration.kind === "dated") {
      dated.set(expiration.expiresAt, (dated.get(expiration.expiresAt) ?? 0) + 1);
    } else if (expiration.kind === "never") {
      never += 1;
    } else {
      unknown += 1;
    }
  }

  const groups = [...dated.entries()]
    .sort(([left], [right]) => left - right)
    .map(([expiresAt, count]) => {
      const date = formatExpirationDate(expiresAt, now);
      const remainingMinutes = (expiresAt * 1000 - now) / MINUTE_MS;
      const relative =
        remainingMinutes > 0
          ? `in ${formatDuration(remainingMinutes, config.spacedDuration)}`
          : "expired";
      return `${count} ${count === 1 ? "expires" : "expire"} ${date} (${relative})`;
    });
  if (never > 0) groups.push(`${never} never`);
  if (unknown > 0) groups.push(`${unknown} unknown`);

  return groups.length > 0 ? `${available}${REPORT_SEPARATOR}${groups.join(", ")}` : available;
}

const MINUTE_MS = 60_000;

function formatExpirationDate(expiresAt: number, now: number): string {
  const expiration = new Date(expiresAt * 1000);
  const current = new Date(now);
  const year = expiration.getFullYear();
  const suffix = year === current.getFullYear() ? "" : ` ${year}`;
  return `${expiration.getDate()} ${MONTH_LABELS[expiration.getMonth()]}${suffix}`;
}

function formatOpenRouterReport(
  lines: string[],
  report: UsageReport,
  config: UsageDisplayConfig,
): void {
  const limit = report.buckets.find((bucket) => bucket.id === "key-limit");
  if (limit) {
    const period = limit.period ? ` (${limit.period})` : "";
    const amount = bucketPercent(limit, config.value);
    const value =
      amount === undefined
        ? `${formatUsd(limit.limit ?? 0)} cap; ${config.value} unavailable`
        : `${formatUsd(amount)} of ${formatUsd(limit.limit ?? 0)} ${valueWord(config)}`;
    lines.push(`${`Key limit${period}:`.padEnd(VALUE_COLUMN)}${value}`);
  }
  for (const metric of report.metrics) {
    lines.push(
      `${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
    );
  }
}

function formatOpenCodeGoReport(
  lines: string[],
  report: UsageReport,
  config: UsageDisplayConfig,
  now: number,
): void {
  for (const bucket of report.buckets) {
    lines.push(
      `${`${bucket.label} limit:`.padEnd(VALUE_COLUMN)}${formatReportCell(bucket, config, now)}`,
    );
  }
}

function formatGenericReport(
  lines: string[],
  report: UsageReport,
  config: UsageDisplayConfig,
): void {
  for (const bucket of report.buckets) {
    lines.push(
      `${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(bucketPercent(bucket, config.value) ?? "unavailable", bucket.unit)}`,
    );
  }
  for (const metric of report.metrics) {
    lines.push(
      `${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
    );
  }
}

function codexSegments(
  report: UsageReport,
  config: UsageDisplayConfig,
  now: number,
  model?: UsageModel,
): UsageSegment[] | undefined {
  const group = selectCodexGroup(report, model);
  if (!group) return [{ text: formatCodexCreditsStatus(report) }];

  const buckets = report.buckets.filter((bucket) => (bucket.groupId ?? bucket.id) === group);
  const labelBucket = buckets[0];
  const prefix =
    group === "codex" ? "codex" : `codex ${compactLimitLabel(labelBucket?.groupLabel ?? group)}`;

  const cells = selectStatuslineBuckets(buckets, config.statusline, now)
    .map((bucket) => statuslineCellSegments(bucket, config, now))
    .filter((cell) => cell.length > 0);
  // Nothing rendered because every field is switched off is a display choice,
  // not missing data: hide the entry rather than claim usage is unavailable.
  if (cells.length === 0) return undefined;

  return cells.flatMap((cell, index) => [
    { text: index === 0 ? `${prefix} ` : config.statusline.separator },
    ...cell,
  ]);
}

/**
 * `auto` keeps the primary window and adds any other one on track to run out
 * before it resets — the line only widens when a second window needs watching.
 */
function selectStatuslineBuckets(
  buckets: UsageBucket[],
  options: UsageStatuslineOptions,
  now: number,
): UsageBucket[] {
  if (options.buckets === "all") return buckets;
  const primary = buckets[0];
  if (!primary) return [];
  if (options.buckets === "primary") return [primary];
  return [primary, ...buckets.slice(1).filter((bucket) => isAtRisk(bucket, now))];
}

function statuslineCellSegments(
  bucket: UsageBucket,
  config: UsageDisplayConfig,
  now: number,
  windowLabel?: string,
): UsageSegment[] {
  const alert = bucketAlert(bucket);
  const parts: UsageSegment[] = [];
  for (const field of config.statusline.fields) {
    switch (field) {
      case "window": {
        const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
        parts.push({
          text: windowLabel ?? formatWindowLabel(bucket.windowMinutes, fallback, true),
        });
        break;
      }
      case "bar": {
        const bar = renderBucketBar(bucket, config, config.statusline, now);
        if (bar) parts.push({ text: bar, color: alert });
        break;
      }
      case "percent": {
        const amount = formatBucketAmount(bucket, config);
        if (amount) parts.push({ text: amount, color: alert });
        break;
      }
      case "reset": {
        // No countdown when no window is running: a Codex 5h window that has
        // lapsed does not restart until the next message, so there is nothing
        // to count down to.
        const left = minutesUntilReset(bucket, now);
        if (left !== undefined) parts.push({ text: formatDuration(left, config.spacedDuration) });
        break;
      }
      case "projection": {
        const projection = formatProjection(bucket, config, now, false);
        if (projection) parts.push({ text: projection });
        break;
      }
    }
  }
  return spaced(parts);
}

/** Exported for the display-options preview, which renders a cell without its label column. */
export function formatReportCell(
  bucket: UsageBucket,
  config: UsageDisplayConfig,
  now: number,
): string {
  const head: string[] = [];
  const tail: string[] = [];
  for (const field of config.report.fields) {
    switch (field) {
      case "window":
        break;
      case "bar": {
        const bar = renderBucketBar(bucket, config, config.report, now);
        if (bar) head.push(bar);
        break;
      }
      case "percent": {
        const amount = formatBucketAmount(bucket, config);
        if (amount) head.push(`${amount} ${valueWord(config)}`);
        break;
      }
      case "reset": {
        const left = minutesUntilReset(bucket, now);
        if (left === undefined) {
          tail.push(bucket.resetsAt === undefined ? "" : "no active window");
          break;
        }
        tail.push(
          `resets ${formatReset(bucket.resetsAt ?? 0)} (in ${formatDuration(left, config.spacedDuration)})`,
        );
        break;
      }
      case "projection": {
        const projection = formatProjection(bucket, config, now, true);
        if (projection) tail.push(projection);
        break;
      }
    }
  }
  return [head.join(" "), ...tail].filter((part) => part.length > 0).join(REPORT_SEPARATOR);
}

function renderBucketBar(
  bucket: UsageBucket,
  config: UsageDisplayConfig,
  surface: UsageSurfaceOptions,
  now: number,
): string | undefined {
  const share = bucketPercentOfLimit(bucket, config.value);
  if (share === undefined) return undefined;
  const marker = surface.paceMarker ? paceMarkerPosition(bucket, config.value, now) : undefined;
  return renderBar(share, surface.barWidth, marker);
}

function formatBucketAmount(bucket: UsageBucket, config: UsageDisplayConfig): string | undefined {
  const amount = bucketPercent(bucket, config.value);
  if (amount === undefined) return undefined;
  if (bucket.unit === "usd") return formatUsd(amount);
  if (bucket.unit === "percent") return `${clampPercent(amount).toFixed(0)}%`;
  return String(amount);
}

function formatProjection(
  bucket: UsageBucket,
  config: UsageDisplayConfig,
  now: number,
  verbose: boolean,
): string | undefined {
  const left = minutesUntilReset(bucket, now);
  const toEmpty = minutesToExhaustion(bucket, now);
  // Silent when the quota outlasts the window: there is nothing to warn about.
  if (left === undefined || toEmpty === undefined || toEmpty >= left) return undefined;
  const duration = formatDuration(toEmpty, config.spacedDuration) || "<1m";
  return verbose ? `empty in ~${duration}` : `empty ${duration}`;
}

function openCodeGoSegments(
  report: UsageReport,
  config: UsageDisplayConfig,
  now: number,
): UsageSegment[] | undefined {
  const buckets = selectStatuslineBuckets(report.buckets, config.statusline, now);
  const cells = buckets
    .map((bucket) => statuslineCellSegments(bucket, config, now, bucket.label.toLowerCase()))
    .filter((cell) => cell.length > 0);
  if (cells.length === 0) return undefined;

  return cells.flatMap((cell, index) => [
    { text: index === 0 ? "opencode-go " : config.statusline.separator },
    ...cell,
  ]);
}

function openRouterSegments(
  report: UsageReport,
  config: UsageDisplayConfig,
  now: number,
): UsageSegment[] | undefined {
  const limit = report.buckets.find((bucket) => bucket.id === "key-limit");
  if (limit) {
    const amount = formatBucketAmount(limit, config);
    if (amount) {
      const alert = bucketAlert(limit);
      // Per-token billing has no window, so the time fields have nothing to add:
      // a spend cap can still fill a bar, but never carries a pace tick.
      const bar = config.statusline.fields.includes("bar")
        ? renderBucketBar(limit, config, config.statusline, now)
        : undefined;
      return spaced([
        { text: "openrouter" },
        ...(bar ? [{ text: bar, color: alert }] : []),
        { text: amount, color: alert },
        { text: valueWord(config) },
      ]);
    }
  }
  // Spend without a cap: the total is the only honest number available.
  const total = report.metrics.find((metric) => metric.id === "usage-total");
  if (typeof total?.value === "number") {
    return [{ text: `openrouter ${formatUsd(total.value)} used` }];
  }
  return undefined;
}

function formatCodexCreditsStatus(report: UsageReport): string {
  const credits = report.metrics.find((metric) => metric.id === "credits");
  if (!credits) return "codex usage unavailable";
  if (credits.value === "none") return "codex no credits";
  if (credits.value === "available") return "codex credits available";
  if (credits.value === "unlimited") return "codex credits unlimited";
  return `codex ${formatMetricValue(credits.value, "count")} credits`;
}

function valueWord(config: UsageDisplayConfig): string {
  return config.value === "used" ? "used" : "left";
}

function selectCodexGroup(report: UsageReport, model?: UsageModel): string | undefined {
  const groups = [...new Set(report.buckets.map((bucket) => bucket.groupId ?? bucket.id))];
  if (model?.provider !== "openai-codex") {
    return groups.includes("codex") ? "codex" : groups[0];
  }
  const modelKeys = normalizedModelKeys(model);
  for (const group of groups) {
    const bucket = report.buckets.find(
      (candidate) => (candidate.groupId ?? candidate.id) === group,
    );
    const keys = [group, bucket?.groupLabel, ...(bucket?.modelKeys ?? [])]
      .map(normalizeKey)
      .filter((key): key is string => key !== undefined);
    if (keys.some((key) => modelKeys.has(key))) return group;
  }
  const variants = [...modelKeys]
    .map((key) => key.match(/(?:^|-)codex-(.+)$/)?.[1])
    .filter((value): value is string => Boolean(value));
  for (const variant of variants) {
    const matches = groups.filter((group) => {
      if (group === "codex") return false;
      const key = normalizeKey(group);
      return key ? normalizedKeyHasToken(key, variant) : false;
    });
    if (matches.length === 1) return matches[0];
  }
  return groups.includes("codex") ? "codex" : groups[0];
}

function normalizedModelKeys(model: UsageModel): Set<string> {
  const keys = new Set<string>();
  for (const value of [model.id, model.name]) {
    const key = normalizeKey(value);
    if (!key) continue;
    keys.add(key);
    const index = key.indexOf("codex");
    if (index >= 0) keys.add(key.slice(index));
  }
  return keys;
}

function normalizeKey(value: string | undefined): string | undefined {
  const normalized = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function normalizedKeyHasToken(key: string, token: string): boolean {
  return (
    key === token ||
    key.startsWith(`${token}-`) ||
    key.endsWith(`-${token}`) ||
    key.includes(`-${token}-`)
  );
}

function compactLimitLabel(label: string): string {
  const normalized = label.replace(/[_-]+/g, " ").trim();
  return (normalized.match(/\bcodex\s+(.+)$/i)?.[1]?.trim() || normalized)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function formatWindowLabel(
  minutes: number | undefined,
  fallback: "5h" | "weekly",
  compact: boolean,
): string {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) {
    return compact && fallback === "weekly" ? "wk" : capitalize(fallback);
  }
  if (minutes === 10_080) return compact ? "wk" : "Weekly";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatMetricValue(value: number | string, unit: UsageMetric["unit"]): string {
  if (unit === "usd" && typeof value === "number") return formatUsd(value);
  return String(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatReset(epochSeconds: number): string {
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return "an unknown time";
  const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
  const now = new Date();
  if (reset.toDateString() === now.toDateString()) return time;
  return `${time} on ${reset.getDate()} ${reset.toLocaleDateString(undefined, { month: "short" })}`;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
