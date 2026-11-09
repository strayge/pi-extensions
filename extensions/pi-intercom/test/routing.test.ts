import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { IntercomClient } from "../src/broker/client.ts";
import { initializeIntercomPool } from "../src/pool.ts";

test("workspace pools isolate roster and routing; global opt-in requires both peers", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "intercom-pool-"));
  const previousEnv = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agentDir;
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

  async function connect(id: string, name: string, scope: string): Promise<IntercomClient> {
    process.env.PI_INTERCOM_SCOPE_ID = scope;
    const client = new IntercomClient();
    clients.push(client);
    await client.connect(
      {
        name,
        cwd: agentDir,
        model: "test",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      },
      id,
    );
    return client;
  }

  const envA: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "surface-a" };
  const envB: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "surface-b" };
  await initializeIntercomPool(agentDir, envA, async () => "workspace-a");
  await initializeIntercomPool(agentDir, envB, async () => "workspace-b");
  assert.ok(envA.PI_INTERCOM_SCOPE_ID);
  assert.ok(envB.PI_INTERCOM_SCOPE_ID);
  const supervisor = await connect("parent-a", "supervisor", envA.PI_INTERCOM_SCOPE_ID);
  await connect("parent-b", "supervisor", envB.PI_INTERCOM_SCOPE_ID);
  const child = await connect("child-a", "child", envA.PI_INTERCOM_SCOPE_ID);
  assert.deepEqual((await child.listSessions()).map((s) => s.id).sort(), ["child-a", "parent-a"]);
  const received = once(supervisor, "message");
  assert.equal((await child.send("supervisor", { text: "correct parent" })).delivered, true);
  const [, message] = await received;
  assert.equal(message.content.text, "correct parent");
  assert.equal((await child.send("parent-b", { text: "must not cross pools" })).delivered, false);

  const globalA = await connect("global-a", "global-a", "");
  assert.deepEqual(
    (await globalA.listSessions()).map((s) => s.id),
    ["global-a"],
  );
  assert.equal((await globalA.send("parent-a", { text: "still isolated" })).delivered, false);
  const globalB = await connect("global-b", "global-b", "");
  const globalReceived = once(globalB, "message");
  assert.equal((await globalA.send("global-b", { text: "shared global pool" })).delivered, true);
  await globalReceived;
});
