import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig, readConfig } from "./config-load.ts";
import { macGrepSandbox } from "./macos.ts";
import { bindPath } from "./paths.ts";
import { decide, resolveCatalog } from "./policy.ts";
import { RuntimeCoordinator } from "./sandbox.ts";
import type { FilesystemSnapshot } from "./schema.ts";

const mac = process.platform === "darwin";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture() {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-macos-"))).canonical;
  const project = path.join(dir, "ProjectÉ");
  mkdirSync(project);
  const config = defaultConfig();
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
  config.modes.subproject = config.modes.project!;
  config.pathRules = [];
  const root = { family: randomUUID(), binding: bindPath(project) };
  const snapshot = (): FilesystemSnapshot => {
    const catalog = resolveCatalog(config, root, { agentDir: dir, home: dir });
    return { revision: 0, root, mode: "project", profile: catalog.profiles.project!, rules: catalog.rules, grants: [], exceptions: [] };
  };
  const family = { id: root.family, network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }), decideHost: async () => false };
  return { dir, project, config, root, snapshot, family, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("APFS canonical aliases cannot bypass existing rules; ambiguous missing creation fails closed", { skip: !mac }, () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.project, "SecretÉ"), "credential");
    f.config.pathRules = [{ path: "SecretÉ", scope: "file", read: "deny" }];
    const aliases = ["SecretÉ", "SecretE\u0301"];
    if (existsSync(path.join(f.project, "secreté"))) aliases.push("secreté");
    const snapshot = f.snapshot();
    for (const name of aliases) {
      const target = bindPath(path.join(f.project, name));
      assert.equal(target.canonical, bindPath(path.join(f.project, "SecretÉ")).canonical);
      assert.equal(decide(snapshot, target, "read").action, "deny");
    }
    f.config.pathRules = [{ path: "FutureÉ", scope: "file", read: "ask" }];
    const future = f.snapshot();
    for (const name of ["FutureÉ", "futuree\u0301", "unrelated-new-file"]) {
      assert.equal(decide(future, bindPath(path.join(f.project, name)), "write").action, "ask");
    }
    assert.equal(decide(future, bindPath(path.join(f.project, "SecretÉ")), "read").action, "allow");
    writeFileSync(path.join(f.project, "FutureÉ"), "created externally");
    assert.equal(decide(future, bindPath(path.join(f.project, "unrelated-new-file")), "write").action, "allow");
    assert.equal(decide(future, bindPath(path.join(f.project, "FutureE\u0301")), "read").action, "ask");
  } finally { f.close(); }
});

test("native Seatbelt denies case/Unicode aliases, future creation, unlink, and symlink escapes", { skip: !mac }, async () => {
  const f = fixture(); const runtime = new RuntimeCoordinator();
  try {
    mkdirSync(path.join(f.project, "nested"));
    const secret = path.join(f.project, "nested", "SecretÉ");
    writeFileSync(secret, "CREDENTIAL");
    writeFileSync(path.join(f.dir, "outside"), "OUTSIDE");
    symlinkSync(path.join(f.dir, "outside"), path.join(f.project, "escape"));
    f.config.pathRules = [
      { path: "nested/SecretÉ", scope: "file", read: "deny" },
      { path: "nested/FutureÉ", scope: "file", write: "deny" },
    ];
    const futureAliases = existsSync(path.join(f.project, "nested", "secreté"))
      ? ["FutureÉ", "futureé"] : ["FutureÉ", "FutureÉ"];
    const commands = [
      "cat nested/SecretÉ", "cat nested/secreté", "cat escape",
      ...futureAliases.map((name) => `echo bad > ${quote(`nested/${name}`)}`),
      "rm nested/SecretÉ", "mv nested moved", "echo GOOD > nested/sibling", "echo DONE",
    ];
    let output = "";
    const result = await runtime.operations(f.snapshot(), f.family, () => {}).exec(commands.join("; "), f.project, { onData: (data) => { output += data; } });
    assert.equal(result.exitCode, 0, output);
    assert.doesNotMatch(output, /CREDENTIAL|OUTSIDE/);
    assert.equal(readFileSync(secret, "utf8"), "CREDENTIAL");
    for (const name of futureAliases) assert.ok(!existsSync(path.join(f.project, "nested", name)), name);
    assert.equal(readFileSync(path.join(f.project, "nested", "sibling"), "utf8").trim(), "GOOD");
  } finally { await runtime.shutdown(f.root.family); f.close(); }
});

