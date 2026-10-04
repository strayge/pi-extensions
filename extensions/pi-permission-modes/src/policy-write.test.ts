import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionOwner, StaleAuthorityError } from "./approvals.ts";
import { defaultConfig, loadConfig } from "./config-load.ts";
import { createDirectTools } from "./direct-tools.ts";
import { bindFile, bindPath } from "./paths.ts";
import { PermissionStore, STATE_FILE } from "./permission-state.ts";
import { GlobalPolicyWriter } from "./policy-write.ts";
import { decide, resolveCatalog } from "./policy.ts";
import type { PermissionModeConfig } from "./schema.ts";

function fixture(change?: (config: PermissionModeConfig, outside: string) => void) {
  const directory = bindPath(mkdtempSync(path.join(tmpdir(), "permission-global-"))).canonical;
  const project = path.join(directory, "project"); const outside = path.join(directory, "outside");
  mkdirSync(project); mkdirSync(outside);
  const config = defaultConfig();
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!; config.pathRules = [];
  change?.(config, outside);
  const context = { agentDir: directory, home: directory, piPackage: project };
  const store = new PermissionStore(directory); store.load(undefined, project, context, config);
  const file = path.join(store.directory, "permission-mode.json");
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const root = { family: randomUUID(), binding: bindPath(project) };
  const writer = new GlobalPolicyWriter(context); const warnings: string[] = [];
  const owner = new PermissionOwner(resolveCatalog(config, root, context), { store, policyWriter: writer, ask: async () => ({ lifetime: "global" }), confirmGlobal: async () => true, warn: (message) => warnings.push(message) });
  return { directory, project, outside, config, context, root, store, file, writer, warnings, owner, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("global exact-file saves publish immediately, consolidate upgrades and revoke the current declaration", async () => {
  const f = fixture();
  try {
    const file = path.join(f.outside, "notes"); writeFileSync(file, "NOTE");
    const network = f.owner.network.snapshot();
    await f.owner.requestGrant(file, "read", "global read");
    assert.equal(f.owner.snapshot().grants.length, 0);
    assert.equal(decide(f.owner.snapshot(), bindPath(file), "read").action, "allow");
    assert.equal(decide(f.owner.snapshot(), bindPath(f.outside), "read").action, "ask");
    await f.owner.requestGrant(file, "write", "global upgrade");
    const saved = loadConfig(f.directory, f.directory).global;
    assert.deepEqual(saved.pathRules, [{ path: file, scope: "file", read: "allow", write: "allow" }]);
    assert.deepEqual(saved.modes, f.config.modes);
    assert.deepEqual(f.owner.network.snapshot(), network);
    const id = f.owner.snapshot().rules[0]!.id;
    rmSync(file); mkdirSync(file);
    await f.owner.changeGlobal({ kind: "revoke", id });
    assert.deepEqual(loadConfig(f.directory, f.directory).global.pathRules, []);
    assert.equal(f.owner.snapshot().rules.length, 0);
    await assert.rejects(f.owner.changeGlobal({ kind: "revoke", id }), /stale or unavailable/);
  } finally { f.close(); }
});

test("global saves consolidate canonical aliases and explicitly rebind repaired positive declarations", async () => {
  for (const repaired of [false, true]) {
    const f = fixture((config, outside) => {
      const file = path.join(outside, "notes");
      if (repaired) mkdirSync(file);
      else { writeFileSync(file, "NOTE"); symlinkSync("notes", path.join(outside, "alias")); }
      config.pathRules = [{ path: file, scope: "file", read: "allow" }, ...(repaired ? [] : [{ path: path.join(outside, "alias"), scope: "file" as const, read: "allow" as const }])];
    });
    try {
      const file = path.join(f.outside, "notes");
      if (repaired) { rmSync(file, { recursive: true }); writeFileSync(file, "REPAIRED"); }
      await f.owner.requestGrant(file, "write", "explicit reapproval");
      assert.deepEqual(loadConfig(f.directory, f.directory).global.pathRules, [{ path: file, scope: "file", read: "allow", write: "allow" }]);
      assert.equal(f.owner.snapshot().rules.length, 1);
      assert.equal(decide(f.owner.snapshot(), bindPath(file), "write").action, "allow");
    } finally { f.close(); }
  }
});

test("global clear removes blocked and dormant positives without usable targets and preserves restrictions", async () => {
  const f = fixture((config, outside) => {
    const directory = path.join(outside, "wrong-type"); mkdirSync(directory);
    writeFileSync(path.join(outside, "original"), "ORIGINAL");
    writeFileSync(path.join(outside, "other"), "OTHER");
    symlinkSync("original", path.join(outside, "redirect"));
    mkdirSync(path.join(outside, "pinned")); writeFileSync(path.join(outside, "pinned", "file"), "PINNED");
    config.pathRules = [
      { path: path.join(outside, "redirect"), scope: "file", read: "allow" },
      { path: path.join(outside, "pinned", "file"), scope: "file", write: "allow" },
      { path: path.join(outside, "missing"), scope: "file", read: "allow" },
      { path: directory, scope: "file", write: "allow" },
      { path: outside, scope: "tree", read: "ask" },
    ];
  });
  try {
    rmSync(path.join(f.outside, "redirect")); symlinkSync("other", path.join(f.outside, "redirect"));
    renameSync(path.join(f.outside, "pinned"), path.join(f.outside, "pinned-old"));
    mkdirSync(path.join(f.outside, "pinned")); writeFileSync(path.join(f.outside, "pinned", "file"), "REPLACED");
    await f.owner.changeGlobal({ kind: "clear" });
    assert.deepEqual(loadConfig(f.directory, f.directory).global.pathRules, [{ path: f.outside, scope: "tree", read: "ask" }]);
    assert.equal(f.owner.snapshot().grants.length, 0);
  } finally { f.close(); }
});

test("global saves cannot borrow receipts or yolo access to overwrite equal restrictions", async () => {
  const f = fixture((config, outside) => {
    writeFileSync(path.join(outside, "notes"), "NOTE");
    config.pathRules = [{ path: path.join(outside, "notes"), scope: "file", read: "ask" }];
  });
  try {
    f.owner.ask = async () => ({ lifetime: "session" });
    await f.owner.authorize([path.join(f.outside, "notes")], "read", "receipt");
    const before = readFileSync(f.file, "utf8");
    f.owner.select("yolo");
    await assert.rejects(f.owner.changeGlobal({ kind: "save", scope: "file", binding: bindFile(bindPath(path.join(f.outside, "notes"))), access: "read" }), /remains ask.*manually/);
    assert.equal(readFileSync(f.file, "utf8"), before);
  } finally { f.close(); }
});

test("global removals preserve surviving restriction pins before and during confirmation", async () => {
  for (const [redirectAt, multiple] of [["prepare", false], ["confirm", false], ["prepare", true], ["confirm", true]] as const) {
    const f = fixture((config, outside) => {
      writeFileSync(path.join(outside, "original"), "ORIGINAL"); writeFileSync(path.join(outside, "other"), "OTHER");
      symlinkSync("original", path.join(outside, "alias"));
      config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: [".", outside], resourceReads: [] };
      config.modes.subproject = config.modes.project!;
      config.pathRules = [
        ...(multiple ? [{ path: path.join(outside, "alias"), scope: "file" as const, read: "allow" as const }] : []),
        { path: path.join(outside, "alias"), scope: "file", read: "allow", write: "deny" },
      ];
    });
    try {
      const before = readFileSync(f.file, "utf8");
      const redirect = () => { rmSync(path.join(f.outside, "alias")); symlinkSync("other", path.join(f.outside, "alias")); };
      if (redirectAt === "prepare") redirect();
      else f.owner.confirmGlobal = async () => { redirect(); return true; };
      const id = f.owner.snapshot().rules.at(-1)!.id;
      await assert.rejects(f.owner.changeGlobal(multiple ? { kind: "revoke", id } : { kind: "clear" }), /target changed|identity changed/);
      assert.equal(readFileSync(f.file, "utf8"), before);
      assert.equal(f.owner.snapshot().rules.at(-1)!.binding?.canonical, path.join(f.outside, "original"));
    } finally { f.close(); }
  }
});

test("global clear preserves ordinary grants and receipts for surviving ask operations", async () => {
  const f = fixture((config, outside) => {
    writeFileSync(path.join(outside, "notes"), "NOTE");
    config.pathRules = [{ path: path.join(outside, "notes"), scope: "file", read: "allow", write: "ask" }];
  });
  try {
    const file = path.join(f.outside, "notes");
    f.owner.ask = async () => ({ lifetime: "session" });
    await f.owner.authorize([file], "write", "ask receipt");
    const receipt = f.owner.snapshot().exceptions[0]!.id;
    await f.owner.requestDirectory(f.project, "read", "ordinary grant");
    const grant = f.owner.snapshot().grants[0]!.id;
    await f.owner.changeGlobal({ kind: "clear" });
    assert.equal(f.owner.snapshot().exceptions[0]!.id, receipt);
    assert.equal(f.owner.snapshot().grants[0]!.id, grant);
    assert.equal(decide(f.owner.snapshot(), bindPath(file), "write").action, "allow");
    assert.deepEqual(loadConfig(f.directory, f.directory).global.pathRules, [{ path: file, scope: "file", write: "ask" }]);
  } finally { f.close(); }
});

test("read-only global reapproval cannot reactivate blocked write authority", async () => {
  const f = fixture((config, outside) => { config.pathRules = [{ path: outside, scope: "tree", write: "allow" }]; });
  try {
    renameSync(f.outside, `${f.outside}-old`); mkdirSync(f.outside);
    const before = readFileSync(f.file, "utf8");
    const binding = bindPath(f.outside);
    await assert.rejects(f.owner.changeGlobal({ kind: "save", binding, scope: "tree", access: "read" }), /explicit R\/W reauthorization/);
    assert.equal(readFileSync(f.file, "utf8"), before);
    assert.equal(decide(f.owner.snapshot(), binding, "write").action, "ask");
    await f.owner.changeGlobal({ kind: "save", binding, scope: "tree", access: "write" });
    assert.equal(decide(f.owner.snapshot(), binding, "write").action, "allow");
    await f.owner.changeGlobal({ kind: "save", binding, scope: "tree", access: "read" });
    assert.equal(decide(f.owner.snapshot(), binding, "write").action, "allow");
  } finally { f.close(); }
});

test("positive reapproval cannot retarget a neighboring restrictive operation", async () => {
  const f = fixture((config, outside) => {
    writeFileSync(path.join(outside, "original"), "ORIGINAL"); writeFileSync(path.join(outside, "other"), "OTHER");
    symlinkSync("original", path.join(outside, "alias"));
    config.pathRules = [{ path: path.join(outside, "alias"), scope: "file", read: "allow", write: "deny" }];
  });
  try {
    const alias = path.join(f.outside, "alias"); const before = readFileSync(f.file, "utf8");
    rmSync(alias); symlinkSync("other", alias);
    await assert.rejects(f.owner.changeGlobal({ kind: "save", binding: bindFile(bindPath(alias)), scope: "file", access: "read" }), /target changed|identity changed/);
    assert.equal(readFileSync(f.file, "utf8"), before);
    assert.equal(f.owner.snapshot().rules[0]!.binding?.canonical, path.join(f.outside, "original"));
  } finally { f.close(); }
});

test("global publication preserves distinct ask sources and remaps only rewritten declarations", async () => {
  const f = fixture((config, outside) => {
    const file = path.join(outside, "notes"); writeFileSync(file, "NOTE");
    config.pathRules = [{ path: file, scope: "file", read: "ask", write: "allow" }, { path: file, scope: "file", read: "ask", write: "deny" }];
  });
  try {
    f.owner.ask = async () => ({ lifetime: "session" });
    const file = path.join(f.outside, "notes");
    await f.owner.authorize([file], "read", "both asks");
    const before = f.owner.snapshot().exceptions;
    assert.equal(new Set(before.map((e) => e.ruleId)).size, 2);
    const other = path.join(f.outside, "other"); writeFileSync(other, "OTHER");
    await f.owner.changeGlobal({ kind: "save", scope: "file", binding: bindFile(bindPath(other)), access: "read" });
    assert.deepEqual(f.owner.snapshot().exceptions, before);
    await f.owner.changeGlobal({ kind: "clear" });
    const after = f.owner.snapshot().exceptions;
    assert.deepEqual(after.map((e) => e.id), before.map((e) => e.id));
    assert.equal(new Set(after.map((e) => e.ruleId)).size, 2);
    assert.equal(after[1]!.ruleId, before[1]!.ruleId);
    assert.equal(decide(f.owner.snapshot(), bindPath(file), "read").action, "allow");
    assert.equal(decide(f.owner.snapshot(), bindPath(file), "write").action, "deny");
  } finally { f.close(); }
});

test("crash-equivalent global removal preserves cached restriction boundaries and distinct receipts", async (t) => {
  for (const redirected of [false, true]) {
    const f = fixture((config, outside) => {
      writeFileSync(path.join(outside, "original"), "ORIGINAL"); writeFileSync(path.join(outside, "other"), "OTHER");
      symlinkSync("original", path.join(outside, "alias"));
      config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: [".", outside], resourceReads: [] };
      config.modes.subproject = config.modes.project!;
      config.pathRules = [{ path: path.join(outside, "alias"), scope: "file", read: "ask", write: "allow" }, { path: path.join(outside, "alias"), scope: "file", read: "ask", write: "deny" }];
    });
    try {
      const binding = { id: randomUUID(), file: path.join(f.directory, "session.jsonl"), cwd: f.project };
      writeFileSync(binding.file, "session"); f.store.load(binding, f.project, f.context, f.config);
      const first = f.owner.snapshot().rules[0]!.id;
      f.owner.ask = async (request) => ({ lifetime: request.ruleId && request.ruleId !== first ? "project" : "session" });
      const alias = path.join(f.outside, "alias");
      await f.owner.authorize([alias], "read", "independent asks");
      await f.owner.requestDirectory(f.project, "read", "independent ordinary grant");
      const receipts = f.owner.snapshot().exceptions; const grants = f.owner.snapshot().grants;
      assert.equal(receipts.length, 2);
      const cache = path.join(f.store.directory, STATE_FILE); const bytes = readFileSync(cache, "utf8");
      t.mock.method(f.store, "save", () => { throw new Error("injected cache failure"); });
      await f.owner.changeGlobal({ kind: "clear" });
      assert.equal(readFileSync(cache, "utf8"), bytes);
      const current = loadConfig(f.directory, f.directory).global;
      const restart = () => new PermissionStore(f.directory).load(binding, f.project, f.context, current);
      if (redirected) {
        rmSync(alias); symlinkSync("other", alias);
        assert.throws(restart, /Saved path rule target changed|Saved path target changed/);
      } else {
        const restored = restart();
        assert.deepEqual(restored.session!.exceptions, receipts);
        assert.equal(restored.project.exceptions[0]!.id, receipts[1]!.id);
        assert.equal(restored.session!.grants[0]!.id, grants[0]!.id);
        assert.equal(restored.session!.catalog.rules[0]!.write, undefined);
        const owner = new PermissionOwner(restored.session!.catalog, { restored: restored.session, ask: async () => undefined });
        assert.equal(decide(owner.snapshot(), bindPath(alias), "read").action, "allow");
        assert.equal(decide(owner.snapshot(), bindPath(path.join(f.outside, "original")), "write").action, "deny");
      }
    } finally { t.mock.restoreAll(); f.close(); }
  }
});

