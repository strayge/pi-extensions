import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "./core.ts";
import { formatWindowLabel } from "./format.ts";
import {
  CACHE_GAP_BUCKETS,
  deriveHistoryRange,
  type HistoryRangeView,
  type LiveQuotaContext,
  type LoadedHistory,
  type QuotaBucketHistory,
  type QuotaProviderHistory,
} from "./history.ts";

export const HISTORY_TABS = ["Models", "Cache", "Quotas"] as const;
export const HISTORY_RANGES = [
  { label: "1d", durationMs: 24 * 60 * 60_000 },
  { label: "2d", durationMs: 2 * 24 * 60 * 60_000 },
  { label: "3d", durationMs: 3 * 24 * 60 * 60_000 },
  { label: "5d", durationMs: 5 * 24 * 60 * 60_000 },
  { label: "7d", durationMs: 7 * 24 * 60 * 60_000 },
  { label: "14d", durationMs: 14 * 24 * 60 * 60_000 },
  { label: "30d", durationMs: 30 * 24 * 60 * 60_000 },
] as const;

export type HistoryTab = (typeof HISTORY_TABS)[number];
export type HistoryRangeLabel = (typeof HISTORY_RANGES)[number]["label"];

export type HistoryNavigationRow = "Tabs" | "Range";

export interface HistoryMenuState {
  tab: HistoryTab;
  range: HistoryRangeLabel;
  navigationRow: HistoryNavigationRow;
  scrollOffset: number;
}

export interface HistoryRenderResult {
  lines: string[];
  contentLines: number;
  viewportLines: number;
  maxScroll: number;
  scrollOffset: number;
}

export interface ShowUsageHistoryOptions {
  history: LoadedHistory;
  live?: LiveQuotaContext;
  signal: AbortSignal;
  /** Test seam for proving range aggregation is not repeated during navigation. */
  deriveRange?: typeof deriveHistoryRange;
}

type HistoryTheme = Pick<Theme, "fg" | "bold">;
type Tone = "plain" | "accent" | "dim";
type Part = { text: string; tone?: Tone };

const MAX_ARTIFACT_LABEL_LENGTH = 80;
export const HISTORY_PANEL_HEIGHT = 17;

/** Bound untrusted artifact labels before adding terminal styling. */
export function sanitizeArtifactLabel(value: string): string {
  return sanitizeDisplayText(value, MAX_ARTIFACT_LABEL_LENGTH) || "—";
}

export function createHistoryMenuState(): HistoryMenuState {
  return {
    tab: "Models",
    range: "1d",
    navigationRow: "Tabs",
    scrollOffset: 0,
  };
}

function rangeDefinition(label: HistoryRangeLabel) {
  return HISTORY_RANGES.find((range) => range.label === label) ?? HISTORY_RANGES[0];
}

function styled(parts: Part[], theme?: HistoryTheme): string {
  if (!theme) return parts.map((part) => part.text).join("");
  return parts
    .map((part) => {
      if (part.tone === "accent") return theme.fg("accent", theme.bold(part.text));
      if (part.tone === "dim") return theme.fg("dim", part.text);
      return part.text;
    })
    .join("");
}

function safe(line: string, width: number): string {
  const bounded = Math.max(1, width);
  const firstCut = truncateToWidth(line, bounded);
  const cut = visibleWidth(firstCut) <= bounded ? firstCut : truncateToWidth(firstCut, bounded, "");
  return line.includes("\u001b") ? cut : cut.replaceAll("\u001b[0m", "");
}

function column(value: string, width: number): string {
  const fitted = sanitizeDisplayText(
    truncateToWidth(sanitizeArtifactLabel(value), width, ""),
    MAX_ARTIFACT_LABEL_LENGTH,
  );
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function wrapText(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width));
}

