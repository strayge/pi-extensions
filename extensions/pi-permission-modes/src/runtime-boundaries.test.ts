import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import { RuntimeCoordinator } from "./sandbox.ts";
import type { FilesystemSnapshot } from "./schema.ts";

const supported = process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/socat");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
test("runtime baseline admits exact Node, preserves read-only roots, and masks future and overlapping rules", {
  skip: !supported && process.platform !== "darwin",
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-boundary-"));
  const project = path.join(dir, "project");
  const ro = path.join(dir, "readonly");
  const agentDir = path.join(dir, "agent");
  mkdirSync(agentDir);
  mkdirSync(path.join(project, "one", "two"), { recursive: true });
  mkdirSync(ro);
  writeFileSync(path.join(ro, "data"), "READONLY");
  writeFileSync(path.join(dir, "outside"), "HIDDEN");
  const config = defaultConfig();
  config.modes.project!.filesystem = {
    kind: "scoped",
    readOnly: [ro],
    readWrite: ["."],
    resourceReads: ["pi", "system"],
  };
  config.modes.subproject = config.modes.project!;
  config.pathRules = [
    { path: "one/two/future", scope: "file", read: "deny" },
    { path: "one/two/hidden", scope: "tree", read: "deny" },
    { path: "one/two/hidden/key", scope: "file", write: "deny" },
  ];
  mkdirSync(path.join(project, "one", "two", "hidden"));
  writeFileSync(path.join(project, "one", "two", "hidden", "key"), "NO-REOPEN");
  const root = { family: randomUUID(), binding: bindPath(project) };
  const catalog = resolveCatalog(config, root, { agentDir, home: dir, piPackage: getPackageDir() });
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
  let output = "";
  try {
    const script = `const fs=require('fs'); console.log('NODE-BASELINE'); try { console.log(fs.readFileSync(${JSON.stringify(path.join(dir, "outside"))}, 'utf8')) } catch { console.log('OUTSIDE-DENIED') }`;
    const npm = path.join(path.dirname(process.execPath), "npm");
    const checkNpm = process.platform === "darwin" && existsSync(npm);
    const npmCommand = checkNpm ? `${quote(npm)} --version && echo NPM-BASELINE; ` : "";
    const command = `${quote(process.execPath)} -e ${quote(script)}; ${npmCommand}cat ${quote(path.join(ro, "data"))}; echo BAD > ${quote(path.join(ro, "data"))}; echo BAD > one/two/future; cat one/two/hidden/key; mv one moved; mkdir sibling; echo OK > one/two/sibling; echo DONE`;
    const result = await runtime
      .operations(
        snapshot,
        {
          id: root.family,
          network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }),
          decideHost: async () => false,
        },
        () => {},
      )
      .exec(command, project, {
        onData: (data) => {
          output += data;
        },
      });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /^NODE-BASELINE$/m);
    assert.match(output, /^OUTSIDE-DENIED$/m);
    if (checkNpm) assert.match(output, /^NPM-BASELINE$/m);
    assert.match(output, /READONLY/);
    assert.doesNotMatch(output, /HIDDEN|NO-REOPEN/);
    assert.equal(readFileSync(path.join(ro, "data"), "utf8"), "READONLY");
    assert.equal(readFileSync(path.join(project, "one", "two", "sibling"), "utf8").trim(), "OK");
    assert.ok(!existsSync(path.join(project, "one", "two", "future")), "owned future mountpoint must be cleaned up");
  } finally {
    await runtime.shutdown(root.family);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frozen descriptor mounts survive final-path replacement and write denials never grant outside reads", { skip: !supported }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-fd-boundary-"));
  const project = path.join(dir, "project"); const granted = path.join(dir, "granted"); const outside = path.join(dir, "outside");
  for (const folder of [project, granted, outside]) mkdirSync(folder);
  writeFileSync(path.join(granted, "data"), "ORIGINAL"); writeFileSync(path.join(outside, "data"), "UNAPPROVED");
  const config = defaultConfig();
  config.pathRules = [{ path: dir, scope: "tree", write: "deny" }];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [granted], readWrite: ["."], resourceReads: ["system"] };
  config.modes.subproject = config.modes.project!;
  const root = { family: randomUUID(), binding: bindPath(project) };
  const catalog = resolveCatalog(config, root, { agentDir: dir, home: dir });
  const snapshot: FilesystemSnapshot = { revision: 0, root, mode: "project", profile: catalog.profiles.project!, rules: catalog.rules, grants: [], exceptions: [] };
  const runtime = new RuntimeCoordinator(); let output = "";
  try {
    const command = `cat ${quote(path.join(granted, "data"))}; cat ${quote(path.join(outside, "data"))}; for fd in /proc/self/fd/*; do readlink "$fd"; done; echo DONE`;
    const result = await runtime.operations(snapshot, { id: root.family, network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }), decideHost: async () => false }, () => { renameSync(granted, `${granted}-old`); symlinkSync(outside, granted); }).exec(command, project, { onData: (data) => { output += data; } });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /ORIGINAL/); assert.doesNotMatch(output, /UNAPPROVED|granted-old/);
  } finally { await runtime.shutdown(root.family); rmSync(dir, { recursive: true, force: true }); }
});

test("macOS process mode changes syscall policy without moving final filesystem restrictions", async () => {
  const module = await import(
    new URL("./sandbox/macos-sandbox-utils.js", import.meta.resolve("@anthropic-ai/sandbox-runtime")).href
  );
  const policy = {
    grants: [{ path: "/tmp", directory: true, write: true }],
    guards: ["/tmp/protected"],
    rules: [{ path: "/dev/ptmx", directory: false, read: true, write: true }],
    program: [
      { path: "/tmp", directory: true, read: true, write: true },
      { path: "/dev/ptmx", directory: false, read: false, write: false },
    ],
  };
  for (const processMode of ["compatible", "strict"]) {
    const generated = module.wrapCommandWithSandboxMacOS({
      command: "true",
      needsNetworkRestriction: false,
      readConfig: { denyOnly: ["/"], allowWithinDeny: ["/tmp"], explicitPolicy: policy },
      writeConfig: { allowOnly: ["/tmp"], denyWithinAllow: [], explicitPolicy: policy },
      allowPty: true,
      processMode,
      binShell: "/bin/bash",
    });
    assert.match(generated, /file-write-unlink file-write-create/);
    assert.ok(generated.lastIndexOf("deny file-read* file-write*") > generated.indexOf("allow pseudo-tty"));
    for (const syscall of [82, 147, 244])
      assert.equal(generated.includes(`syscall-number ${syscall}`), processMode === "strict");
  }
});
