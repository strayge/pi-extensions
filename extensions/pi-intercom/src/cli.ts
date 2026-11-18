#!/usr/bin/env -S npx tsx
/** Scripted access uses the same exact-identity sender and wait lifecycle as the extension. */
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { IntercomClient, type SendResult } from "./broker/client.ts";
import { formatBroadcastResult, isBroadcastDestination, sendBroadcast } from "./broadcast.ts";
import { loadConfig } from "./config.ts";
import { ReplyWaiter } from "./reply-tracker.ts";
import {
  parseRelayEnvelope,
  relayMessage,
  relaySenderName,
  resolveOrigin,
  type CrossMachineEnvelope,
} from "./cross-machine-envelope.ts";
import { sendCrossMachine, type CrossMachineDelivery } from "./cross-machine-transport.ts";
import { parseCrossMachineTarget } from "./cross-machine-discovery.ts";
import type { Message, SessionInfo, SessionRegistration } from "./types.ts";

export const CLI_USAGE = `usage: pi-intercom <list|send> [--to <name|session-id|parent|workspace|global>] [--text <message>]
                        [--wait] [--quiet|--active] [--reply-to <message-id>] [--timeout-ms <n>] [--name <session-name>] [--json]
Direct sends default to active; workspace/global broadcasts default to quiet and exclude children/CLI clients.
Full IDs route across pools; names/prefixes and list stay in the current pool. global means this broker only.
--wait requires a live direct peer, cannot combine with --quiet, and stops only waiting. Broadcasts cannot use --wait/--reply-to.
Thread answers with explicit --to <full-sender-id> --reply-to <message-id>. The standalone CLI has no parent.
Acceptance is not read proof; receipt timeout is unknown. Do not automatically retry uncertain sends.`;
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

export interface CliOptions {
  command: "list" | "send" | "relay";
  to: string | null;
  text: string | null;
  wait: boolean;
  quiet: boolean;
  replyTo?: string;
  envelopeStdin: boolean;
  timeoutMs: number;
  name: string;
  json: boolean;
}

export class CliUsageError extends Error {}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command !== "list" && command !== "send" && command !== "relay") {
    throw new CliUsageError(`unknown command: ${String(command)}; use send --wait instead of ask\n${CLI_USAGE}`);
  }
  const opts: CliOptions = {
    command, to: null, text: null, wait: false, quiet: false, envelopeStdin: false,
    timeoutMs: DEFAULT_WAIT_TIMEOUT_MS, name: "pi-intercom-cli", json: false,
  };
  if (command === "relay"
    && (rest.filter((arg) => arg === "--envelope-stdin").length !== 1
      || rest.filter((arg) => arg === "--json").length > 1
      || rest.some((arg) => arg !== "--envelope-stdin" && arg !== "--json"))) {
    throw new CliUsageError(`relay requires only --envelope-stdin (and optional --json)\n${CLI_USAGE}`);
  }
  let deliveryMode: "quiet" | "active" | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") { opts.json = true; continue; }
    if (arg === "--wait") { opts.wait = true; continue; }
    if (arg === "--quiet" || arg === "--active") {
      const mode = arg === "--quiet" ? "quiet" : "active";
      if (deliveryMode !== undefined && deliveryMode !== mode) throw new CliUsageError("Choose either --quiet or --active");
      deliveryMode = mode;
      continue;
    }
    if (arg === "--envelope-stdin") { opts.envelopeStdin = true; continue; }
    const value = rest[i + 1];
    if (value === undefined) throw new CliUsageError(`missing value for ${arg}\n${CLI_USAGE}`);
    if (arg === "--to") opts.to = value;
    else if (arg === "--text") opts.text = value;
    else if (arg === "--name") opts.name = value;
    else if (arg === "--reply-to") opts.replyTo = value;
    else if (arg === "--timeout-ms") {
      const parsed = Number(value);
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new CliUsageError(`invalid --timeout-ms value: ${value}`);
      }
      opts.timeoutMs = parsed;
    } else throw new CliUsageError(`unknown option: ${arg}\n${CLI_USAGE}`);
    i++;
  }
  opts.quiet = deliveryMode === "quiet" || (deliveryMode === undefined && opts.command === "send" && isBroadcastDestination(opts.to));
  if (opts.command === "send" && isBroadcastDestination(opts.to)) {
    if (opts.wait || opts.replyTo !== undefined) throw new CliUsageError("Broadcasts do not support --wait or --reply-to");
  }
  if (opts.wait && opts.quiet) throw new CliUsageError("--wait cannot be combined with --quiet");
  if (opts.command !== "send" && deliveryMode !== undefined) throw new CliUsageError("--quiet and --active require send");
  if (opts.command !== "relay" && opts.envelopeStdin) throw new CliUsageError("--envelope-stdin is only valid for relay");
  if (opts.command !== "send" && (opts.wait || opts.replyTo)) throw new CliUsageError("--wait and --reply-to require send");
  if (opts.command === "send") {
    if (!opts.to) throw new CliUsageError(`--to is required for send\n${CLI_USAGE}`);
    if (!opts.text) throw new CliUsageError(`--text is required for send\n${CLI_USAGE}`);
  }
  return opts;
}

