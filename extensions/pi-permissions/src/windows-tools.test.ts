import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { createDirectTools } from "./direct-tools.ts";
import { createSearchTools } from "./filtered-search.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import { runtime, type RuntimeFamily } from "./sandbox.ts";

const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((content) => content.text ?? "").join("\n");
test("native direct and search tools preserve slash patterns, junction classification and contained grep permissions", { skip: process.platform !== "win32" || process.env.PI_NATIVE_WINDOWS_MXC !== "1", timeout: 180000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "native-tools-")); const project = path.join(root, "project"); mkdirSync(project);
  const actualHome = homedir(); const previousProfile = process.env.USERPROFILE; const previousXdg = process.env.XDG_CONFIG_HOME;
  const files = ["src/a.ts", "src/nested/b.ts", "private/secret.ts"];
  for (const name of files) { mkdirSync(path.dirname(path.join(project, name)), { recursive: true }); writeFileSync(path.join(project, name), "needle\n"); }
  const metadata = [path.join(root, ".gitconfig"), path.join(root, ".config", "git", "config"), path.join(root, ".config", "git", "ignore")];
  for (const file of metadata) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, ""); }
  const outside = path.join(root, "unapproved"); mkdirSync(outside); writeFileSync(path.join(outside, "secret"), "private");
  const config = defaultConfig(); config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] }; config.modes.subproject = config.modes.project!;
  config.pathRules = [{ path: "private", scope: "tree", read: "deny" }, ...metadata.map((file) => ({ path: file, scope: "file" as const, read: "allow" as const }))];
  const catalog = resolveCatalog(config, { family: randomUUID(), binding: bindPath(project) }, { agentDir: root, home: root });
  const owner = new PermissionOwner(catalog, { ask: async () => undefined });
  const family: RuntimeFamily = { id: owner.id, network: () => owner.network.snapshot(), decideHost: (host, port) => owner.network.decide(host, port), decideHostWithRevision: (host, port, signal) => owner.network.decideWithRevision(host, port, undefined, signal) };
  try {
    await runtime.prepareWindows(family, { project: bindPath(project), agentDir: root, home: actualHome });
    process.env.USERPROFILE = root; process.env.XDG_CONFIG_HOME = path.join(root, ".config");
    const ctx = { ...({ cwd: project, hasUI: false } as ExtensionContext), tools: [], executeTool: async () => { throw new Error("No nested tools"); } };
    const [read, edit, write] = createDirectTools(() => owner, project); const [find, grep, ls] = createSearchTools(() => owner, project);
    await write.execute("write", { path: "spaced Кириллица.txt", content: "initial\n" }, undefined, undefined, ctx);
    await edit.execute("edit", { path: "spaced Кириллица.txt", edits: [{ oldText: "initial", newText: "changed" }] }, undefined, undefined, ctx);
    assert.match(text(await read.execute("read", { path: "spaced Кириллица.txt" }, undefined, undefined, ctx)), /changed/);
    assert.equal(readFileSync(path.join(project, "spaced Кириллица.txt"), "utf8"), "changed\n");
    await assert.rejects(read.execute("denied", { path: "private/secret.ts" }, undefined, undefined, ctx), /denied/);
    const shallow = text(await find.execute("find", { pattern: "src/*.ts" }, undefined, undefined, ctx)); assert.match(shallow, /src\/a\.ts/); assert.doesNotMatch(shallow, /nested\/b/);
    const nested = text(await find.execute("find", { pattern: "src/**/*.ts" }, undefined, undefined, ctx)); assert.match(nested, /nested\/b\.ts/);
    const matches = text(await grep.execute("grep", { pattern: "needle", glob: "**/*.ts" }, undefined, undefined, ctx)); assert.match(matches, /src\/a\.ts:1: needle/); assert.doesNotMatch(matches, /secret\.ts/);
    symlinkSync(path.join(project, "src"), path.join(project, "authorized-link"), "junction"); symlinkSync(outside, path.join(project, "blocked-link"), "junction");
    const entries = text(await ls.execute("ls", { path: "." }, undefined, undefined, ctx)); assert.match(entries, /authorized-link\//); assert.doesNotMatch(entries, /blocked-link\//); assert.match(entries, /blocked-link/);
  } finally {
    owner.block("test complete"); await owner.drain(); await runtime.shutdown(owner.id);
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});