function selectorLines(
  label: HistoryNavigationRow,
  values: readonly string[],
  selectedIndex: number,
  active: boolean,
  width: number,
  theme?: HistoryTheme,
): string[] {
  const tiny = width <= 3;
  const marker = active ? (tiny ? "> " : "› ") : "  ";
  const labelColumn = `${label}${" ".repeat(Math.max(1, 10 - label.length))}`;
  const indent = " ".repeat(marker.length + visibleWidth(labelColumn));
  const lines: Part[][] = [
    [
      { text: marker, tone: active ? "accent" : "plain" },
      { text: labelColumn, tone: active ? "accent" : "dim" },
    ],
  ];
  const selectedText = (value: string, availableWidth: number): string => {
    if (availableWidth <= 0) return "";
    if (availableWidth === 1) return "[";
    return `[${truncateToWidth(value, availableWidth - 2).replaceAll("\u001b[0m", "")}]`;
  };
  let valuesOnLine = 0;
  for (const [index, value] of values.entries()) {
    const selected = index === selectedIndex;
    const fullText = selected ? `[${value}]` : value;
    const current = lines.at(-1) as Part[];
    const separator = valuesOnLine > 0 ? "   " : "";
    if (
      visibleWidth(styled([...current, { text: separator }, { text: fullText }], theme)) > width
    ) {
      const continuation = visibleWidth(indent + fullText) <= width ? indent : "";
      const availableWidth = Math.max(0, width - visibleWidth(continuation));
      const text = selected ? selectedText(value, availableWidth) : value;
      lines.push([
        ...(continuation ? [{ text: continuation }] : []),
        { text, tone: selected ? "accent" : "plain" },
      ]);
      valuesOnLine = 1;
    } else {
      const availableWidth = Math.max(
        0,
        width - visibleWidth(styled(current, theme)) - visibleWidth(separator),
      );
      const text = selected ? selectedText(value, availableWidth) : value;
      current.push({ text: separator }, { text, tone: selected ? "accent" : "plain" });
      valuesOnLine += 1;
    }
  }
  return lines.map((line, index) => {
    const rendered = styled(line, theme);
    if (!tiny || index !== 0) return safe(rendered, width);
    const truncated = truncateToWidth(rendered, Math.max(1, width), "");
    return rendered.includes("\u001b") ? truncated : truncated.replaceAll("\u001b[0m", "");
  });
}

function grouped(value: number, fractionDigits: number, trimFraction = false): string {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return "—";
  const fixed = Math.abs(value).toFixed(fractionDigits);
  const [integer = "0", fraction] = fixed.split(".");
  const spaced = integer.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const suffix = trimFraction ? fraction?.replace(/0+$/, "") : fraction;
  return `${value < 0 ? "-" : ""}${spaced}${suffix ? `.${suffix}` : ""}`;
}

function number(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return "—";
  return grouped(Math.round(value), 0);
}

function decimal(value: number): string {
  return grouped(value, 2, true);
}

function tokens(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return "—";
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)} M` : number(value);
}

function tokensInMillions(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return "—";
  return `${(value / 1_000_000).toFixed(2)} M`;
}

function usablePercentage(value: number | undefined): value is number {
  return (
    value !== undefined && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
  );
}

function percent(value: number | undefined): string {
  return usablePercentage(value) ? `${number(value)}%` : "—";
}

function money(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100) return "—";
  return `$${grouped(value, 2)}`;
}

function field(lines: string[], label: string, value: string, width: number): void {
  const prefix = `${label}: `;
  if (visibleWidth(prefix + value) <= width) lines.push(prefix + value);
  else {
    lines.push(label);
    lines.push(...wrapText(`  ${value}`, width));
  }
}

function rawState(raw: QuotaBucketHistory["latest"]): string | undefined {
  const format = raw.unit === "usd" ? money : decimal;
  const values = [
    usableRawNumber(raw.unit, raw.used) ? `used ${format(raw.used)}` : undefined,
    usableRawNumber(raw.unit, raw.remaining) ? `remaining ${format(raw.remaining)}` : undefined,
    usableRawNumber(raw.unit, raw.limit) ? `limit ${format(raw.limit)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (values.length === 0) return undefined;
  const unit = raw.unit === "usd" ? "" : ` ${raw.unit}`;
  return `${values.join(", ")}${unit}`;
}

function rawFragment(
  label: string,
  observation: QuotaBucketHistory["current"],
): string | undefined {
  if (!observation || usablePercentage(observation.percentage)) return undefined;
  const state = rawState(observation.raw);
  return state === undefined ? undefined : `${label} ${state}`;
}

const WARNING_SUMMARIES = {
  "unreadable-source": "Some historical data could not be read",
  "malformed-jsonl": "Some historical records were malformed",
  "malformed-snapshot": "Some quota observations were malformed",
  "broken-lineage": "Some copied session history could not be linked reliably",
  "cyclic-lineage": "Some copied session history could not be linked reliably",
  "ambiguous-output-match": "Some subagent activity could not be deduplicated reliably",
  "unattributable-call": "Some historical model work could not be attributed",
  "untimestamped-call": "Some model calls lacked timestamps and were excluded",
  "invalid-usage": "Some model calls had invalid usage and were excluded",
  "imprecise-gap-timing": "Some calls lacked precise timing and were excluded from cache gaps",
} as const;

function warningLine(message: string, theme?: HistoryTheme, indent = ""): string {
  return styled([{ text: `${indent}${message}`, tone: "dim" }], theme);
}

