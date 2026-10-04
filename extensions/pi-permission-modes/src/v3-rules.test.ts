import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDirectTools } from "./direct-tools.ts";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { decide, positiveTarget, resolveCatalog } from "./policy.ts";
import { compileFilesystem, RuntimeCoordinator } from "./sandbox.ts";
import type { Access, PathRule } from "./schema.ts";

function fixture() {
  const directory = bindPath(mkdtempSync(path.join(tmpdir(), "permission-v3-"))).canonical;
  const work = path.join(directory, "work");
  mkdirSync(path.join(work, "private"), { recursive: true });
  const file = path.join(work, "private", "notes.txt");
  writeFileSync(file, "NOTE"); writeFileSync(path.join(work, "private", "sibling"), "SECRET-SIBLING");
  const config = defaultConfig();
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
  config.modes.subproject = config.modes.project!;
  config.pathRules = [{ path: "private", scope: "tree", read: "deny" }];
  const root = { family: randomUUID(), binding: bindPath(work) };
  const context = { agentDir: directory, home: directory };
  return { directory, work, file, root, context, config, owner: () => new PermissionOwner(resolveCatalog(config, root, context), { ask: async () => undefined }), close: () => rmSync(directory, { recursive: true, force: true }) };
}
const cases: { name: string; declaration?: Partial<PathRule>; receipt?: Access; read: boolean; write: boolean }[] = [
  { name: "no exception", read: false, write: false },
  { name: "read allow", declaration: { read: "allow" }, read: true, write: false },
  { name: "write allow", declaration: { write: "allow" }, read: true, write: true },
  { name: "approved read ask", declaration: { read: "ask" }, receipt: "read", read: true, write: false },
  { name: "approved write ask", declaration: { write: "ask" }, receipt: "write", read: true, write: true },
];

for (const row of cases) {
  test(`baseline R/W with parent read denial: ${row.name}`, () => {
    const f = fixture();
    try {
      if (row.declaration) f.config.pathRules.push({ path: "private/notes.txt", scope: "file", ...row.declaration });
      const snapshot = f.owner().snapshot();
      const target = bindPath(f.file);
      if (row.receipt) {
        const pending = decide(snapshot, target, row.receipt);
        assert.equal(pending.action, "ask"); assert.equal(pending.directory, false);
      }
      const approved = { ...snapshot, exceptions: row.receipt ? [{ id: randomUUID(), ruleId: snapshot.rules[1]!.id, access: row.receipt, lifetime: "session" as const }] : [] };
      assert.equal(decide(approved, target, "read").action === "allow", row.read);
      assert.equal(decide(approved, target, "write").action === "allow", row.write);
      assert.equal(decide(approved, bindPath(path.join(f.work, "private", "sibling")), "read").action, "deny");
      const compiled = compileFilesystem(approved).explicitPolicy!;
      const entry = compiled.program.find((r) => r.path === f.file);
      if (row.declaration) assert.deepEqual([entry?.read, entry?.write], [row.read, row.write]);
      assert.ok(compiled.program.some((r) => r.path === path.dirname(f.file) && !r.read && !r.write));
    } finally { f.close(); }
  });
}

const native = process.platform === "darwin" || (process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/socat"));
test("native operation program enforces the compact matrix without reopening ancestors or siblings", { skip: !native }, async () => {
  for (const row of cases) {
    const f = fixture(); const runtime = new RuntimeCoordinator();
    try {
      if (row.declaration) f.config.pathRules.push({ path: "private/notes.txt", scope: "file", ...row.declaration });
      const snapshot = f.owner().snapshot();
      const approved = { ...snapshot, exceptions: row.receipt ? [{ id: randomUUID(), ruleId: snapshot.rules[1]!.id, access: row.receipt, lifetime: "session" as const }] : [] };
      let output = "";
      const result = await runtime.operations(approved, { id: f.root.family, network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }), decideHost: async () => false }, () => {}).exec(
        "if cat private/notes.txt; then echo READ-OK; fi; if printf W >> private/notes.txt; then echo WRITE-OK; fi; cat private/sibling; mv private moved; echo SAFE > sibling; echo DONE",
        f.work, { onData: (data) => { output += data; } },
      );
      assert.equal(result.exitCode, 0, output);
      assert.equal(output.includes("READ-OK"), row.read, `${row.name}: ${output}`);
      assert.equal(output.includes("WRITE-OK"), row.write, `${row.name}: ${output}`);
      assert.doesNotMatch(output, /SECRET-SIBLING/);
      assert.equal(readFileSync(f.file, "utf8"), row.write ? "NOTEW" : "NOTE");
      assert.equal(readFileSync(path.join(f.work, "sibling"), "utf8").trim(), "SAFE");
      assert.equal(existsSync(path.join(f.work, "moved")), false);
    } finally { await runtime.shutdown(f.root.family); f.close(); }
  }
});

