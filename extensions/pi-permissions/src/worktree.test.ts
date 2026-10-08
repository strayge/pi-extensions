import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, initTheme, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { PermissionStore, STATE_FILE } from "./permission-state.ts";
import { decide, resolveCatalog } from "./policy.ts";
import { compileFilesystem, RuntimeCoordinator } from "./sandbox.ts";
import { automaticWorktreeGrants } from "./worktree.ts";

function fixture(mainName = "main") {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-worktree-"))).canonical;
  const main = path.join(dir, mainName); const worktree = path.join(dir, "linked worktree");
  const common = path.join(main, ".git"); const git = path.join(common, "worktrees", "linked");
  for (const folder of [main, worktree, common, path.join(common, "worktrees"), git, path.join(common, "objects"), path.join(common, "refs")]) mkdirSync(folder);
  writeFileSync(path.join(worktree, ".git"), `gitdir: ${git}\n`);
  writeFileSync(path.join(git, "commondir"), "../..\n");
  writeFileSync(path.join(git, "gitdir"), `${path.join(worktree, ".git")}\n`);
  for (const folder of [git, common]) writeFileSync(path.join(folder, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(common, "config"), "[core]\n\trepositoryformatversion = 0\n");
  writeFileSync(path.join(main, "private"), "MAIN-CHECKOUT-SECRET");
  const root = { family: randomUUID(), binding: bindPath(worktree) };
  const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  const context = { agentDir: dir, home: dir };
  const catalog = () => resolveCatalog(config, root, context);
  const owner = () => new PermissionOwner(catalog(), { ask: async () => assert.fail("Automatic access must not prompt") });
  return { dir, main, worktree, common, git, root, config, context, catalog, owner, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("starting-worktree metadata is automatic R/W baseline, not authority over the main checkout", async () => {
  const f = fixture();
  try {
    const owner = f.owner();
    assert.deepEqual(owner.snapshot().profile.grants.filter((g) => g.definition?.startsWith("worktree:")).map((g) => [g.binding.canonical, g.access]), [[f.common, "write"]]);
    assert.equal(owner.snapshot().grants.length, 0);
    for (const file of [path.join(f.common, "objects", "new"), path.join(f.git, "HEAD")]) {
      assert.equal(decide(owner.snapshot(), bindPath(file), "read").action, "allow");
      assert.equal(decide(owner.snapshot(), bindPath(file), "write").action, "allow");
      await owner.authorize([file], "write", "Git metadata");
    }
    assert.equal(decide(owner.snapshot(), bindPath(f.main), "read").action, "ask");
    assert.equal(decide(owner.snapshot(), bindPath(path.join(f.main, "private")), "read").action, "ask");
    const compiled = compileFilesystem(owner.snapshot());
    assert.ok(compiled.allowWrite.includes(f.common));
    assert.ok(!compiled.allowRead.includes(f.main));
    owner.select("subproject");
    assert.equal(decide(owner.snapshot(), bindPath(f.common), "write").action, "allow");
    const other = path.join(f.dir, "other"); mkdirSync(other);
    assert.equal(decide(owner.snapshot(), bindPath(other), "write").action, "ask");
  } finally { f.close(); }
});

test("ancestor discovery accepts relative Gitfiles, canonical root aliases, and detached HEADs", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.worktree, ".git"), `gitdir: ${path.relative(f.worktree, f.git)}\n`);
    writeFileSync(path.join(f.git, "HEAD"), `${"a".repeat(40)}\n`);
    writeFileSync(path.join(f.git, "gitdir"), `${path.relative(f.git, path.join(f.worktree, ".git"))}\n`);
    mkdirSync(path.join(f.worktree, "nested"));
    symlinkSync(path.join(f.worktree, "nested"), path.join(f.dir, "alias"));
    assert.equal(automaticWorktreeGrants(bindPath(path.join(f.dir, "alias")))[0]?.binding.canonical, f.common);
    assert.deepEqual(automaticWorktreeGrants(bindPath(f.main)), []);
    writeFileSync(path.join(f.worktree, "nested", ".git"), `gitdir: ${path.join(f.common, "modules", "nested")}\n`);
    assert.deepEqual(automaticWorktreeGrants(bindPath(path.join(f.worktree, "nested"))), []);
  } finally { f.close(); }
});

