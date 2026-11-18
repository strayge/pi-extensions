import type { DeliveryDetails, SessionInfo } from "./types.ts";

export const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
export const INTERCOM_EXTENSION_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";
export const INTERCOM_OUTBOX_REQUEST_EVENT = "intercom:outbox-request";
export const INTERCOM_OUTBOX_RESULT_EVENT = "intercom:outbox-result";
export const INTERCOM_SESSION_IDENTITY_EVENT = "intercom:session-identity";

/**
 * Emitted before choosing the intercom ID. The bus may be shared by SDK sessions:
 * providers must match sessionId to the exact canonical child they own before
 * claiming. Claims override process/machine-wide routing configuration. Parent
 * metadata describes this launch, not the ancestry of a resumed transcript.
 * Conflicting claims fail rather than selecting another runtime's relationship.
 */
export interface IntercomSessionIdentityRequestV1 {
  version: 1;
  sessionId: string;
  claim(stableId: string, relationship?: { parentSessionId?: string }): void;
}

export type IntercomOutboxResultStatus = "sent" | "rejected" | "blocked" | "failed";

export type IntercomOutboxResultCode =
  | "user_cancelled"
  | "confirmation_unavailable"
  | "session_unavailable"
  | "session_ended"
  | "invalid_request"
  | "duplicate_request"
  | "target_not_found"
  | "target_ambiguous"
  | "self_target"
  | "delivery_failed"
  | "delivery_unknown";

export interface IntercomOutboxRequestV1 {
  version: 1;
  requestId: string;
  extensionId: string;
  extensionName: string;
  to: string;
  message: string;
}

export type IntercomOutboxRequest = IntercomOutboxRequestV1;

export interface IntercomOutboxResultV1 extends Partial<DeliveryDetails> {
  version: 1;
  requestId: string;
  status: IntercomOutboxResultStatus;
  code?: IntercomOutboxResultCode;
  extensionId?: string;
  extensionName?: string;
  messageId?: string;
  targetId?: string;
  detail?: string;
}

export type IntercomOutboxResult = IntercomOutboxResultV1;

export interface IntercomExtensionOwner {
  sessionId: string;
  epoch: string;
}

export interface IntercomExtensionState {
  revision: number;
  payload: unknown;
}

export type IntercomExtensionEvent =
  | { type: "connection"; connected: boolean; supported: boolean }
  | { type: "owner"; owner?: IntercomExtensionOwner }
  | { type: "message"; fromSessionId: string; owner?: IntercomExtensionOwner; payload: unknown }
  | { type: "state"; state: IntercomExtensionState }
  | { type: "state_result"; committed: boolean; revision: number; reason?: string }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: SessionInfo };

export interface IntercomExtensionChannel {
  readonly namespace: string;
  snapshot(): {
    connected: boolean;
    supported: boolean;
    owner?: IntercomExtensionOwner;
    state?: IntercomExtensionState;
  };
  publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  commitState(payload: unknown, expectedRevision?: number): void;
  listSessions(): Promise<SessionInfo[]>;
}

export interface IntercomExtensionRegistration {
  namespace: string;
  ownerEligible: boolean;
  onEvent(event: IntercomExtensionEvent): void;
  onReady(channel: IntercomExtensionChannel): void;
}