test("native tree exceptions permit metadata and entry operations while deeper restrictions and ancestor guards remain intact", { skip: !native }, async () => {
  const f = fixture(); const runtime = new RuntimeCoordinator();
  try {
    const open = path.join(f.work, "private", "open"); mkdirSync(open);
    const secret = path.join(open, "secret"); writeFileSync(secret, "DEEP-SECRET");
    f.config.pathRules.push({ path: "private/open", scope: "tree", write: "allow" }, { path: "private/open/secret", scope: "file", read: "deny" });
    let output = "";
    const result = await runtime.operations(f.owner().snapshot(), { id: f.root.family, network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }), decideHost: async () => false }, () => {}).exec(
      "printf A > private/open/edit; printf B >> private/open/edit; printf C > private/open/edit; chmod 640 private/open/edit; printf TEMP > private/open/temp; mv private/open/temp private/open/renamed; rm private/open/renamed; cat private/open/secret; printf WRONG >> private/open/secret; rm private/open/secret; printf WRONG > private/unauthorized-lock; mv private moved; echo DONE",
      f.work, { onData: (data) => { output += data; } },
    );
    assert.equal(result.exitCode, 0, output);
    assert.equal(readFileSync(path.join(open, "edit"), "utf8"), "C");
    assert.equal(statSync(path.join(open, "edit")).mode & 0o777, 0o640);
    assert.equal(existsSync(path.join(open, "temp")), false);
    assert.equal(existsSync(path.join(open, "renamed")), false);
    assert.equal(readFileSync(secret, "utf8"), "DEEP-SECRET");
    assert.doesNotMatch(output, /DEEP-SECRET/);
    assert.equal(existsSync(path.join(f.work, "private", "unauthorized-lock")), false);
    assert.equal(existsSync(path.join(f.work, "moved")), false);
  } finally { await runtime.shutdown(f.root.family); f.close(); }
});

test("positive tree allows and approved asks never authorize escaping descendant symlinks", async () => {
  for (const row of cases.filter((row) => row.declaration)) {
    const f = fixture(); const runtime = new RuntimeCoordinator();
    try {
      const outside = path.join(f.directory, "outside"); mkdirSync(outside);
      const secret = path.join(outside, "secret"); writeFileSync(secret, "ESCAPED-SECRET");
      symlinkSync(outside, path.join(f.work, "private", "link"));
      f.config.pathRules = [{ path: "private", scope: "tree", ...row.declaration }];
      const owner = f.owner();
      if (row.receipt) {
        owner.ask = async () => ({ lifetime: "session" });
        await owner.authorize([f.file], row.receipt, "inside the declared tree");
        owner.ask = async () => undefined;
      }
      const alias = path.join(f.work, "private", "link", "secret");
      assert.notEqual(decide(owner.snapshot(), bindPath(alias), "read").action, "allow", row.name);
      assert.notEqual(decide(owner.snapshot(), bindPath(alias), "write").action, "allow", row.name);
      const [read, , write] = createDirectTools(() => owner, f.work);
      const ctx = { ...({ cwd: f.work } as ExtensionContext), tools: [], executeTool: async () => { throw new Error("Nested tools are not part of this fixture"); } };
      await assert.rejects(read.execute("read", { path: alias }, undefined, undefined, ctx), /denied/);
      await assert.rejects(write.execute("write", { path: alias, content: "ESCAPED" }, undefined, undefined, ctx), /denied/);
      if (native) {
        let output = "";
        await runtime.operations(owner.snapshot(), { id: f.root.family, network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }), decideHost: async () => false }, () => {}).exec(
          "cat private/link/secret; printf ESCAPED >> private/link/secret; echo DONE", f.work, { onData: (data) => { output += data; } },
        );
        assert.doesNotMatch(output, /ESCAPED-SECRET/);
      }
      assert.equal(readFileSync(secret, "utf8"), "ESCAPED-SECRET");
    } finally { await runtime.shutdown(f.root.family); f.close(); }
  }
});

