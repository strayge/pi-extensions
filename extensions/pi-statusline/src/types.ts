/**
 * Configuration and render-time shapes for the statusline.
 *
 * The config is a list of lines, each line a list of item objects. Item objects
 * carry their own presentation options so a layout can be hand-edited without a
 * second lookup table of per-type settings.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const ITEM_TYPES = [
  "brand",
  "cwd",
  "branch",
  "git_status",
  "session",
  "provider",
  "model",
  "thinking",
  "tokens",
  "tokens_in",
  "tokens_out",
  "cache_read",
  "cache_write",
  "cache_hit",
  "cost",
  "context",
  "turn",
  "time",
  "tools",
  "extensions",
  "slot",
  "text",
  "sep",
  "split",
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

/**
 * The colors an item may ask for.
 *
 * A narrow slice of pi's palette: the semantic names that mean something on a
 * footer, plus `mdLink` as a sixth distinguishable hue — producers that color
 * by category run out of options otherwise, and every theme defines it.
 * `satisfies` ties the list to the real palette, so a name that pi does not
 * define cannot be added here — `theme.fg` throws on an unknown color, and a
 * throw inside the footer takes the session down.
 */
export const ITEM_COLORS = [
  "dim",
  "muted",
  "text",
  "accent",
  "success",
  "warning",
  "error",
  "mdLink",
] as const satisfies readonly ThemeColor[];

export type ItemColor = (typeof ITEM_COLORS)[number];

/**
 * Options an extension declares for its own slot.
 *
 * Scalars only: these are edited by cycling and typing in the layout editor and
 * round-trip through the config file as JSON. A producer holding an ordered set
 * expresses it as several scalars, the way `/usage` already reduces its field
 * list to a `quota` mode and a `reset` toggle.
 */
export type SlotOptionValue = string | number | boolean;
export type SlotOptions = Record<string, SlotOptionValue>;

export const SLOT_FIELD_KINDS = ["string", "number", "boolean", "enum"] as const;
export type SlotFieldKind = (typeof SLOT_FIELD_KINDS)[number];

export interface SlotFieldSpec {
  key: string;
  label: string;
  kind: SlotFieldKind;
  /** `enum` only. The first entry is what an unset field behaves as. */
  options?: string[];
  /** `number` only. */
  min?: number;
  max?: number;
  description?: string;
}

/** A run of slot text sharing one color. */
export interface SlotSegment {
  text: string;
  color?: ItemColor;
}

/** A bare string is one uncolored segment; the object form can add an icon. */
export type SlotRenderResult =
  | string
  | SlotSegment[]
  | { segments: SlotSegment[]; icon?: string }
  | undefined;

export interface SlotRenderEnv {
  /** True when the editor is drawing a preview rather than the footer painting.
   *  Lets a producer stand in for data it has not fetched yet. */
  preview: boolean;
}

/** A producer's option schema plus the function that draws with it. */
export interface SlotRegistration {
  id: string;
  /** Schema version, so an option shape stored by another build is detectable. */
  version: number;
  fields: SlotFieldSpec[];
  /** The producer's own current values, shown as the editor's "unset" text. */
  defaults?: SlotOptions;
  render?: (options: SlotOptions, env: SlotRenderEnv) => SlotRenderResult;
  icon?: string;
  color?: ItemColor;
  priority?: number;
  defaultPlacement?: SlotPlacement;
}

/** What `render` produced, once normalized and made safe to print. */
export interface RenderedSlot {
  segments: SlotSegment[];
  icon?: string;
}

export const CWD_STYLES = ["home", "basename", "full"] as const;
export type CwdStyle = (typeof CWD_STYLES)[number];