test("cache recovery preserves surviving restrictions and receipts after global allow additions", async (t) => {
  for (const write of ["deny", "ask"] as const) for (const redirected of [false, true]) {
    const f = fixture((config, outside) => {
      const file = path.join(outside, "notes"); writeFileSync(file, "NOTE"); writeFileSync(path.join(outside, "other"), "OTHER");
      config.pathRules = [{ path: file, scope: "file", write }];
    });
    try {
      f.owner.ask = async () => ({ lifetime: "project" });
      const file = path.join(f.outside, "notes");
      await f.owner.requestDirectory(f.project, "read", "independent remembered grant");
      if (write === "ask") await f.owner.authorize([file], "write", "remember conditional permission");
      const before = f.owner.snapshot();
      const cache = path.join(f.store.directory, STATE_FILE); const bytes = readFileSync(cache, "utf8");
      t.mock.method(f.store, "save", () => { throw new Error("injected cache failure"); });
      await f.owner.changeGlobal({ kind: "save", binding: bindFile(bindPath(file)), scope: "file", access: "read" });
      assert.equal(readFileSync(cache, "utf8"), bytes);
      const current = loadConfig(f.directory, f.directory).global;
      const restart = () => new PermissionStore(f.directory).load(undefined, f.project, f.context, current).project;
      if (redirected) {
        rmSync(file); symlinkSync("other", file);
        assert.throws(restart, /Saved path rule target changed|Saved path target changed/);
      } else {
        const restored = restart();
        assert.deepEqual(restored.exceptions, before.exceptions);
        assert.equal(restored.grants[0]!.id, before.grants[0]!.id);
        const owner = new PermissionOwner(restored.catalog!, { grants: restored.grants, exceptions: restored.exceptions, ask: async () => undefined });
        assert.equal(decide(owner.snapshot(), bindPath(file), "read").action, "allow");
        assert.equal(decide(owner.snapshot(), bindPath(file), "write").action, write === "deny" ? "deny" : "allow");
      }
    } finally { t.mock.restoreAll(); f.close(); }
  }
});

