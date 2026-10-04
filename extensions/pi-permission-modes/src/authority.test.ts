import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner, StaleAuthorityError, type ApprovalAnswer } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { PermissionStore, STATE_FILE } from "./permission-state.ts";
import { resolveCatalog } from "./policy.ts";

function fixture() {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-owner-"))).canonical;
  const project = path.join(dir, "project");
  mkdirSync(project);
  const outside = path.join(dir, "outside");
  mkdirSync(outside);
  const config = defaultConfig();
  config.network.default = "restricted";
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  config.pathRules = [];
  const root = { family: randomUUID(), binding: bindPath(project) };
  const context = { agentDir: dir, home: dir };
  const catalog = resolveCatalog(config, root, context);
  return {
    dir,
    project,
    outside,
    config,
    root,
    context,
    catalog,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("stale asynchronous approvals cannot reinstall revoked authority", async () => {
  const f = fixture();
  let answer!: (value: ApprovalAnswer | undefined) => void;
  const owner = new PermissionOwner(f.catalog, {
    ask: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  try {
    const pending = owner.requestDirectory(f.outside, "read", "outside read");
    owner.revoke();
    answer({ lifetime: "session" });
    await assert.rejects(pending, StaleAuthorityError);
    assert.equal(owner.snapshot().grants.length, 0);
    const stale = owner.snapshot();
    owner.select("yolo");
    assert.throws(() => owner.check(stale.revision), StaleAuthorityError);
    assert.equal(owner.network.snapshot().restricted, true);
  } finally {
    f.close();
  }
});

test("protected session restore binds ID, canonical file, and root; stale project writers fail", async () => {
  const f = fixture();
  try {
    const sessionFile = path.join(f.dir, "session.jsonl");
    writeFileSync(sessionFile, "session");
    const binding = { id: "session", file: sessionFile, cwd: f.project };
    const store = new PermissionStore(f.dir);
    store.load(binding, f.project);
    const owner = new PermissionOwner(f.catalog, { store, ask: async () => ({ lifetime: "project" }) });
    await owner.requestDirectory(f.outside, "read", "remember");
    const second = new PermissionStore(f.dir);
    const restored = second.load(binding, f.project);
    assert.equal(restored.project.grants.length, 1);
    const other = new PermissionOwner(f.catalog, {
      store: second,
      restored: restored.session,
      grants: restored.project.grants,
      ask: async () => ({ lifetime: "project" }),
    });
    other.revoke();
    assert.throws(() => owner.revoke(), /another session/);
    assert.equal(new PermissionStore(f.dir).load(binding, f.project).project.grants.length, 0);
    assert.throws(
      () => new PermissionStore(f.dir).load({ ...binding, file: path.join(f.dir, "copied.jsonl") }, f.project),
      /binding mismatch/,
    );
    chmodSync(path.join(f.dir, "permission-mode", STATE_FILE), 0o644);
    assert.throws(() => new PermissionStore(f.dir).load(binding, f.project), /private/);
  } finally {
    f.close();
  }
});

test("failed persistence grants nothing and invalid reload blocks rather than retaining access", async () => {
  const f = fixture();
  try {
    const store = new PermissionStore(f.dir);
    store.load(undefined, f.project);
    const owner = new PermissionOwner(f.catalog, { store, ask: async () => ({ lifetime: "project" }) });
    writeFileSync(path.join(f.dir, "permission-mode", ".authority.lock"), "orphan", { mode: 0o600 });
    await assert.rejects(owner.requestDirectory(f.outside, "write", "failure"), /locked/);
    assert.equal(owner.snapshot().grants.length, 0);
    rmSync(path.join(f.dir, "permission-mode", ".authority.lock"));
    const release = owner.attachChild(() => release());
    const invalid = { ...f.config, modes: {} };
    await assert.rejects(owner.reload(invalid, undefined, f.context), /removed/);
    assert.throws(() => owner.snapshot(), /unavailable/);
  } finally {
    f.close();
  }
});
