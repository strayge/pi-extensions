import net from "net";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash, randomUUID } from "crypto";
import { writeMessage, createMessageReader, MAX_FRAME_BYTES } from "./framing.ts";
import { isMessage, isMessageReceipt, isSessionId, isSessionRegistration, messageDeliveryFingerprint } from "./protocol.ts";
import {
  ensureIntercomRuntimeDir,
  getBrokerListenTarget,
  getBrokerPortFilePath,
  getIntercomDirPath,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.ts";
import { BROADCAST_AUDIENCE_FEATURE, EXACT_SEND_FEATURE, EXTENSION_BUS_FEATURE, PARENT_IDENTITY_FEATURE, RESERVED_DESTINATIONS, SESSION_HELD_ERROR_CODE, UNIFIED_MESSAGING_FEATURE } from "../types.ts";
import type { DeliveryState, SessionInfo, Message, BrokerMessage, ExtensionCapability, MessageControl, MessageReceiptStatus } from "../types.ts";
import { ExtensionStateManager } from "./extension-state.ts";
import { assertNoLiveBroker } from "./runtime-claim.ts";
import { resolveHerdrLocations } from "../herdr-location.ts";

const INTERCOM_DIR = getIntercomDirPath();
const LISTEN_TARGET = getBrokerListenTarget();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");
const PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
const BROKER_STATE_ID = randomUUID();
const MAX_SESSIONS = 128;
const MAX_UNREGISTERED_CONNECTIONS = 32;
const REGISTRATION_TIMEOUT_MS = 1000;
const RATE_LIMIT_CAPACITY = 240;
const RATE_LIMIT_REFILL_PER_SECOND = 120;
const PRESENCE_HEARTBEAT_MS = 1000;
const MAX_EXTENSIONS_PER_SESSION = 32;
const MAX_EXTENSION_MESSAGE_BYTES = 16 * 1024;
const MAX_EXTENSION_STATE_BYTES = 64 * 1024;
const MESSAGE_RECEIPT_ROUTE_RETENTION_MS = 60 * 60 * 1000;
const DISCONNECTED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAILBOX_MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_MAILBOX_MESSAGES = 256;
const DELIVERY_RECORD_RETENTION_MS = 60 * 60 * 1000;
const MAX_DELIVERY_RECORDS = 4096;
// Must stay below the client's 10s send timeout, so an unconfirmed send resolves as unknown instead of throwing.
const RECEIPT_TIMEOUT_MS = readPositiveIntEnv(process.env.PI_INTERCOM_RECEIPT_TIMEOUT_MS, 5000, 10_000);
const RECEIPT_PROOF_STATUSES = new Set<MessageReceiptStatus>(["accepted", "acknowledged", "queued", "injected"]);
const RECEIPT_FAILURE_STATUSES = new Set<MessageReceiptStatus>(["failed", "rejected", "unsupported", "expired", "cancelled", "superseded"]);
const LIVENESS_MISSED_INTERVALS = 3;
const LIVENESS_SWEEP_MS = readPositiveIntEnv(process.env.PI_INTERCOM_LIVENESS_SWEEP_MS, 10_000);
const TCP_KEEPALIVE_DELAY_MS = 30_000;

function readPositiveIntEnv(raw: string | undefined, fallback: number, limit = Infinity): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value < limit ? value : fallback;
}

function serializedPayloadSize(payload: unknown): number | null {
  try {
    const json = JSON.stringify(payload);
    return json === undefined ? null : Buffer.byteLength(json, "utf8");
  } catch {
    return null;
  }
}

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
  key: string;
  scopeId?: string;
  lastPresenceBroadcastAt: number;
  ownerOrder: number;
  extensions?: ExtensionCapability[];
  /** Stable Pi session identity used only for live Herdr snapshot joins. This
   * is a self-asserted local-client hint, not authenticated location evidence. */
  herdrSessionPath?: string;
  unifiedMessaging: boolean;
  /** Heartbeat interval the client promised; absent for clients that never heartbeat. */
  livenessIntervalMs?: number;
  lastInboundAt: number;
}

/** A socket delivery whose success reply waits for the receiver's receipt. */
interface PendingReceipt {
  senderSocket: net.Socket;
  fromKey: string;
  messageId: string;
  targetSocket: net.Socket;
  timer: NodeJS.Timeout;
}

interface DeliveryRecord {
  fingerprint: string;
  state: DeliveryState;
  reason?: string;
  code?: string;
  retryable: boolean;
  createdAt: number;
}

interface NamespaceOwner {
  namespace: string;
  sessionKey: string;
  sessionId: string;
  socket: net.Socket;
  epoch: string;
  scopeId?: string;
}

interface ConnectionState {
  socket: net.Socket;
  tokens: number;
  lastRefillAt: number;
}

interface WaitEdge {
  from: string;
  to: string;
}

interface MessageReceiptRoute {
  from: string;
  to: string;
  createdAt: number;
}

interface DisconnectedSession {
  info: SessionInfo;
  unifiedMessaging: boolean;
  key: string;
  scopeId?: string;
  disconnectedAt: number;
}

interface MailboxMessage {
  from: SessionInfo;
  fromKey: string;
  targetKey: string;
  message: Message;
  queuedAt: number;
}

function normalizeScopeId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid register scopeId");
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

// Clients share this host, so a signal-0 probe tells whether a claimed pid still runs.
// EPERM means it exists under another user.
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function sameScope(a: string | undefined, b: string | undefined): boolean {
  return a === b;
}

function scopedSessionKey(scopeId: string | undefined, sessionId: string): string {
  return JSON.stringify([scopeId ?? null, sessionId]);
}

function scopedExtensionKey(scopeId: string | undefined, namespace: string): string {
  return JSON.stringify([scopeId ?? null, namespace]);
}