test("malformed, unrelated, and symlinked metadata never grant access or disable scoped policy", () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => writeFileSync(path.join(f.worktree, ".git"), `gitdir: ${f.main}\n`),
    (f: ReturnType<typeof fixture>) => writeFileSync(path.join(f.worktree, ".git"), `gitdir: ${f.git}\nextra\n`),
    (f: ReturnType<typeof fixture>) => writeFileSync(path.join(f.worktree, ".git"), `gitdir: ${"a".repeat(8193)}`),
    (f: ReturnType<typeof fixture>) => writeFileSync(path.join(f.git, "commondir"), `${f.dir}\n`),
    (f: ReturnType<typeof fixture>) => writeFileSync(path.join(f.git, "gitdir"), `${path.join(f.main, "private")}\n`),
    (f: ReturnType<typeof fixture>) => writeFileSync(path.join(f.git, "HEAD"), "invalid\n"),
    (f: ReturnType<typeof fixture>) => rmSync(path.join(f.common, "objects"), { recursive: true }),
    (f: ReturnType<typeof fixture>) => { renameSync(path.join(f.git, "commondir"), path.join(f.git, "real-commondir")); symlinkSync("real-commondir", path.join(f.git, "commondir")); },
    (f: ReturnType<typeof fixture>) => { renameSync(path.join(f.worktree, ".git"), path.join(f.worktree, "gitfile")); symlinkSync("gitfile", path.join(f.worktree, ".git")); },
    (f: ReturnType<typeof fixture>) => { renameSync(f.git, `${f.git}-real`); symlinkSync(`${f.git}-real`, f.git); },
    (f: ReturnType<typeof fixture>) => { renameSync(path.dirname(f.git), `${path.dirname(f.git)}-real`); symlinkSync(`${path.dirname(f.git)}-real`, path.dirname(f.git)); },
    (f: ReturnType<typeof fixture>) => { renameSync(f.common, path.join(f.dir, "relocated-git")); symlinkSync(path.join(f.dir, "relocated-git"), f.common); },
  ];
  for (const invalidate of cases) {
    const f = fixture();
    try {
      invalidate(f);
      assert.deepEqual(automaticWorktreeGrants(f.root.binding), []);
      const owner = f.owner();
      assert.equal(owner.snapshot().profile.kind, "scoped");
      assert.equal(decide(owner.snapshot(), bindPath(f.common), "write").action, "ask");
    } finally { f.close(); }
  }
});

test("unrepresentable automatic metadata paths do not prevent unrelated sandbox commands", async () => {
  const f = fixture("main[repo]"); const runtime = new RuntimeCoordinator();
  try {
    const owner = f.owner();
    assert.deepEqual(automaticWorktreeGrants(f.root.binding), []);
    assert.doesNotThrow(() => compileFilesystem(owner.snapshot()));
    if (process.platform === "darwin") {
      f.config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
      const withSystem = f.owner();
      const family = { id: f.root.family, network: () => withSystem.network.snapshot(), decideHost: async () => false };
      let output = "";
      const result = await runtime.operations(withSystem.snapshot(), family, () => {}).exec("echo UNRELATED-COMMAND", f.worktree, { onData: (data) => { output += data; } });
      assert.equal(result.exitCode, 0, output);
      assert.match(output, /UNRELATED-COMMAND/);
    }
  } finally { await runtime.shutdown(f.root.family); f.close(); }
});

test("metadata pins survive reloads through configurations with no scoped profiles", async () => {
  const f = fixture();
  try {
    const owner = f.owner(); const config = structuredClone(f.config);
    for (const mode of Object.values(config.modes)) mode.filesystem = { kind: "unrestricted" };
    await owner.reload(config, undefined, f.context);
    assert.equal(owner.snapshot().profile.kind, "unrestricted");
    await owner.reload(f.config, undefined, f.context);
    assert.equal(decide(owner.snapshot(), bindPath(f.common), "write").action, "allow");
  } finally { f.close(); }
});

test("explicit read/write asks and denies override automatic metadata baseline", () => {
  const f = fixture();
  try {
    for (const access of ["read", "write"] as const) {
      for (const action of ["ask", "deny"] as const) {
        f.config.pathRules = [{ path: f.common, scope: "tree", [access]: action }];
        const snapshot = f.owner().snapshot();
        assert.equal(decide(snapshot, bindPath(path.join(f.git, "HEAD")), access).action, action);
        assert.ok(!compileFilesystem(snapshot).allowWrite.includes(f.common));
      }
    }
  } finally { f.close(); }
});

test("live reload cannot rediscover edited Gitfiles or rebind replaced metadata directories", async () => {
  const f = fixture(); const other = fixture();
  try {
    const owner = f.owner();
    writeFileSync(path.join(f.worktree, ".git"), `gitdir: ${other.git}\n`);
    writeFileSync(path.join(other.git, "gitdir"), `${path.join(f.worktree, ".git")}\n`);
    await owner.reload(f.config, undefined, f.context);
    assert.equal(decide(owner.snapshot(), bindPath(f.common), "write").action, "allow");
    assert.equal(decide(owner.snapshot(), bindPath(other.common), "write").action, "ask");
    assert.equal(f.owner().snapshot().profile.grants.find((g) => g.definition?.startsWith("worktree:"))?.binding.canonical, other.common);
    renameSync(f.common, `${f.common}-old`); mkdirSync(f.common);
    assert.equal(decide(owner.snapshot(), bindPath(f.common), "write").action, "ask");
    await assert.rejects(owner.reload(f.config, undefined, f.context), /identity changed/);
    rmSync(path.join(other.worktree, ".git"));
    const initiallyPlain = other.owner();
    writeFileSync(path.join(other.worktree, ".git"), `gitdir: ${other.git}\n`);
    writeFileSync(path.join(other.git, "gitdir"), `${path.join(other.worktree, ".git")}\n`);
    await initiallyPlain.reload(other.config, undefined, other.context);
    assert.equal(decide(initiallyPlain.snapshot(), bindPath(other.common), "write").action, "ask");
  } finally { f.close(); other.close(); }
});

