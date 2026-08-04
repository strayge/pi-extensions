/**
 * The `/usage` display-options screen.
 *
 * `ui.select` takes plain strings with no room for a description, so each entry
 * names its setting and that setting's current value — `Show: used`. Enter
 * advances to the next value and the menu redraws in place.
 *
 * The title holds a live preview, re-rendered from the pending config after
 * every keypress, which is what makes cycling legible: the effect of a value
 * shows up immediately above the list rather than being named in the label.
 */

import {
  type ExtensionCommandContext,
  getSettingsListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, TruncatedText } from "@earendil-works/pi-tui";
import { clampBarWidth, matchingPreset, presetConfig, USAGE_FIELDS } from "./config.ts";
import { formatReportCell, formatUsageStatusline } from "./format.ts";
import { sampleUsageReport } from "./sample.ts";
import type {
  UsageBucketMode,
  UsageDisplayConfig,
  UsageField,
  UsageModel,
  UsagePresetName,
  UsageReport,
  UsageSurfaceOptions,
} from "./types.ts";

const BACK = "Back";

const PRESET_VALUES: UsagePresetName[] = ["legacy", "minimal", "compact", "full"];
const BUCKET_VALUES: UsageBucketMode[] = ["auto", "primary", "all"];
const BAR_WIDTH_VALUES = [4, 6, 8, 10, 12, 16, 20];
const ON_OFF = ["on", "off"];

type QuotaMode = "bar+%" | "% only" | "bar only" | "off";
const QUOTA_VALUES: QuotaMode[] = ["bar+%", "% only", "bar only", "off"];

type PanelTheme = Pick<Theme, "fg" | "bold">;

/**
 * One row of the display menu.
 *
 * Exported along with `buildSettings` because the statusline slot schema is
 * generated from the same list: the two editors then cannot disagree about what
 * a setting is called, what it may be set to, or how far a change reaches.
 */
export interface Setting {
  id: string;
  name: string;
  description?: string;
  current: (config: UsageDisplayConfig) => string;
  /** Cycled in order; a value outside the list (`custom`) lands on the first. */
  values: readonly string[];
  apply: (config: UsageDisplayConfig, value: string) => UsageDisplayConfig;
}

export interface DisplayMenuOptions {
  config: UsageDisplayConfig;
  /** Persists and applies the change; returns the config actually stored. */
  save: (config: UsageDisplayConfig) => UsageDisplayConfig;
  report?: UsageReport;
  model?: UsageModel;
  signal: AbortSignal;
  configPath: string;
}

export async function showDisplayMenu(
  ctx: ExtensionCommandContext,
  options: DisplayMenuOptions,
): Promise<void> {
  if (ctx.mode === "tui") return showDisplayPanel(ctx, options);
  return showDisplaySelect(ctx, options);
}

/**
 * A live settings panel: the cursor stays on the row being changed, and every
 * row is refreshed after each change because settings are not independent —
 * cycling `Preset` rewrites all of them, and changing any of the others moves
 * `Preset` to `custom`.
 */
async function showDisplayPanel(
  ctx: ExtensionCommandContext,
  options: DisplayMenuOptions,
): Promise<void> {
  let config = options.config;
  const settings = buildSettings();

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const header = new Container();
    // Rebuilt rather than reflowed: the preview lines are truncated to the
    // width they are given, so a narrow terminal clips them instead of wrapping
    // a bar onto a second row.
    const paintHeader = () => {
      header.clear();
      for (const line of previewLines(config, options, theme)) {
        header.addChild(new TruncatedText(line, 1, 0));
      }
    };
    paintHeader();
    container.addChild(header);

    const list = new SettingsList(
      settings.map((setting) => ({
        id: setting.id,
        label: setting.name,
        description: setting.description,
        currentValue: setting.current(config),
        values: [...setting.values],
      })),
      Math.min(settings.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        const changed = settings.find((setting) => setting.id === id);
        if (!changed) return;
        config = options.save(changed.apply(config, value));
        for (const setting of settings) list.updateValue(setting.id, setting.current(config));
        paintHeader();
        container.invalidate();
        tui.requestRender();
      },
      () => done(undefined),
    );
    container.addChild(list);

    const stop = () => done(undefined);
    options.signal.addEventListener("abort", stop, { once: true });

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput?.(data),
      dispose: () => options.signal.removeEventListener("abort", stop),
    };
  });
}

/** Non-TUI fallback: one dialog per change, cycling the chosen setting. */
async function showDisplaySelect(
  ctx: ExtensionCommandContext,
  options: DisplayMenuOptions,
): Promise<void> {
  let config = options.config;
  const settings = buildSettings();

  while (!options.signal.aborted) {
    const entries = settings.map((setting) => `${setting.name}: ${setting.current(config)}`);
    const choice = await ctx.ui.select(
      plainPreview(config, options).join("\n"),
      [...entries, BACK],
      { signal: options.signal },
    );
    if (!choice || choice === BACK) return;

    const setting = settings[entries.indexOf(choice)];
    if (!setting) return;
    config = options.save(setting.apply(config, nextValue(setting, config)));
  }
}

function nextValue(setting: Setting, config: UsageDisplayConfig): string {
  const values = setting.values;
  const index = values.indexOf(setting.current(config));
  return values[(index + 1) % values.length] ?? (values[0] as string);
}

function plainPreview(config: UsageDisplayConfig, options: DisplayMenuOptions): string[] {
  const now = Date.now();
  const report = previewReport(options.report, now);
  const statusline =
    formatUsageStatusline(report, options.model, config, now) ?? "(nothing to show)";
  const bucket = report.buckets[0];
  const reportLine = bucket ? formatReportCell(bucket, config, now) : "(nothing to show)";
  return [
    `Usage display · ${options.configPath}`,
    "",
    `Statusline:  ${statusline}`,
    `Report:      ${reportLine}`,
  ];
}

