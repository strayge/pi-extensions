/**
 * Display config: presets, validation, and persistence for `usage.json`.
 *
 * Validation is forgiving on purpose — a typo in one key should cost the user
 * that key and a warning, not the whole display. Anything unrecognised falls
 * back to the preset value and is reported through `warnings`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  UsageBucketMode,
  UsageDisplayConfig,
  UsageField,
  UsagePresetName,
  UsageStatuslineOptions,
  UsageSurfaceOptions,
  UsageValueMode,
} from "./types.ts";

export const CONFIG_FILE_NAME = "usage.json";

export const USAGE_FIELDS: readonly UsageField[] = [
  "window",
  "bar",
  "percent",
  "reset",
  "projection",
];
export const BUCKET_MODES: readonly UsageBucketMode[] = ["auto", "primary", "all"];
export const VALUE_MODES: readonly UsageValueMode[] = ["used", "remaining"];
export const PRESET_NAMES: readonly UsagePresetName[] = [
  "legacy",
  "minimal",
  "compact",
  "full",
  "custom",
];

const MIN_BAR_WIDTH = 1;
const MAX_BAR_WIDTH = 40;
const MAX_SEPARATOR_CHARS = 5;

export const DEFAULT_PRESET: UsagePresetName = "compact";

type PresetName = Exclude<UsagePresetName, "custom">;

/**
 * `legacy` reproduces the statusline this extension shipped before the display
 * options existed. The report still gains the relative countdown: it has the
 * room, and there was never a reason to withhold it there.
 */
const PRESETS: Record<PresetName, Omit<UsageDisplayConfig, "version" | "preset">> = {
  legacy: {
    value: "remaining",
    spacedDuration: true,
    statusline: {
      fields: ["percent", "window"],
      buckets: "all",
      barWidth: 8,
      paceMarker: false,
      separator: " ",
    },
    report: { fields: ["bar", "percent", "reset"], barWidth: 20, paceMarker: false },
  },
  minimal: {
    value: "used",
    spacedDuration: true,
    statusline: {
      fields: ["percent", "reset"],
      buckets: "primary",
      barWidth: 8,
      paceMarker: false,
      separator: " · ",
    },
    report: { fields: ["bar", "percent", "reset"], barWidth: 20, paceMarker: true },
  },
  compact: {
    value: "used",
    spacedDuration: true,
    statusline: {
      fields: ["bar", "percent", "reset"],
      buckets: "auto",
      barWidth: 8,
      paceMarker: true,
      separator: " · ",
    },
    report: { fields: ["bar", "percent", "reset", "projection"], barWidth: 20, paceMarker: true },
  },
  full: {
    value: "used",
    spacedDuration: true,
    statusline: {
      fields: ["window", "bar", "percent", "reset"],
      buckets: "all",
      barWidth: 8,
      paceMarker: true,
      separator: " · ",
    },
    report: { fields: ["bar", "percent", "reset", "projection"], barWidth: 20, paceMarker: true },
  },
};

export interface LoadedDisplayConfig {
  config: UsageDisplayConfig;
  path: string;
  warnings: string[];
  /** False when the file was missing or unreadable and a preset was used. */
  fromFile: boolean;
}

export function configPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

export function presetConfig(name: UsagePresetName): UsageDisplayConfig {
  const resolved: PresetName = name === "custom" ? (DEFAULT_PRESET as PresetName) : name;
  const preset = PRESETS[resolved];
  return {
    version: 1,
    preset: resolved,
    value: preset.value,
    spacedDuration: preset.spacedDuration,
    statusline: { ...preset.statusline, fields: [...preset.statusline.fields] },
    report: { ...preset.report, fields: [...preset.report.fields] },
  };
}

export function defaultDisplayConfig(): UsageDisplayConfig {
  return presetConfig(DEFAULT_PRESET);
}

/** The preset this config reproduces, or `custom` once anything diverges. */
export function matchingPreset(config: UsageDisplayConfig): UsagePresetName {
  for (const name of Object.keys(PRESETS) as PresetName[]) {
    if (sameDisplay(config, presetConfig(name))) return name;
  }
  return "custom";
}

export function loadDisplayConfig(path = configPath()): LoadedDisplayConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { config: defaultDisplayConfig(), path, warnings: [], fromFile: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      config: defaultDisplayConfig(),
      path,
      warnings: [`${CONFIG_FILE_NAME} is not valid JSON (${reason}); using defaults`],
      fromFile: false,
    };
  }

  const { config, warnings } = validateDisplayConfig(parsed);
  return { config, path, warnings, fromFile: true };
}

