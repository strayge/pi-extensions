/**
 * Working out which slots need their options pushed back to their producer.
 *
 * The statusline owns the values, but a producer keeps its own config file for
 * its other surfaces — `pi-usage` renders a `/usage` report from the same
 * settings — so a change made here has to reach it. Only actual changes are
 * sent: a push carries authority, and re-sending an unchanged set on every
 * reload would let the statusline overwrite a file it was never asked to touch.
 */

import type { ItemConfig, SlotItemConfig, SlotOptions, StatuslineConfig } from "./types.ts";

/** Every slot's options, keyed by id, in layout order. */
export function slotOptionsById(config: StatuslineConfig): Map<string, SlotOptions[]> {
  const found = new Map<string, SlotOptions[]>();
  for (const line of config.lines) {
    for (const item of line) {
      if (item.type !== "slot") continue;
      const slot = item as SlotItemConfig;
      const instances = found.get(slot.id) ?? [];
      instances.push({ ...(slot.options ?? {}) });
      found.set(slot.id, instances);
    }
  }
  return found;
}

/**
 * The ids whose options differ between two layouts.
 *
 * An id that disappeared entirely is not a change of options — the user removed
 * an item, and telling the producer to adopt an empty set would silently reset
 * its own config.
 */
export function changedSlotOptions(
  previous: StatuslineConfig,
  next: StatuslineConfig,
): Map<string, SlotOptions[]> {
  const before = slotOptionsById(previous);
  const after = slotOptionsById(next);
  const changed = new Map<string, SlotOptions[]>();

  for (const [id, instances] of after) {
    if (!sameInstances(before.get(id), instances)) changed.set(id, instances);
  }
  return changed;
}

function sameInstances(left: SlotOptions[] | undefined, right: SlotOptions[]): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((options, index) => sameOptions(options, right[index]));
}

function sameOptions(left: SlotOptions, right: SlotOptions | undefined): boolean {
  if (!right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/** True when any item in the layout is a slot with the given id. */
export function hasSlot(lines: ItemConfig[][], id: string): boolean {
  return lines.some((line) =>
    line.some((item) => item.type === "slot" && (item as SlotItemConfig).id === id),
  );
}
