/**
 * Publishes the usage status as a statusline slot, so a statusline extension
 * can place it anywhere in the bar instead of leaving it in the catch-all row.
 *
 * Standalone by design: it talks to pi's shared event bus and imports nothing
 * from the statusline package. With no statusline installed the events go
 * nowhere and the calls cost nothing, so this stays alongside
 * `ctx.ui.setStatus`, which is what a stock pi footer reads.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PUBLISH_CHANNEL = "statusline:publish";
const CLEAR_CHANNEL = "statusline:clear";
const REQUEST_CHANNEL = "statusline:request";

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

/**
 * Returns a setter for the slot's text; `undefined` hides it.
 *
 * The last value is re-sent whenever the statusline asks for it, which covers
 * the statusline starting after this extension has already published — load
 * order between extensions is not fixed.
 */
export function publishStatuslineItem(
  pi: ExtensionAPI,
  definition: SlotDefinition,
): (text: string | undefined) => void {
  let current: string | undefined;

  const send = () => {
    if (current === undefined) pi.events.emit(CLEAR_CHANNEL, { id: definition.id });
    else pi.events.emit(PUBLISH_CHANNEL, { ...definition, text: current });
  };

  pi.events.on(REQUEST_CHANNEL, () => {
    if (current !== undefined) send();
  });

  return (text: string | undefined) => {
    if (text === current) return;
    current = text;
    send();
  };
}
