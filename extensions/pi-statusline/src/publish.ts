/**
 * Producer side of the slot protocol.
 *
 * Standalone by design: it imports nothing from this package beyond types, so
 * another extension can copy this file verbatim rather than take a dependency
 * on the statusline. If the statusline is not installed, the events go nowhere
 * and the calls cost nothing. Messages carry the calling session's owner, and
 * replays/options only match that owner.
 *
 *   import { publishStatuslineItem } from "./statusline-publish.ts";
 *
 *   export default function (pi: ExtensionAPI) {
 *     const publish = publishStatuslineItem(pi, {
 *       id: "usage",
 *       icon: "📊",
 *       defaultPlacement: { line: 1, side: "right" },
 *     });
 *     pi.on("session_start", (_event, ctx) => publish(ctx, "42%"));
 *     pi.on("session_shutdown", (_event, ctx) => publish(ctx, undefined));
 *   }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  SlotFieldSpec,
  SlotItem,
  SlotOptions,
  SlotRenderEnv,
  SlotRenderResult,
} from "./types.ts";

export type SlotDefinition = Omit<SlotItem, "text">;

/**
 * Returns a setter for one slot's text.
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
    if (current === undefined) pi.events.emit("statusline:clear", { id: definition.id, owner });
    else pi.events.emit("statusline:publish", { ...definition, text: current, owner });
  };

  pi.events.on("statusline:request", (data) => {
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
}

/**
 * Defer the schema announcement until refresh(ctx) supplies a session owner,
 * so another session's requests and options cannot affect this slot.
 *
 * `render` is called synchronously while the statusline paints, and again while
 * the user cycles options in the layout editor — with the *pending* values, so
 * the preview is exact and nothing has to be persisted to try a setting out.
 * Keep it pure and quick: no I/O, no awaiting, and no throwing, though a throw
 * costs the slot rather than the session.
 *
 *   const slot = registerStatuslineSlot(pi, {
 *     id: "usage",
 *     version: 1,
 *     fields: [{ key: "barWidth", label: "bar width", kind: "number", min: 1, max: 40 }],
 *     defaults: () => ({ barWidth: config.barWidth }),
 *     render: (options, env) => draw(options, env.preview),
 *     onOptions: (options) => save({ ...config, ...options }),
 *   });
 *   pi.on("session_start", (_event, ctx) => slot.refresh(ctx));
 */
export function registerStatuslineSlot(
  pi: ExtensionAPI,
  definition: SlotSchemaDefinition,
): { dispose: () => void; refresh: (ctx: Pick<ExtensionContext, "sessionManager">) => void } {
  const { defaults, onOptions, ...rest } = definition;
  let owner: string | undefined;

  const announce = () => {
    pi.events.emit("statusline:register", { ...rest, defaults: defaults?.(), owner });
  };

  const unsubscribeRequest = pi.events.on("statusline:request", (data) => {
    if (owner && isRecord(data) && data.owner === owner) announce();
  });
  const unsubscribeOptions = pi.events.on("statusline:options", (data) => {
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
      if (owner) pi.events.emit("statusline:unregister", { id: definition.id, owner });
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
