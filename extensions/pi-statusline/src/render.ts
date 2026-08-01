/**
 * Turns a config plus live session state into the footer's lines.
 *
 * Order of business per render: resolve where published slots go, build one
 * cell per configured item, style it, then hand each line to the layout engine.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { buildItemValue, type RenderEnv } from "./items.ts";
import { isBlankLine, type LayoutCell, layoutLine } from "./layout.ts";
import type {
  ExtensionsItemConfig,
  ItemConfig,
  SepItemConfig,
  SlotItem,
  SlotItemConfig,
  StatuslineConfig,
} from "./types.ts";

const DEFAULT_PRIORITY = 50;
const DEFAULT_COLOR: ThemeColor = "dim";

export function renderStatusline(
  width: number,
  config: StatuslineConfig,
  theme: Theme,
  env: Omit<RenderEnv, "placedStatusKeys">,
): string[] {
  if (width <= 0) return [];

  // Placement is resolved before the catch-all is asked what is left, so a slot
  // that got injected by its own hint is not also listed among the leftovers.
  const lines = injectUnplacedSlots(config.lines, env.slots.all(), collectPlacedIds(config.lines));
  const fullEnv: RenderEnv = { ...env, placedStatusKeys: collectPlacedIds(lines) };

  const rendered: string[] = [];
  for (const line of lines) {
    const cells = line
      .filter((item) => item.hidden !== true)
      .map((item) => buildCell(item, theme, fullEnv))
      .filter((cell): cell is LayoutCell => cell !== undefined);
    if (isBlankLine(cells)) continue;
    const text = layoutLine(cells, width, config.groupGap);
    if (text.length > 0) rendered.push(text);
  }

  return rendered;
}

/** Ids the layout places by name; those never fall into the catch-all. */
function collectPlacedIds(lines: ItemConfig[][]): Set<string> {
  const placed = new Set<string>();
  for (const line of lines) {
    for (const item of line) {
      if (item.type === "slot" && item.hidden !== true) placed.add((item as SlotItemConfig).id);
    }
  }
  return placed;
}

/**
 * Give published-but-unplaced slots their requested position.
 *
 * Only a hint: anything already named in the config was filtered out by the
 * caller, and anything without a hint is left to the `extensions` catch-all.
 * Each injected item brings its own separator so it cannot run into its
 * neighbour; a separator that ends up leading is dropped during collapsing.
 */
function injectUnplacedSlots(
  lines: ItemConfig[][],
  slots: SlotItem[],
  placed: Set<string>,
): ItemConfig[][] {
  const pending = slots
    .filter((slot) => !placed.has(slot.id) && slot.defaultPlacement && slot.text.length > 0)
    .sort((a, b) => (a.defaultPlacement?.order ?? 0) - (b.defaultPlacement?.order ?? 0));
  if (pending.length === 0 || lines.length === 0) return lines;

  const result = lines.map((line) => [...line]);
  const hasCatchAll = lines.some((line) =>
    line.some((item) => item.type === "extensions" && item.hidden !== true),
  );

  for (const slot of pending) {
    // Without a catch-all the extension would otherwise be invisible, so an
    // explicit line hint is required to reach the "extensions" fallback.
    const placement = slot.defaultPlacement ?? {};
    if (placement.line === undefined && placement.side === undefined && hasCatchAll) continue;

    const lineIndex = Math.min(placement.line ?? result.length - 1, result.length - 1);
    const line = result[lineIndex];
    if (!line) continue;

    const item: SlotItemConfig = { type: "slot", id: slot.id, priority: slot.priority };
    line.splice(insertIndex(line, placement.side ?? "right"), 0, { type: "sep" }, item);
  }

  return result;
}

/** Where a side lands: before the first split, before the second, or at the end. */
function insertIndex(line: ItemConfig[], side: "left" | "center" | "right"): number {
  const splits = line.flatMap((item, index) => (item.type === "split" ? [index] : []));
  if (side === "left") return splits[0] ?? line.length;
  if (side === "center") return splits[1] ?? line.length;
  return line.length;
}

function buildCell(item: ItemConfig, theme: Theme, env: RenderEnv): LayoutCell | undefined {
  if (item.type === "split") {
    return { key: "split", text: "", styled: "", kind: "split", priority: 0 };
  }

  const value = buildItemValue(item, env);
  if (!value || value.text.length === 0) {
    return { key: item.type, text: "", styled: "", kind: "item", priority: priorityOf(item) };
  }

  if (item.type === "sep") {
    const text = (item as SepItemConfig).text ?? " ";
    return {
      key: "sep",
      text,
      styled: style(text, item, value.color, theme),
      kind: "sep",
      priority: priorityOf(item),
    };
  }

  const text = decorate(value.text, item);
  return {
    key: keyOf(item),
    text,
    styled: style(text, item, value.color, theme),
    kind: "item",
    priority: priorityOf(item),
  };
}

function decorate(value: string, item: ItemConfig): string {
  const icon = item.icon ? `${item.icon} ` : "";
  return `${item.prefix ?? ""}${icon}${value}${item.suffix ?? ""}`;
}

/**
 * Styling is per cell rather than per line: an extension's own color codes end
 * with a reset, which would otherwise cancel a line-wide wrapper for everything
 * that follows it.
 */
function style(
  text: string,
  item: ItemConfig,
  valueColor: ThemeColor | undefined,
  theme: Theme,
): string {
  const configured = item.color && item.color !== "auto" ? item.color : undefined;
  const color = configured ?? valueColor ?? DEFAULT_COLOR;
  const colored = theme.fg(color, text);
  return item.bold ? theme.bold(colored) : colored;
}

function priorityOf(item: ItemConfig): number {
  return item.priority ?? DEFAULT_PRIORITY;
}

function keyOf(item: ItemConfig): string {
  if (item.type === "slot") return `slot:${(item as SlotItemConfig).id}`;
  if (item.type === "extensions") {
    const include = (item as ExtensionsItemConfig).include;
    return include ? `extensions:${include.join(",")}` : "extensions";
  }
  return item.type;
}
