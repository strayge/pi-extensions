import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner, StaleAuthorityError, type ApprovalAnswer } from "./approvals.ts";
import { permissionAwareness } from "./awareness.ts";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { PermissionStore, STATE_FILE } from "./permission-state.ts";
import { decide, resolveCatalog } from "./policy.ts";
import { compileFilesystem } from "./sandbox.ts";
import type { PermissionModeConfig } from "./schema.ts";

function fixture(t: { after: (cleanup: () => void) => void }, change?: (config: PermissionModeConfig, project: string) => void) {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-block-"))).canonical;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, "project"); const target = path.join(project, "target");
  mkdirSync(project); mkdirSync(target);
  writeFileSync(path.join(target, "file"), "ORIGINAL"); writeFileSync(path.join(project, "sibling"), "SIBLING");
  const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  change?.(config, project);
  const root = { family: randomUUID(), binding: bindPath(project) };
  const context = { agentDir: dir, home: dir };
  const catalog = resolveCatalog(config, root, context);
  const owner = new PermissionOwner(catalog, { ask: async () => ({ action: "block" }) });
  return { dir, project, target, config, context, catalog, owner };
}

test("file/tree session blocks merge into immutable evaluation and compiler snapshots", async (t) => {
  for (const scope of ["file", "tree"] as const) for (const access of ["read", "write"] as const) {
    const f = fixture(t);
    const target = scope === "file" ? path.join(f.target, "file") : f.target;
    const before = f.owner.snapshot();
    await assert.rejects(f.owner.requestGrant(target, access, "block"), /blocked for this session/);
    const snapshot = f.owner.snapshot(); const block = f.owner.sessionBlocks[0]!;
    assert.match(block.id, /^block:[a-f0-9-]+$/); assert.equal(block.scope, scope);
    assert.equal(snapshot.revision, before.revision + 1); assert.equal(before.rules.length, 0);
    assert.equal(snapshot.grants.length, 0); assert.equal(snapshot.exceptions.length, 0);
    assert.ok(Object.isFrozen(f.owner.sessionBlocks)); assert.ok(Object.isFrozen(block.binding));
    assert.equal(decide(snapshot, bindPath(path.join(f.target, "file")), "read").action, access === "read" ? "deny" : "allow");
    assert.equal(decide(snapshot, bindPath(path.join(f.target, "file")), "write").action, "deny");
    assert.equal(decide(snapshot, bindPath(path.join(f.project, "sibling")), "write").action, "allow");
    f.owner.ask = async () => assert.fail("Blocked requests must not prompt again");
    await assert.rejects(f.owner.authorize([path.join(f.target, "file")], "write", "blocked"), /access denied/);
    const native = compileFilesystem(snapshot).explicitPolicy!.program.find((r) => r.path === target)!;
    assert.equal(native.directory, scope === "tree"); assert.equal(native.write, false); assert.equal(native.read, access === "write");
    f.owner.select("yolo");
    assert.equal(decide(f.owner.snapshot(), bindPath(target), "write").action, "allow");
    assert.equal(compileFilesystem(f.owner.snapshot()).disabled, true);
  }
});

test("equal grants and receipts lose to a block; narrower grants and receipts override it", async (t) => {
  const f = fixture(t, (config, project) => {
    config.pathRules = [
      { path: "target", scope: "tree", write: "ask" },
      { path: path.join(project, "target", "file"), scope: "file", write: "ask" },
    ];
  });
  f.owner.ask = async () => ({ lifetime: "session" });
  await f.owner.authorize([f.target], "write", "equal receipt");
  await f.owner.requestDirectory(f.target, "write", "equal grant");
  assert.equal(f.owner.snapshot().exceptions.length, 1);
  f.owner.ask = async () => ({ action: "block" });
  await assert.rejects(f.owner.requestDirectory(f.target, "read", "read block"), /blocked/);
  assert.equal(decide(f.owner.snapshot(), bindPath(f.target), "write").action, "deny");
  f.owner.ask = async () => ({ lifetime: "session" });
  const file = path.join(f.target, "file");
  await f.owner.authorize([file], "write", "narrower receipt");
  assert.equal(decide(f.owner.snapshot(), bindPath(file), "write").action, "allow");
  const granted = path.join(f.target, "granted"); writeFileSync(granted, "GRANTED");
  await f.owner.requestGrant(granted, "read", "narrower R/O file grant");
  assert.equal(decide(f.owner.snapshot(), bindPath(granted), "read").action, "allow");
  assert.equal(decide(f.owner.snapshot(), bindPath(granted), "write").action, "deny");
  await f.owner.requestGrant(granted, "write", "narrower R/W file grant");
  assert.equal(decide(f.owner.snapshot(), bindPath(granted), "write").action, "allow");
  assert.equal(decide(f.owner.snapshot(), bindPath(f.target), "read").action, "deny");
  f.owner.revoke();
  assert.equal(f.owner.sessionBlocks.length, 0);
  assert.equal(f.owner.snapshot().grants.length, 0);
  assert.equal(f.owner.snapshot().exceptions.length, 0);
});