function warningLines(view: HistoryRangeView, tab: HistoryTab, theme?: HistoryTheme): string[] {
  const accepted = view.warnings.filter((warning) => {
    if (warning.code === "imprecise-gap-timing") return tab === "Cache";
    if (warning.code === "malformed-snapshot") return tab === "Quotas";
    return tab === "Models";
  });
  return [...new Set(accepted.map((warning) => WARNING_SUMMARIES[warning.code]))].map((message) =>
    warningLine(message, theme),
  );
}

function modelsLines(view: HistoryRangeView, width: number, theme?: HistoryTheme): string[] {
  const lines: string[] = [];
  if (view.models.length === 0) lines.push("No model calls in range");
  if (width >= 120) {
    lines.push(
      "Provider/model                         Calls      Input  Cache read Cache write     Output      Total       Cost",
    );
    for (const row of view.models) {
      lines.push(
        `${column(row.route, 36)} ${number(row.calls).padStart(7)} ${tokensInMillions(row.input).padStart(10)} ${tokensInMillions(row.cacheRead).padStart(11)} ${tokensInMillions(row.cacheWrite).padStart(11)} ${tokensInMillions(row.output).padStart(10)} ${tokensInMillions(row.total).padStart(10)} ${money(row.cost).padStart(10)}`,
      );
    }
  } else {
    for (const [index, row] of view.models.entries()) {
      if (index > 0) lines.push("");
      lines.push(...wrapText(sanitizeArtifactLabel(row.route), width));
      field(lines, "Calls", number(row.calls), width);
      field(lines, "Input", tokensInMillions(row.input), width);
      field(lines, "Cache read", tokensInMillions(row.cacheRead), width);
      field(lines, "Cache write", tokensInMillions(row.cacheWrite), width);
      field(lines, "Output", tokensInMillions(row.output), width);
      field(lines, "Total tokens", tokensInMillions(row.total), width);
      field(lines, "Recorded cost", money(row.cost), width);
    }
  }
  lines.push(...warningLines(view, "Models", theme));
  return lines;
}

function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return "—";
  if (value < 1_000) return number(value);
  const useMillions = value >= 999_950;
  const divisor = useMillions ? 1_000_000 : 1_000;
  const suffix = useMillions ? "M" : "k";
  return `${grouped(value / divisor, 1, true)}${suffix}`;
}

function cacheCountWidth(view: HistoryRangeView): number {
  let width = 1;
  for (const row of view.cache.rows) {
    for (const bucket of CACHE_GAP_BUCKETS) {
      width = Math.max(width, visibleWidth(compactCount(row.gaps[bucket].samples)));
    }
  }
  return width;
}

function cacheCell(
  samples: number,
  percentageValue: number | undefined,
  countWidth: number,
  theme?: HistoryTheme,
  percentageWidth = 4,
): string {
  const percentage = percent(percentageValue);
  const percentageField = percentage.padStart(percentageWidth);
  if (samples === 0 && percentage === "—") {
    return `${percentageField}${" ".repeat(countWidth + 1)}`;
  }
  const count = compactCount(samples);
  return styled(
    [
      { text: `${percentageField} ` },
      { text: count, tone: count === "—" ? undefined : "dim" },
      { text: " ".repeat(Math.max(0, countWidth - visibleWidth(count))) },
    ],
    theme,
  );
}

function compactCacheLines(
  bucket: string,
  samples: number,
  percentageValue: number | undefined,
  width: number,
  theme?: HistoryTheme,
): string[] {
  const percentage = percent(percentageValue);
  const count = samples === 0 && percentage === "—" ? undefined : compactCount(samples);
  const countTone: Tone | undefined = count === undefined || count === "—" ? undefined : "dim";
  const parts: Part[] = [
    { text: `${bucket}: ${percentage}` },
    ...(count === undefined ? [] : [{ text: " " }, { text: count, tone: countTone }]),
  ];
  const lines: Part[][] = [[]];
  let lineWidth = 0;
  for (const part of parts) {
    for (const character of part.text) {
      const characterWidth = visibleWidth(character);
      if (lineWidth + characterWidth > width) {
        lines.push([]);
        lineWidth = 0;
      }
      if (character === " " && lineWidth === 0) continue;
      const line = lines.at(-1) as Part[];
      const previous = line.at(-1);
      if (previous && previous.tone === part.tone) previous.text += character;
      else line.push({ text: character, tone: part.tone });
      lineWidth += characterWidth;
    }
  }
  return lines.filter((line) => line.length > 0).map((line) => styled(line, theme));
}