test("canonicalized global saves preserve cached restrictions without depending on obsolete aliases", async (t) => {
  for (const [relative, change] of [[true, "target"], [false, "target"], [false, "alias"]] as const) {
    const f = fixture((config, outside) => {
      const original = relative ? path.join(path.dirname(outside), "project", "notes") : path.join(outside, "original");
      writeFileSync(original, "ORIGINAL"); writeFileSync(path.join(outside, "other"), "OTHER");
      if (!relative) symlinkSync("original", path.join(outside, "alias"));
      config.pathRules = [{ path: relative ? "notes" : path.join(outside, "alias"), scope: "file", write: "deny" }];
    });
    try {
      const original = relative ? path.join(f.project, "notes") : path.join(f.outside, "original");
      const target = relative ? original : path.join(f.outside, "alias");
      const peer = new PermissionOwner(resolveCatalog(f.config, { ...f.root, family: randomUUID() }, f.context), { ask: async () => undefined });
      f.owner.ask = async () => ({ lifetime: "project" });
      await f.owner.requestDirectory(f.project, "read", "remember ordinary grant");
      t.mock.method(f.store, "save", () => { throw new Error("injected cache failure"); });
      await f.owner.changeGlobal({ kind: "save", binding: bindFile(bindPath(target)), scope: "file", access: "read" });
      const current = loadConfig(f.directory, f.directory).global;
      assert.equal(current.pathRules[0]!.path, original);
      const changed = change === "target" ? original : target;
      rmSync(changed); symlinkSync(path.join(f.outside, "other"), changed);
      const restart = () => new PermissionStore(f.directory).load(undefined, f.project, f.context, current).project;
      if (change === "target") {
        assert.throws(restart, /Saved path rule target changed|Saved path target changed/);
        await assert.rejects(peer.reload(current, undefined, f.context), /target changed|identity changed/);
        assert.throws(() => peer.snapshot(), /unavailable/);
      } else {
        const restored = restart();
        const owner = new PermissionOwner(restored.catalog!, { grants: restored.grants, exceptions: restored.exceptions, ask: async () => undefined });
        assert.equal(decide(owner.snapshot(), bindPath(original), "read").action, "allow");
        assert.equal(decide(owner.snapshot(), bindPath(original), "write").action, "deny");
        await peer.reload(current, undefined, f.context);
        assert.equal(decide(peer.snapshot(), bindPath(original), "read").action, "allow");
        assert.equal(decide(peer.snapshot(), bindPath(original), "write").action, "deny");
      }
    } finally { t.mock.restoreAll(); f.close(); }
  }
});