/** The transport surface is injectable without constructing SDK sessions. */
export interface CliClient {
  sessionId?: string | null;
  isConnected(): boolean;
  connect(session: SessionRegistration, sessionId?: string): Promise<void>;
  listSessions(options?: Parameters<IntercomClient["listSessions"]>[0]): Promise<SessionInfo[]>;
  resolveTarget(to: string, options?: { requireLive?: boolean }): Promise<SessionInfo | null>;
  send(to: string, options: Parameters<IntercomClient["send"]>[1]): Promise<SendResult>;
  cancelAsk(messageId: string): void;
  sendMessageReceipt(receipt: Parameters<IntercomClient["sendMessageReceipt"]>[0]): void;
  on(event: "message", listener: (from: SessionInfo, message: Message) => void): unknown;
  on(event: "disconnected", listener: (error: Error) => void): unknown;
  off(event: "message", listener: (from: SessionInfo, message: Message) => void): unknown;
  off(event: "disconnected", listener: (error: Error) => void): unknown;
  disconnect(): Promise<void>;
}

export interface CliDeps {
  client: CliClient;
  out?: { write(chunk: string): unknown };
  err?: { write(chunk: string): unknown };
  signal?: AbortSignal;
  readStdin?: () => Promise<string>;
  crossMachineSend?: (target: string, text: string, origin: ReturnType<typeof resolveOrigin>) => Promise<CrossMachineDelivery>;
  machineName?: string;
}

export function buildCliRegistration(name: string, now = Date.now(), runtimeFallbackAlias = false): SessionRegistration {
  return {
    role: "transport",
    cwd: process.cwd(), model: "pi-intercom-cli", pid: process.pid,
    startedAt: now, lastActivity: now, name,
    ...(runtimeFallbackAlias ? { runtimeFallbackAlias: true } : {}), status: "idle",
  };
}

