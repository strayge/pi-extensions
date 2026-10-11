import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { createDirectTools } from "./direct-tools.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import type { PathRule } from "./schema.ts";

function fixture(rules: PathRule[] = []) {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-direct-"))).canonical;
  const project = path.join(dir, "project");
  mkdirSync(project);
  const config = defaultConfig();
  config.pathRules = rules;
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  const makeOwner = () => new PermissionOwner(
    resolveCatalog(config, { family: randomUUID(), binding: bindPath(project) }, { agentDir: dir, home: dir }),
    { ask: async () => { throw new Error("Project writes must not prompt"); } },
  );
  const owner = makeOwner();
  const ctx = {
    ...({ cwd: project } as ExtensionContext), tools: [],
    executeTool: async () => { throw new Error("Nested tools are not part of this fixture"); },
  };
  const write = (current = owner) => createDirectTools(() => current, project)[2];
  return { dir, project, owner, makeOwner, ctx, write, close: () => rmSync(dir, { recursive: true, force: true }) };
}

function afterAuthorization(owner: PermissionOwner, change: () => void): void {
  /** Reproduce a filesystem change after the execution binding has already been frozen. */
  const authorize = owner.authorize.bind(owner);
  owner.authorize = async (...args) => {
    const result = await authorize(...args);
    change();
    return result;
  };
}

test("parallel sibling writes create their shared missing parents without extra approval", async () => {
  const f = fixture();
  try {
    const names = ["README", "product", "architecture", "story-editing"];
    const results = await Promise.allSettled(names.map((name) => f.write().execute(name, {
      path: `docs/nested/${name}.md`, content: name,
    }, undefined, undefined, f.ctx)));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    for (const name of names) assert.equal(readFileSync(path.join(f.project, "docs", "nested", `${name}.md`), "utf8"), name);
    assert.equal(f.owner.snapshot().grants.length, 0);
  } finally { f.close(); }
});

test("independent owners can materialize the same missing parents concurrently", async () => {
  const f = fixture();
  try {
    const owners = [f.owner, f.makeOwner()];
    const results = await Promise.allSettled(owners.map((owner, i) => f.write(owner).execute(String(i), {
      path: `docs/${i}.md`, content: String(i),
    }, undefined, undefined, f.ctx)));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    for (let i = 0; i < owners.length; i++) assert.equal(readFileSync(path.join(f.project, "docs", `${i}.md`), "utf8"), String(i));
  } finally { f.close(); }
});

test("new real parent directories may appear after write authorization", async () => {
  const f = fixture();
  try {
    afterAuthorization(f.owner, () => mkdirSync(path.join(f.project, "docs")));
    await f.write().execute("created-parent", { path: "docs/deeper/file.md", content: "allowed" }, undefined, undefined, f.ctx);
    assert.equal(readFileSync(path.join(f.project, "docs", "deeper", "file.md"), "utf8"), "allowed");
  } finally { f.close(); }
});

test("writes through previously authorized symlinks can still create real parents", async () => {
  const f = fixture();
  try {
    const existing = path.join(f.project, "existing");
    mkdirSync(existing);
    symlinkSync(existing, path.join(f.project, "alias"));
    await f.write().execute("existing-alias", {
      path: "alias/docs/file.md", content: "allowed",
    }, undefined, undefined, f.ctx);
    assert.equal(readFileSync(path.join(existing, "docs", "file.md"), "utf8"), "allowed");
  } finally { f.close(); }
});

test("parent creation cannot adopt a new symlink or a newly created destination file", async () => {
  for (const change of ["symlink", "leaf", "non-directory"] as const) {
    const f = fixture();
    try {
      const docs = path.join(f.project, "docs");
      const elsewhere = path.join(f.dir, "elsewhere");
      mkdirSync(elsewhere);
      afterAuthorization(f.owner, () => {
        if (change === "symlink") symlinkSync(elsewhere, docs);
        else if (change === "non-directory") writeFileSync(docs, "not a directory");
        else { mkdirSync(docs); writeFileSync(path.join(docs, "file.md"), "concurrent file"); }
      });
      await assert.rejects(f.write().execute(change, { path: "docs/file.md", content: "replacement" }, undefined, undefined, f.ctx));
      if (change === "leaf") assert.equal(readFileSync(path.join(docs, "file.md"), "utf8"), "concurrent file");
      else if (change === "non-directory") assert.equal(readFileSync(docs, "utf8"), "not a directory");
      assert.equal(existsSync(path.join(elsewhere, "file.md")), false);
    } finally { f.close(); }
  }
});

