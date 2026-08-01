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
import type { SlotItem } from "./types.ts";

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
