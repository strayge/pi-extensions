/**
 * Slot registry: how other extensions get their own text into the statusline.
 *
 * There are two halves. A producer *publishes* a string and may suggest where it
 * belongs; the suggestion is only a default — if the user's config names the id
 * anywhere, that placement wins and the hint is ignored. A producer may also
 * *register* an option schema plus a `render` function, which lets the user
 * configure it from the layout editor and see the result in the live preview.
 *
 *   const owner = ctx.sessionManager.getSessionId();
 *   pi.events.emit("statusline:publish", {
 *     id: "usage", owner, icon: "📊", text: "42%",
 *     defaultPlacement: { line: 1, side: "right", order: 10 },
 *   });
 *   pi.events.emit("statusline:clear", { id: "usage", owner });
 *
 *   pi.events.emit("statusline:register", {
 *     id: "usage", owner, version: 1,
 *     fields: [{ key: "barWidth", label: "bar width", kind: "number" }],
 *     defaults: { barWidth: 8 },
 *     render: (options, env) => "▓▓░░ 42%",
 *   });
 *   pi.events.emit("statusline:unregister", { id: "usage", owner });
 *
 * Traffic before session_start is dropped. The statusline then emits
 * `statusline:request` with { owner } so that session's producers re-publish and
 * re-register. It emits `statusline:options` with owner when the values stored
 * in the config change, so a producer can mirror them into its own config file.
 * Unstamped messages and messages for another session are ignored.
 *
 * `render` is called inside the paint path, where a throw is fatal and an
 * over-wide line kills the session, so everything it returns is treated as
 * hostile: escapes stripped, control characters removed, colors checked against
 * the palette, and the call itself wrapped.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitize, sanitizeLiteral, stripAnsi } from "./format.ts";
import {
  ITEM_COLORS,
  type ItemColor,
  type RenderedSlot,
  SLOT_FIELD_KINDS,
  type SlotFieldKind,
  type SlotFieldSpec,
  type SlotItem,
  type SlotOptions,
  type SlotOptionValue,
  type SlotPlacement,
  type SlotRegistration,
  type SlotRenderEnv,
  type SlotRenderResult,
  type SlotSegment,
} from "./types.ts";

export const PUBLISH_CHANNEL = "statusline:publish";
export const CLEAR_CHANNEL = "statusline:clear";
export const REQUEST_CHANNEL = "statusline:request";
export const REGISTER_CHANNEL = "statusline:register";
export const UNREGISTER_CHANNEL = "statusline:unregister";
export const OPTIONS_CHANNEL = "statusline:options";

export class SlotRegistry {
  private owner: string | undefined;
  private items = new Map<string, SlotItem>();
  private registrations = new Map<string, SlotRegistration>();
  /**
   * Every id published this session, kept past a clear. A slot reporting a
   * condition is quiet most of the time, and forgetting it the moment it goes
   * quiet would leave it placeable only while it happens to be showing.
   */
  private seen = new Set<string>();
  /** One message per id: a broken producer is asked to render on every frame. */
  private failures = new Map<string, string>();
  private pi: ExtensionAPI;
  private onChange: () => void;

  constructor(pi: ExtensionAPI, onChange: () => void) {
    this.pi = pi;
    this.onChange = onChange;
  }

  setOwner(owner: string | undefined): void {
    this.owner = owner;
  }

  /** Subscribe to the bus. Safe to call once per extension activation. */
  listen(): void {
    this.pi.events.on(PUBLISH_CHANNEL, (data) => {
      if (!this.owner || !isRecord(data) || data.owner !== this.owner) return;
      const item = parseSlotItem(data);
      if (!item) return;
      const previous = this.items.get(item.id);
      this.seen.add(item.id);
      if (previous && slotItemsEqual(previous, item)) return;
      this.items.set(item.id, item);
      this.onChange();
    });

    this.pi.events.on(CLEAR_CHANNEL, (data) => {
      if (!this.owner || !isRecord(data) || data.owner !== this.owner) return;
      const id = typeof data.id === "string" ? data.id : undefined;
      if (!id || !this.items.delete(id)) return;
      this.onChange();
    });

    this.pi.events.on(REGISTER_CHANNEL, (data) => {
      if (!this.owner || !isRecord(data) || data.owner !== this.owner) return;
      const registration = parseRegistration(data);
      if (!registration) return;
      this.registrations.set(registration.id, registration);
      // A re-announce may carry fresh defaults, and those are what the editor
      // shows for an unset field, so a repaint is due either way.
      this.failures.delete(registration.id);
      this.onChange();
    });

    this.pi.events.on(UNREGISTER_CHANNEL, (data) => {
      if (!this.owner || !isRecord(data) || data.owner !== this.owner) return;
      const id = typeof data.id === "string" ? data.id : undefined;
      if (!id || !this.registrations.delete(id)) return;
      this.failures.delete(id);
      this.onChange();
    });
  }

  /** Ask producers to re-publish and re-register; call once the footer is up. */
  request(): void {
    if (!this.owner) return;
    this.pi.events.emit(REQUEST_CHANNEL, { owner: this.owner });
  }

  get(id: string): SlotItem | undefined {
    return this.items.get(id);
  }

  all(): SlotItem[] {
    return [...this.items.values()];
  }

  /** Ids the layout editor may offer, including ones currently cleared. */
  known(): string[] {
    return [...new Set([...this.seen, ...this.registrations.keys()])];
  }

  registration(id: string): SlotRegistration | undefined {
    return this.registrations.get(id);
  }

  registered(): SlotRegistration[] {
    return [...this.registrations.values()];
  }

  /**
   * Draw a slot from its producer's own code, or `undefined` when it did not
   * register one, returned nothing, or threw.
   */
  render(id: string, options: SlotOptions, env: SlotRenderEnv): RenderedSlot | undefined {
    const registration = this.registrations.get(id);
    if (!registration?.render) return undefined;

    let result: SlotRenderResult;
    try {
      result = registration.render(coerceOptions(options, registration), env);
    } catch (error) {
      // Banked rather than reported: this runs inside a render, which is no
      // place to write to the terminal or to open a dialog. `/statusline`
      // drains it.
      if (!this.failures.has(id)) {
        this.failures.set(id, error instanceof Error ? error.message : String(error));
      }
      return undefined;
    }
    return normalizeRendered(result);
  }

  /** Drain the render failures seen so far, for the caller to surface. */
  takeRenderFailures(): string[] {
    const messages = [...this.failures].map(
      ([id, reason]) => `slot "${id}" failed to render: ${reason}`,
    );
    this.failures.clear();
    return messages;
  }

  /**
   * Tell a producer what the config now says, so it can mirror the values into
   * its own file and keep its other surfaces in step.
   *
   * Every configured instance is sent, in layout order: two items may carry
   * different options, and picking one for the producer would be inventing an
   * answer. A producer that only wants one reads `instances[0]`.
   */
  pushOptions(id: string, instances: SlotOptions[]): void {
    if (!this.owner) return;
    const registration = this.registrations.get(id);
    this.pi.events.emit(OPTIONS_CHANNEL, {
      id,
      owner: this.owner,
      version: registration?.version ?? 1,
      instances: instances.map((options) => ({
        options: registration ? coerceOptions(options, registration) : { ...options },
      })),
    });
  }

  clear(): void {
    this.failures.clear();
    if (this.items.size === 0 && this.registrations.size === 0) return;
    this.items.clear();
    this.registrations.clear();
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

function parseRegistration(data: unknown): SlotRegistration | undefined {
  if (!isRecord(data)) return undefined;
  const { id } = data;
  if (typeof id !== "string" || id.length === 0) return undefined;

  const registration: SlotRegistration = {
    id,
    version: typeof data.version === "number" && Number.isFinite(data.version) ? data.version : 1,
    fields: parseFields(data.fields),
  };

  if (typeof data.render === "function") {
    registration.render = data.render as SlotRegistration["render"];
  }
  const defaults = parseOptions(data.defaults);
  if (defaults) registration.defaults = defaults;
  if (typeof data.icon === "string") registration.icon = sanitize(data.icon);
  if (isItemColor(data.color)) registration.color = data.color;
  if (typeof data.priority === "number" && Number.isFinite(data.priority)) {
    registration.priority = data.priority;
  }
  const placement = parsePlacement(data.defaultPlacement);
  if (placement) registration.defaultPlacement = placement;
  return registration;
}

function parseFields(data: unknown): SlotFieldSpec[] {
  if (!Array.isArray(data)) return [];
  const fields: SlotFieldSpec[] = [];
  const seen = new Set<string>();

  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const { key } = entry;
    if (typeof key !== "string" || key.length === 0 || seen.has(key)) continue;
    if (!isFieldKind(entry.kind)) continue;

    const field: SlotFieldSpec = {
      key,
      label: typeof entry.label === "string" && entry.label.length > 0 ? entry.label : key,
      kind: entry.kind,
    };

    if (entry.kind === "enum") {
      // An enum with nothing to cycle through would be a dead row in the editor.
      const options = Array.isArray(entry.options)
        ? entry.options.filter((option): option is string => typeof option === "string")
        : [];
      if (options.length === 0) continue;
      field.options = options;
    }
    if (typeof entry.min === "number" && Number.isFinite(entry.min)) field.min = entry.min;
    if (typeof entry.max === "number" && Number.isFinite(entry.max)) field.max = entry.max;
    if (typeof entry.description === "string") field.description = entry.description;

    seen.add(key);
    fields.push(field);
  }
  return fields;
}

