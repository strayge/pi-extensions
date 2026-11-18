export const EXTENSION_BUS_FEATURE = "extension-bus-v1";
export const EXACT_SEND_FEATURE = "exact-send-v1";
export const UNIFIED_MESSAGING_FEATURE = "unified-messaging-v2";
export const PARENT_IDENTITY_FEATURE = "parent-identity-v1";
export const BROADCAST_AUDIENCE_FEATURE = "broadcast-audience-v1";
export type BroadcastDestination = "workspace" | "global";
export const RESERVED_DESTINATIONS = new Set(["parent", "workspace", "global"]);
/** Broker refused a register because another live process holds the session id. */
export const SESSION_HELD_ERROR_CODE = "E_SESSION_HELD";

/** `socket_delivered` is the wire name for receiver-path acceptance, never read/processing proof. */
export type DeliveryState = "socket_delivered" | "queued" | "failed" | "unknown";

export interface DeliveryDetails {
  delivery: DeliveryState;
  code?: string;
  retryable: boolean;
  outcomeKnown: boolean;
}

export type HerdrLocation =
  | {
      status: "current";
      workspace: { id: string; label: string };
      tab: { id: string; label: string };
      paneId: string;
      /** Time when the broker requested the live Herdr snapshot. */
      refreshedAt: number;
    }
  | { status: "not_hosted" }
  | {
      status: "unavailable";
      paneId: string;
      reason: "herdr_unavailable" | "unsupported" | "command_failed" | "pane_missing" | "invalid_response";
      detail?: string;
    };

export interface SessionInfo {
  id: string;
  /** Pi runtime identity, independent of a configured intercom routing ID. */
  canonicalSessionId?: string;
  /** Current immediate launcher's canonical Pi identity, never transcript ancestry. */
  parentSessionId?: string;
  /** Workers are agents with parentSessionId; CLI/relay participants are transport-only. */
  role?: "agent" | "transport";
  /** Broker-owned lifetime of this live endpoint. */
  endpointEpoch?: string;
  name?: string;
  /** True only when the extension synthesized name for an unnamed runtime. */
  runtimeFallbackAlias?: boolean;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  /** Live context-window usage, pushed via presence from the source session's
   *  getContextUsage(). contextPct is 0..100 (rounded); contextTokens /
   *  contextWindow are raw token counts. All optional: unknown right after a
   *  compaction (before the next assistant response), when no model is selected,
   *  or on older clients that never report it. */
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** tmux pane id (e.g. "%212") of the session's terminal, read from
   *  $TMUX_PANE at registration. Present only when the session runs inside a
   *  tmux pane; absent for cloud, headless, IDE-embedded, or Herdr sessions.
   *  The pane id is immutable for the process lifetime — unlike the window
   *  name, which is mutable — so a peer can live-resolve the current window
   *  from it via tmux when it needs to introspect or drive that pane. */
  tmuxPane?: string;
  /** Launch-time Herdr pane alias. It may differ from the current pane id after a move. */
  herdrPaneId?: string;
  /** Present on list responses. `current` is freshly resolved for that request;
   *  other states explicitly distinguish non-Herdr sessions from failures. */
  herdrLocation?: HerdrLocation;
}

export type SessionHolder = Pick<SessionInfo, "pid" | "cwd" | "name">;

export interface CrossMachineOrigin {
  name: string;
  sessionId: string;
  machine: string;
}

export interface CrossMachineProvenance {
  type: "ssh-relay";
  version: 1;
  origin: CrossMachineOrigin;
  trust: "ssh-asserted";
}

export interface Message {
  id: string;
  timestamp: number;
  senderSequence?: number;
  brokerReceivedAt?: number;
  brokerDeliveredAt?: number;
  receiverReceivedAt?: number;
  injectedAt?: number;
  supersedes?: string;
  retryOf?: string;
  replyTo?: string;
  expectsReply?: boolean;
  /** Native next-turn delivery; false/omitted actively wakes or steers. */
  quiet?: boolean;
  provenance?: MessageProvenance;
  crossMachine?: CrossMachineProvenance;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface MessageProvenance {
  type: "extension_outbox";
  extensionId: string;
  extensionName: string;
  requestId: string;
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type MessageReceiptStatus = "receiver_received" | "accepted" | "queued" | "injected" | "acknowledged" | "failed" | "rejected" | "unsupported" | "expired" | "cancelled" | "superseded" | "cancellation_requested";

export interface MessageReceipt {
  messageId: string;
  status: MessageReceiptStatus;
  timestamp: number;
  detail?: string;
}

export type MessageControlAction = "cancel" | "supersede";

export interface MessageControl {
  messageId: string;
  action: MessageControlAction;
  timestamp: number;
  supersededBy?: string;
  detail?: string;
}

export interface ExtensionCapability {
  namespace: string;
  ownerEligible: boolean;
}

export type SessionRegistration = Omit<SessionInfo, "id" | "endpointEpoch" | "peerUid" | "trustedLocal" | "herdrLocation"> & {
  extensions?: ExtensionCapability[];
  features?: string[];
  /** Broker-only join hint; never returned in the public roster. */
  herdrSessionPath?: string;
  /** The client emits delivery receipts. Socket receipt alone is never acceptance proof. */
  acknowledgesReceipts?: boolean;
  /** The client sends a frame at least this often, so the broker may drop it after several silent intervals. */
  livenessIntervalMs?: number;
};

export type ClientMessage =
  | { type: "register"; session: SessionRegistration; sessionId?: string; stateId?: string; scopeId?: string }
  | { type: "unregister"; moveToScopeId?: string | null }
  | { type: "extension_capabilities_update"; extensions: ExtensionCapability[] }
  | { type: "list"; requestId: string; resolve?: string; audience?: BroadcastDestination }
  | { type: "send"; to: string; message: Message; targetId?: string; targetEpoch?: string }
  | { type: "message_receipt"; receipt: MessageReceipt }
  | { type: "cancel_message"; messageId: string }
  | { type: "cancel_ask"; messageId: string }
  | { type: "presence"; name?: string; runtimeFallbackAlias?: boolean; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null }
  | {
      type: "extension_publish";
      namespace: string;
      audience: "owner" | "capable";
      ownerEpoch?: string;
      ownerOnly?: boolean;
      payload: unknown;
    }
  | {
      type: "extension_state_commit";
      namespace: string;
      ownerEpoch: string;
      expectedRevision: number;
      payload: unknown;
    };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; features?: string[] }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string; code?: string; holder?: SessionHolder }
  | ({ type: "delivered"; messageId: string } & DeliveryDetails)
  | ({ type: "delivery_failed"; messageId: string; reason: string } & DeliveryDetails)
  | { type: "message_receipt"; from: SessionInfo; receipt: MessageReceipt }
  | { type: "message_control"; from: SessionInfo; control: MessageControl }
  | { type: "extension_owner"; namespace: string; ownerId?: string; ownerEpoch?: string }
  | {
      type: "extension_message";
      namespace: string;
      fromSessionId: string;
      ownerId?: string;
      ownerEpoch?: string;
      payload: unknown;
    }
  | {
      type: "extension_state";
      namespace: string;
      revision: number;
      payload: unknown;
    }
  | {
      type: "extension_state_result";
      namespace: string;
      committed: boolean;
      revision: number;
      reason?: string;
    };
