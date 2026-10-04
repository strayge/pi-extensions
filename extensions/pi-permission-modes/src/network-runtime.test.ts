import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindPath } from "./paths.ts";
import { NetworkSession } from "./network.ts";
import { RuntimeCoordinator } from "./sandbox.ts";
import type { FilesystemSnapshot } from "./schema.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const supported =
  process.platform === "linux" &&
  existsSync("/usr/bin/bwrap") &&
  existsSync("/usr/bin/socat") &&
  existsSync("/usr/bin/curl");
test("native SOCKS DOMAINNAME requests cannot use alternate IPv4 spellings to bypass a deny", {
  skip: !supported && process.platform !== "darwin",
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "permission-socks-alias-"));
  let connections = 0;
  const server = createTcpServer((socket) => { connections++; socket.end("DENIED-ENDPOINT-REACHED"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const root = { family: randomUUID(), binding: bindPath(directory) };
  const snapshot: FilesystemSnapshot = { revision: 0, root, mode: "yolo", profile: { kind: "unrestricted", grants: [] }, rules: [], grants: [], exceptions: [] };
  const network = new NetworkSession({ default: "restricted", allowedDomains: ["127.1"], deniedDomains: ["127.0.0.1"] }, () => {});
  const requested: string[] = []; const runtime = new RuntimeCoordinator(); let output = "";
  const script = `
    const net = require('node:net'), assert = require('node:assert/strict');
    async function probe(host) {
      const proxy = new URL(process.env.ALL_PROXY);
      const socket = net.connect(Number(proxy.port), proxy.hostname);
      socket.setTimeout(3000, () => socket.destroy(new Error('SOCKS timeout')));
      const input = socket[Symbol.asyncIterator](); let buffer = Buffer.alloc(0);
      async function read(n) {
        while (buffer.length < n) { const {value,done} = await input.next(); if(done) throw new Error('SOCKS closed'); buffer = Buffer.concat([buffer,value]); }
        const result = buffer.subarray(0,n); buffer = buffer.subarray(n); return result;
      }
      try {
        socket.write(Buffer.from([5,1,2])); assert.deepEqual([...await read(2)], [5,2]);
        const user = Buffer.from(decodeURIComponent(proxy.username)), pass = Buffer.from(decodeURIComponent(proxy.password));
        socket.write(Buffer.concat([Buffer.from([1,user.length]), user, Buffer.from([pass.length]), pass]));
        assert.deepEqual([...await read(2)], [1,0]);
        const name = Buffer.from(host);
        socket.write(Buffer.concat([Buffer.from([5,1,0,3,name.length]),name,Buffer.from([${port >> 8},${port & 255}])]));
        const response = await read(2); assert.equal(response[0],5); assert.notEqual(response[1],0,'denied endpoint reached');
        console.log('DENIED',host);
      } finally { socket.destroy(); }
    }
    (async()=>{for(const host of ['127.1','0x7f000001','0177.0.0.1']) await probe(host)})().catch(error=>{console.error(error);process.exitCode=1});
  `;
  try {
    const result = await runtime.operations(snapshot, { id: root.family, network: () => network.snapshot(), decideHost: (host) => { requested.push(host); return network.decide(host); } }, () => {})
      .exec(`${quote(process.execPath)} -e ${quote(script)}`, directory, { timeout: 10, onData: (data) => { output += data; } });
    assert.equal(result.exitCode, 0, output);
    assert.deepEqual(requested, ["127.1", "0x7f000001", "0177.0.0.1"]);
    assert.equal(output.match(/DENIED /g)?.length, 3, output);
    assert.equal(connections, 0);
  } finally { await runtime.shutdown(root.family); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("network-only confinement follows live grant, deny, toggle, and reload without rerunning commands", {
  skip: !supported && process.platform !== "darwin",
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "permission-network-"));
  const secret = path.join(directory, "unrestricted-secret");
  writeFileSync(secret, "FS-UNRESTRICTED");
  const server = createServer((_request, response) => response.end("NETWORK-ALLOWED"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const root = { family: randomUUID(), binding: bindPath(directory) };
  const snapshot: FilesystemSnapshot = {
    revision: 0,
    root,
    mode: "custom-name",
    profile: { kind: "unrestricted", grants: [] },
    rules: [],
    grants: [],
    exceptions: [],
  };
  const network = new NetworkSession({ default: "restricted", allowedDomains: [], deniedDomains: [] }, () => {});
  let stage = 0;
  let output = "";
  const runtime = new RuntimeCoordinator();
  const family = {
    id: root.family,
    network: () => network.snapshot(),
    decideHost: (host: string) => network.decide(host),
  };
  try {
    const curl = `/usr/bin/curl -s --max-time 3 --noproxy '' --proxy "$HTTP_PROXY" http://127.0.0.1:${port}/`;
    const result = await runtime
      .operations(snapshot, family, () => {})
      .exec(`cat '${secret}'; ${[1, 2, 3, 4].map((step) => `${curl}; echo STEP-${step}; while [ ! -e stage-${step} ]; do sleep 0.01; done`).join("; ")}; ${curl}; echo END`, directory, {
        onData: (data) => {
          output += data;
          if (stage < 4 && output.includes(`STEP-${stage + 1}`)) {
            stage++;
            if (stage === 1) network.grant(["127.0.0.1"]);
            if (stage === 2) network.change({ deniedDomains: ["127.0.0.1"] });
            if (stage === 3) network.change({ restricted: false });
            if (stage === 4) network.reconfigure({ default: "restricted", allowedDomains: [], deniedDomains: ["127.0.0.1"] }, { default: "open", allowedDomains: [], deniedDomains: [] });
            writeFileSync(path.join(directory, `stage-${stage}`), "continue");
          }
        },
        timeout: 10,
      });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /FS-UNRESTRICTED/);
    assert.equal(stage, 4, output);
    assert.equal(output.split("NETWORK-ALLOWED").length - 1, 2, output);
    assert.ok(output.indexOf("NETWORK-ALLOWED") > output.indexOf("STEP-1"), output);
    assert.equal(output.split("FS-UNRESTRICTED").length - 1, 1, output);
  } finally {
    await runtime.shutdown(root.family);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
