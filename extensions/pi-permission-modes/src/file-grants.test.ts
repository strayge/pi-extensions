import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner, type AskApproval } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { PermissionStore, STATE_FILE } from "./permission-state.ts";
import { decide, resolveCatalog } from "./policy.ts";
import { compileFilesystem } from "./sandbox.ts";

function fixture(t: { after: (cleanup: () => void) => void }) {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-file-grants-"))).canonical;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, "project"); const outside = path.join(dir, "outside");
  mkdirSync(project); mkdirSync(outside);
  const file = path.join(outside, "config"); const sibling = path.join(outside, "sibling");
  writeFileSync(file, "CONFIG"); writeFileSync(sibling, "SIBLING");
  const config = defaultConfig();
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  config.pathRules = [];
  const root = { family: randomUUID(), binding: bindPath(project) };
  const context = { agentDir: dir, home: dir };
  const catalog = () => resolveCatalog(config, root, context);
  const owner = (ask: AskApproval = async () => ({ lifetime: "session" })) => new PermissionOwner(catalog(), { ask });
  return { dir, project, outside, file, sibling, config, context, catalog, owner };
}

test("explicit file grants restrict read/write authority to the selected name and revoke independently", async (t) => {
  const f = fixture(t); const requests: string[] = [];
  const owner = f.owner(async (request) => {
    requests.push(request.kind);
    assert.equal(request.path, f.file); assert.equal(request.create, false);
    return { lifetime: "session" };
  });
  await owner.requestGrant(f.file, "read", "read global config");
  assert.equal(decide(owner.snapshot(), bindPath(f.file), "read").action, "allow");
  assert.equal(decide(owner.snapshot(), bindPath(f.file), "write").action, "ask");
  for (const target of [f.outside, f.sibling])
    assert.equal(decide(owner.snapshot(), bindPath(target), "read").action, "ask");
  const compiled = compileFilesystem(owner.snapshot()).explicitPolicy!;
  assert.deepEqual(compiled.grants.find((grant) => grant.path === f.file), { path: f.file, directory: false, write: false });
  assert.ok(!compiled.grants.some((grant) => grant.path === f.outside));
  await owner.requestGrant(f.file, "write", "update global config");
  assert.equal(decide(owner.snapshot(), bindPath(f.file), "write").action, "allow");
  assert.ok(compileFilesystem(owner.snapshot()).explicitPolicy!.grants.some((grant) => grant.path === f.file && !grant.directory && grant.write));
  assert.deepEqual(requests, ["file", "file"]);
  const [read, write] = owner.snapshot().grants;
  owner.revoke(write!.id);
  assert.equal(decide(owner.snapshot(), bindPath(f.file), "write").action, "ask");
  assert.equal(decide(owner.snapshot(), bindPath(f.file), "read").action, "allow");
  owner.revoke(read!.id);
  assert.equal(decide(owner.snapshot(), bindPath(f.file), "read").action, "ask");
});

test("file grants preserve independent ask exceptions and cannot override hard denies", async (t) => {
  const f = fixture(t);
  f.config.pathRules = [
    { path: f.file, scope: "file", read: "ask", write: "deny" },
    { path: f.sibling, scope: "file", read: "deny" },
  ];
  const requests: string[] = [];
  const owner = f.owner(async (request) => { requests.push(request.kind); return { lifetime: "session" }; });
  await owner.requestGrant(f.file, "read", "config");
  assert.equal(decide(owner.snapshot(), bindPath(f.file), "read").action, "ask");
  await owner.authorize([f.file], "read", "separate rule exception");
  assert.deepEqual(requests, ["file", "exception"]);
  assert.equal(decide(owner.snapshot(), bindPath(f.file), "read").action, "allow");
  await assert.rejects(owner.requestGrant(f.file, "write", "denied write"), /Hard-denied/);
  await assert.rejects(owner.requestGrant(f.sibling, "read", "denied read"), /Hard-denied/);
  assert.equal(owner.snapshot().grants.length, 1);
  assert.deepEqual(requests, ["file", "exception"]);
});

