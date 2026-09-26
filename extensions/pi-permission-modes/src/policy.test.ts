import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig, mergeConfig } from "./config-load.ts";
import { assertBinding, bindPath, configPath, modelPath, readPath } from "./paths.ts";
import { decide, resolveCatalog, tightenCatalog } from "./policy.ts";
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

test("v2 rejects legacy fields and replaces explicit global arrays", () => {
  assert.throws(() => mergeConfig(defaultConfig(), { modes: {} }), /Legacy/);
  assert.throws(
    () => mergeConfig(defaultConfig(), { version: 2, modes: { project: { permission: {} } } }),
    /unknown field/,
  );
  assert.deepEqual(mergeConfig(defaultConfig(), { version: 2, pathRules: [] }).pathRules, []);
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
    assert.equal(bindPath(path.join(f.dir, "good", "new")).canonical, path.join(f.dir, "real", "new"));
  } finally {
    f.dispose();
  }
});

test("root identities and descriptor-relative parent resolution cannot be retargeted", () => {
  const f = fixture();
  try {
    assert.equal(configPath("..", f.root, f.dir).canonical, path.dirname(f.dir));
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

test("repository narrowing retains omitted global identities and cannot replace lexical rules", async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.dir, "first")); mkdirSync(path.join(f.dir, "second"));
    symlinkSync("first", path.join(f.dir, "alias"));
    f.config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["alias"], resourceReads: [] };
    f.config.pathRules = [{ path: "alias/secret", scope: "file", read: "ask" }];
    const global = resolveCatalog(f.config, f.root, f.context);
    assert.throws(() => tightenCatalog(global, { version: 2, pathRules: [{ path: "first/secret", scope: "file", read: "ask" }] }, f.context), /remove global path rules/);
    const narrowed = tightenCatalog(global, { version: 2, modes: { project: { filesystem: { kind: "scoped", readOnly: [], readWrite: [], resourceReads: [] } } } }, f.context);
    assert.equal(narrowed.rules[0]!.id, global.rules[0]!.id);
    const owner = new PermissionOwner(narrowed, { ask: async () => undefined });
    unlinkSync(path.join(f.dir, "alias")); symlinkSync("second", path.join(f.dir, "alias"));
    await assert.rejects(owner.reload(f.config, undefined, f.context), /identity changed/);
    assert.throws(() => owner.snapshot(), /unavailable/);
  } finally { f.dispose(); }
});