test("retained-owner reload cannot retarget a surviving restriction after another root removes allows", async () => {
  for (const redirected of [false, true]) {
    const f = fixture((config, outside) => {
      writeFileSync(path.join(outside, "original"), "ORIGINAL"); writeFileSync(path.join(outside, "other"), "OTHER");
      symlinkSync("original", path.join(outside, "alias"));
      config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: [".", outside], resourceReads: [] };
      config.modes.subproject = config.modes.project!;
      config.pathRules = [{ path: path.join(outside, "alias"), scope: "file", read: "allow", write: "deny" }];
    });
    try {
      const peer = new PermissionOwner(resolveCatalog(f.config, { ...f.root, family: randomUUID() }, f.context), { ask: async () => undefined });
      const id = peer.snapshot().rules[0]!.id;
      await f.owner.changeGlobal({ kind: "clear" });
      const current = loadConfig(f.directory, f.directory).global;
      if (redirected) {
        const alias = path.join(f.outside, "alias"); rmSync(alias); symlinkSync("other", alias);
        await assert.rejects(peer.reload(current, undefined, f.context), /target changed|identity changed/);
        assert.throws(() => peer.snapshot(), /unavailable/);
      } else {
        await peer.reload(current, undefined, f.context);
        assert.equal(peer.snapshot().rules[0]!.id, id);
        assert.equal(peer.snapshot().rules[0]!.read, undefined);
        assert.equal(decide(peer.snapshot(), bindPath(path.join(f.outside, "original")), "write").action, "deny");
      }
    } finally { f.close(); }
  }
});