function cacheLines(view: HistoryRangeView, width: number, theme?: HistoryTheme): string[] {
  const lines = [
    `Cached input share: ${percent(view.cache.cachedInputShare)}`,
    `Calls reading cache: ${percent(view.cache.callsReadingCache)}`,
    "",
  ];
  if (view.cache.rows.length === 0) lines.push("No model calls in range");
  const countWidth = cacheCountWidth(view);
  const percentageWidth = Math.max(4, ...CACHE_GAP_BUCKETS.map((bucket) => visibleWidth(bucket)));
  const wideHeader = `${column("Provider/model", 36)} ${CACHE_GAP_BUCKETS.map(
    (bucket) => `${bucket.padStart(percentageWidth)}${" ".repeat(countWidth + 1)}`,
  ).join(" ")}`;
  if (visibleWidth(wideHeader) <= width) {
    lines.push(wideHeader);
    for (const row of view.cache.rows) {
      lines.push(
        `${column(row.route, 36)} ${CACHE_GAP_BUCKETS.map((bucket) => {
          const cell = row.gaps[bucket];
          return cacheCell(cell.samples, cell.percentage, countWidth, theme, percentageWidth);
        }).join(" ")}`,
      );
    }
  } else {
    const labelWidth = Math.max(...CACHE_GAP_BUCKETS.map((bucket) => visibleWidth(bucket)));
    for (const [index, row] of view.cache.rows.entries()) {
      if (index > 0) lines.push("");
      lines.push(...wrapText(sanitizeArtifactLabel(row.route), width));
      for (const bucket of CACHE_GAP_BUCKETS) {
        const cell = row.gaps[bucket];
        const value = cacheCell(cell.samples, cell.percentage, countWidth, theme);
        const alignedLabel = `${bucket}${" ".repeat(labelWidth - visibleWidth(bucket))}`;
        if (visibleWidth(`${alignedLabel}: ${value}`) <= width) {
          lines.push(`${alignedLabel}: ${value}`);
        } else {
          lines.push(...compactCacheLines(bucket, cell.samples, cell.percentage, width, theme));
        }
      }
    }
  }
  lines.push(...warningLines(view, "Cache", theme));
  return lines;
}

function quotaBucketLabel(bucket: QuotaBucketHistory): string {
  if (bucket.latest.groupId !== "codex") return sanitizeArtifactLabel(bucket.label);
  const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
  return formatWindowLabel(bucket.latest.windowMinutes, fallback, false);
}

function quotaBucketTitles(buckets: QuotaBucketHistory[]): string[] {
  const labels = buckets.map(quotaBucketLabel);
  const groupLabels = buckets.map((bucket) =>
    bucket.latest.groupLabel ? sanitizeArtifactLabel(bucket.latest.groupLabel) : undefined,
  );
  const labelCounts = new Map<string, number>();
  for (const label of labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);

  const candidates = labels.map((label, index) => {
    if ((labelCounts.get(label) ?? 0) < 2) return label;
    const groupLabel = groupLabels[index];
    const disambiguates =
      groupLabel !== undefined &&
      groupLabel !== "—" &&
      groupLabel !== label &&
      groupLabels.every(
        (other, otherIndex) =>
          otherIndex === index || labels[otherIndex] !== label || other !== groupLabel,
      );
    return disambiguates ? `${groupLabel} · ${label}` : label;
  });

  const reserved = new Set(candidates);
  const used = new Set<string>();
  return candidates.map((candidate) => {
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    let ordinal = 2;
    while (used.has(`${candidate} (${ordinal})`) || reserved.has(`${candidate} (${ordinal})`)) {
      ordinal += 1;
    }
    const title = `${candidate} (${ordinal})`;
    used.add(title);
    return title;
  });
}

function quotaCapacityLine(capacity: QuotaBucketHistory["capacity"]): string | undefined {
  if (!capacity) return undefined;
  const relation = capacity.lowerBound ? "≥" : "≈";
  const lowerBound = capacity.lowerBound ? " (lower bound)" : "";
  if (capacity.estimated100PercentCost !== undefined) {
    const capacityCost = money(capacity.estimated100PercentCost);
    if (capacityCost !== "—") return `100% ${relation} ${capacityCost}${lowerBound}`;
  }
  const capacityTokens = tokens(capacity.estimated100PercentTokens);
  return capacityTokens === "—"
    ? undefined
    : `100% ${relation} ${capacityTokens} tokens${lowerBound}`;
}

