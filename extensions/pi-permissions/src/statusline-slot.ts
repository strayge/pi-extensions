/**
 * Publishes the mode and network chips as statusline slots, so a statusline
 * extension can place each one anywhere in the bar instead of leaving the pair
 * in the catch-all row.
 *
 * Standalone by design: it talks to pi's shared event bus and imports nothing
 * from the statusline package. With no statusline installed the events go
 * nowhere and the calls cost nothing, so this stays alongside
 * `ctx.ui.setStatus`, which is what a stock pi footer reads. Messages carry
 * the calling session's owner, and replays only match that session owner.
 *
 * Unlike the reference helper, the setter takes a color per call — a mode's
 * color is part of what the chip reports, so it changes as the mode does.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PUBLISH_CHANNEL = "statusline:publish";
const CLEAR_CHANNEL = "statusline:clear";
const REQUEST_CHANNEL = "statusline:request";

/**
 * The statusline's palette. Anything outside it throws while the footer paints,
 * and a throw there takes the session down — so mode colors, which are
 * unvalidated user config, are checked against this rather than passed through.
 */
export const SLOT_COLORS = [
  "dim",
  "muted",
  "text",
  "accent",
  "success",
  "warning",
  "error",
  "mdLink",
] as const;

export type SlotColor = (typeof SLOT_COLORS)[number];

export interface SlotDefinition {
  id: string;
  icon?: string;
  color?: SlotColor;
  priority?: number;
  defaultPlacement?: { line?: number; side?: "left" | "center" | "right"; order?: number };
}

/**
 * Returns a setter for one slot; `undefined` hides it.
 *
 * The last value is re-sent when the owning session's statusline asks for it,
 * recovering publications dropped before the statusline's session_start.
 * Pass the context performing each write so unchanged text moves with sessions.
 */
export function publishStatuslineItem(
  pi: ExtensionAPI,
  definition: SlotDefinition,
): (ctx: Pick<ExtensionContext, "sessionManager">, text: string | undefined, color?: SlotColor) => void {
  let sessionOwner: string | undefined;
  let current: string | undefined;
  let currentColor: SlotColor | undefined;

  const send = () => {
    if (current === undefined) pi.events.emit(CLEAR_CHANNEL, { id: definition.id, owner: sessionOwner });
    else pi.events.emit(PUBLISH_CHANNEL, { ...definition, color: currentColor ?? definition.color, text: current, owner: sessionOwner });
  };

  pi.events.on(REQUEST_CHANNEL, (data) => {
    if (sessionOwner && isRecord(data) && data.owner === sessionOwner && current !== undefined) send();
  });

  return (ctx, text, color) => {
    const nextSessionOwner = ctx.sessionManager.getSessionId();
    if (nextSessionOwner === sessionOwner && text === current && color === currentColor) return;
    sessionOwner = nextSessionOwner;
    current = text;
    currentColor = color;
    send();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