test("macOS rejects stale positive regions after profile generation without banning ordinary file leaf replacement", { skip: process.platform !== "darwin" }, async () => {
  for (const substitution of ["directory", "file-parent", "file-leaf"] as const) {
    const f = fixture(); const runtime = new RuntimeCoordinator();
    try {
      const outside = path.join(f.directory, "outside"); mkdirSync(outside);
      const secret = path.join(outside, "secret"); writeFileSync(secret, "ORIGINAL");
      f.config.pathRules = [{ path: substitution === "directory" ? outside : secret, scope: substitution === "directory" ? "tree" : "file", write: "allow" }];
      const snapshot = f.owner().snapshot(); let output = "";
      const run = runtime.operations(snapshot, { id: f.root.family, network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }), decideHost: async () => false }, () => {
        if (substitution === "file-leaf") { writeFileSync(`${secret}.new`, "REPLACEMENT"); renameSync(`${secret}.new`, secret); }
        else { renameSync(outside, `${outside}-old`); mkdirSync(outside); writeFileSync(secret, "REPLACEMENT"); }
      }).exec(`cat '${secret}'; printf CHANGED >> '${secret}'`, f.work, { onData: (data) => { output += data; } });
      if (substitution === "file-leaf") {
        assert.equal((await run).exitCode, 0);
        assert.match(output, /REPLACEMENT/);
        assert.equal(readFileSync(secret, "utf8"), "REPLACEMENTCHANGED");
      } else {
        await assert.rejects(run, /permission program changed/);
        assert.equal(output, "");
        assert.equal(readFileSync(secret, "utf8"), "REPLACEMENT");
      }
    } finally { await runtime.shutdown(f.root.family); f.close(); }
  }
});

test("Linux argument generation constructs exception destinations before sealing masks and before private facilities", async () => {
  const f = fixture();
  const module = await import(new URL("./sandbox/linux-sandbox-utils.js", import.meta.resolve("@anthropic-ai/sandbox-runtime")).href);
  try {
    f.config.pathRules.push({ path: "private/notes.txt", scope: "file", write: "allow" });
    const policy = compileFilesystem(f.owner().snapshot()).explicitPolicy!;
    policy.sourceFds = Object.fromEntries(Object.keys(policy.bindings).map((key, index) => [key, index + 3]));
    const generated = await module.wrapCommandWithSandboxLinux({
      command: "true", needsNetworkRestriction: false, allowAllUnixSockets: true, binShell: "/bin/bash", bwrapPath: "/test/bwrap",
      readConfig: { denyOnly: [], allowWithinDeny: [], explicitPolicy: policy },
      writeConfig: { allowOnly: [], denyWithinAllow: [], explicitPolicy: policy },
    });
    const mask = `--tmpfs ${path.dirname(f.file)}`;
    const leaf = `--bind-fd ${policy.sourceFds[f.file]} ${f.file}`;
    const seal = `--remount-ro ${path.dirname(f.file)}`;
    assert.ok(generated.includes(mask), generated);
    assert.ok(generated.indexOf(leaf) > generated.indexOf(mask), generated);
    assert.ok(generated.indexOf(seal) > generated.indexOf(leaf), generated);
    assert.ok(generated.indexOf("--dev /dev") > generated.indexOf(seal), generated);
    assert.ok(generated.indexOf("--proc /proc") > generated.indexOf(seal), generated);
    assert.ok(!generated.includes(`--bind-fd ${policy.sourceFds[path.dirname(f.file)]} ${path.dirname(f.file)}`));
  } finally { module.cleanupBwrapMountPoints(); f.close(); }
});

