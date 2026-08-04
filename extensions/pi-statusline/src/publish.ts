/**
 * Producer side of the slot protocol.
 *
 * Standalone by design: it imports nothing from this package beyond types, so
 * another extension can copy this file verbatim rather than take a dependency
 * on the statusline. If the statusline is not installed, the events go nowhere
 * and the calls cost nothing.
 *
 *   import { publishStatuslineItem } from "./statusline-publish.ts";
 *
 *   export default function (pi: ExtensionAPI) {
 *     const publish = publishStatuslineItem(pi, {
 *       id: "usage",
 *       icon: "📊",
 *       defaultPlacement: { line: 1, side: "right" },
 *     });
 *     publish("42%");        // show
 *     publish(undefined);    // hide
 *   }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
 * The last published text is re-sent whenever the statusline asks, which covers
 * the case where the statusline starts after the producer has already spoken.
 */
export function publishStatuslineItem(
  pi: ExtensionAPI,
  definition: SlotDefinition,
): (text: string | undefined) => void {
  let current: string | undefined;

  const send = () => {
    if (current === undefined) pi.events.emit("statusline:clear", { id: definition.id });
    else pi.events.emit("statusline:publish", { ...definition, text: current });
  };

  pi.events.on("statusline:request", () => {
    if (current !== undefined) send();
  });

  return (text: string | undefined) => {
    if (text === current) return;
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
 * Register an option schema and a renderer for one slot.
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
 */
export function registerStatuslineSlot(
  pi: ExtensionAPI,
  definition: SlotSchemaDefinition,
): { dispose: () => void; refresh: () => void } {
  const { defaults, onOptions, ...rest } = definition;

  const announce = () => {
    pi.events.emit("statusline:register", { ...rest, defaults: defaults?.() });
  };

  const unsubscribeRequest = pi.events.on("statusline:request", announce);
  const unsubscribeOptions = pi.events.on("statusline:options", (data) => {
    if (!onOptions || !isRecord(data) || data.id !== definition.id) return;
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

  announce();

  return {
    dispose: () => {
      unsubscribeRequest();
      unsubscribeOptions();
      pi.events.emit("statusline:unregister", { id: definition.id });
    },
    /** Call when your own config changed elsewhere, so the defaults follow. */
    refresh: announce,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