/**
 * Styled per line, not per block: a reset inside one line would otherwise
 * cancel the styling of everything after it.
 */
function previewLines(
  config: UsageDisplayConfig,
  options: DisplayMenuOptions,
  theme: PanelTheme,
): string[] {
  const [path, blank, statusline, report] = plainPreview(config, options);
  return [
    theme.fg("accent", theme.bold(path ?? "")),
    blank ?? "",
    theme.fg("dim", statusline ?? ""),
    theme.fg("dim", report ?? ""),
    "",
  ];
}

/**
 * A live report is only usable as a preview when it has a bucket to draw; the
 * credits-only and error cases fall back to the sample.
 */
function previewReport(report: UsageReport | undefined, now: number): UsageReport {
  return report && report.buckets.length > 0 ? report : sampleUsageReport(now);
}

export function buildSettings(): Setting[] {
  return [
    {
      id: "preset",
      name: "Preset",
      description: "Sets every option below at once; reads custom once one diverges",
      current: (config) => matchingPreset(config),
      values: PRESET_VALUES,
      apply: (_config, value) => presetConfig(value as UsagePresetName),
    },
    {
      id: "value",
      name: "Show",
      description: "Whether percentages name the quota spent or the quota left",
      current: (config) => config.value,
      values: ["used", "remaining"],
      apply: (config, value) => ({ ...config, value: value === "used" ? "used" : "remaining" }),
    },
    {
      id: "reset-time",
      name: "Reset time",
      description: "Time until the window resets; hidden while no window is running",
      current: (config) => onOff(hasField(config.statusline, "reset")),
      values: ON_OFF,
      apply: (config, value) => setFieldEverywhere(config, "reset", value === "on"),
    },
    {
      id: "time-spacing",
      name: "Time spacing",
      current: (config) => (config.spacedDuration ? "3h 12m" : "3h12m"),
      values: ["3h 12m", "3h12m"],
      apply: (config, value) => ({ ...config, spacedDuration: value === "3h 12m" }),
    },
    {
      id: "pace-marker",
      name: "Pace marker",
      description: "Ticks the bar where the clock stands, to compare against the fill",
      current: (config) => onOff(config.statusline.paceMarker),
      values: ON_OFF,
      apply: (config, value) => {
        const paceMarker = value === "on";
        return {
          ...config,
          statusline: { ...config.statusline, paceMarker },
          report: { ...config.report, paceMarker },
        };
      },
    },
    {
      id: "quota",
      name: "Quota",
      description: "How the quota itself is drawn",
      current: (config) => quotaMode(config.statusline),
      values: QUOTA_VALUES,
      apply: (config, value) => setQuotaMode(config, value as QuotaMode),
    },
    {
      id: "buckets",
      name: "Buckets",
      description: "auto adds the weekly window only when it is on track to run out",
      current: (config) => config.statusline.buckets,
      values: BUCKET_VALUES,
      apply: (config, value) => ({
        ...config,
        statusline: { ...config.statusline, buckets: value as UsageBucketMode },
      }),
    },
    {
      id: "bar-width",
      name: "Bar width",
      current: (config) => String(config.statusline.barWidth),
      values: BAR_WIDTH_VALUES.map(String),
      apply: (config, value) => ({
        ...config,
        statusline: { ...config.statusline, barWidth: clampBarWidth(Number(value)) },
      }),
    },
    {
      // Statusline-only: the report shows the projection whenever it has one,
      // and a control that read "off" while the report below it displayed a
      // projection would be lying about its own state.
      id: "projection",
      name: "Statusline projection",
      description: "When the quota is on track to run out, how long that leaves",
      current: (config) => onOff(hasField(config.statusline, "projection")),
      values: ON_OFF,
      apply: (config, value) => ({
        ...config,
        statusline: {
          ...config.statusline,
          fields: withField(config.statusline.fields, "projection", value === "on"),
        },
      }),
    },
  ];
}

function quotaMode(surface: UsageSurfaceOptions): QuotaMode {
  const bar = hasField(surface, "bar");
  const percent = hasField(surface, "percent");
  if (bar && percent) return "bar+%";
  if (percent) return "% only";
  if (bar) return "bar only";
  return "off";
}

function setQuotaMode(config: UsageDisplayConfig, mode: QuotaMode): UsageDisplayConfig {
  const bar = mode === "bar+%" || mode === "bar only";
  const percent = mode === "bar+%" || mode === "% only";
  return {
    ...config,
    statusline: {
      ...config.statusline,
      fields: withField(withField(config.statusline.fields, "bar", bar), "percent", percent),
    },
    report: {
      ...config.report,
      fields: withField(withField(config.report.fields, "bar", bar), "percent", percent),
    },
  };
}

function setFieldEverywhere(
  config: UsageDisplayConfig,
  field: UsageField,
  present: boolean,
): UsageDisplayConfig {
  return {
    ...config,
    statusline: {
      ...config.statusline,
      fields: withField(config.statusline.fields, field, present),
    },
    report: { ...config.report, fields: withField(config.report.fields, field, present) },
  };
}

function hasField(surface: UsageSurfaceOptions, field: UsageField): boolean {
  return surface.fields.includes(field);
}

/** Adds or removes a field, keeping the canonical left-to-right order. */
function withField(fields: UsageField[], field: UsageField, present: boolean): UsageField[] {
  if (!present) return fields.filter((candidate) => candidate !== field);
  if (fields.includes(field)) return [...fields];
  const wanted = new Set([...fields, field]);
  return USAGE_FIELDS.filter((candidate) => wanted.has(candidate));
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}
