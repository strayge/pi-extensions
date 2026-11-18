import { randomUUID } from "node:crypto";
import type { IntercomClient, SendResult } from "./broker/client.ts";
import type { BroadcastDestination, SessionInfo } from "./types.ts";

export function isBroadcastDestination(to: string | undefined | null): to is BroadcastDestination {
  return to === "workspace" || to === "global";
}

export type BroadcastRecipientResult = {
  targetId: string;
  endpointEpoch: string;
} & (SendResult | { delivery: "not_attempted"; reason: string });

export interface BroadcastResult {
  destination: BroadcastDestination;
  ok: boolean;
  interrupted: boolean;
  total: number;
  accepted: number;
  queued: number;
  failed: number;
  unknown: number;
  notAttempted: number;
  recipients: BroadcastRecipientResult[];
}

/** Sequential dispatch keeps undispatched snapshot entries unsent on interruption. */
export async function sendBroadcast(
  client: Pick<IntercomClient, "send" | "isConnected">,
  destination: BroadcastDestination,
  snapshot: readonly SessionInfo[],
  options: Pick<Parameters<IntercomClient["send"]>[1], "text" | "attachments" | "quiet" | "signal">,
): Promise<BroadcastResult> {
  if (snapshot.some(target => !target.endpointEpoch)) throw new Error("Broadcast snapshots require connected exact endpoints");
  const recipients: BroadcastRecipientResult[] = [];
  let interrupted = false;
  for (const target of snapshot) {
    const binding = { targetId: target.id, endpointEpoch: target.endpointEpoch! };
    if (interrupted || options.signal?.aborted || !client.isConnected()) {
      interrupted = true;
      recipients.push({ ...binding, delivery: "not_attempted", reason: "Broadcast interrupted before dispatch" });
      continue;
    }
    const id = randomUUID();
    try {
      const result = await client.send(target.id, { ...options, quiet: options.quiet ?? true, target, messageId: id });
      recipients.push({ ...result, ...binding });
      if (result.code === "E_SEND_INTERRUPTED") interrupted = true;
    } catch (error) {
      // A disconnected socket can reject after its write; never call that undelivered.
      recipients.push({ ...binding, id, delivered: false, delivery: "unknown", code: "E_SEND_INTERRUPTED", retryable: false, outcomeKnown: false, reason: error instanceof Error ? error.message : String(error) });
      interrupted = true;
    }
  }
  const count = (delivery: BroadcastRecipientResult["delivery"]) => recipients.filter(result => result.delivery === delivery).length;
  const accepted = count("socket_delivered");
  const queued = count("queued");
  return {
    destination, ok: snapshot.length > 0 && !interrupted && accepted + queued === snapshot.length,
    interrupted, total: snapshot.length, accepted, queued,
    failed: count("failed"), unknown: count("unknown"), notAttempted: count("not_attempted"), recipients,
  };
}

export function formatBroadcastResult(result: BroadcastResult): string {
  if (result.total === 0) return `Broadcast to ${result.destination}: zero recipients; no messages dispatched.`;
  const summary = `Broadcast to ${result.destination}${result.interrupted ? " interrupted" : ""}: ${result.accepted} accepted, ${result.queued} queued, ${result.failed} failed, ${result.unknown} unknown, ${result.notAttempted} not attempted (${result.total} recipients). Acceptance is not read or processing proof.`;
  return [summary, ...result.recipients.map(recipient => {
    const delivery = recipient.delivery === "socket_delivered" ? "accepted" : recipient.delivery;
    return `${recipient.targetId}: ${delivery}${"id" in recipient ? ` (${recipient.id})` : ""}${recipient.reason ? ` — ${recipient.reason}` : ""}`;
  })].join("\n");
}
