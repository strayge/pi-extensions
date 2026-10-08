import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig, mergeConfig } from "./config-load.ts";
import { assertBinding, bindPath, configPath, modelPath, readPath } from "./paths.ts";
import { automaticResources, decide, resolveCatalog, SYSTEM_PATHS } from "./policy.ts";
import type { FilesystemSnapshot } from "./schema.ts";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-core-"));
  const root = { family: randomUUID(), binding: bindPath(dir) };
  const config = defaultConfig();
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject!.filesystem = { kind: "scoped", readOnly: [], readWrite: [".."], resourceReads: [] };
  config.pathRules = [];
  const context = { agentDir: dir, home: dir };
  return { dir, root, config, context, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Command Line Tools belong only to the macOS system-resource baseline", () => {
  const tools = "/Library/Developer/CommandLineTools";
  assert.ok(SYSTEM_PATHS.darwin!.includes(tools));
  assert.ok(!SYSTEM_PATHS.linux!.includes(tools));
});

test("macOS system resources discover optional read-only Command Line Tools without granting their parent", { skip: process.platform !== "darwin" }, (t) => {
  const f = fixture(); const tools = "/Library/Developer/CommandLineTools";
  const exists = fs.existsSync;
  try {
    if (exists(tools)) {
      const filesystem = f.config.modes.project!.filesystem;
      if (filesystem.kind !== "scoped") assert.fail("Expected a scoped profile");
      filesystem.resourceReads = ["system"];
      const owner = new PermissionOwner(resolveCatalog(f.config, f.root, f.context), { ask: async () => undefined });
      const target = bindPath(tools);
      const grant = owner.snapshot().profile.grants.find((g) => g.definition === `resource:${tools}`)!;
      assert.equal(grant.access, "read"); assert.equal(grant.scope, "tree"); assert.equal(grant.runtime, true);
      assert.equal(decide(owner.snapshot(), target, "read").action, "allow");
      assert.equal(decide(owner.snapshot(), target, "write").action, "ask");
      assert.equal(decide(owner.snapshot(), bindPath(path.dirname(tools)), "read").action, "ask");
      filesystem.resourceReads = [];
      const optedOut = new PermissionOwner(resolveCatalog(f.config, f.root, f.context), { ask: async () => undefined });
      assert.equal(decide(optedOut.snapshot(), target, "read").action, "ask");
    }
    t.mock.method(fs, "existsSync", (file: fs.PathLike) => String(file) !== tools && exists(file));
    syncBuiltinESMExports();
    assert.ok(!automaticResources(["system"], f.context).some((g) => g.definition === `resource:${tools}`));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.dispose(); }
});

test("macOS catalogs inspect dependencies once per build and do not cache them across builds", { skip: process.platform !== "darwin" }, (t) => {
  const f = fixture(); const spawn = childProcess.spawnSync;
  try {
    const runtime = path.join(f.dir, "runtime"); const agent = path.join(f.dir, "agent"); const pi = path.join(f.dir, "pi");
    for (const directory of [runtime, agent, pi]) mkdirSync(directory);
    const node = path.join(bindPath(runtime).canonical, "node");
    const first = path.join(bindPath(runtime).canonical, "first.dylib");
    const second = path.join(bindPath(runtime).canonical, "second.dylib");
    for (const file of [node, first, second]) writeFileSync(file, "fixture");
    let dependency = first; let inspections = 0;
    t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawn>) => {
      if (args[0] !== "/usr/bin/otool") return spawn(...args);
      inspections++;
      const [flag, file] = args[1] as string[];
      const stdout = flag === "-l" ? "" : `${file}:\n${file === node ? `\t${dependency} (compatibility version 1.0.0, current version 1.0.0)\n` : ""}`;
      return { pid: 0, output: [], stdout, stderr: "", status: 0, signal: null };
    });
    syncBuiltinESMExports();
    for (const name of ["project", "subproject"])
      f.config.modes[name]!.filesystem = { kind: "scoped", readOnly: [], readWrite: [], resourceReads: ["pi"] };
    const context = { ...f.context, agentDir: agent, piPackage: pi, node };
    const initial = resolveCatalog(f.config, f.root, context);
    assert.equal(inspections, 4);
    assert.deepEqual(initial.profiles.project!.grants, initial.profiles.subproject!.grants);
    const grant = initial.profiles.project!.grants.find((item) => item.binding.canonical === first)!;
    assert.equal(grant.scope, "file"); assert.equal(grant.access, "read"); assert.equal(grant.runtime, true);
    assert.ok(!initial.profiles.project!.grants.some((item) => item.binding.canonical === path.dirname(node)));
    dependency = second;
    const refreshed = resolveCatalog(f.config, f.root, context, initial);
    assert.equal(inspections, 8);
    assert.ok(refreshed.profiles.project!.grants.some((item) => item.binding.canonical === second));
    assert.ok(!refreshed.profiles.project!.grants.some((item) => item.binding.canonical === first));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.dispose(); }
});

