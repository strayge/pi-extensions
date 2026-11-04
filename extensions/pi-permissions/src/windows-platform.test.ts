import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { assertNativeSemantics } from "./native-semantics.ts";
import { assertBinding, bindFile, bindPath, configPath, identity, resolvePermissionBinding, within } from "./paths.ts";
import { PermissionStore, STATE_FILE } from "./permission-state.ts";
import { decide, resolveCatalog } from "./policy.ts";
import { assertWindowsPath, assertWindowsPrivate, createWindowsPrivateDirectory, validateWindowsSecurity, windowsSystemResources } from "./windows-platform.ts";

const native = { skip: process.platform === "win32" ? false : "Requires native Windows/NTFS" };

test("Windows spellings reject streams, devices, shares, and ambiguous components", () => {
  for (const input of ["C:\\project\\notes.txt", "D:/non ASCII/файл.txt", "C:\\", "C:\\a\\..\\b"])
    assert.doesNotThrow(() => assertWindowsPath(input));
  for (const input of ["C:relative", "\\\\server\\share", "\\\\?\\C:\\project", "\\\\.\\pipe\\name", "C:\\a:stream", "C:\\NUL.txt", "C:\\COM¹", "C:\\bad.", "C:\\bad ", "C:\\bad\0name", "C:\\bad\ud800", "C:\\CONIN$", "C:\\CONOUT$"])
    assert.throws(() => assertWindowsPath(input), /Windows path|local drive/);
});

test("DACL privacy rejects unrelated principals including descendant-only access", () => {
  const info = { user: "user", owner: "user", rules: [{ sid: "user", rights: 2032127, allow: true, inheritOnly: false }], reparse: false, directory: true };
  validateWindowsSecurity(info, true);
  for (const change of [
    { owner: "other" }, { reparse: true }, { directory: false }, { rules: [] },
    { rules: [...info.rules, { sid: "S-1-1-0", rights: 1, allow: true, inheritOnly: false }] },
    { rules: [...info.rules, { sid: "S-1-1-0", rights: 1, allow: true, inheritOnly: true }] },
  ]) assert.throws(() => validateWindowsSecurity({ ...info, ...change }, true), /Windows authority/);
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "permissions-windows-данные-"));
  const project = path.join(directory, "project");
  mkdirSync(project);
  return { directory, project, close: () => rmSync(directory, { force: true, recursive: true }) };
}

test("native identities, drive casing, junctions, missing parents and atomic replacement stay pinned", native, () => {
  const f = fixture();
  try {
    assert.deepEqual(identity(f.project), identity(f.project.toUpperCase()));
    const root = { family: randomUUID(), binding: bindPath(f.project) };
    assert.equal(configPath("missing/leaf", root, f.directory).canonical, path.join(f.project, "missing", "leaf"));
    const mixed = path.join(f.project, "missing", "leaf").replaceAll(path.sep, "/");
    assertBinding(bindPath(mixed));
    assert.equal(bindPath(mixed).prefix, f.project);
    assertBinding(bindPath(`${f.project}/missing/leaf`));
    const file = path.join(f.project, "файл.txt");
    writeFileSync(file, "original");
    const original = bindPath(file);
    assert.notEqual(original.identity.ino, "0");
    assert.ok(BigInt(original.identity.birthtimeNs) > 0n);
    const permission = bindFile(original);
    writeFileSync(`${file}.new`, "new"); renameSync(`${file}.new`, file);
    assert.throws(() => assertBinding(original), /identity changed/);
    assert.equal(resolvePermissionBinding(permission).canonical, file);
    const alias = path.join(f.directory, "alias");
    symlinkSync(f.project, alias, "junction");
    assert.equal(bindPath(path.join(alias, "файл.txt")).canonical, file);
    const future = bindFile(bindPath(path.join(f.project, "new", "secret")));
    mkdirSync(path.join(f.project, "new")); writeFileSync(path.join(f.project, "new", "secret"), "secret");
    assert.doesNotThrow(() => resolvePermissionBinding(future));
    renameSync(f.project, `${f.project}-old`); mkdirSync(f.project);
    assert.throws(() => resolvePermissionBinding(permission), /identity changed/);
    assert.throws(() => resolvePermissionBinding(future), /identity changed/);
    assert.throws(() => configPath("leaf", root, f.directory), /identity changed/);
  } finally { f.close(); }
});