test("retained-owner reload preserves all equal ask receipts across global allow additions and removals", async () => {
  const f = fixture((config, outside) => {
    const file = path.join(outside, "notes"); writeFileSync(file, "NOTE");
    config.pathRules = [{ path: file, scope: "file", write: "ask" }, { path: file, scope: "file", read: "ask", write: "ask" }];
  });
  try {
    const peer = new PermissionOwner(resolveCatalog(f.config, { ...f.root, family: randomUUID() }, f.context), { ask: async () => ({ lifetime: "session" }) });
    const file = path.join(f.outside, "notes");
    await peer.authorize([file], "write", "all read and write asks");
    const current = structuredClone(f.config);
    current.pathRules[0]!.read = "allow";
    await peer.reload(current, undefined, f.context);
    const before = peer.snapshot().exceptions;
    assert.equal(before.length, 3);
    delete current.pathRules[0]!.read;
    await peer.reload(current, undefined, f.context);
    assert.deepEqual(peer.snapshot().exceptions, before);
    assert.equal(decide(peer.snapshot(), bindPath(file), "read").action, "allow");
    assert.equal(decide(peer.snapshot(), bindPath(file), "write").action, "allow");
  } finally { f.close(); }
});

test("project receipts follow current declaration IDs when an older session cache resumes", async () => {
  const f = fixture((config, outside) => {
    const file = path.join(outside, "notes"); writeFileSync(file, "NOTE");
    config.pathRules = [{ path: file, scope: "file", read: "ask", write: "allow" }, { path: file, scope: "file", read: "ask", write: "deny" }];
  });
  try {
    const binding = { id: randomUUID(), file: path.join(f.directory, "session.jsonl"), cwd: f.project };
    writeFileSync(binding.file, "session"); f.store.load(binding, f.project, f.context, f.config);
    const first = f.owner.snapshot().rules[0]!.id;
    f.owner.ask = async (request) => ({ lifetime: request.ruleId === first ? "project" : "session" });
    const file = path.join(f.outside, "notes"); await f.owner.authorize([file], "read", "both asks");
    const stale = { ...binding, id: randomUUID(), file: path.join(f.directory, "stale-session.jsonl") };
    writeFileSync(stale.file, "stale session");
    const cache = path.join(f.store.directory, STATE_FILE); const document = JSON.parse(readFileSync(cache, "utf8"));
    document.sessions[JSON.stringify(stale.id)] = { ...document.sessions[JSON.stringify(binding.id)], binding: stale };
    writeFileSync(cache, JSON.stringify(document));
    await f.owner.changeGlobal({ kind: "clear" });
    const current = loadConfig(f.directory, f.directory).global;
    const restored = new PermissionStore(f.directory).load(stale, f.project, f.context, current);
    assert.notEqual(restored.project.exceptions[0]!.ruleId, first);
    const owner = new PermissionOwner(restored.session!.catalog, {
      restored: restored.session,
      exceptions: [...restored.session!.exceptions.filter((e) => e.lifetime === "session"), ...restored.project.exceptions],
      ask: async () => undefined,
    });
    assert.equal(new Set(owner.snapshot().exceptions.map((e) => e.ruleId)).size, 2);
    assert.equal(decide(owner.snapshot(), bindPath(file), "read").action, "allow");
  } finally { f.close(); }
});

