/**
 * The slot schema pi-statusline edits, generated from `/usage`'s own settings.
 *
 * Both editors read one list, so they cannot disagree about what a setting is
 * called, what it may be set to, or how far a change reaches: toggling "reset
 * time" from the statusline moves the `/usage` report exactly as toggling it in
 * `/usage` does, because it is the same `apply`.
 *
 * The scalar kinds are enough because the display menu already proved it —
 * every setting there cycles through a short list of values, the field array
 * included, which is reached through `quota` and `reset time` rather than
 * edited directly.
 */

import { buildSettings, type Setting } from "./display-menu.ts";
import type { SlotFieldSpec, SlotOptions, SlotOptionValue } from "./statusline-slot.ts";
import type { UsageDisplayConfig } from "./types.ts";

const BAR_WIDTH_MIN = 1;
const BAR_WIDTH_MAX = 40;

/** Settings whose values are a yes/no pair read better as a toggle. */
const BOOLEAN_SETTINGS = new Set(["reset-time", "pace-marker", "projection"]);
/** A width is a number, not a list: the menu's steps are a convenience there. */
const NUMBER_SETTINGS = new Set(["bar-width"]);

export function usageSlotFields(): SlotFieldSpec[] {
  return buildSettings().map((setting) => {
    const field: SlotFieldSpec = {
      key: setting.id,
      // Lowercased to sit alongside the statusline's own rows, which read
      // `show bar` and `bar width` rather than `Show bar`.
      label: setting.name.toLowerCase(),
      kind: kindOf(setting),
    };
    if (setting.description) field.description = setting.description;
    if (field.kind === "enum") field.options = [...setting.values];
    if (field.kind === "number") {
      field.min = BAR_WIDTH_MIN;
      field.max = BAR_WIDTH_MAX;
    }
    return field;
  });
}

/** The producer's current values, so an unset field reads as `usage.json` does. */
export function usageSlotDefaults(config: UsageDisplayConfig): SlotOptions {
  const defaults: SlotOptions = {};
  for (const setting of buildSettings()) {
    const current = setting.current(config);
    if (BOOLEAN_SETTINGS.has(setting.id)) defaults[setting.id] = current === "on";
    else if (NUMBER_SETTINGS.has(setting.id)) defaults[setting.id] = Number(current);
    else defaults[setting.id] = current;
  }
  return defaults;
}

/**
 * Layer a slot's options over a config.
 *
 * Order follows the menu, which puts `preset` first: it rewrites everything
 * below it, so applying it after another key would discard that key.
 */
export function applyUsageSlotOptions(
  config: UsageDisplayConfig,
  options: SlotOptions,
): UsageDisplayConfig {
  let result = config;
  for (const setting of buildSettings()) {
    const value = options[setting.id];
    if (value === undefined) continue;
    result = setting.apply(result, settingValue(setting, value));
  }
  return result;
}

function kindOf(setting: Setting): SlotFieldSpec["kind"] {
  if (BOOLEAN_SETTINGS.has(setting.id)) return "boolean";
  if (NUMBER_SETTINGS.has(setting.id)) return "number";
  return "enum";
}

/** Back to the string the menu's `apply` speaks. */
function settingValue(setting: Setting, value: SlotOptionValue): string {
  if (BOOLEAN_SETTINGS.has(setting.id)) return value === true ? "on" : "off";
  if (NUMBER_SETTINGS.has(setting.id)) return String(value);
  return String(value);
}
