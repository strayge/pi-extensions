import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { assertBinding, bindFile, bindPath, resolvePermissionBinding } from "./paths.ts";
import { PermissionStore, STATE_FILE } from "./permission-state.ts";
import { decide, resolveCatalog, SYSTEM_PATHS } from "./policy.ts";
import { compileFilesystem } from "./sandbox.ts";

function replace(file: string): void {
  /** Keep the old inode alive until rename so the fixture always performs an atomic replacement. */
  writeFileSync(`${file}.new`, "replacement");
  renameSync(`${file}.new`, file);
}

function fixture() {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-files-"))).canonical;
  const project = path.join(dir, "project");
  const system = path.join(dir, "system");
  mkdirSync(project); mkdirSync(system);
  const resource = path.join(system, "resolver.conf");
  const alias = path.join(system, "resolver-link");
  const credential = path.join(project, "credential");
  writeFileSync(resource, "resolver"); symlinkSync("resolver.conf", alias);
  writeFileSync(credential, "secret");
  const baseline = SYSTEM_PATHS[process.platform];
  SYSTEM_PATHS[process.platform] = [alias];
  const config = defaultConfig();
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
  config.modes.subproject = config.modes.project!;
  config.pathRules = [{ path: "credential", scope: "file", read: "ask", write: "deny" }];
  const root = { family: randomUUID(), binding: bindPath(project) };
  const context = { agentDir: dir, home: dir };
  const catalog = resolveCatalog(config, root, context);
  return {
    dir, project, system, resource, alias, credential, config, root, context, catalog,
    close: () => {
      if (baseline) SYSTEM_PATHS[process.platform] = baseline;
      else delete SYSTEM_PATHS[process.platform];
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("exact-file permissions survive leaf replacement while execution identities remain strict", () => {
  const f = fixture();
  try {
    const original = bindPath(f.alias);
    const permission = bindFile(original);
    replace(f.resource);
    assert.throws(() => assertBinding(original), /identity changed/);
    const current = resolvePermissionBinding(permission);
    assert.equal(current.identity.ino, bindPath(f.resource).identity.ino);
    assert.notEqual(current.identity.ino, original.identity.ino);
    assert.equal(current.canonical, original.canonical);
    const owner = new PermissionOwner(f.catalog, { ask: async () => undefined });
    assert.equal(decide(owner.snapshot(), bindPath(f.alias), "read").action, "allow");
    assert.equal(decide(owner.snapshot(), bindPath(f.alias), "write").action, "ask");
    const compiled = compileFilesystem(owner.snapshot()).explicitPolicy!;
    assert.deepEqual(compiled.bindings[f.resource], current);
    assert.equal(compiled.grants.find((grant) => grant.path === f.resource)?.directory, false);
    assert.ok(!compiled.grants.some((grant) => grant.path === f.system));
    replace(f.resource);
    assert.throws(() => assertBinding(compiled.bindings[f.resource]!), /identity changed/);
    assert.doesNotThrow(() => compileFilesystem(owner.snapshot()));
  } finally { f.close(); }
});

test("parent replacement, symlink redirection, and target type changes cannot retarget file authority", () => {
  for (const change of ["parent", "symlink", "directory"] as const) {
    const f = fixture();
    try {
      const permission = bindFile(bindPath(f.alias));
      if (change === "parent") {
        renameSync(f.system, `${f.system}-old`);
        mkdirSync(f.system);
        linkSync(path.join(`${f.system}-old`, "resolver.conf"), f.resource);
        symlinkSync("resolver.conf", f.alias);
      } else if (change === "symlink") {
        writeFileSync(path.join(f.system, "other"), "other");
        unlinkSync(f.alias); symlinkSync("other", f.alias);
      } else {
        unlinkSync(f.resource); mkdirSync(f.resource);
      }
      assert.throws(() => resolvePermissionBinding(permission), /identity changed|target changed/);
      const owner = new PermissionOwner(f.catalog, { ask: async () => undefined });
      assert.notEqual(decide(owner.snapshot(), bindPath(f.alias), "read").action, "allow");
      const compiled = compileFilesystem(owner.snapshot()).explicitPolicy!;
      assert.ok(!compiled.grants.some((g) => g.path === f.resource || g.path === f.system));
    } finally { f.close(); }
  }
});

test("future tree rules acquire current execution identities without losing their original boundary", () => {
  const f = fixture();
  try {
    const target = path.join(f.project, "future-tree");
    f.config.pathRules = [{ path: "future-tree", scope: "tree", write: "deny" }];
    const owner = new PermissionOwner(resolveCatalog(f.config, f.root, f.context), { ask: async () => undefined });
    mkdirSync(target);
    const compiled = compileFilesystem(owner.snapshot()).explicitPolicy!;
    assert.deepEqual(compiled.bindings[target], bindPath(target));
    assert.doesNotThrow(() => assertBinding(compiled.bindings[target]!));
  } finally { f.close(); }
});

test("future file restrictions stay attached to their names through creation, deletion, and replacement", () => {
  const f = fixture();
  try {
    const target = path.join(f.project, "new", "secret");
    f.config.pathRules = [{ path: "new/secret", scope: "file", read: "deny" }];
    const owner = new PermissionOwner(resolveCatalog(f.config, f.root, f.context), { ask: async () => undefined });
    const permission = owner.snapshot().rules[0]!.binding!;
    mkdirSync(path.dirname(target)); writeFileSync(target, "secret");
    for (let i = 0; i < 2; i++) {
      assert.equal(decide(owner.snapshot(), bindPath(target), "read").action, "deny");
      unlinkSync(target);
      assert.equal(decide(owner.snapshot(), bindPath(target), "write").action, "deny");
      writeFileSync(target, "replacement");
    }
    assert.doesNotThrow(() => resolvePermissionBinding(permission));
    renameSync(f.project, `${f.project}-old`); mkdirSync(f.project);
    assert.throws(() => resolvePermissionBinding(permission), /identity changed/);
  } finally { f.close(); }
});

test("file grants and ask/deny rules survive replacement, profile changes, reload, and saved-state restoration", async () => {
  const f = fixture();
  try {
    const binding = { id: randomUUID(), file: path.join(f.dir, "session.jsonl"), cwd: f.project };
    writeFileSync(binding.file, "session");
    const store = new PermissionStore(f.dir);
    store.load(binding, f.project, f.context);
    let prompts = 0;
    const owner = new PermissionOwner(f.catalog, { store, ask: async () => { prompts++; return { lifetime: "project" }; } });
    replace(f.resource); replace(f.credential);
    assert.equal(decide(owner.snapshot(), bindPath(f.credential), "read").action, "ask");
    await owner.authorize([f.credential], "read", "approve file name");
    assert.equal(prompts, 1);
    replace(f.credential);
    owner.select("subproject"); owner.select("project");
    await owner.reload(f.config, undefined, f.context);
    await owner.authorize([f.credential, f.alias], "read", "replacement");
    assert.equal(prompts, 1);
    assert.equal(decide(owner.snapshot(), bindPath(f.credential), "write").action, "deny");
    replace(f.resource); replace(f.credential);
    const restored = new PermissionStore(f.dir).load(binding, f.project, f.context);
    assert.equal(restored.project.exceptions.length, 1);
    const restarted = new PermissionOwner(restored.session!.catalog, { restored: restored.session, ask: async () => undefined });
    await restarted.authorize([f.credential, f.alias], "read", "restored names");
    assert.equal(decide(restarted.snapshot(), bindPath(f.credential), "write").action, "deny");
    const projectOnly = new PermissionStore(f.dir).load(undefined, f.project, f.context);
    assert.equal(projectOnly.project.exceptions.length, 1);
    assert.doesNotThrow(() => compileFilesystem(restarted.snapshot()));
    const state = JSON.parse(readFileSync(path.join(f.dir, "permission-mode", STATE_FILE), "utf8"));
    assert.equal(state.version, 4);
  } finally { f.close(); }
});

test("file-boundary tampering in saved state fails closed", () => {
  const f = fixture();
  try {
    const binding = { id: randomUUID(), file: path.join(f.dir, "session.jsonl"), cwd: f.project };
    writeFileSync(binding.file, "session");
    const store = new PermissionStore(f.dir); store.load(binding, f.project, f.context);
    new PermissionOwner(f.catalog, { store, ask: async () => undefined });
    const file = path.join(f.dir, "permission-mode", STATE_FILE);
    const original = JSON.parse(readFileSync(file, "utf8"));
    for (const target of ["session", "project"] as const) {
      const state = structuredClone(original);
      const catalog = target === "session" ? state.sessions[JSON.stringify(binding.id)].catalog : state.projects[JSON.stringify(f.project)].catalog;
      const permission = catalog.rules[0].binding;
      const parent = bindPath(f.dir);
      permission.parent = { ...parent, identity: { type: parent.identity.type } };
      writeFileSync(file, JSON.stringify(state));
      assert.throws(() => new PermissionStore(f.dir).load(binding, f.project, f.context), /Invalid saved file permission anchor/);
    }
  } finally { f.close(); }
});

test("old saved authority is left untouched and never restored into the new format", () => {
  const f = fixture();
  try {
    const store = new PermissionStore(f.dir);
    const old = path.join(store.directory, "state-v2.json");
    writeFileSync(old, '{"version":2,"sessions":{"old":{"mode":"yolo"}},"projects":{}}', { mode: 0o600 });
    const before = readFileSync(old, "utf8");
    const binding = { id: "old", file: path.join(f.dir, "session.jsonl"), cwd: f.project };
    writeFileSync(binding.file, "session");
    const restored = store.load(binding, f.project, f.context);
    assert.equal(restored.session, undefined);
    assert.deepEqual(restored.project, { generation: 0, grants: [], exceptions: [] });
    const owner = new PermissionOwner(f.catalog, { store, ask: async () => undefined });
    assert.equal(owner.snapshot().mode, "project");
    assert.equal(owner.network.snapshot().restricted, false);
    assert.equal(readFileSync(old, "utf8"), before);
    assert.equal(JSON.parse(readFileSync(path.join(store.directory, STATE_FILE), "utf8")).version, 4);
  } finally { f.close(); }
});