export const TIME_FORMATS = ["clock", "elapsed"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

/** How a context item marks a prompt cache that has gone cold. */
export const COLD_STYLES = ["off", "symbol", "color", "both"] as const;
export type ColdStyle = (typeof COLD_STYLES)[number];

/**
 * Options shared by every item. `color: "auto"` defers to the item's own
 * default, which is `dim` for everything except the context meter, which tints
 * itself once the window fills up.
 */
export interface BaseItemConfig {
  type: ItemType;
  icon?: string;
  prefix?: string;
  suffix?: string;
  color?: ItemColor | "auto";
  bold?: boolean;
  hidden?: boolean;
  /** Higher survives longer when a line has to shed items to fit. */
  priority?: number;
}

export interface CwdItemConfig extends BaseItemConfig {
  type: "cwd";
  style?: CwdStyle;
}

export interface ModelItemConfig extends BaseItemConfig {
  type: "model";
  /** Drop the vendor prefix and date suffix, e.g. `claude-opus-5` -> `opus-5`. */
  short?: boolean;
}

export interface ProviderItemConfig extends BaseItemConfig {
  type: "provider";
  /** Stock pi only shows the provider when more than one is configured. */
  onlyWhenMultiple?: boolean;
}

export interface ThinkingItemConfig extends BaseItemConfig {
  type: "thinking";
  /** Stock pi only shows thinking for models that support reasoning. */
  onlyWhenSupported?: boolean;
}

/**
 * The meter is assembled from independent parts rather than picked from a list
 * of styles, so any combination is reachable. They render in a fixed order —
 * bar, gauge, percent, tokens — with the window appended to whatever value
 * comes last.
 */
export interface ContextItemConfig extends BaseItemConfig {
  type: "context";
  /** `[████░░░░]`, `barWidth` columns wide. */
  showBar?: boolean;
  /** A single column of `▁▂▃▄▅▆▇█`. */
  showGauge?: boolean;
  /** `51.1%`. On by default, as stock pi does. */
  showPercent?: boolean;
  /** `139k` — tokens in context, which stock pi does not show. */
  showTokens?: boolean;
  /** Append `<windowSeparator><window>`, as stock pi does. */
  showWindow?: boolean;
  /** Move the percentage past the window: `139k/272k 51.1%`. */
  percentAfterWindow?: boolean;
  /** Wrap the percentage: `139k/272k (51.1%)`. */
  percentParens?: boolean;
  barWidth?: number;
  /** `"/"` by default; `" / "` keeps its padding. */
  windowSeparator?: string;
  /** Tint at >70% (warning) and >90% (error), as stock pi does. */
  threshold?: boolean;
  /** Drop the whole item while the context is still empty. */
  hideWhenZero?: boolean;
  /**
   * Mark the context once the prompt cache has likely expired, so the cost of
   * the next request is visible before it is paid.
   *
   * Off by default: an existing layout must look the same after an upgrade.
   * `color` and `both` outrank `threshold`, since a cache about to be re-written
   * is news the fill level is not.
   */
  coldStyle?: ColdStyle;
  /** Idle minutes after the last response before the cache counts as cold. */
  coldAfterMinutes?: number;
  /** Leading glyph for `symbol` and `both`. Its trailing space is preserved. */
  coldMarker?: string;
  coldColor?: ItemColor;
}

export interface TimeItemConfig extends BaseItemConfig {
  type: "time";
  format?: TimeFormat;
}

export interface TextItemConfig extends BaseItemConfig {
  type: "text";
  text: string;
}

export interface SepItemConfig extends BaseItemConfig {
  type: "sep";
  text?: string;
}

export interface SlotItemConfig extends BaseItemConfig {
  type: "slot";
  id: string;
  /** Values for the options the producer registered. Absent keys fall back to
   *  the producer's own config, so an untouched item tracks whatever it says. */
  options?: SlotOptions;
}

export interface ExtensionsItemConfig extends BaseItemConfig {
  type: "extensions";
  /** Whitelist of status keys; omitted means "everything not placed elsewhere". */
  include?: string[];
  exclude?: string[];
  /** Per-key icon, prepended to that extension's status text. */
  icons?: Record<string, string>;
  separator?: string;
}

export type ItemConfig =
  | BaseItemConfig
  | CwdItemConfig
  | ModelItemConfig
  | ProviderItemConfig
  | ThinkingItemConfig
  | ContextItemConfig
  | TimeItemConfig
  | TextItemConfig
  | SepItemConfig
  | SlotItemConfig
  | ExtensionsItemConfig;

export interface StatuslineConfig {
  version: 1;
  /** Minimum gap between left/center/right groups on one line. */
  groupGap: number;
  lines: ItemConfig[][];
}

/**
 * What an item builder produces: a bare value plus an optional color override.
 *
 * `text` is always the whole value, so width math and emptiness checks read one
 * field whatever produced it. `segments` is set only by a slot whose producer
 * colored its own parts, and carries the same characters split up.
 */
export interface ItemValue {
  text: string;
  color?: ThemeColor;
  segments?: SlotSegment[];
  /**
   * A color that outranks even an explicit `color` on the item.
   *
   * For a state the user asked to be told about by another key, which a resting
   * color would otherwise swallow: setting `color` on a context item must not
   * quietly disable the `coldColor` set right next to it.
   */
  overrideColor?: ThemeColor;
}

/** An item published over the event bus by another extension. */
export interface SlotItem {
  id: string;
  text: string;
  icon?: string;
  color?: ItemColor;
  priority?: number;
  defaultPlacement?: SlotPlacement;
}

export interface SlotPlacement {
  /** Zero-based line index. Out-of-range values clamp to the last line. */
  line?: number;
  side?: "left" | "center" | "right";
  /** Sort key among items injected into the same group. */
  order?: number;
}
