import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { createSearchTools } from "./filtered-search.ts";
import { bindPath } from "./paths.ts";
import { macRipgrep } from "./macos.ts";
import { resolveCatalog } from "./policy.ts";

const fd = path.join(process.env.HOME ?? "", ".pi", "agent", "bin", "fd");
const rg = process.platform === "darwin" ? macRipgrep() : "/usr/bin/rg";
test("fd and rg differential fixtures cover parent/tool ignore precedence, overrides, and lexical glob paths", {
  skip: !existsSync(fd) || !existsSync(rg),
}, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "permission-parity-"));
  const directory = path.join(rootDir, "project");
  mkdirSync(directory);
  const home = process.env.HOME;
  process.env.HOME = rootDir;
  const put = (file: string, contents: string) => {
    const target = path.join(rootDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  try {
    put(".gitignore", "parent-ignored.txt\n");
    put("project/.git/info/exclude", "public.txt\n");
    put("project/.gitignore", "!public.txt\nignored/\n");
    put("project/.fdignore", "tool.txt\n");
    put("project/.rgignore", "tool.txt\n");
    put("project/dir/.gitignore", "!tool.txt\n");
    for (const file of [
      "public.txt",
      "parent-ignored.txt",
      "Case.TXT",
      "dir/a.txt",
      "dir/tool.txt",
      "ignored/found.txt",
      "node_modules/visible.txt",
    ])
      put(`project/${file}`, "needle");
    const config = defaultConfig();
    config.pathRules = [];
    config.modes.project!.filesystem = { kind: "scoped", readOnly: [rootDir], readWrite: ["."], resourceReads: [] };
    config.modes.subproject = config.modes.project!;
    const root = { family: randomUUID(), binding: bindPath(directory) };
    const owner = new PermissionOwner(resolveCatalog(config, root, { agentDir: rootDir, home: rootDir }), {
      ask: async () => undefined,
    });
    const [find, grep] = createSearchTools(() => owner, directory);
    const ctx = { ...({ cwd: directory } as ExtensionContext), tools: [], executeTool: async () => { throw new Error("Nested tools are not part of this fixture"); } };
    const nativeFind = spawnSync(fd, ["--glob", "--hidden", "--color=never", "--", "*.txt", directory], {
      encoding: "utf8",
    });
    assert.equal(nativeFind.status, 0, nativeFind.stderr);
    const result = await find.execute("find", { pattern: "*.txt" }, undefined, undefined, ctx);
    const rendered = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    assert.deepEqual(
      rendered.split("\n").filter(Boolean).sort(),
      nativeFind.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((p) => path.relative(directory, p))
        .sort(),
    );
    for (const glob of [undefined, "*.txt", "**/*.txt", "!Case.TXT", "dir/*.txt", "/dir/*.txt", `${directory}/*.txt`]) {
      const native = spawnSync(
        rg,
        [
          "--no-config",
          "--files-with-matches",
          "--hidden",
          ...(glob ? ["--glob", glob] : []),
          "--",
          "needle",
          directory,
        ],
        { encoding: "utf8" },
      );
      assert.ok(native.status === 0 || native.status === 1, native.stderr);
      const actual = await grep.execute("grep", { pattern: "needle", glob }, undefined, undefined, ctx);
      const files = actual.content
        .map((c) => ("text" in c ? c.text : ""))
        .join("\n")
        .split("\n")
        .filter((line) => /:1: needle$/.test(line))
        .map((line) => line.replace(/:1: needle$/, ""))
        .sort();
      const expected = native.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((p) => path.relative(directory, p))
        .sort();
      assert.deepEqual(files, expected, `grep glob ${glob}`);
    }
  } finally {
    process.env.HOME = home;
    rmSync(rootDir, { recursive: true, force: true });
  }
});
