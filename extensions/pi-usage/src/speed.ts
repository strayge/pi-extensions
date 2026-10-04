import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
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
  thinkingLevel?: string;
  inferred: boolean;
  samples: number;
  previousSamples: number;
  medianRate?: number;
  medianSeconds?: number;
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

function rate(call: NormalizedCall): number {
  return call.usage.output / ((call.durationMs as number) / 1_000);
}

function exclusion(call: NormalizedCall): "unsuccessful" | "untimed" | "noOutput" | undefined {
  if (call.stopReason !== "stop" && call.stopReason !== "toolUse") return "unsuccessful";
  if (!positive(call.durationMs)) return "untimed";
  if (!positive(call.usage.output) || !positive(rate(call))) return "noOutput";
  return undefined;
}

function rowKey(call: NormalizedCall): string {
  return JSON.stringify([
    call.provider,
    call.model,
    call.thinkingLevel ?? null,
    call.thinkingLevelInferred === true,
  ]);
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
    { row: SpeedRow; current: NormalizedCall[]; previous: NormalizedCall[]; active: boolean }
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
    const key = rowKey(call);
    let group = groups.get(key);
    if (!group) {
      group = {
        row: {
          provider: call.provider,
          model: call.model,
          thinkingLevel: call.thinkingLevel,
          inferred: call.thinkingLevelInferred === true,
          samples: 0,
          previousSamples: 0,
          changes: [],
        },
        current: [],
        previous: [],
        active: false,
      };
      groups.set(key, group);
    }
    const excluded = exclusion(call);
    if (at >= since) {
      group.active = true;
      coverage.assistants += 1;
      if (excluded) coverage[excluded] += 1;
      else coverage.observed += 1;
      // Retain rows with missing observations so coverage is not mistaken for no activity.
      if (!excluded) group.current.push(call);
    } else if (!excluded) group.previous.push(call);
  }
  const rows: SpeedRow[] = [];
  for (const group of groups.values()) {
    if (!group.active) continue;
    const { row, current, previous } = group;
    row.samples = current.length;
    row.previousSamples = previous.length;
    row.medianRate = median(current.map(rate));
    row.medianSeconds = median(current.map((call) => (call.durationMs as number) / 1_000));
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
  rows.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model) ||
      (a.thinkingLevel ?? "").localeCompare(b.thinkingLevel ?? "") ||
      Number(a.inferred) - Number(b.inferred),
  );
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

function number(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(1);
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
  const effortWidth = report.rows.reduce(
    (width, row) =>
      Math.max(
        width,
        Math.min(16, visibleWidth(label(row.thinkingLevel ?? "unknown")) + Number(row.inferred)),
      ),
    7,
  );
  const values = [
    ["Provider/model", "Effort", "N now/prev", "tok/s", "Request s", "Trend"],
    ...report.rows.map((row) => [
      label(`${row.provider}/${row.model}`),
      `${truncateToWidth(label(row.thinkingLevel ?? "unknown"), effortWidth - Number(row.inferred), "")}${row.inferred ? "*" : ""}`,
      `${row.samples}/${row.previousSamples}`,
      number(row.medianRate),
      number(row.medianSeconds),
      speedTrend(row.changes),
    ]),
  ];
  const widths = [routeWidth, effortWidth, 11, 9, 9, 12];
  for (const row of values) {
    for (let index = 2; index < widths.length; index += 1) {
      widths[index] = Math.max(widths[index] as number, visibleWidth(row[index] as string));
    }
  }
  return values.map((row) =>
    row.map((value, index) => cell(value, widths[index] as number)).join(" "),
  );
}

/** Keep a single table even on narrow terminals; horizontal navigation reveals clipped columns. */
export function speedReportLines(
  report: SpeedReport,
  width: number,
  horizontalOffset = 0,
): string[] {
  const boundedWidth = Math.max(1, width);
  const table = speedTable(report);
  const maxPan = Math.max(0, visibleWidth(table[0] as string) - boundedWidth);
  const pan = Math.min(Math.max(0, horizontalOffset), maxPan);
  const wrap = (text: string) => wrapTextWithAnsi(text, boundedWidth);
  const c = report.coverage;
  return [
    ...wrap(`Speed · ${report.range} vs previous ${report.range} · discoverable project histories`),
    ...table.map((line) => sliceByColumn(line, pan, boundedWidth)),
    ...(report.rows.length === 0 ? wrap("No assistant requests in selected period") : []),
    ...wrap(
      `Coverage (now): ${c.observed}/${c.assistants} observed · ${c.unsuccessful} unsuccessful · ${c.untimed} untimed · ${c.noOutput} no usable output`,
    ),
    ...wrap(
      "N: observed now/previous. Medians: effective output tok/s (includes reasoning), approximate whole request seconds; excludes tool execution.",
    ),
    ...wrap(
      "* inferred requested effort (separate rows); unknown stays unknown. Trend: descriptive cohort median % changes, min…max (cohort count); ≥10 requests each period. Not generation speed or statistical confidence.",
    ),
    ...(report.warnings.length
      ? wrap(`Warnings (comparison period or unscoped): ${report.warnings.join(", ")}`)
      : []),
  ].map((line) => truncateToWidth(line, boundedWidth, ""));
}

export function createSpeedComponent(
  report: SpeedReport,
  theme: Pick<Theme, "fg">,
  requestRender: () => void,
  done: () => void,
  height: () => number,
): Component & { dispose?: () => void } {
  let scroll = 0;
  let pan = 0;
  let contentLength = 0;
  let viewport = 1;
  let maxPan = 0;
  const tableWidth = visibleWidth(speedTable(report)[0] as string);
  return {
    render(width) {
      maxPan = Math.max(0, tableWidth - Math.max(1, width));
      pan = Math.min(pan, maxPan);
      const content = speedReportLines(report, width, pan);
      contentLength = content.length;
      const panelHeight = Math.max(1, Math.min(20, height()));
      viewport = Math.max(1, panelHeight - 1);
      scroll = Math.min(scroll, Math.max(0, contentLength - viewport));
      const lines = content.slice(scroll, scroll + viewport);
      if (panelHeight > 1)
        lines.push(
          theme.fg(
            "dim",
            `↑↓/PgUp/PgDn scroll · ←→ columns · Esc close (${scroll + 1}/${contentLength})`,
          ),
        );
      return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
    },
    handleInput(data) {
      if (matchesKey(data, "escape")) {
        done();
        return;
      }
      if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
      else if (matchesKey(data, "down"))
        scroll = Math.min(Math.max(0, contentLength - viewport), scroll + 1);
      else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - viewport);
      else if (matchesKey(data, "pageDown"))
        scroll = Math.min(Math.max(0, contentLength - viewport), scroll + viewport);
      else if (matchesKey(data, "left")) pan = Math.max(0, pan - 8);
      else if (matchesKey(data, "right")) pan = Math.min(maxPan, pan + 8);
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
  const report = deriveSpeedReport(history, range);
  if (ctx.mode !== "tui") {
    await ctx.ui.select(speedReportLines(report, 140).join("\n"), ["Close"], { signal });
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
        report,
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