test("native Seatbelt enforces user file grants without admitting parent or sibling contents", { skip: !mac }, async () => {
  const f = fixture(); const runtime = new RuntimeCoordinator();
  try {
    const file = path.join(f.dir, "global-config"); const sibling = path.join(f.dir, "sibling");
    writeFileSync(file, "FILE-CONTENT"); writeFileSync(sibling, "SIBLING-CONTENT");
    const owner = new PermissionOwner(resolveCatalog(f.config, f.root, { agentDir: f.dir, home: f.dir }), {
      ask: async () => ({ lifetime: "session" }),
    });
    await owner.requestGrant(file, "read", "read exact file");
    let output = "";
    const read = await runtime.operations(owner.snapshot(), f.family, () => {}).exec(
      `cat ${quote(file)}; cat ${quote(sibling)}; if echo bad > ${quote(file)}; then echo WRITE-LEAK; fi; echo DONE`,
      f.project, { onData: (data) => { output += data; } },
    );
    assert.equal(read.exitCode, 0, output);
    assert.match(output, /FILE-CONTENT/); assert.doesNotMatch(output, /SIBLING-CONTENT|WRITE-LEAK/);
    assert.equal(readFileSync(file, "utf8"), "FILE-CONTENT");
    await owner.requestGrant(file, "write", "write exact file");
    output = "";
    const write = await runtime.operations(owner.snapshot(), f.family, () => {}).exec(
      `echo UPDATED > ${quote(file)}; if echo bad > ${quote(sibling)}; then echo SIBLING-LEAK; fi; if ls ${quote(f.dir)}; then echo DIRECTORY-LEAK; fi; echo DONE`,
      f.project, { onData: (data) => { output += data; } },
    );
    assert.equal(write.exitCode, 0, output);
    assert.doesNotMatch(output, /SIBLING-LEAK|DIRECTORY-LEAK/);
    assert.equal(readFileSync(file, "utf8").trim(), "UPDATED");
    assert.equal(readFileSync(sibling, "utf8"), "SIBLING-CONTENT");
  } finally { await runtime.shutdown(f.root.family); f.close(); }
});

test("native Seatbelt enforces session file blocks from the production owner snapshot", { skip: !mac }, async () => {
  const f = fixture(); const runtime = new RuntimeCoordinator();
  try {
    const file = path.join(f.project, "secret"); const sibling = path.join(f.project, "sibling");
    writeFileSync(file, "BLOCKED-CONTENT"); writeFileSync(sibling, "SIBLING-CONTENT");
    const owner = new PermissionOwner(resolveCatalog(f.config, f.root, { agentDir: f.dir, home: f.dir }), {
      ask: async () => ({ action: "block" }),
    });
    await assert.rejects(owner.requestGrant(file, "read", "block exact file"), /blocked/);
    writeFileSync(`${file}.tmp`, "REPLACED-CONTENT"); renameSync(`${file}.tmp`, file);
    let output = "";
    const result = await runtime.operations(owner.snapshot(), f.family, () => {}).exec(
      `cat secret; if echo bad > secret; then echo WRITE-LEAK; fi; echo UPDATED > sibling; cat sibling; echo DONE`,
      f.project, { onData: (data) => { output += data; } },
    );
    assert.equal(result.exitCode, 0, output);
    assert.doesNotMatch(output, /BLOCKED-CONTENT|REPLACED-CONTENT|WRITE-LEAK/);
    assert.match(output, /UPDATED/);
    assert.equal(readFileSync(file, "utf8"), "REPLACED-CONTENT");
  } finally { await runtime.shutdown(f.root.family); f.close(); }
});

