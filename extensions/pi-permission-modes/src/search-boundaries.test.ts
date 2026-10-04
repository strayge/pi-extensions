import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { createSearchTools } from "./filtered-search.ts";
import { macRipgrep } from "./macos.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";

function fixture() {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-ignore-"))).canonical;
  const project = path.join(dir, "project"); mkdirSync(project);
  const previousCwd = process.cwd(); process.chdir(project);
  const home = process.env.HOME; const xdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = dir; process.env.XDG_CONFIG_HOME = path.join(dir, ".config");
  const put = (file: string, content: string) => { const target = path.join(dir, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); };
  put(".gitconfig", `[core]\n excludesFile = ${path.join(dir, "global.ignore")}\n`);
  put("global.ignore", "/global-drop.txt\n");
  put(".gitignore", "parent-drop.txt\n");
  put("project/.git", "gitdir: ../metadata/worktrees/branch\n");
  put("metadata/worktrees/branch/commondir", "../..\n");
  put("metadata/info/exclude", "common-drop.txt\n");
  put("project/.gitignore", "nested-drop.txt\n");
  mkdirSync(path.join(project, "nested", ".git"), { recursive: true });
  for (const file of ["visible.txt", "global-drop.txt", "common-drop.txt", "parent-drop.txt", "nested-drop.txt", "nested/global-drop.txt", "nested/nested-drop.txt", "nested/common-drop.txt", "nested/visible.txt"]) put(`project/${file}`, "needle");
  const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [dir], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  const root = { family: randomUUID(), binding: bindPath(project) };
  const owner = () => new PermissionOwner(resolveCatalog(config, root, { agentDir: dir, home: dir }), { ask: async () => undefined });
  return {
    dir,
    project,
    config,
    put,
    owner,
    ctx: {
      ...({ cwd: project } as ExtensionContext),
      tools: [],
      executeTool: async () => { throw new Error("Nested tools are not part of this fixture"); },
    },
    close: () => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = xdg;
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  } };
}
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text ?? "").join("\n");

test("Gitfile/common-dir exclusions and anchored global rules respect nested repository boundaries", async () => {
  const f = fixture();
  try {
    const owner = f.owner(); const [, grep] = createSearchTools(() => owner, f.project);
    const actual = text(await grep.execute("search", { pattern: "needle" }, undefined, undefined, f.ctx))
      .split("\n").filter((line) => line.endsWith(":1: needle")).map((line) => line.slice(0, -10)).sort();
    const rg = process.platform === "darwin" ? macRipgrep() : "/usr/bin/rg";
    const native = spawnSync(rg, ["--no-config", "--hidden", "-l", "needle", f.project], { encoding: "utf8", cwd: f.project });
    assert.equal(native.status, 0, native.stderr);
    const expected = native.stdout.trim().split("\n").map((file) => path.relative(f.project, file)).sort();
    assert.deepEqual(actual, expected);
    assert.ok(!actual.includes("global-drop.txt")); assert.ok(actual.includes("nested/global-drop.txt"));
    assert.ok(actual.includes("nested/nested-drop.txt")); assert.ok(actual.includes("nested/common-drop.txt"));
    const nested = path.join(f.project, "nested");
    const inside = text(await grep.execute("nested-root", { pattern: "needle", path: nested }, undefined, undefined, f.ctx))
      .split("\n").filter((line) => line.endsWith(":1: needle")).map((line) => line.slice(0, -10)).sort();
    const nativeInside = spawnSync(rg, ["--no-config", "--hidden", "-l", "needle", nested], { encoding: "utf8", cwd: f.project });
    assert.equal(nativeInside.status, 0, nativeInside.stderr);
    assert.deepEqual(inside, nativeInside.stdout.trim().split("\n").map((file) => path.relative(nested, file)).sort());
  } finally { f.close(); }
});

test("unauthorized common metadata blocks search and a broken nested Gitfile only omits its subtree", async () => {
  const f = fixture();
  try {
    f.config.pathRules = [{ path: path.join(f.dir, "metadata"), scope: "tree", read: "deny" }];
    let owner = f.owner(); let [find] = createSearchTools(() => owner, f.project);
    await assert.rejects(find.execute("blocked", { pattern: "*.txt" }, undefined, undefined, f.ctx), /Search unavailable/);
    f.config.pathRules = [];
    f.put("project/broken/.git", "gitdir: missing-metadata\n"); f.put("project/broken/private.txt", "needle");
    owner = f.owner(); [find] = createSearchTools(() => owner, f.project);
    const result = text(await find.execute("nested", { pattern: "*.txt" }, undefined, undefined, f.ctx));
    assert.match(result, /visible.txt/); assert.doesNotMatch(result, /broken\/private.txt/); assert.match(result, /unavailable ignore context/);
  } finally { f.close(); }
});