test("Windows rule depth honors narrower read and write exceptions without Unicode overgrants", native, () => {
  const f = fixture();
  try {
    for (const child of ["deny", "deny/ro", "deny/rw"]) mkdirSync(path.join(f.project, child), { recursive: true });
    const config = defaultConfig();
    config.modes = { project: { label: "Project", color: "accent", filesystem: { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] } } };
    config.cycleOrder = ["project"];
    config.pathRules = [{ path: "deny", scope: "tree", read: "deny" }, { path: "deny/ro", scope: "tree", read: "allow" }, { path: "deny/rw", scope: "tree", write: "allow" }];
    const owner = new PermissionOwner(resolveCatalog(config, { family: randomUUID(), binding: bindPath(f.project) }, { agentDir: f.directory, home: f.directory }), { ask: async () => undefined });
    for (const [relative, read, write] of [["deny/file", "deny", "deny"], ["deny/ro/file", "allow", "deny"], ["deny/rw/file", "allow", "allow"]]) {
      const binding = bindPath(path.join(f.project, relative!));
      assert.equal(decide(owner.snapshot(), binding, "read").action, read);
      assert.equal(decide(owner.snapshot(), binding, "write").action, write);
    }
    assert.equal(within(path.join(f.project, "K"), path.join(f.project, "k")), false);
    config.pathRules = [{ path: "secret", scope: "file", read: "deny" }];
    const restricted = new PermissionOwner(resolveCatalog(config, { family: randomUUID(), binding: bindPath(f.project) }, { agentDir: f.directory, home: f.directory }), { ask: async () => undefined });
    const alias = path.join(f.directory, "alias"); symlinkSync(f.project, alias, "junction");
    assert.equal(decide(restricted.snapshot(), bindPath(path.join(alias, "SECRET")), "write").action, "deny");
  } finally { f.close(); }
});

test("ACL evidence from a different private object cannot authorize a held descriptor", native, (t) => {
  const f = fixture();
  const file = path.join(f.directory, "first"); const other = path.join(f.directory, "second");
  writeFileSync(file, "first"); writeFileSync(other, "second");
  const descriptor = openSync(file, "r");
  try {
    assertWindowsPrivate(file, false, descriptor);
    const spawn = childProcess.spawnSync;
    t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawn>) => spawn(args[0], args[1], { ...args[2], input: JSON.stringify(other) }));
    syncBuiltinESMExports();
    assert.throws(() => assertWindowsPrivate(file, false, descriptor), /authority changed/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); closeSync(descriptor); f.close(); }
});

test("private authority below an unrelated-user mutable ancestor is rejected", native, () => {
  const f = fixture();
  try {
    const ancestor = path.join(f.directory, "mutable"); mkdirSync(ancestor);
    const authority = path.join(ancestor, "private"); createWindowsPrivateDirectory(authority);
    const system = path.dirname((process.report.getReport() as { sharedObjects: string[] }).sharedObjects.find((file) => path.basename(file).toLowerCase() === "kernel32.dll")!);
    const result = spawnSync(path.join(system, "icacls.exe"), [ancestor, "/grant", "*S-1-1-0:F"], { cwd: system, encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    assert.throws(() => assertWindowsPrivate(authority, true), /ancestor DACL/);
  } finally { f.close(); }
});

test("private NTFS publication replaces existing files and rejects unsafe existing authority without repairing it", native, () => {
  const f = fixture();
  try {
    const savedRoot = process.env.SystemRoot;
    let store: PermissionStore;
    try {
      process.env.SystemRoot = f.project;
      store = new PermissionStore(f.directory);
      const resources = windowsSystemResources();
      assert.ok(resources.length > 0);
      assert.ok(resources.every((file) => lstatSync(file).isFile() && !within(f.directory, file)));
    } finally { process.env.SystemRoot = savedRoot; }
    assertWindowsPrivate(store.directory, true);
    assertNativeSemantics(bindPath(store.directory));
    const file = path.join(store.directory, STATE_FILE);
    writeFileSync(file, "original");
    assertWindowsPrivate(file, false);
    const temporary = path.join(store.directory, "replacement");
    writeFileSync(temporary, "replacement"); renameSync(temporary, file);
    assert.equal(readFileSync(file, "utf8"), "replacement");
    assertWindowsPrivate(file, false);
    const unsafe = path.join(f.directory, "unsafe"); mkdirSync(unsafe);
    const result = spawnSync(path.join(process.env.SystemRoot!, "System32", "icacls.exe"), [unsafe, "/grant", "*S-1-1-0:(OI)(CI)R"], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    assert.throws(() => assertWindowsPrivate(unsafe, true), /DACL/);
    assert.throws(() => createWindowsPrivateDirectory(unsafe), /DACL/);
    assert.throws(() => assertWindowsPrivate(unsafe, true), /DACL/);
    assert.ok(lstatSync(unsafe).isDirectory());
  } finally { f.close(); }
});