function quotaBucketLines(
  bucket: QuotaBucketHistory,
  width: number,
  title?: string,
  theme?: HistoryTheme,
): string[] {
  const bucketTitle = title ?? sanitizeArtifactLabel(bucket.label);
  const fragments: string[] = [];
  const percentageObservations = bucket.observations.some((observation) =>
    usablePercentage(observation.percentage),
  );
  const capacityLine = quotaCapacityLine(bucket.capacity);

  if (percentageObservations) {
    const resetSuffix =
      bucket.observedResets > 0
        ? ` · over ${number(bucket.observedResets)} ${bucket.observedResets === 1 ? "reset" : "resets"}`
        : "";
    fragments.push(`${percent(bucket.observedConsumption).padStart(3)} consumed${resetSuffix}`);
  } else {
    const fallback = usablePercentage(bucket.current?.percentage)
      ? bucket.current.percentage
      : usablePercentage(bucket.historicalBoundary?.percentage)
        ? bucket.historicalBoundary.percentage
        : undefined;
    if (fallback !== undefined) fragments.push(`${percent(fallback).padStart(3)} used`);
  }
  if (capacityLine) fragments.push(capacityLine);

  const latestObservation = bucket.observations.at(-1);
  fragments.push(
    ...[
      rawFragment("current", bucket.current),
      rawFragment("latest", latestObservation),
      rawFragment("boundary", bucket.historicalBoundary),
    ].filter((value): value is string => Boolean(value)),
  );

  let unstyledTitle = `${bucketTitle}:`;
  const row = `${unstyledTitle}${fragments.length > 0 ? ` ${fragments.join(" · ")}` : ""}`;
  const lines = wrapText(row, width)
    .filter((line) => visibleWidth(line) > 0)
    .map((line) => {
      if (!theme || unstyledTitle.length === 0) return line;
      if (unstyledTitle.startsWith(" ") && !line.startsWith(" "))
        unstyledTitle = unstyledTitle.trimStart();
      let prefixLength = 0;
      while (
        prefixLength < line.length &&
        prefixLength < unstyledTitle.length &&
        line[prefixLength] === unstyledTitle[prefixLength]
      ) {
        prefixLength += 1;
      }
      const prefix = line.slice(0, prefixLength);
      unstyledTitle = unstyledTitle.slice(prefixLength);
      return styled([{ text: prefix, tone: "dim" }, { text: line.slice(prefixLength) }], theme);
    });
  for (const warning of new Set([
    ...bucket.capacityWarnings,
    ...(bucket.capacity?.warnings ?? []),
  ])) {
    const indent = width > 2 ? "  " : "";
    lines.push(
      ...wrapText(warning, width - visibleWidth(indent))
        .filter((line) => visibleWidth(line) > 0)
        .map((line) => styled([{ text: `${indent}${line}`, tone: "dim" }], theme)),
    );
  }
  return lines;
}

function usableRawNumber(
  unit: QuotaBucketHistory["latest"]["unit"],
  value: number | undefined,
): value is number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return false;
  return unit === "usd" ? value <= Number.MAX_SAFE_INTEGER / 100 : value <= Number.MAX_SAFE_INTEGER;
}

function visibleQuotaBucket(bucket: QuotaBucketHistory): boolean {
  const normalizedUsage = [
    bucket.current?.percentage,
    bucket.historicalBoundary?.percentage,
    bucket.latestPercentage,
    bucket.observedPeak,
    bucket.observedConsumption,
    ...bucket.observations.map((observation) => observation.percentage),
  ];
  if (normalizedUsage.some((value) => usablePercentage(value) && value > 0)) return true;

  const rawStates = [
    bucket.current?.raw,
    bucket.historicalBoundary?.raw,
    bucket.latest,
    ...bucket.observations.map((observation) => observation.raw),
  ];
  if (
    rawStates.some((raw) => {
      if (!raw) return false;
      const used = raw.used;
      if (usableRawNumber(raw.unit, used) && used > 0) return true;
      const limit = raw.limit;
      const remaining = raw.remaining;
      const derivedUsed =
        usableRawNumber(raw.unit, limit) && usableRawNumber(raw.unit, remaining)
          ? limit - remaining
          : undefined;
      return usableRawNumber(raw.unit, derivedUsed) && derivedUsed > 0;
    })
  )
    return true;

  return quotaCapacityLine(bucket.capacity) !== undefined;
}

function isMainCodexBucket(bucket: QuotaBucketHistory): boolean {
  if (bucket.latest.groupId !== undefined) return bucket.latest.groupId === "codex";
  return bucket.id === "codex" || bucket.id.startsWith("codex:");
}

function quotaPresentationProviders(view: HistoryRangeView): QuotaProviderHistory[] {
  return view.quotas.providers.flatMap((provider) => {
    const identities = provider.identities.flatMap((identity) => {
      const buckets = identity.buckets.filter(
        (bucket) =>
          visibleQuotaBucket(bucket) &&
          (provider.providerId !== "openai-codex" || isMainCodexBucket(bucket)),
      );
      return buckets.length > 0 ? [{ ...identity, buckets }] : [];
    });
    return identities.length > 0 ? [{ ...provider, identities }] : [];
  });
}

