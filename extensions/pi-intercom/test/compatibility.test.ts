import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IntercomClient } from "../src/broker/client.ts";
import { createMessageReader, writeMessage } from "../src/broker/framing.ts";
import { ensureIntercomRuntimeDir, getBrokerSocketPath } from "../src/broker/paths.ts";
import { isSessionRegistration } from "../src/broker/protocol.ts";
import { UNIFIED_MESSAGING_FEATURE } from "../src/types.ts";

const registration = {
  cwd: "/test",
  model: "test",
  pid: process.pid,
  startedAt: 1,
  lastActivity: 1,
};

test("registration feature lists are validated", () => {
  assert.equal(
    isSessionRegistration({ ...registration, features: [UNIFIED_MESSAGING_FEATURE] }),
    true,
  );
  assert.equal(isSessionRegistration({ ...registration, features: [1] }), false);
  assert.equal(isSessionRegistration({ ...registration, features: "legacy" }), false);
});

test("new clients reject an old broker without restarting or falling back", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "intercom-legacy-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousTransport = process.env.PI_INTERCOM_TRANSPORT;
  const previousTcp = process.env.PI_INTERCOM_TCP;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_INTERCOM_TRANSPORT;
  delete process.env.PI_INTERCOM_TCP;
  ensureIntercomRuntimeDir();
  let registrations = 0;
  let features = ["exact-send-v1"];
  const listRequests: Record<string, unknown>[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on(
      "data",
      createMessageReader(
        (frame) => {
          const message = frame as Record<string, unknown>;
          switch (message.type) {
            case "register":
              registrations++;
              writeMessage(socket, {
                type: "registered",
                sessionId: "legacy-id",
                features,
              });
              break;
            case "list":
              listRequests.push(message);
              assert.equal(
                "audience" in message,
                false,
                "unsupported audience must not reach the broker",
              );
              assert.equal(typeof message.requestId, "string");
              writeMessage(socket, {
                type: "sessions",
                requestId: message.requestId,
                sessions: [],
              });
              break;
            case "unregister":
              break;
            default:
              assert.fail(`Unexpected client frame: ${String(message.type)}`);
          }
        },
        (error) => {
          socket.destroy();
          assert.fail(error);
        },
      ),
    );
  });
  const client = new IntercomClient();
  t.after(async () => {
    await client.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousTransport === undefined) delete process.env.PI_INTERCOM_TRANSPORT;
    else process.env.PI_INTERCOM_TRANSPORT = previousTransport;
    if (previousTcp === undefined) delete process.env.PI_INTERCOM_TCP;
    else process.env.PI_INTERCOM_TCP = previousTcp;
    rmSync(agentDir, { recursive: true, force: true });
  });
  server.listen(getBrokerSocketPath());
  await once(server, "listening");
  await assert.rejects(client.connect(registration), /Upgrade clients and broker together/);
  assert.equal(registrations, 1);
  assert.equal(client.isConnected(), false);
  assert.equal(server.listening, true);
  features = [UNIFIED_MESSAGING_FEATURE];
  await client.connect(registration);
  await assert.rejects(client.listSessions({ audience: "global" }), /Broadcast audience.*upgrade/);
  assert.deepEqual(await client.listSessions(), []);
  assert.equal(listRequests.length, 1, "only the ordinary list barrier may reach the broker");
  assert.equal(registrations, 2, "one register frame per connection, without restart or fallback");
});