function scopedExtensionStateNamespace(scopeId: string | undefined, namespace: string): string {
  if (!scopeId) {
    return namespace;
  }
  return JSON.stringify(["scope", createHash("sha256").update(scopeId).digest("hex"), namespace]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private waits = new Map<string, WaitEdge>();
  private messageReceiptRoutes = new Map<string, MessageReceiptRoute>();
  private disconnectedSessions = new Map<string, DisconnectedSession>();
  private mailboxMessages: MailboxMessage[] = [];
  private deliveryRecords = new Map<string, DeliveryRecord>();
  private pendingReceipts = new Map<string, PendingReceipt>();
  private connections = new Set<net.Socket>();
  private unregisteredConnections = new Set<net.Socket>();
  private server: net.Server;
  private lastLivenessSweepAt = Date.now();
  private shutdownTimer: NodeJS.Timeout | null = null;
  private namespaceOwners = new Map<string, NamespaceOwner>();
  private nextOwnerOrder = 1;
  private extensionStateManager: ExtensionStateManager;

  constructor() {
    ensureIntercomRuntimeDir(INTERCOM_DIR);
    assertNoLiveBroker(PID_PATH);
    this.extensionStateManager = new ExtensionStateManager(INTERCOM_DIR);
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      try {
        unlinkSync(LISTEN_TARGET);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    const onListening = () => {
      if (typeof LISTEN_TARGET === "string") {
        restrictIntercomRuntimeFile(LISTEN_TARGET);
      } else {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          throw new Error("Intercom TCP broker started without a TCP address");
        }
        const endpoint: BrokerConnectTarget = {
          transport: "tcp",
          host: LISTEN_TARGET.host,
          port: address.port,
          stateId: BROKER_STATE_ID,
        };
        writeFileSync(PORT_PATH, `${JSON.stringify(endpoint)}\n`, { mode: INTERCOM_RUNTIME_FILE_MODE });
        restrictIntercomRuntimeFile(PORT_PATH);
      }
      writeFileSync(PID_PATH, String(process.pid), { mode: INTERCOM_RUNTIME_FILE_MODE });
      restrictIntercomRuntimeFile(PID_PATH);
      console.log(`Intercom broker started (pid: ${process.pid})`);
    };

    if (typeof LISTEN_TARGET === "string") {
      this.server.listen(LISTEN_TARGET, onListening);
    } else {
      this.server.listen({ host: LISTEN_TARGET.host, port: LISTEN_TARGET.port }, onListening);
    }
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
    setInterval(() => this.evictSilentSessions(), LIVENESS_SWEEP_MS).unref();
  }

  // A process that died without closing its socket can leave it open, and writes to it
  // still succeed. Dropping a session whose client stopped heartbeating hands its mail
  // to the mailbox through the normal close path.
  private evictSilentSessions(): void {
    const now = Date.now();
    const sinceLastSweepMs = now - this.lastLivenessSweepAt;
    this.lastLivenessSweepAt = now;
    // A sweep this late means the broker itself was paused (system sleep suspends the
    // broker and its clients together); a missed tick plus 1s covers ordinary timer lag.
    if (sinceLastSweepMs > 2 * LIVENESS_SWEEP_MS + 1000) {
      for (const session of this.sessions.values()) session.lastInboundAt = now;
      return;
    }
    for (const session of this.sessions.values()) {
      if (session.livenessIntervalMs === undefined) continue;
      const silentMs = now - session.lastInboundAt;
      if (silentMs <= session.livenessIntervalMs * LIVENESS_MISSED_INTERVALS) continue;
      console.log(`Dropping session ${session.info.id}: no heartbeat for ${silentMs}ms`);
      session.socket.destroy();
    }
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    // Lets the OS notice a dead peer on the TCP transport; pipes and Unix sockets ignore it.
    socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY_MS);
    let sessionKey: string | null = null;
    let registrationTimeout: NodeJS.Timeout | null = null;
    const armRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
      }
      this.unregisteredConnections.delete(socket);
      this.unregisteredConnections.add(socket);
      this.evictOldestUnregisteredConnections(socket);
      registrationTimeout = setTimeout(() => {
        if (!sessionKey) {
          socket.destroy();
        }
      }, REGISTRATION_TIMEOUT_MS);
      registrationTimeout.unref?.();
    };
    const clearRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
        registrationTimeout = null;
      }
      this.unregisteredConnections.delete(socket);
    };
    armRegistrationTimeout();
    const connection: ConnectionState = {
      socket,
      tokens: RATE_LIMIT_CAPACITY,
      lastRefillAt: Date.now(),
    };

    const reader = createMessageReader((msg) => {
      if (!this.consumeToken(connection)) {
        writeMessage(socket, { type: "error", error: "Intercom broker rate limit exceeded" });
        socket.destroy(new Error("Intercom broker rate limit exceeded"));
        return;
      }
      const session = sessionKey ? this.sessions.get(sessionKey) : undefined;
      if (session?.socket === socket) session.lastInboundAt = Date.now();
      this.handleMessage(socket, msg, sessionKey, (id) => {
        sessionKey = id;
        if (id) {
          clearRegistrationTimeout();
        } else {
          armRegistrationTimeout();
        }
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      clearRegistrationTimeout();
      this.connections.delete(socket);
      this.settlePendingReceiptsForSocket(socket);
      if (sessionKey) {
        const existing = this.sessions.get(sessionKey);
        if (existing?.socket === socket) {
          this.rememberDisconnectedSession(existing);
          this.sessions.delete(sessionKey);
          this.clearMessageReceiptRoutesForSession(sessionKey);
          this.broadcast({ type: "session_left", sessionId: existing.info.id }, sessionKey, existing.scopeId);
          this.recomputeNamespaceOwners();
          this.scheduleShutdownCheck();
        }
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private evictOldestUnregisteredConnections(currentSocket: net.Socket): void {
    while (this.unregisteredConnections.size > MAX_UNREGISTERED_CONNECTIONS) {
      const [oldest] = this.unregisteredConnections;
      if (!oldest) {
        return;
      }
      if (oldest === currentSocket && this.unregisteredConnections.size === 1) {
        return;
      }
      this.unregisteredConnections.delete(oldest);
      oldest.destroy();
    }
  }

  private consumeToken(connection: ConnectionState, now = Date.now()): boolean {
    const elapsedMs = now - connection.lastRefillAt;
    if (elapsedMs > 0) {
      connection.tokens = Math.min(
        RATE_LIMIT_CAPACITY,
        connection.tokens + elapsedMs * RATE_LIMIT_REFILL_PER_SECOND / 1000,
      );
      connection.lastRefillAt = now;
    }
    if (connection.tokens < 1) {
      return false;
    }
    connection.tokens -= 1;
    return true;
  }

  private scheduleShutdownCheck(delayMs = 5000): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size > 0) return;
      const now = Date.now();
      this.pruneMailboxMessages(now);
      // Queued mail keeps the broker up until it is delivered or expires; recheck at the next expiry.
      if (this.mailboxMessages.length > 0) {
        const oldestQueuedAt = Math.min(...this.mailboxMessages.map(entry => entry.queuedAt));
        this.scheduleShutdownCheck(Math.max(oldestQueuedAt + MAILBOX_MESSAGE_RETENTION_MS - now + 1, 1000));
        return;
      }
      console.log("No sessions connected, shutting down");
      this.shutdown();
    }, delayMs);
  }

  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentKey: string | null,
    setKey: (key: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;
    const requiresEndpointAuth = typeof LISTEN_TARGET !== "string";
    const hasEndpointAuth = clientMessage.stateId === BROKER_STATE_ID;

    if (clientMessage.type === "health") {
      if (typeof clientMessage.requestId !== "string") {
        throw new Error("Invalid health message");
      }
      if (requiresEndpointAuth && !hasEndpointAuth) {
        throw new Error("Invalid intercom TCP endpoint credentials");
      }
      writeMessage(socket, {
        type: "health_ok",
        requestId: clientMessage.requestId,
        protocol: INTERCOM_PROTOCOL_NAME,
        version: INTERCOM_PROTOCOL_VERSION,
      });
      return;
    }

    if (requiresEndpointAuth && clientMessage.type === "register" && !hasEndpointAuth) {
      throw new Error("Invalid intercom TCP endpoint credentials");
    }

    if (currentKey === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (currentKey) {
          throw new Error("Received duplicate register message");
        }
        
        let id: string = randomUUID();
        if (clientMessage.sessionId !== undefined) {
          if (!isSessionId(clientMessage.sessionId)) {
            throw new Error("Invalid register sessionId");
          }
          id = clientMessage.sessionId;
        }
        if (RESERVED_DESTINATIONS.has(id)) {
          writeMessage(socket, { type: "error", code: "E_RESERVED_ID", error: `Reserved routing ID "${id}"; configure a different session ID` });
          socket.end();
          break;
        }
        const scopeId = normalizeScopeId(clientMessage.scopeId);
        const key = scopedSessionKey(scopeId, id);
        const session = clientMessage.session;
        const extensions = session.extensions;
        if (extensions !== undefined) {
          if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS_PER_SESSION) {
            throw new Error(`Invalid extensions field (maximum ${MAX_EXTENSIONS_PER_SESSION})`);
          }
          for (const extension of extensions) {
            if (!this.validateExtensionCapability(extension)) {
              throw new Error(`Invalid extension capability: ${JSON.stringify(extension)}`);
            }
          }
        }

        this.pruneDisconnectedSessions();
        this.pruneMailboxMessages();
        const previous = this.sessions.get(key);
        if (!previous && this.sessions.size >= MAX_SESSIONS) {
          writeMessage(socket, { type: "error", error: "Too many registered intercom sessions" });
          socket.destroy();
          break;
        }
        if (previous && previous.info.pid !== session.pid && isProcessAlive(previous.info.pid)) {
          // Another live process holds this id. Keep it; handing the id over makes the
          // two processes evict each other on every reconnect (#155).
          const holder = previous.info;
          writeMessage(socket, {
            type: "error",
            code: SESSION_HELD_ERROR_CODE,
            error: `Intercom session ${id} is held by live process ${holder.pid} in ${holder.cwd}`,
            holder: { pid: holder.pid, cwd: holder.cwd, ...(holder.name !== undefined ? { name: holder.name } : {}) },
          });
          socket.end();
          break;
        }
        if (previous) {
          this.clearMessageReceiptRoutesForSession(key);
          previous.socket.end();
        }
        setKey(key);
        const info: SessionInfo = {
          id,
          endpointEpoch: randomUUID(),
          ...(session.role !== undefined ? { role: session.role } : {}),
          ...(session.canonicalSessionId !== undefined ? { canonicalSessionId: session.canonicalSessionId } : {}),
          ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
          ...(session.name !== undefined ? { name: session.name } : {}),
          ...(session.runtimeFallbackAlias !== undefined ? { runtimeFallbackAlias: session.runtimeFallbackAlias } : {}),
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...(session.status !== undefined ? { status: session.status } : {}),
          ...(session.tmuxPane !== undefined ? { tmuxPane: session.tmuxPane } : {}),
          ...(session.herdrPaneId !== undefined ? { herdrPaneId: session.herdrPaneId } : {}),
          trustedLocal: typeof LISTEN_TARGET === "string" && process.platform !== "win32",
        };

        const connectedSession: ConnectedSession = {
          socket,
          info,
          key,
          ...(scopeId ? { scopeId } : {}),
          lastPresenceBroadcastAt: Date.now(),
          ownerOrder: previous?.ownerOrder ?? this.nextOwnerOrder++,
          extensions,
          ...(session.herdrSessionPath ? { herdrSessionPath: session.herdrSessionPath } : {}),
          unifiedMessaging: session.features?.includes(UNIFIED_MESSAGING_FEATURE) === true,
          ...(session.livenessIntervalMs !== undefined ? { livenessIntervalMs: session.livenessIntervalMs } : {}),
          lastInboundAt: Date.now(),
        };
        this.sessions.set(key, connectedSession);
        this.disconnectedSessions.delete(key);
        
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        // This must be the first broker message. Older clients ignore the
        // additive features field; newer clients use it to avoid sending
        // extension operations to an older broker.
        writeMessage(socket, {
          type: "registered",
          sessionId: id,
          features: [EXTENSION_BUS_FEATURE, EXACT_SEND_FEATURE, UNIFIED_MESSAGING_FEATURE, PARENT_IDENTITY_FEATURE, BROADCAST_AUDIENCE_FEATURE],
        });
        this.broadcast({ type: "session_joined", session: info }, key, scopeId);

        this.recomputeNamespaceOwners();
        this.flushMailboxForSession(connectedSession);

        if (extensions) {
          for (const ext of extensions) {
            const owner = this.namespaceOwners.get(scopedExtensionKey(scopeId, ext.namespace));
            writeMessage(socket, {
              type: "extension_owner",
              namespace: ext.namespace,
              ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
            });
            const state = this.extensionStateManager.loadState(scopedExtensionStateNamespace(scopeId, ext.namespace));
            if (state) {
              writeMessage(socket, {
                type: "extension_state",
                namespace: ext.namespace,
                revision: state.revision,
                payload: state.payload,
              });
            }
          }
        }
        break;
      }

      case "unregister": {
        if (!currentKey) {
          throw new Error("Received unregister before register");
        }
        const existing = this.sessions.get(currentKey);
        if (existing?.socket === socket) {
          let retained = existing;
          if (clientMessage.moveToScopeId !== undefined) {
            const scopeId = clientMessage.moveToScopeId === null ? undefined : normalizeScopeId(clientMessage.moveToScopeId);
            const key = scopedSessionKey(scopeId, existing.info.id);
            // Only an explicit request from this identity's owner may move its retained mailbox.
            if (key !== currentKey && !this.sessions.has(key) && !this.disconnectedSessions.has(key)) {
              retained = { ...existing, key, scopeId };
              for (const edge of this.waits.values()) {
                if (edge.to === currentKey) edge.to = key;
              }
              for (const entry of this.mailboxMessages) {
                if (entry.targetKey === currentKey) entry.targetKey = key;
                if (entry.fromKey === currentKey) {
                  entry.fromKey = key;
                  const oldRecordKey = this.deliveryRecordKey(currentKey, entry.message.id);
                  const record = this.deliveryRecords.get(oldRecordKey);
                  if (record) {
                    this.deliveryRecords.delete(oldRecordKey);
                    this.deliveryRecords.set(this.deliveryRecordKey(key, entry.message.id), record);
                  }
                }
              }
            }
          }
          this.rememberDisconnectedSession(retained);
          this.sessions.delete(currentKey);
          this.clearMessageReceiptRoutesForSession(currentKey);
          this.broadcast({ type: "session_left", sessionId: existing.info.id }, currentKey, existing.scopeId);
          this.recomputeNamespaceOwners();
          this.scheduleShutdownCheck();
        }
        setKey(null);
        break;
      }

      case "extension_capabilities_update": {
        if (!currentKey) {
          throw new Error("Received extension_capabilities_update before register");
        }
        const session = this.sessions.get(currentKey);
        if (!session || session.socket !== socket) {
          throw new Error("Extension capability session not found");
        }
        const extensions = clientMessage.extensions;
        if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS_PER_SESSION) {
          throw new Error(`Invalid extensions field (maximum ${MAX_EXTENSIONS_PER_SESSION})`);
        }
        for (const extension of extensions) {
          if (!this.validateExtensionCapability(extension)) {
            throw new Error(`Invalid extension capability: ${JSON.stringify(extension)}`);
          }
        }
        session.extensions = extensions;
        this.recomputeNamespaceOwners();
        for (const extension of extensions) {
          const owner = this.namespaceOwners.get(scopedExtensionKey(session.scopeId, extension.namespace));
          writeMessage(socket, {
            type: "extension_owner",
            namespace: extension.namespace,
            ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
          });
          const state = this.extensionStateManager.loadState(scopedExtensionStateNamespace(session.scopeId, extension.namespace));
          if (state) {
            writeMessage(socket, {
              type: "extension_state",
              namespace: extension.namespace,
              revision: state.revision,
              payload: state.payload,
            });
          }
        }
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }

        const requester = currentKey ? this.sessions.get(currentKey) : undefined;
        if (!requester || requester.socket !== socket) {
          throw new Error("List session not found");
        }
        if (clientMessage.audience !== undefined) {
          if ((clientMessage.audience !== "workspace" && clientMessage.audience !== "global") || clientMessage.resolve !== undefined) throw new Error("Invalid broadcast audience request");
          const sessions = Array.from(this.sessions.values())
            .filter(session => session.key !== requester.key
              && session.info.role === "agent"
              && !session.info.parentSessionId
              && (clientMessage.audience === "global" || sameScope(session.scopeId, requester.scopeId)))
            .map(session => session.info);
          writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
          break;
        }
        if (clientMessage.resolve !== undefined) {
          if (typeof clientMessage.resolve !== "string" || (RESERVED_DESTINATIONS.has(clientMessage.resolve) && clientMessage.resolve !== "parent")) throw new Error("Invalid direct peer destination");
          const targets = clientMessage.resolve === "parent"
            ? this.resolveParent(requester)
            : this.resolveTargets(clientMessage.resolve, requester.scopeId);
          writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions: targets.map((target) => this.sessions.has(target.key) ? target.info : { ...target.info, endpointEpoch: undefined }) });
          break;
        }
        const sessions = Array.from(this.sessions.values())
          .filter(session => sameScope(session.scopeId, requester.scopeId))
          .map(s => s.info);
        const requestId = clientMessage.requestId;
        // Resolve all hosted panes from one bounded live snapshot. Never retain
        // the result: moved panes must be re-resolved by the next list request.
        const herdrSessionPaths = new Map(
          Array.from(this.sessions.values())
            .filter(session => sameScope(session.scopeId, requester.scopeId) && session.herdrSessionPath)
            .map(session => [session.info.id, session.herdrSessionPath!] as const),
        );
        void resolveHerdrLocations(sessions, { sessionPaths: herdrSessionPaths })
          .then((resolvedSessions) => writeMessage(socket, { type: "sessions", requestId, sessions: resolvedSessions }))
          .catch((cause) => {
            const detail = cause instanceof Error ? cause.message : String(cause);
            const fallback = sessions.map((session) => ({
              ...session,
              herdrLocation: session.herdrPaneId
                ? { status: "unavailable" as const, paneId: session.herdrPaneId, reason: "command_failed" as const, detail }
                : { status: "not_hosted" as const },
            }));
            writeMessage(socket, { type: "sessions", requestId, sessions: fallback });
          });
        break;
      }

      case "send": {
        if (!currentKey) {
          throw new Error("Received send before register");
        }
        const message = clientMessage.message;
        const messageId = isMessage(message) ? message.id : "unknown";

        if (typeof clientMessage.to !== "string" || !isMessage(message)) {
          this.writeDeliveryFailure(socket, messageId, "Invalid message format", "E_INVALID_MESSAGE");
          break;
        }
        const fromSession = this.sessions.get(currentKey);
        if (!fromSession || fromSession.socket !== socket) {
          this.writeDeliveryFailure(socket, message.id, "Sender session not found", "E_SENDER_NOT_FOUND");
          break;
        }

        if (!fromSession.unifiedMessaging) {
          this.writeDeliveryFailure(socket, message.id, "Sender requires a coordinated intercom upgrade and reload", "E_INCOMPATIBLE_CLIENT");
          break;
        }
        if (RESERVED_DESTINATIONS.has(clientMessage.to)) {
          this.writeDeliveryFailure(socket, message.id, "Reserved destination is not available for direct peer routing", "E_RESERVED_TARGET");
          break;
        }
        const brokerReceivedAt = Date.now();
        this.pruneMessageReceiptRoutes(brokerReceivedAt);

        const hasTargetId = clientMessage.targetId !== undefined;
        const hasTargetEpoch = clientMessage.targetEpoch !== undefined;
        if (
          (hasTargetEpoch && !hasTargetId)
          || (hasTargetId && (typeof clientMessage.targetId !== "string" || clientMessage.targetId.length === 0))
          || (hasTargetEpoch && (typeof clientMessage.targetEpoch !== "string" || clientMessage.targetEpoch.length === 0))
        ) {
          this.writeDeliveryFailure(socket, message.id, "Exact target requires a valid id and optional endpoint epoch", "E_INVALID_TARGET");
          break;
        }
        const resolved = hasTargetId
          ? this.exactTargets(clientMessage.targetId as string)
          : this.resolveTargets(clientMessage.to as string, fromSession.scopeId);
        if (resolved.length > 1) {
          this.writeDeliveryFailure(socket, message.id, "Ambiguous session target; use a unique full session ID", "E_AMBIGUOUS_TARGET");
          break;
        }
        if (hasTargetId) {
          const targetId = clientMessage.targetId as string;
          const targetEpoch = clientMessage.targetEpoch as string | undefined;
          const fingerprint = messageDeliveryFingerprint(message, targetId);
          if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) {
            break;
          }
          const exactTarget = resolved[0];
          if (!exactTarget) {
            this.recordDelivery(currentKey, message.id, fingerprint, "failed", "Session not found", "E_TARGET_NOT_FOUND");
            this.writeDeliveryFailure(socket, message.id, "Session not found", "E_TARGET_NOT_FOUND");
            break;
          }
          const liveEpoch = this.sessions.get(exactTarget.key)?.info.endpointEpoch;
          if (liveEpoch !== targetEpoch) {
            this.recordDelivery(currentKey, message.id, fingerprint, "failed", "Target endpoint changed before delivery", "E_TARGET_REBOUND", true);
            this.writeDeliveryFailure(socket, message.id, "Target endpoint changed before delivery", "E_TARGET_REBOUND", true);
            break;
          }
          clientMessage.to = targetId;
        }

        if (message.quiet && message.expectsReply) {
          this.writeDeliveryFailure(socket, message.id, "wait: true cannot be combined with quiet: true", "E_WAIT_QUIET");
          break;
        }
        const target = resolved[0] ? this.sessions.get(resolved[0].key) : undefined;
        if (target) {
          if (!target.unifiedMessaging) {
            this.writeDeliveryFailure(socket, message.id, "Receiver requires a coordinated intercom upgrade and reload", "E_INCOMPATIBLE_RECEIVER");
            break;
          }
          const fingerprint = messageDeliveryFingerprint(message, target.info.id);
          if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) {
            break;
          }
          if (message.supersedes) {
            const supersededRoute = this.messageReceiptRoutes.get(message.supersedes);
            if (!supersededRoute || supersededRoute.from !== currentKey || supersededRoute.to !== target.key) {
              this.writeDeliveryFailure(socket, message.id, "Supersede target does not match a previous message from this sender to this receiver", "E_SUPERSEDE_TARGET");
              break;
            }
          }
          if (message.expectsReply) {
            if (Array.from(this.waits.values()).some((edge) => edge.from === currentKey)) {
              this.writeDeliveryFailure(socket, message.id, "Already waiting for a reply", "E_ALREADY_WAITING");
              break;
            }
            if (Array.from(this.waits.values()).some((edge) => edge.from === target.key && edge.to === currentKey)) {
              this.writeDeliveryFailure(socket, message.id, "Mutual wait refused: target is already waiting for this session", "E_MUTUAL_WAIT");
              break;
            }
            this.waits.set(this.deliveryRecordKey(currentKey, message.id), { from: currentKey, to: target.key });
          }
          const deliveredMessage: Message = {
            ...message,
            brokerReceivedAt,
            brokerDeliveredAt: Date.now(),
          };
          if (message.supersedes) {
            const control: MessageControl = {
              action: "supersede",
              messageId: message.supersedes,
              supersededBy: message.id,
              timestamp: Date.now(),
            };
            writeMessage(target.socket, {
              type: "message_control",
              from: fromSession.info,
              control,
            });
            this.updateDeliveryRecord(currentKey, message.supersedes, "failed", `Superseded by ${message.id}`, "E_DELIVERY_SUPERSEDED");
          }
          this.messageReceiptRoutes.set(message.id, { from: currentKey, to: target.key, createdAt: brokerReceivedAt });
          writeMessage(target.socket, {
            type: "message",
            from: fromSession.info,
            message: deliveredMessage,
          });
          this.completeSocketDelivery(socket, currentKey, target, message, fingerprint);
          break;
        }

        const disconnectedTarget = resolved[0] ? this.disconnectedSessions.get(resolved[0].key) : undefined;
        if (disconnectedTarget) {
          const target = disconnectedTarget.info;
          const fingerprint = messageDeliveryFingerprint(message, target.id);
          if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) {
            break;
          }
          if (message.supersedes) {
            this.writeDeliveryFailure(socket, message.id, "Supersede target is not connected", "E_SUPERSEDE_TARGET");
            break;
          }
          if (message.expectsReply) {
            this.writeDeliveryFailure(socket, message.id, "Target session is not currently connected; waiting sends are not queued", "E_TARGET_DISCONNECTED");
            break;
          }
          if (!disconnectedTarget.unifiedMessaging) {
            this.writeDeliveryFailure(socket, message.id, "Receiver requires a coordinated intercom upgrade and reload", "E_INCOMPATIBLE_RECEIVER");
            break;
          }
          this.queueMailboxMessage(fromSession, disconnectedTarget, message, brokerReceivedAt);
          this.recordDelivery(currentKey, message.id, fingerprint, "queued");
          this.writeDeliverySuccess(socket, message.id, "queued");
          break;
        }

        this.writeDeliveryFailure(socket, message.id, "Session not found", "E_TARGET_NOT_FOUND");
        break;
      }

      case "message_receipt": {
        if (!currentKey) {
          throw new Error("Received message_receipt before register");
        }
        if (!isMessageReceipt(clientMessage.receipt)) {
          throw new Error("Invalid message_receipt message");
        }
        this.pruneMessageReceiptRoutes();
        const route = this.messageReceiptRoutes.get(clientMessage.receipt.messageId);
        const receiver = this.sessions.get(currentKey);
        const sender = route ? this.sessions.get(route.from) : undefined;
        if (route?.to === currentKey && receiver?.socket === socket) {
          const key = this.deliveryRecordKey(route.from, clientMessage.receipt.messageId);
          if (RECEIPT_PROOF_STATUSES.has(clientMessage.receipt.status)) {
            if (this.deliveryRecords.get(key)?.state !== "failed") {
              this.updateDeliveryRecord(route.from, clientMessage.receipt.messageId, "socket_delivered");
            }
            this.confirmPendingReceipt(key, socket);
            if (this.deliveryRecords.get(key)?.state === "failed") break;
          } else if (RECEIPT_FAILURE_STATUSES.has(clientMessage.receipt.status)) {
            const reason = clientMessage.receipt.detail ?? `Receiver reported ${clientMessage.receipt.status}`;
            const code = `E_RECEIVER_${clientMessage.receipt.status.toUpperCase()}`;
            this.updateDeliveryRecord(route.from, clientMessage.receipt.messageId, "failed", reason, code);
            // A late failure need not settle the owner's waiter; cancel_ask owns that cleanup.
            this.failPendingReceipt(key, reason, code, true);
          }
        }
        if (route?.to === currentKey && receiver?.socket === socket && sender) {
          writeMessage(sender.socket, {
            type: "message_receipt",
            from: receiver.info,
            receipt: clientMessage.receipt,
          });
        }
        break;
      }

      case "cancel_message": {
        if (!currentKey) {
          throw new Error("Received cancel_message before register");
        }
        if (typeof clientMessage.messageId !== "string") {
          throw new Error("Invalid cancel_message message");
        }
        this.pruneMessageReceiptRoutes();
        this.pruneMailboxMessages();
        const sender = this.sessions.get(currentKey);
        const queuedIndex = this.mailboxMessages.findIndex(entry => entry.message.id === clientMessage.messageId && entry.fromKey === currentKey);
        if (queuedIndex >= 0 && sender?.socket === socket) {
          this.mailboxMessages.splice(queuedIndex, 1);
          this.updateDeliveryRecord(currentKey, clientMessage.messageId, "failed", "Sender cancelled the queued delivery", "E_DELIVERY_CANCELLED");
          this.waits.delete(this.deliveryRecordKey(currentKey, clientMessage.messageId));
          writeMessage(socket, { type: "delivered", messageId: clientMessage.messageId });
          break;
        }
        const route = this.messageReceiptRoutes.get(clientMessage.messageId);
        const receiver = route ? this.sessions.get(route.to) : undefined;
        if (route?.from !== currentKey || sender?.socket !== socket || !receiver) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: clientMessage.messageId,
            reason: "Message cannot be cancelled by this session",
          });
          break;
        }
        writeMessage(receiver.socket, {
          type: "message_control",
          from: sender.info,
          control: {
            action: "cancel",
            messageId: clientMessage.messageId,
            timestamp: Date.now(),
          },
        });
        this.waits.delete(this.deliveryRecordKey(currentKey, clientMessage.messageId));
        this.updateDeliveryRecord(currentKey, clientMessage.messageId, "failed", "Sender cancelled the delivery", "E_DELIVERY_CANCELLED");
        writeMessage(socket, { type: "delivered", messageId: clientMessage.messageId });
        break;
      }

      case "cancel_ask": {
        if (!currentKey) {
          throw new Error("Received cancel_ask before register");
        }
        if (typeof clientMessage.messageId !== "string") {
          throw new Error("Invalid cancel_ask message");
        }
        const session = this.sessions.get(currentKey);
        if (session?.socket === socket) {
          this.waits.delete(this.deliveryRecordKey(currentKey, clientMessage.messageId));
        }
        break;
      }

      case "presence": {
        if (!currentKey) {
          throw new Error("Received presence before register");
        }
        const session = this.sessions.get(currentKey);
        if (session?.socket === socket) {
          let changed = false;
          if (clientMessage.name !== undefined) {
            if (typeof clientMessage.name !== "string") {
              throw new Error("Invalid presence name");
            }
            if (session.info.name !== clientMessage.name) {
              session.info.name = clientMessage.name;
              changed = true;
            }
          }
          if (clientMessage.runtimeFallbackAlias !== undefined) {
            if (typeof clientMessage.runtimeFallbackAlias !== "boolean") {
              throw new Error("Invalid presence runtimeFallbackAlias");
            }
            if (session.info.runtimeFallbackAlias !== clientMessage.runtimeFallbackAlias) {
              session.info.runtimeFallbackAlias = clientMessage.runtimeFallbackAlias;
              changed = true;
            }
          }
          if (clientMessage.status !== undefined) {
            if (typeof clientMessage.status !== "string") {
              throw new Error("Invalid presence status");
            }
            if (session.info.status !== clientMessage.status) {
              session.info.status = clientMessage.status;
              changed = true;
            }
          }
          if (clientMessage.model !== undefined) {
            if (typeof clientMessage.model !== "string") {
              throw new Error("Invalid presence model");
            }
            if (session.info.model !== clientMessage.model) {
              session.info.model = clientMessage.model;
              changed = true;
            }
          }
          // Context-usage fields: a number updates, an explicit null CLEARS (the
          // value is unknown right after a compaction — delete rather than carry
          // the stale-high value forward), undefined leaves the field untouched.
          if (clientMessage.contextPct !== undefined) {
            if (clientMessage.contextPct === null) {
              if (session.info.contextPct !== undefined) { delete session.info.contextPct; changed = true; }
            } else if (typeof clientMessage.contextPct !== "number") {
              throw new Error("Invalid presence contextPct");
            } else if (session.info.contextPct !== clientMessage.contextPct) {
              session.info.contextPct = clientMessage.contextPct;
              changed = true;
            }
          }
          if (clientMessage.contextTokens !== undefined) {
            if (clientMessage.contextTokens === null) {
              if (session.info.contextTokens !== undefined) { delete session.info.contextTokens; changed = true; }
            } else if (typeof clientMessage.contextTokens !== "number") {
              throw new Error("Invalid presence contextTokens");
            } else if (session.info.contextTokens !== clientMessage.contextTokens) {
              session.info.contextTokens = clientMessage.contextTokens;
              changed = true;
            }
          }
          if (clientMessage.contextWindow !== undefined) {
            if (clientMessage.contextWindow === null) {
              if (session.info.contextWindow !== undefined) { delete session.info.contextWindow; changed = true; }
            } else if (typeof clientMessage.contextWindow !== "number") {
              throw new Error("Invalid presence contextWindow");
            } else if (session.info.contextWindow !== clientMessage.contextWindow) {
              session.info.contextWindow = clientMessage.contextWindow;
              changed = true;
            }
          }
          const now = Date.now();
          session.info.lastActivity = now;
          if (changed || now - session.lastPresenceBroadcastAt >= PRESENCE_HEARTBEAT_MS) {
            session.lastPresenceBroadcastAt = now;
            this.broadcast({ type: "presence_update", session: session.info }, currentKey, session.scopeId);
          }
        }
        break;
      }

      case "extension_publish": {
        this.handleExtensionPublish(socket, currentKey, clientMessage);
        break;
      }

      case "extension_state_commit": {
        this.handleExtensionStateCommit(socket, currentKey, clientMessage);
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private rememberDisconnectedSession(session: ConnectedSession, now = Date.now()): void {
    this.disconnectedSessions.set(session.key, {
      info: { ...session.info },
      unifiedMessaging: session.unifiedMessaging,
      key: session.key,
      ...(session.scopeId ? { scopeId: session.scopeId } : {}),
      disconnectedAt: now,
    });
    this.pruneDisconnectedSessions(now);
  }

  private pruneDisconnectedSessions(now = Date.now()): void {
    for (const [sessionId, session] of this.disconnectedSessions) {
      if (now - session.disconnectedAt > DISCONNECTED_SESSION_RETENTION_MS) {
        this.disconnectedSessions.delete(sessionId);
      }
    }
  }

  private pruneMailboxMessages(now = Date.now()): void {
    for (let index = this.mailboxMessages.length - 1; index >= 0; index -= 1) {
      const entry = this.mailboxMessages[index]!;
      if (now - entry.queuedAt > MAILBOX_MESSAGE_RETENTION_MS) {
        this.messageReceiptRoutes.delete(entry.message.id);
        this.updateDeliveryRecord(entry.fromKey, entry.message.id, "failed", "Mailbox delivery expired", "E_DELIVERY_EXPIRED");
        this.mailboxMessages.splice(index, 1);
      }
    }
  }

  private queueMailboxMessage(from: ConnectedSession, target: DisconnectedSession, message: Message, brokerReceivedAt: number): void {
    this.pruneMailboxMessages(brokerReceivedAt);
    while (this.mailboxMessages.length >= MAX_MAILBOX_MESSAGES) {
      const evicted = this.mailboxMessages.shift();
      if (!evicted) break;
      this.messageReceiptRoutes.delete(evicted.message.id);
      this.updateDeliveryRecord(evicted.fromKey, evicted.message.id, "failed", "Mailbox capacity evicted the delivery", "E_DELIVERY_EVICTED");
    }
    this.mailboxMessages.push({
      from: { ...from.info },
      fromKey: from.key,
      targetKey: target.key,
      message: { ...message, brokerReceivedAt },
      queuedAt: brokerReceivedAt,
    });
  }

  private writeDeliverySuccess(socket: net.Socket, messageId: string, delivery: "socket_delivered" | "queued"): void {
    writeMessage(socket, { type: "delivered", messageId, delivery, retryable: false, outcomeKnown: true });
  }

  private writeDeliveryFailure(socket: net.Socket, messageId: string, reason: string, code: string, retryable = false): void {
    writeMessage(socket, { type: "delivery_failed", messageId, reason, delivery: "failed", code, retryable, outcomeKnown: true });
  }

  // Socket writes and transport receipts cannot prove a receiver selected a delivery path.
  private completeSocketDelivery(senderSocket: net.Socket, fromKey: string, target: ConnectedSession, message: Message, fingerprint: string): void {
    const key = this.deliveryRecordKey(fromKey, message.id);
    this.recordDelivery(fromKey, message.id, fingerprint, "unknown");
    const timer = setTimeout(() => {
      this.failPendingReceipt(key, `Receiver did not confirm acceptance within ${RECEIPT_TIMEOUT_MS}ms`, "E_RECEIPT_TIMEOUT");
    }, RECEIPT_TIMEOUT_MS);
    timer.unref();
    this.pendingReceipts.set(key, {
      senderSocket,
      fromKey,
      messageId: message.id,
      targetSocket: target.socket,
      timer,
    });
  }

  private confirmPendingReceipt(key: string, receiverSocket: net.Socket): void {
    const pending = this.pendingReceipts.get(key);
    if (!pending || pending.targetSocket !== receiverSocket) return;
    clearTimeout(pending.timer);
    this.pendingReceipts.delete(key);
    // A cancel or supersede may already have settled the record while the receipt was in flight.
    const record = this.deliveryRecords.get(key);
    if (record?.state === "failed") {
      if (pending.senderSocket.writable) this.writeDeliveryFailure(pending.senderSocket, pending.messageId, record.reason ?? "Delivery failed", record.code ?? "E_DELIVERY_FAILED");
      return;
    }
    this.updateDeliveryRecord(pending.fromKey, pending.messageId, "socket_delivered");
    if (pending.senderSocket.writable) this.writeDeliverySuccess(pending.senderSocket, pending.messageId, "socket_delivered");
  }

  private failPendingReceipt(key: string, reason: string, code: string, outcomeKnown = false): void {
    const pending = this.pendingReceipts.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingReceipts.delete(key);
    if (pending.senderSocket.writable) {
      writeMessage(pending.senderSocket, { type: "delivery_failed", messageId: pending.messageId, reason, delivery: outcomeKnown ? "failed" : "unknown", code, retryable: false, outcomeKnown });
    }
  }

  private settlePendingReceiptsForSocket(socket: net.Socket): void {
    for (const [key, pending] of this.pendingReceipts) {
      // A closed sender socket is unwritable, so this reason only ever reaches a live sender.
      if (pending.targetSocket === socket || pending.senderSocket === socket) {
        this.failPendingReceipt(key, "Receiver disconnected before confirming receipt", "E_RECEIVER_DISCONNECTED");
      }
    }
  }

  private deliveryRecordKey(fromSessionId: string, messageId: string): string {
    return JSON.stringify([fromSessionId, messageId]);
  }

  private replayOrReject(socket: net.Socket, fromSessionId: string, messageId: string, fingerprint: string): boolean {
    this.pruneDeliveryRecords();
    const key = this.deliveryRecordKey(fromSessionId, messageId);
    const record = this.deliveryRecords.get(key);
    if (!record) return false;
    if (record.fingerprint !== fingerprint) {
      this.writeDeliveryFailure(socket, messageId, "Message id was reused with different authored content", "E_MESSAGE_ID_REUSE");
      return true;
    }
    if (record.state === "unknown") {
      const pending = this.pendingReceipts.get(key);
      if (pending) {
        // The receipt is still in flight; its outcome answers this retry.
        pending.senderSocket = socket;
        return true;
      }
      writeMessage(socket, { type: "delivery_failed", messageId, reason: "Previous delivery acceptance is unknown; not redispatched", delivery: "unknown", code: "E_RECEIPT_TIMEOUT", retryable: false, outcomeKnown: false });
      return true;
    }
    if (record.code === "E_TARGET_REBOUND" && record.retryable) {
      return false;
    }
    if (record.state === "socket_delivered" || record.state === "queued") {
      this.writeDeliverySuccess(socket, messageId, record.state);
    } else {
      this.writeDeliveryFailure(socket, messageId, record.reason ?? "Previous delivery failed", record.code ?? "E_DELIVERY_FAILED", record.retryable);
    }
    return true;
  }

  private recordDelivery(fromSessionId: string, messageId: string, fingerprint: string, state: DeliveryState, reason?: string, code?: string, retryable = false): void {
    this.pruneDeliveryRecords();
    while (this.deliveryRecords.size >= MAX_DELIVERY_RECORDS) {
      const oldest = this.deliveryRecords.keys().next().value;
      if (oldest === undefined) break;
      this.deliveryRecords.delete(oldest);
    }
    this.deliveryRecords.set(this.deliveryRecordKey(fromSessionId, messageId), {
      fingerprint,
      state,
      ...(reason ? { reason } : {}),
      ...(code ? { code } : {}),
      retryable,
      createdAt: Date.now(),
    });
  }

  private pruneDeliveryRecords(now = Date.now()): void {
    for (const [key, record] of this.deliveryRecords) {
      if (now - record.createdAt > DELIVERY_RECORD_RETENTION_MS) this.deliveryRecords.delete(key);
    }
  }

  private updateDeliveryRecord(fromSessionId: string, messageId: string, state: DeliveryState, reason?: string, code?: string): void {
    const record = this.deliveryRecords.get(this.deliveryRecordKey(fromSessionId, messageId));
    if (!record) return;
    record.state = state;
    record.reason = reason;
    record.code = code;
    record.retryable = false;
  }

  private flushMailboxForSession(session: ConnectedSession, now = Date.now()): void {
    this.pruneMailboxMessages(now);
    for (let index = 0; index < this.mailboxMessages.length;) {
      const entry = this.mailboxMessages[index]!;
      if (entry.targetKey !== session.key || !session.unifiedMessaging) {
        index += 1;
        continue;
      }
      // The only bulk write to one socket: pace it so a large mailbox cannot trip writeMessage's queue cap.
      if (session.socket.writableLength >= MAX_FRAME_BYTES) {
        session.socket.once("drain", () => {
          if (this.sessions.get(session.key) === session) this.flushMailboxForSession(session);
        });
        return;
      }

      this.mailboxMessages.splice(index, 1);
      const deliveredMessage: Message = {
        ...entry.message,
        brokerDeliveredAt: Date.now(),
      };
      writeMessage(session.socket, {
        type: "message",
        from: entry.from,
        message: deliveredMessage,
      });
      this.messageReceiptRoutes.set(entry.message.id, {
        from: entry.fromKey,
        to: session.key,
        createdAt: entry.message.brokerReceivedAt ?? entry.queuedAt,
      });
      this.updateDeliveryRecord(entry.fromKey, entry.message.id, "unknown");
    }
  }

  private pruneMessageReceiptRoutes(now = Date.now()): void {
    for (const [messageId, route] of this.messageReceiptRoutes) {
      if (now - route.createdAt > MESSAGE_RECEIPT_ROUTE_RETENTION_MS) {
        this.messageReceiptRoutes.delete(messageId);
      }
    }
  }

  private clearMessageReceiptRoutesForSession(sessionKey: string): void {
    // A recipient reconnect does not end the originating session's local waiter.
    for (const [key, edge] of this.waits) {
      if (edge.from === sessionKey) this.waits.delete(key);
    }
    for (const [messageId, route] of this.messageReceiptRoutes) {
      if (route.from === sessionKey || route.to === sessionKey) {
        this.messageReceiptRoutes.delete(messageId);
      }
    }
  }

  private exactTargets(id: string): Array<ConnectedSession | DisconnectedSession> {
    this.pruneDisconnectedSessions();
    return [...this.sessions.values(), ...this.disconnectedSessions.values()].filter((session) => session.info.id === id);
  }

  private resolveParent(requester: ConnectedSession): Array<ConnectedSession | DisconnectedSession> {
    const parentId = requester.info.parentSessionId;
    if (requester.info.role !== "agent" || !parentId) return [];
    this.pruneDisconnectedSessions();
    // A current endpoint supersedes historical routing aliases for the same Pi runtime.
    const live = [...this.sessions.values()].filter((session) => session.info.role === "agent" && session.info.canonicalSessionId === parentId);
    if (live.length > 0) return live;
    return [...this.disconnectedSessions.values()].filter((session) => session.info.role === "agent" && session.info.canonicalSessionId === parentId);
  }

  private resolveTargets(nameOrId: string, scopeId: string | undefined): Array<ConnectedSession | DisconnectedSession> {
    const exact = this.exactTargets(nameOrId);
    if (exact.length > 0) return exact;
    // A full UUID is an identity, never a display-name or prefix suggestion.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId)) return [];
    const local = [...this.sessions.values()].filter((session) => sameScope(session.scopeId, scopeId));
    const lowerName = nameOrId.toLowerCase();
    const named = local.filter((session) => !RESERVED_DESTINATIONS.has(session.info.name?.toLowerCase() ?? ""));
    const names = named.filter((session) => session.info.name?.toLowerCase() === lowerName);
    if (names.length > 0) return names;
    const ids = local.filter((session) => session.info.id.startsWith(nameOrId));
    if (ids.length > 0) return ids;
    return named.filter((session) => session.info.name?.toLowerCase().startsWith(lowerName));
  }

  private broadcast(msg: BrokerMessage, exclude?: string, scopeId?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude && sameScope(session.scopeId, scopeId)) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private validateExtensionCapability(cap: unknown): cap is ExtensionCapability {
    if (typeof cap !== "object" || cap === null) {
      return false;
    }
    const c = cap as Record<string, unknown>;
    if (typeof c.namespace !== "string" || typeof c.ownerEligible !== "boolean") {
      return false;
    }
    return this.validateNamespace(c.namespace);
  }

  private validateNamespace(ns: string): boolean {
    // ^[a-z0-9][a-z0-9._/-]{0,63}$
    if (ns.length === 0 || ns.length > 64) {
      return false;
    }
    if (!/^[a-z0-9]/.test(ns)) {
      return false;
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/.test(ns)) {
      return false;
    }
    return true;
  }

  private recomputeNamespaceOwners(): void {
    const namespaces = new Map<string, { namespace: string; scopeId?: string }>();
    for (const [key, owner] of this.namespaceOwners) {
      namespaces.set(key, {
        namespace: owner.namespace,
        ...(owner.scopeId ? { scopeId: owner.scopeId } : {}),
      });
    }
    for (const session of this.sessions.values()) {
      for (const extension of session.extensions ?? []) {
        namespaces.set(scopedExtensionKey(session.scopeId, extension.namespace), {
          namespace: extension.namespace,
          ...(session.scopeId ? { scopeId: session.scopeId } : {}),
        });
      }
    }

    // For each namespace, elect owner by (startedAt, sessionId).
    for (const [namespaceKey, scopedNamespace] of namespaces) {
      const { namespace, scopeId } = scopedNamespace;
      const candidates: Array<{ sessionKey: string; session: ConnectedSession }> = [];
      for (const [sessionKey, session] of this.sessions) {
        if (session.extensions) {
          const hasNamespace = session.extensions.some(
            (ext) => sameScope(session.scopeId, scopeId) && ext.namespace === namespace && ext.ownerEligible
          );
          if (hasNamespace) {
            candidates.push({ sessionKey, session });
          }
        }
      }

      if (candidates.length === 0) {
        if (this.namespaceOwners.delete(namespaceKey)) {
          for (const session of this.sessions.values()) {
            const isCapable = sameScope(session.scopeId, scopeId)
              && session.extensions?.some((extension) => extension.namespace === namespace);
            if (isCapable) {
              writeMessage(session.socket, { type: "extension_owner", namespace });
            }
          }
        }
        continue;
      }

      // Use broker-owned registration order so clients cannot seize authority
      // by backdating their advertised session start time. Stable-ID socket
      // replacements preserve the original order.
      candidates.sort((a, b) => {
        if (a.session.ownerOrder !== b.session.ownerOrder) {
          return a.session.ownerOrder - b.session.ownerOrder;
        }
        return a.session.info.id.localeCompare(b.session.info.id);
      });

      const winner = candidates[0]!;
      const existing = this.namespaceOwners.get(namespaceKey);

      const ownerChanged = !existing || existing.sessionKey !== winner.sessionKey;
      const socketChanged = existing && existing.socket !== winner.session.socket;

      if (ownerChanged || socketChanged) {
        const epoch = randomUUID();
        this.namespaceOwners.set(namespaceKey, {
          namespace,
          sessionKey: winner.sessionKey,
          sessionId: winner.session.info.id,
          socket: winner.session.socket,
          epoch,
          ...(scopeId ? { scopeId } : {}),
        });

        for (const session of this.sessions.values()) {
          if (session.extensions?.length) {
            const isCapable = sameScope(session.scopeId, scopeId)
              && session.extensions.some((ext) => ext.namespace === namespace);
            if (isCapable) {
              writeMessage(session.socket, {
                type: "extension_owner",
                namespace,
                ownerId: winner.session.info.id,
                ownerEpoch: epoch,
              });
            }
          }
        }
      }
    }
  }

  private handleExtensionPublish(
    socket: net.Socket,
    currentKey: string | null,
    msg: Record<string, unknown>
  ): void {
    if (!currentKey) {
      throw new Error("Received extension_publish before register");
    }

    const session = this.sessions.get(currentKey);
    if (!session || session.socket !== socket) {
      writeMessage(socket, { type: "error", error: "Session not found" });
      return;
    }

    if (!session.extensions?.length) {
      writeMessage(socket, { type: "error", error: "Session has not advertised extension capability" });
      return;
    }

    const namespace = msg.namespace;
    const audience = msg.audience;
    const ownerOnly = msg.ownerOnly === true;
    const ownerEpoch = msg.ownerEpoch;
    const payload = msg.payload;

    if (typeof namespace !== "string" || !this.validateNamespace(namespace)) {
      writeMessage(socket, { type: "error", error: "Invalid namespace" });
      return;
    }

    if (audience !== "owner" && audience !== "capable") {
      writeMessage(socket, { type: "error", error: "Invalid audience" });
      return;
    }

    const payloadSize = serializedPayloadSize(payload);
    if (payloadSize === null || payloadSize > MAX_EXTENSION_MESSAGE_BYTES) {
      writeMessage(socket, { type: "error", error: "Invalid extension payload or payload exceeds 16 KiB limit" });
      return;
    }

    // Verify sender has capability for this namespace
    const hasCapability = session.extensions?.some((ext) => ext.namespace === namespace);
    if (!hasCapability) {
      writeMessage(socket, { type: "error", error: "Sender does not have capability for this namespace" });
      return;
    }

    const owner = this.namespaceOwners.get(scopedExtensionKey(session.scopeId, namespace));
    if ((audience === "owner" || ownerOnly) && !owner) {
      writeMessage(socket, { type: "error", error: "No owner for this namespace" });
      return;
    }

    // For owner-only messages, validate exact socket and epoch
    if (ownerOnly && owner) {
      if (typeof ownerEpoch !== "string") {
        writeMessage(socket, { type: "error", error: "ownerEpoch required for owner-only messages" });
        return;
      }
      if (currentKey !== owner.sessionKey || socket !== owner.socket || ownerEpoch !== owner.epoch) {
        writeMessage(socket, { type: "error", error: "Owner validation failed" });
        return;
      }
    }

    // Route message to appropriate audience
    for (const [recipientId, recipientSession] of this.sessions) {
      if (!sameScope(recipientSession.scopeId, session.scopeId)) {
        continue;
      }
      if (!recipientSession.extensions?.length) {
        continue;
      }

      const isCapable = recipientSession.extensions.some((ext) => ext.namespace === namespace);
      if (!isCapable) {
        continue;
      }

      const shouldReceive =
        audience === "capable" ||
        (audience === "owner" && owner !== undefined &&
          recipientId === owner.sessionKey &&
          recipientSession.socket === owner.socket);

      if (shouldReceive) {
        writeMessage(recipientSession.socket, {
          type: "extension_message",
          namespace,
          fromSessionId: session.info.id,
          ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
          payload,
        });
      }
    }
  }

  private handleExtensionStateCommit(
    socket: net.Socket,
    currentKey: string | null,
    msg: Record<string, unknown>
  ): void {
    if (!currentKey) {
      throw new Error("Received extension_state_commit before register");
    }

    const session = this.sessions.get(currentKey);
    if (!session || session.socket !== socket) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace: String(msg.namespace || ""),
        committed: false,
        revision: 0,
        reason: "Session not found",
      });
      return;
    }

    if (!session.extensions?.length) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace: String(msg.namespace || ""),
        committed: false,
        revision: 0,
        reason: "Session has not advertised extension capability",
      });
      return;
    }

    const namespace = msg.namespace;
    const ownerEpoch = msg.ownerEpoch;
    const expectedRevision = msg.expectedRevision;
    const payload = msg.payload;

    if (typeof namespace !== "string" || !this.validateNamespace(namespace)) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace: String(namespace),
        committed: false,
        revision: 0,
        reason: "Invalid namespace",
      });
      return;
    }
    const stateNamespace = scopedExtensionStateNamespace(session.scopeId, namespace);

    if (typeof ownerEpoch !== "string") {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Invalid ownerEpoch",
      });
      return;
    }

    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Invalid expectedRevision",
      });
      return;
    }

    const payloadSize = serializedPayloadSize(payload);
    if (payloadSize === null || payloadSize > MAX_EXTENSION_STATE_BYTES) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Invalid extension state or payload exceeds 64 KiB limit",
      });
      return;
    }

    // Verify sender has capability for this namespace
    const hasCapability = session.extensions?.some((ext) => ext.namespace === namespace);
    if (!hasCapability) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Sender does not have capability for this namespace",
      });
      return;
    }

    const owner = this.namespaceOwners.get(scopedExtensionKey(session.scopeId, namespace));
    if (!owner) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "No owner for this namespace",
      });
      return;
    }

    // Validate owner, socket, and epoch
    if (currentKey !== owner.sessionKey || socket !== owner.socket || ownerEpoch !== owner.epoch) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Owner validation failed",
      });
      return;
    }

    const result = this.extensionStateManager.commitState(stateNamespace, expectedRevision, payload);

    // Send result to committer
    writeMessage(socket, {
      type: "extension_state_result",
      namespace,
      committed: result.committed,
      revision: result.revision,
      reason: result.reason,
    });

    // If committed, broadcast new state to all capable sessions
    if (result.committed) {
      for (const recipientSession of this.sessions.values()) {
        if (!sameScope(recipientSession.scopeId, session.scopeId)) {
          continue;
        }
        if (!recipientSession.extensions?.length) {
          continue;
        }

        const isCapable = recipientSession.extensions.some((ext) => ext.namespace === namespace);
        if (isCapable) {
          writeMessage(recipientSession.socket, {
            type: "extension_state",
            namespace,
            revision: result.revision,
            payload,
          });
        }
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");
    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    this.waits.clear();
    this.messageReceiptRoutes.clear();
    this.disconnectedSessions.clear();
    this.mailboxMessages.length = 0;
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      try {
        unlinkSync(LISTEN_TARGET);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
    }
    try {
      unlinkSync(PORT_PATH);
    } catch {
      // The TCP endpoint file only exists when opt-in TCP transport is active.
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
    this.server.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