/** Scalars only, so an option can never smuggle in an object the editor cannot show. */
export function parseOptions(data: unknown): SlotOptions | undefined {
  if (!isRecord(data)) return undefined;
  const options: SlotOptions = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") options[key] = sanitizeLiteral(value);
    else if (typeof value === "number" && Number.isFinite(value)) options[key] = value;
    else if (typeof value === "boolean") options[key] = value;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Reduce stored options to what the producer actually declared, in the shape it
 * declared. Undeclared keys are dropped on the way out rather than in the file:
 * they may belong to a version of the producer that is not loaded right now.
 */
function coerceOptions(options: SlotOptions, registration: SlotRegistration): SlotOptions {
  const result: SlotOptions = {};
  for (const field of registration.fields) {
    const value: SlotOptionValue | undefined = options[field.key];
    if (value === undefined) continue;
    switch (field.kind) {
      case "boolean":
        if (typeof value === "boolean") result[field.key] = value;
        break;
      case "number":
        if (typeof value === "number" && Number.isFinite(value)) {
          result[field.key] = clamp(value, field.min, field.max);
        }
        break;
      case "enum":
        if (typeof value === "string" && field.options?.includes(value)) result[field.key] = value;
        break;
      default:
        if (typeof value === "string") result[field.key] = sanitizeLiteral(value);
        break;
    }
  }
  return result;
}

function normalizeRendered(result: SlotRenderResult): RenderedSlot | undefined {
  if (result === undefined) return undefined;

  let raw: unknown[] = [];
  let icon: string | undefined;
  if (typeof result === "string") raw = [{ text: result }];
  else if (Array.isArray(result)) raw = result;
  else if (isRecord(result)) {
    if (Array.isArray(result.segments)) raw = result.segments;
    if (typeof result.icon === "string") icon = clean(result.icon);
  } else return undefined;

  const segments: SlotSegment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.text !== "string") continue;
    const text = clean(entry.text);
    if (text.length === 0) continue;
    const segment: SlotSegment = { text };
    if (isItemColor(entry.color)) segment.color = entry.color;
    segments.push(segment);
  }

  const trimmed = trimSegments(segments);
  if (trimmed.length === 0) return undefined;
  return icon ? { segments: trimmed, icon } : { segments: trimmed };
}