export function saveDisplayConfig(config: UsageDisplayConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const stored: UsageDisplayConfig = { ...config, preset: matchingPreset(config) };
  writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/**
 * Coerce arbitrary parsed JSON into a usable config.
 *
 * `preset` picks the baseline; every other key overrides it. A file naming only
 * a preset therefore tracks that preset's definition rather than freezing a copy
 * of today's fields.
 */
export function validateDisplayConfig(input: unknown): {
  config: UsageDisplayConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!isRecord(input)) {
    return {
      config: defaultDisplayConfig(),
      warnings: ["config root is not an object; using defaults"],
    };
  }

  if (input.version !== undefined && input.version !== 1) {
    warnings.push(`unknown config version ${JSON.stringify(input.version)}; reading as version 1`);
  }

  let baseline = DEFAULT_PRESET;
  if (input.preset !== undefined) {
    if (isOneOf(input.preset, PRESET_NAMES)) baseline = input.preset;
    else warnings.push(`unknown preset ${JSON.stringify(input.preset)}; using ${DEFAULT_PRESET}`);
  }
  const config = presetConfig(baseline);

  if (input.value !== undefined) {
    if (isOneOf(input.value, VALUE_MODES)) config.value = input.value;
    else
      warnings.push(`unknown value mode ${JSON.stringify(input.value)}; keeping ${config.value}`);
  }
  if (input.spacedDuration !== undefined) {
    if (typeof input.spacedDuration === "boolean") config.spacedDuration = input.spacedDuration;
    else warnings.push("spacedDuration is not a boolean; ignored");
  }

  config.statusline = validateStatusline(input.statusline, config.statusline, warnings);
  config.report = validateSurface(input.report, config.report, "report", warnings);
  config.preset = matchingPreset(config);
  return { config, warnings };
}

function validateStatusline(
  input: unknown,
  fallback: UsageStatuslineOptions,
  warnings: string[],
): UsageStatuslineOptions {
  const surface = validateSurface(input, fallback, "statusline", warnings);
  const result: UsageStatuslineOptions = {
    ...surface,
    buckets: fallback.buckets,
    separator: fallback.separator,
  };
  if (!isRecord(input)) return result;

  if (input.buckets !== undefined) {
    if (isOneOf(input.buckets, BUCKET_MODES)) result.buckets = input.buckets;
    else warnings.push(`statusline.buckets ${JSON.stringify(input.buckets)} is unknown; ignored`);
  }
  if (input.separator !== undefined) {
    if (typeof input.separator === "string") result.separator = sanitizeSeparator(input.separator);
    else warnings.push("statusline.separator is not a string; ignored");
  }
  return result;
}

function validateSurface(
  input: unknown,
  fallback: UsageSurfaceOptions,
  where: string,
  warnings: string[],
): UsageSurfaceOptions {
  const result: UsageSurfaceOptions = { ...fallback, fields: [...fallback.fields] };
  if (input === undefined) return result;
  if (!isRecord(input)) {
    warnings.push(`${where} is not an object; using preset values`);
    return result;
  }

  if (input.fields !== undefined) {
    if (Array.isArray(input.fields)) {
      const fields: UsageField[] = [];
      for (const candidate of input.fields) {
        if (!isOneOf(candidate, USAGE_FIELDS)) {
          warnings.push(`${where}.fields has unknown entry ${JSON.stringify(candidate)}; skipped`);
          continue;
        }
        if (!fields.includes(candidate)) fields.push(candidate);
      }
      result.fields = fields;
    } else {
      warnings.push(`${where}.fields is not an array; using preset fields`);
    }
  }

  if (input.barWidth !== undefined) {
    if (typeof input.barWidth === "number" && Number.isFinite(input.barWidth)) {
      result.barWidth = Math.min(
        MAX_BAR_WIDTH,
        Math.max(MIN_BAR_WIDTH, Math.round(input.barWidth)),
      );
    } else {
      warnings.push(`${where}.barWidth is not a number; ignored`);
    }
  }

  if (input.paceMarker !== undefined) {
    if (typeof input.paceMarker === "boolean") result.paceMarker = input.paceMarker;
    else warnings.push(`${where}.paceMarker is not a boolean; ignored`);
  }

  return result;
}

/**
 * Separators are padding as much as glyph, so the surrounding spaces have to
 * survive: the general display sanitizer trims and collapses whitespace, which
 * would turn `" · "` into `"·"` and run the cells together.
 */
function sanitizeSeparator(value: string): string {
  const printable = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("");
  return printable.slice(0, MAX_SEPARATOR_CHARS) || " ";
}

export function clampBarWidth(value: number): number {
  return Math.min(MAX_BAR_WIDTH, Math.max(MIN_BAR_WIDTH, Math.round(value)));
}

function sameDisplay(left: UsageDisplayConfig, right: UsageDisplayConfig): boolean {
  return (
    left.value === right.value &&
    left.spacedDuration === right.spacedDuration &&
    left.statusline.buckets === right.statusline.buckets &&
    left.statusline.separator === right.statusline.separator &&
    sameSurface(left.statusline, right.statusline) &&
    sameSurface(left.report, right.report)
  );
}

function sameSurface(left: UsageSurfaceOptions, right: UsageSurfaceOptions): boolean {
  return (
    left.barWidth === right.barWidth &&
    left.paceMarker === right.paceMarker &&
    left.fields.length === right.fields.length &&
    left.fields.every((field, index) => field === right.fields[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
