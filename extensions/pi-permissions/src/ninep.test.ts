import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { grantLimitations } from "./evaluation.ts";
import { approvalUI } from "./file-approval.ts";
import { assertNativeSemantics, isLinux9p } from "./native-semantics.ts";
import { bindPath, within } from "./paths.ts";
import { decide, resolveCatalog } from "./policy.ts";
import { compileFilesystem } from "./sandbox.ts";
import type { AccessGrant, PathRule } from "./schema.ts";

/** These simulated filesystem types test admission and warning policy, not native 9p enforcement. */
function fixture(t: TestContext) {
  const directory = bindPath(mkdtempSync(path.join(tmpdir(), "permission-ninep-policy-"))).canonical;
  const project = path.join(directory, "project"); const ninep = path.join(directory, "ninep");
  for (const folder of [project, ninep, path.join(ninep, "open"), path.join(ninep, "private"), path.join(ninep, "ask"), path.join(ninep, "readonly")]) mkdirSync(folder);
  writeFileSync(path.join(ninep, "open", "note"), "OPEN");
  const statfs = fs.statfsSync;
  t.mock.method(fs, "statfsSync", (file: fs.PathLike) => {
    const result = statfs(file);
    if (within(ninep.toLowerCase(), String(file).toLowerCase())) result.type = 0x01021997;
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); });
  const config = defaultConfig();
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  config.pathRules = [
    { path: path.join(ninep, "private"), scope: "tree", read: "deny" },
    { path: path.join(ninep, "ask"), scope: "tree", read: "ask" },
    { path: path.join(ninep, "readonly"), scope: "tree", write: "deny" },
  ];
  const root = { family: randomUUID(), binding: bindPath(project) };
  const context = { agentDir: directory, home: directory };
  const catalog = () => resolveCatalog(config, root, context);
  const grant: AccessGrant = { id: randomUUID(), binding: bindPath(ninep), access: "write", lifetime: "project" };
  return { directory, project, ninep, config, catalog, grant, context };
}

const linux = { skip: process.platform !== "linux" };

test("simulated Linux 9p is admitted by default, including missing prefixes; strict types and failures stay unchanged", linux, (t) => {
  const f = fixture(t);
  assert.equal(isLinux9p(bindPath(path.join(f.ninep, "missing", "child"))), true);
  assert.doesNotThrow(() => assertNativeSemantics(bindPath(f.ninep)));
  const statfs = fs.statfsSync;
  let type = 0x01021994;
  t.mock.method(fs, "statfsSync", (file: fs.PathLike) => ({ ...statfs(file), type }));
  syncBuiltinESMExports();
  assert.doesNotThrow(() => assertNativeSemantics(bindPath(f.project)));
  type = 0xef53;
  assert.doesNotThrow(() => assertNativeSemantics(bindPath(f.project)));
  type = 0x1234;
  assert.throws(() => assertNativeSemantics(bindPath(f.project)), /unavailable for filesystem type 1234/);
  type = 0xef53;
  const casefold = path.join(f.directory, "casefold"); mkdirSync(casefold);
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawn>) => args[0] === "/usr/bin/lsattr" && (args[1] as string[]).includes(casefold)
    ? { pid: 0, output: [], stdout: `--------------F------- ${casefold}\n`, stderr: "", status: 0, signal: null }
    : spawn(...args));
  syncBuiltinESMExports();
  assert.throws(() => assertNativeSemantics(bindPath(casefold)), /Cannot verify case-sensitive native enforcement/);
});

test("new and restored simulated 9p grants retain evaluator decisions and generated nested masks", linux, async (t) => {
  const f = fixture(t);
  for (const restored of [false, true]) {
    const owner = new PermissionOwner(f.catalog(), { grants: restored ? [f.grant] : [], ask: async () => ({ lifetime: "project" }) });
    if (!restored) await owner.requestDirectory(f.ninep, "write", "ordinary grant");
    const snapshot = owner.snapshot();
    assert.equal(decide(snapshot, bindPath(path.join(f.ninep, "open", "note")), "write").action, "allow");
    assert.equal(decide(snapshot, bindPath(path.join(f.ninep, "private")), "read").action, "deny");
    assert.equal(decide(snapshot, bindPath(path.join(f.ninep, "ask")), "read").action, "ask");
    assert.equal(decide(snapshot, bindPath(path.join(f.ninep, "readonly")), "read").action, "allow");
    assert.equal(decide(snapshot, bindPath(path.join(f.ninep, "readonly")), "write").action, "deny");
    const program = compileFilesystem(snapshot).explicitPolicy!.program;
    assert.ok(program.some((entry) => entry.path === f.ninep && entry.read && entry.write));
    assert.ok(program.some((entry) => entry.path === path.join(f.ninep, "private") && !entry.read && !entry.write));
    assert.ok(program.some((entry) => entry.path === path.join(f.ninep, "readonly") && entry.read && !entry.write));
  }
});

