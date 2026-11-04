import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { assertNativeSemantics } from "./native-semantics.ts";
import { bindPath, contains, sameIdentity, within } from "./paths.ts";
import { decide, resolveCatalog } from "./policy.ts";
import { PermissionStore } from "./permission-state.ts";
import { prepareWindowsComparison, windowsPermissionKey } from "./windows-platform.ts";

const native = { skip: process.platform === "win32" ? false : "Requires the native Windows ordinal comparer" };
const pairs: [string, string, boolean][] = [
  ["approved.txt", "APPROVED.txt", true], ["ключ", "КЛЮЧ", true],
  ["K", "k", false], ["ß", "SS", false], ["ı", "I", false],
  ["İ", "i\u0307", false], ["ſ", "S", false], ["𐐨", "𐐀", false], ["ა", "Ა", false],
];

function fixture(caseSensitive = true) {
  const directory = mkdtempSync(path.join(tmpdir(), "permission-comparison-данные-"));
  const project = path.join(directory, "project"); mkdirSync(project);
  const system = path.dirname((process.report.getReport() as { sharedObjects: string[] }).sharedObjects.find((file) => path.basename(file).toLowerCase() === "kernel32.dll")!);
  if (caseSensitive) {
    const changed = childProcess.spawnSync(path.join(system, "fsutil.exe"), ["file", "setCaseSensitiveInfo", project, "enable"], { cwd: system, encoding: "utf8", timeout: 3000 });
    assert.equal(changed.status, 0, changed.stdout + changed.stderr);
  }
  const config = defaultConfig();
  config.modes = { project: { label: "Project", color: "accent", filesystem: { kind: "scoped", readOnly: [], readWrite: [], resourceReads: [] } } };
  config.cycleOrder = ["project"]; config.pathRules = [];
  const root = { family: randomUUID(), binding: bindPath(project) };
  const context = { agentDir: directory, home: directory };
  return { directory, project, config, root, context, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("Windows policy keys use native equivalence without changing canonical identities", native, () => {
  prepareWindowsComparison();
  for (const [left, right, expected] of pairs) {
    assert.equal(windowsPermissionKey(left) === windowsPermissionKey(right), expected, `${left} / ${right}`);
    assert.equal(contains({ canonical: `C:\\root\\${left}` }, { canonical: `C:\\root\\${right}` }, "file"), expected);
  }
  assert.equal(within("C:\\Root", "C:\\ROOT\\child"), false);
  assert.equal(contains({ canonical: "C:\\Root" }, { canonical: "C:\\ROOT\\child" }), true);
  assert.equal(contains({ canonical: "C:\\Root" }, { canonical: "C:\\ROOTED\\child" }), false);
});

test("prepared comparisons and verified-volume checks never launch per-entry helpers", native, (t) => {
  const f = fixture();
  try {
    prepareWindowsComparison();
    const binding = bindPath(f.project); assertNativeSemantics(binding);
    t.mock.method(childProcess, "spawnSync", () => { throw new Error("Unexpected per-entry helper"); });
    syncBuiltinESMExports();
    for (let i = 0; i < 1000; i++) {
      assert.equal(windowsPermissionKey(`C:\\project\\FILE-${i}`), windowsPermissionKey(`c:\\PROJECT\\file-${i}`));
      assertNativeSemantics(binding);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test("malformed comparer refresh fails without retiring the already prepared comparer", native, (t) => {
  prepareWindowsComparison();
  try {
    t.mock.method(childProcess, "spawnSync", () => ({ status: 0, stdout: '{"table":"partial"}', stderr: "" }));
    syncBuiltinESMExports();
    assert.throws(() => prepareWindowsComparison(true), /Invalid Windows comparison/);
    assert.equal(windowsPermissionKey("FILE"), windowsPermissionKey("file"));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("case-family file authority stays nonrecursive and distinct case-variant objects stay distinct", native, () => {
  const f = fixture();
  try {
    const lower = path.join(f.project, "report.txt"); const upper = path.join(f.project, "REPORT.TXT");
    writeFileSync(lower, "lower"); writeFileSync(upper, "upper");
    const first = bindPath(lower); const second = bindPath(upper);
    assert.equal(sameIdentity(first.identity, second.identity), false);
    f.config.pathRules = [{ path: "report.txt", scope: "file", read: "allow" }];
    const owner = new PermissionOwner(resolveCatalog(f.config, f.root, f.context), { ask: async () => undefined });
    assert.equal(decide(owner.snapshot(), first, "read").action, "allow");
    assert.equal(decide(owner.snapshot(), second, "read").action, "allow");
    assert.equal(decide(owner.snapshot(), bindPath(path.join(f.project, "unrelated")), "read").action, "ask");
    const alias = path.join(f.directory, "alias"); symlinkSync(f.project, alias, "junction");
    assert.equal(decide(owner.snapshot(), bindPath(path.join(alias, "REPORT.TXT")), "read").action, "allow");
    rmSync(upper); mkdirSync(upper); writeFileSync(path.join(upper, "child"), "child");
    assert.equal(decide(owner.snapshot(), bindPath(path.join(upper, "child")), "read").action, "ask");
    assert.equal(readFileSync(lower, "utf8"), "lower");
  } finally { f.close(); }
});

test("future file and tree materialization tolerate native case spelling without adopting another parent", native, () => {
  const f = fixture(false);
  try {
    f.config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
    f.config.pathRules = [{ path: "PACKAGE.JSON", scope: "file", read: "ask" }, { path: "FUTURE", scope: "tree", read: "deny" }];
    const owner = new PermissionOwner(resolveCatalog(f.config, f.root, f.context), { ask: async () => undefined });
    writeFileSync(path.join(f.project, "package.json"), "package"); mkdirSync(path.join(f.project, "future"));
    writeFileSync(path.join(f.project, "future", "child"), "child");
    assert.equal(decide(owner.snapshot(), bindPath(path.join(f.project, "package.json")), "read").action, "ask");
    assert.equal(decide(owner.snapshot(), bindPath(path.join(f.project, "future", "child")), "read").action, "deny");
    assert.equal(decide(owner.snapshot(), bindPath(path.join(f.project, "unrelated")), "read").action, "allow");
  } finally { f.close(); }
});

test("saved future file and tree restrictions restore equivalent casing without merging declarations", native, () => {
  const f = fixture(false);
  try {
    f.config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
    f.config.pathRules = [
      { path: "PACKAGE.JSON", scope: "file", read: "ask" },
      { path: "FUTURE", scope: "tree", read: "deny" },
      { path: "MISSING/PACKAGE.JSON", scope: "file", read: "ask" },
    ];
    const session = { id: randomUUID(), file: path.join(f.directory, "session.jsonl"), cwd: f.project };
    writeFileSync(session.file, "session");
    const store = new PermissionStore(f.directory); store.load(session, f.project, f.context, f.config);
    const original = new PermissionOwner(resolveCatalog(f.config, f.root, f.context), { store, ask: async () => undefined });
    const ids = original.snapshot().rules.map((rule) => rule.id);
    writeFileSync(path.join(f.project, "package.json"), "package");
    mkdirSync(path.join(f.project, "future")); writeFileSync(path.join(f.project, "future", "child"), "child");
    mkdirSync(path.join(f.project, "missing")); writeFileSync(path.join(f.project, "missing", "package.json"), "package");
    const saved = new PermissionStore(f.directory).load(session, f.project, f.context, f.config).session!;
    const owner = new PermissionOwner(saved.catalog, { restored: saved, ask: async () => undefined });
    assert.deepEqual(owner.snapshot().rules.map((rule) => rule.id), ids);
    for (const file of ["package.json", "missing/package.json"])
      assert.equal(decide(owner.snapshot(), bindPath(path.join(f.project, file)), "read").action, "ask");
    assert.equal(decide(owner.snapshot(), bindPath(path.join(f.project, "future", "child")), "read").action, "deny");
    assert.equal(decide(owner.snapshot(), bindPath(path.join(f.project, "unrelated")), "read").action, "allow");
  } finally { f.close(); }
});

test("equivalent restrictive declarations retain separate ask receipts and deny precedence", native, async () => {
  const f = fixture();
  try {
    const lower = path.join(f.project, "secret"); const upper = path.join(f.project, "SECRET");
    writeFileSync(lower, "lower"); writeFileSync(upper, "upper");
    f.config.pathRules = [{ path: "secret", scope: "file", read: "ask" }, { path: "SECRET", scope: "file", read: "ask" }];
    const asked: string[] = [];
    const owner = new PermissionOwner(resolveCatalog(f.config, f.root, f.context), { ask: async (request) => { asked.push(request.ruleId!); return { lifetime: "session" }; } });
    assert.equal(decide(owner.snapshot(), bindPath(upper), "read").exceptions.length, 2);
    await owner.authorize([upper], "read", "case-family approval");
    assert.equal(new Set(asked).size, 2);
    assert.equal(decide(owner.snapshot(), bindPath(lower), "read").action, "allow");
    f.config.pathRules = [{ path: "secret", scope: "file", read: "allow" }, { path: "SECRET", scope: "file", read: "deny" }];
    const denied = new PermissionOwner(resolveCatalog(f.config, f.root, f.context), { ask: async () => undefined });
    assert.equal(decide(denied.snapshot(), bindPath(lower), "read").action, "deny");
    assert.equal(decide(denied.snapshot(), bindPath(upper), "read").action, "deny");
  } finally { f.close(); }
});