/** Escapes first: `sanitizeLiteral` alone would leave their parameters behind. */
function clean(text: string): string {
  return sanitizeLiteral(stripAnsi(text));
}

/**
 * Trim the outer edges of the whole value, not of each segment: padding between
 * segments is the producer's spacing and has to survive, but a leading or
 * trailing space would misalign the item against its neighbours.
 */
function trimSegments(segments: SlotSegment[]): SlotSegment[] {
  const result = segments.map((segment) => ({ ...segment }));

  while (result.length > 0) {
    const first = result[0];
    if (!first) break;
    const text = first.text.replace(/^\s+/, "");
    if (text.length === 0) {
      result.shift();
      continue;
    }
    first.text = text;
    break;
  }

  while (result.length > 0) {
    const last = result.at(-1);
    if (!last) break;
    const text = last.text.replace(/\s+$/, "");
    if (text.length === 0) {
      result.pop();
      continue;
    }
    last.text = text;
    break;
  }

  return result;
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

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let result = value;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

function isFieldKind(value: unknown): value is SlotFieldKind {
  return typeof value === "string" && (SLOT_FIELD_KINDS as readonly string[]).includes(value);
}

function isItemColor(value: unknown): value is ItemColor {
  return typeof value === "string" && (ITEM_COLORS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