test("macOS launch revalidates bindings and cancellation kills the contained process", { skip: !mac }, async () => {
  const f = fixture(); const runtime = new RuntimeCoordinator();
  try {
    const snapshot = f.snapshot();
    await assert.rejects(runtime.operations(snapshot, f.family, () => {
      renameSync(f.project, `${f.project}-old`); mkdirSync(f.project);
    }).exec("echo SHOULD-NOT-RUN", f.project, { onData: () => assert.fail("launched with replaced authority") }), /identity changed/);
    rmSync(f.project, { recursive: true }); renameSync(`${f.project}-old`, f.project);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      await assert.rejects(runtime.operations(snapshot, f.family, () => {}).exec("echo READY; sleep 30; echo escaped > marker", f.project, {
        signal: controller.signal, onData: (data) => { if (String(data).includes("READY")) controller.abort(); },
      }), /aborted/i);
      assert.ok(!existsSync(path.join(f.project, "marker")));
    } finally { clearTimeout(timer); }
  } finally { await runtime.shutdown(f.root.family); f.close(); }
});

test("scoped macOS shell combines filesystem denial with live proxy policy and blocks direct networking", { skip: !mac }, async () => {
  const f = fixture(); const runtime = new RuntimeCoordinator();
  const server = createServer((_request, response) => response.end("PROXY-ALLOWED"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let allow = false; let output = "";
  try {
    writeFileSync(path.join(f.dir, "outside"), "OUTSIDE-CONTENT");
    const curl = `/usr/bin/curl -s --max-time 2 --noproxy '' --proxy "$HTTP_PROXY" http://127.0.0.1:${port}/`;
    const command = `cat ${quote(path.join(f.dir, "outside"))}; ${curl}; echo FIRST; sleep 0.2; ${curl}; /usr/bin/curl -s --max-time 2 --noproxy '*' http://127.0.0.1:${port}/; echo DONE`;
    const result = await runtime.operations(f.snapshot(), { ...f.family, network: () => ({ revision: Number(allow), restricted: true, allowedDomains: [], deniedDomains: [] }), decideHost: async () => allow }, () => {}).exec(command, f.project, {
      timeout: 10, onData: (data) => { output += data; if (output.includes("FIRST")) allow = true; },
    });
    assert.equal(result.exitCode, 0, output);
    assert.doesNotMatch(output, /OUTSIDE-CONTENT/);
    assert.equal(output.split("PROXY-ALLOWED").length - 1, 1, output);
    const searchSocket = spawnSync("/usr/bin/sandbox-exec", ["-p", macGrepSandbox("/bin/bash"), "/bin/bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], { cwd: "/", encoding: "utf8", timeout: 3000 });
    assert.notEqual(searchSocket.status, 0);
    assert.match(searchSocket.stderr, /Operation not permitted/);
  } finally {
    await runtime.shutdown(f.root.family);
    await new Promise<void>((resolve) => server.close(() => resolve())); f.close();
  }
});

test("stdin search sandbox cannot read or write arbitrary host files", { skip: !mac }, () => {
  const f = fixture();
  try {
    const secret = path.join(f.dir, "secret"); writeFileSync(secret, "HOST-SECRET");
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", macGrepSandbox("/bin/bash"), "/bin/bash", "-c",
      `read line; echo "$line"; read secret < ${quote(secret)}; echo "$secret"; echo bad > ${quote(path.join(f.dir, "created"))}`],
    { cwd: "/", encoding: "utf8", input: "AUTHORIZED-STDIN\n" });
    assert.match(result.stdout, /AUTHORIZED-STDIN/);
    assert.doesNotMatch(result.stdout, /HOST-SECRET/);
    assert.ok(!existsSync(path.join(f.dir, "created")));
  } finally { f.close(); }
});

test("Apple system config aliases work without accepting user-controlled symlinks", { skip: !mac }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-config-mac-"));
  try {
    const file = path.join(dir, "config.json"); writeFileSync(file, "{}");
    assert.deepEqual(readConfig(file), {});
    symlinkSync("config.json", path.join(dir, "linked.json"));
    assert.throws(() => readConfig(path.join(dir, "linked.json")), /symlink redirection/);
    symlinkSync(dir, `${dir}-alias`);
    try { assert.throws(() => readConfig(path.join(`${dir}-alias`, "config.json")), /symlink redirection/); }
    finally { rmSync(`${dir}-alias`); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