test("v3 rejects unsupported versions and replaces explicit user arrays", () => {
  for (const version of [undefined, null, 0, 4, "3"])
    assert.throws(() => mergeConfig(defaultConfig(), { version, modes: {} }), /Unsupported permission configuration version/);
  assert.throws(
    () => mergeConfig(defaultConfig(), { version: 3, modes: { project: { permission: {} } } }),
    /unknown field/,
  );
  assert.deepEqual(mergeConfig(defaultConfig(), { version: 3, pathRules: [] }).pathRules, []);
});

test("trusted user policy selects process containment independently of filesystem rules", () => {
  const f = fixture();
  try {
    const catalog = resolveCatalog(f.config, f.root, f.context);
    const strict = resolveCatalog({ ...f.config, processMode: "strict" }, f.root, f.context, catalog);
    assert.equal(new PermissionOwner(strict, { ask: async () => undefined }).snapshot().processMode, "strict");
    assert.equal(new PermissionOwner(catalog, { ask: async () => undefined }).snapshot().processMode, "compatible");
  } finally { f.dispose(); }
});

test("missing creation is distinct from dangling final and intermediate links", () => {
  const f = fixture();
  try {
    assert.deepEqual(bindPath(path.join(f.dir, "new", "file")).missing, ["new", "file"]);
    symlinkSync("missing", path.join(f.dir, "bad"));
    assert.throws(() => bindPath(path.join(f.dir, "bad")), /Dangling/);
    assert.throws(() => bindPath(path.join(f.dir, "bad", "child")), /Dangling/);
    mkdirSync(path.join(f.dir, "real"));
    symlinkSync("real", path.join(f.dir, "good"));
    assert.equal(bindPath(path.join(f.dir, "good", "new")).canonical, path.join(f.root.binding.canonical, "real", "new"));
  } finally {
    f.dispose();
  }
});

test("root identities and descriptor-relative parent resolution cannot be retargeted", () => {
  const f = fixture();
  try {
    assert.equal(configPath("..", f.root, f.dir).canonical, path.dirname(f.root.binding.canonical));
    const moved = `${f.dir}-moved`;
    renameSync(f.dir, moved);
    mkdirSync(f.dir);
    assert.throws(() => assertBinding(f.root.binding), /identity changed/);
    assert.throws(() => configPath(".", f.root, f.dir), /identity changed/);
    rmSync(moved, { recursive: true });
  } finally {
    f.dispose();
  }
});

test("read fallback is selected once without normalizing a native filename again", () => {
  const f = fixture();
  try {
    const exact = path.join(f.dir, "Shot 1\u202FPM.png");
    writeFileSync(exact, "selected");
    const selected = readPath(modelPath("Shot 1 PM.png", f.dir));
    assert.equal(selected, exact);
    assert.equal(readFileSync(selected, "utf8"), "selected");
  } finally {
    f.dispose();
  }
});

