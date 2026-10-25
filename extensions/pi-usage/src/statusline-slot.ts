/**
 * Publishes the usage status as a statusline slot, so a statusline extension
 * can place it anywhere in the bar instead of leaving it in the catch-all row.
 *
 * Standalone by design: it talks to pi's shared event bus and imports nothing
 * from the statusline package. With no statusline installed the events go
 * nowhere and the calls cost nothing, so this stays alongside
 * `ctx.ui.setStatus`, which is what a stock pi footer reads. Messages carry
 * the calling session's owner, and replays/options only match that owner.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PUBLISH_CHANNEL = "statusline:publish";
const CLEAR_CHANNEL = "statusline:clear";
const REQUEST_CHANNEL = "statusline:request";
const REGISTER_CHANNEL = "statusline:register";
const UNREGISTER_CHANNEL = "statusline:unregister";
const OPTIONS_CHANNEL = "statusline:options";
const INSTANCES_CHANNEL = "statusline:instances";

export interface SlotDefinition {
  id: string;
  icon?: string;
  color?: string;
  priority?: number;
  defaultPlacement?: {
    line?: number;
    side?: "left" | "center" | "right";
    order?: number;
  };
}

/** Scalars only: these are cycled and typed in the statusline's own editor. */
export type SlotOptionValue = string | number | boolean;
export type SlotOptions = Record<string, SlotOptionValue>;

export interface SlotFieldSpec {
  key: string;
  label: string;
  kind: "string" | "number" | "boolean" | "enum";
  /** `enum` only. The first entry is what an unset field behaves as. */
  options?: string[];
  /** `number` only. */
  min?: number;
  max?: number;
  description?: string;
}

/** A run of text sharing one color, named from the statusline's palette. */
export interface SlotSegment {
  text: string;
  color?: "dim" | "muted" | "text" | "accent" | "success" | "warning" | "error";
}

export type SlotRenderResult =
  | string
  | SlotSegment[]
  | { segments: SlotSegment[]; icon?: string }
  | undefined;

export interface SlotRenderEnv {
  /** True while the layout editor draws a preview, so a producer can stand in
   *  for data it has not fetched yet. */
  preview: boolean;
}

export interface SlotSchemaDefinition extends SlotDefinition {
  /** Bump when the meaning of a key changes, so a stored shape is detectable. */
  version: number;
  fields: SlotFieldSpec[];
  /** Read at announce time, so the editor's "unset" text follows your config. */
  defaults?: () => SlotOptions;
  render?: (options: SlotOptions, env: SlotRenderEnv) => SlotRenderResult;
  /** The layout's values for this slot, sent when the user changes them.
   *  `instances` holds every placement; the first is the conventional one. */
  onOptions?: (options: SlotOptions, instances: SlotOptions[]) => void;
  /** Read-only saved layout demand, including startup and removal. */
  onInstances?: (instances: SlotOptions[]) => void;
}

/**
 * Returns a setter for the slot's text; `undefined` hides it.
 *
 * The last value is re-sent when the owning session's statusline asks for it,
 * recovering publications dropped before the statusline's session_start.
 * Pass the context performing each write so unchanged text moves with sessions.
 */
export function publishStatuslineItem(
  pi: ExtensionAPI,
  definition: SlotDefinition,
): (ctx: Pick<ExtensionContext, "sessionManager">, text: string | undefined) => void {
  let owner: string | undefined;
  let current: string | undefined;

  const send = () => {
    if (current === undefined) pi.events.emit(CLEAR_CHANNEL, { id: definition.id, owner });
    else pi.events.emit(PUBLISH_CHANNEL, { ...definition, text: current, owner });
  };

  pi.events.on(REQUEST_CHANNEL, (data) => {
    if (owner && isRecord(data) && data.owner === owner && current !== undefined) send();
  });

  return (ctx, text) => {
    const nextOwner = ctx.sessionManager.getSessionId();
    if (nextOwner === owner && text === current) return;
    owner = nextOwner;
    current = text;
    send();
  };
}

/**
 * Defer the schema announcement until refresh(ctx) supplies a session owner,
 * so another session's requests and options cannot affect this slot.
 *
 * `render` is called synchronously while the statusline paints, and again while
 * the user cycles options in its layout editor — with the *pending* values, so
 * the preview is exact and nothing has to be saved to try a setting out. Keep
 * it pure and quick: no I/O, no awaiting, and no throwing, though a throw costs
 * the slot rather than the session.
 *
 * With no statusline installed the events go nowhere and this costs nothing.
 */
export function registerStatuslineSlot(
  pi: ExtensionAPI,
  definition: SlotSchemaDefinition,
): { dispose: () => void; refresh: (ctx: Pick<ExtensionContext, "sessionManager">) => void } {
  const { defaults, onOptions, onInstances, ...rest } = definition;
  let owner: string | undefined;

  const announce = () => {
    pi.events.emit(REGISTER_CHANNEL, { ...rest, defaults: defaults?.(), owner });
  };

  const unsubscribeRequest = pi.events.on(REQUEST_CHANNEL, (data) => {
    if (owner && isRecord(data) && data.owner === owner) announce();
  });
  const unsubscribeInstances = pi.events.on(INSTANCES_CHANNEL, (data) => {
    if (!owner || !isRecord(data) || data.owner !== owner || data.id !== definition.id) return;
    if (!Array.isArray(data.instances)) return;
    onInstances?.(
      data.instances
        .filter(isRecord)
        .map((entry) => (isRecord(entry.options) ? (entry.options as SlotOptions) : {})),
    );
  });
  const unsubscribeOptions = pi.events.on(OPTIONS_CHANNEL, (data) => {
    if (!owner || !isRecord(data) || data.owner !== owner) return;
    if (!onOptions || data.id !== definition.id) return;
    const instances = Array.isArray(data.instances)
      ? data.instances
          .filter(isRecord)
          .map((entry) => (isRecord(entry.options) ? (entry.options as SlotOptions) : {}))
      : [];
    onOptions(instances[0] ?? {}, instances);
    // The handler just changed the config `defaults` reads from, and those are
    // what an unset field shows: re-announce so it keeps naming the truth.
    announce();
  });

  return {
    dispose: () => {
      unsubscribeRequest();
      unsubscribeOptions();
      unsubscribeInstances();
      if (owner) pi.events.emit(UNREGISTER_CHANNEL, { id: definition.id, owner });
    },
    /** Call at session start and on config changes so ownership and defaults follow. */
    refresh: (ctx) => {
      owner = ctx.sessionManager.getSessionId();
      announce();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