test("automatic metadata is omitted from persisted authority and rediscovered on fresh restore", () => {
  const f = fixture();
  try {
    const binding = { id: randomUUID(), file: path.join(f.dir, "session.jsonl"), cwd: f.worktree };
    writeFileSync(binding.file, "session");
    const store = new PermissionStore(f.dir); store.load(binding, f.worktree, f.context, f.config);
    new PermissionOwner(f.catalog(), { store, ask: async () => undefined });
    assert.doesNotMatch(readFileSync(path.join(f.dir, "permissions", STATE_FILE), "utf8"), /worktreeGrants|worktree:/);
    const restored = new PermissionStore(f.dir).load(binding, f.worktree, f.context, f.config);
    assert.equal(restored.session?.catalog.profiles.project?.grants.find((g) => g.definition?.startsWith("worktree:"))?.binding.canonical, f.common);
    rmSync(path.join(f.worktree, ".git"));
    const withoutMarker = new PermissionStore(f.dir).load(binding, f.worktree, f.context, f.config);
    assert.ok(!withoutMarker.session?.catalog.profiles.project?.grants.some((g) => g.definition?.startsWith("worktree:")));
  } finally { f.close(); }
});

test("Pi's actual loader initializes automatic worktree access without UI or personal policy", async () => {
  initTheme("dark");
  const f = fixture(); const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(f.dir, "agent");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    mkdirSync(agentDir, { mode: 0o700 }); mkdirSync(path.join(agentDir, "permissions"), { mode: 0o700 });
    writeFileSync(path.join(agentDir, "permissions", "config.json"), JSON.stringify(f.config), { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: f.worktree, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: f.worktree, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(f.worktree), tools: ["read", "write"],
    }));
    await session.bindExtensions({});
    const read = session.agent.state.tools.find((tool) => tool.name === "read")!;
    const write = session.agent.state.tools.find((tool) => tool.name === "write")!;
    assert.match(JSON.stringify((await read.execute("metadata", { path: path.join(f.git, "HEAD") })).content), /refs\/heads\/main/);
    const file = path.join(f.common, "refs", "created");
    await write.execute("metadata-write", { path: file, content: "shared metadata" });
    assert.equal(readFileSync(file, "utf8"), "shared metadata");
    await assert.rejects(read.execute("main-file", { path: path.join(f.main, "private") }), /denied|UI/i);
  } finally {
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    f.close();
  }
});

test("native sandbox permits Git status, commit, and refs in a linked worktree without main-file access", { skip: process.platform !== "darwin" }, async () => {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-worktree-native-"))).canonical;
  const main = path.join(dir, "main"); const worktree = path.join(dir, "linked");
  const runtime = new RuntimeCoordinator(); const familyId = randomUUID();
  const git = (args: string[], cwd = dir) => execFileSync("/usr/bin/git", args, {
    cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, stdio: "pipe",
  });
  try {
    git(["-c", "init.defaultBranch=main", "init", main]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], main);
    git(["worktree", "add", "--detach", worktree], main);
    writeFileSync(path.join(main, "private"), "MAIN-CHECKOUT-SECRET");
    const config = defaultConfig(); config.pathRules = [];
    config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
    config.modes.subproject = config.modes.project!;
    const root = { family: familyId, binding: bindPath(worktree) };
    const owner = new PermissionOwner(resolveCatalog(config, root, { agentDir: dir, home: dir }), { ask: async () => assert.fail("Git must not prompt") });
    const family = { id: familyId, network: () => owner.network.snapshot(), decideHost: async () => false };
    let output = "";
    const result = await runtime.operations(owner.snapshot(), family, () => {}).exec(
      `export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null; /usr/bin/git status --porcelain && /usr/bin/git -c user.name=Test -c user.email=test@example.invalid -c commit.gpgsign=false commit --allow-empty -m linked && /usr/bin/git branch linked-created && { if cat '${main}/private'; then echo MAIN-FILE-LEAK; fi; echo DONE; }`,
      worktree, { onData: (data) => { output += data; } },
    );
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /DONE/); assert.doesNotMatch(output, /MAIN-CHECKOUT-SECRET|MAIN-FILE-LEAK/);
    assert.ok(existsSync(path.join(main, ".git", "refs", "heads", "linked-created")));
    assert.equal(git(["log", "-1", "--format=%s"], worktree).toString().trim(), "linked");
  } finally { await runtime.shutdown(familyId); rmSync(dir, { recursive: true, force: true }); }
});