function quotasLines(view: HistoryRangeView, width: number, theme?: HistoryTheme): string[] {
  const providers = quotaPresentationProviders(view);
  if (providers.length === 0) {
    return ["No quota observations in range", ...warningLines(view, "Quotas", theme)];
  }

  const lines: string[] = [];
  for (const [providerIndex, provider] of providers.entries()) {
    if (providerIndex > 0) lines.push("");
    lines.push(sanitizeArtifactLabel(provider.providerName));
    if (provider.noHistoryInRange) lines.push("No history in range");

    const showAccounts = provider.identities.length > 1;
    for (const [identityIndex, identity] of provider.identities.entries()) {
      if (showAccounts) {
        if (identityIndex > 0) lines.push("");
        lines.push(`Account ${identityIndex + 1}`);
      }
      const titles = quotaBucketTitles(identity.buckets);
      for (const [bucketIndex, bucket] of identity.buckets.entries()) {
        if (bucketIndex > 0) lines.push("");
        lines.push(...quotaBucketLines(bucket, width, titles[bucketIndex], theme));
      }
    }
  }
  const warnings = warningLines(view, "Quotas", theme);
  if (warnings.length > 0) lines.push("", ...warnings);
  return lines;
}

function contentLines(
  view: HistoryRangeView,
  state: HistoryMenuState,
  width: number,
  theme?: HistoryTheme,
): string[] {
  if (state.tab === "Models") return modelsLines(view, width, theme);
  if (state.tab === "Cache") return cacheLines(view, width, theme);
  return quotasLines(view, width, theme);
}

function wrappedContentLines(
  view: HistoryRangeView,
  state: HistoryMenuState,
  width: number,
  theme?: HistoryTheme,
): string[] {
  const boundedWidth = Math.max(1, width);
  return contentLines(view, state, boundedWidth, theme)
    .flatMap((line) =>
      line.length === 0
        ? [line]
        : wrapText(line, boundedWidth).filter((segment) => visibleWidth(segment) > 0),
    )
    .map((line) => safe(line, boundedWidth));
}

/** Render a width-safe, height-bounded history screen from the shared range view models. */
export function renderUsageHistory(
  history: LoadedHistory,
  state: HistoryMenuState,
  width: number,
  terminalHeight: number,
  options: {
    live?: LiveQuotaContext;
    theme?: HistoryTheme;
    view?: HistoryRangeView;
    padToHeight?: boolean;
  } = {},
): HistoryRenderResult {
  const boundedWidth = Math.max(1, width);
  const range = rangeDefinition(state.range);
  const view =
    options.view ?? deriveHistoryRange(history, range.durationMs, { live: options.live });
  const selected = state;
  const fullHeader = [
    ...selectorLines(
      "Tabs",
      HISTORY_TABS,
      HISTORY_TABS.indexOf(selected.tab),
      selected.navigationRow === "Tabs",
      boundedWidth,
      options.theme,
    ),
    ...selectorLines(
      "Range",
      HISTORY_RANGES.map((item) => item.label),
      HISTORY_RANGES.findIndex((item) => item.label === selected.range),
      selected.navigationRow === "Range",
      boundedWidth,
      options.theme,
    ),
  ];
  const compactHeader = [
    safe(
      styled(
        [
          { text: selected.navigationRow === "Tabs" ? "› " : "  ", tone: "accent" },
          { text: `Tabs ${selected.tab}`, tone: "accent" },
        ],
        options.theme,
      ),
      boundedWidth,
    ),
    safe(
      styled(
        [
          { text: selected.navigationRow === "Range" ? "› " : "  ", tone: "accent" },
          { text: `Range ${selected.range}`, tone: "accent" },
        ],
        options.theme,
      ),
      boundedWidth,
    ),
  ];
  const activeChoice = selected.navigationRow === "Tabs" ? selected.tab : selected.range;
  const combinedHeader = [
    safe(
      styled(
        [
          {
            text: `› ${selected.navigationRow} ${activeChoice} · ${selected.range}`,
            tone: "accent",
          },
        ],
        options.theme,
      ),
      boundedWidth,
    ),
  ];
  const boundedHeight = Math.max(1, terminalHeight);
  const header =
    fullHeader.length + 2 <= boundedHeight
      ? fullHeader
      : boundedHeight >= 4
        ? compactHeader
        : combinedHeader;
  const content = wrappedContentLines(view, selected, boundedWidth, options.theme);
  const hints = ["↑↓ rows", "←→ change", "Ctrl+↑↓ scroll", "Esc back"];
  const footerPlain: string[] = [];
  for (const hint of hints) {
    const current = footerPlain.at(-1);
    if (!current || visibleWidth(`${current} · ${hint}`) > boundedWidth) footerPlain.push(hint);
    else footerPlain[footerPlain.length - 1] = `${current} · ${hint}`;
  }
  const fullFooter = footerPlain.map((line) =>
    safe(styled([{ text: line, tone: "dim" }], options.theme), boundedWidth),
  );
  const minimumViewport = content.length > 0 && boundedHeight > header.length ? 1 : 0;
  const footerBudget = Math.max(0, boundedHeight - header.length - minimumViewport);
  let footer =
    hints.every((hint) => visibleWidth(hint) <= boundedWidth) && fullFooter.length <= footerBudget
      ? fullFooter
      : [];
  if (footer.length === 0 && footerBudget > 0) {
    const compactHints = ["↑↓", "←→", "Ctrl+↑↓", "Esc"];
    const spaced = packHints(compactHints, boundedWidth, footerBudget, " ");
    const packed = spaced.complete
      ? spaced
      : packHints(compactHints, boundedWidth, footerBudget, "");
    footer = packed.lines.map((line) =>
      safe(styled([{ text: line, tone: "dim" }], options.theme), boundedWidth),
    );
  }
  const available = Math.max(0, boundedHeight - header.length - footer.length);
  const footerSeparatorLines = footer.length > 0 && available >= 2 ? 1 : 0;
  const afterFooterSeparator = available - footerSeparatorLines;
  const headerSeparatorLines = afterFooterSeparator >= 2 ? 1 : 0;
  const viewportLines = Math.max(0, afterFooterSeparator - headerSeparatorLines);
  const maxScroll = Math.max(0, content.length - viewportLines);
  const scrollOffset = Math.min(Math.max(0, selected.scrollOffset), maxScroll);
  const visible = content.slice(scrollOffset, scrollOffset + viewportLines);
  const padding =
    options.padToHeight === false
      ? []
      : Array.from({ length: Math.max(0, viewportLines - visible.length) }, () => "");
  const lines = [
    ...header,
    ...(headerSeparatorLines ? [""] : []),
    ...visible,
    ...padding,
    ...(footerSeparatorLines ? [""] : []),
    ...footer,
  ].map((line) => safe(line, boundedWidth));
  return { lines, contentLines: content.length, viewportLines, maxScroll, scrollOffset };
}