test("an existing ancestor cannot be replaced while preparing a write", async () => {
  const f = fixture();
  try {
    const existing = path.join(f.project, "existing");
    mkdirSync(existing);
    afterAuthorization(f.owner, () => {
      renameSync(existing, `${existing}-old`);
      mkdirSync(path.join(existing, "docs"), { recursive: true });
    });
    await assert.rejects(f.write().execute("replaced-parent", {
      path: "existing/docs/file.md", content: "not allowed",
    }, undefined, undefined, f.ctx), /identity changed/);
    assert.equal(existsSync(path.join(existing, "docs", "file.md")), false);
  } finally { f.close(); }
});

test("refreshing a write binding keeps both original and newly observed parents pinned", async () => {
  for (const replaced of ["original", "new"] as const) {
    const f = fixture();
    try {
      const existing = path.join(f.project, "existing");
      const docs = path.join(existing, "docs");
      mkdirSync(existing);
      const check = f.owner.check.bind(f.owner);
      let prepared = false;
      f.owner.check = (revision) => {
        check(revision);
        if (!existsSync(docs)) return;
        if (!prepared) { prepared = true; return; }
        if (replaced === "original") {
          renameSync(existing, `${existing}-old`);
          mkdirSync(existing);
          renameSync(path.join(`${existing}-old`, "docs"), docs);
        } else {
          renameSync(docs, `${docs}-old`);
          mkdirSync(docs);
        }
      };
      await assert.rejects(f.write().execute(replaced, {
        path: "existing/docs/file.md", content: "not allowed",
      }, undefined, undefined, f.ctx), /identity changed/);
      assert.equal(existsSync(path.join(docs, "file.md")), false);
    } finally { f.close(); }
  }
});

test("advancing through several created parents does not forget an earlier parent identity", async () => {
  const f = fixture();
  try {
    const existing = path.join(f.project, "existing");
    const docs = path.join(existing, "docs");
    const deeper = path.join(docs, "deeper");
    mkdirSync(existing);
    afterAuthorization(f.owner, () => mkdirSync(docs));
    const check = f.owner.check.bind(f.owner);
    let prepared = false;
    f.owner.check = (revision) => {
      check(revision);
      if (!existsSync(deeper)) return;
      if (!prepared) { prepared = true; return; }
      renameSync(docs, `${docs}-old`);
      mkdirSync(docs);
      renameSync(path.join(`${docs}-old`, "deeper"), deeper);
    };
    await assert.rejects(f.write().execute("earlier-parent", {
      path: "existing/docs/deeper/file.md", content: "not allowed",
    }, undefined, undefined, f.ctx), /identity changed/);
    assert.equal(existsSync(path.join(deeper, "file.md")), false);
  } finally { f.close(); }
});

test("existing-file writes retain their original execution identity", async () => {
  const f = fixture();
  try {
    const file = path.join(f.project, "file.md");
    writeFileSync(file, "original");
    afterAuthorization(f.owner, () => {
      renameSync(file, `${file}-old`);
      writeFileSync(file, "concurrent replacement");
    });
    await assert.rejects(f.write().execute("replaced-file", { path: file, content: "not allowed" }, undefined, undefined, f.ctx), /identity changed/);
    assert.equal(readFileSync(file, "utf8"), "concurrent replacement");
  } finally { f.close(); }
});

test("safe parent creation does not bypass protected paths", async () => {
  const f = fixture([{ path: "docs/secret.md", scope: "file", write: "deny" }]);
  try {
    await assert.rejects(f.write().execute("denied", { path: "docs/secret.md", content: "not allowed" }, undefined, undefined, f.ctx), /access denied/);
    assert.equal(existsSync(path.join(f.project, "docs")), false);
  } finally { f.close(); }
});