test("cache recovery cannot use an unchanged source receipt for a newly added equal ask", async () => {
  const f = fixture((config, outside) => {
    const file = path.join(outside, "notes"); writeFileSync(file, "NOTE");
    config.pathRules = [{ path: file, scope: "file", read: "ask", write: "allow" }];
  });
  try {
    f.owner.ask = async () => ({ lifetime: "project" });
    const file = path.join(f.outside, "notes");
    await f.owner.authorize([file], "read", "original ask");
    const config = structuredClone(f.config); config.pathRules.push({ path: file, scope: "file", read: "ask" });
    const restored = new PermissionStore(f.directory).load(undefined, f.project, f.context, config).project;
    const owner = new PermissionOwner(restored.catalog!, { grants: restored.grants, exceptions: restored.exceptions, ask: async () => undefined });
    assert.equal(owner.snapshot().exceptions.length, 1);
    assert.equal(new Set(owner.snapshot().rules.map((r) => r.id)).size, 2);
    const decision = decide(owner.snapshot(), bindPath(file), "read");
    assert.equal(decision.action, "ask"); assert.equal(decision.exceptions.length, 1);
    assert.notEqual(decision.exceptions[0]!.rule.id, owner.snapshot().exceptions[0]!.ruleId);
    await f.owner.reload(config, undefined, f.context);
    const live = decide(f.owner.snapshot(), bindPath(file), "read");
    assert.equal(live.action, "ask"); assert.equal(live.exceptions.length, 1);
    assert.notEqual(live.exceptions[0]!.rule.id, f.owner.snapshot().exceptions[0]!.ruleId);
  } finally { f.close(); }
});

test("same-path survivor reservation keeps a newly added normalized ask independent of old receipts", async () => {
  for (const reverse of [false, true]) {
    const f = fixture((config, outside) => {
      writeFileSync(path.join(path.dirname(outside), "project", "notes"), "NOTE");
      config.pathRules = [{ path: "notes", scope: "file", read: "ask", write: "allow" }];
    });
    try {
      f.owner.ask = async () => ({ lifetime: "project" });
      const file = path.join(f.project, "notes"); await f.owner.authorize([file], "read", "old source");
      const source = f.owner.snapshot().rules[0]!.id;
      const current = structuredClone(f.config);
      current.pathRules = [{ path: "notes", scope: "file", read: "ask" }, { path: file, scope: "file", read: "ask" }];
      if (reverse) current.pathRules.reverse();
      const restored = new PermissionStore(f.directory).load(undefined, f.project, f.context, current).project;
      const cached = new PermissionOwner(restored.catalog!, { exceptions: restored.exceptions, grants: restored.grants, ask: async () => undefined });
      const snapshot = cached.snapshot();
      assert.equal(new Set(snapshot.rules.map((r) => r.id)).size, 2);
      assert.equal(snapshot.rules.find((r) => r.path === "notes")!.id, source);
      const decision = decide(snapshot, bindPath(file), "read");
      assert.equal(decision.action, "ask"); assert.equal(decision.exceptions.length, 1);
      assert.equal(decision.exceptions[0]!.rule.path, file);
      await f.owner.reload(current, undefined, f.context);
      const live = decide(f.owner.snapshot(), bindPath(file), "read");
      assert.equal(live.action, "ask"); assert.equal(live.exceptions.length, 1);
      assert.equal(live.exceptions[0]!.rule.path, file);
      await f.owner.authorize([file], "read", "new independent source");
      assert.equal(f.owner.snapshot().exceptions.length, 2);
      assert.equal(decide(f.owner.snapshot(), bindPath(file), "read").action, "allow");
      const resumed = new PermissionStore(f.directory).load(undefined, f.project, f.context, current).project;
      assert.equal(new Set(resumed.catalog!.rules.map((r) => r.id)).size, 2);
      assert.equal(resumed.exceptions.length, 2);
    } finally { f.close(); }
  }
});