function packHints(
  hints: readonly string[],
  width: number,
  maximumLines: number,
  separator: string,
): { lines: string[]; complete: boolean } {
  const lines: string[] = [];
  let placed = 0;
  for (const hint of hints) {
    if (visibleWidth(hint) > width) continue;
    let target = lines.findIndex((line) => visibleWidth(`${line}${separator}${hint}`) <= width);
    if (target < 0 && lines.length < maximumLines) {
      lines.push("");
      target = lines.length - 1;
    }
    if (target < 0) continue;
    lines[target] = lines[target] ? `${lines[target]}${separator}${hint}` : hint;
    placed += 1;
  }
  return { lines, complete: placed === hints.length };
}

function cycle(index: number, length: number, delta: number): number {
  if (length === 0) return 0;
  return (index + delta + length) % length;
}

/** Apply one input event and clamp every selection and scroll change to the new view. */
export function updateHistoryMenuState(
  history: LoadedHistory,
  state: HistoryMenuState,
  data: string,
  width: number,
  terminalHeight: number,
  live?: LiveQuotaContext,
  getView: (durationMs: number) => HistoryRangeView = (durationMs) =>
    deriveHistoryRange(history, durationMs, { live }),
): HistoryMenuState {
  const next = { ...state };

  const tabShortcutDelta = matchesKey(data, "tab") ? 1 : matchesKey(data, "shift+tab") ? -1 : 0;
  if (tabShortcutDelta) {
    next.tab = HISTORY_TABS[
      cycle(HISTORY_TABS.indexOf(next.tab), HISTORY_TABS.length, tabShortcutDelta)
    ] as HistoryTab;
    next.scrollOffset = 0;
  }

  const rangeKeys = ["1", "2", "3", "4", "5", "6", "7"] as const;
  for (let index = 0; index < HISTORY_RANGES.length; index += 1) {
    const key = rangeKeys[index];
    if (key && matchesKey(data, key)) {
      next.range = HISTORY_RANGES[index]?.label ?? "1d";
      next.scrollOffset = 0;
    }
  }

  if (matchesKey(data, "up") || matchesKey(data, "down")) {
    next.navigationRow = next.navigationRow === "Tabs" ? "Range" : "Tabs";
  }

  const choiceDelta = matchesKey(data, "right") ? 1 : matchesKey(data, "left") ? -1 : 0;
  if (choiceDelta && next.navigationRow === "Tabs") {
    next.tab = HISTORY_TABS[
      cycle(HISTORY_TABS.indexOf(next.tab), HISTORY_TABS.length, choiceDelta)
    ] as HistoryTab;
    next.scrollOffset = 0;
  } else if (choiceDelta && next.navigationRow === "Range") {
    next.range =
      HISTORY_RANGES[
        cycle(
          HISTORY_RANGES.findIndex((range) => range.label === next.range),
          HISTORY_RANGES.length,
          choiceDelta,
        )
      ]?.label ?? "1d";
    next.scrollOffset = 0;
  }

  const nextView = getView(rangeDefinition(next.range).durationMs);
  let rendered = renderUsageHistory(history, next, width, terminalHeight, {
    live,
    view: nextView,
  });
  next.scrollOffset = rendered.scrollOffset;
  const page = Math.max(1, rendered.viewportLines - 1);
  if (matchesKey(data, "ctrl+up")) next.scrollOffset -= 1;
  if (matchesKey(data, "ctrl+down")) next.scrollOffset += 1;
  if (matchesKey(data, "pageUp")) next.scrollOffset -= page;
  if (matchesKey(data, "pageDown")) next.scrollOffset += page;

  rendered = renderUsageHistory(history, next, width, terminalHeight, {
    live,
    view: nextView,
  });
  next.scrollOffset = rendered.scrollOffset;
  return next;
}