test("file approval rejects identity changes, scope widening, and directory-only tool requests", async (t) => {
  const f = fixture(t);
  const widening = f.owner(async () => ({ lifetime: "session", directory: f.outside, binding: bindPath(f.outside) }));
  await assert.rejects(widening.requestGrant(f.file, "read", "exact file"), /cannot edit directory scope/);
  assert.equal(widening.snapshot().grants.length, 0);
  await assert.rejects(widening.requestDirectory(f.file, "read", "directory tool"), /requires a directory/);
  const replaced = f.owner(async () => {
    renameSync(f.file, `${f.file}-old`); writeFileSync(f.file, "REPLACED");
    return { lifetime: "session" };
  });
  await assert.rejects(replaced.requestGrant(f.file, "read", "confirm original object"), /identity changed/);
  assert.equal(replaced.snapshot().grants.length, 0);
});

test("session/project file grants survive atomic replacement, reload, restoration, and persisted revocation", async (t) => {
  const f = fixture(t);
  const binding = { id: randomUUID(), file: path.join(f.dir, "session.jsonl"), cwd: f.project };
  writeFileSync(binding.file, "session");
  const store = new PermissionStore(f.dir); store.load(binding, f.project, f.context);
  const owner = new PermissionOwner(f.catalog(), { store, ask: async (request) => ({ lifetime: request.path === f.file ? "project" : "session" }) });
  await owner.requestGrant(f.file, "write", "remember exact file");
  await owner.requestGrant(f.sibling, "read", "session-only file");
  writeFileSync(`${f.file}.new`, "REPLACED"); renameSync(`${f.file}.new`, f.file);
  owner.select("subproject"); owner.select("project");
  await owner.reload(f.config, undefined, f.context);
  await owner.authorize([f.file], "write", "replacement keeps file name authority");
  const freshStore = new PermissionStore(f.dir);
  const restored = freshStore.load(binding, f.project, f.context);
  assert.equal(restored.project.grants.length, 1); assert.equal(restored.session!.grants.length, 2);
  const projectOnly = new PermissionStore(f.dir).load(undefined, f.project, f.context);
  assert.equal(projectOnly.project.grants.length, 1);
  const restarted = new PermissionOwner(restored.session!.catalog, { store: freshStore, restored: restored.session, ask: async () => undefined });
  await restarted.authorize([f.file], "write", "restored file");
  await restarted.authorize([f.sibling], "read", "restored session file");
  assert.equal(decide(restarted.snapshot(), bindPath(f.outside), "read").action, "ask");
  restarted.revoke(restored.project.grants[0]!.id);
  assert.equal(new PermissionStore(f.dir).load(binding, f.project, f.context).project.grants.length, 0);
});

test("file grants pin their parent and symlink destination without authorizing aliases to other names", async (t) => {
  const f = fixture(t); const alias = path.join(f.outside, "alias");
  symlinkSync("config", alias);
  const owner = f.owner();
  await owner.requestGrant(alias, "read", "explicit symlink to file");
  assert.equal(decide(owner.snapshot(), bindPath(f.file), "read").action, "allow");
  assert.equal(decide(owner.snapshot(), bindPath(f.sibling), "read").action, "ask");
  unlinkSync(alias); symlinkSync("sibling", alias);
  assert.throws(() => compileFilesystem(owner.snapshot()), /target changed/);
  unlinkSync(alias); symlinkSync("config", alias);
  renameSync(f.outside, `${f.outside}-old`); mkdirSync(f.outside);
  writeFileSync(f.file, "NEW PARENT"); symlinkSync("config", alias);
  assert.throws(() => compileFilesystem(owner.snapshot()), /identity changed/);
});

test("saved file grants reject malformed anchors and non-file replacements", async (t) => {
  const f = fixture(t);
  const store = new PermissionStore(f.dir); store.load(undefined, f.project, f.context);
  const owner = new PermissionOwner(f.catalog(), { store, ask: async () => ({ lifetime: "project" }) });
  await owner.requestGrant(f.file, "read", "remember config");
  const stateFile = path.join(f.dir, "permission-mode", STATE_FILE);
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const original = readFileSync(stateFile, "utf8");
  state.projects[JSON.stringify(f.project)].grants[0].binding.parent = {
    ...bindPath(f.dir), identity: { type: "directory" },
  };
  writeFileSync(stateFile, JSON.stringify(state));
  assert.throws(() => new PermissionStore(f.dir).load(undefined, f.project, f.context), /Invalid saved file permission anchor/);
  writeFileSync(stateFile, original);
  unlinkSync(f.file); mkdirSync(f.file);
  assert.throws(() => new PermissionStore(f.dir).load(undefined, f.project, f.context), /target changed/);
});
