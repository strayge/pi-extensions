import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import { RuntimeCoordinator } from "./sandbox.ts";
import type { FilesystemSnapshot } from "./schema.ts";

const supported = process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/socat");
test("real bubblewrap confines full-RW roots and preserves final restrictions through ancestor moves", {
  skip: !supported,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-runtime-"));
  const project = path.join(dir, "project");
  mkdirSync(project);
  mkdirSync(path.join(project, "nested"));
  const outside = path.join(dir, "outside");
  writeFileSync(outside, "outside-secret");
  const protectedFile = path.join(project, "nested", "secret");
  writeFileSync(protectedFile, "credential-secret");
  const config = defaultConfig();
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
  config.modes.subproject = config.modes.project!;
  config.pathRules = [{ path: protectedFile, scope: "file", read: "deny", write: "deny" }];
  const root = { family: randomUUID(), binding: bindPath(project) };
  const catalog = resolveCatalog(config, root, { agentDir: dir, home: dir });
  const snapshot: FilesystemSnapshot = {
    revision: 0,
    root,
    mode: "project",
    profile: catalog.profiles.project!,
    rules: catalog.rules,
    grants: [],
    exceptions: [],
  };
  const runtime = new RuntimeCoordinator();
  const family = {
    id: root.family,
    network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }),
    decideHost: async () => false,
  };
  let output = "";
  try {
    const command = `echo yes > .env; mkdir child; echo sibling > nested/ok; mv nested/ok nested/renamed; rm nested/renamed; cat '${outside}'; cat nested/secret; mv nested replaced; echo finish`;
    const result = await runtime
      .operations(snapshot, family, () => {})
      .exec(command, project, {
        onData: (data) => {
          output += data;
        },
      });
    assert.equal(result.exitCode, 0, output);
    assert.equal(readFileSync(path.join(project, ".env"), "utf8").trim(), "yes");
    assert.ok(!output.includes("outside-secret"), output);
    assert.ok(!output.includes("credential-secret"), output);
    assert.ok(existsSync(protectedFile), output);
    assert.ok(existsSync(path.join(project, "child")), output);
    console.log(`bubblewrap gate filesystem type: ${statfsSync(project).type.toString(16)}`);
  } finally {
    await runtime.shutdown(root.family);
    rmSync(dir, { recursive: true, force: true });
  }
});
