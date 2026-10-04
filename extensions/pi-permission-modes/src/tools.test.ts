import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionOwner, type AskApproval } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { createDirectTools } from "./direct-tools.ts";
import { createSearchTools } from "./filtered-search.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";

function fixture(ask: AskApproval = async () => undefined) {
  const directory = fs.realpathSync.native(mkdtempSync(path.join(tmpdir(), "permission-tools-")));
  writeFileSync(path.join(directory, "auth.json"), "credential");
  const home = process.env.HOME;
  process.env.HOME = directory;
  const config = defaultConfig();
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  config.pathRules = [{ path: "auth.json", scope: "file", read: "ask", write: "ask" }];
  const root = { family: randomUUID(), binding: bindPath(directory) };
  const catalog = resolveCatalog(config, root, { agentDir: directory, home: directory });
  const owner = new PermissionOwner(catalog, { ask });
  const context = { cwd: directory, hasUI: false } as ExtensionContext;
  return {
    directory,
    owner,
    context,
    close: () => {
      process.env.HOME = home;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

test("direct tools execute authorized fallback spelling and leave content and patches untouched", async () => {
  const f = fixture();
  try {
    const [read, edit, write] = createDirectTools(() => f.owner, f.directory);
    const chosen = path.join(f.directory, "Shot 1\u202FPM.png");
    writeFileSync(chosen, `literal file://${chosen}`);
    const result = await read.execute("read", { path: "Shot 1 PM.png" }, undefined, undefined, f.context);
    assert.equal(text(result), `literal file://${chosen}`);
    await write.execute("write", { path: ".env", content: "old" }, undefined, undefined, f.context);
    const edited = await edit.execute(
      "edit",
      { path: ".env", edits: [{ oldText: "old", newText: "$& file:///literal" }] },
      undefined,
      undefined,
      f.context,
    );
    assert.match(edited.details!.patch, /\$& file:\/\/\/literal/);
    assert.equal(readFileSync(path.join(f.directory, ".env"), "utf8"), "$& file:///literal");
    if (fs.existsSync(path.join(f.directory, "AUTH.JSON"))) {
      await assert.rejects(read.execute("case-alias", { path: "AUTH.JSON" }, undefined, undefined, f.context), /denied/);
    } else {
      writeFileSync(path.join(f.directory, "AUTH.JSON"), "case-distinct");
      assert.match(
        text(await read.execute("case-distinct", { path: "AUTH.JSON" }, undefined, undefined, f.context)),
        /case-distinct/,
      );
    }
    writeFileSync(path.join(f.directory, "oversized$&.txt"), "x".repeat(60000));
    assert.match(
      text(await read.execute("long", { path: "oversized$&.txt" }, undefined, undefined, f.context)),
      /oversized\$&\.txt \| head/,
    );
    await assert.rejects(read.execute("secret", { path: "auth.json" }, undefined, undefined, f.context), /denied/);
  } finally {
    f.close();
  }
});

test("search excludes credentials before reading and supports explicit roots without following discovered links", async (t) => {
  const f = fixture();
  const denied = path.join(f.directory, "auth.json");
  const checkRead = (value: unknown) => {
    if (typeof value !== "string") return;
    let canonical = value;
    try {
      canonical = fs.realpathSync(value);
    } catch {}
    assert.notEqual(canonical, denied, "credential content must never be opened");
  };
  const originalRead = fsPromises.readFile;
  const originalStream = fs.createReadStream;
  t.mock.method(fsPromises, "readFile", (...args: Parameters<typeof originalRead>) => {
    checkRead(args[0]);
    return originalRead(...args);
  });
  t.mock.method(fs, "createReadStream", (...args: Parameters<typeof originalStream>) => {
    checkRead(args[0]);
    return originalStream(...args);
  });
  syncBuiltinESMExports();
  try {
    writeFileSync(path.join(f.directory, "auth.json"), "needle SECRET");
    writeFileSync(path.join(f.directory, "public.txt"), "needle public");
    mkdirSync(path.join(f.directory, "dir"));
    writeFileSync(path.join(f.directory, "dir", "other.txt"), "needle other");
    symlinkSync("dir", path.join(f.directory, "link"));
    symlinkSync("auth.json", path.join(f.directory, "credential-link"));
    const [find, grep, ls] = createSearchTools(() => f.owner, f.directory);
    const found = text(await find.execute("find", { pattern: "*" }, undefined, undefined, f.context));
    assert.doesNotMatch(found, /auth\.json|credential-link/);
    assert.match(found, /symlinks not followed/);
    const matches = text(await grep.execute("grep", { pattern: "needle" }, undefined, undefined, f.context));
    assert.match(matches, /needle public/);
    assert.doesNotMatch(matches, /SECRET/);
    assert.match(text(await ls.execute("ls", {}, undefined, undefined, f.context)), /link\//);
    assert.match(
      text(await find.execute("alias", { pattern: "*", path: "link" }, undefined, undefined, f.context)),
      /other.txt/,
    );
    symlinkSync(f.directory, path.join(f.directory, "self"));
    assert.doesNotMatch(
      text(await grep.execute("alias-root", { pattern: "needle", path: "self" }, undefined, undefined, f.context)),
      /SECRET/,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test("ignore source precedence, metadata symlink omission, and empty/malformed glob contracts", async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.directory, ".git", "info"), { recursive: true });
    writeFileSync(path.join(f.directory, ".git", "info", "exclude"), "public.txt\n");
    writeFileSync(path.join(f.directory, ".gitignore"), "!public.txt\n");
    writeFileSync(path.join(f.directory, "public.txt"), "public");
    mkdirSync(path.join(f.directory, "unsafe"));
    writeFileSync(path.join(f.directory, "unsafe", "hidden"), "never listed");
    symlinkSync("../auth.json", path.join(f.directory, "unsafe", ".ignore"));
    const [find, grep] = createSearchTools(() => f.owner, f.directory);
    const result = text(await find.execute("find", { pattern: "" }, undefined, undefined, f.context));
    assert.match(result, /public.txt/);
    assert.doesNotMatch(result, /unsafe\/hidden/);
    assert.match(result, /unavailable ignore context/);
    await assert.rejects(find.execute("bad", { pattern: "[!]" }, undefined, undefined, f.context), /Invalid glob/);
    await assert.rejects(
      grep.execute("bad", { pattern: "public", glob: "[^]" }, undefined, undefined, f.context),
      /Invalid glob/,
    );
    await assert.rejects(find.execute("abort", { pattern: "*" }, AbortSignal.abort(), undefined, f.context));
  } finally {
    f.close();
  }
});