test("stale and aborted block answers never publish; a concurrent allow cannot bypass a new block", async (t) => {
  for (const invalidate of ["revision", "abort"] as const) {
    const f = fixture(t); const controller = new AbortController();
    let answer!: (value: ApprovalAnswer) => void;
    f.owner.ask = (request) => {
      assert.ok(Object.isFrozen(request));
      return new Promise((resolve) => { answer = resolve; });
    };
    const pending = f.owner.requestDirectory(f.target, "read", "pending block", controller.signal);
    const rejected = assert.rejects(pending, invalidate === "revision" ? StaleAuthorityError : { name: "AbortError" });
    if (invalidate === "revision") f.owner.select("subproject"); else controller.abort();
    answer({ action: "block" }); await rejected;
    assert.equal(f.owner.sessionBlocks.length, 0);
  }
  const f = fixture(t); const file = path.join(f.target, "file");
  let answer!: (value: ApprovalAnswer) => void;
  f.owner.ask = (request) => request.access === "write" ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({ action: "block" });
  const pending = f.owner.requestGrant(file, "write", "pending allow");
  const rejected = assert.rejects(pending, StaleAuthorityError);
  await assert.rejects(f.owner.requestGrant(file, "read", "equal block"), /blocked/);
  answer({ lifetime: "session" }); await rejected;
  assert.equal(f.owner.snapshot().grants.length, 0);
  assert.equal(decide(f.owner.snapshot(), bindPath(file), "write").action, "deny");
});

test("edited blocks require the displayed, still-pinned containing directory", async (t) => {
  const f = fixture(t);
  f.owner.ask = async () => ({ action: "block", directory: f.project, binding: bindPath(f.project) });
  await assert.rejects(f.owner.requestDirectory(f.target, "write", "wider block"), /blocked/);
  assert.equal(f.owner.sessionBlocks[0]!.binding!.canonical, f.project);
  f.owner.revoke();
  for (const answer of [
    { action: "block", directory: f.dir },
    { action: "block", directory: f.project, binding: bindPath(f.target) },
    { action: "block", directory: f.target, binding: bindPath(f.target) },
  ] as const) {
    f.owner.ask = async () => answer;
    await assert.rejects(f.owner.requestDirectory(f.project, "write", "invalid scope"), /identity|displayed|contain/);
    assert.equal(f.owner.sessionBlocks.length, 0);
  }
  const pinned = bindPath(f.target);
  f.owner.ask = async () => {
    renameSync(f.target, `${f.target}-old`); mkdirSync(f.target);
    return { action: "block", binding: pinned, directory: f.target };
  };
  await assert.rejects(f.owner.requestDirectory(f.target, "write", "replaced"), /identity changed/);
  assert.equal(f.owner.sessionBlocks.length, 0);
});