test("discovered dangling and unauthorized link chains never resolve outside targets or abort searches", async (t) => {
  const f = fixture();
  try {
    const outside = path.join(f.dir, "outside-private"); mkdirSync(outside);
    const hop = path.join(outside, "hop"); symlinkSync(f.project, hop);
    symlinkSync(path.join(outside, "missing"), path.join(f.project, "dangling"));
    symlinkSync(hop, path.join(f.project, "private-link"));
    symlinkSync("nested", path.join(f.project, "allowed-link"));
    f.config.pathRules = [{ path: outside, scope: "tree", read: "deny" }];
    const syncReadlink = fs.readlinkSync; const asyncReadlink = fsPromises.readlink;
    t.mock.method(fs, "readlinkSync", (...args: Parameters<typeof syncReadlink>) => {
      assert.ok(!String(args[0]).startsWith(outside), "resolved an unauthorized link hop");
      return syncReadlink(...args);
    });
    t.mock.method(fsPromises, "readlink", (...args: Parameters<typeof asyncReadlink>) => {
      assert.ok(!String(args[0]).startsWith(outside), "followed an unauthorized link hop");
      return asyncReadlink(...args);
    });
    syncBuiltinESMExports();
    const owner = f.owner(); const [find, grep, ls] = createSearchTools(() => owner, f.project);
    const listing = text(await ls.execute("links", {}, undefined, undefined, f.ctx));
    assert.match(listing, /^dangling$/m); assert.match(listing, /^private-link$/m);
    assert.match(listing, /^allowed-link\/$/m); assert.match(listing, /visible.txt/);
    const found = text(await find.execute("find-links", { pattern: "*" }, undefined, undefined, f.ctx));
    const matches = text(await grep.execute("grep-links", { pattern: "needle" }, undefined, undefined, f.ctx));
    for (const result of [found, matches]) {
      assert.match(result, /visible.txt/); assert.match(result, /3 discovered symlinks not followed/);
      assert.doesNotMatch(result, /private-link|dangling|allowed-link/);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test("known exact-file exceptions remain searchable without enumerating a denied parent", async (t) => {
  const f = fixture();
  try {
    f.put("project/private/notes.txt", "allowed needle"); f.put("project/private/sibling.txt", "secret needle");
    f.config.pathRules = [
      { path: "private", scope: "tree", read: "deny" },
      { path: "private/notes.txt", scope: "file", read: "allow" },
    ];
    const parent = path.join(f.project, "private"); const file = path.join(parent, "notes.txt");
    const readdir = fsPromises.readdir;
    t.mock.method(fsPromises, "readdir", (...args: Parameters<typeof readdir>) => {
      assert.notEqual(String(args[0]), parent, "enumerated a denied parent to find an exception");
      return readdir(...args);
    });
    syncBuiltinESMExports();
    const owner = f.owner(); const [find, grep] = createSearchTools(() => owner, f.project);
    const broad = text(await find.execute("broad", { pattern: "*.txt" }, undefined, undefined, f.ctx));
    assert.doesNotMatch(broad, /private\/notes|sibling.txt/); assert.match(broad, /omitted by filesystem permissions/);
    assert.match(text(await find.execute("known", { pattern: "*.txt", path: file }, undefined, undefined, f.ctx)), /^notes.txt$/m);
    assert.match(text(await grep.execute("known-content", { pattern: "needle", path: file }, undefined, undefined, f.ctx)), /allowed needle/);
    await assert.rejects(grep.execute("parent", { pattern: "needle", path: parent }, undefined, undefined, f.ctx), /denied/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test("cancellation after directory enumeration prevents every subsequent content open", async (t) => {
  const f = fixture();
  try {
    const owner = f.owner(); const [, grep] = createSearchTools(() => owner, f.project);
    const controller = new AbortController(); const readdir = fsPromises.readdir;
    t.mock.method(fsPromises, "readdir", async (...args: Parameters<typeof readdir>) => {
      const result = await readdir(...args); controller.abort(); return result;
    });
    t.mock.method(fs, "createReadStream", () => { assert.fail("content opened after traversal cancellation"); });
    syncBuiltinESMExports();
    await assert.rejects(grep.execute("cancel", { pattern: "needle" }, controller.signal, undefined, f.ctx), /abort/i);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});
