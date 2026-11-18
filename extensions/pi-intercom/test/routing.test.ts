import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sendBroadcast } from "../src/broadcast.ts";
import { IntercomClient, type SendResult } from "../src/broker/client.ts";
import { createMessageReader, writeMessage } from "../src/broker/framing.ts";
import { getBrokerSocketPath } from "../src/broker/paths.ts";
import { isSessionRegistration } from "../src/broker/protocol.ts";
import { runCli } from "../src/cli.ts";
import {
  INTERCOM_EXTENSION_REGISTER_EVENT,
  INTERCOM_OUTBOX_REQUEST_EVENT,
  INTERCOM_OUTBOX_RESULT_EVENT,
  INTERCOM_SESSION_IDENTITY_EVENT,
  type IntercomExtensionChannel,
  type IntercomOutboxResultV1,
  type IntercomSessionIdentityRequestV1,
} from "../src/extension-api.ts";
import { initializeIntercomPool } from "../src/pool.ts";
import { ReplyWaiter } from "../src/reply-tracker.ts";
import type {
  Message,
  MessageReceiptStatus,
  SessionInfo,
  SessionRegistration,
} from "../src/types.ts";
import { ComposeOverlay } from "../src/ui/compose.ts";
import { HandoverPicker, type HandoverPickerResult } from "../src/ui/handover-picker.ts";

const registration = (name: string, cwd: string) => ({
  name,
  cwd,
  model: "test",
  pid: process.pid,
  startedAt: Date.now(),
  lastActivity: Date.now(),
});

function nextMessage(client: IntercomClient): Promise<[SessionInfo, Message]> {
  return once(client, "message", { signal: AbortSignal.timeout(3000) }) as Promise<
    [SessionInfo, Message]
  >;
}

function closeClientSocket(client: IntercomClient): void {
  const socket = (client as unknown as { socket: net.Socket | null }).socket;
  assert.ok(socket);
  socket.destroy();
}

test("handover picker keeps explicit local and remote selection without a project action", async () => {
  const current: SessionInfo = { ...registration("self", "/project"), id: "self", status: "idle" };
  const peer: SessionInfo = {
    ...registration("local peer", "/other/project"),
    id: "local-peer",
    endpointEpoch: "selected-endpoint",
    status: "idle",
  };
  const results: Array<HandoverPickerResult | undefined> = [];
  let fetched = 0;
  let remoteRendered = () => {};
  const remoteReady = new Promise<void>((resolve) => {
    remoteRendered = resolve;
  });
  let picker: HandoverPicker;
  const createPicker = (preselectSessionId?: string) =>
    new HandoverPicker(
      {
        requestRender: () => {
          if (picker.render(88).join("\n").includes("worker@remote")) remoteRendered();
        },
      } as ConstructorParameters<typeof HandoverPicker>[0],
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as ConstructorParameters<typeof HandoverPicker>[1],
      {
        matches: (data: string, key: string) => data === key,
        getKeys: () => [],
      } as unknown as ConstructorParameters<typeof HandoverPicker>[2],
      {
        currentSession: current,
        sessions: [current, peer],
        preselectSessionId,
        lister: {
          listMachines: async () => {
            fetched++;
            return [{ label: "remote", target: "host", enabled: true }];
          },
          listAgents: async () => [{ name: "worker", cwd: "/remote/project" }],
        },
      },
      (result) => results.push(result),
    );
  picker = createPicker(peer.id);
  picker.handleInput("continue the task");
  for (const width of [1, 2, 10, 30, 88]) {
    assert.ok(picker.render(width).every((line) => visibleWidth(line) <= width));
  }
  assert.doesNotMatch(picker.render(88).join("\n"), /New session|project path/);
  picker.handleInput("tui.select.confirm");
  assert.deepEqual(results[0], {
    target: { kind: "local", session: peer },
    goal: "continue the task",
  });
  assert.equal(fetched, 0);

  picker = createPicker();
  picker.handleInput("tui.select.down");
  picker.handleInput("tui.select.confirm");
  await remoteReady;
  assert.equal(fetched, 1, "fetch is the action immediately after local peers");
  for (const width of [1, 2, 10, 30, 88]) {
    assert.ok(picker.render(width).every((line) => visibleWidth(line) <= width));
  }
  picker.handleInput("tui.select.down");
  picker.handleInput("tui.select.confirm");
  assert.deepEqual(results[1], {
    target: { kind: "remote", target: "worker@remote" },
    goal: undefined,
  });
});

