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
import {
  MIN_OUTPUT_TOKENS,
  parseStreamMeasurement,
  type StreamMeasurement,
} from "./measurement.ts";

const DAY_MS = 24 * 60 * 60_000;
const DAY_LABELS = ["24h", ...Array.from({ length: 6 }, (_, i) => `${i + 2}d`)];

export interface SpeedDay {
  samples: number;
  medianRate?: number;
}

export interface SpeedRow {
  provider: string;
  model: string;
  days: SpeedDay[];
}

export interface SpeedReport {
  since: number;
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

type SpeedSample = Pick<NormalizedCall, "stopReason" | "stream">;

function rate(call: SpeedSample): number {
  const stream = call.stream as StreamMeasurement;
  return stream.outputTokens / (stream.durationMs / 1_000);
}

function exclusion(call: SpeedSample): "unsuccessful" | "untimed" | "noOutput" | undefined {
  if (call.stopReason !== "stop" && call.stopReason !== "toolUse") return "unsuccessful";
  if (
    call.stream &&
    (!positive(call.stream.outputTokens) || call.stream.outputTokens < MIN_OUTPUT_TOKENS)
  )
    return "noOutput";
  if (!parseStreamMeasurement(call.stream)) return "untimed";
  if (!positive(rate(call))) return "noOutput";
  return undefined;
}

/** Keep the session status and historical report on the same measured-request definition. */
export function medianRequestRate(calls: SpeedSample[]): number | undefined {
  return median(calls.filter((call) => !exclusion(call)).map(rate));
}

/** Freeze all seven rolling days to the same history load, without mixing provider routes. */
export function deriveSpeedReport(history: LoadedHistory): SpeedReport {
  const since = history.now - DAY_LABELS.length * DAY_MS;
  const coverage: SpeedReport["coverage"] = {
    assistants: 0,
    observed: 0,
    unsuccessful: 0,
    untimed: 0,
    noOutput: 0,
  };
  const groups = new Map<string, { provider: string; model: string; rates: number[][] }>();
  for (const call of history.calls) {
    const at = call.timestamp;
    if (
      call.kind !== "assistant" ||
      at === undefined ||
      !Number.isFinite(at) ||
      at < since ||
      at > history.now
    )
      continue;
    coverage.assistants += 1;
    const excluded = exclusion(call);
    if (excluded) {
      coverage[excluded] += 1;
      continue;
    }
    coverage.observed += 1;
    const key = JSON.stringify([call.provider, call.model]);
    let group = groups.get(key);
    if (!group) {
      group = {
        provider: call.provider,
        model: call.model,
        rates: DAY_LABELS.map(() => []),
      };
      groups.set(key, group);
    }
    // Assign shared boundaries to the newer bucket without counting a request twice.
    const day = Math.max(0, Math.ceil((history.now - at) / DAY_MS) - 1);
    (group.rates[day] as number[]).push(rate(call));
  }
  const rows = [...groups.values()].map(({ provider, model, rates }) => ({
    provider,
    model,
    days: rates.map((values) => ({ samples: values.length, medianRate: median(values) })),
  }));
  rows.sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider));
  const warnings = new Map<string, number>();
  for (const warning of history.warnings) {
    if (warning.code === "malformed-snapshot" || warning.code === "imprecise-gap-timing") continue;
    const times =
      warning.timestamps ?? (warning.timestamp === undefined ? [] : [warning.timestamp]);
    if (times.length && !times.some((at) => at >= since && at <= history.now)) continue;
    warnings.set(warning.code, (warnings.get(warning.code) ?? 0) + 1);
  }
  return {
    since,
    now: history.now,
    rows,
    coverage,
    warnings: [...warnings].map(([code, count]) => `${code} (${count})`),
  };
}

function number(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? "—"
    : value
        .toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        .replaceAll(",", " ");
}

function label(value: string): string {
  return sanitizeDisplayText(value, 80) || "—";
}

function cell(value: string, width: number): string {
  const cut = truncateToWidth(value, width, "");
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

function speedTable(report: SpeedReport): string[] {
  const modelCounts = new Map<string, number>();
  for (const row of report.rows) {
    modelCounts.set(row.model, (modelCounts.get(row.model) ?? 0) + 1);
  }
  const values = [
    ["Model", ...DAY_LABELS],
    ...report.rows.map((row) => [
      (modelCounts.get(row.model) as number) > 1
        ? `${label(row.model)} (${label(row.provider)})`
        : label(row.model),
      ...row.days.map((day) => number(day.medianRate)),
    ]),
  ];
  const widths = (values[0] as string[]).map((value) => Math.max(5, visibleWidth(value)));
  for (const row of values) {
    for (let index = 0; index < widths.length; index += 1) {
      widths[index] = Math.max(widths[index] as number, visibleWidth(row[index] as string));
    }
  }
  return values.map((row) =>
    row.map((value, index) => cell(value, widths[index] as number)).join(" "),
  );
}

const EMPTY_MESSAGE = "No measured requests in the last seven days";

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
    ...table.map((line) => sliceByColumn(line, pan, width)),
    ...(report.rows.length === 0 ? [EMPTY_MESSAGE] : []),
  ].map((line) => truncateToWidth(line, width, ""));
}

export function createSpeedComponent(
  history: LoadedHistory,
  theme: Pick<Theme, "fg">,
  requestRender: () => void,
  done: () => void,
  height: () => number,
): Component & { dispose?: () => void } {
  const report = deriveSpeedReport(history);
  const table = speedTable(report);
  let scroll = 0;
  let pan = 0;
  const contentLength = Math.max(1, report.rows.length);
  let viewport = 0;
  let maxPan = 0;
  return {
    render(width) {
      const panelHeight = Math.max(0, Math.min(20, Math.floor(height())));
      if (width <= 0 || panelHeight === 0) return [];
      maxPan = Math.max(0, visibleWidth(table[0] as string) - width);
      pan = Math.min(pan, maxPan);
      const headers = [sliceByColumn(table[0] as string, pan, width)];
      const hint = panelHeight >= 4;
      viewport = Math.max(0, panelHeight - headers.length - (hint ? 2 : 0));
      scroll = Math.min(scroll, Math.max(0, contentLength - viewport));
      const content =
        report.rows.length === 0
          ? [EMPTY_MESSAGE]
          : table.slice(1).map((line) => sliceByColumn(line, pan, width));
      const lines = [...headers.slice(0, panelHeight), ...content.slice(scroll, scroll + viewport)];
      if (hint) lines.push("", theme.fg("dim", "←→ columns · ↑↓/PgUp/PgDn rows · Esc close"));
      return lines.map((line) => truncateToWidth(line, width, ""));
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
      else if (matchesKey(data, "left") || matchesKey(data, "shift+left"))
        pan = Math.max(0, pan - 8);
      else if (matchesKey(data, "right") || matchesKey(data, "shift+right"))
        pan = Math.min(maxPan, pan + 8);
      else return;
      requestRender();
    },
    invalidate() {},
  };
}

export async function showSpeedReport(
  ctx: ExtensionCommandContext,
  history: LoadedHistory,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (ctx.mode !== "tui") {
    await ctx.ui.select(speedReportLines(deriveSpeedReport(history), 140).join("\n"), ["Close"], {
      signal,
      [Symbol.for("pi-extensions:input-dialog")]: false,
    });
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