test("global clear preserves distinct relative and absolute ask sources on reload and stale-cache recovery", async (t) => {
  for (const reverse of [false, true]) {
    const f = fixture((config, outside) => {
      const file = path.join(path.dirname(outside), "project", "notes"); writeFileSync(file, "NOTE");
      config.pathRules = [{ path: "notes", scope: "file", read: "ask", write: "allow" }, { path: file, scope: "file", read: "ask", write: "allow" }];
      if (reverse) config.pathRules.reverse();
    });
    try {
      f.owner.ask = async () => ({ lifetime: "project" });
      const peer = new PermissionOwner(resolveCatalog(f.config, { ...f.root, family: randomUUID() }, f.context), { ask: async () => ({ lifetime: "session" }) });
      const file = path.join(f.project, "notes");
      await f.owner.authorize([file], "read", "both remembered asks");
      await peer.authorize([file], "read", "both live asks");
      const cachedReceipts = f.owner.snapshot().exceptions; const liveReceipts = peer.snapshot().exceptions;
      assert.equal(cachedReceipts.length, 2); assert.equal(liveReceipts.length, 2);
      t.mock.method(f.store, "save", () => { throw new Error("injected cache failure"); });
      await f.owner.changeGlobal({ kind: "clear" });
      const current = loadConfig(f.directory, f.directory).global;
      await peer.reload(current, undefined, f.context);
      assert.deepEqual(peer.snapshot().exceptions, liveReceipts);
      assert.equal(new Set(peer.snapshot().rules.map((r) => r.id)).size, 2);
      assert.equal(decide(peer.snapshot(), bindPath(file), "read").action, "allow");
      const restored = new PermissionStore(f.directory).load(undefined, f.project, f.context, current).project;
      assert.deepEqual(restored.exceptions, cachedReceipts);
      assert.equal(new Set(restored.catalog!.rules.map((r) => r.id)).size, 2);
      assert.ok(restored.catalog!.rules.every((r) => r.write === undefined));
      const cached = new PermissionOwner(restored.catalog!, { grants: restored.grants, exceptions: restored.exceptions, ask: async () => undefined });
      assert.equal(decide(cached.snapshot(), bindPath(file), "read").action, "allow");
    } finally { t.mock.restoreAll(); f.close(); }
  }
});

test("ambiguous normalized survivor claims reject instead of choosing a receipt source by rule order", async () => {
  for (const reverse of [false, true]) {
    const f = fixture((config, outside) => {
      writeFileSync(path.join(path.dirname(outside), "project", "notes"), "NOTE");
      config.pathRules = [{ path: "notes", scope: "file", read: "ask", write: "allow" }];
    });
    try {
      f.owner.ask = async () => ({ lifetime: "project" });
      const file = path.join(f.project, "notes"); await f.owner.authorize([file], "read", "old source");
      const current = structuredClone(f.config);
      current.pathRules = [{ path: file, scope: "file", read: "ask" }, { path: "./notes", scope: "file", read: "ask" }];
      if (reverse) current.pathRules.reverse();
      assert.throws(() => new PermissionStore(f.directory).load(undefined, f.project, f.context, current), /Ambiguous surviving/);
      await assert.rejects(f.owner.reload(current, undefined, f.context), /Ambiguous surviving/);
      assert.throws(() => f.owner.snapshot(), /unavailable/);
    } finally { f.close(); }
  }
});

