import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { IntercomClient, SendResult } from "../src/broker/client.ts";
import { buildCliRegistration, type CliClient, parseCliArgs, runCli } from "../src/cli.ts";
import { parseCrossMachineTarget } from "../src/cross-machine-discovery.ts";
import type { Message, SessionInfo } from "../src/types.ts";

const peer: SessionInfo = {
  id: "exact-peer",
  endpointEpoch: "endpoint",
  name: "worker",
  cwd: "/test",
  model: "test",
  pid: 1,
  startedAt: 1,
  lastActivity: 1,
};

class FakeClient extends EventEmitter implements CliClient {
  sessionId = "cli";
  sends: Array<{ to: string; options: Parameters<IntercomClient["send"]>[1] }> = [];
  cleared: string[] = [];
  receipts: Array<Parameters<IntercomClient["sendMessageReceipt"]>[0]> = [];
  disconnected = false;
  delivery: SendResult["delivery"] = "socket_delivered";
  sendError?: Error;
  target: SessionInfo | null = peer;
  roster: SessionInfo[] = [peer];
  lists: Array<Parameters<IntercomClient["listSessions"]>[0]> = [];
  onSend?: (options: Parameters<IntercomClient["send"]>[1]) => void;
  isConnected(): boolean {
    return !this.disconnected;
  }
  async connect(): Promise<void> {}
  async listSessions(
    options?: Parameters<IntercomClient["listSessions"]>[0],
  ): Promise<SessionInfo[]> {
    this.lists.push(options);
    return this.roster;
  }
  async resolveTarget(): Promise<SessionInfo | null> {
    return this.target;
  }
  async send(to: string, options: Parameters<IntercomClient["send"]>[1]): Promise<SendResult> {
    this.sends.push({ to, options });
    this.onSend?.(options);
    if (this.sendError) throw this.sendError;
    return {
      id: options.messageId ?? "sent-id",
      targetId: to,
      delivered: this.delivery === "socket_delivered" || this.delivery === "queued",
      delivery: this.delivery,
      retryable: false,
      outcomeKnown: this.delivery !== "unknown",
    };
  }
  sendMessageReceipt(receipt: Parameters<IntercomClient["sendMessageReceipt"]>[0]): void {
    this.receipts.push(receipt);
  }
  cancelAsk(messageId: string): void {
    this.cleared.push(messageId);
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

function output() {
  let text = "";
  return {
    write: (chunk: string) => {
      text += chunk;
    },
    text: () => text,
  };
}

function response(replyTo: string, text: string): Message {
  return { id: text, timestamp: 1, replyTo, content: { text } };
}

test("CLI is transport-only and built-in destinations cannot route over SSH", () => {
  assert.equal(buildCliRegistration("cli").role, "transport");
  assert.equal(buildCliRegistration("cli").parentSessionId, undefined);
  for (const destination of ["parent", "workspace", "global"])
    assert.throws(
      () => parseCrossMachineTarget(`${destination}@remote`),
      /does not support SSH routing/,
    );
});

test("CLI clean break exposes send --wait and explicit threading", () => {
  assert.equal(parseCliArgs(["send", "--to", "worker", "--text", "hello"]).wait, false);
  const options = parseCliArgs([
    "send",
    "--to",
    "worker",
    "--text",
    "hello",
    "--wait",
    "--reply-to",
    "old",
    "--timeout-ms",
    "250",
  ]);
  assert.equal(options.wait, true);
  assert.equal(options.replyTo, "old");
  assert.equal(options.timeoutMs, 250);
  for (const action of ["ask", "reply", "pending"])
    assert.throws(() => parseCliArgs([action]), /unknown command/);
  assert.throws(() => parseCliArgs(["list", "--wait"]), /require send/);
});

test("CLI pins the exact peer and installs correlation before an immediate reply", async () => {
  const client = new FakeClient();
  const out = output();
  client.onSend = (options) => {
    assert.equal(options.target, peer);
    assert.equal(options.expectsReply, true);
    const messageId = options.messageId;
    assert.ok(messageId);
    client.emit("message", { ...peer, id: "wrong-peer" }, response(messageId, "wrong identity"));
    client.emit("message", peer, response(messageId, "clarification?"));
    client.emit("message", peer, response(messageId, "second response"));
  };
  assert.equal(
    await runCli(["send", "--to", "worker", "--text", "question", "--wait", "--json"], {
      client,
      out,
    }),
    0,
  );
  const result = JSON.parse(out.text());
  assert.equal(result.from, peer.id);
  assert.equal(result.text, "clarification?");
  assert.equal(client.sends[0]?.to, peer.id);
  assert.deepEqual(client.cleared, [client.sends[0]?.options.messageId]);
  assert.deepEqual(
    client.receipts.map((receipt) => receipt.status),
    ["rejected", "acknowledged", "rejected"],
  );
  assert.equal(client.listenerCount("message"), 0);
  assert.equal(client.disconnected, true);
});

test("CLI consumes the first quiet correlated response once as its wait result", async () => {
  const client = new FakeClient();
  const out = output();
  client.onSend = (options) => {
    const messageId = options.messageId;
    assert.ok(messageId);
    client.emit(
      "message",
      { ...peer, id: "wrong-peer" },
      {
        ...response(messageId, "wrong quiet peer"),
        quiet: true,
      },
    );
    client.emit("message", peer, { ...response(messageId, "quiet answer"), quiet: true });
    client.emit("message", peer, { ...response(messageId, "later quiet answer"), quiet: true });
  };
  assert.equal(
    await runCli(["send", "--to", "worker", "--text", "question", "--wait", "--json"], {
      client,
      out,
    }),
    0,
  );
  assert.equal(JSON.parse(out.text()).text, "quiet answer");
  assert.equal(client.sends.length, 1);
  assert.equal(client.cleared.length, 1);
  assert.deepEqual(
    client.receipts.map((receipt) => receipt.status),
    ["rejected", "acknowledged", "rejected"],
  );
  assert.equal(client.listenerCount("message"), 0);
});

test("an immediate answer is not discarded when its send receipt is unknown or interrupted", async () => {
  for (const interrupted of [false, true]) {
    const client = new FakeClient();
    client.delivery = "unknown";
    if (interrupted) client.sendError = new Error("connection closed after answer");
    client.onSend = (options) => {
      const messageId = options.messageId;
      assert.ok(messageId);
      client.emit("message", peer, response(messageId, "answer arrived"));
    };
    const out = output();
    assert.equal(
      await runCli(["send", "--to", "worker", "--text", "question", "--wait", "--json"], {
        client,
        out,
      }),
      0,
    );
    const result = JSON.parse(out.text());
    assert.equal(result.text, "answer arrived");
    assert.equal(result.outboundDelivery.delivery, "unknown");
    assert.equal(client.cleared.length, 1);
  }
});

test("CLI keeps waiting when an answer arrives after an unknown send receipt", async () => {
  const client = new FakeClient();
  client.delivery = "unknown";
  client.onSend = (options) => {
    const messageId = options.messageId;
    assert.ok(messageId);
    setImmediate(() => client.emit("message", peer, response(messageId, "answer after receipt")));
  };
  const out = output();
  assert.equal(
    await runCli(["send", "--to", "worker", "--text", "question", "--wait", "--json"], {
      client,
      out,
    }),
    0,
  );
  const result = JSON.parse(out.text());
  assert.equal(result.text, "answer after receipt");
  assert.equal(result.outboundDelivery.delivery, "unknown");
  assert.equal(result.outboundDelivery.outcomeKnown, false);
  assert.equal(client.sends.length, 1);
  assert.equal(client.cleared.length, 1);
});

test("CLI sends ordinary threaded answers without waiting or recipient inference", async () => {
  const client = new FakeClient();
  const out = output();
  assert.equal(
    await runCli(
      ["send", "--to", "exact-peer", "--text", "answer", "--reply-to", "ordinary", "--json"],
      { client, out },
    ),
    0,
  );
  assert.equal(client.sends[0]?.options.replyTo, "ordinary");
  assert.equal(client.sends[0]?.options.expectsReply, undefined);
  assert.equal(JSON.parse(out.text()).targetId, peer.id);
});

test("CLI timeout and cancellation clear only waiting, and offline peers are not dispatched", async () => {
  const timed = new FakeClient();
  timed.delivery = "unknown";
  const err = output();
  assert.equal(
    await runCli(["send", "--to", "worker", "--text", "question", "--wait", "--timeout-ms", "10"], {
      client: timed,
      err,
    }),
    2,
  );
  assert.match(err.text(), /recipient message was not cancelled/);
  assert.equal(timed.cleared.length, 1);
  const aborted = new FakeClient();
  aborted.delivery = "unknown";
  const controller = new AbortController();
  aborted.onSend = () => setImmediate(() => controller.abort());
  assert.equal(
    await runCli(["send", "--to", "worker", "--text", "question", "--wait"], {
      client: aborted,
      signal: controller.signal,
      err: output(),
    }),
    1,
  );
  assert.equal(aborted.cleared.length, 1);
  const offline = new FakeClient();
  offline.target = { ...peer, endpointEpoch: undefined };
  assert.equal(
    await runCli(["send", "--to", "worker", "--text", "question", "--wait"], {
      client: offline,
      err: output(),
    }),
    1,
  );
  assert.deepEqual(offline.sends, []);
  const before = new FakeClient();
  assert.equal(
    await runCli(["send", "--to", "worker", "--text", "question", "--wait"], {
      client: before,
      signal: controller.signal,
      err: output(),
    }),
    1,
  );
  assert.deepEqual(before.sends, []);
});

test("CLI disconnection interrupts rather than recreating a wait", async () => {
  const client = new FakeClient();
  const err = output();
  client.delivery = "unknown";
  client.onSend = () => setImmediate(() => client.emit("disconnected", new Error("socket closed")));
  assert.equal(
    await runCli(["send", "--to", "worker", "--text", "question", "--wait"], { client, err }),
    1,
  );
  assert.match(err.text(), /Waiting interrupted/);
  assert.equal(client.sends.length, 1);
  assert.equal(client.cleared.length, 1);
});

test("quiet CLI delivery is explicit and invalid combinations never dispatch", async () => {
  const client = new FakeClient();
  assert.equal(
    await runCli(["send", "--to", "worker", "--text", "info", "--quiet"], {
      client,
      out: output(),
    }),
    0,
  );
  assert.equal(client.sends[0]?.options.quiet, true);
  assert.equal(parseCliArgs(["send", "--to", "worker", "--text", "active"]).quiet, false);
  assert.equal(
    parseCliArgs(["send", "--to", "worker", "--text", "active", "--active"]).quiet,
    false,
  );
  for (const flags of [
    ["--wait", "--quiet"],
    ["--quiet", "--active"],
  ]) {
    const invalid = new FakeClient();
    assert.equal(
      await runCli(["send", "--to", "worker", "--text", "invalid", ...flags], {
        client: invalid,
        err: output(),
      }),
      1,
    );
    assert.equal(invalid.disconnected, false);
    assert.deepEqual(invalid.sends, []);
  }
  const remote = new FakeClient();
  assert.equal(
    await runCli(["send", "--to", "worker@remote", "--text", "info", "--quiet"], {
      client: remote,
      err: output(),
    }),
    1,
  );
  assert.equal(remote.disconnected, false);
  assert.deepEqual(remote.sends, []);
});

test("CLI delivery modes come only from consumed flags, never option values", () => {
  for (const destination of ["workspace", "global"]) {
    const base = ["send", "--to", destination];
    const literal = parseCliArgs([...base, "--text", "--active"]);
    assert.equal(literal.text, "--active");
    assert.equal(literal.quiet, true);
    assert.equal(parseCliArgs([...base, "--text", "info", "--name", "--active"]).quiet, true);
    assert.equal(parseCliArgs([...base, "--text", "--active", "--quiet"]).quiet, true);
    assert.equal(
      parseCliArgs([...base, "--text", "--quiet", "--name", "--active", "--active"]).quiet,
      false,
    );
    for (const flags of [
      ["--quiet", "--active"],
      ["--active", "--quiet"],
    ]) {
      assert.throws(() => parseCliArgs([...base, "--text", "info", ...flags]), /Choose either/);
    }
  }
  assert.equal(parseCliArgs(["list", "--name", "--active"]).quiet, false);
  assert.throws(() => parseCliArgs(["list", "--active"]), /require send/);
});

test("CLI broadcasts default quiet, snapshot once, and report partial or empty delivery without blanket success", async () => {
  for (const destination of ["workspace", "global"] as const) {
    assert.equal(parseCliArgs(["send", "--to", destination, "--text", "info"]).quiet, true);
    for (const flags of [[], ["--active"], ["--quiet"]]) {
      const client = new FakeClient();
      client.roster = [peer, { ...peer, id: "second-peer", endpointEpoch: "second-endpoint" }];
      const out = output();
      assert.equal(
        await runCli(["send", "--to", destination, "--text", "info", "--json", ...flags], {
          client,
          out,
        }),
        0,
      );
      assert.deepEqual(client.lists, [{ audience: destination }]);
      assert.equal(client.sends.length, 2);
      assert.equal(client.sends[0]?.options.quiet, !flags.includes("--active"));
      assert.equal(client.sends[0]?.options.target, peer);
      assert.equal(client.sends[1]?.options.target?.endpointEpoch, "second-endpoint");
      const result = JSON.parse(out.text());
      assert.equal(result.ok, true);
      assert.equal(result.accepted, 2);
      assert.notEqual(result.recipients[0].id, result.recipients[1].id);
      assert.equal(client.disconnected, true);
    }
  }
  const partial = new FakeClient();
  partial.roster = [peer, { ...peer, id: "second" }];
  partial.onSend = () => {
    partial.delivery = partial.sends.length === 1 ? "queued" : "failed";
  };
  const out = output();
  assert.equal(
    await runCli(["send", "--to", "workspace", "--text", "mixed", "--json"], {
      client: partial,
      out,
    }),
    1,
  );
  assert.equal(JSON.parse(out.text()).ok, false);
  assert.equal(JSON.parse(out.text()).queued, 1);
  assert.equal(JSON.parse(out.text()).failed, 1);
  const empty = new FakeClient();
  empty.roster = [];
  const text = output();
  assert.equal(
    await runCli(["send", "--to", "workspace", "--text", "empty"], { client: empty, out: text }),
    1,
  );
  assert.match(text.text(), /zero recipients; no messages dispatched/);
  assert.deepEqual(empty.sends, []);
});

test("a fanout socket rejection is unknown, while later snapshot entries remain not attempted", async () => {
  const client = new FakeClient();
  client.roster = [peer, { ...peer, id: "second" }, { ...peer, id: "third" }];
  client.onSend = () => {
    if (client.sends.length === 2) client.sendError = new Error("socket closed after write");
  };
  const out = output();
  assert.equal(
    await runCli(["send", "--to", "global", "--text", "info", "--json"], { client, out }),
    1,
  );
  const result = JSON.parse(out.text());
  assert.equal(result.interrupted, true);
  assert.deepEqual([result.accepted, result.unknown, result.notAttempted], [1, 1, 1]);
  assert.equal(result.recipients[1].outcomeKnown, false);
  assert.equal(typeof result.recipients[1].id, "string");
  assert.equal(result.recipients[2].id, undefined);
  assert.equal(client.sends.length, 2);

  const disconnected = new FakeClient();
  disconnected.roster = client.roster;
  disconnected.onSend = () => {
    disconnected.disconnected = true;
  };
  const known = output();
  assert.equal(
    await runCli(["send", "--to", "global", "--text", "info", "--json"], {
      client: disconnected,
      out: known,
    }),
    1,
  );
  const knownResult = JSON.parse(known.text());
  assert.deepEqual(
    [knownResult.accepted, knownResult.unknown, knownResult.notAttempted],
    [1, 0, 2],
  );
  assert.equal(disconnected.sends.length, 1);
});

test("invalid CLI broadcasts and SSH relay group targets never dispatch", async () => {
  for (const destination of ["workspace", "global"]) {
    for (const flags of [["--wait"], ["--wait", "--active"], ["--reply-to", "old"]]) {
      const client = new FakeClient();
      const err = output();
      assert.equal(
        await runCli(["send", "--to", destination, "--text", "invalid", ...flags], { client, err }),
        1,
      );
      assert.match(err.text(), /Broadcasts do not support/);
      assert.deepEqual(client.lists, []);
      assert.deepEqual(client.sends, []);
      assert.equal(client.disconnected, false);
    }
    const client = new FakeClient();
    assert.equal(
      await runCli(["send", "--to", `${destination}@remote`, "--text", "invalid"], {
        client,
        err: output(),
      }),
      1,
    );
    assert.deepEqual(client.sends, []);
    const relay = new FakeClient();
    const err = output();
    assert.equal(
      await runCli(["relay", "--envelope-stdin"], {
        client: relay,
        err,
        readStdin: async () =>
          JSON.stringify({
            version: 1,
            target: destination,
            text: "invalid",
            trust: "ssh-asserted",
            origin: { name: "sender", sessionId: "remote-id", machine: "remote" },
          }),
      }),
      1,
    );
    assert.match(err.text(), /not a broadcast/);
    assert.deepEqual(relay.sends, []);
    assert.equal(relay.disconnected, false);
  }
});

test("unsupported cross-machine waiting fails before connecting or sending", async () => {
  const client = new FakeClient();
  const err = output();
  assert.equal(
    await runCli(["send", "--to", "worker@remote", "--text", "question", "--wait"], {
      client,
      err,
    }),
    1,
  );
  assert.match(err.text(), /do not support/);
  assert.deepEqual(client.sends, []);
});