function sessionRow(session: SessionInfo): { name: string; id: string; model: string; status: string; cwd: string } {
  return { name: session.name ?? "(unnamed)", id: session.id, model: session.model, status: session.status ?? "?", cwd: session.cwd };
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  const reportFailure = (message: string, code = 1, result?: SendResult): number => {
    if (argv.includes("--json")) out.write(`${JSON.stringify({ ok: false, error: message, ...(result ?? {}) })}\n`);
    else err.write(`${message}\n`);
    return code;
  };
  let opts: CliOptions;
  let relayEnvelope: CrossMachineEnvelope | undefined;
  try {
    opts = parseCliArgs(argv);
    if (opts.command === "relay") {
      relayEnvelope = parseRelayEnvelope(await (deps.readStdin ?? readProcessStdin)());
      if (relayEnvelope.target.includes("@") || isBroadcastDestination(relayEnvelope.target)) throw new CliUsageError("relay target must be a local direct name or session id, not a broadcast");
    }
    if (opts.command === "send" && opts.to!.includes("@")) {
      if (opts.wait || opts.quiet || opts.replyTo) throw new CliUsageError("Cross-machine sends do not support --wait, --quiet, or --reply-to");
      parseCrossMachineTarget(opts.to!);
    }
  } catch (error) {
    return reportFailure(error instanceof Error ? error.message : String(error));
  }
  try {
    await deps.client.connect({ ...buildCliRegistration(relayEnvelope ? relaySenderName(relayEnvelope.origin) : opts.name, Date.now(), Boolean(relayEnvelope)), acknowledgesReceipts: opts.wait });
  } catch (error) {
    return reportFailure(`cannot reach the local intercom broker: ${error instanceof Error ? error.message : String(error)}\nis a pi session with pi-intercom loaded currently running on this machine?`);
  }
  try {
    if (deps.signal?.aborted) throw new Error("Cancelled before dispatch");
    if (opts.command === "list") {
      const sessions = await deps.client.listSessions();
      if (opts.json) out.write(`${JSON.stringify({ ok: true, sessions: sessions.map(sessionRow) }, null, 2)}\n`);
      else for (const session of sessions) {
        const row = sessionRow(session);
        out.write(`${row.name}\t${row.id}\t${row.model}\t${row.status}\t${row.cwd}\n`);
      }
      return 0;
    }
    if (opts.command === "relay") {
      const envelope = relayEnvelope!;
      const result = await deps.client.send(envelope.target, {
        text: relayMessage(envelope), signal: deps.signal,
        crossMachine: { type: "ssh-relay", version: 1, origin: envelope.origin, trust: envelope.trust },
      });
      if (!result.delivered) return reportFailure(`relay delivery failed: ${result.reason ?? "unknown reason"}`, 1, result);
      if (opts.json) out.write(`${JSON.stringify({ ok: true, ...result, origin: relaySenderName(envelope.origin), trust: envelope.trust })}\n`);
      else out.write(`relayed from ${relaySenderName(envelope.origin)} to ${envelope.target} (${result.id})\n`);
      return 0;
    }
    if (opts.to!.includes("@")) {
      if (!deps.crossMachineSend) return reportFailure("cross-machine delivery is unavailable");
      const sessions = await deps.client.listSessions();
      const remote = await deps.crossMachineSend(opts.to!, opts.text!, resolveOrigin(sessions, opts.name, deps.machineName ?? "localhost", deps.client.sessionId));
      if (opts.json) out.write(`${JSON.stringify({ ok: true, delivered: true, crossMachine: true, machine: remote.machine.label, target: remote.agent.name })}\n`);
      else out.write(`delivered to ${relaySenderName({ name: remote.agent.name, machine: remote.machine.label })} over SSH\n`);
      return 0;
    }
    if (isBroadcastDestination(opts.to)) {
      const snapshot = await deps.client.listSessions({ audience: opts.to });
      const result = await sendBroadcast(deps.client, opts.to, snapshot, { text: opts.text!, quiet: opts.quiet, signal: deps.signal });
      if (opts.json) out.write(`${JSON.stringify(result, null, 2)}\n`);
      else out.write(`${formatBroadcastResult(result)}\n`);
      return result.ok ? 0 : 1;
    }
    if (!opts.wait) {
      const result = await deps.client.send(opts.to!, { text: opts.text!, replyTo: opts.replyTo, quiet: opts.quiet, signal: deps.signal });
      if (!result.delivered) return reportFailure(`delivery ${result.delivery}: ${result.reason ?? "unknown reason"}`, 1, result);
      if (opts.json) out.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      else out.write(`${result.delivery === "queued" ? "queued in volatile mailbox" : "accepted"} by ${result.targetId ?? opts.to} (${result.id})\n`);
      return 0;
    }

    const target = await deps.client.resolveTarget(opts.to!, { requireLive: true });
    if (!target?.endpointEpoch) throw new Error("Waiting sends require a live peer");
    if (target.id === deps.client.sessionId) throw new Error("Cannot message the current session");
    if (deps.signal?.aborted) throw new Error("Cancelled before dispatch");
    const messageId = randomUUID();
    const waiter = new ReplyWaiter(opts.timeoutMs);
    let lastDelivery = "created";
    const reply = waiter.wait(target.id, messageId, { signal: deps.signal, onFinish: () => deps.client.cancelAsk(messageId), deliveryState: () => lastDelivery });
    reply.catch(() => undefined);
    const onMessage = (from: SessionInfo, message: Message) => {
      const matched = waiter.receive(from.id, message);
      deps.client.sendMessageReceipt({ messageId: message.id, timestamp: Date.now(), status: matched ? "acknowledged" : "rejected", detail: matched ? "matched CLI reply waiter" : "CLI has no delivery path for this message" });
    };
    const onDisconnected = (error: Error) => waiter.reject(new Error(`Waiting interrupted: ${error.message}`));
    deps.client.on("message", onMessage);
    deps.client.on("disconnected", onDisconnected);
    let sendResult: SendResult | undefined;
    try {
      const result = await deps.client.send(target.id, { text: opts.text!, replyTo: opts.replyTo, target, messageId, expectsReply: true, signal: deps.signal }).catch(async (error: unknown): Promise<SendResult> => {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
        // Do not discard an answer that arrived before the send receipt was interrupted.
        await reply;
        return { id: messageId, targetId: target.id, delivered: false, delivery: "unknown", retryable: false, outcomeKnown: false, reason: error instanceof Error ? error.message : String(error) };
      });
      sendResult = result;
      lastDelivery = result.delivery;
      if (!result.delivered && result.delivery !== "unknown") waiter.reject(new Error(`delivery ${result.delivery}: ${result.reason ?? "unknown reason"}`));
      const answer = await reply;
      if (opts.json) out.write(`${JSON.stringify({ ok: true, messageId, targetId: target.id, from: target.id, text: answer.content.text, attachments: answer.content.attachments, replyMessageId: answer.id, outboundDelivery: result }, null, 2)}\n`);
      else out.write(`${answer.content.text}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reportFailure(message, message.startsWith("No reply from") ? 2 : 1, sendResult);
    } finally {
      waiter.reject(new Error("Waiting ended"));
      deps.client.off("message", onMessage);
      deps.client.off("disconnected", onDisconnected);
    }
  } catch (error) {
    return reportFailure(`intercom request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await deps.client.disconnect().catch(() => {});
  }
}

async function readProcessStdin(): Promise<string> {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

export async function runMain(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    return await runCli(argv, {
      client: new IntercomClient(), signal: controller.signal,
      machineName: config.crossMachine.machineName,
      crossMachineSend: (target, text, origin) => sendCrossMachine(target, text, origin, { remoteCommand: config.crossMachine.remoteCommand }),
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) process.exit(await runMain());