test("warning detection checks protected 9p submounts and declaration aliases without changing authorization", linux, (t) => {
  const f = fixture(t); const owner = new PermissionOwner(f.catalog(), { grants: [f.grant], ask: async () => undefined });
  const snapshot = owner.snapshot();
  assert.equal(grantLimitations(snapshot, bindPath(f.directory), "tree", "write").protections.length, 3);
  assert.deepEqual(grantLimitations(snapshot, bindPath(f.project), "tree", "write"), { limited: false, protections: [] });
  assert.deepEqual(grantLimitations(snapshot, bindPath(path.join(f.ninep, "open")), "tree", "write"), { limited: true, protections: [] });
  assert.equal(grantLimitations(snapshot, bindPath(f.ninep), "tree", "read").protections.length, 2);
  const alias = path.join(f.directory, "NINEP"); mkdirSync(alias); mkdirSync(path.join(alias, "secret"));
  const rules: PathRule[] = [{ path: path.join(alias, "secret"), scope: "tree", read: "deny" }];
  f.config.pathRules = rules;
  const aliased = new PermissionOwner(f.catalog(), { grants: [f.grant], ask: async () => undefined }).snapshot();
  assert.equal(grantLimitations(aliased, bindPath(f.ninep), "tree", "write").protections.length, 1);
  assert.equal(decide(aliased, bindPath(path.join(f.ninep, "secret")), "read").action, "allow", "warning-only alias comparison must not alter precedence");
  f.config.pathRules = [{ path: path.join(f.project, "protected"), scope: "tree", read: "deny" }];
  const strict = new PermissionOwner(f.catalog(), { ask: async () => undefined }).snapshot();
  assert.deepEqual(grantLimitations(strict, bindPath(f.project), "tree", "write"), { limited: false, protections: [] });
});

test("ordinary narrower R/O authority is additive, not a warning-worthy nested write restriction", linux, (t) => {
  const f = fixture(t); f.config.pathRules = [{ path: path.join(f.ninep, "readonly"), scope: "tree", read: "allow" }];
  f.config.modes.project!.filesystem = { kind: "scoped", readOnly: [path.join(f.ninep, "readonly")], readWrite: [f.ninep], resourceReads: [] };
  const owner = new PermissionOwner(f.catalog(), { grants: [{ ...f.grant, binding: bindPath(path.join(f.ninep, "readonly")), access: "read" }], ask: async () => undefined });
  assert.equal(decide(owner.snapshot(), bindPath(path.join(f.ninep, "readonly")), "write").action, "allow");
  assert.deepEqual(grantLimitations(owner.snapshot(), bindPath(f.ninep), "tree", "write"), { limited: true, protections: [] });
});

test("scope edits refresh the 9p warning and approval avoids an equivalent activation notice", linux, async (t) => {
  const f = fixture(t); const notices: string[] = []; let prompts = 0;
  const owner = new PermissionOwner(f.catalog(), { ask: async () => undefined, interactive: () => true, warn: (message) => notices.push(message) });
  const ctx = { cwd: f.project, hasUI: true, ui: { select: async (title: string) => {
    if (title.startsWith("Choose directory scope")) return f.ninep;
    prompts++;
    assert.doesNotMatch(title, /More-specific restrictions remain protected/);
    if (prompts === 1) { assert.doesNotMatch(title, /Warning/); return "Edit directory scope"; }
    assert.match(title, /Warning\nNested protections on 9p cannot be reliably enforced/);
    assert.ok(title.includes(`Path       ${f.ninep}`));
    return "Allow for this session";
  } } } as unknown as ExtensionContext;
  owner.ask = approvalUI(() => ctx, () => owner);
  await owner.requestDirectory(path.join(f.ninep, "open"), "write", "widen the displayed scope");
  assert.equal(prompts, 2); assert.equal(owner.snapshot().grants[0]!.binding.canonical, f.ninep);
  owner.warnFilesystemLimitations(); assert.deepEqual(notices, []);
});

test("activation scans root authority once per context, including later blocks and reload, without per-operation/child notices", linux, async (t) => {
  const f = fixture(t); const notices: string[] = [];
  const owner = new PermissionOwner(f.catalog(), { grants: [f.grant], ask: async () => ({ action: "block" }) });
  owner.warnFilesystemLimitations();
  owner.warn = (message) => notices.push(message); owner.interactive = () => true;
  owner.warnFilesystemLimitations(); assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Nested protections on 9p/);
  const release = owner.attachChild(() => {});
  await owner.authorize([path.join(f.ninep, "open")], "write", "operation"); release();
  owner.warnFilesystemLimitations(); owner.select("subproject"); assert.equal(notices.length, 1);
  await assert.rejects(owner.requestDirectory(path.join(f.ninep, "open"), "write", "block"), /blocked/);
  assert.equal(notices.length, 2);
  await owner.reload(f.config, undefined, f.context); assert.equal(notices.length, 2);
  f.config.pathRules.push({ path: path.join(f.ninep, "new-protection"), scope: "tree", write: "ask" });
  await owner.reload(f.config, undefined, f.context); assert.equal(notices.length, 3);
  owner.select("yolo"); owner.warnFilesystemLimitations(); assert.equal(notices.length, 3);
});

test("profile roots and global positive declarations activate warnings, while owners without interactive UI stay silent", linux, (t) => {
  const f = fixture(t);
  f.config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: [f.ninep], resourceReads: [] };
  for (const kind of ["profile", "global"] as const) {
    if (kind === "global") {
      f.config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
      f.config.pathRules.push({ path: f.ninep, scope: "tree", write: "allow" });
    }
    let interactive = false; const notices: string[] = [];
    const owner = new PermissionOwner(f.catalog(), { ask: async () => undefined, warn: (message) => notices.push(message), interactive: () => interactive });
    owner.warnFilesystemLimitations(); owner.select("project"); assert.deepEqual(notices, []);
    interactive = true; owner.warnFilesystemLimitations(); assert.equal(notices.length, 1, kind);
  }
});
