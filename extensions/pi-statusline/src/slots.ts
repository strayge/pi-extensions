/**
 * Slot registry: how other extensions get their own text into the statusline.
 *
 * A producer publishes an item over pi's shared event bus and may suggest where
 * it should land. The suggestion is only a default — if the user's config names
 * the id anywhere, that placement wins and the hint is ignored. Producers that
 * never publish anything cost nothing, and extensions that only call
 * `ctx.ui.setStatus` still surface through the `extensions` item.
 *
 *   pi.events.emit("statusline:publish", {
 *     id: "usage", icon: "📊", text: "42%",
 *     defaultPlacement: { line: 1, side: "right", order: 10 },
 *   });
 *   pi.events.emit("statusline:clear", { id: "usage" });
 *
 * The statusline emits `statusline:request` on session start so producers that
 * loaded before it can re-publish; load order between extensions is not fixed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitize } from "./format.ts";
import { ITEM_COLORS, type ItemColor, type SlotItem, type SlotPlacement } from "./types.ts";

export const PUBLISH_CHANNEL = "statusline:publish";
export const CLEAR_CHANNEL = "statusline:clear";
export const REQUEST_CHANNEL = "statusline:request";

export class SlotRegistry {
  private items = new Map<string, SlotItem>();
  private pi: ExtensionAPI;
  private onChange: () => void;

  constructor(pi: ExtensionAPI, onChange: () => void) {
    this.pi = pi;
    this.onChange = onChange;
  }

  /** Subscribe to the bus. Safe to call once per extension activation. */
  listen(): void {
    this.pi.events.on(PUBLISH_CHANNEL, (data) => {
      const item = parseSlotItem(data);
      if (!item) return;
      const previous = this.items.get(item.id);
      if (previous && slotItemsEqual(previous, item)) return;
      this.items.set(item.id, item);
      this.onChange();
    });

    this.pi.events.on(CLEAR_CHANNEL, (data) => {
      const id = isRecord(data) && typeof data.id === "string" ? data.id : undefined;
      if (!id || !this.items.delete(id)) return;
      this.onChange();
    });
  }

  /** Ask producers to re-publish; call once the footer is installed. */
  request(): void {
    this.pi.events.emit(REQUEST_CHANNEL, {});
  }

  get(id: string): SlotItem | undefined {
    return this.items.get(id);
  }

  all(): SlotItem[] {
    return [...this.items.values()];
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.onChange();
  }
}

function parseSlotItem(data: unknown): SlotItem | undefined {
  if (!isRecord(data)) return undefined;
  const { id, text } = data;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof text !== "string") return undefined;

  const item: SlotItem = { id, text: sanitize(text) };
  // The icon is rendered as-is, so it goes through the same flattening as the
  // text: a newline in it measures as zero columns and would slip past every
  // width check into pi's line accounting.
  if (typeof data.icon === "string") item.icon = sanitize(data.icon);
  // A color pi does not define makes `theme.fg` throw inside the footer, which
  // is fatal — one producer's typo must not take the session down.
  if (isItemColor(data.color)) item.color = data.color;
  if (typeof data.priority === "number" && Number.isFinite(data.priority)) {
    item.priority = data.priority;
  }
  const placement = parsePlacement(data.defaultPlacement);
  if (placement) item.defaultPlacement = placement;
  return item;
}

function parsePlacement(data: unknown): SlotPlacement | undefined {
  if (!isRecord(data)) return undefined;
  const placement: SlotPlacement = {};
  if (typeof data.line === "number" && Number.isFinite(data.line)) {
    placement.line = Math.max(0, Math.round(data.line));
  }
  if (data.side === "left" || data.side === "center" || data.side === "right") {
    placement.side = data.side;
  }
  if (typeof data.order === "number" && Number.isFinite(data.order)) placement.order = data.order;
  return Object.keys(placement).length > 0 ? placement : undefined;
}

function slotItemsEqual(a: SlotItem, b: SlotItem): boolean {
  return (
    a.text === b.text &&
    a.icon === b.icon &&
    a.color === b.color &&
    a.priority === b.priority &&
    a.defaultPlacement?.line === b.defaultPlacement?.line &&
    a.defaultPlacement?.side === b.defaultPlacement?.side &&
    a.defaultPlacement?.order === b.defaultPlacement?.order
  );
}

function isItemColor(value: unknown): value is ItemColor {
  return typeof value === "string" && (ITEM_COLORS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
