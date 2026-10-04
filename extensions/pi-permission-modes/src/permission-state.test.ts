import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { bindPath, resolvePermissionBinding } from "./paths.ts";
import { LEGACY_STATE_FILE, PermissionStore, STATE_FILE } from "./permission-state.ts";
import { resolveCatalog } from "./policy.ts";

async function fixture(runtime = false) {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-saved-"))).canonical;
  const project = path.join(dir, "project"); const outside = path.join(dir, "outside");
  const piPackage = path.join(dir, "pi-runtime");
  for (const file of [project, outside, piPackage, path.join(project, "docs")]) mkdirSync(file);
  writeFileSync(path.join(project, "credential"), "secret");
  const config = defaultConfig();
  config.network.deniedDomains = ["blocked.example"];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: runtime ? ["pi"] : [] };
  config.modes.subproject = config.modes.project!;
  config.modes.docs = { label: "Docs", color: "accent", filesystem: { kind: "scoped", readOnly: ["docs"], readWrite: [], resourceReads: [] } };
  config.pathRules = [{ path: "credential", scope: "file", read: "ask" }];
  const root = { family: randomUUID(), binding: bindPath(project) }; const context = { agentDir: dir, home: dir, piPackage };
  const catalog = resolveCatalog(config, root, context);
  const binding = { id: randomUUID(), file: path.join(dir, "session.jsonl"), cwd: project };
  writeFileSync(binding.file, "session");
  const store = new PermissionStore(dir); store.load(binding, project, context);
  const owner = new PermissionOwner(catalog, { store, ask: async () => ({ lifetime: "project" }) });
  await owner.requestDirectory(outside, runtime ? "write" : "read", "remember directory");
  await owner.authorize([path.join(project, "credential")], "read", "remember exception");
  owner.select("docs");
  const file = path.join(dir, "permission-mode", STATE_FILE);
  return { dir, project, outside, piPackage, context, binding, owner, file, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("fresh launches restore pathname authority with new identities while live owners remain pinned", async () => {
  const f = await fixture();
  try {
    const restored = new PermissionStore(f.dir).load(f.binding, f.project, f.context);
    assert.equal(restored.session?.mode, "docs");
    assert.equal(restored.project.grants.length, 1);
    assert.equal(restored.project.exceptions.length, 1);
    const projectOnly = new PermissionStore(f.dir).load(undefined, f.project, f.context);
    assert.equal(projectOnly.session, undefined);
    assert.equal(projectOnly.project.catalog?.profiles.docs?.grants[0]?.binding.canonical, path.join(f.project, "docs"));
    const previousRoot = restored.session!.catalog.root.binding.identity;
    renameSync(f.project, `${f.project}-old`); mkdirSync(f.project);
    mkdirSync(path.join(f.project, "docs")); writeFileSync(path.join(f.project, "credential"), "new secret");
    renameSync(f.outside, `${f.outside}-old`); mkdirSync(f.outside);
    const restarted = new PermissionStore(f.dir).load(f.binding, f.project, f.context);
    assert.notDeepEqual(restarted.session!.catalog.root.binding.identity, previousRoot);
    assert.deepEqual(resolvePermissionBinding(restarted.project.grants[0]!.binding).identity, bindPath(f.outside).identity);
    assert.equal(restarted.session?.mode, "docs");
    assert.equal(restarted.project.exceptions.length, 1);
    assert.deepEqual(restarted.session!.network, restored.session!.network);
    assert.throws(() => f.owner.snapshot(), /identity changed/);
    assert.doesNotThrow(() => new PermissionStore(f.dir).load(undefined, f.project, f.context));
  } finally { f.close(); }
});

test("saved catalogs preserve strict process mode and legacy omissions restore as compatible", async () => {
  const f = await fixture();
  try {
    const document = JSON.parse(readFileSync(f.file, "utf8"));
    const catalogs = [document.projects[JSON.stringify(f.project)].catalog, document.sessions[JSON.stringify(f.binding.id)].catalog];
    for (const catalog of catalogs) catalog.config.processMode = "strict";
    writeFileSync(f.file, JSON.stringify(document));
    let restored = new PermissionStore(f.dir).load(f.binding, f.project, f.context);
    assert.equal(new PermissionOwner(restored.session!.catalog, { restored: restored.session, ask: async () => undefined }).snapshot().processMode, "strict");
    for (const catalog of catalogs) delete catalog.config.processMode;
    writeFileSync(f.file, JSON.stringify(document));
    restored = new PermissionStore(f.dir).load(f.binding, f.project, f.context);
    assert.equal(new PermissionOwner(restored.session!.catalog, { restored: restored.session, ask: async () => undefined }).snapshot().processMode, "compatible");
  } finally { f.close(); }
});

test("user strict process mode survives saved-catalog reconstruction", async () => {
  const f = await fixture();
  try {
    const store = new PermissionStore(f.dir);
    const restored = store.load(f.binding, f.project, f.context);
    const catalog = resolveCatalog({ ...restored.session!.catalog.config, processMode: "strict" }, restored.session!.catalog.root, f.context, restored.session!.catalog);
    const owner = new PermissionOwner(catalog, { store, restored: restored.session, ask: async () => undefined });
    assert.equal(owner.snapshot().processMode, "strict");
    const restarted = new PermissionStore(f.dir).load(f.binding, f.project, f.context);
    assert.equal(restarted.session!.catalog.config.processMode, "strict");
  } finally { f.close(); }
});

test("saved authority omits inode snapshots and runtime resources without changing project generations", async () => {
  const f = await fixture(true);
  try {
    const before = JSON.parse(readFileSync(f.file, "utf8"));
    assert.equal(before.version, 4);
    assert.doesNotMatch(readFileSync(f.file, "utf8"), /"(?:dev|ino|birthtimeNs|runtime)":/);
    const projectKey = JSON.stringify(f.project);
    assert.ok(!before.projects[projectKey].catalog.profiles.project.grants.some((grant: { definition: string }) => grant.definition === `resource:${f.piPackage}`));
    const store = new PermissionStore(f.dir);
    const restored = store.load(f.binding, f.project, f.context);
    new PermissionOwner(restored.session!.catalog, { store, restored: restored.session, ask: async () => undefined });
    assert.equal(JSON.parse(readFileSync(f.file, "utf8")).projects[projectKey].generation, before.projects[projectKey].generation);
  } finally { f.close(); }
});

test("legacy state is rejected untouched instead of migrating authority", async () => {
  const f = await fixture(true);
  try {
    const restored = new PermissionStore(f.dir).load(f.binding, f.project, f.context);
    const document = JSON.parse(readFileSync(f.file, "utf8"));
    document.version = 3;
    const projectKey = JSON.stringify(f.project); const sessionKey = JSON.stringify(f.binding.id);
    document.projects[projectKey] = restored.project;
    document.sessions[sessionKey] = restored.session;
    const otherBinding = { ...f.binding, id: randomUUID() };
    document.sessions[JSON.stringify(otherBinding.id)] = { ...restored.session, binding: otherBinding };
    const legacy = path.join(path.dirname(f.file), LEGACY_STATE_FILE);
    const original = JSON.stringify(document, (field, value) => field === "runtime" ? undefined : value);
    writeFileSync(legacy, original, { mode: 0o600 }); rmSync(f.file);
    renameSync(f.piPackage, `${f.piPackage}-old`); mkdirSync(f.piPackage);
    renameSync(f.outside, `${f.outside}-old`); mkdirSync(f.outside);
    assert.throws(() => new PermissionStore(f.dir).load(f.binding, f.project, f.context), /Unsupported legacy.*reset/);
    assert.equal(readFileSync(legacy, "utf8"), original);
    assert.equal(fs.existsSync(f.file), false);
  } finally { f.close(); }
});

test("fresh bindings still reject changed symlink destinations", async () => {
  const f = await fixture();
  try {
    renameSync(f.outside, `${f.outside}-old`);
    symlinkSync(f.project, f.outside);
    assert.throws(() => new PermissionStore(f.dir).load(f.binding, f.project, f.context), /Saved path target changed/);
  } finally { f.close(); }
});

test("malformed saved authority cannot widen configuration or bypass remembered-catalog validation", async () => {
  const f = await fixture();
  try {
    const original = JSON.parse(readFileSync(f.file, "utf8"));
    const projectKey = JSON.stringify(f.project); const sessionKey = JSON.stringify(f.binding.id);
    const mutations = [
      (d: typeof original) => { d.projects[projectKey].catalog.profiles.project.kind = "unrestricted"; },
      (d: typeof original) => { d.projects[projectKey].catalog.profiles.docs.grants[0].access = "write"; },
      (d: typeof original) => { delete d.projects[projectKey].catalog; },
      (d: typeof original) => { d.projects[projectKey].grants[0].lifetime = "session"; },
      (d: typeof original) => { d.projects[projectKey].grants[0].command = "legacy approval"; },
      (d: typeof original) => { d.projects[projectKey].exceptions[0].ruleId = "orphan"; },
      (d: typeof original) => { d.projects[projectKey].catalog.rules[0].read = "deny"; },
      (d: typeof original) => { d.projects[projectKey].catalog.root.binding.canonical = f.dir; },
      (d: typeof original) => { d.sessions[sessionKey].network.revision = -1; },
      (d: typeof original) => { d.sessions[sessionKey].network.deniedDomains = []; },
      (d: typeof original) => { d.sessions[sessionKey].mode = "removed-custom-mode"; },
      (d: typeof original) => { d.sessions[sessionKey].unexpected = true; },
    ];
    for (const mutate of mutations) {
      const document = structuredClone(original); mutate(document); writeFileSync(f.file, JSON.stringify(document));
      assert.throws(() => new PermissionStore(f.dir).load(f.binding, f.project, f.context), /[Ii]nvalid|[Ss]aved|incompatible|Malformed/);
    }
  } finally { f.close(); }
});

test("current network policy cannot inherit stale open authority or legitimize a corrupt saved mode", async () => {
  const f = await fixture();
  try {
    const document = JSON.parse(readFileSync(f.file, "utf8"));
    const config = structuredClone(document.projects[JSON.stringify(f.project)].catalog.config);
    config.network.default = "restricted";
    const restored = new PermissionStore(f.dir).load(f.binding, f.project, f.context, config);
    const owner = new PermissionOwner(restored.session!.catalog, { restored: restored.session, ask: async () => undefined });
    assert.equal(owner.network.snapshot().restricted, true);
    assert.equal(await owner.network.decide("unlisted.invalid"), false);
    const mode = "added_yolo";
    document.sessions[JSON.stringify(f.binding.id)].mode = mode;
    writeFileSync(f.file, JSON.stringify(document));
    config.modes[mode] = { label: "Added", color: "error", filesystem: { kind: "unrestricted" } };
    assert.throws(() => new PermissionStore(f.dir).load(f.binding, f.project, f.context, config), /Invalid saved session mode/);
  } finally { f.close(); }
});

test("current user policy supersedes obsolete cache targets and prunes only obsolete receipts", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.file, "utf8");
    const document = JSON.parse(before);
    const config = structuredClone(document.projects[JSON.stringify(f.project)].catalog.config);
    config.pathRules = [];
    rmSync(path.join(f.project, "credential")); mkdirSync(path.join(f.project, "credential"));
    const restored = new PermissionStore(f.dir).load(f.binding, f.project, f.context, config);
    assert.equal(restored.session!.catalog.rules.length, 0);
    assert.equal(restored.project.exceptions.length, 0);
    assert.equal(restored.session!.exceptions.length, 0);
    assert.equal(restored.project.grants.length, 1);
    assert.equal(readFileSync(f.file, "utf8"), before);
    document.projects[JSON.stringify(f.project)].catalog.config.version = 2;
    const unsupported = JSON.stringify(document); writeFileSync(f.file, unsupported);
    assert.throws(() => new PermissionStore(f.dir).load(f.binding, f.project, f.context, config), /only version 3/);
    assert.equal(readFileSync(f.file, "utf8"), unsupported);
  } finally { f.close(); }
});

test("post-commit lock cleanup failure does not roll back memory or report a committed revoke as failed", async (t) => {
  const f = await fixture();
  const unlink = fs.unlinkSync;
  try {
    t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
      if (String(file).endsWith(".authority.lock")) throw new Error("injected cleanup failure");
      return unlink(file);
    });
    syncBuiltinESMExports();
    assert.doesNotThrow(() => f.owner.revoke());
    assert.equal(f.owner.snapshot().grants.length, 0);
    assert.equal(JSON.parse(readFileSync(f.file, "utf8")).projects[JSON.stringify(f.project)].grants.length, 0);
    assert.throws(() => new PermissionStore(f.dir).load(f.binding, f.project, f.context), /locked/);
    t.mock.restoreAll(); syncBuiltinESMExports();
    unlink(path.join(f.dir, "permission-mode", ".authority.lock"));
    assert.equal(new PermissionStore(f.dir).load(f.binding, f.project, f.context).project.grants.length, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});