test("unified direct messaging keeps discovery scoped and routing identity-bound", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "intercom-direct-"));
  const previousEnv = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_RECEIPT_TIMEOUT_MS = "50";
  delete process.env.PI_INTERCOM_TRANSPORT;
  delete process.env.PI_INTERCOM_TCP;
  const clients: IntercomClient[] = [];
  const broker = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../src/broker/broker.ts", import.meta.url)),
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const closed = once(broker, "exit");
  let stderr = "";
  broker.stderr.on("data", (data) => {
    stderr += String(data);
  });
  t.after(async () => {
    await Promise.all(clients.map((client) => client.disconnect()));
    if (broker.exitCode === null && broker.signalCode === null) broker.kill();
    await closed;
    for (const key of [
      "PI_CODING_AGENT_DIR",
      "PI_INTERCOM_SCOPE_ID",
      "PI_INTERCOM_TRANSPORT",
      "PI_INTERCOM_TCP",
      "PI_INTERCOM_RECEIPT_TIMEOUT_MS",
    ]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    rmSync(agentDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Broker startup timed out: ${stderr}`)),
      10_000,
    );
    broker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    broker.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Broker exited: ${stderr}`));
    });
    let output = "";
    broker.stdout.on("data", (data) => {
      output += String(data);
      if (output.includes("Intercom broker started")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  async function connect(
    id: string,
    name: string,
    scope: string,
    onMessage?: (from: SessionInfo, message: Message) => void,
    cwd = agentDir,
    identity: Partial<SessionRegistration> = {},
  ): Promise<IntercomClient> {
    process.env.PI_INTERCOM_SCOPE_ID = scope;
    const client = new IntercomClient();
    clients.push(client);
    const retainedMessages: Message[] = [];
    client.on("message", (_from: SessionInfo, message: Message) => {
      retainedMessages.push(message);
      client.sendMessageReceipt({
        messageId: message.id,
        status: "accepted",
        timestamp: Date.now(),
        detail: "retained by test receiver",
      });
    });
    if (onMessage) client.on("message", onMessage);
    await client.connect(
      { ...registration(name, cwd), ...identity, acknowledgesReceipts: true },
      id,
    );
    return client;
  }

  const envA: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "surface-a" };
  const envB: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "surface-b" };
  await initializeIntercomPool(agentDir, envA, async () => "workspace-a");
  await initializeIntercomPool(agentDir, envB, async () => "workspace-b");
  const scopeA = envA.PI_INTERCOM_SCOPE_ID;
  const scopeB = envB.PI_INTERCOM_SCOPE_ID;
  assert.ok(scopeA);
  assert.ok(scopeB);
  const a = await connect("parent-a", "supervisor", scopeA);
  const b = await connect("parent-b", "supervisor", scopeB);
  const child = await connect("child-a", "child", scopeA);

  await t.test(
    "broadcast audiences are broker-scoped live top-level snapshots with exact fanout",
    async () => {
      const scope = "broadcast-pool";
      const metadata = (id: string): Partial<SessionRegistration> => ({
        role: "agent",
        canonicalSessionId: id,
      });
      const sender = await connect(
        "broadcast-sender",
        "sender",
        scope,
        undefined,
        agentDir,
        metadata("broadcast-sender"),
      );
      const mail = new Map<string, Message[]>();
      const makePeer = async (id: string, pool: string, identity = metadata(id)) => {
        const messages: Message[] = [];
        mail.set(id, messages);
        return connect(
          id,
          id,
          pool,
          (_from, message) => messages.push(message),
          agentDir,
          identity,
        );
      };
      const first = await makePeer("broadcast-first", scope);
      const second = await makePeer("broadcast-second", scope);
      const foreign = await makePeer("broadcast-foreign", "broadcast-other");
      const defaultPeer = await makePeer("broadcast-default", "");
      const senderChild = await makePeer("broadcast-child", scope, {
        ...metadata("broadcast-child"),
        parentSessionId: "broadcast-sender",
      });
      const otherChild = await makePeer("broadcast-other-child", "broadcast-other", {
        ...metadata("broadcast-other-child"),
        parentSessionId: "someone-else",
      });
      const transport = await makePeer("broadcast-cli", scope, { role: "transport" });
      const legacy = await makePeer("broadcast-unclassified", scope, {});
      const offline = await makePeer("broadcast-offline", scope);
      await offline.disconnect();
      const workspace = await sender.listSessions({ audience: "workspace" });
      assert.deepEqual(
        workspace.map((peer) => peer.id),
        ["broadcast-first", "broadcast-second"],
      );
      assert.ok(workspace.every((peer) => peer.endpointEpoch));
      assert.deepEqual(
        (await sender.listSessions({ audience: "global" })).map((peer) => peer.id).sort(),
        ["broadcast-default", "broadcast-first", "broadcast-foreign", "broadcast-second"],
      );
      assert.deepEqual(
        (await defaultPeer.listSessions({ audience: "workspace" })).map((peer) => peer.id),
        [],
      );
      assert.equal(
        (await sender.listSessions()).some((peer) => peer.id === "broadcast-foreign"),
        false,
      );
      assert.equal(await sender.resolveTarget("broadcast-fore"), null);
      assert.equal((await sender.resolveTarget("broadcast-foreign"))?.id, "broadcast-foreign");
      // Resolution follows the registered requester, not the last process environment value.
      process.env.PI_INTERCOM_SCOPE_ID = "unrelated-process-pool";
      assert.deepEqual(
        (await sender.listSessions({ audience: "workspace" })).map((peer) => peer.id),
        workspace.map((peer) => peer.id),
      );
      const late = await makePeer("broadcast-late", scope);
      const attachments = [{ type: "snippet" as const, name: "code", content: "x" }];
      const result = await sendBroadcast(sender, "workspace", workspace, {
        text: "snapshot",
        attachments,
      });
      assert.equal(result.ok, true);
      assert.equal(result.accepted, 2);
      assert.equal(
        new Set(
          result.recipients.map((recipient) => {
            assert.ok("id" in recipient);
            return recipient.id;
          }),
        ).size,
        2,
      );
      for (const recipient of result.recipients) {
        const messages = mail.get(recipient.targetId);
        assert.ok(messages);
        const received = messages[0];
        assert.ok(received);
        assert.ok("id" in recipient);
        assert.equal(received.id, recipient.id);
        assert.equal(received.quiet, true);
        assert.deepEqual(received.content.attachments, attachments);
      }
      assert.deepEqual(mail.get("broadcast-late"), []);
      assert.deepEqual(mail.get("broadcast-child"), []);
      assert.deepEqual(mail.get("broadcast-other-child"), []);
      const firstMail = mail.get("broadcast-first");
      assert.ok(firstMail);
      const original = firstMail[0];
      assert.ok(original);
      const answer = nextMessage(sender);
      await first.send("broadcast-sender", {
        text: "thread",
        replyTo: original.id,
      });
      const firstResult = result.recipients[0];
      assert.ok(firstResult);
      assert.ok("id" in firstResult);
      assert.equal((await answer)[1].replyTo, firstResult.id);
      const empty = await sendBroadcast(defaultPeer, "workspace", [], { text: "empty" });
      assert.equal(empty.ok, false);
      assert.equal(empty.total, 0);

      await second.disconnect({ moveToScopeId: "broadcast-moved" });
      const rebound = await makePeer("broadcast-second", "broadcast-moved");
      const partial = await sendBroadcast(sender, "workspace", workspace, {
        text: "stale snapshot",
        quiet: false,
      });
      assert.equal(partial.accepted, 1);
      assert.equal(partial.failed, 1);
      assert.equal(partial.ok, false);
      const reboundResult = partial.recipients[1];
      assert.ok(reboundResult);
      assert.ok("code" in reboundResult);
      assert.equal(reboundResult.code, "E_TARGET_REBOUND");
      const active = firstMail[1];
      assert.ok(active);
      assert.equal(active.quiet, false);
      assert.deepEqual(mail.get("broadcast-second"), []);

      const duplicateA = await makePeer("broadcast-duplicate", scope);
      const duplicateB = await connect(
        "broadcast-duplicate",
        "duplicate",
        "broadcast-other",
        undefined,
        agentDir,
        metadata("broadcast-duplicate"),
      );
      const duplicateSnapshot = (await sender.listSessions({ audience: "workspace" })).filter(
        (peer) => peer.id === "broadcast-duplicate",
      );
      const ambiguous = await sendBroadcast(sender, "workspace", duplicateSnapshot, {
        text: "ambiguous",
      });
      assert.equal(ambiguous.failed, 1);
      const ambiguousResult = ambiguous.recipients[0];
      assert.ok(ambiguousResult);
      assert.ok("code" in ambiguousResult);
      assert.equal(ambiguousResult.code, "E_AMBIGUOUS_TARGET");
      assert.deepEqual(mail.get("broadcast-duplicate"), []);
      for (const client of [
        sender,
        first,
        foreign,
        defaultPeer,
        senderChild,
        otherChild,
        transport,
        legacy,
        late,
        rebound,
        duplicateA,
        duplicateB,
      ])
        await client.disconnect();
    },
  );

  await t.test(
    "broadcast fanout preserves rejected and uncertain receipt outcomes and stops unsent entries on abort",
    async () => {
      const scope = "broadcast-receipts";
      const sender = await connect("fanout-sender", "sender", scope);
      const seen: string[] = [];
      const receivers: IntercomClient[] = [];
      for (const status of ["accepted", "rejected", "receiver_received"] as const) {
        process.env.PI_INTERCOM_SCOPE_ID = scope;
        const receiver = new IntercomClient();
        clients.push(receiver);
        receivers.push(receiver);
        receiver.on("message", (_from: SessionInfo, message: Message) => {
          seen.push(status);
          receiver.sendMessageReceipt({ messageId: message.id, status, timestamp: Date.now() });
        });
        await receiver.connect(
          { ...registration(status, agentDir), role: "agent", acknowledgesReceipts: true },
          `fanout-${status}`,
        );
      }
      const snapshot = await sender.listSessions({ audience: "workspace" });
      const partial = await sendBroadcast(sender, "workspace", snapshot, { text: "mixed" });
      assert.deepEqual(
        [partial.accepted, partial.failed, partial.unknown, partial.notAttempted],
        [1, 1, 1, 0],
      );
      assert.equal(partial.ok, false);
      const uncertainResult = partial.recipients[2];
      assert.ok(uncertainResult);
      assert.equal(uncertainResult.delivery, "unknown");
      assert.ok("outcomeKnown" in uncertainResult);
      assert.equal(uncertainResult.outcomeKnown, false);
      const controller = new AbortController();
      const firstReceiver = receivers[0];
      assert.ok(firstReceiver);
      firstReceiver.once("message", () => controller.abort());
      const interrupted = await sendBroadcast(sender, "workspace", snapshot, {
        text: "abort after acceptance",
        signal: controller.signal,
      });
      assert.equal(interrupted.interrupted, true);
      assert.deepEqual([interrupted.accepted, interrupted.notAttempted], [1, 2]);
      const unsent = interrupted.recipients[1];
      assert.ok(unsent);
      assert.equal(unsent.delivery, "not_attempted");
      assert.equal("id" in unsent, false);
      const before = await sendBroadcast(sender, "workspace", snapshot, {
        text: "already aborted",
        signal: controller.signal,
      });
      assert.equal(before.notAttempted, 3);
      assert.deepEqual(seen, ["accepted", "rejected", "receiver_received", "accepted"]);
      await sender.disconnect();
      for (const receiver of receivers) await receiver.disconnect();
    },
  );

  await t.test(
    "local names and prefixes do not advertise other pools; exact IDs cross them",
    async () => {
      assert.deepEqual((await child.listSessions()).map((s) => s.id).sort(), [
        "child-a",
        "parent-a",
      ]);
      for (const target of ["supervisor", "super", "parent-"]) {
        const received = nextMessage(a);
        assert.equal((await child.send(target, { text: "local discovery" })).delivered, true);
        assert.equal((await received)[1].content.text, "local discovery");
      }
      const received = nextMessage(b);
      const sent = await child.send("parent-b", { text: "exact cross-pool" });
      assert.equal(sent.delivered, true);
      assert.equal(sent.targetId, "parent-b");
      assert.equal((await received)[0].id, "child-a");
      const globalPool = await connect("default-pool", "default-pool", "");
      assert.deepEqual(
        (await globalPool.listSessions()).map((s) => s.id),
        ["default-pool"],
      );
      const exact = nextMessage(a);
      assert.equal(
        (await globalPool.send("parent-a", { text: "default pool is ordinary" })).delivered,
        true,
      );
      await exact;
      assert.equal(
        (await globalPool.send("supervisor", { text: "hidden name" })).code,
        "E_TARGET_NOT_FOUND",
      );
    },
  );

  await t.test(
    "parent resolves canonical launch ownership across routing IDs and pools",
    async () => {
      const parentMetadata = { role: "agent" as const, canonicalSessionId: "parent-canonical" };
      const workerMetadata = {
        role: "agent" as const,
        canonicalSessionId: "worker-canonical",
        parentSessionId: "parent-canonical",
      };
      const parent = await connect(
        "stable-parent-old",
        "parent",
        scopeB,
        undefined,
        agentDir,
        parentMetadata,
      );
      const worker = await connect(
        "stable-worker",
        "worker",
        scopeA,
        undefined,
        agentDir,
        workerMetadata,
      );
      assert.equal((await worker.resolveTarget("parent"))?.id, "stable-parent-old");
      assert.equal(
        (await worker.listSessions()).find((session) => session.id === "stable-worker")
          ?.parentSessionId,
        "parent-canonical",
      );
      const incoming = nextMessage(parent);
      assert.equal(
        (await worker.send("parent", { text: "direct parent" })).targetId,
        "stable-parent-old",
      );
      await incoming;
      await parent.disconnect();
      assert.equal((await worker.send("parent", { text: "retained parent" })).delivery, "queued");
      await assert.rejects(
        worker.send("parent", { text: "offline wait", expectsReply: true }),
        /disconnected.*live/,
      );
      const replacement = await connect(
        "stable-parent-current",
        "different label",
        scopeB,
        undefined,
        agentDir,
        parentMetadata,
      );
      assert.equal(
        (await worker.resolveTarget("parent", { requireLive: true }))?.id,
        "stable-parent-current",
      );
      const newMail: Message[] = [];
      replacement.on("message", (_from, message) => newMail.push(message));
      await replacement.listSessions();
      assert.equal(newMail.length, 0, "retained mail must not transfer to a new routing identity");
      const duplicate = await connect(
        "stable-parent-duplicate",
        "duplicate",
        scopeA,
        undefined,
        agentDir,
        parentMetadata,
      );
      await assert.rejects(
        worker.send("parent", { text: "ambiguous" }),
        /Ambiguous parent identity/,
      );
      await duplicate.disconnect();
      const missing = await connect(
        "missing-parent-worker",
        "parent-canonical",
        scopeA,
        undefined,
        agentDir,
        {
          ...workerMetadata,
          canonicalSessionId: "missing-worker",
          parentSessionId: "unknown-canonical",
        },
      );
      await assert.rejects(
        missing.send("parent", { text: "no guessing" }),
        /Parent identity.*unavailable/,
      );
      await assert.rejects(a.send("parent", { text: "root" }), /No current parent metadata/);
      const transport = await connect("transport-only", "cli", scopeA, undefined, agentDir, {
        role: "transport",
      });
      await assert.rejects(transport.send("parent", { text: "cli" }), /No current parent metadata/);
      for (const invalid of [
        { role: "agent", canonicalSessionId: "child", parentSessionId: "child" },
        { role: "agent", parentSessionId: "parent" },
        { role: "transport", canonicalSessionId: "cli", parentSessionId: "parent" },
        { role: "worker", canonicalSessionId: "child" },
        { role: "agent", canonicalSessionId: " " },
      ]) {
        assert.equal(
          isSessionRegistration({ ...registration("invalid", agentDir), ...invalid }),
          false,
        );
      }
    },
  );

  await t.test("explicit pool changes move only the same exact retained identity", async () => {
    const offline = await connect("move-mailbox", "move-mailbox", scopeA);
    await offline.disconnect();
    const moving = await connect("moving-peer", "moving", scopeA);
    const outbound = await moving.send("move-mailbox", { text: "cancel after moving" });
    assert.equal(outbound.delivery, "queued");
    await moving.disconnect({ moveToScopeId: "moved-pool" });
    assert.equal(
      (await child.send("moving-peer", { text: "same identity, new discovery pool" })).delivery,
      "queued",
    );
    const mail: Message[] = [];
    const resumed = await connect("moving-peer", "moving", "moved-pool", (_from, message) =>
      mail.push(message),
    );
    await resumed.listSessions();
    assert.equal(mail.length, 1);
    assert.equal((await child.resolveTarget("moving-peer"))?.id, "moving-peer");
    assert.equal(
      (await child.listSessions()).some((session) => session.id === "moving-peer"),
      false,
    );
    assert.equal((await resumed.cancelMessage(outbound.id)).delivered, true);
    const cancelledMail: Message[] = [];
    const recipient = await connect("move-mailbox", "move-mailbox", scopeA, (_from, message) =>
      cancelledMail.push(message),
    );
    await recipient.listSessions();
    assert.deepEqual(cancelledMail, []);
  });

  await t.test("ordinary sends accept threaded answers and preserve attachments", async () => {
    const inbound = nextMessage(b);
    const sent = await child.send("parent-b", {
      text: "ordinary question",
      attachments: [{ type: "snippet", name: "code", content: "x", language: "ts" }],
    });
    const [from, original] = await inbound;
    assert.equal(original.expectsReply, undefined);
    assert.equal(original.content.attachments?.[0]?.content, "x");
    const answer = nextMessage(child);
    assert.equal((await b.send(from.id, { text: "answer", replyTo: sent.id })).delivered, true);
    assert.equal((await answer)[1].replyTo, sent.id);
    const another = nextMessage(child);
    assert.equal(
      (await b.send(from.id, { text: "another answer", replyTo: sent.id })).delivered,
      true,
    );
    await another;
  });

  await t.test(
    "waits match the exact peer once; cleanup is not recipient cancellation",
    async () => {
      const waiter = new ReplyWaiter(1000);
      const ordinary: Message[] = [];
      const controls: string[] = [];
      const handler = (from: SessionInfo, message: Message) => {
        if (!waiter.receive(from.id, message)) ordinary.push(message);
      };
      child.on("message", handler);
      b.onMessageControl((_from, control) => controls.push(control.action));
      try {
        const target = await child.resolveTarget("parent-b", { requireLive: true });
        assert.ok(target?.endpointEpoch);
        const reply = waiter.wait(target.id, "wait-question", {
          onFinish: () => child.cancelAsk("wait-question"),
        });
        const request = nextMessage(b);
        assert.equal(
          (
            await child.send(target.id, {
              target,
              text: "wait",
              messageId: "wait-question",
              expectsReply: true,
            })
          ).delivered,
          true,
        );
        await request;
        await a.send("child-a", { text: "wrong peer", replyTo: "wait-question" });
        await child.listSessions();
        assert.equal(waiter.active, true);
        assert.equal(ordinary.length, 1);
        const reverse = await b.send("child-a", { text: "blocking loop", expectsReply: true });
        assert.equal(reverse.code, "E_MUTUAL_WAIT");
        const second = await child.send("parent-a", { text: "second wait", expectsReply: true });
        assert.equal(second.code, "E_ALREADY_WAITING");
        await b.send("child-a", { text: "clarification?", replyTo: "wait-question" });
        assert.equal((await reply).content.text, "clarification?");
        assert.equal(waiter.active, false);
        await b.send("child-a", { text: "later answer", replyTo: "wait-question" });
        await child.listSessions();
        assert.equal(ordinary.length, 2);
        assert.equal(ordinary[1]?.content.text, "later answer");
        const next = await b.send("child-a", { text: "guard was cleared", expectsReply: true });
        assert.equal(next.delivered, true);
        b.cancelAsk(next.id);
        await b.listSessions();

        for (const mode of ["abort", "timeout"] as const) {
          const messageId = `wait-${mode}`;
          const controller = new AbortController();
          const shortWaiter = new ReplyWaiter(mode === "timeout" ? 30 : 1000);
          const pending = shortWaiter.wait(target.id, messageId, {
            signal: controller.signal,
            onFinish: () => child.cancelAsk(messageId),
          });
          const rejected = assert.rejects(
            pending,
            mode === "abort" ? /Cancelled waiting/ : /No reply from/,
          );
          assert.equal(
            (await child.send(target.id, { target, text: mode, messageId, expectsReply: true }))
              .delivered,
            true,
          );
          if (mode === "abort") controller.abort();
          await rejected;
          await child.listSessions();
          const late = nextMessage(child);
          assert.equal(
            (await b.send("child-a", { text: "late", replyTo: messageId })).delivered,
            true,
          );
          await late;
          const guard = await b.send("child-a", { text: "no stale guard", expectsReply: true });
          assert.equal(guard.delivered, true);
          b.cancelAsk(guard.id);
          await b.listSessions();
        }
        assert.deepEqual(controls, []);
        assert.equal(existsSync(join(agentDir, "intercom", "pending-asks")), false);
      } finally {
        waiter.reject(new Error("test ended"));
        child.off("message", handler);
      }
    },
  );

  await t.test(
    "recipient reconnect, replacement, and pool moves retain incoming wait guards",
    async () => {
      for (const mode of ["reconnect", "replace", "pool-move"] as const) {
        const ownerId = `guard-owner-${mode}`;
        const recipientId = `guard-recipient-${mode}`;
        const owner = await connect(ownerId, ownerId, scopeA);
        const recipient = await connect(recipientId, recipientId, scopeB);
        const sent = await owner.send(recipientId, {
          text: "accepted blocking wait",
          expectsReply: true,
        });
        assert.equal(sent.delivered, true);
        const nextScope = mode === "pool-move" ? `guard-moved-${mode}` : scopeB;
        if (mode !== "replace")
          await recipient.disconnect(mode === "pool-move" ? { moveToScopeId: nextScope } : {});
        const resumed = await connect(recipientId, recipientId, nextScope);
        assert.equal(
          (await resumed.send(ownerId, { text: "reverse wait", expectsReply: true })).code,
          "E_MUTUAL_WAIT",
        );
        const thread = nextMessage(owner);
        assert.equal(
          (await resumed.send(ownerId, { text: "ordinary answer", replyTo: sent.id })).delivered,
          true,
        );
        await thread;
        owner.cancelAsk(sent.id);
        await owner.listSessions();
        const reverse = await resumed.send(ownerId, {
          text: "owner cleared wait",
          expectsReply: true,
        });
        assert.equal(reverse.delivered, true);
        resumed.cancelAsk(reverse.id);
        await resumed.listSessions();
        const again = await owner.send(recipientId, {
          text: "owner will disconnect",
          expectsReply: true,
        });
        assert.equal(again.delivered, true);
        await owner.disconnect();
        const reconnectedOwner = await connect(ownerId, ownerId, scopeA);
        const released = await resumed.send(ownerId, {
          text: "owner disconnect cleared wait",
          expectsReply: true,
        });
        assert.equal(released.delivered, true);
        resumed.cancelAsk(released.id);
        await resumed.listSessions();
        await reconnectedOwner.disconnect();
      }
    },
  );

  await t.test("offline exact mail never transfers to a same-name/cwd replacement", async () => {
    await b.disconnect();
    assert.equal(
      (await child.send("parent-b", { text: "offline", replyTo: "ordinary-earlier", quiet: true }))
        .delivery,
      "queued",
    );
    await assert.rejects(child.resolveTarget("parent-b", { requireLive: true }), /disconnected/);
    const replacementMail: Message[] = [];
    const replacement = await connect("replacement-b", "supervisor", scopeB, (_from, message) =>
      replacementMail.push(message),
    );
    await replacement.listSessions();
    assert.deepEqual(replacementMail, []);
    const resumedMail: Message[] = [];
    const resumed = await connect("parent-b", "supervisor", scopeB, (_from, message) =>
      resumedMail.push(message),
    );
    await resumed.listSessions();
    assert.equal(resumedMail.length, 1);
    assert.equal(resumedMail[0]?.replyTo, "ordinary-earlier");
    assert.equal(resumedMail[0]?.quiet, true);
    assert.equal(
      (await child.send("unknown-identity", { text: "no mailbox" })).code,
      "E_TARGET_NOT_FOUND",
    );
  });

  await t.test("unknown UUIDs, duplicate IDs, and reserved names cannot retarget", async () => {
    const unknown = "00000000-0000-4000-8000-000000000099";
    await connect("uuid-name-decoy", unknown, scopeA);
    assert.equal(
      (await child.send(unknown, { text: "not a display name" })).code,
      "E_TARGET_NOT_FOUND",
    );
    const duplicate = "00000000-0000-4000-8000-000000000001";
    await connect(duplicate, "one", scopeA);
    await connect(duplicate, "two", scopeB);
    await assert.rejects(child.send(duplicate, { text: "ambiguous" }), /Ambiguous/);
    const namedGlobal = await connect("reserved-name-peer", "global", scopeA);
    await assert.rejects(child.send("global", { text: "reserved" }), /Reserved/);
    assert.equal(
      (await child.send("glo", { text: "reserved display name prefix" })).code,
      "E_TARGET_NOT_FOUND",
    );
    const exact = nextMessage(namedGlobal);
    assert.equal(
      (await child.send("reserved-name-peer", { text: "reachable by id" })).delivered,
      true,
    );
    await exact;
    await assert.rejects(connect("parent", "invalid", scopeA), /Reserved routing ID/);
  });

  await t.test("a resolved endpoint never silently rebinds after reconnect", async () => {
    const original = await connect("rebound-peer", "rebound", scopeA);
    const target = await child.resolveTarget("rebound");
    assert.ok(target);
    await original.disconnect();
    const reboundMail: Message[] = [];
    const rebound = await connect("rebound-peer", "rebound", scopeA, (_from, message) =>
      reboundMail.push(message),
    );
    const failed = await child.send(target.id, { text: "stale endpoint", target });
    assert.equal(failed.code, "E_TARGET_REBOUND");
    let renders = 0;
    let finishRender = () => {};
    const composed = new Promise<void>((resolve) => {
      finishRender = resolve;
    });
    const overlay = new ComposeOverlay(
      {
        requestRender: () => {
          if (++renders === 2) finishRender();
        },
      } as ConstructorParameters<typeof ComposeOverlay>[0],
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as ConstructorParameters<typeof ComposeOverlay>[1],
      {
        matches: (data: string, key: string) => data === "\r" && key === "tui.select.confirm",
        getKeys: () => [],
      } as unknown as ConstructorParameters<typeof ComposeOverlay>[2],
      target,
      "rebound",
      child,
      () => assert.fail("A stale compose selection must not succeed"),
    );
    overlay.handleInput("selected before reconnect");
    renders = 0;
    overlay.handleInput("\r");
    await composed;
    assert.match(overlay.render(72).join("\n"), /Target endpoint changed before delivery/);
    const controller = new AbortController();
    const resolveTarget = child.resolveTarget.bind(child);
    child.resolveTarget = async (to, options) => {
      const resolved = await resolveTarget(to, options);
      controller.abort();
      return resolved;
    };
    try {
      await assert.rejects(
        child.send("rebound", { text: "aborted during resolution", signal: controller.signal }),
        /before dispatch/,
      );
    } finally {
      child.resolveTarget = resolveTarget;
    }
    await rebound.listSessions();
    assert.deepEqual(reboundMail, []);
  });

  await t.test("transport interruption preserves direct, CLI and fanout uncertainty", async () => {
    process.env.PI_INTERCOM_SCOPE_ID = scopeA;
    const receiver = new IntercomClient();
    clients.push(receiver);
    await receiver.connect(
      registration("interruption-receiver", agentDir),
      "interruption-receiver",
    );
    const received: Message[] = [];
    let sender!: IntercomClient;
    receiver.on("message", (_from: SessionInfo, message: Message) => {
      received.push(message);
      closeClientSocket(sender);
    });
    const peer = await child.resolveTarget("interruption-receiver");
    assert.ok(peer?.endpointEpoch);
    sender = await connect("interrupted-direct", "interrupted-direct", scopeA);
    const direct = await sender.send(peer.id, {
      target: peer,
      text: "direct",
      messageId: "original-send-id",
    });
    assert.equal(received[0]?.id, "original-send-id");
    assert.equal(direct.id, "original-send-id");
    assert.equal(direct.targetId, peer.id);
    assert.equal(direct.delivery, "unknown");
    assert.equal(direct.code, "E_SEND_INTERRUPTED");
    assert.equal(direct.outcomeKnown, false);
    assert.equal(direct.retryable, false);
    await assert.rejects(
      sender.send(peer.id, { target: peer, text: "not dispatched" }),
      /disconnected|Not connected/,
    );

    sender = new IntercomClient();
    clients.push(sender);
    let output = "";
    assert.equal(
      await runCli(["send", "--to", peer.id, "--text", "CLI", "--json"], {
        client: sender,
        out: {
          write: (text) => {
            output += text;
          },
        },
      }),
      1,
    );
    const cli = JSON.parse(output);
    assert.equal(cli.id, received[1]?.id);
    assert.equal(cli.targetId, peer.id);
    assert.equal(cli.delivery, "unknown");
    assert.equal(cli.code, "E_SEND_INTERRUPTED");
    assert.equal(cli.outcomeKnown, false);
    assert.equal(cli.retryable, false);

    sender = await connect("interrupted-broadcast", "interrupted-broadcast", scopeA);
    const other = await child.resolveTarget("parent-a");
    assert.ok(other?.endpointEpoch);
    const fanout = await sendBroadcast(sender, "workspace", [peer, other], { text: "fanout" });
    assert.equal(fanout.interrupted, true);
    assert.equal(fanout.unknown, 1);
    assert.equal(fanout.notAttempted, 1);
    assert.equal(received.length, 3);

    const cancelling = await connect("interrupted-cancel", "interrupted-cancel", scopeA);
    const cancellation = cancelling.cancelMessage("cancellation-is-not-a-send");
    closeClientSocket(cancelling);
    await assert.rejects(cancellation, /disconnected/);
    await receiver.disconnect();
  });

  await t.test("explicit cancellation and uncertain receipts remain distinct", async () => {
    const request = nextMessage(a);
    const sent = await child.send("parent-a", { text: "cancel explicitly" });
    await request;
    const control = once(a, "message_control", { signal: AbortSignal.timeout(3000) });
    assert.equal((await child.cancelMessage(sent.id)).delivered, true);
    assert.equal((await control)[1].action, "cancel");
    process.env.PI_INTERCOM_SCOPE_ID = scopeA;
    const silent = new IntercomClient();
    clients.push(silent);
    await silent.connect(
      { ...registration("silent", agentDir), acknowledgesReceipts: true },
      "silent-receiver",
    );
    const unknown = await child.send("silent-receiver", { text: "socket is not proof" });
    assert.equal(unknown.delivery, "unknown");
    assert.equal(unknown.outcomeKnown, false);
    assert.equal(unknown.code, "E_RECEIPT_TIMEOUT");
  });

  await t.test("late receiver failures cannot clear the owner's wait guard", async () => {
    for (const initial of ["queued", "unknown"] as const) {
      const ownerId = `late-failure-owner-${initial}`;
      const receiverId = `late-failure-receiver-${initial}`;
      const owner = await connect(ownerId, ownerId, scopeA);
      process.env.PI_INTERCOM_SCOPE_ID = scopeB;
      const receiver = new IntercomClient();
      clients.push(receiver);
      const retained: Message[] = [];
      receiver.on("message", (_from: SessionInfo, message: Message) => {
        retained.push(message);
        let status: MessageReceiptStatus = "accepted";
        if (message.expectsReply) {
          status = initial === "queued" ? "queued" : "receiver_received";
        }
        receiver.sendMessageReceipt({ messageId: message.id, status, timestamp: Date.now() });
      });
      await receiver.connect(registration(receiverId, agentDir), receiverId);
      const sent = await owner.send(receiverId, { text: "keep waiting", expectsReply: true });
      assert.equal(sent.delivered, initial === "queued");
      assert.equal(sent.delivery, initial === "queued" ? "socket_delivered" : "unknown");
      assert.equal(retained[0]?.id, sent.id);
      receiver.sendMessageReceipt({
        messageId: sent.id,
        status: initial === "queued" ? "expired" : "rejected",
        timestamp: Date.now(),
      });
      await receiver.listSessions();
      assert.equal(
        (await receiver.send(ownerId, { text: "reverse wait", expectsReply: true })).code,
        "E_MUTUAL_WAIT",
      );
      assert.equal(
        (await receiver.send(ownerId, { text: "ordinary thread", replyTo: sent.id })).delivered,
        true,
      );
      assert.equal(
        (await receiver.send(ownerId, { text: "still waiting", expectsReply: true })).code,
        "E_MUTUAL_WAIT",
      );
      owner.cancelAsk(sent.id);
      await owner.listSessions();
      const reverse = await receiver.send(ownerId, {
        text: "owner ended its wait",
        expectsReply: true,
      });
      assert.equal(reverse.delivered, true);
      receiver.cancelAsk(reverse.id);
      await receiver.listSessions();
    }
  });

  await t.test("acceptance needs a delivery path, not socket or transport receipt", async () => {
    process.env.PI_INTERCOM_SCOPE_ID = scopeA;
    const receiver = new IntercomClient();
    clients.push(receiver);
    await receiver.connect(registration("receiptless", agentDir), "receiptless");
    let received = 0;
    const retained: Message[] = [];
    let status: MessageReceiptStatus = "receiver_received";
    receiver.on("message", (_from: SessionInfo, message: Message) => {
      received++;
      if (status === "accepted") retained.push(message);
      receiver.sendMessageReceipt({ messageId: message.id, status, timestamp: Date.now() });
    });
    const unknown = await child.send("receiptless", { text: "not accepted", messageId: "unknown" });
    assert.equal(unknown.delivered, false);
    assert.equal(unknown.delivery, "unknown");
    assert.equal(unknown.retryable, false);
    assert.equal(unknown.outcomeKnown, false);
    assert.equal(
      (await child.send("receiptless", { text: "not accepted", messageId: "unknown" })).delivery,
      "unknown",
    );
    assert.equal(received, 1);
    for (const failure of ["failed", "rejected", "unsupported", "expired"] as const) {
      status = failure;
      const result = await child.send("receiptless", { text: failure, messageId: failure });
      assert.equal(result.delivery, "failed");
      assert.equal(result.outcomeKnown, true);
      assert.equal(result.code, `E_RECEIVER_${failure.toUpperCase()}`);
      status = "accepted";
      const replay = await child.send("receiptless", { text: failure, messageId: failure });
      assert.equal(replay.delivered, false);
      assert.equal(replay.code, result.code);
    }
    status = "accepted";
    const quiet = await child.send("receiptless", {
      text: "informational",
      quiet: true,
      messageId: "quiet-fingerprint",
    });
    assert.equal(quiet.delivered, true);
    assert.equal(
      (
        await child.send("receiptless", {
          text: "informational",
          quiet: false,
          messageId: quiet.id,
        })
      ).code,
      "E_MESSAGE_ID_REUSE",
    );
    await assert.rejects(
      child.send("receiptless", { text: "invalid", quiet: true, expectsReply: true }),
      /wait: true cannot be combined/,
    );
    assert.equal(received, 6);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.quiet, true);
  });

  await t.test(
    "a real CLI waiter accepts its first correlated answer before disconnecting",
    async () => {
      process.env.PI_INTERCOM_SCOPE_ID = scopeA;
      const cliClient = new IntercomClient();
      clients.push(cliClient);
      let output = "";
      const incoming = nextMessage(a);
      const waiting = runCli(
        ["send", "--to", "parent-a", "--text", "CLI question", "--wait", "--json"],
        {
          client: cliClient,
          out: {
            write: (text) => {
              output += text;
            },
          },
        },
      );
      const [from, request] = await incoming;
      const answer = await a.send(from.id, { text: "CLI answer", replyTo: request.id });
      assert.equal(answer.delivered, true);
      assert.equal(await waiting, 0);
      assert.equal(JSON.parse(output).text, "CLI answer");
    },
  );

  await t.test(
    "extension entry waits beyond an unknown receipt and preserves outbox/bus sends",
    { timeout: 10_000 },
    async (st) => {
      const previousTimeout = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
      process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "2000";
      st.after(() => {
        if (previousTimeout === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
        else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previousTimeout;
      });
      st.mock.method(globalThis, "fetch", () => {
        throw new Error("Network forbidden in the sender SDK fixture");
      });
      mkdirSync(join(agentDir, "intercom"), { recursive: true });
      writeFileSync(
        join(agentDir, "intercom", "config.json"),
        JSON.stringify({ confirmSend: true }),
      );
      const sdk = await import("@earendil-works/pi-coding-agent");
      const { getModel } = await import("@earendil-works/pi-ai/compat");
      const { default: intercom } = await import("../src/index.ts");
      const modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(agentDir, "fixture-auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      await modelRuntime.setRuntimeApiKey("openai", "fixture-only");
      const model = getModel("openai", "gpt-4o");
      assert.ok(model);
      const eventBus = sdk.createEventBus();
      const senderManager = sdk.SessionManager.inMemory(agentDir);
      let identityFailure: "conflicting" | "invalid" | undefined;
      eventBus.on(INTERCOM_SESSION_IDENTITY_EVENT, (payload) => {
        const request = payload as IntercomSessionIdentityRequestV1;
        if (request.sessionId !== senderManager.getSessionId()) return;
        request.claim("entry-sender", { parentSessionId: "entry-parent-canonical" });
        if (identityFailure === "conflicting") {
          request.claim("wrong-routing-id", { parentSessionId: "wrong-parent" });
        } else if (identityFailure === "invalid") {
          request.claim("entry-sender", { parentSessionId: request.sessionId });
        }
      });
      const settingsManager = sdk.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: agentDir,
        agentDir,
        settingsManager,
        eventBus,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [intercom],
        systemPrompt: "Isolated sender fixture; no model calls.",
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const { session } = await sdk.createAgentSession({
        cwd: agentDir,
        agentDir,
        model,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: senderManager,
        tools: ["intercom"],
      });
      st.after(async () => {
        try {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          session.dispose();
        }
      });
      session.agent.streamFunction = () => {
        throw new Error("A sender-only fixture must not start a model turn");
      };
      process.env.PI_INTERCOM_SCOPE_ID = scopeB;
      const receiver = new IntercomClient();
      clients.push(receiver);
      await receiver.connect(
        {
          ...registration("entry-receiver", agentDir),
          role: "agent",
          canonicalSessionId: "entry-parent-canonical",
          acknowledgesReceipts: true,
        },
        "entry-receiver",
      );
      process.env.PI_INTERCOM_SCOPE_ID = scopeA;
      const startupErrors: string[] = [];
      const confirmations: string[] = [];
      let confirm: () => Promise<boolean> = async () => true;
      await session.bindExtensions({
        mode: "tui",
        uiContext: {
          ...session.extensionRunner.createContext().ui,
          confirm: async (_title, text) => {
            confirmations.push(text);
            return confirm();
          },
        },
        onError: (error) => startupErrors.push(error.error),
      });
      const tool = session.agent.state.tools.find((candidate) => candidate.name === "intercom");
      assert.ok(tool);
      const originalSend = IntercomClient.prototype.send;
      let observeUnknown: (result: SendResult) => void = () => {};
      const unknown = new Promise<SendResult>((resolve) => {
        observeUnknown = resolve;
      });
      let senderDispatches = 0;
      let entryClient: IntercomClient | undefined;
      st.mock.method(
        IntercomClient.prototype,
        "send",
        async function (
          this: IntercomClient,
          to: string,
          options: Parameters<IntercomClient["send"]>[1],
        ) {
          if (this.sessionId === "entry-sender") {
            entryClient = this;
            if (options.expectsReply) senderDispatches++;
          }
          const result = await originalSend.call(this, to, options);
          if (
            this.sessionId === "entry-sender" &&
            options.expectsReply &&
            result.delivery === "unknown"
          )
            observeUnknown(result);
          return result;
        },
      );
      const incoming = nextMessage(receiver);
      let settled = false;
      const waiting = tool
        .execute("entry-wait", {
          action: "send",
          to: "parent",
          message: "question",
          wait: true,
        })
        .then((result) => {
          settled = true;
          return result;
        });
      const [, request] = await incoming;
      assert.equal((await unknown).outcomeKnown, false);
      assert.equal(settled, false);
      assert.equal(
        (
          await receiver.send("entry-sender", {
            text: "answer after unknown receipt",
            replyTo: request.id,
          })
        ).delivered,
        true,
      );
      const answered = await waiting;
      assert.ok(JSON.stringify(answered.content).includes("answer after unknown receipt"));
      assert.equal(answered.details.outboundDelivery.delivery, "unknown");
      assert.equal(answered.details.outboundDelivery.outcomeKnown, false);
      assert.equal(senderDispatches, 1);

      receiver.on("message", (_from: SessionInfo, message: Message) =>
        receiver.sendMessageReceipt({
          messageId: message.id,
          status: "acknowledged",
          timestamp: Date.now(),
        }),
      );
      const parentMail = nextMessage(receiver);
      const parentSend = await tool.execute("entry-parent", {
        action: "send",
        to: "parent",
        message: "nonwaiting parent",
      });
      assert.equal(parentSend.details.targetId, "entry-receiver");
      assert.equal((await parentMail)[1].content.text, "nonwaiting parent");
      for (const options of [
        { cwd: agentDir },
        { openProjectPaneIfMissing: false },
        { focus: false },
      ]) {
        const rejected = await tool.execute("entry-parent-invalid", {
          action: "send",
          to: "parent",
          message: "invalid",
          ...options,
        });
        assert.equal(rejected.details.error, true);
        assert.match(
          JSON.stringify(rejected.content),
          /Directory targeting is no longer supported/,
        );
      }
      const outboxResult = new Promise<IntercomOutboxResultV1>((resolve) => {
        eventBus.on(INTERCOM_OUTBOX_RESULT_EVENT, (payload) => {
          const result = payload as IntercomOutboxResultV1;
          if (result.requestId === "entry-outbox") resolve(result);
        });
      });
      const outboxMail = nextMessage(receiver);
      eventBus.emit(INTERCOM_OUTBOX_REQUEST_EVENT, {
        version: 1,
        requestId: "entry-outbox",
        extensionId: "fixture",
        extensionName: "Fixture",
        to: "entry-receiver",
        message: "outbox preserved",
      });
      assert.equal((await outboxResult).status, "sent");
      assert.equal((await outboxMail)[1].provenance?.requestId, "entry-outbox");
      let receiveBusMessage: (payload: unknown) => void = () => {};
      const busMessage = new Promise<unknown>((resolve) => {
        receiveBusMessage = resolve;
      });
      const channel = await new Promise<IntercomExtensionChannel>((resolve) => {
        eventBus.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
          namespace: "sender-fixture",
          ownerEligible: true,
          onReady: resolve,
          onEvent: (event: { type: string; payload?: unknown }) => {
            if (event.type === "message") receiveBusMessage(event.payload);
          },
        });
      });
      channel.publish({ preserved: true }, { audience: "capable" });
      assert.deepEqual(await busMessage, { preserved: true });

      await st.test("subagent result relay rejects a replaced resolved endpoint", async (rt) => {
        const replacementMail: Message[] = [];
        const originalPeer = await connect("entry-relay-target", "relay-target", scopeA);
        let replacement: IntercomClient | undefined;
        let resolutions = 0;
        const originalResolve = IntercomClient.prototype.resolveTarget;
        rt.mock.method(
          IntercomClient.prototype,
          "resolveTarget",
          async function (
            this: IntercomClient,
            to: string,
            options: Parameters<IntercomClient["resolveTarget"]>[1],
          ) {
            const peer = await originalResolve.call(this, to, options);
            if (this.sessionId === "entry-sender" && to === "entry-relay-target") {
              resolutions++;
              if (resolutions === 1) {
                assert.ok(peer?.endpointEpoch);
                await originalPeer.disconnect();
                replacement = await connect(
                  "entry-relay-target",
                  "relay-target",
                  scopeA,
                  (_from, message) => replacementMail.push(message),
                );
                const current = await originalResolve.call(this, to, options);
                assert.ok(current?.endpointEpoch);
                assert.notEqual(current.endpointEpoch, peer.endpointEpoch);
              }
            }
            return peer;
          },
        );
        let unsubscribe = () => {};
        const delivery = new Promise<{ delivered: boolean; error?: string }>((resolve) => {
          unsubscribe = eventBus.on("subagent:result-intercom-delivery", (payload) => {
            const result = payload as { requestId: string; delivered: boolean; error?: string };
            if (result.requestId === "entry-relay-rebound") resolve(result);
          });
        });
        try {
          eventBus.emit("subagent:result-intercom", {
            to: "entry-relay-target",
            message: "must not adopt the replacement endpoint",
            requestId: "entry-relay-rebound",
          });
          const result = await delivery;
          assert.equal(result.delivered, false);
          assert.match(result.error ?? "", /Target endpoint changed before delivery/);
          assert.equal(resolutions, 1);
          assert.ok(replacement);
          await replacement.listSessions();
          assert.deepEqual(replacementMail, []);
        } finally {
          unsubscribe();
          await originalPeer.disconnect();
          await replacement?.disconnect();
        }
      });

      await st.test("intercom-id shows the full target without editing the prompt", async () => {
        const previousUI = session.extensionRunner.getUIContext();
        const notices: string[] = [];
        let editorText = "Unsent draft";
        session.extensionRunner.setUIContext(
          {
            ...previousUI,
            notify: (message) => notices.push(message),
            getEditorText: () => editorText,
            setEditorText: (text) => {
              editorText = text;
            },
          },
          "tui",
        );
        try {
          const command = session.extensionRunner.getCommand("intercom-id");
          assert.ok(command);
          await command.handler("", session.extensionRunner.createCommandContext());
          assert.deepEqual(notices, ["Intercom contact target: entry-sender"]);
          assert.equal(editorText, "Unsent draft");
        } finally {
          session.extensionRunner.setUIContext(previousUI, "tui");
        }
      });

      await st.test(
        "path handovers reject before opening generation or calling the model",
        async (ht) => {
          const previousUI = session.extensionRunner.getUIContext();
          const notices: string[] = [];
          const context = session.extensionRunner.createCommandContext();
          const generation = ht.mock.method(context.modelRegistry, "streamSimple", () => {
            throw new Error("Path handovers must not call the model");
          });
          let dialogs = 0;
          session.extensionRunner.setUIContext(
            {
              ...previousUI,
              notify: (message) => notices.push(message),
              custom: async () => {
                dialogs++;
                throw new Error("Path handovers must not open generation");
              },
            },
            "tui",
          );
          try {
            const command = session.extensionRunner.getCommand("handover");
            assert.ok(command);
            for (const path of [
              "/project",
              "./project",
              "../project",
              "~/project",
              ".",
              "..",
              "C:\\project",
              ".\\project",
            ]) {
              await command.handler(
                `${path} next task`,
                session.extensionRunner.createCommandContext(),
              );
              assert.match(notices.at(-1) ?? "", /Use intercom list.*peer recipient/);
            }
            assert.equal(dialogs, 0);
            assert.equal(generation.mock.callCount(), 0);
            session.extensionRunner.setUIContext(
              {
                ...previousUI,
                custom: async <T>() => {
                  dialogs++;
                  return null as T;
                },
              },
              "tui",
            );
            await command.handler(
              "review/api next task",
              session.extensionRunner.createCommandContext(),
            );
            assert.equal(dialogs, 1, "a slash in a peer name must not imply directory targeting");
            assert.equal(generation.mock.callCount(), 0);
          } finally {
            generation.mock.restore();
            session.extensionRunner.setUIContext(previousUI, "tui");
          }
        },
      );

      await st.test("picker handover pins its endpoint through editing", async (ht) => {
        const originalPeer = await connect("entry-handover-target", "handover-target", scopeA);
        const selected = await child.resolveTarget("entry-handover-target");
        assert.ok(selected?.endpointEpoch);
        const previousUI = session.extensionRunner.getUIContext();
        let dialogs = 0;
        let replacement: IntercomClient | undefined;
        const replacementMail: Message[] = [];
        let attempted: SendResult | undefined;
        const send = IntercomClient.prototype.send;
        ht.mock.method(
          IntercomClient.prototype,
          "send",
          async function (
            this: IntercomClient,
            to: string,
            options: Parameters<IntercomClient["send"]>[1],
          ) {
            if (to === selected.id) assert.equal(options.target, selected);
            const result = await send.call(this, to, options);
            if (to === selected.id) attempted = result;
            return result;
          },
        );
        session.extensionRunner.setUIContext(
          {
            ...previousUI,
            custom: async <T>() => {
              dialogs++;
              return (
                dialogs === 1
                  ? { target: { kind: "local", session: selected } }
                  : { text: "generated handover" }
              ) as T;
            },
            editor: async (_title, text) => {
              await originalPeer.disconnect();
              replacement = await connect(
                "entry-handover-target",
                "handover-target",
                scopeA,
                (_from, message) => replacementMail.push(message),
              );
              return text;
            },
          },
          "tui",
        );
        try {
          const command = session.extensionRunner.getCommand("handover");
          assert.ok(command);
          await command.handler("", session.extensionRunner.createCommandContext());
          assert.equal(dialogs, 2);
          assert.equal(attempted?.code, "E_TARGET_REBOUND");
          assert.ok(replacement);
          await replacement.listSessions();
          assert.deepEqual(replacementMail, []);
        } finally {
          session.extensionRunner.setUIContext(previousUI, "tui");
          await originalPeer.disconnect();
          await replacement?.disconnect();
        }
      });

      await st.test("tool/outbox distinguish uncertainty from pre-dispatch failure", async () => {
        process.env.PI_INTERCOM_SCOPE_ID = scopeA;
        const uncertainPeer = new IntercomClient();
        clients.push(uncertainPeer);
        await uncertainPeer.connect(registration("entry-uncertain", agentDir), "entry-uncertain");
        const mail: Message[] = [];
        uncertainPeer.on("message", (_from: SessionInfo, message: Message) => {
          mail.push(message);
          if (message.content.text === "interrupt tool") {
            assert.ok(entryClient);
            closeClientSocket(entryClient);
          }
        });
        const interrupted = await tool.execute("entry-interrupted", {
          action: "send",
          to: "entry-uncertain",
          message: "interrupt tool",
        });
        assert.equal(interrupted.details.messageId, mail[0]?.id);
        assert.equal(interrupted.details.targetId, "entry-uncertain");
        assert.equal(interrupted.details.delivery, "unknown");
        assert.equal(interrupted.details.code, "E_SEND_INTERRUPTED");
        assert.equal(interrupted.details.outcomeKnown, false);
        assert.equal(interrupted.details.retryable, false);
        assert.match(JSON.stringify(interrupted.content), /could not be confirmed/);

        function requestOutbox(requestId: string): Promise<IntercomOutboxResultV1> {
          const result = new Promise<IntercomOutboxResultV1>((resolve) => {
            const unsubscribe = eventBus.on(INTERCOM_OUTBOX_RESULT_EVENT, (payload) => {
              const result = payload as IntercomOutboxResultV1;
              if (result.requestId === requestId) {
                unsubscribe();
                resolve(result);
              }
            });
          });
          eventBus.emit(INTERCOM_OUTBOX_REQUEST_EVENT, {
            version: 1,
            requestId,
            extensionId: "fixture",
            extensionName: "Fixture",
            to: "entry-uncertain",
            message: requestId,
          });
          return result;
        }
        const unknown = await requestOutbox("entry-outbox-unknown");
        assert.equal(unknown.status, "failed");
        assert.equal(unknown.code, "delivery_unknown");
        assert.equal(unknown.delivery, "unknown");
        assert.equal(unknown.messageId, "entry-outbox-unknown");
        assert.equal(unknown.targetId, "entry-uncertain");
        assert.equal(unknown.outcomeKnown, false);
        assert.equal(unknown.retryable, false);
        confirm = async () => false;
        const cancelled = await requestOutbox("entry-outbox-before-dispatch");
        assert.equal(cancelled.status, "rejected");
        assert.equal(cancelled.code, "user_cancelled");
        assert.equal(cancelled.delivery, undefined);
        assert.equal(mail.length, 2);
        confirm = async () => true;

        const incoming = nextMessage(uncertainPeer);
        const pending = requestOutbox("entry-outbox-replaced");
        const [, dispatched] = await incoming;
        assert.equal(dispatched.id, "entry-outbox-replaced");
        await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
        const replaced = await pending;
        assert.equal(replaced.status, "failed");
        assert.equal(replaced.code, "delivery_unknown");
        assert.equal(replaced.delivery, "unknown");
        assert.equal(replaced.messageId, dispatched.id);
        assert.equal(replaced.targetId, "entry-uncertain");
        assert.equal(replaced.outcomeKnown, false);
        assert.equal(replaced.retryable, false);
        assert.equal(mail.length, 3);
        await uncertainPeer.disconnect();
      });

      const connectionAttempts: Array<{ registration: SessionRegistration; id?: string }> = [];
      const originalConnect = IntercomClient.prototype.connect;
      st.mock.method(
        IntercomClient.prototype,
        "connect",
        function (this: IntercomClient, registration: SessionRegistration, id?: string) {
          connectionAttempts.push({ registration, id });
          return originalConnect.call(this, registration, id);
        },
      );
      for (const failure of ["conflicting", "invalid"] as const) {
        identityFailure = failure;
        senderManager.newSession();
        await session.extensionRunner.emit({ type: "session_start", reason: "new" });
        assert.match(startupErrors.at(-1) ?? "", /Conflicting.*claims|Invalid.*parent/);
        const status = await tool.execute("identity-failed-status", { action: "status" });
        assert.equal(status.details.error, true);
        assert.match(JSON.stringify(status.content), /runtime not initialized/);
        assert.equal(connectionAttempts.length, 0, "failed identity must not attempt registration");
      }
      identityFailure = undefined;
      await session.extensionRunner.emit({ type: "session_start", reason: "new" });
      assert.equal(connectionAttempts.length, 1);
      assert.equal(connectionAttempts[0]?.id, "entry-sender");
      assert.equal(
        connectionAttempts[0]?.registration.canonicalSessionId,
        senderManager.getSessionId(),
      );
      assert.equal(connectionAttempts[0]?.registration.parentSessionId, "entry-parent-canonical");
      const recovered = await tool.execute("identity-recovered-status", { action: "status" });
      assert.notEqual(recovered.details.error, true);

      const broadcastMail: Message[] = [];
      const first = await connect(
        "entry-broadcast-first",
        "first",
        scopeA,
        (_from, message) => broadcastMail.push(message),
        agentDir,
        { role: "agent" },
      );
      const second = await connect(
        "entry-broadcast-second",
        "second",
        scopeA,
        (_from, message) => broadcastMail.push(message),
        agentDir,
        { role: "agent" },
      );
      const originalList = IntercomClient.prototype.listSessions;
      let audienceRequests = 0;
      st.mock.method(
        IntercomClient.prototype,
        "listSessions",
        function (this: IntercomClient, options: Parameters<IntercomClient["listSessions"]>[0]) {
          if (this.sessionId === "entry-sender" && options?.audience) audienceRequests++;
          return originalList.call(this, options);
        },
      );
      const confirmationsBefore = confirmations.length;
      let late: IntercomClient | undefined;
      confirm = async () => {
        late = await connect(
          "entry-broadcast-late",
          "late",
          scopeA,
          (_from, message) => broadcastMail.push(message),
          agentDir,
          { role: "agent" },
        );
        return true;
      };
      const broadcast = await tool.execute("entry-broadcast", {
        action: "send",
        to: "workspace",
        message: "confirmed snapshot",
      });
      assert.equal(broadcast.details.delivered, true);
      assert.equal(broadcast.details.total, 2);
      assert.equal(audienceRequests, 1);
      assert.equal(confirmations.length, confirmationsBefore + 1);
      assert.match(confirmations.at(-1) ?? "", /workspace.*2 recipients/);
      assert.match(confirmations.at(-1) ?? "", /entry-broadcast-first/);
      assert.match(confirmations.at(-1) ?? "", /entry-broadcast-second/);
      assert.equal(broadcastMail.length, 2);
      assert.ok(broadcastMail.every((message) => message.quiet));
      confirm = async () => false;
      const declined = await tool.execute("entry-broadcast-declined", {
        action: "send",
        to: "workspace",
        message: "declined",
      });
      assert.equal(declined.details.cancelled, true);
      assert.equal(broadcastMail.length, 2);
      const controller = new AbortController();
      confirm = async () => {
        controller.abort();
        return true;
      };
      const aborted = await tool.execute(
        "entry-broadcast-aborted",
        { action: "send", to: "workspace", message: "aborted" },
        controller.signal,
      );
      assert.equal(aborted.details.notAttempted, 3);
      assert.equal(aborted.details.interrupted, true);
      assert.equal(aborted.details.delivered, false);
      assert.equal(broadcastMail.length, 2);
      const requestsBefore = audienceRequests;
      const promptsBefore = confirmations.length;
      for (const options of [
        { wait: true },
        { replyTo: "earlier" },
        { cwd: agentDir },
        { openProjectPaneIfMissing: false },
        { focus: false },
      ]) {
        const rejected = await tool.execute("entry-broadcast-invalid", {
          action: "send",
          to: "global",
          message: "invalid",
          ...options,
        });
        assert.equal(rejected.details.error, true);
      }
      const handover = await tool.execute("entry-group-handover", {
        action: "handover",
        to: "workspace",
      });
      assert.equal(handover.details.error, true);
      assert.match(JSON.stringify(handover.content), /direct recipient/);
      const alreadyAborted = await tool.execute(
        "entry-broadcast-before-abort",
        { action: "send", to: "workspace", message: "no prompt" },
        controller.signal,
      );
      assert.equal(alreadyAborted.details.error, true);
      assert.equal(audienceRequests, requestsBefore);
      assert.equal(confirmations.length, promptsBefore);
      assert.equal(broadcastMail.length, 2);
      for (const peer of [first, second, late]) await peer?.disconnect();
    },
  );

  await t.test("legacy receiver registration cannot silently accept unified sends", async () => {
    const socket = net.connect(getBrokerSocketPath());
    const frames: Record<string, unknown>[] = [];
    socket.on(
      "data",
      createMessageReader(
        (frame) => frames.push(frame as Record<string, unknown>),
        (error) => {
          socket.destroy();
          assert.fail(error);
        },
      ),
    );
    t.after(() => socket.destroy());
    await once(socket, "connect");
    writeMessage(socket, {
      type: "register",
      sessionId: "legacy",
      scopeId: scopeA,
      session: registration("legacy", agentDir),
    });
    // A list request on this socket is a deterministic registration barrier.
    const listed = new Promise<void>((resolve, reject) => {
      const reader = createMessageReader(
        (frame) => {
          if ((frame as { type?: string }).type === "sessions") resolve();
        },
        (error) => {
          socket.destroy();
          reject(error);
        },
      );
      socket.on("data", reader);
    });
    writeMessage(socket, { type: "list", requestId: "barrier" });
    await listed;
    assert.equal(frames[0]?.type, "registered");
    const result = await child.send("legacy", { text: "must upgrade receiver" });
    assert.equal(result.code, "E_INCOMPATIBLE_RECEIVER");
    const failure = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on(
        "data",
        createMessageReader(
          (frame) => {
            if ((frame as { type?: string }).type === "delivery_failed")
              resolve(frame as Record<string, unknown>);
          },
          (error) => {
            socket.destroy();
            reject(error);
          },
        ),
      );
    });
    writeMessage(socket, {
      type: "send",
      to: "child-a",
      message: { id: "legacy-send", timestamp: Date.now(), content: { text: "old semantics" } },
    });
    assert.equal((await failure).code, "E_INCOMPATIBLE_CLIENT");
  });
});
