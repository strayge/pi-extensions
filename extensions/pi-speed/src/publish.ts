import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PUBLISH_CHANNEL = "statusline:publish";
const CLEAR_CHANNEL = "statusline:clear";
const REQUEST_CHANNEL = "statusline:request";
type SpeedSlotDefinition = { id: "speed" };

/** Replay keeps the value visible when the statusline loads after this producer. */
export function publishStatuslineItem(
  pi: ExtensionAPI,
  definition: SpeedSlotDefinition,
): (text: string | undefined) => void {
  let current: string | undefined;

  const send = () => {
    if (current === undefined) pi.events.emit(CLEAR_CHANNEL, { id: definition.id });
    else pi.events.emit(PUBLISH_CHANNEL, { id: definition.id, text: current });
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
