import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "./core.ts";
import type { LoadedHistory, NormalizedCall } from "./history.ts";

export const SPEED_RANGES = ["1d", "2d", "3d", "5d", "7d", "14d"] as const;
export type SpeedRange = (typeof SPEED_RANGES)[number];
const DAY_MS = 24 * 60 * 60_000;

export function speedRange(value: string): SpeedRange | undefined {
  return SPEED_RANGES.find((range) => range === value);
}

export interface SpeedRow {
  provider: string;
  model: string;
  samples: number;
  previousSamples: number;
  medianRate?: number;
  totalOutputTokens: number;
  totalSeconds: number;
  changes: number[];
}

export interface SpeedReport {
  range: SpeedRange;
  since: number;
  previousSince: number;
  now: number;
  rows: SpeedRow[];
  coverage: {
    assistants: number;
    observed: number;
    unsuccessful: number;
    untimed: number;
    noOutput: number;
  };
  warnings: string[];
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 ? upper : (sorted[middle - 1] as number) / 2 + upper / 2;
}

function positive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

type SpeedSample = Pick<NormalizedCall, "stopReason" | "durationMs" | "usage">;

function rate(call: SpeedSample): number {
  return call.usage.output / ((call.durationMs as number) / 1_000);
}

function exclusion(call: SpeedSample): "unsuccessful" | "untimed" | "noOutput" | undefined {
  if (call.stopReason !== "stop" && call.stopReason !== "toolUse") return "unsuccessful";
  if (!positive(call.durationMs)) return "untimed";
  if (!positive(call.usage.output) || !positive(rate(call))) return "noOutput";
  return undefined;
}

/** Keep the session status and historical report on the same measured-request definition. */
export function medianRequestRate(calls: SpeedSample[]): number | undefined {
  return median(calls.filter((call) => !exclusion(call)).map(rate));
}

function rowKey(call: NormalizedCall): string {
  return JSON.stringify([call.provider, call.model]);
}

function bin(value: number, boundaries: number[]): number {
  const index = boundaries.findIndex((boundary) => value < boundary);
  return index < 0 ? boundaries.length : index;
}

function cohortKey(call: NormalizedCall): string {
  const context = call.usage.input + call.usage.cacheRead + call.usage.cacheWrite;
  return JSON.stringify([
    bin(context, [16_000, 64_000, 128_000]),
    bin(call.usage.output, [500, 2_000, 8_000]),
    call.stopReason,
    call.thinkingLevel ?? null,
    call.thinkingLevelInferred === true,
  ]);
}