test("directory blocking never creates missing directories; exception blocks retain exact declared future scope", async (t) => {
  const f = fixture(t); const missing = path.join(f.target, "missing");
  await assert.rejects(f.owner.requestDirectory(missing, "write", "no creation"), /blocked for this session/);
  assert.equal(existsSync(missing), false); assert.equal(f.owner.sessionBlocks.length, 1);
  f.owner.ask = async () => assert.fail("A missing blocked directory must not prompt again");
  await assert.rejects(f.owner.requestDirectory(missing, "write", "still blocked"), /Hard-denied/);
  const native = compileFilesystem(f.owner.snapshot()).explicitPolicy!.program.find((r) => r.path === missing)!;
  assert.equal(native.directory, true); assert.equal(native.write, false);
  mkdirSync(missing);
  assert.equal(decide(f.owner.snapshot(), bindPath(missing), "write").action, "deny");
  for (const scope of ["file", "tree"] as const) {
    const e = fixture(t, (config) => { config.pathRules = [{ path: "target/missing", scope, read: "ask" }]; });
    const future = path.join(e.target, "missing");
    e.owner.ask = async (request) => {
      assert.equal(request.kind, "exception"); assert.equal(request.scope, scope);
      return { action: "block" };
    };
    await assert.rejects(e.owner.authorize([future], "read", "future rule"), /blocked/);
    const block = e.owner.sessionBlocks[0]!;
    assert.equal(block.scope, scope); assert.equal(block.binding, e.catalog.rules[0]!.binding);
    assert.equal(e.owner.snapshot().exceptions.length, 0); assert.equal(existsSync(future), false);
    if (scope === "file") writeFileSync(future, "created externally"); else mkdirSync(future);
    assert.equal(decide(e.owner.snapshot(), bindPath(future), "read").action, "deny");
  }
});

test("exact-file blocks follow atomic replacement without blocking siblings and can be removed after parent replacement", async (t) => {
  const f = fixture(t); const file = path.join(f.target, "file"); const sibling = path.join(f.target, "sibling");
  writeFileSync(sibling, "SIBLING");
  await assert.rejects(f.owner.requestGrant(file, "read", "exact block"), /blocked/);
  writeFileSync(`${file}.tmp`, "REPLACEMENT"); renameSync(`${file}.tmp`, file);
  assert.equal(decide(f.owner.snapshot(), bindPath(file), "read").action, "deny");
  assert.equal(decide(f.owner.snapshot(), bindPath(sibling), "write").action, "allow");
  const id = f.owner.sessionBlocks[0]!.id;
  renameSync(f.target, `${f.target}-old`); mkdirSync(f.target); writeFileSync(file, "NEW");
  assert.throws(() => decide(f.owner.snapshot(), bindPath(file), "read"), /identity changed/);
  f.owner.revoke(id);
  assert.equal(decide(f.owner.snapshot(), bindPath(file), "read").action, "allow");
});

test("blocks survive owner reload/profile changes but never persist or restore, and inspection keeps them separate", async (t) => {
  const f = fixture(t);
  const store = new PermissionStore(f.dir);
  const session = { id: randomUUID(), file: path.join(f.dir, "session.jsonl"), cwd: f.project };
  store.load(session, f.project, f.context, f.config);
  const owner = new PermissionOwner(f.catalog, { store, ask: async () => ({ action: "block" }) });
  const stateFile = path.join(store.directory, STATE_FILE);
  const before = readFileSync(stateFile, "utf8");
  await assert.rejects(owner.requestDirectory(f.target, "read", "memory only"), /blocked/);
  assert.equal(readFileSync(stateFile, "utf8"), before);
  const block = owner.sessionBlocks[0]!;
  owner.select("subproject");
  await owner.reload(f.config, undefined, f.context);
  assert.equal(owner.sessionBlocks[0], block);
  assert.equal(decide(owner.snapshot(), bindPath(f.target), "read").action, "deny");
  const awareness = permissionAwareness(owner);
  assert.match(awareness, new RegExp(`Session blocks:\\n${block.id}:`));
  assert.doesNotMatch(awareness.split("Session blocks:")[0]!, /block:/);
  assert.match(awareness, /R\/O denial \(also denies writes\)/);
  assert.doesNotMatch(readFileSync(stateFile, "utf8"), /block:|session block/);
  const freshStore = new PermissionStore(f.dir);
  const restored = freshStore.load(session, f.project, f.context, f.config).session!;
  const reopened = new PermissionOwner(restored.catalog, { restored, ask: async () => undefined });
  assert.equal(reopened.sessionBlocks.length, 0);
  assert.equal(decide(reopened.snapshot(), bindPath(f.target), "read").action, "allow");
  const saved = readFileSync(stateFile, "utf8");
  const lock = path.join(store.directory, ".authority.lock"); writeFileSync(lock, "orphan", { mode: 0o600 });
  assert.throws(() => owner.revoke(), /locked/);
  assert.equal(owner.sessionBlocks[0], block);
  owner.revoke(block.id);
  assert.equal(readFileSync(stateFile, "utf8"), saved);
  assert.equal(owner.sessionBlocks.length, 0);
});