test("directory grants never satisfy rule exceptions and write includes read restrictions", () => {
  const f = fixture();
  try {
    f.config.pathRules = [{ path: "secret", scope: "file", read: "ask" }];
    const catalog = resolveCatalog(f.config, f.root, f.context);
    const snapshot: FilesystemSnapshot = {
      revision: 0,
      root: f.root,
      mode: "project",
      profile: catalog.profiles.project!,
      rules: catalog.rules,
      grants: [],
      exceptions: [],
    };
    const target = bindPath(path.join(f.dir, "secret"));
    const decision = decide(snapshot, target, "write");
    assert.equal(decision.action, "ask");
    assert.equal(decision.directory, false);
    assert.equal(decision.exceptions[0]?.access, "read");
    assert.equal(
      decide(
        {
          ...snapshot,
          exceptions: [{ id: randomUUID(), ruleId: catalog.rules[0]!.id, access: "read", lifetime: "session" }],
        },
        target,
        "write",
      ).action,
      "allow",
    );
  } finally {
    f.dispose();
  }
});

test("reload rediscovers exact runtime resources but retains agent-data boundaries and path rules", async () => {
  const f = fixture();
  try {
    const runtime = path.join(f.dir, "pi-runtime"); const agentDir = path.join(f.dir, "agent");
    mkdirSync(runtime); mkdirSync(agentDir);
    const canonicalRuntime = bindPath(runtime).canonical;
    const context = { ...f.context, agentDir, piPackage: runtime };
    f.config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["pi"] };
    f.config.pathRules = [{ path: path.join(runtime, "secret"), scope: "file", read: "deny" }];
    const owner = new PermissionOwner(resolveCatalog(f.config, f.root, context), { ask: async () => undefined });
    const old = owner.snapshot().profile.grants.find((grant) => grant.binding.canonical === canonicalRuntime)!;
    renameSync(runtime, `${runtime}-old`); mkdirSync(runtime);
    assert.throws(() => assertBinding(old.binding as ReturnType<typeof bindPath>), /identity changed/);
    // An explicit rule anchor remains durable even inside a runtime package.
    await assert.rejects(owner.reload(f.config, undefined, context), /identity changed/);
    rmSync(runtime, { recursive: true }); renameSync(`${runtime}-old`, runtime);
    await owner.reload(f.config, undefined, context);
    f.config.pathRules = [];
    await owner.reload(f.config, undefined, context);
    renameSync(runtime, `${runtime}-old`); mkdirSync(runtime);
    await owner.reload(f.config, undefined, context);
    const current = owner.snapshot().profile.grants.find((grant) => grant.binding.canonical === canonicalRuntime)!;
    assert.deepEqual(current.binding, bindPath(runtime));
    assert.notDeepEqual(current.binding, old.binding);
    assert.ok(!owner.snapshot().profile.grants.some((grant) => grant.binding.canonical === path.dirname(f.dir)));
    renameSync(agentDir, `${agentDir}-old`); mkdirSync(agentDir);
    await assert.rejects(owner.reload(f.config, undefined, context), /identity changed/);
  } finally { f.dispose(); }
});

test("user policy reload retains frozen lexical rule boundaries", async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.dir, "first")); mkdirSync(path.join(f.dir, "second"));
    symlinkSync("first", path.join(f.dir, "alias"));
    f.config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["alias"], resourceReads: [] };
    f.config.pathRules = [{ path: "alias/secret", scope: "file", read: "ask" }];
    const global = resolveCatalog(f.config, f.root, f.context);
    const replacement = resolveCatalog(f.config, f.root, f.context, global);
    assert.equal(replacement.rules[0]!.id, global.rules[0]!.id);
    const owner = new PermissionOwner(replacement, { ask: async () => undefined });
    unlinkSync(path.join(f.dir, "alias")); symlinkSync("second", path.join(f.dir, "alias"));
    await assert.rejects(owner.reload(f.config, undefined, f.context), /identity changed/);
    assert.throws(() => owner.snapshot(), /unavailable/);
  } finally { f.dispose(); }
});