test("conditional asks outside the profile materialize R/W without an unrelated parent grant", async () => {
  const f = fixture();
  try {
    const outside = path.join(f.directory, "outside"); writeFileSync(outside, "OUTSIDE");
    f.config.pathRules = [{ path: outside, scope: "file", write: "ask" }];
    const owner = f.owner(); const prompts: string[] = [];
    owner.ask = async (request) => { prompts.push(`${request.kind}:${request.access}`); return { lifetime: "session" }; };
    assert.equal(decide(owner.snapshot(), bindPath(outside), "read").directory, true);
    await owner.authorize([outside], "write", "conditional access");
    assert.deepEqual(prompts, ["exception:write"]);
    assert.equal(owner.snapshot().grants.length, 0);
    assert.equal(decide(owner.snapshot(), bindPath(outside), "read").action, "allow");
    assert.equal(decide(owner.snapshot(), bindPath(outside), "write").action, "allow");
  } finally { f.close(); }
});

test("all equally winning asks need their receipts and equal deny wins independent of list order", async () => {
  const f = fixture();
  try {
    f.config.pathRules = [
      { path: "private/notes.txt", scope: "file", read: "allow" },
      { path: f.file, scope: "file", read: "ask" },
      { path: "./private/notes.txt", scope: "file", read: "ask" },
    ];
    const owner = f.owner(); let prompts = 0;
    owner.ask = async () => { prompts++; return { lifetime: "session" }; };
    await owner.authorize([f.file], "read", "all receipts");
    assert.equal(prompts, 2);
    f.config.pathRules.push({ path: "private/./notes.txt", scope: "file", read: "deny" });
    for (const rules of [f.config.pathRules, [...f.config.pathRules].reverse()]) {
      f.config.pathRules = rules;
      assert.equal(decide(f.owner().snapshot(), bindPath(f.file), "read").action, "deny");
    }
  } finally { f.close(); }
});

test("session and project grants form the same narrow exception without broadening a file grant", async () => {
  for (const lifetime of ["session", "project"] as const) {
    const f = fixture();
    try {
      const owner = f.owner(); owner.ask = async () => ({ lifetime });
      await owner.requestGrant(f.file, "read", "narrow read");
      assert.equal(decide(owner.snapshot(), bindPath(f.file), "read").action, "allow");
      assert.equal(decide(owner.snapshot(), bindPath(f.file), "write").action, "deny");
      assert.equal(decide(owner.snapshot(), bindPath(path.dirname(f.file)), "read").action, "deny");
    } finally { f.close(); }
  }
});

test("invalid and dormant positive sources do not disable valid policy or mount a parent", () => {
  const f = fixture();
  try {
    const outside = path.join(f.directory, "outside"); writeFileSync(outside, "ORIGINAL");
    f.config.pathRules = [{ path: outside, scope: "file", read: "allow" }, { path: path.join(f.directory, "missing"), scope: "file", write: "allow" }];
    const owner = f.owner();
    assert.equal(positiveTarget(owner.snapshot().rules[1]!.binding, "file").state, "dormant");
    assert.equal(decide(owner.snapshot(), bindPath(outside), "read").action, "allow");
    renameSync(outside, outside + "-old"); writeFileSync(outside, "REPLACED");
    assert.equal(decide(owner.snapshot(), bindPath(outside), "read").action, "allow");
    rmSync(outside); mkdirSync(outside);
    assert.equal(positiveTarget(owner.snapshot().rules[0]!.binding, "file").state, "blocked");
    assert.equal(decide(owner.snapshot(), bindPath(outside), "read").action, "ask");
    assert.ok(!compileFilesystem(owner.snapshot()).allowRead.includes(outside));
    const malformedPositive = f.owner();
    assert.equal(malformedPositive.snapshot().rules[0]!.binding, undefined);
    rmSync(outside, { recursive: true }); symlinkSync(outside + "-old", outside);
    assert.equal(positiveTarget(owner.snapshot().rules[0]!.binding, "file").state, "blocked");
  } finally { f.close(); }
});
