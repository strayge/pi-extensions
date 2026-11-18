import { BorderedLoader, defineTool, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { IntercomClient, IntercomSessionHeldError, type SendResult } from "./broker/client.ts";
import { formatBroadcastResult, isBroadcastDestination, sendBroadcast } from "./broadcast.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { SessionListOverlay, type SessionListSelection } from "./ui/session-list.ts";
import { HandoverPicker, type HandoverPickerResult, type RemoteSessionLister } from "./ui/handover-picker.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";
import { getAskTimeoutMs, getIntercomScopeId, loadConfig, setIntercomScopeId, type IntercomConfig } from "./config.ts";
import { EXTENSION_BUS_FEATURE, RESERVED_DESTINATIONS } from "./types.ts";
import type { Attachment, BrokerMessage, Message, MessageControl, MessageReceiptStatus, SessionInfo, SessionRegistration } from "./types.ts";
import {
  INTERCOM_EXTENSION_REGISTER_EVENT,
  INTERCOM_EXTENSION_REGISTRY_READY_EVENT,
  INTERCOM_OUTBOX_REQUEST_EVENT,
  INTERCOM_OUTBOX_RESULT_EVENT,
  INTERCOM_SESSION_IDENTITY_EVENT,
  type IntercomExtensionChannel,
  type IntercomExtensionEvent,
  type IntercomExtensionOwner,
  type IntercomExtensionRegistration,
  type IntercomExtensionState,
  type IntercomOutboxRequestV1,
  type IntercomOutboxResultCode,
  type IntercomOutboxResultStatus,
  type IntercomOutboxResultV1,
  type IntercomSessionIdentityRequestV1,
} from "./extension-api.ts";
import { ReplyWaiter } from "./reply-tracker.ts";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { sameCwd } from "./cwd.ts";
import { initializeIntercomPool } from "./pool.ts";
import { formatContextUsage } from "./format-context.ts";
import { openProjectPane, resolveTargetInCwd, waitForProjectSession, type ProjectPaneLaunch } from "./project-agent.ts";
import { relaySenderName } from "./cross-machine-envelope.ts";
import { runCommand, sendCrossMachine } from "./cross-machine-transport.ts";
import { listMachineAgents, listSavedMachines, parseCrossMachineTarget } from "./cross-machine-discovery.ts";
import { formatHandoverMessage, generateHandoverBody, readGitState } from "./handover.ts";
import { isIdleWakePending, releaseIdleWake, reserveIdleWake } from "./idle-wake.ts";

const INTERCOM_TOOL_NAME = "intercom";
const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const INBOUND_MESSAGE_DEDUPE_MAX = 1000;
const INBOUND_MESSAGE_DEDUPE_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";
const INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_SESSION_ID";
const STABLE_INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_STABLE_ID";
const NAME_POLL_MS_ENV = "PI_INTERCOM_NAME_POLL_MS";

interface InboundMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

interface DeliveryTarget {
  id: string;
  label: string;
  peer?: SessionInfo;
  projectPane?: ProjectPaneLaunch;
}

interface DeliveryRequest {
  to?: string;
  cwd?: string;
  openProjectPaneIfMissing?: boolean;
  focus?: boolean;
  message: string;
  attachments?: Attachment[];
  replyTo?: string;
  supersedes?: string;
  retryOf?: string;
  wait?: boolean;
  quiet?: boolean;
  /** Handovers are always new messages and are not sent once the signal aborts. */
  handover?: boolean;
  /** Preserve an interactive selection through generation and editor delays. */
  resolvedPeer?: SessionInfo;
}

interface IntercomToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface OutboxTarget {
  id: string;
  label: string;
  peer: SessionInfo;
}

interface OutboxRequestTrace {
  requestId: string;
  extensionId?: string;
  extensionName?: string;
  to?: string;
  message?: string;
}

interface PendingOutboxRequest {
  generation: number;
  request: OutboxRequestTrace;
  dispatchedTargetId?: string;
}

type OutboxResultOptions = Pick<IntercomOutboxResultV1, "code" | "detail" | "messageId" | "targetId" | "delivery" | "retryable" | "outcomeKnown">;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Newer Pi custom-started runs use the normal prompt lifecycle and next-turn queue.
// An unparseable version takes the older, user-prompt wake path.
function triggerTurnRunsPromptLifecycle(piVersion: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(piVersion);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 1 || (major === 1 && Number(match[2]) >= 2);
}

export function explicitCrossMachineSendRestriction(options: {
  to?: string;
  cwd?: string;
  openProjectPaneIfMissing?: boolean;
  attachments?: readonly unknown[];
  replyTo?: string;
  supersedes?: string;
  retryOf?: string;
}): string | undefined {
  if (!options.to?.includes("@")) return undefined;
  if (options.cwd || options.openProjectPaneIfMissing) {
    return "Cross-machine send does not support cwd or opening project panes.";
  }
  if (options.replyTo || options.supersedes || options.retryOf || options.attachments?.length) {
    return "Cross-machine send only supports a new text message; attachments, reply relationships, supersede, and retry are not supported.";
  }
  return undefined;
}

// An unconfirmed outcome must not read as a failure: the receiver may still have the message.
function undeliveredText(target: string, result: SendResult): string {
  const reason = result.reason ?? "Session may not exist or has disconnected.";
  return result.outcomeKnown
    ? `Message to "${target}" was not delivered: ${reason}`
    : `Delivery to "${target}" could not be confirmed: ${reason}. The message may still arrive, so sending it again could duplicate it.`;
}

function queuedText(target: string, what = "message"): string {
  return `Session "${target}" is not connected. The ${what} was queued in a volatile broker mailbox for that exact identity; it may be lost if the broker restarts.`;
}

function deliveryDetails(result: SendResult): Record<string, unknown> {
  return {
    messageId: result.id,
    ...(result.targetId ? { targetId: result.targetId } : {}),
    delivered: result.delivered,
    delivery: result.delivery,
    retryable: result.retryable,
    outcomeKnown: result.outcomeKnown,
    ...(result.code ? { code: result.code } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatAttachments(attachments: Attachment[]): string {
  let text = "";
  for (const att of attachments) {
    if (att.language) {
      text += `\n\n---\nAttachment: ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\nAttachment: ${att.name}\n${att.content}`;
    }
  }
  return text;
}
function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  return new Set(
    sessions
      .map(s => s.name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
      .filter((name, index, names) => names.indexOf(name) !== index)
  );
}
function sessionIdPrefixes(sessions: SessionInfo[]): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const session of sessions) {
    let longestSharedPrefix = 0;
    for (const other of sessions) {
      if (other.id === session.id) {
        continue;
      }
      let length = 0;
      while (length < session.id.length && session.id[length] === other.id[length]) {
        length += 1;
      }
      longestSharedPrefix = Math.max(longestSharedPrefix, length);
    }
    const minimumLength = Math.max(8, longestSharedPrefix + 1);
    const groupBoundary = session.id.indexOf("-", minimumLength);
    const length = groupBoundary === -1 ? minimumLength : groupBoundary;
    prefixes.set(session.id, session.id.slice(0, length));
  }
  return prefixes;
}
function parseSubagentIntercomPayload(payload: unknown): { to: string; message: string; requestId?: string } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.to !== "string" || typeof record.message !== "string") {
    return null;
  }
  const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
  return { to: record.to, message: record.message, ...(requestId ? { requestId } : {}) };
}
function parseOutboxRequestPayload(payload: unknown): { ok: true; request: IntercomOutboxRequestV1 } | { ok: false; requestId?: string; extensionId?: string; extensionName?: string; detail: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, detail: "request must be an object" };
  }
  const record = payload as Record<string, unknown>;
  const requestId = typeof record.requestId === "string" && record.requestId.trim() ? record.requestId : undefined;
  const extensionId = typeof record.extensionId === "string" && record.extensionId.trim() ? record.extensionId.trim() : undefined;
  const extensionName = typeof record.extensionName === "string" && record.extensionName.trim() ? record.extensionName.trim() : undefined;
  if (record.version !== 1) {
    return { ok: false, requestId, extensionId, extensionName, detail: "version must be 1" };
  }
  if (!requestId) {
    return { ok: false, extensionId, extensionName, detail: "requestId is required" };
  }
  if (!extensionId) {
    return { ok: false, requestId, extensionName, detail: "extensionId is required" };
  }
  if (!extensionName) {
    return { ok: false, requestId, extensionId, detail: "extensionName is required" };
  }
  if (typeof record.to !== "string" || !record.to.trim()) {
    return { ok: false, requestId, extensionId, extensionName, detail: "to is required" };
  }
  if (typeof record.message !== "string" || !record.message.trim()) {
    return { ok: false, requestId, extensionId, extensionName, detail: "message is required" };
  }
  return {
    ok: true,
    request: {
      version: 1,
      requestId,
      extensionId,
      extensionName,
      to: record.to.trim(),
      message: record.message,
    },
  };
}
function resolveIntercomPresenceName(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 18)}`;
}
function buildPresenceIdentity(pi: ExtensionAPI, sessionId: string): { name: string; runtimeFallbackAlias: boolean } {
  const sessionName = pi.getSessionName();
  return {
    name: resolveIntercomPresenceName(sessionName, sessionId),
    runtimeFallbackAlias: !sessionName?.trim(),
  };
}
function resolveConfiguredIntercomSessionId(piSessionId: string, config: IntercomConfig): string {
  return process.env[STABLE_INTERCOM_SESSION_ID_ENV]?.trim() || config.stableId || piSessionId;
}
// The tmux pane id (e.g. "%212") the session was launched in. $TMUX_PANE is
// inherited at process start and immutable for the lifetime — moving the pane
// between windows keeps its id — so it is a stable join key a peer can use to
// live-resolve the current window via tmux. Absent outside tmux.
function currentTmuxPane(): string | undefined {
  const pane = process.env.TMUX_PANE?.trim();
  return pane ? pane : undefined;
}
// Herdr exports a launch-time pane alias to hosted processes. Its visible,
// workspace-qualified id can change when the pane moves, so registration also
// carries the stable Pi session file and the broker resolves both against a
// fresh snapshot. Workspace and tab ids are intentionally never registered.
function currentHerdrPane(): string | undefined {
  const pane = process.env.HERDR_PANE_ID?.trim();
  return pane ? pane : undefined;
}
function formatIntercomContactSnippet(sessionId: string): string {
  return `Use pi-intercom: intercom({ action: "send", to: "${sessionId}", message: "..." })`;
}
function formatSessionLabel(session: SessionInfo, duplicates: Set<string>): string {
  if (!session.name) {
    return session.id;
  }
  return duplicates.has(session.name.toLowerCase())
    ? `${session.name} (${session.id.slice(0, 8)})`
    : session.name;
}
function formatHerdrLocation(session: SessionInfo): string {
  const location = session.herdrLocation;
  if (!location) return "";
  if (location.status === "not_hosted") return "not under Herdr";
  if (location.status === "unavailable") return `Herdr location unavailable: ${location.reason} (pane ${location.paneId})`;
  return `Herdr ${location.workspace.label} [${location.workspace.id}] / ${location.tab.label} [${location.tab.id}] / pane ${location.paneId}`;
}
function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean, idPrefix: string): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  const pane = session.tmuxPane ? ` · tmux ${session.tmuxPane}` : "";
  const herdrLocation = formatHerdrLocation(session);
  const herdr = herdrLocation ? ` · ${herdrLocation}` : "";
  return `• ${name} (${idPrefix}) — ${session.cwd} (${session.model}${formatContextUsage(session)}${pane})${herdr}${suffix}`;
}
function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
function expandHomePath(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? joinPath(homedir(), path.slice(2)) : path;
}
function firstTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.replace(/\*\*/g, "") ?? "";
}
function formatMessageTimestamp(timestamp: number | undefined): string | undefined {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
function formatInboundDeliveryMetadata(message: Message): string {
  const parts = [`id ${message.id}`];
  if (message.quiet) parts.push("quiet information; no acknowledgement requested");
  if (typeof message.senderSequence === "number") parts.push(`seq ${message.senderSequence}`);
  if (message.supersedes) parts.push(`supersedes ${message.supersedes}`);
  if (message.retryOf) parts.push(`retry of ${message.retryOf}`);
  const sentAt = formatMessageTimestamp(message.timestamp);
  if (sentAt) parts.push(`sent ${sentAt}`);
  const brokerDeliveredAt = formatMessageTimestamp(message.brokerDeliveredAt);
  if (brokerDeliveredAt) parts.push(`broker delivered ${brokerDeliveredAt}`);
  const receiverReceivedAt = formatMessageTimestamp(message.receiverReceivedAt);
  if (receiverReceivedAt) parts.push(`receiver received ${receiverReceivedAt}`);
  const injectedAt = formatMessageTimestamp(message.injectedAt);
  if (injectedAt) parts.push(`injected ${injectedAt}`);
  return parts.join(" · ");
}
function getNamePollMs(): number {
  const configured = process.env[NAME_POLL_MS_ENV];
  if (configured !== undefined) {
    const value = Number(configured);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 1000;
}
export default function piIntercomExtension(pi: ExtensionAPI, piVersion = VERSION) {
  let client: IntercomClient | null = null;
  const wakeWithTriggerTurn = triggerTurnRunsPromptLifecycle(piVersion);
  const config: IntercomConfig = loadConfig();
  const askTimeoutMs = getAskTimeoutMs();
  const localExtensions = new Map<string, {
    registration: IntercomExtensionRegistration;
    channel: IntercomExtensionChannel;
    owner?: IntercomExtensionOwner;
    state?: IntercomExtensionState;
  }>();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentIntercomSessionId: string | null = null;
  let currentParentSessionId: string | undefined;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let namePollTimer: NodeJS.Timeout | null = null;
  let lastPresenceName: string | null = null;
  let lastPresenceRuntimeFallbackAlias: boolean | null = null;
  const previousIntercomSessionId = process.env[INTERCOM_SESSION_ID_ENV];
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let startupConnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  // Retrying a held session id cannot succeed until its holder exits, so background reconnects stop
  // until the next session start (/reload) or a successful manual connect.
  let sessionHeldBlocked = false;
  let shuttingDown = false;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  const heldInboundMessages: InboundMessageEntry[] = [];
  let heldInboundTimer: NodeJS.Timeout | null = null;
  function dropHeldInboundMessage(messageId: string, receipt: { status: MessageReceiptStatus; detail?: string }): boolean {
    const index = heldInboundMessages.findIndex((entry) => entry.message.id === messageId);
    if (index < 0) return false;
    heldInboundMessages.splice(index, 1);
    if (heldInboundMessages.length === 0) clearHeldInboundTimer();
    emitMessageReceipt(messageId, receipt.status, receipt.detail);
    return true;
  }
  function expireHeldInboundMessages(detail: string): void {
    for (const entry of heldInboundMessages.splice(0)) {
      emitMessageReceipt(entry.message.id, "expired", detail);
    }
    clearHeldInboundTimer();
  }
  const activeTools = new Map<string, string>();
  const replyWaiter = new ReplyWaiter(askTimeoutMs);

  const seenInboundMessages = new Map<string, number>();
  const latestOutboundReceipts = new Map<string, { status: MessageReceiptStatus; timestamp: number; detail?: string }>();
  const outboxRequestIds = new Set<string>();
  const pendingOutboxRequests = new Map<string, PendingOutboxRequest>();
  function hasSeenInboundMessage(from: SessionInfo, message: Message, now = Date.now()): boolean {
    for (const [key, seenAt] of seenInboundMessages) {
      if (now - seenAt > INBOUND_MESSAGE_DEDUPE_RETENTION_MS) {
        seenInboundMessages.delete(key);
      }
    }
    const key = `${from.id}\0${message.id}`;
    if (seenInboundMessages.has(key)) {
      return true;
    }
    seenInboundMessages.set(key, now);
    while (seenInboundMessages.size > INBOUND_MESSAGE_DEDUPE_MAX) {
      const oldestKey = seenInboundMessages.keys().next().value;
      if (typeof oldestKey !== "string") break;
      seenInboundMessages.delete(oldestKey);
    }
    return false;
  }
  function emitMessageReceipt(messageId: string, status: MessageReceiptStatus, detail?: string): void {
    try {
      client?.sendMessageReceipt({
        messageId,
        status,
        timestamp: Date.now(),
        ...(detail ? { detail } : {}),
      });
    } catch {
      // Receipts are diagnostics; message handling should not fail when the sender disconnects.
    }
  }
  function handleMessageControl(control: MessageControl): void {
    const supersededDetail = control.supersededBy ? `superseded by ${control.supersededBy}` : undefined;
    if (dropHeldInboundMessage(control.messageId, control.action === "cancel"
      ? { status: "cancelled", detail: "dropped before injection" }
      : { status: "superseded", detail: supersededDetail })) return;
    if (control.action === "cancel") {
      emitMessageReceipt(control.messageId, "cancellation_requested", "message may already be injected or processed");
      return;
    }
    emitMessageReceipt(control.messageId, "superseded", supersededDetail);
  }
  function latestDeliveryState(messageId: string | null, fallback: string): string {
    if (!messageId) {
      return fallback;
    }
    const receipt = latestOutboundReceipts.get(messageId);
    return receipt ? receipt.status : fallback;
  }
  function rejectReplyWaiter(error: Error): void {
    replyWaiter.reject(error);
  }
  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function clearStartupConnectTimer(): void {
    if (!startupConnectTimer) {
      return;
    }
    clearTimeout(startupConnectTimer);
    startupConnectTimer = null;
  }
  function clearNamePollTimer(): void {
    if (!namePollTimer) {
      return;
    }
    clearInterval(namePollTimer);
    namePollTimer = null;
  }
  function getLiveContext(ctx: ExtensionContext | null = runtimeContext, generation = runtimeGeneration): ExtensionContext | null {
    if (disposed || shuttingDown || generation !== runtimeGeneration || !ctx) {
      return null;
    }
    try {
      if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) {
        return null;
      }
      void ctx.hasUI;
      return ctx;
    } catch {
      // A context that throws while reading session/UI state is no longer usable.
      return null;
    }
  }
  function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext?.hasUI) {
      return;
    }
    try {
      liveContext.ui.notify(message, level);
    } catch {
      // The UI can disappear during session shutdown/reload while async overlay work is settling.
    }
  }
  function notifyCommand(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext) return;
    if (!liveContext.hasUI) {
      // Command handlers return void and print mode supplies a no-op UI. Keep
      // command output visible without injecting a synthetic Pi message.
      console.error(message);
      return;
    }
    notifyIfLive(liveContext, message, level, generation);
  }
  function getReconnectDelayMs(): number {
    const backoffMs = [1000, 2000, 5000, 10000, 30000];
    return backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]!;
  }
  function currentStatus(): string {
    const activeToolName = activeTools.values().next().value;
    const lifecycleStatus = activeToolName ? `tool:${activeToolName}` : agentRunning ? "thinking" : "idle";
    return config.status ? `${lifecycleStatus} · ${config.status}` : lifecycleStatus;
  }
  function emitLocalExtensionEvent(namespace: string, event: IntercomExtensionEvent): void {
    try {
      localExtensions.get(namespace)?.registration.onEvent(event);
    } catch {
      // One local extension must not break intercom or other extension channels.
    }
  }
  function createExtensionChannel(namespace: string): IntercomExtensionChannel {
    return {
      namespace,
      snapshot() {
        const extension = localExtensions.get(namespace);
        return {
          connected: Boolean(client?.isConnected()),
          supported: Boolean(client?.supportsFeature(EXTENSION_BUS_FEATURE)),
          ...(extension?.owner ? { owner: extension.owner } : {}),
          ...(extension?.state ? { state: extension.state } : {}),
        };
      },
      publish(payload, options = {}) {
        const activeClient = client;
        if (!activeClient?.isConnected()) throw new Error("Intercom is not connected");
        const extension = localExtensions.get(namespace);
        const ownerOnly = options.ownerOnly ?? false;
        const ownerEpoch = ownerOnly ? extension?.owner?.epoch : undefined;
        if (ownerOnly && !ownerEpoch) throw new Error(`No owner is available for ${namespace}`);
        activeClient.sendExtensionMessage({
          type: "extension_publish",
          namespace,
          audience: options.audience ?? "owner",
          ...(ownerOnly ? { ownerOnly: true, ownerEpoch } : {}),
          payload,
        });
      },
      commitState(payload, expectedRevision) {
        const activeClient = client;
        if (!activeClient?.isConnected()) throw new Error("Intercom is not connected");
        const extension = localExtensions.get(namespace);
        const ownerEpoch = extension?.owner?.epoch;
        if (!ownerEpoch || extension.owner?.sessionId !== activeClient.sessionId) {
          throw new Error(`Current session is not the owner of ${namespace}`);
        }
        activeClient.sendExtensionMessage({
          type: "extension_state_commit",
          namespace,
          ownerEpoch,
          expectedRevision: expectedRevision ?? extension.state?.revision ?? 0,
          payload,
        });
      },
      async listSessions() {
        const activeClient = client;
        if (!activeClient?.isConnected()) throw new Error("Intercom is not connected");
        return activeClient.listSessions();
      },
    };
  }
  function currentExtensionCapabilities() {
    return [...localExtensions.values()].map(({ registration }) => ({
      namespace: registration.namespace,
      ownerEligible: registration.ownerEligible,
    }));
  }
  function registerLocalExtension(registration: IntercomExtensionRegistration): void {
    if (!/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(registration.namespace)) {
      throw new Error(`Invalid intercom extension namespace: ${registration.namespace}`);
    }
    if (localExtensions.has(registration.namespace)) {
      throw new Error(`Intercom extension namespace already registered: ${registration.namespace}`);
    }
    const channel = createExtensionChannel(registration.namespace);
    localExtensions.set(registration.namespace, { registration, channel });
    const activeClient = client;
    const connected = Boolean(activeClient?.isConnected());
    const supported = Boolean(activeClient?.supportsFeature(EXTENSION_BUS_FEATURE));
    // Write the capability update before exposing a connected channel. Socket
    // framing preserves this order if onReady publishes synchronously.
    if (activeClient && connected && supported) {
      activeClient.updateExtensionCapabilities(currentExtensionCapabilities());
    }
    registration.onReady(channel);
    if (connected) {
      emitLocalExtensionEvent(registration.namespace, { type: "connection", connected: true, supported });
    }
  }
  function buildRegistration(): SessionRegistration {
    const liveContext = getLiveContext();
    if (!liveContext || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }

    const identity = buildPresenceIdentity(pi, currentIntercomSessionId ?? currentSessionId);
    const tmuxPane = currentTmuxPane();
    const herdrPaneId = currentHerdrPane();
    const herdrSessionPath = herdrPaneId ? liveContext.sessionManager.getSessionFile() : undefined;
    return {
      ...identity,
      role: "agent",
      canonicalSessionId: currentSessionId,
      ...(currentParentSessionId ? { parentSessionId: currentParentSessionId } : {}),
      cwd: liveContext.cwd,
      model: currentModel,
      pid: process.pid,
      startedAt: sessionStartedAt,
      lastActivity: Date.now(),
      status: currentStatus(),
      ...(tmuxPane ? { tmuxPane } : {}),
      ...(herdrPaneId ? { herdrPaneId } : {}),
      ...(herdrSessionPath ? { herdrSessionPath } : {}),
      // handleIncomingMessage confirms every message it accepts; one that lands mid-reload goes unconfirmed.
      acknowledgesReceipts: true,
      ...(localExtensions.size > 0
        ? {
            extensions: currentExtensionCapabilities(),
          }
        : {}),
    };
  }
  // Snapshot the live session's context-window usage for presence. getContextUsage()
  // (stock SDK) reports { tokens, contextWindow, percent }, with tokens/percent null
  // right after a compaction (before the next assistant response). We emit null in
  // that case to CLEAR a peer's stale value rather than freeze the old percentage.
  // Feature-detected so an older runtime without getContextUsage() just omits it.
  function currentContextUsage(): { contextPct?: number | null; contextTokens?: number | null; contextWindow?: number } {
    const usage = getLiveContext()?.getContextUsage?.();
    if (!usage) {
      return {};
    }
    const result: { contextPct?: number | null; contextTokens?: number | null; contextWindow?: number } = {
      contextPct: typeof usage.percent === "number" && Number.isFinite(usage.percent) ? Math.round(usage.percent) : null,
      contextTokens: typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null,
    };
    if (typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
      result.contextWindow = usage.contextWindow;
    }
    return result;
  }

  function syncPresenceIdentity(sessionId: string): void {
    if (!client || !getLiveContext()) {
      return;
    }
    const identity = buildPresenceIdentity(pi, currentIntercomSessionId ?? sessionId);
    lastPresenceName = identity.name;
    lastPresenceRuntimeFallbackAlias = identity.runtimeFallbackAlias;
    client.updatePresence({ ...identity, status: currentStatus(), ...currentContextUsage() });
  }
  function startNamePoll(): void {
    clearNamePollTimer();
    const initialIdentity = currentSessionId ? buildPresenceIdentity(pi, currentIntercomSessionId ?? currentSessionId) : null;
    lastPresenceName = initialIdentity?.name ?? null;
    lastPresenceRuntimeFallbackAlias = initialIdentity?.runtimeFallbackAlias ?? null;
    namePollTimer = setInterval(() => {
      if (!currentSessionId || !getLiveContext()) {
        return;
      }
      const identity = buildPresenceIdentity(pi, currentIntercomSessionId ?? currentSessionId);
      if (identity.name !== lastPresenceName || identity.runtimeFallbackAlias !== lastPresenceRuntimeFallbackAlias) {
        syncPresenceIdentity(currentSessionId);
      }
    }, getNamePollMs());
    namePollTimer.unref?.();
  }
  function publishIntercomSessionId(sessionId: string): void {
    process.env[INTERCOM_SESSION_ID_ENV] = sessionId;
  }
  function restoreIntercomSessionId(): void {
    if (previousIntercomSessionId === undefined) {
      delete process.env[INTERCOM_SESSION_ID_ENV];
      return;
    }
    process.env[INTERCOM_SESSION_ID_ENV] = previousIntercomSessionId;
  }
  function syncPresenceStatus(): void {
    if (!client || !currentSessionId || !getLiveContext()) {
      return;
    }
    // context% rides the status heartbeat so peers see live usage at turn boundaries.
    client.updatePresence({ status: currentStatus(), ...currentContextUsage() });
  }
  function currentSessionTargetMatches(to: string, resolvedTo?: string | null, activeClient?: IntercomClient): boolean {
    const targets = new Set<string>();
    const addTarget = (target: string | undefined | null) => {
      const trimmed = target?.trim();
      if (trimmed) targets.add(trimmed.toLowerCase());
    };
    addTarget(currentSessionId);
    addTarget(currentIntercomSessionId);
    addTarget(activeClient?.sessionId);
    addTarget(pi.getSessionName());
    if (currentSessionId) addTarget(buildPresenceIdentity(pi, currentIntercomSessionId ?? currentSessionId).name);
    return Boolean(resolvedTo && activeClient?.sessionId && resolvedTo === activeClient.sessionId)
      || targets.has(to.trim().toLowerCase());
  }
  function buildOutboxResult(request: OutboxRequestTrace, status: IntercomOutboxResultStatus, options: OutboxResultOptions = {}): IntercomOutboxResultV1 {
    return {
      version: 1,
      requestId: request.requestId,
      status,
      ...(request.extensionId ? { extensionId: request.extensionId } : {}),
      ...(request.extensionName ? { extensionName: request.extensionName } : {}),
      ...options,
    };
  }
  function emitOutboxResult(result: IntercomOutboxResultV1, request: OutboxRequestTrace): void {
    pi.appendEntry("intercom_outbox_result", {
      ...result,
      ...(request.to ? { to: request.to } : {}),
      ...(request.message ? { message: { text: request.message } } : {}),
      timestamp: Date.now(),
    });
    pi.events.emit(INTERCOM_OUTBOX_RESULT_EVENT, result);
  }
  function settleOutboxRequest(requestId: string, status: IntercomOutboxResultStatus, options: OutboxResultOptions = {}): boolean {
    const pending = pendingOutboxRequests.get(requestId);
    if (!pending) {
      return false;
    }
    pendingOutboxRequests.delete(requestId);
    emitOutboxResult(buildOutboxResult(pending.request, status, options), pending.request);
    return true;
  }
  function failPendingOutboxRequests(generation: number, code: IntercomOutboxResultCode, detail: string): void {
    for (const [requestId, pending] of [...pendingOutboxRequests]) {
      if (pending.generation === generation) {
        settleOutboxRequest(requestId, "failed", pending.dispatchedTargetId
          ? { code: "delivery_unknown", detail: `${detail} during delivery; outcome is unknown. Do not automatically retry.`, messageId: requestId, targetId: pending.dispatchedTargetId, delivery: "unknown", outcomeKnown: false, retryable: false }
          : { code, detail });
      }
    }
  }
  function resolveOutboxTarget(sessions: SessionInfo[], currentId: string, to: string): { ok: true; target: OutboxTarget } | { ok: false; code: "target_not_found" | "target_ambiguous" | "self_target"; detail: string } {
    const matches = sessions;
    if (matches.length === 0) {
      return { ok: false, code: "target_not_found", detail: `Session "${to}" is not currently connected.` };
    }
    if (matches.length > 1) {
      return { ok: false, code: "target_ambiguous", detail: `Multiple sessions match "${to}".` };
    }
    const target = matches[0]!;
    if (target.id === currentId) {
      return { ok: false, code: "self_target", detail: "Cannot message the current session." };
    }
    return { ok: true, target: { id: target.id, label: target.name || target.id, peer: target } };
  }
  function handleOutboxRequest(payload: unknown): void {
    const parsed = parseOutboxRequestPayload(payload);
    if (parsed.ok === false) {
      if (parsed.requestId) {
        const trace: OutboxRequestTrace = {
          requestId: parsed.requestId,
          ...(parsed.extensionId ? { extensionId: parsed.extensionId } : {}),
          ...(parsed.extensionName ? { extensionName: parsed.extensionName } : {}),
        };
        emitOutboxResult(buildOutboxResult(trace, "rejected", { code: "invalid_request", detail: parsed.detail }), trace);
      }
      return;
    }

    const request = parsed.request;
    const trace: OutboxRequestTrace = {
      requestId: request.requestId,
      extensionId: request.extensionId,
      extensionName: request.extensionName,
      to: request.to,
      message: request.message,
    };
    if (outboxRequestIds.has(request.requestId)) {
      emitOutboxResult(buildOutboxResult(trace, "rejected", { code: "duplicate_request", detail: "requestId has already been used in this session runtime" }), trace);
      return;
    }
    outboxRequestIds.add(request.requestId);

    const outboxGeneration = runtimeGeneration;
    pendingOutboxRequests.set(request.requestId, { generation: outboxGeneration, request: trace });

    void (async () => {
      const liveContext = getLiveContext(runtimeContext, outboxGeneration);
      if (!liveContext) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_unavailable", detail: "Intercom session is not active" });
        return;
      }
      if (config.confirmSend && !liveContext.hasUI) {
        settleOutboxRequest(request.requestId, "blocked", { code: "confirmation_unavailable", detail: "confirmSend is enabled but no UI is available" });
        return;
      }

      let activeClient: IntercomClient;
      try {
        activeClient = await ensureConnected("background");
      } catch (error) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_unavailable", detail: getErrorMessage(error) });
        return;
      }
      if (!getLiveContext(liveContext, outboxGeneration)) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_ended", detail: "Session ended before target resolution" });
        return;
      }

      let target: OutboxTarget;
      try {
        const currentClientSessionId = activeClient.sessionId;
        if (RESERVED_DESTINATIONS.has(request.to)) throw new Error("Extension outbox requires a direct peer destination");
        const sessions = await activeClient.listSessions({ resolve: request.to });
        if (!currentClientSessionId) {
          settleOutboxRequest(request.requestId, "failed", { code: "session_unavailable", detail: "Current session is not registered with intercom" });
          return;
        }
        const resolved = resolveOutboxTarget(sessions, currentClientSessionId, request.to);
        if (resolved.ok === false) {
          settleOutboxRequest(request.requestId, "blocked", { code: resolved.code, detail: resolved.detail });
          return;
        }
        target = resolved.target;
      } catch (error) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_unavailable", detail: getErrorMessage(error) });
        return;
      }
      if (!getLiveContext(liveContext, outboxGeneration)) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_ended", detail: "Session ended before confirmation" });
        return;
      }

      if (config.confirmSend) {
        let confirmed = false;
        try {
          confirmed = await liveContext.ui.confirm(
            "Send extension message",
            `Allow ${request.extensionName} (${request.extensionId}) to send to "${target.label}":\n\n${request.message}`,
          );
        } catch (error) {
          settleOutboxRequest(request.requestId, "blocked", { code: "confirmation_unavailable", detail: getErrorMessage(error) });
          return;
        }
        if (!getLiveContext(liveContext, outboxGeneration)) {
          settleOutboxRequest(request.requestId, "failed", { code: "session_ended", detail: "Session ended during confirmation" });
          return;
        }
        if (!confirmed) {
          settleOutboxRequest(request.requestId, "rejected", { code: "user_cancelled", detail: "User cancelled the outbox request" });
          return;
        }
      }

      try {
        if (!getLiveContext(liveContext, outboxGeneration) || client !== activeClient || !activeClient.isConnected()) {
          settleOutboxRequest(request.requestId, "failed", { code: "session_ended", detail: "Session ended before delivery" });
          return;
        }
        const sending = activeClient.send(target.id, {
          target: target.peer,
          messageId: request.requestId,
          text: request.message,
          provenance: {
            type: "extension_outbox",
            extensionId: request.extensionId,
            extensionName: request.extensionName,
            requestId: request.requestId,
          },
        });
        const pending = pendingOutboxRequests.get(request.requestId);
        if (pending) pending.dispatchedTargetId = target.id;
        const result = await sending;
        if (pendingOutboxRequests.get(request.requestId)?.generation !== outboxGeneration) return;
        const metadata = { messageId: result.id, targetId: result.targetId ?? target.id, delivery: result.delivery, retryable: result.retryable, outcomeKnown: result.outcomeKnown };
        if (!result.delivered) {
          settleOutboxRequest(request.requestId, "failed", { ...metadata, code: result.delivery === "unknown" ? "delivery_unknown" : "delivery_failed", detail: result.reason ?? "Delivery failed" });
          return;
        }
        if (getLiveContext(liveContext, outboxGeneration)) pi.appendEntry("intercom_sent", {
          to: target.label,
          message: { text: request.message },
          messageId: result.id,
          timestamp: Date.now(),
          extension: { id: request.extensionId, name: request.extensionName, requestId: request.requestId },
        });
        settleOutboxRequest(request.requestId, "sent", metadata);
      } catch (error) {
        if (pendingOutboxRequests.get(request.requestId)?.generation !== outboxGeneration) return;
        const live = getLiveContext(liveContext, outboxGeneration);
        settleOutboxRequest(request.requestId, "failed", {
          code: live ? "session_unavailable" : "session_ended",
          detail: getErrorMessage(error),
        });
      }
    })();
  }
  function sendIncomingMessage(entry: InboundMessageEntry, generation = runtimeGeneration): boolean {
    if (runtimeStarted && !getLiveContext(runtimeContext, generation)) {
      emitMessageReceipt(entry.message.id, "expired", "session context no longer active before injection");
      return false;
    }
    const replyCommand = entry.replyCommand;
    const senderDisplay = entry.message.crossMachine
      ? `${relaySenderName(entry.message.crossMachine.origin)} · unverified cross-machine`
      : entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = replyCommand ? `\n\nTo reply, use the intercom tool: ${replyCommand}` : "";
    const deliveryMetadata = formatInboundDeliveryMetadata(entry.message);
    const activeContext = getLiveContext(runtimeContext, generation);
    try {
      pi.sendMessage(
        {
          customType: "intercom_message",
          content: `**From ${senderDisplay}** (session ID: ${entry.from.id}; ${entry.from.cwd})${replyInstruction}\n\n_${deliveryMetadata}_\n\n${entry.bodyText}`,
          display: true,
          details: entry,
        },
        entry.message.quiet
          ? { deliverAs: "nextTurn" }
          : { deliverAs: "steer", ...(wakeWithTriggerTurn && activeContext?.isIdle() ? { triggerTurn: true } : {}) },
      );
      // Older Pi custom-started runs skip the normal prompt lifecycle and next-turn queue.
      if (!entry.message.quiet && !wakeWithTriggerTurn && activeContext?.isIdle() && !isIdleWakePending(activeContext.sessionManager)) {
        reserveIdleWake(activeContext.sessionManager);
        pi.sendUserMessage("New intercom message above.", { deliverAs: "steer" });
      }
      // The public API returns void: this proves handoff, not consumption or async run success.
      emitMessageReceipt(entry.message.id, "accepted", entry.message.quiet
        ? "handed to native next-turn queue (volatile; not read)"
        : "handed to native active delivery (not read or processed)");
      return true;
    } catch (error) {
      emitMessageReceipt(entry.message.id, "failed", getErrorMessage(error));
      return false;
    }
  }
  function deliverIncomingBrokerMessage(entry: InboundMessageEntry, ctx: ExtensionContext, generation: number): void {
    if (!getLiveContext(ctx, generation)) {
      emitMessageReceipt(entry.message.id, "expired", "session context no longer active before delivery");
      return;
    }
    sendIncomingMessage(entry, generation);
  }
  function flushHeldInboundMessages(ctx: ExtensionContext, generation: number): void {
    if (!getLiveContext(ctx, generation)) return;
    while (heldInboundMessages.length > 0 && (ctx.isIdle() || agentRunning) && getLiveContext(ctx, generation)) {
      deliverIncomingBrokerMessage(heldInboundMessages.shift()!, ctx, generation);
    }
    if (heldInboundMessages.length === 0) clearHeldInboundTimer();
  }
  function clearHeldInboundTimer(): void {
    if (heldInboundTimer) clearInterval(heldInboundTimer);
    heldInboundTimer = null;
  }
  function holdIncomingBrokerMessage(entry: InboundMessageEntry, ctx: ExtensionContext, generation: number): void {
    heldInboundMessages.push(entry);
    emitMessageReceipt(entry.message.id, "queued", "held until delivery is safe");
    if (!heldInboundTimer) {
      heldInboundTimer = setInterval(() => flushHeldInboundMessages(ctx, generation), 100);
      heldInboundTimer.unref();
    }
  }
  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message): void {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      emitMessageReceipt(message.id, "expired", "session context no longer active on receipt");
      return;
    }
    const receiverReceivedAt = Date.now();
    if (hasSeenInboundMessage(from, message, receiverReceivedAt)) {
      emitMessageReceipt(message.id, "receiver_received", "duplicate suppressed; original acceptance is not reasserted");
      return;
    }
    const receivedMessage = { ...message, receiverReceivedAt };
    emitMessageReceipt(receivedMessage.id, "receiver_received");
    if (replyWaiter.receive(from.id, receivedMessage)) {
      emitMessageReceipt(receivedMessage.id, "acknowledged", "matched reply waiter");
      return;
    }
    const attachmentText = receivedMessage.content.attachments?.length
      ? formatAttachments(receivedMessage.content.attachments)
      : "";
    const bodyText = `${receivedMessage.content.text}${attachmentText}`;
    const replyCommand = !receivedMessage.quiet && config.replyHint
      ? receivedMessage.crossMachine
        ? `intercom({ action: "send", to: ${JSON.stringify(relaySenderName(receivedMessage.crossMachine.origin))}, message: "..." })`
        : `intercom({ action: "send", to: ${JSON.stringify(from.id)}, replyTo: ${JSON.stringify(receivedMessage.id)}, message: "..." })`
      : undefined;
    const entry = { from, message: receivedMessage, replyCommand, bodyText };
    // Busy without an agent run cannot steer; manual compaction can discard an appended custom entry.
    if (heldInboundMessages.length > 0 || (!liveContext.isIdle() && !agentRunning)) {
      holdIncomingBrokerMessage(entry, liveContext, messageGeneration);
    } else {
      deliverIncomingBrokerMessage(entry, liveContext, messageGeneration);
    }
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.onBrokerMessage((message: BrokerMessage) => {
      if (client !== nextClient) return;
      switch (message.type) {
        case "registered": {
          const supported = message.features?.includes(EXTENSION_BUS_FEATURE) ?? false;
          if (supported && localExtensions.size > 0) {
            nextClient.updateExtensionCapabilities(currentExtensionCapabilities());
          }
          for (const namespace of localExtensions.keys()) {
            emitLocalExtensionEvent(namespace, { type: "connection", connected: true, supported });
          }
          break;
        }
        case "extension_owner": {
          const extension = localExtensions.get(message.namespace);
          if (!extension) break;
          extension.owner = message.ownerId && message.ownerEpoch
            ? { sessionId: message.ownerId, epoch: message.ownerEpoch }
            : undefined;
          emitLocalExtensionEvent(message.namespace, { type: "owner", ...(extension.owner ? { owner: extension.owner } : {}) });
          break;
        }
        case "extension_message": {
          const extension = localExtensions.get(message.namespace);
          if (!extension) break;
          emitLocalExtensionEvent(message.namespace, {
            type: "message",
            fromSessionId: message.fromSessionId,
            ...(message.ownerId && message.ownerEpoch
              ? { owner: { sessionId: message.ownerId, epoch: message.ownerEpoch } }
              : {}),
            payload: message.payload,
          });
          break;
        }
        case "extension_state": {
          const extension = localExtensions.get(message.namespace);
          if (!extension) break;
          extension.state = { revision: message.revision, payload: message.payload };
          emitLocalExtensionEvent(message.namespace, { type: "state", state: extension.state });
          break;
        }
        case "extension_state_result":
          emitLocalExtensionEvent(message.namespace, {
            type: "state_result",
            committed: message.committed,
            revision: message.revision,
            ...(message.reason ? { reason: message.reason } : {}),
          });
          break;
        case "message_receipt":
          latestOutboundReceipts.set(message.receipt.messageId, {
            status: message.receipt.status,
            timestamp: message.receipt.timestamp,
            ...(message.receipt.detail ? { detail: message.receipt.detail } : {}),
          });
          break;
        case "message_control":
          handleMessageControl(message.control);
          break;
        case "session_joined":
          for (const namespace of localExtensions.keys()) {
            emitLocalExtensionEvent(namespace, { type: "session_joined", session: message.session });
          }
          break;
        case "session_left":
          for (const namespace of localExtensions.keys()) {
            emitLocalExtensionEvent(namespace, { type: "session_left", sessionId: message.sessionId });
          }
          break;
        case "presence_update":
          for (const namespace of localExtensions.keys()) {
            emitLocalExtensionEvent(namespace, { type: "presence_update", session: message.session });
          }
          break;
      }
    });
    nextClient.on("message", (from, message) => {
      const liveContext = getLiveContext();
      if (client !== nextClient) {
        return;
      }
      if (!liveContext) {
        emitMessageReceipt(message.id, "expired", "session context no longer active on receipt");
        return;
      }
      handleIncomingMessage(liveContext, from, message);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      markLocalExtensionsDisconnected();
      client = null;
      if (!shuttingDown && !disposed) {
        clearReconnectTimer();
        scheduleReconnect();
      }
    });
    nextClient.on("error", () => {
      // Keep broker/socket noise out of the TUI. Reconnect logic runs from the disconnect path.
    });
  }
  function markLocalExtensionsDisconnected(): void {
    for (const [namespace, extension] of localExtensions) {
      extension.owner = undefined;
      emitLocalExtensionEvent(namespace, { type: "connection", connected: false, supported: false });
      emitLocalExtensionEvent(namespace, { type: "owner" });
    }
  }
  function scheduleReconnect(): void {
    if (disposed || shuttingDown || sessionHeldBlocked || reconnectTimer || reconnectPromise || !getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (scheduledGeneration !== runtimeGeneration || !getLiveContext()) {
        return;
      }
      reconnectAttempt += 1;
      void ensureConnected("background").catch(() => {
        // ensureConnected("background") already queued the next retry.
      });
    }, getReconnectDelayMs());
  }
  function reportSessionHeld(ctx: ExtensionContext, generation: number, error: IntercomSessionHeldError): void {
    if (sessionHeldBlocked || !getLiveContext(ctx, generation)) return;
    sessionHeldBlocked = true;
    const message = `Intercom is offline: session id ${currentIntercomSessionId} is held by process ${error.holder.pid} in ${error.holder.cwd}. Close that session and run /reload, or give this session its own PI_INTERCOM_STABLE_ID.`;
    notifyIfLive(ctx, message, "warning", generation);
    pi.appendEntry("intercom_session_held", {
      sessionId: currentIntercomSessionId,
      holder: error.holder,
      error: error.message,
      timestamp: Date.now(),
    });
  }
  async function ensureConnected(reason: "startup" | "background" | "tool" | "overlay"): Promise<IntercomClient> {
    if (!config.enabled) {
      throw new Error("Intercom disabled");
    }
    if (shuttingDown) {
      throw new Error("Intercom shutting down");
    }
    if (disposed) throw new Error("Intercom runtime not initialized");
    if (client && client.isConnected()) {
      return client;
    }
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise && reconnectPromiseGeneration === generationAtStart) {
      return reconnectPromise;
    }
    let nextReconnectPromise!: Promise<IntercomClient>;
    nextReconnectPromise = (async () => {
      const nextClient = new IntercomClient();
      client = nextClient;
      attachClientHandlers(nextClient);
      let retryAfterFailure = false;
      try {
        await initializeIntercomPool(contextAtStart.cwd);
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          throw new Error("Intercom runtime no longer active");
        }
        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        await nextClient.connect(buildRegistration(), currentIntercomSessionId ?? currentSessionId);
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        reconnectAttempt = 0;
        sessionHeldBlocked = false;
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
        }
        if (error instanceof IntercomSessionHeldError) {
          reportSessionHeld(contextAtStart, generationAtStart, error);
        }
        retryAfterFailure = reason === "background";
        throw toError(error);
      } finally {
        if (reconnectPromise === nextReconnectPromise) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
        // scheduleReconnect() skips while reconnectPromise is set, so queue the retry only after clearing it.
        if (retryAfterFailure && getLiveContext(contextAtStart, generationAtStart)) {
          scheduleReconnect();
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    return nextReconnectPromise;
  }
  /** Pin a live endpoint before registering the single waiter, then dispatch without re-resolution. */
  async function sendAndWait(activeClient: IntercomClient, targetId: string, payload: Omit<Parameters<IntercomClient["send"]>[1], "messageId" | "expectsReply">, wait: {
    signal: AbortSignal | undefined;
    onAttempt: (messageId: string) => void;
    deliveryState: () => string;
  }): Promise<{ result: SendResult; display: string; reply: Promise<Message> }> {
    const peer = payload.target ?? await activeClient.resolveTarget(targetId, { requireLive: true });
    if (peer && !peer.endpointEpoch) throw new Error("Waiting sends require a live peer");
    if (!peer) throw new Error(`No connected peer matches "${targetId}". Waiting sends require a live peer.`);
    if (peer.id === activeClient.sessionId) throw new Error("Cannot message the current session");
    if (replyWaiter.active) throw new Error("Already waiting for a reply");
    if (wait.signal?.aborted) throw new Error("Cancelled before dispatch");
    const messageId = randomUUID();
    wait.onAttempt(messageId);
    const reply = replyWaiter.wait(peer.id, messageId, { signal: wait.signal, onFinish: () => activeClient.cancelAsk(messageId), deliveryState: wait.deliveryState });
    reply.catch(() => undefined);
    try {
      const result = await activeClient.send(peer.id, { ...payload, target: peer, messageId, expectsReply: true, signal: wait.signal });
      if (!result.delivered && result.delivery !== "unknown") replyWaiter.reject(new Error(undeliveredText(peer.id, result)), messageId);
      return { result, display: peer.id, reply };
    } catch (error) {
      replyWaiter.reject(toError(error), messageId);
      // A response accepted before a transport interruption still satisfies this wait.
      await reply;
      return { result: { id: messageId, targetId: peer.id, delivered: false, delivery: "unknown", retryable: false, outcomeKnown: false, reason: getErrorMessage(error) }, display: peer.id, reply };
    }
  }
  function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        row.push(Math.min(row[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost));
      }
      previous = row;
    }
    return previous[b.length]!;
  }
  function nearestSessionName(sessions: SessionInfo[], to: string): SessionInfo | null {
    const needle = to.toLowerCase();
    let best: SessionInfo | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
      if (!session.name || RESERVED_DESTINATIONS.has(session.name.toLowerCase())) {
        continue;
      }
      const candidate = session.name.toLowerCase();
      const limit = Math.max(2, Math.floor(Math.max(candidate.length, needle.length) / 4));
      const distance = editDistance(candidate, needle);
      if (distance <= limit && distance < bestDistance) {
        best = session;
        bestDistance = distance;
      }
    }
    return best;
  }
  function describeNoSessionMatch(sessions: SessionInfo[], to: string): string {
    const nearest = nearestSessionName(sessions, to);
    if (nearest?.name) {
      const prefixes = sessionIdPrefixes(sessions);
      return `No connected session matches "${to}". Nearest name: "${nearest.name}" (${prefixes.get(nearest.id)!}). Run intercom list and address the session by its full name or the id shown in parentheses.`;
    }
    return `No connected session matches "${to}". Run intercom list for connected sessions.`;
  }
  async function resolveCwdDeliveryTarget(activeClient: IntercomClient, options: {
    to?: string;
    cwd: string;
    openProjectPaneIfMissing?: boolean;
    focus?: boolean;
    signal?: AbortSignal;
  }): Promise<DeliveryTarget> {
    const sessions = await activeClient.listSessions();
    const currentSessionId = activeClient.sessionId;
    if (!currentSessionId) {
      throw new Error("Current session is not registered with intercom.");
    }
    const currentSession = sessions.find((session) => session.id === currentSessionId);
    if (!currentSession) {
      throw new Error("Current session is missing from intercom session list.");
    }

    const targetCwd = options.cwd && options.cwd !== "."
      ? resolvePath(currentSession.cwd, options.cwd)
      : currentSession.cwd;
    const existing = await resolveTargetInCwd(activeClient, {
      sessions,
      currentSessionId,
      targetCwd,
      ...(options.to ? { to: options.to } : {}),
    });
    if (existing.kind === "found" && existing.session) {
      return { id: existing.session.id, label: options.to || existing.session.name || existing.session.id, peer: existing.session };
    }
    if (!options.openProjectPaneIfMissing) {
      throw new Error(`${existing.reason ?? `No intercom session is connected in ${targetCwd}.`} Pass openProjectPaneIfMissing: true to open a Herdr project pane and start Pi there.`);
    }

    const beforeSessionIds = new Set(sessions.map((session) => session.id));
    const projectPane = await openProjectPane({ cwd: targetCwd, focus: options.focus, signal: options.signal });
    const session = await waitForProjectSession(activeClient, {
      projectRoot: projectPane.projectRoot,
      currentSessionId,
      beforeSessionIds,
      ...(options.to ? { to: options.to } : {}),
      signal: options.signal,
    });
    return { id: session.id, label: session.name || session.id, peer: session, projectPane };
  }
  /** Shared by send, handover, and /handover. Never throws; failures are returned as error results. */
  async function deliverMessage(
    connectedClient: IntercomClient,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    request: DeliveryRequest,
  ): Promise<IntercomToolResult> {
    const { to, cwd, openProjectPaneIfMissing, focus, message, attachments, replyTo, supersedes, retryOf, quiet } = request;
    try {
      if (request.wait && quiet) throw new Error("wait: true cannot be combined with quiet: true");
      if (isBroadcastDestination(to)) {
        if (request.handover) throw new Error("Handover requires a direct recipient, not a broadcast");
        if (request.wait || replyTo !== undefined) throw new Error("Broadcasts do not support wait: true or replyTo");
        if (cwd !== undefined || openProjectPaneIfMissing !== undefined || focus !== undefined) throw new Error("Broadcast destinations cannot be combined with cwd or project-pane options");
        if (supersedes !== undefined || retryOf !== undefined) throw new Error("Broadcasts are new messages; supersedes and retryOf require a direct recipient");
        if (signal?.aborted) throw new Error("Cancelled before dispatch");
        const snapshot = await connectedClient.listSessions({ audience: to });
        if (signal?.aborted) throw new Error("Cancelled before dispatch");
        if (config.confirmSend && ctx.hasUI) {
          const audience = snapshot.map(peer => `${peer.name ?? "(unnamed)"} (${peer.id})`).join("\n") || "zero recipients";
          const confirmed = await ctx.ui.confirm("Send broadcast", `Send to ${to} (${snapshot.length} recipients):\n${audience}\n\n${message}${attachments?.length ? formatAttachments(attachments) : ""}`, { signal });
          if (!confirmed) return { content: [{ type: "text", text: "Broadcast cancelled by user; no messages dispatched" }], details: { destination: to, cancelled: true, delivered: false } };
        }
        const result = await sendBroadcast(connectedClient, to, snapshot, { text: message, attachments, quiet, signal });
        for (const recipient of result.recipients) {
          if ("delivered" in recipient && recipient.delivered) pi.appendEntry("intercom_sent", { to: recipient.targetId, message: { text: message, attachments }, messageId: recipient.id, timestamp: Date.now(), broadcast: to });
        }
        return { content: [{ type: "text", text: formatBroadcastResult(result) }], details: { ...result, delivered: result.ok, error: !result.ok } };
      }
      if (to === "parent" && (cwd !== undefined || openProjectPaneIfMissing !== undefined || focus !== undefined)) throw new Error("The parent destination cannot be combined with cwd or project-pane options");
      if (replyTo && !to) throw new Error("Threaded sends require an explicit 'to' recipient");
      const crossMachineTarget = Boolean(to?.includes("@"));
      if (crossMachineTarget && (request.wait || quiet)) throw new Error("Cross-machine sends do not support wait: true or quiet: true");
      if (request.wait && replyWaiter.active) throw new Error("Already waiting for a reply");
      const crossMachineRestriction = explicitCrossMachineSendRestriction({
        to, cwd, openProjectPaneIfMissing, attachments, replyTo, supersedes, retryOf,
      });
      if (crossMachineRestriction) {
        return {
          content: [{ type: "text", text: crossMachineRestriction }],
          details: { error: true, crossMachine: false },
        };
      }
      if (crossMachineTarget) {
        try {
          parseCrossMachineTarget(to!);
        } catch (error) {
          return {
            content: [{ type: "text", text: getErrorMessage(error) }],
            details: { error: true, crossMachine: false },
          };
        }
      }
      if (openProjectPaneIfMissing && !cwd) {
        return {
          content: [{ type: "text", text: "openProjectPaneIfMissing requires a target cwd." }],
          details: { error: true },
        };
      }
      const confirmSend = !replyTo && config.confirmSend && ctx.hasUI;
      const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
      if (confirmSend && cwd && openProjectPaneIfMissing) {
        const confirmed = await ctx.ui.confirm(
          "Send message",
          `Send to "${to ?? cwd}":\n\n${message}${attachmentText}`,
        );
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Message cancelled by user" }],
            details: {},
          };
        }
      }
      if (confirmSend && crossMachineTarget) {
        const confirmed = await ctx.ui.confirm("Send message", `Send to "${to}":\n\n${message}`);
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Message cancelled by user" }],
            details: {},
          };
        }
      }
      if (crossMachineTarget) {
        if (request.handover && signal?.aborted) {
          return { content: [{ type: "text", text: "Handover was cancelled before delivery." }], details: { error: true } };
        }
        const identity = buildPresenceIdentity(pi, connectedClient.sessionId ?? ctx.sessionManager.getSessionId());
        try {
          const remote = await sendCrossMachine(to!, message, {
            name: identity.name,
            sessionId: connectedClient.sessionId ?? ctx.sessionManager.getSessionId(),
            machine: config.crossMachine.machineName,
          }, {
            remoteCommand: config.crossMachine.remoteCommand,
          });
          const remoteTarget = relaySenderName({ name: remote.agent.name, machine: remote.machine.label });
          pi.appendEntry("intercom_sent", {
            to: remoteTarget,
            message: { text: message },
            timestamp: Date.now(),
            crossMachine: true,
          });
          return {
            content: [{ type: "text", text: `Message sent to ${remoteTarget} over SSH (origin identity is SSH-asserted)` }],
            details: { delivered: true, crossMachine: true, machine: remote.machine.label, target: remote.agent.name, trust: "ssh-asserted" },
          };
        } catch (remoteError) {
          return {
            content: [{ type: "text", text: `Explicit cross-machine message to "${to}" was not delivered: ${getErrorMessage(remoteError)}` }],
            details: { error: true, crossMachine: false },
          };
        }
      }
      const peer = cwd ? undefined : request.resolvedPeer ?? await connectedClient.resolveTarget(to!, { requireLive: request.wait });
      if (!cwd && !peer) throw new Error(describeNoSessionMatch(await connectedClient.listSessions(), to!));
      const target: DeliveryTarget = cwd
        ? await resolveCwdDeliveryTarget(connectedClient, { to, cwd, openProjectPaneIfMissing, focus, signal })
        : { id: peer?.id ?? to!, label: to!, ...(peer ? { peer } : {}) };
      const sendTo = target.id;
      const targetDisplay = target.projectPane ? target.label : to ?? target.label;
      if (sendTo === connectedClient.sessionId) {
        return {
          content: [{ type: "text", text: "Cannot message the current session" }],
          details: { error: true },
        };
      }
      if (confirmSend && !(cwd && openProjectPaneIfMissing)) {
        const confirmed = await ctx.ui.confirm(
          "Send message",
          `Send to "${targetDisplay}":\n\n${message}${attachmentText}`,
        );
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Message cancelled by user" }],
            details: {},
          };
        }
      }
      if (request.handover && signal?.aborted) {
        return { content: [{ type: "text", text: "Handover was cancelled before delivery." }], details: { error: true } };
      }
      if (signal?.aborted) throw new Error("Cancelled before dispatch");
      if (request.wait) {
        let messageId: string | null = null;
        let deliveryState = "created";
        const sent = await sendAndWait(connectedClient, sendTo, { text: message, attachments, replyTo, supersedes, retryOf, target: target.peer }, {
          signal,
          onAttempt: (id) => { messageId = id; },
          deliveryState: () => latestDeliveryState(messageId, deliveryState),
        });
        deliveryState = sent.result.delivery;
        if (sent.result.delivered) pi.appendEntry("intercom_sent", { to: sent.display, message: { text: message, attachments, replyTo }, messageId: sent.result.id, timestamp: Date.now() });
        try {
          const answer = await sent.reply;
          const text = answer.content.text + (answer.content.attachments?.length ? formatAttachments(answer.content.attachments) : "");
          pi.appendEntry("intercom_received", { from: sent.display, message: answer.content, messageId: answer.id, timestamp: answer.timestamp });
          return { content: [{ type: "text", text: `**Reply from ${sent.display}:**\n${text}` }], details: { messageId: sent.result.id, targetId: sent.display, replyMessageId: answer.id, outboundDelivery: deliveryDetails(sent.result) } };
        } catch (error) {
          return { content: [{ type: "text", text: getErrorMessage(error) }], details: { error: true, ...deliveryDetails(sent.result), targetId: sent.display, deliveryState: latestDeliveryState(messageId, deliveryState) } };
        }
      }
      const result = await connectedClient.send(sendTo, {
        text: message, attachments, replyTo, supersedes, retryOf, quiet, target: target.peer, signal,
      });
      const noMatchText = result.code === "E_TARGET_NOT_FOUND"
        ? describeNoSessionMatch(await connectedClient.listSessions(), sendTo)
        : undefined;
      if (!result.delivered) {
        return {
          content: [{ type: "text", text: noMatchText ?? undeliveredText(targetDisplay, result) }],
          details: { ...deliveryDetails(result), ...(noMatchText ? { error: true } : {}) },
        };
      }
      pi.appendEntry("intercom_sent", {
        to: targetDisplay,
        message: { text: message, attachments, replyTo, supersedes, retryOf },
        messageId: result.id,
        timestamp: Date.now(),
      });
      if (replyTo) dropHeldInboundMessage(replyTo, { status: "acknowledged", detail: "answered before injection" });
      return {
        content: [{
          type: "text",
          text: result.delivery === "queued"
            ? queuedText(result.targetId ?? targetDisplay, "message")
            : target.projectPane
              ? `Opened Herdr project pane ${target.projectPane.paneId} for ${target.projectPane.projectRoot} and sent message to ${targetDisplay}`
              : `Message sent to ${result.targetId ?? targetDisplay}`,
        }],
        details: {
          ...deliveryDetails(result),
          targetId: result.targetId,
          ...(replyTo ? { replyTo } : {}),
          ...(target.projectPane ? { openedProjectPane: true, paneId: target.projectPane.paneId, projectRoot: target.projectPane.projectRoot } : {}),
        },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to send: ${getErrorMessage(error)}` }],
        details: { error: true },
      };
    }
  }
  async function buildHandoverText(
    connectedClient: IntercomClient,
    ctx: ExtensionContext,
    options: { goal?: string; crossMachine: boolean },
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const [body, git] = await Promise.all([
      generateHandoverBody(ctx, options.goal, signal),
      readGitState(ctx.cwd),
    ]);
    if (signal?.aborted) {
      throw new Error("Handover generation was aborted.");
    }
    const sessionId = connectedClient.sessionId ?? ctx.sessionManager.getSessionId();
    return formatHandoverMessage({
      senderName: pi.getSessionName()?.trim() || sessionId.slice(0, 8),
      senderCwd: ctx.cwd,
      sessionFile: options.crossMachine ? undefined : ctx.sessionManager.getSessionFile(),
      git,
      body,
    });
  }
  function deliverLocalSubagentRelayMessage(sender: "subagent-control" | "subagent-result", status: string, messageText: string): boolean {
    const liveContext = getLiveContext();
    const now = Date.now();
    return sendIncomingMessage({
      from: {
        id: sender,
        name: sender,
        cwd: liveContext?.cwd ?? "",
        model: sender,
        pid: process.pid,
        startedAt: now,
        lastActivity: now,
        status,
      },
      message: {
        id: randomUUID(),
        timestamp: now,
        content: { text: messageText },
      },
      bodyText: messageText,
    }, runtimeGeneration);
  }
  function recordSubagentDeliveryError(entryType: string, to: string, message: string, error: unknown): void {
    pi.appendEntry(entryType, {
      to,
      message,
      error: getErrorMessage(error),
      timestamp: Date.now(),
    });
  }
  function startSessionRuntime(ctx: ExtensionContext): void {
    const previousClient = client;
    failPendingOutboxRequests(runtimeGeneration, "session_ended", "Session replaced");
    shuttingDown = false;
    disposed = true;
    runtimeStarted = true;
    runtimeGeneration += 1;
    outboxRequestIds.clear();
    reconnectAttempt = 0;
    sessionHeldBlocked = false;
    clearReconnectTimer();
    clearStartupConnectTimer();
    clearNamePollTimer();
    rejectReplyWaiter(new Error("Session replaced; waiting interrupted"));
    agentRunning = false;
    expireHeldInboundMessages("session replaced before injection");
    activeTools.clear();
    runtimeContext = null;
    currentSessionId = null;
    currentIntercomSessionId = null;
    currentParentSessionId = undefined;
    sessionStartedAt = null;
    if (previousClient) {
      client = null;
      void previousClient.disconnect().catch(() => undefined);
    }
    const sessionId = ctx.sessionManager.getSessionId();
    let claimedIntercomSessionId: string | undefined;
    let claimedParentSessionId: string | undefined;
    let identityError: string | undefined;
    let acceptingClaims = true;
    const identityRequest: IntercomSessionIdentityRequestV1 = {
      version: 1,
      sessionId,
      claim: (stableId, relationship) => {
        if (!acceptingClaims || typeof stableId !== "string" || !stableId.trim()) return;
        const parentId = relationship?.parentSessionId;
        if (parentId !== undefined && (typeof parentId !== "string" || !parentId.trim() || parentId !== parentId.trim() || parentId === sessionId)) {
          identityError = "Invalid current parent canonical session identity";
          return;
        }
        if (claimedIntercomSessionId !== undefined && (claimedIntercomSessionId !== stableId.trim() || claimedParentSessionId !== parentId)) {
          identityError = "Conflicting session-scoped intercom identity claims";
          return;
        }
        claimedIntercomSessionId = stableId.trim();
        claimedParentSessionId = parentId;
      },
    };
    pi.events.emit(INTERCOM_SESSION_IDENTITY_EVENT, identityRequest);
    acceptingClaims = false;
    if (identityError) throw new Error(identityError);
    const intercomSessionId = claimedIntercomSessionId ?? resolveConfiguredIntercomSessionId(sessionId, config);
    runtimeContext = ctx;
    currentSessionId = sessionId;
    currentIntercomSessionId = intercomSessionId;
    currentParentSessionId = claimedParentSessionId;
    publishIntercomSessionId(intercomSessionId);
    currentModel = ctx.model?.id ?? "unknown";
    sessionStartedAt = Date.now();
    const initialPresenceIdentity = buildPresenceIdentity(pi, currentIntercomSessionId);
    lastPresenceName = initialPresenceIdentity.name;
    lastPresenceRuntimeFallbackAlias = initialPresenceIdentity.runtimeFallbackAlias;
    disposed = false;
    startNamePoll();
    const startupGeneration = runtimeGeneration;
    startupConnectTimer = setTimeout(() => {
      startupConnectTimer = null;
      if (!getLiveContext(ctx, startupGeneration)) {
        return;
      }
      void ensureConnected("startup").catch(() => {
        if (!getLiveContext(ctx, startupGeneration)) {
          return;
        }
        scheduleReconnect();
      });
    }, 0);
  }
  function emitResultDelivery(requestId: string | undefined, delivered: boolean, error?: unknown): void {
    if (!requestId) return;
    pi.events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
      requestId,
      delivered,
      ...(error ? { error: getErrorMessage(error) } : {}),
    });
  }
  function relaySubagentIntercomPayload(payload: unknown, options: {
    sender: "subagent-control" | "subagent-result";
    status: string;
    errorEntryType: string;
    acknowledge?: boolean;
  }): void {
    const parsed = parseSubagentIntercomPayload(payload);
    if (!parsed) return;

    const relayGeneration = runtimeGeneration;
    void (async () => {
      const relayStillLive = () => !runtimeStarted || Boolean(getLiveContext(runtimeContext, relayGeneration));
      if (!relayStillLive()) {
        return;
      }
      if (currentSessionTargetMatches(parsed.to)) {
        const delivered = deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, delivered, delivered ? undefined : "Native delivery handoff failed");
        return;
      }

      let activeClient: IntercomClient;
      let target: SessionInfo;
      try {
        activeClient = await ensureConnected("background");
        const peer = await activeClient.resolveTarget(parsed.to);
        if (!peer) throw new Error(`No intercom session matches "${parsed.to}".`);
        target = peer;
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
        return;
      }

      if (!relayStillLive()) {
        return;
      }
      if (currentSessionTargetMatches(parsed.to, target.id, activeClient)) {
        const delivered = deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, delivered, delivered ? undefined : "Native delivery handoff failed");
        return;
      }

      try {
        const result = await activeClient.send(target.id, { text: parsed.message, target });
        if (!relayStillLive()) return;
        if (!result.delivered) {
          const error = new Error(result.reason ?? "Session may not exist or has disconnected.");
          recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
          if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
          return;
        }
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
      }
    })();
  }
  const unsubscribeExtensionRegister = pi.events.on(INTERCOM_EXTENSION_REGISTER_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const registration = payload as Partial<IntercomExtensionRegistration>;
    if (
      typeof registration.namespace !== "string"
      || typeof registration.ownerEligible !== "boolean"
      || typeof registration.onEvent !== "function"
      || typeof registration.onReady !== "function"
    ) {
      return;
    }
    registerLocalExtension(registration as IntercomExtensionRegistration);
  });
  pi.events.emit(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, { version: 1 });
  const unsubscribeSubagentControlIntercom = pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-control",
      status: "needs_attention",
      errorEntryType: "intercom_control_error",
    });
  });
  const unsubscribeSubagentResultIntercom = pi.events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-result",
      status: "result",
      errorEntryType: "intercom_result_error",
      acknowledge: true,
    });
  });
  const unsubscribeOutboxRequest = pi.events.on(INTERCOM_OUTBOX_REQUEST_EVENT, handleOutboxRequest);
  pi.on("session_start", async (_event, ctx) => {
    if (!config.enabled) {
      return;
    }
    startSessionRuntime(ctx);
    // Resolve the pool before the first turn can launch children with inherited env.
    await ensureConnected("startup").catch((error) => {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "warning", runtimeGeneration);
    });
  });
  
  pi.on("session_shutdown", async () => {
    unsubscribeExtensionRegister();
    unsubscribeSubagentControlIntercom();
    unsubscribeSubagentResultIntercom();
    unsubscribeOutboxRequest();
    shuttingDown = true;
    disposed = true;
    failPendingOutboxRequests(runtimeGeneration, "session_ended", "Session shutting down");
    runtimeGeneration += 1;
    clearStartupConnectTimer();
    clearReconnectTimer();
    clearNamePollTimer();
    restoreIntercomSessionId();
    rejectReplyWaiter(new Error("Session shutting down; waiting interrupted"));
    agentRunning = false;
    expireHeldInboundMessages("session shut down before injection");
    activeTools.clear();
    if (client) {
      await client.disconnect();
      client = null;
    }
    runtimeContext = null;
    currentSessionId = null;
    currentIntercomSessionId = null;
    sessionStartedAt = null;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const generation = runtimeGeneration;
    if (!getLiveContext(ctx, generation)) return;
    // Quiet queue insertion is safe even when compaction notifications lag behind native state.
    // Native next-turn messages drain before agent_start. Active holds must not wake reentrantly.
    for (let index = 0; index < heldInboundMessages.length && getLiveContext(ctx, generation);) {
      const entry = heldInboundMessages[index]!;
      if (!entry.message.quiet) {
        index += 1;
        continue;
      }
      heldInboundMessages.splice(index, 1);
      deliverIncomingBrokerMessage(entry, ctx, generation);
    }
    if (heldInboundMessages.length === 0) clearHeldInboundTimer();
  });
  pi.on("agent_start", (_event, ctx) => {
    releaseIdleWake(ctx.sessionManager);
    if (!getLiveContext()) {
      return;
    }
    agentRunning = true;
    if (runtimeContext) flushHeldInboundMessages(runtimeContext, runtimeGeneration);
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("tool_execution_start", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.set(event.toolCallId, event.toolName);
    syncPresenceStatus();
  });
  pi.on("tool_execution_end", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.delete(event.toolCallId);
    syncPresenceStatus();
  });
  pi.on("agent_end", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = false;
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("turn_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!currentSessionId || sessionId !== currentSessionId) {
      if (!config.enabled) {
        return;
      }
      startSessionRuntime(ctx);
      return;
    }
    if (!getLiveContext(ctx)) {
      return;
    }
    syncPresenceIdentity(sessionId);
  });
  pi.on("model_select", (event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentModel = event.model.id;
    if (client) {
      client.updatePresence({
        ...buildPresenceIdentity(pi, currentIntercomSessionId ?? ctx.sessionManager.getSessionId()),
        model: event.model.id,
        status: currentStatus(),
      });
    }
  });

  // Key by the outer CustomMessage, which the host reuses across child rebuilds.
  const inlineMessageExpansion = new WeakMap<object, { globalExpanded: boolean; expanded: boolean }>();
  pi.registerMessageRenderer("intercom_message", (message, options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    let expansionState = inlineMessageExpansion.get(message);
    if (!expansionState) {
      expansionState = { globalExpanded: options.expanded, expanded: options.expanded };
      inlineMessageExpansion.set(message, expansionState);
    } else if (expansionState.globalExpanded !== options.expanded) {
      // Reset in the callback, even when two global changes occur before render.
      expansionState.globalExpanded = options.expanded;
      expansionState.expanded = options.expanded;
    }
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText, !options.expanded, expansionState);
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== INTERCOM_TOOL_NAME) {
      return;
    }
    if (!event.details || typeof event.details !== "object") {
      return;
    }

    const details = event.details as { error?: unknown; delivered?: unknown };
    if (details.error === true || details.delivered === false) {
      return { isError: true };
    }
  });

  pi.registerTool(defineTool({
    name: "intercom",
    label: "Intercom",
    description: `Coordinate with pi sessions on this broker using send, optionally with wait: true.
Names, prefixes, and list discovery stay in the current pool; full session IDs route across pools.
Use full sender IDs and explicit replyTo to answer any earlier message, even after a wait ends.
The reserved destinations parent, workspace, and global are not peer names; use a full ID for colliding names.
parent uses current launch metadata, not transcript ancestry. workspace means this pool (including named/default pools);
global means this broker only. Broadcasts exclude self, all children, and CLI clients.
Direct sends are active by default; broadcasts are quiet by default. Quiet uses volatile native next-turn delivery.
Active sends wake idle peers or steer busy work without aborting it. Acceptance is not read or processing proof.
Receipt timeout is unknown: do not automatically retry an uncertain send. Broadcast results can be partial.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "list-cwd" })                → List sessions in the current working directory
  intercom({ action: "list-cwd", cwd: "/path" })  → List sessions in a specific directory
  intercom({ action: "send", to: "name-or-id", message: "..." })  → Send message
  intercom({ action: "send", cwd: "/path", openProjectPaneIfMissing: true, message: "..." }) → Open a visible Herdr project pane when needed, then send
  intercom({ action: "send", to: "name-or-id", message: "...", wait: true }) → Send and wait for the first exact-peer correlated response
  intercom({ action: "send", to: "parent", message: "Need a decision", wait: true }) → Contact the immediate spawning session
  intercom({ action: "send", to: "workspace", message: "Status update" }) → Quiet broadcast to top-level peers in this pool
  intercom({ action: "send", to: "global", message: "Attention needed", quiet: false }) → Active broadcast across this broker
  intercom({ action: "handover", to: "name-or-id", message: "next task" }) → Summarize this session and hand it over; the receiver acts on it
  intercom({ action: "handover", cwd: "/path", openProjectPaneIfMissing: true }) → Hand over to the session in that project, opening a Herdr pane when needed
  intercom({ action: "cancel", messageId: "..." })                 → Request cancellation of a sent message
  intercom({ action: "send", to: "full-sender-id", replyTo: "message-id", message: "..." }) → Send a threaded answer
  intercom({ action: "status" })                  → Show connection status`,
    promptSnippet:
      "Coordinate with pi peers: discover sessions, send updates or threaded answers, optionally wait, or broadcast to workspace/global.",
    promptGuidelines: [
      "Reply through intercom send with the full sender ID in to and the earlier message ID in replyTo; never infer a recipient or thread.",
      "Use intercom send to parent for current-launch owner decisions; add wait: true only when blocked on a response. Routine child completion still uses its normal result path.",
      "Intercom wait requires a live direct peer, cannot combine with quiet: true, and stops only waiting on timeout/cancellation. A quiet exact-peer correlated response satisfies that wait once instead of entering nextTurn.",
      "Intercom workspace/global broadcasts default to quiet and report individual outcomes; they cannot use wait or replyTo. Do not automatically retry unknown delivery outcomes.",
    ],

    parameters: Type.Object({
      action: StringEnum(["list", "list-cwd", "send", "handover", "status", "cancel"] as const, {
        description: "Action: 'list', 'list-cwd', 'send', 'handover', 'status', or 'cancel'. Use send with wait: true to wait for a response; always specify a recipient for threaded sends.",
      }),
      to: Type.Optional(Type.String({
        description: "Target session: name, full session ID, or the short id shown in parentheses by 'list' (a leading ID prefix resolves; when no session has this exact name or ID, a leading name prefix shared by exactly one connected session also resolves, otherwise use the full name). Full IDs route across pools; names and prefixes are scoped to this pool. Use parent for the immediate spawning session (requires explicit launch metadata; supports wait). Use workspace for other connected top-level Pi agents in this pool, or global across this broker's pools; broadcasts exclude children and transport clients. Built-in destinations cannot combine with cwd/project-pane options. With cwd, omit to target the sole live session there.",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send. For 'handover', the optional next task for the receiver.",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: StringEnum(["file", "snippet", "context"] as const),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      wait: Type.Optional(Type.Boolean({ description: "Wait for the first response from this exact live peer correlated by replyTo. Defaults to false; timeout or cancellation stops only waiting." })),
      quiet: Type.Optional(Type.Boolean({ description: "Next-turn delivery without waking, steering, or conversational acknowledgement, except an exact correlated response to an active waiter goes once to that wait result instead. Defaults to false for direct sends and true for workspace/global broadcasts; explicit false makes a broadcast active. Volatile acceptance is not read proof. Cannot combine with wait: true; local send only." })),
      replyTo: Type.Optional(Type.String({
        description: "Earlier message ID for thread correlation. Requires an explicit recipient; no pending request is needed.",
      })),
      messageId: Type.Optional(Type.String({
        description: "Message ID for actions that operate on an existing message, such as 'cancel'.",
      })),
      supersedes: Type.Optional(Type.String({
        description: "Previous message ID this send explicitly supersedes. Only works for the same sender and receiver.",
      })),
      retryOf: Type.Optional(Type.String({
        description: "Previous message ID this send is a user-authored retry of. Retries always send a new message ID.",
      })),
      cwd: Type.Optional(Type.String({
        description: "Working directory filter for 'list-cwd'. For send/handover, scopes target lookup to that directory; omit 'to' to target the sole live peer there. Absolute, or relative to the current session's cwd; '.' means the current cwd.",
      })),
      openProjectPaneIfMissing: Type.Optional(Type.Boolean({
        description: "For send/handover with cwd, open a visible Herdr project pane and launch Pi there when no matching live session is connected.",
      })),
      focus: Type.Optional(Type.Boolean({
        description: "For openProjectPaneIfMissing, focus the new Herdr pane. Defaults to true.",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.wait && params.quiet) return { content: [{ type: "text", text: "wait: true cannot be combined with quiet: true" }], details: { error: true } };
      if (params.quiet !== undefined && params.action !== "send") return { content: [{ type: "text", text: "quiet is only supported for send" }], details: { error: true } };
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          details: { error: true },
        };
      }

      syncPresenceIdentity(ctx.sessionManager.getSessionId());

      const { action, to, message, attachments, replyTo, messageId, supersedes, retryOf, cwd, openProjectPaneIfMissing, focus, wait, quiet } = params;
      if (wait && action !== "send") return { content: [{ type: "text", text: "wait is only supported for send" }], details: { error: true } };

      switch (action) {
        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);
            const otherSessions = sessions.filter(s => s.id !== mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                details: { error: true },
              };
            }

            const prefixes = sessionIdPrefixes(sessions);
            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true, prefixes.get(currentSession.id)!)}`;
            const otherSection = otherSessions.length === 0
              ? "**Other sessions:**\nNo other sessions connected."
              : `**Other sessions:**\n${otherSessions.map((session) => formatSessionListRow(session, currentSession.cwd, false, prefixes.get(session.id)!)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              details: { roster: { peers: otherSessions.length, total: sessions.length } },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        case "list-cwd": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                details: { error: true },
              };
            }

            // Default to the current session's cwd; an explicit `cwd` overrides
            // (relative paths resolved against it, "." meaning the current cwd).
            const filterCwd = cwd && cwd !== "."
              ? resolvePath(currentSession.cwd, cwd)
              : currentSession.cwd;

            const otherSessions = sessions.filter(
              s => s.id !== mySessionId && sameCwd(s.cwd, filterCwd),
            );

            // Fail loud: filtering by a directory with no peers while the
            // session's OWN cwd has some otherwise reads as a misleading empty
            // result (common when a caller passes a guessed parent cwd).
            let emptyNote = "No other sessions in this directory.";
            if (otherSessions.length === 0 && !sameCwd(filterCwd, currentSession.cwd)) {
              const here = sessions.filter(
                s => s.id !== mySessionId && sameCwd(s.cwd, currentSession.cwd),
              ).length;
              if (here > 0) {
                emptyNote += ` Your session's cwd is ${currentSession.cwd} (${here} peer${here === 1 ? "" : "s"} there) — call list-cwd without a cwd argument to list them.`;
              }
            }

            const prefixes = sessionIdPrefixes(sessions);
            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true, prefixes.get(currentSession.id)!)}`;
            const otherSection = otherSessions.length === 0
              ? `**Other sessions (cwd: ${filterCwd}):**\n${emptyNote}`
              : `**Other sessions (cwd: ${filterCwd}):**\n${otherSessions.map((session) => formatSessionListRow(session, currentSession.cwd, false, prefixes.get(session.id)!)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              details: { roster: { peers: otherSessions.length, total: sessions.length, cwd: filterCwd } },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        case "cancel": {
          if (!messageId) {
            return {
              content: [{ type: "text", text: "Missing 'messageId' parameter" }],
              details: { error: true },
            };
          }
          try {
            const result = await connectedClient.cancelMessage(messageId);
            if (!result.delivered) {
              const errorText = result.reason ?? "Message may not exist or may belong to another sender.";
              return {
                content: [{ type: "text", text: `Cancellation for ${messageId} was not delivered: ${errorText}` }],
                details: { messageId, delivered: false, reason: result.reason },
              };
            }
            return {
              content: [{ type: "text", text: `Cancellation requested for ${messageId}` }],
              details: { messageId, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to cancel message: ${getErrorMessage(error)}` }],
              details: { error: true, messageId },
            };
          }
        }

        case "send": {
          if ((!to && !cwd) || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'cwd', or missing 'message' parameter" }],
              details: { error: true },
            };
          }
          return deliverMessage(connectedClient, ctx, _signal, {
            to, cwd, openProjectPaneIfMissing, focus, message, attachments, replyTo, supersedes, retryOf, wait, quiet,
          });
        }

        case "handover": {
          if (isBroadcastDestination(to)) return { content: [{ type: "text", text: "Handover requires a direct recipient, not a broadcast" }], details: { error: true } };
          if (!to && !cwd) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'cwd' parameter" }],
              details: { error: true },
            };
          }
          if (replyTo || supersedes || retryOf || attachments?.length) {
            return {
              content: [{ type: "text", text: "Handover always sends a new message; replyTo, supersedes, retryOf, and attachments are not supported." }],
              details: { error: true },
            };
          }
          let handoverText: string;
          try {
            handoverText = await buildHandoverText(connectedClient, ctx, { goal: message, crossMachine: Boolean(to?.includes("@")) }, _signal);
          } catch (error) {
            return {
              content: [{ type: "text", text: `Handover failed: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
          return deliverMessage(connectedClient, ctx, _signal, { to, cwd, openProjectPaneIfMissing, focus, message: handoverText, handover: true });
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const pool = getIntercomScopeId();
            const mySession = sessions.find((session) => session.id === mySessionId);
            const shortId = (mySessionId ?? "unknown").slice(0, 8);
            return {
              content: [{
                type: "text",
                text: `**Intercom status:**\nConnected: Yes\nSession ID: ${mySessionId}\nSession name: ${mySession?.name ?? "(unnamed)"} (short id: ${shortId})${pool ? `\nPool: ${pool}` : ""}\nActive sessions: ${sessions.length}`,
              }],
              details: {},
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}. Use send with an explicit recipient; add wait: true to wait or replyTo to thread an answer.` }],
            details: { error: true },
          };
      }
    },
    renderCall(args, theme, context) {
      const action = typeof args.action === "string" ? args.action : "intercom";
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messageText = context.expanded && typeof args.message === "string"
        ? args.message
        : previewText(args.message, 96);
      const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
      let text = theme.fg("toolTitle", theme.bold("intercom "));
      text += theme.fg(args.wait === true ? "warning" : "accent", action);
      if (target) {
        text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      }
      if (attachmentCount > 0) {
        text += " " + theme.fg("dim", `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`);
      }
      if (messageText) {
        text += "\n  " + theme.fg("dim", messageText);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Intercom working..."), 0, 0);
      }
      const details = result.details as { delivered?: boolean; error?: boolean; messageId?: string; reason?: string; roster?: { peers: number; total: number; cwd?: string } } | undefined;
      const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
      let text = failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      if (details?.roster && !failed && !context.expanded) {
        // Collapsed rows are display-only; the model still receives the full roster text.
        const { peers, total, cwd: rosterCwd } = details.roster;
        const where = rosterCwd ? ` in ${rosterCwd}` : "";
        text += theme.fg("text", peers === 0 ? `no other sessions${where}` : `${peers} other session${peers === 1 ? "" : "s"}${where}`);
        text += theme.fg("dim", ` (${total} connected)`);
        return new Text(text, 0, 0);
      }
      text += theme.fg(failed ? "error" : "text", firstTextContent(result));
      if (details?.messageId && !context.expanded) {
        text += theme.fg("dim", ` (${details.messageId.slice(0, 8)})`);
      }
      if (details?.reason && context.expanded) {
        text += "\n" + theme.fg("dim", `Reason: ${details.reason}`);
      }
      return new Text(text, 0, 0);
    },
  }));

  function insertIntoEditor(ctx: ExtensionContext, text: string): boolean {
    if (!ctx.hasUI) return false;
    const ui = ctx.ui as { getEditorText?: () => string; setEditorText?: (text: string) => void };
    if (typeof ui.setEditorText !== "function") return false;
    const existing = typeof ui.getEditorText === "function" ? ui.getEditorText() : "";
    ui.setEditorText(existing.trim() ? `${existing.trimEnd()}\n\n${text}` : text);
    return true;
  }

  async function insertIntercomId(ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;
    let contactClient: IntercomClient;
    try {
      contactClient = await ensureConnected("tool");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", commandGeneration);
      return;
    }
    const sessionId = contactClient.sessionId;
    if (!sessionId || !getLiveContext(liveContext, commandGeneration)) return;
    const snippet = formatIntercomContactSnippet(sessionId);
    if (insertIntoEditor(liveContext, snippet)) {
      notifyIfLive(liveContext, `Inserted intercom contact target: ${sessionId}`, "info", commandGeneration);
      return;
    }
    notifyIfLive(liveContext, `Intercom contact target: ${sessionId}`, "info", commandGeneration);
  }

  async function setIntercomAlias(args: string, ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;

    let alias = args.trim();
    const opensAliasInput = !alias || alias.toLowerCase() === "menu";
    if (opensAliasInput) {
      if (!liveContext.hasUI) {
        const currentAlias = pi.getSessionName()?.trim();
        notifyCommand(
          liveContext,
          alias ? "The alias menu requires an interactive UI; use /alias <name>." : currentAlias ? `Session alias: ${currentAlias}` : "No session alias set. Use /alias <name>.",
          alias ? "warning" : "info",
          commandGeneration,
        );
        return;
      }

      const currentAlias = pi.getSessionName()?.trim();
      let entered: string | undefined;
      try {
        entered = await liveContext.ui.input(
          "Set session alias",
          currentAlias ? `Current alias: ${currentAlias}` : "Enter an alias",
        );
      } catch (error) {
        notifyCommand(liveContext, `Unable to set session alias: ${getErrorMessage(error)}`, "error", commandGeneration);
        return;
      }
      if (entered === undefined) return;
      alias = entered.trim();
      if (!alias) {
        notifyCommand(liveContext, "Session alias cannot be empty.", "warning", commandGeneration);
        return;
      }
    }

    if (!getLiveContext(liveContext, commandGeneration)) return;
    try {
      pi.setSessionName(alias);
    } catch (error) {
      notifyCommand(liveContext, `Unable to set session alias: ${getErrorMessage(error)}`, "error", commandGeneration);
      return;
    }

    // Pi's session_info_changed event updates the built-in UI, but it is not
    // an ExtensionAPI event. Push the new identity directly so broker peers
    // see the alias without waiting for the idle name poll.
    syncPresenceIdentity(liveContext.sessionManager.getSessionId());
    notifyCommand(liveContext, `Session alias set: ${alias}`, "info", commandGeneration);
  }

  async function runIntercomPoolCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;
    const requested = args.trim();
    if (!requested) {
      notifyCommand(liveContext, `Intercom pool: ${getIntercomScopeId() ?? "default"}`, "info", commandGeneration);
      return;
    }
    const nextPool = requested === "default" ? undefined : requested;
    // A connect already in flight registered with the old pool; let it settle first.
    await reconnectPromise?.catch(() => undefined);
    if (!getLiveContext(liveContext, commandGeneration)) return;
    if (process.env.PI_INTERCOM_SCOPE_ID !== undefined && nextPool === getIntercomScopeId()) {
      notifyCommand(liveContext, `Already in intercom pool: ${requested}`, "info", commandGeneration);
      return;
    }
    if (replyWaiter.active) {
      // Moving a waiter to another socket would silently abandon its response.
      notifyCommand(liveContext, "Cannot switch intercom pool while waiting for a reply. Wait for the response or cancel waiting first.", "warning", commandGeneration);
      return;
    }

    setIntercomScopeId(nextPool);
    const previousClient = client;
    client = null;
    clearReconnectTimer();
    markLocalExtensionsDisconnected();
    await previousClient?.disconnect({ moveToScopeId: nextPool ?? null }).catch(() => undefined);
    if (!getLiveContext(liveContext, commandGeneration)) return;
    try {
      await ensureConnected("background");
    } catch (error) {
      if (getLiveContext(liveContext, commandGeneration)) {
        // A tool connect that started during the switch may own this failed attempt, and it does not retry.
        scheduleReconnect();
      }
      notifyCommand(liveContext, `Switched to intercom pool ${requested}, but intercom is unavailable: ${getErrorMessage(error)}. Retrying in the background.`, "warning", commandGeneration);
      return;
    }
    notifyCommand(liveContext, `Joined intercom pool: ${requested}`, "info", commandGeneration);
  }

  async function runHandoverCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;
    if (!liveContext.hasUI || (liveContext as ExtensionContext & { mode?: string }).mode !== "tui") {
      notifyCommand(liveContext, "/handover requires the interactive terminal UI; use the intercom tool's handover action instead.", "error", commandGeneration);
      return;
    }
    const input = args.trim();
    if (!input) {
      await openHandoverPicker(liveContext, commandGeneration);
      return;
    }
    const target = input.split(/\s+/, 1)[0]!;
    const goal = input.slice(target.length).trim() || undefined;
    const isPath = /^(\/|\.\.?\/|~(\/|$))/.test(target);
    const request = isPath ? { cwd: expandHomePath(target), openProjectPaneIfMissing: true } : { to: target };
    await performHandover(liveContext, commandGeneration, request, { goal, crossMachine: !isPath && target.includes("@") });
  }

  async function openHandoverPicker(ctx: ExtensionContext, generation: number, preselectSessionId?: string): Promise<void> {
    let pickerClient: IntercomClient;
    try {
      pickerClient = await ensureConnected("tool");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", generation);
      return;
    }
    if (!getLiveContext(ctx, generation)) return;
    syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let sessions: SessionInfo[];
    try {
      sessions = await pickerClient.listSessions();
    } catch (error) {
      notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", generation);
      return;
    }
    const currentSession = sessions.find((session) => session.id === pickerClient.sessionId);
    if (!currentSession) {
      notifyIfLive(ctx, "Current session is missing from intercom session list", "error", generation);
      return;
    }
    if (!getLiveContext(ctx, generation)) return;

    const discoveryDeps = { run: runCommand, herdrBin: process.env.HERDR_BIN_PATH ?? "herdr" };
    const lister: RemoteSessionLister = {
      listMachines: () => listSavedMachines(discoveryDeps),
      listAgents: (machine) => listMachineAgents(machine, discoveryDeps),
    };
    const picked = await ctx.ui.custom<HandoverPickerResult | undefined>(
      (tui, theme, keybindings, done) => new HandoverPicker(tui, theme, keybindings, { currentSession, sessions, lister, preselectSessionId }, done),
      { overlay: true, overlayOptions: { width: 88 } },
    ).catch(() => undefined);
    if (!picked || !getLiveContext(ctx, generation)) return;

    const { target, goal } = picked;
    if (target.kind === "local") {
      await performHandover(ctx, generation, { to: target.session.id, resolvedPeer: target.session }, { goal, crossMachine: false });
      return;
    }
    if (target.kind === "remote") {
      await performHandover(ctx, generation, { to: target.target }, { goal, crossMachine: true });
      return;
    }
    const path = (await ctx.ui.input("Project path for the new session", "~/dev/project"))?.trim();
    if (!getLiveContext(ctx, generation)) return;
    if (!path) {
      notifyIfLive(ctx, "Handover cancelled", "info", generation);
      return;
    }
    await performHandover(ctx, generation, { cwd: expandHomePath(path), openProjectPaneIfMissing: true }, { goal, crossMachine: false });
  }

  async function performHandover(
    ctx: ExtensionContext,
    generation: number,
    request: Pick<DeliveryRequest, "to" | "cwd" | "openProjectPaneIfMissing" | "resolvedPeer">,
    options: { goal?: string; crossMachine: boolean },
  ): Promise<void> {
    let handoverClient: IntercomClient;
    try {
      handoverClient = await ensureConnected("tool");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", generation);
      return;
    }
    if (!getLiveContext(ctx, generation)) return;

    const generated = await ctx.ui.custom<{ text: string } | { error: string } | null>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, "Generating handover...");
      loader.onAbort = () => done(null);
      buildHandoverText(handoverClient, ctx, options, loader.signal).then(
        (text) => done({ text }),
        (error) => done(loader.signal.aborted ? null : { error: getErrorMessage(error) }),
      );
      return loader;
    });
    if (!getLiveContext(ctx, generation)) return;
    if (!generated) {
      notifyIfLive(ctx, "Handover cancelled", "info", generation);
      return;
    }
    if ("error" in generated) {
      notifyIfLive(ctx, `Handover failed: ${generated.error}`, "error", generation);
      return;
    }

    const edited = await ctx.ui.editor("Edit handover", generated.text);
    if (!getLiveContext(ctx, generation)) return;
    if (edited === undefined || !edited.trim()) {
      notifyIfLive(ctx, "Handover cancelled", "info", generation);
      return;
    }

    try {
      handoverClient = await ensureConnected("tool");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", generation);
      return;
    }
    const result = await deliverMessage(handoverClient, ctx, undefined, { ...request, message: edited, handover: true });
    const failed = result.details.error === true || result.details.delivered === false;
    notifyIfLive(ctx, failed ? firstTextContent(result) : `Handover: ${firstTextContent(result)}`, failed ? "error" : "info", generation);
  }

  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {
    const overlayGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, overlayGeneration);
    if (!liveContext?.hasUI || (liveContext as ExtensionContext & { mode?: string }).mode !== "tui") return;

    let overlayClient: IntercomClient;
    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let currentSession: SessionInfo;
    let sessions: SessionInfo[];
    let duplicates: Set<string>;
    try {
      const mySessionId = overlayClient.sessionId;
      const allSessions = await overlayClient.listSessions();
      if (!getLiveContext(ctx, overlayGeneration)) return;
      const foundCurrentSession = allSessions.find(s => s.id === mySessionId);
      if (!foundCurrentSession) {
        notifyIfLive(ctx, "Current session is missing from intercom session list", "error", overlayGeneration);
        return;
      }
      currentSession = foundCurrentSession;
      duplicates = duplicateSessionNames(allSessions);
      sessions = allSessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }

    const selection = await ctx.ui.custom<SessionListSelection | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(theme, keybindings, currentSession, sessions, done, getIntercomScopeId()),
      { overlay: true, overlayOptions: { width: 88 } }
    ).catch(() => undefined);

    if (!selection || !getLiveContext(ctx, overlayGeneration)) return;
    if (selection.action === "handover") {
      await openHandoverPicker(ctx, overlayGeneration, selection.session.id);
      return;
    }
    const selectedSession = selection.session;

    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    const targetLabel = formatSessionLabel(selectedSession, duplicates);

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, overlayClient, done),
      { overlay: true, overlayOptions: { width: 72 } }
    ).catch(() => undefined);

    if (result?.sent && result.messageId && result.text && getLiveContext(ctx, overlayGeneration)) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      notifyIfLive(ctx, result.queued ? queuedText(targetLabel) : `Message sent to ${targetLabel}`, "info", overlayGeneration);
    }
  }

  pi.registerCommand("intercom", {
    description: "Open session intercom overlay",
    handler: async (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerCommand("intercom-id", {
    description: "Insert a stable pi-intercom handoff snippet for this session into the editor",
    handler: async (_args, ctx) => insertIntercomId(ctx),
  });

  pi.registerCommand("intercom-pool", {
    description: "Show or switch this session's intercom pool (usage: /intercom-pool, /intercom-pool <name>, or /intercom-pool default)",
    handler: async (args, ctx) => runIntercomPoolCommand(args, ctx),
  });

  pi.registerCommand("alias", {
    description: "Set the current session alias (usage: /alias <name> or /alias menu)",
    handler: async (args, ctx) => setIntercomAlias(args, ctx),
  });

  pi.registerCommand("handover", {
    description: "Summarize this session and hand it over to another session (usage: /handover to pick a session, or /handover <target or project path> [next task])",
    handler: async (args, ctx) => runHandoverCommand(args, ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "Open session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });
}
