/**
 * Config file handling: parse, validate, and persist the layout.
 *
 * Validation is forgiving on purpose — a typo in one item should cost the user
 * that item and a warning, not the whole statusline. Anything unrecognised is
 * dropped and reported through `warnings`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./defaults.ts";
import { sanitizeLiteral } from "./format.ts";
import {
  CWD_STYLES,
  ITEM_COLORS,
  ITEM_TYPES,
  type ItemConfig,
  type ItemType,
  type StatuslineConfig,
  TIME_FORMATS,
} from "./types.ts";

export const CONFIG_FILE_NAME = "statusline.json";

const MAX_SEPARATOR_CHARS = 5;

export interface LoadedConfig {
  config: StatuslineConfig;
  path: string;
  warnings: string[];
}

export function configPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

export function loadConfig(path = configPath()): LoadedConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { config: defaultConfig(), path, warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      config: defaultConfig(),
      path,
      warnings: [`${CONFIG_FILE_NAME} is not valid JSON (${reason}); using defaults`],
    };
  }

  const { config, warnings } = validateConfig(parsed);
  return { config, path, warnings };
}

export function saveConfig(config: StatuslineConfig, path = configPath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/**
 * Coerce arbitrary parsed JSON into a usable config.
 *
 * Empty lines are preserved here rather than pruned: an empty line in the
 * config is a line the user is mid-way through building in the editor. Lines
 * that render to nothing are dropped at render time instead.
 */
export function validateConfig(input: unknown): {
  config: StatuslineConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!isRecord(input)) {
    return { config: defaultConfig(), warnings: ["config root is not an object; using defaults"] };
  }

  if (input.version !== undefined && input.version !== 1) {
    warnings.push(`unknown config version ${JSON.stringify(input.version)}; reading as version 1`);
  }

  const groupGap = clampInteger(input.groupGap, 2, 0, 40);

  const rawLines = input.lines;
  if (!Array.isArray(rawLines)) {
    return {
      config: { ...defaultConfig(), groupGap },
      warnings: [...warnings, "config.lines is missing or not an array; using default layout"],
    };
  }

  const lines: ItemConfig[][] = [];
  for (const [lineIndex, rawLine] of rawLines.entries()) {
    if (!Array.isArray(rawLine)) {
      warnings.push(`line ${lineIndex + 1} is not an array; skipped`);
      continue;
    }
    const line: ItemConfig[] = [];
    for (const [itemIndex, rawItem] of rawLine.entries()) {
      const where = `line ${lineIndex + 1} item ${itemIndex + 1}`;
      const item = validateItem(rawItem, where, warnings);
      if (item) line.push(item);
    }
    lines.push(line);
  }

  return { config: { version: 1, groupGap, lines }, warnings };
}

function validateItem(input: unknown, where: string, warnings: string[]): ItemConfig | undefined {
  // A bare string is accepted as shorthand for `{ "type": "<string>" }`.
  const record = typeof input === "string" ? { type: input } : input;
  if (!isRecord(record)) {
    warnings.push(`${where} is not an object; skipped`);
    return undefined;
  }

  const type = record.type;
  if (typeof type !== "string" || !isItemType(type)) {
    warnings.push(`${where} has unknown type ${JSON.stringify(type)}; skipped`);
    return undefined;
  }

  const item: Record<string, unknown> = { type };
  copyString(record, item, "icon");
  copyString(record, item, "prefix");
  copyString(record, item, "suffix");
  // Checked against the palette rather than copied: `theme.fg` throws on an
  // unknown color, and that throw happens inside the footer's render, which
  // pi treats as fatal. A typo here must cost the color, not the session.
  if (record.color !== undefined) {
    if (record.color === "auto" || isOneOf(record.color, ITEM_COLORS)) item.color = record.color;
    else warnings.push(`${where} has unknown color ${JSON.stringify(record.color)}; ignored`);
  }
  copyBoolean(record, item, "bold");
  copyBoolean(record, item, "hidden");
  if (typeof record.priority === "number" && Number.isFinite(record.priority)) {
    item.priority = record.priority;
  }

  switch (type) {
    case "cwd":
      if (isOneOf(record.style, CWD_STYLES)) item.style = record.style;
      break;
    case "model":
      copyBoolean(record, item, "short");
      break;
    case "provider":
      copyBoolean(record, item, "onlyWhenMultiple");
      break;
    case "thinking":
      copyBoolean(record, item, "onlyWhenSupported");
      break;
    case "context":
      copyBoolean(record, item, "showBar");
      copyBoolean(record, item, "showGauge");
      copyBoolean(record, item, "showPercent");
      copyBoolean(record, item, "showTokens");
      copyBoolean(record, item, "showWindow");
      copyBoolean(record, item, "percentAfterWindow");
      copyBoolean(record, item, "percentParens");
      copyBoolean(record, item, "threshold");
      copyBoolean(record, item, "hideWhenZero");
      if (record.barWidth !== undefined) item.barWidth = clampInteger(record.barWidth, 8, 1, 40);
      // Padding is the point of `" / "`, so this keeps its spaces where the
      // general string copy would be free to keep anything.
      if (typeof record.windowSeparator === "string") {
        const separator = sanitizeLiteral(record.windowSeparator);
        item.windowSeparator = separator.slice(0, MAX_SEPARATOR_CHARS);
      }
      break;
    case "time":
      if (isOneOf(record.format, TIME_FORMATS)) item.format = record.format;
      break;
    case "text":
      if (typeof record.text !== "string") {
        warnings.push(`${where} is a text item without "text"; skipped`);
        return undefined;
      }
      item.text = sanitizeLiteral(record.text);
      break;
    case "sep": {
      copyString(record, item, "text");
      // Separators are structural: the renderer emits their text verbatim, so
      // decoration would be a silent no-op rather than a subtle effect.
      const ignored = ["icon", "prefix", "suffix"].filter((key) => item[key] !== undefined);
      if (ignored.length > 0) {
        warnings.push(`${where} is a separator; ${ignored.join(", ")} ignored`);
        for (const key of ignored) delete item[key];
      }
      break;
    }
    case "slot": {
      const id = typeof record.id === "string" ? sanitizeLiteral(record.id) : "";
      if (id.length === 0) {
        warnings.push(`${where} is a slot item without "id"; skipped`);
        return undefined;
      }
      item.id = id;
      break;
    }
    case "extensions":
      if (isStringArray(record.include)) item.include = [...record.include];
      if (isStringArray(record.exclude)) item.exclude = [...record.exclude];
      if (isRecord(record.icons)) {
        const icons: Record<string, string> = {};
        for (const [key, value] of Object.entries(record.icons)) {
          if (typeof value === "string") icons[key] = sanitizeLiteral(value);
        }
        item.icons = icons;
      }
      copyString(record, item, "separator");
      break;
    default:
      break;
  }

  return item as unknown as ItemConfig;
}

function isItemType(value: string): value is ItemType {
  return (ITEM_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Every string this copies is display text, so all of them lose control codes. */
function copyString(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
  if (typeof from[key] === "string") to[key] = sanitizeLiteral(from[key]);
}

function copyBoolean(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  key: string,
): void {
  if (typeof from[key] === "boolean") to[key] = from[key];
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