test("committed global policy survives directory-flush and lock-cleanup failures", async (t) => {
  const f = fixture();
  const rename = fs.renameSync; const flush = fs.fsyncSync; const unlink = fs.unlinkSync;
  let committed = false; let flushFailures = 0; let cleanupFailures = 0;
  try {
    const file = path.join(f.outside, "notes"); writeFileSync(file, "NOTE");
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => { rename(from, to); if (String(to) === f.file) committed = true; });
    t.mock.method(fs, "fsyncSync", (fd: number) => { if (committed) { flushFailures++; throw new Error("injected directory flush failure"); } flush(fd); });
    t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (committed && String(file).endsWith(".authority.lock")) { cleanupFailures++; throw new Error("injected cleanup failure"); } unlink(file); });
    syncBuiltinESMExports();
    await f.owner.requestGrant(file, "write", "global commit with cleanup failure");
    assert.equal(committed, true); assert.ok(flushFailures); assert.ok(cleanupFailures);
    assert.deepEqual(loadConfig(f.directory, f.directory).global.pathRules, [{ path: file, scope: "file", read: "allow", write: "allow" }]);
    assert.equal(decide(f.owner.snapshot(), bindPath(file), "write").action, "allow");
    assert.ok(f.warnings.some((message) => message.includes("committed and active")));
    await assert.rejects(f.owner.changeGlobal({ kind: "clear" }), /cache is stale/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test("stale confirmations, external edits and cancellation cannot commit global changes", async () => {
  for (const change of ["revision", "document", "cancel"] as const) {
    const f = fixture();
    try {
      const file = path.join(f.outside, "notes"); writeFileSync(file, "NOTE");
      let confirm!: (value: boolean) => void;
      f.owner.confirmGlobal = () => new Promise((resolve) => { confirm = resolve; });
      const signal = new AbortController();
      const pending = f.owner.changeGlobal({ kind: "save", binding: bindFile(bindPath(file)), scope: "file", access: "read" }, signal.signal);
      if (change === "revision") f.owner.revoke();
      if (change === "document") writeFileSync(f.file, `${readFileSync(f.file, "utf8")}\n`);
      if (change === "cancel") signal.abort();
      const before = readFileSync(f.file, "utf8");
      confirm(true);
      await assert.rejects(pending, change === "revision" ? StaleAuthorityError : /changed|abort/i);
      assert.equal(readFileSync(f.file, "utf8"), before);
      assert.equal(f.owner.snapshot().rules.length, 0);
    } finally { f.close(); }
  }
});

test("globally approved creation continues the originating direct write without a hidden ordinary grant", async (t) => {
  for (const cacheFailure of [false, true]) {
    const f = fixture();
    try {
      const created = path.join(f.outside, "new"); const file = path.join(created, "deeper", "file");
      f.owner.ask = async () => ({ lifetime: "global", directory: created, binding: bindPath(created) });
      if (cacheFailure) t.mock.method(f.store, "save", () => { throw new Error("injected cache failure"); });
      const [, , write] = createDirectTools(() => f.owner, f.project);
      const ctx = { ...({ cwd: f.project } as ExtensionContext), tools: [], executeTool: async () => { throw new Error("Nested tools are not part of this fixture"); } };
      await write.execute("write", { path: file, content: "CREATED" }, undefined, undefined, ctx);
      assert.equal(readFileSync(file, "utf8"), "CREATED");
      assert.equal(f.owner.snapshot().grants.length, 0);
      assert.equal(decide(f.owner.snapshot(), bindPath(file), "write").action, "allow");
      assert.equal(decide(f.owner.snapshot(), bindPath(path.join(f.outside, "sibling")), "write").action, "ask");
      assert.equal(f.warnings.some((message) => message.includes("committed and active")), cacheFailure);
      assert.deepEqual(loadConfig(f.directory, f.directory).global.pathRules, [{ path: created, scope: "tree", read: "allow", write: "allow" }]);
      if (cacheFailure) await assert.rejects(f.owner.changeGlobal({ kind: "clear" }), /cache is stale/);
    } finally { t.mock.restoreAll(); f.close(); }
  }
});

test("absent policy is created as a v3 override retaining protections without host-specific profile materialization", async () => {
  const f = fixture();
  try {
    rmSync(f.file);
    const config = defaultConfig(f.directory, f.directory);
    const owner = new PermissionOwner(resolveCatalog(config, f.root, f.context), { policyWriter: f.writer, ask: async () => ({ lifetime: "global" }), confirmGlobal: async () => true });
    const file = path.join(f.outside, "notes"); writeFileSync(file, "NOTE");
    await owner.requestGrant(file, "read", "new policy");
    const raw = JSON.parse(readFileSync(f.file, "utf8"));
    assert.equal(raw.version, 3);
    assert.equal(raw.modes, undefined);
    assert.deepEqual(raw.pathRules, [...config.pathRules, { path: file, scope: "file", read: "allow" }]);
    assert.equal(decide(owner.snapshot(), bindPath(file), "read").action, "allow");
  } finally { f.close(); }
});

test("failed creation never removes a populated or replaced directory", async () => {
  for (const change of ["populated", "replaced"] as const) {
    const f = fixture();
    try {
      const created = path.join(f.outside, "new");
      f.owner.confirmGlobal = async () => {
        if (change === "replaced") { renameSync(created, `${created}-old`); mkdirSync(created); }
        else writeFileSync(path.join(created, "keep"), "KEEP");
        return false;
      };
      await assert.rejects(f.owner.requestDirectory(created, "write", "cancel"), /cancelled/);
      assert.equal(bindPath(created).missing.length, 0);
      if (change === "populated") assert.equal(readFileSync(path.join(created, "keep"), "utf8"), "KEEP");
      assert.equal(f.warnings.some((message) => message.includes("retained created directory")), true);
    } finally { f.close(); }
  }
});

test("failed pre-commit creation removes only the empty created directory and global-policy symlinks are rejected", async () => {
  const f = fixture();
  try {
    const created = path.join(f.outside, "new");
    f.owner.confirmGlobal = async () => false;
    f.owner.ask = async () => ({ lifetime: "global" });
    await assert.rejects(f.owner.requestDirectory(created, "write", "cancel"), /cancelled/);
    assert.equal(bindPath(created).missing.length, 1);
    f.owner.confirmGlobal = async () => true;
    rmSync(f.file); symlinkSync(path.join(f.outside, "missing-policy"), f.file);
    await assert.rejects(f.owner.changeGlobal({ kind: "clear" }), /ELOOP|symlink/i);
  } finally { f.close(); }
});
