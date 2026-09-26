import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindPath } from "./paths.ts";
import { RuntimeCoordinator } from "./sandbox.ts";
import type { FilesystemSnapshot } from "./schema.ts";

const supported =
  process.platform === "linux" &&
  existsSync("/usr/bin/bwrap") &&
  existsSync("/usr/bin/socat") &&
  existsSync("/usr/bin/curl");
test("unrestricted filesystem still filters live connections and never re-runs the command", {
  skip: !supported,
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
  let allow = false;
  let output = "";
  const runtime = new RuntimeCoordinator();
  const family = {
    id: root.family,
    network: () => ({ revision: Number(allow), restricted: true, allowedDomains: [], deniedDomains: [] }),
    decideHost: async () => allow,
  };
  try {
    const curl = `/usr/bin/curl -s --max-time 3 --noproxy '' --proxy "$HTTP_PROXY" http://127.0.0.1:${port}/`;
    const result = await runtime
      .operations(snapshot, family, () => {})
      .exec(`cat '${secret}'; ${curl}; echo FIRST-DONE; sleep 0.2; ${curl}; echo END`, directory, {
        onData: (data) => {
          output += data;
          if (output.includes("FIRST-DONE")) allow = true;
        },
        timeout: 10,
      });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /FS-UNRESTRICTED/);
    assert.equal(output.split("NETWORK-ALLOWED").length - 1, 1, output);
    assert.ok(output.indexOf("NETWORK-ALLOWED") > output.indexOf("FIRST-DONE"), output);
    assert.equal(output.split("FS-UNRESTRICTED").length - 1, 1, output);
  } finally {
    await runtime.shutdown(root.family);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
