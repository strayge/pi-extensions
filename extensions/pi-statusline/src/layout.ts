/**
 * Line layout: separator collapsing, left/center/right alignment, and shedding
 * items that do not fit.
 *
 * Pure on purpose — every rule here is awkward to observe through a live TUI,
 * so the whole thing is driven by plain cells and covered by unit tests.
 *
 * Cells carry both `text` (plain, used for width math) and `styled` (what is
 * actually emitted). Keeping them apart means color codes can never skew the
 * widths, which is the classic way statuslines end up one column too wide.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const ELLIPSIS = "…";

export interface LayoutCell {
  /** Item type or id, for tests and debugging. */
  key: string;
  text: string;
  styled: string;
  kind: "item" | "sep" | "split";
  /** Higher survives longer when the line has to shed items. */
  priority: number;
}

export function cellWidth(cell: LayoutCell): number {
  return visibleWidth(cell.text);
}

/**
 * Render one configured line.
 *
 * Groups are separated by `split` cells: one split gives left/right, two give
 * left/center/right. Further splits are ignored rather than silently producing
 * groups nobody can see.
 */
export function layoutLine(cells: LayoutCell[], width: number, gap: number): string {
  if (width <= 0) return "";

  let groups = splitGroups(cells).map(collapseSeparators);
  groups = shedToFit(groups, width, gap);

  const rendered = groups.map((group) => ({
    styled: group.map((cell) => cell.styled).join(""),
    width: group.reduce((total, cell) => total + cellWidth(cell), 0),
  }));

  if (rendered.every((group) => group.width === 0)) return "";

  const line = composeGroups(rendered, width, gap);
  return visibleWidth(line) > width ? truncateToWidth(line, width, ELLIPSIS) : line;
}

/** True when a line renders to nothing and should be dropped entirely. */
export function isBlankLine(cells: LayoutCell[]): boolean {
  return splitGroups(cells)
    .map(collapseSeparators)
    .every((group) => group.every((cell) => cell.text.length === 0));
}

function splitGroups(cells: LayoutCell[]): LayoutCell[][] {
  const groups: LayoutCell[][] = [[]];
  for (const cell of cells) {
    if (cell.kind === "split" && groups.length < 3) {
      groups.push([]);
      continue;
    }
    if (cell.kind === "split") continue;
    groups.at(-1)?.push(cell);
  }
  return groups;
}

/**
 * Drop separators that no longer sit between two values: leading, trailing, and
 * runs of adjacent separators. This is what makes ` (branch)` and ` • name`
 * vanish cleanly when the branch or the session name is absent.
 */
function collapseSeparators(group: LayoutCell[]): LayoutCell[] {
  const kept: LayoutCell[] = [];
  for (const cell of group) {
    if (cell.kind === "item") {
      if (cell.text.length === 0) continue;
      kept.push(cell);
      continue;
    }
    // Separator: only keep it if a value precedes it and none is pending.
    if (kept.length === 0) continue;
    if (kept.at(-1)?.kind === "sep") continue;
    kept.push(cell);
  }
  while (kept.at(-1)?.kind === "sep") kept.pop();
  return kept;
}

/**
 * Drop the least important items until the line fits.
 *
 * Ties break toward the right, so a run of equal-priority items sheds from the
 * end: `↑12k ↓3.4k R80k W2k CH94%` loses the cache detail before the totals.
 */
function shedToFit(groups: LayoutCell[][], width: number, gap: number): LayoutCell[][] {
  let current = groups;

  while (totalWidth(current, gap) > width) {
    // Never shed the last value standing: a too-long lone item gets truncated,
    // which still says something, rather than leaving an empty line.
    if (countItems(current) <= 1) break;
    const victim = lowestPriorityCell(current);
    if (!victim) break;
    current = current.map((group, groupIndex) =>
      groupIndex === victim.group
        ? collapseSeparators(group.filter((_, index) => index !== victim.index))
        : group,
    );
  }

  return current;
}

function lowestPriorityCell(groups: LayoutCell[][]): { group: number; index: number } | undefined {
  let best: { group: number; index: number; priority: number } | undefined;
  for (const [groupIndex, group] of groups.entries()) {
    for (const [index, cell] of group.entries()) {
      if (cell.kind !== "item") continue;
      if (best === undefined || cell.priority <= best.priority) {
        best = { group: groupIndex, index, priority: cell.priority };
      }
    }
  }
  return best ? { group: best.group, index: best.index } : undefined;
}

function countItems(groups: LayoutCell[][]): number {
  return groups.reduce(
    (total, group) => total + group.filter((cell) => cell.kind === "item").length,
    0,
  );
}

function totalWidth(groups: LayoutCell[][], gap: number): number {
  const widths = groups
    .map((group) => group.reduce((total, cell) => total + cellWidth(cell), 0))
    .filter((groupWidth) => groupWidth > 0);
  if (widths.length === 0) return 0;
  return widths.reduce((total, groupWidth) => total + groupWidth, 0) + gap * (widths.length - 1);
}

interface RenderedGroup {
  styled: string;
  width: number;
}

/**
 * Place the groups by their configured side, not by how many survived.
 *
 * A group keeps its alignment even when its neighbours shed away entirely —
 * the model staying pinned to the right edge on a narrow terminal is the whole
 * reason for having a splitter.
 */
function composeGroups(groups: RenderedGroup[], width: number, gap: number): string {
  const left = groups[0];
  const center = groups.length === 3 ? groups[1] : undefined;
  const right = groups.length === 3 ? groups[2] : groups[1];

  let line = "";
  let cursor = 0;

  if (left && left.width > 0) {
    line += left.styled;
    cursor = left.width;
  }

  if (center && center.width > 0) {
    const rightReserve = right && right.width > 0 ? right.width + gap : 0;
    const earliest = cursor > 0 ? cursor + gap : 0;
    const latest = Math.max(earliest, width - rightReserve - center.width);
    const start = Math.min(Math.max(Math.floor((width - center.width) / 2), earliest), latest);
    line += " ".repeat(start - cursor) + center.styled;
    cursor = start + center.width;
  }

  if (right && right.width > 0) {
    const start = Math.max(width - right.width, cursor > 0 ? cursor + gap : 0);
    line += " ".repeat(start - cursor) + right.styled;
  }

  return line;
}