export interface HistoryTuiComponent extends Component {
  getState(): HistoryMenuState;
  dispose?: () => void;
}

function historyViewCache(
  options: ShowUsageHistoryOptions,
): (durationMs: number) => HistoryRangeView {
  const cache = new Map<number, HistoryRangeView>();
  const derive = options.deriveRange ?? deriveHistoryRange;
  return (durationMs) => {
    let view = cache.get(durationMs);
    if (!view) {
      view = derive(options.history, durationMs, { live: options.live });
      cache.set(durationMs, view);
    }
    return view;
  };
}

/** Render a compact inline panel without depending on terminal or host-chrome height. */
export function createHistoryTuiComponent(
  options: ShowUsageHistoryOptions,
  theme: HistoryTheme,
  requestRender: () => void,
  done: () => void,
): HistoryTuiComponent {
  let state = createHistoryMenuState();
  let lastWidth = 80;
  const getView = historyViewCache(options);
  const component: HistoryTuiComponent = {
    render(width) {
      lastWidth = width;
      const view = getView(rangeDefinition(state.range).durationMs);
      const rendered = renderUsageHistory(options.history, state, width, HISTORY_PANEL_HEIGHT, {
        live: options.live,
        theme,
        view,
        padToHeight: false,
      });
      state.scrollOffset = rendered.scrollOffset;
      return rendered.lines;
    },
    handleInput(data) {
      if (matchesKey(data, "escape")) {
        done();
        return;
      }
      const next = updateHistoryMenuState(
        options.history,
        state,
        data,
        lastWidth,
        HISTORY_PANEL_HEIGHT,
        options.live,
        getView,
      );
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = next;
      requestRender();
    },
    invalidate() {},
    getState: () => ({ ...state }),
  };
  return component;
}

export async function showUsageHistory(
  ctx: ExtensionCommandContext,
  options: ShowUsageHistoryOptions,
): Promise<void> {
  if (options.signal.aborted) return;
  if (ctx.mode !== "tui") return showUsageHistorySelect(ctx, options);
  let cleanupAbort: (() => void) | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const stop = () => done(undefined);
      cleanupAbort = () => options.signal.removeEventListener("abort", stop);
      options.signal.addEventListener("abort", stop, { once: true });
      if (options.signal.aborted) stop();
      const component = createHistoryTuiComponent(
        options,
        theme,
        () => tui.requestRender(),
        () => done(undefined),
      );
      component.dispose = cleanupAbort;
      return component;
    });
  } finally {
    cleanupAbort?.();
  }
}

async function showUsageHistorySelect(
  ctx: ExtensionCommandContext,
  options: ShowUsageHistoryOptions,
): Promise<void> {
  const state = createHistoryMenuState();
  const getView = historyViewCache(options);
  while (!options.signal.aborted) {
    const view = getView(rangeDefinition(state.range).durationMs);
    const actions = [
      ...HISTORY_TABS.filter((tab) => tab !== state.tab).map((tab) => `Tab: ${tab}`),
      ...HISTORY_RANGES.filter((range) => range.label !== state.range).map(
        (range) => `Range: ${range.label}`,
      ),
      "Back",
    ];
    const report = wrappedContentLines(view, state, 100).join("\n");
    const choice = await ctx.ui.select(report, actions, { signal: options.signal });
    if (!choice || choice === "Back") return;
    if (choice.startsWith("Tab: ")) state.tab = choice.slice(5) as HistoryTab;
    else if (choice.startsWith("Range: ")) state.range = choice.slice(7) as HistoryRangeLabel;
    state.scrollOffset = 0;
  }
}