/** Compare like recorded requests without treating changing workloads as a benchmark. */
export function deriveSpeedReport(history: LoadedHistory, range: SpeedRange): SpeedReport {
  const duration = Number.parseInt(range, 10) * DAY_MS;
  const since = history.now - duration;
  const previousSince = since - duration;
  const coverage: SpeedReport["coverage"] = {
    assistants: 0,
    observed: 0,
    unsuccessful: 0,
    untimed: 0,
    noOutput: 0,
  };
  const groups = new Map<
    string,
    { row: SpeedRow; current: NormalizedCall[]; previous: NormalizedCall[] }
  >();
  for (const call of history.calls) {
    const at = call.timestamp;
    if (
      call.kind !== "assistant" ||
      at === undefined ||
      !Number.isFinite(at) ||
      at < previousSince ||
      at > history.now
    )
      continue;
    const excluded = exclusion(call);
    if (at >= since) {
      coverage.assistants += 1;
      if (excluded) coverage[excluded] += 1;
      else coverage.observed += 1;
    }
    if (excluded) continue;
    const key = rowKey(call);
    let group = groups.get(key);
    if (!group) {
      group = {
        row: {
          provider: call.provider,
          model: call.model,
          samples: 0,
          previousSamples: 0,
          totalOutputTokens: 0,
          totalSeconds: 0,
          changes: [],
        },
        current: [],
        previous: [],
      };
      groups.set(key, group);
    }
    if (at >= since) group.current.push(call);
    else group.previous.push(call);
  }
  const rows: SpeedRow[] = [];
  for (const group of groups.values()) {
    if (group.current.length === 0) continue;
    const { row, current, previous } = group;
    row.samples = current.length;
    row.previousSamples = previous.length;
    row.medianRate = medianRequestRate(current);
    row.totalOutputTokens = current.reduce((total, call) => total + call.usage.output, 0);
    row.totalSeconds = current.reduce(
      (total, call) => total + (call.durationMs as number) / 1_000,
      0,
    );
    const cohorts = new Map<string, { current: number[]; previous: number[] }>();
    for (const [period, calls] of [
      ["current", current],
      ["previous", previous],
    ] as const) {
      for (const call of calls) {
        const key = cohortKey(call);
        const cohort = cohorts.get(key) ?? { current: [], previous: [] };
        cohort[period].push(rate(call));
        cohorts.set(key, cohort);
      }
    }
    for (const cohort of cohorts.values()) {
      if (cohort.current.length < 10 || cohort.previous.length < 10) continue;
      const change =
        ((median(cohort.current) as number) / (median(cohort.previous) as number) - 1) * 100;
      if (Number.isFinite(change)) row.changes.push(change);
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const warnings = new Map<string, number>();
  for (const warning of history.warnings) {
    if (warning.code === "malformed-snapshot" || warning.code === "imprecise-gap-timing") continue;
    const times =
      warning.timestamps ?? (warning.timestamp === undefined ? [] : [warning.timestamp]);
    if (times.length && !times.some((at) => at >= previousSince && at <= history.now)) continue;
    warnings.set(warning.code, (warnings.get(warning.code) ?? 0) + 1);
  }
  return {
    range,
    since,
    previousSince,
    now: history.now,
    rows,
    coverage,
    warnings: [...warnings].map(([code, count]) => `${code} (${count})`),
  };
}

function number(value: number | undefined, digits = 1): string {
  return value === undefined || !Number.isFinite(value)
    ? "—"
    : value
        .toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
        .replaceAll(",", " ");
}

function tokens(value: number): string {
  return value >= 1_000_000 ? `${number(value / 1_000_000, 2)} M` : number(value, 0);
}

function duration(seconds: number): string {
  if (seconds < 60) return `${number(seconds)}s`;
  if (seconds < 3_600) return `${number(seconds / 60)}m`;
  if (seconds < 86_400) return `${number(seconds / 3_600)}h`;
  return `${number(seconds / 86_400)}d`;
}

export function speedTrend(changes: number[]): string {
  if (changes.length === 0) return "insufficient";
  const percent = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
  if (changes.length === 1) return percent(changes[0] as number);
  return `${percent(Math.min(...changes))}…${percent(Math.max(...changes))} (${changes.length})`;
}

function label(value: string): string {
  return sanitizeDisplayText(value, 80) || "—";
}

function cell(value: string, width: number): string {
  const cut = truncateToWidth(value, width, "");
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

function speedTable(report: SpeedReport): string[] {
  const routeWidth = report.rows.reduce(
    (width, row) =>
      Math.max(width, Math.min(40, visibleWidth(label(`${row.provider}/${row.model}`)))),
    14,
  );
  const values = [
    ["Provider/model", "Median tok/s", "Total output tokens", "Total request time", "Trend"],
    ...report.rows.map((row) => [
      label(`${row.provider}/${row.model}`),
      number(row.medianRate),
      tokens(row.totalOutputTokens),
      duration(row.totalSeconds),
      speedTrend(row.changes),
    ]),
  ];
  const widths = [routeWidth, 12, 19, 18, 12];
  for (const row of values) {
    for (let index = 1; index < widths.length; index += 1) {
      widths[index] = Math.max(widths[index] as number, visibleWidth(row[index] as string));
    }
  }
  return values.map((row) =>
    row.map((value, index) => cell(value, widths[index] as number)).join(" "),
  );
}

function title(report: SpeedReport): string {
  return `Speed · ${report.range} vs previous ${report.range}`;
}

const EMPTY_MESSAGE = "No measured requests in selected period";

/** Keep a single table even on narrow terminals; horizontal navigation reveals clipped columns. */
export function speedReportLines(
  report: SpeedReport,
  width: number,
  horizontalOffset = 0,
): string[] {
  if (width <= 0) return [];
  const table = speedTable(report);
  const maxPan = Math.max(0, visibleWidth(table[0] as string) - width);
  const pan = Math.min(Math.max(0, horizontalOffset), maxPan);
  return [
    title(report),
    ...table.map((line) => sliceByColumn(line, pan, width)),
    ...(report.rows.length === 0 ? [EMPTY_MESSAGE] : []),
  ].map((line) => truncateToWidth(line, width, ""));
}

export function createSpeedComponent(
  history: LoadedHistory,
  initialRange: SpeedRange,
  theme: Pick<Theme, "fg">,
  requestRender: () => void,
  done: () => void,
  height: () => number,
): Component & { dispose?: () => void } {
  let rangeIndex = SPEED_RANGES.indexOf(initialRange);
  let report = deriveSpeedReport(history, initialRange);
  let table = speedTable(report);
  let scroll = 0;
  let pan = 0;
  let contentLength = Math.max(1, report.rows.length);
  let viewport = 0;
  let maxPan = 0;
  return {
    render(width) {
      const panelHeight = Math.max(0, Math.min(20, Math.floor(height())));
      if (width <= 0 || panelHeight === 0) return [];
      maxPan = Math.max(0, visibleWidth(table[0] as string) - width);
      pan = Math.min(pan, maxPan);
      const selector = SPEED_RANGES.map((range) =>
        range === report.range ? theme.fg("accent", `[${range}]`) : theme.fg("dim", range),
      ).join(" ");
      const rangeLine =
        visibleWidth(`Range: ${selector}`) <= width
          ? `Range: ${selector}`
          : theme.fg("accent", `[${report.range}]`);
      const headers = [rangeLine, title(report), sliceByColumn(table[0] as string, pan, width)];
      const hint = panelHeight >= 5;
      viewport = Math.max(0, panelHeight - headers.length - Number(hint));
      scroll = Math.min(scroll, Math.max(0, contentLength - viewport));
      const content =
        report.rows.length === 0
          ? [EMPTY_MESSAGE]
          : table.slice(1).map((line) => sliceByColumn(line, pan, width));
      const lines = [...headers.slice(0, panelHeight), ...content.slice(scroll, scroll + viewport)];
      if (hint)
        lines.push(theme.fg("dim", "←→ range · ↑↓/PgUp/PgDn rows · Shift+←→ columns · Esc close"));
      return lines.map((line) => truncateToWidth(line, width, ""));
    },
    handleInput(data) {
      if (matchesKey(data, "escape")) {
        done();
        return;
      }
      if (matchesKey(data, "left") || matchesKey(data, "right")) {
        const nextIndex = Math.max(
          0,
          Math.min(SPEED_RANGES.length - 1, rangeIndex + (matchesKey(data, "right") ? 1 : -1)),
        );
        if (nextIndex !== rangeIndex) {
          rangeIndex = nextIndex;
          report = deriveSpeedReport(history, SPEED_RANGES[rangeIndex] as SpeedRange);
          table = speedTable(report);
          contentLength = Math.max(1, report.rows.length);
          scroll = 0;
          pan = 0;
        }
      } else if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
      else if (matchesKey(data, "down"))
        scroll = Math.min(Math.max(0, contentLength - viewport), scroll + 1);
      else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - viewport);
      else if (matchesKey(data, "pageDown"))
        scroll = Math.min(Math.max(0, contentLength - viewport), scroll + viewport);
      else if (matchesKey(data, "shift+left")) pan = Math.max(0, pan - 8);
      else if (matchesKey(data, "shift+right")) pan = Math.min(maxPan, pan + 8);
      else return;
      requestRender();
    },
    invalidate() {},
  };
}

export async function showSpeedReport(
  ctx: ExtensionCommandContext,
  history: LoadedHistory,
  range: SpeedRange,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (ctx.mode !== "tui") {
    let selectedRange = range;
    while (!signal.aborted) {
      const report = deriveSpeedReport(history, selectedRange);
      const selected = await ctx.ui.select(
        speedReportLines(report, 140).join("\n"),
        [...SPEED_RANGES, "Close"],
        { signal, [Symbol.for("pi-extensions:input-dialog")]: false },
      );
      const nextRange = selected === undefined ? undefined : speedRange(selected);
      if (!nextRange) return;
      selectedRange = nextRange;
    }
    return;
  }
  let cleanup: (() => void) | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const stop = () => done(undefined);
      cleanup = () => signal.removeEventListener("abort", stop);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const component = createSpeedComponent(
        history,
        range,
        theme,
        () => tui.requestRender(),
        stop,
        () => tui.terminal.rows,
      );
      component.dispose = cleanup;
      return component;
    });
  } finally {
    cleanup?.();
  }
}
