import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PUBLISH_CHANNEL = "statusline:publish";
const CLEAR_CHANNEL = "statusline:clear";
const REQUEST_CHANNEL = "statusline:request";
type SpeedSlotDefinition = { id: "speed" };

/**
 * Replay recovers publications dropped before the owning statusline's session_start.
 * Pass the context performing each write so unchanged text moves with sessions.
 */
export function publishStatuslineItem(
  pi: ExtensionAPI,
  definition: SpeedSlotDefinition,
): (ctx: Pick<ExtensionContext, "sessionManager">, text: string | undefined) => void {
  let owner: string | undefined;
  let current: string | undefined;

  const send = () => {
    if (current === undefined) pi.events.emit(CLEAR_CHANNEL, { id: definition.id, owner });
    else pi.events.emit(PUBLISH_CHANNEL, { id: definition.id, text: current, owner });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
