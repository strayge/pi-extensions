import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveGitLayout,
  isMarkdown,
  isOutside,
  isPlanFile,
  isProtectedPath,
  isProtectedWrite,
  removeSandboxPlaceholders,
  resolvePlanPath,
  SAFE_OUTSIDE_RE,
  SANDBOX_PLACEHOLDER_PATHS,
  sandboxMountPath,
} from "./paths.ts";

const ROOT = "/home/proj";

test("isOutside: empty/undefined is in-project (tools default to cwd)", () => {
  assert.equal(isOutside(ROOT, undefined), false);
  assert.equal(isOutside(ROOT, ""), false);
});

test("isOutside: in-project relative and nested paths", () => {
  assert.equal(isOutside(ROOT, "src/index.ts"), false);
  assert.equal(isOutside(ROOT, "./a/b/c"), false);
  assert.equal(isOutside(ROOT, "."), false);
});

test("isOutside: parent traversal escapes", () => {
  assert.equal(isOutside(ROOT, ".."), true);
  assert.equal(isOutside(ROOT, "../sibling"), true);
  assert.equal(isOutside(ROOT, "src/../../escape"), true);
});

test("isOutside: absolute paths classified by containment", () => {
  assert.equal(isOutside(ROOT, "/home/proj/src"), false);
  assert.equal(isOutside(ROOT, "/etc/passwd"), true);
  assert.equal(isOutside(ROOT, "/home/projector"), true); // prefix but not contained
});

test("isProtectedPath: segment-aware match of the expanded protected set", () => {
  assert.equal(isProtectedPath(".env"), true);
  assert.equal(isProtectedPath("config/.env"), true);
  assert.equal(isProtectedPath("deploy/.env.production"), true);
  assert.equal(isProtectedPath(".git/config"), true);
  assert.equal(isProtectedPath("node_modules/x"), true);
  assert.equal(isProtectedPath(".vscode/settings.json"), true);
  assert.equal(isProtectedPath("sub/.idea/workspace.xml"), true);
  assert.equal(isProtectedPath("home/.bashrc"), true);
});

test("isProtectedPath: does not flag look-alikes (no loose substring)", () => {
  assert.equal(isProtectedPath("src/app.ts"), false);
  assert.equal(isProtectedPath("src/.environment.ts"), false); // not .env / .env.*
  assert.equal(isProtectedPath("my.gitignore"), false);
  assert.equal(isProtectedPath("docs/environment.md"), false);
  assert.equal(isProtectedPath(".claude/commands/foo.md"), false);
  assert.equal(isProtectedPath(".claude/agents/bar.md"), false);
});

test("resolveGitLayout distinguishes ordinary project layouts", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-git-kind-"));
  try {
    const none = path.join(base, "none");
    mkdirSync(none);
    assert.deepEqual(resolveGitLayout(none), { kind: "none" });

    const repo = path.join(base, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    assert.deepEqual(resolveGitLayout(repo), { kind: "directory" });

    const stub = path.join(base, "stub");
    mkdirSync(stub);
    writeFileSync(path.join(stub, ".git"), "");
    assert.deepEqual(resolveGitLayout(stub), { kind: "placeholder" });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveGitLayout resolves a linked worktree to its common git directory", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "perm-git-wt-")));
  try {
    const commonDir = path.join(base, "main repo", ".git");
    const gitDir = path.join(commonDir, "worktrees", "feature");
    const worktree = path.join(base, "feature tree");
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(path.join(commonDir, "objects"));
    mkdirSync(worktree);
    writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(commonDir, "config"), "[core]\n\tbare = false\n");
    writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(path.join(gitDir, "commondir"), "../..\r\n");
    writeFileSync(path.join(gitDir, "gitdir"), `${path.join(worktree, ".git")}\n`);
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.relative(worktree, gitDir)}\r\n`);

    assert.deepEqual(resolveGitLayout(worktree), {
      kind: "gitfile",
      gitFile: path.join(worktree, ".git"),
      gitDir,
      commonDir,
      writePaths: [commonDir],
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveGitLayout supports linked worktrees from a bare common repository", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "perm-git-bare-")));
  try {
    const commonDir = path.join(base, "repository.git");
    const gitDir = path.join(commonDir, "worktrees", "feature");
    const worktree = path.join(base, "feature");
    mkdirSync(path.join(commonDir, "objects"), { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(worktree);
    writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(commonDir, "config"), "[core]\n\tbare = true\n");
    writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    writeFileSync(path.join(gitDir, "gitdir"), `${path.join(worktree, ".git")}\n`);
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    const layout = resolveGitLayout(worktree);
    assert.equal(layout.kind, "gitfile");
    if (layout.kind === "gitfile") assert.deepEqual(layout.writePaths, [commonDir]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveGitLayout supports submodules and rejects unrelated commondirs", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "perm-git-sub-")));
  try {
    const project = path.join(base, "submodule");
    const gitDir = path.join(base, "super", ".git", "modules", "submodule");
    mkdirSync(project, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(gitDir, "config"), `[core]\n\tworktree = ${path.relative(gitDir, project)}\n`);
    writeFileSync(path.join(project, ".git"), `gitdir: ${gitDir}\n`);
    const submodule = resolveGitLayout(project);
    assert.equal(submodule.kind, "gitfile");
    if (submodule.kind === "gitfile") {
      assert.equal(submodule.commonDir, gitDir);
      assert.deepEqual(submodule.writePaths, [gitDir]);
    }

    const linkedSubmodule = path.join(base, "linked-submodule");
    const linkedSubmoduleGitDir = path.join(base, "linked", ".git", "worktrees", "feature", "modules", "sub");
    mkdirSync(linkedSubmodule, { recursive: true });
    mkdirSync(linkedSubmoduleGitDir, { recursive: true });
    writeFileSync(path.join(linkedSubmoduleGitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      path.join(linkedSubmoduleGitDir, "config"),
      `[core]\n\tworktree = ${path.relative(linkedSubmoduleGitDir, linkedSubmodule)}\n`,
    );
    writeFileSync(path.join(linkedSubmodule, ".git"), `gitdir: ${linkedSubmoduleGitDir}\n`);
    assert.equal(resolveGitLayout(linkedSubmodule).kind, "gitfile");

    const commonDir = path.join(base, "shared", "metadata");
    mkdirSync(commonDir, { recursive: true });
    writeFileSync(path.join(gitDir, "commondir"), `${commonDir}\n`);
    writeFileSync(path.join(gitDir, "gitdir"), `${path.join(project, ".git")}\n`);
    const disjoint = resolveGitLayout(project);
    assert.equal(disjoint.kind, "invalid");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveGitLayout rejects malformed or unsafe gitfiles", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-git-bad-"));
  try {
    const project = path.join(base, "project");
    mkdirSync(project);
    writeFileSync(path.join(project, ".git"), "not a gitfile\n");
    assert.equal(resolveGitLayout(project).kind, "invalid");

    writeFileSync(path.join(project, ".git"), "gitdir: missing\n");
    assert.equal(resolveGitLayout(project).kind, "invalid");

    const gitDir = path.join(base, "metadata", "worktrees", "project");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(gitDir, "commondir"), "missing\n");
    writeFileSync(path.join(project, ".git"), `gitdir: ${gitDir}\n`);
    assert.equal(resolveGitLayout(project).kind, "invalid");

    rmSync(path.join(gitDir, "commondir"));
    const otherWorktree = path.join(base, "other-worktree");
    mkdirSync(otherWorktree);
    writeFileSync(path.join(gitDir, "config"), `[core]\n\tworktree = ${path.relative(gitDir, otherWorktree)}\n`);
    assert.equal(resolveGitLayout(project).kind, "invalid");

    const gitDirLink = path.join(base, "metadata-link");
    symlinkSync(gitDir, gitDirLink);
    writeFileSync(path.join(project, ".git"), `gitdir: ${gitDirLink}\n`);
    assert.equal(resolveGitLayout(project).kind, "invalid");

    rmSync(path.join(project, ".git"));
    symlinkSync(path.join(base, "elsewhere"), path.join(project, ".git"));
    assert.equal(resolveGitLayout(project).kind, "invalid");

    rmSync(path.join(project, ".git"));
    const hardlinkSource = path.join(base, "gitfile-copy");
    writeFileSync(hardlinkSource, `gitdir: ${gitDir}\n`);
    linkSync(hardlinkSource, path.join(project, ".git"));
    assert.equal(resolveGitLayout(project).kind, "invalid");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sandboxMountPath: canonicalizes symlinked mount points bwrap can't mount on", () => {
  const t = tmpdir();
  if (!existsSync(t)) mkdirSync(t, { recursive: true });
  const base = realpathSync(mkdtempSync(path.join(t, "perm-mnt-")));
  try {
    const home = path.join(base, "home");
    const store = path.join(base, "elsewhere", "secrets");
    mkdirSync(store, { recursive: true });
    mkdirSync(home, { recursive: true });
    // The reported WSL shape: ~/.aws is a symlink onto another filesystem.
    symlinkSync(store, path.join(home, ".aws"));
    assert.equal(sandboxMountPath("~/.aws", base, home), store);
    // Paths under the symlink resolve through it too.
    assert.equal(sandboxMountPath("~/.aws/credentials", base, home), path.join(store, "credentials"));

    // A plain directory is returned as-is; relative entries resolve against cwd.
    const proj = path.join(base, "proj");
    mkdirSync(proj, { recursive: true });
    assert.equal(sandboxMountPath(".", proj, home), proj);
    assert.equal(sandboxMountPath("~", base, home), home);

    // Missing paths keep their (absolute) form — the runtime skips or stubs them.
    assert.equal(sandboxMountPath("~/.gnupg", base, home), path.join(home, ".gnupg"));

    // Glob patterns: only the static directory prefix is canonicalized.
    assert.equal(sandboxMountPath("~/.aws/*.json", base, home), path.join(store, "*.json"));
    assert.equal(sandboxMountPath("/*/etc", base, home), "/*/etc"); // glob in the first segment

    // A link that escapes upward would mount over a far broader tree → dropped.
    symlinkSync(base, path.join(home, ".wide"));
    assert.equal(sandboxMountPath("~/.wide", base, home), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isPlanFile: markdown under the in-project docs/plans/ dir only", () => {
  const root = "/home/proj";
  assert.equal(isPlanFile(root, "docs/plans/2026-06-07_x.md"), true);
  assert.equal(isPlanFile(root, "docs/plans/sub/y.markdown"), true);
  assert.equal(isPlanFile(root, "./docs/plans/z.md"), true);
  assert.equal(isPlanFile(root, "docs/plans/notes.txt"), false); // not markdown
  assert.equal(isPlanFile(root, "plans/x.md"), false); // legacy root directory
  assert.equal(isPlanFile(root, "docs/planner/x.md"), false); // sibling directory
  assert.equal(isPlanFile(root, "../docs/plans/x.md"), false); // escapes project
  assert.equal(isPlanFile(root, undefined), false);
});

test("removeSandboxPlaceholders deletes 0-byte placeholders, leaves real files/dirs", () => {
  const t2 = tmpdir();
  if (!existsSync(t2)) mkdirSync(t2, { recursive: true });
  const base = mkdtempSync(path.join(t2, "perm-rm-"));
  try {
    const proj = path.join(base, "proj");
    mkdirSync(proj, { recursive: true });

    // 0-byte placeholders the sandbox plants (files for dotfiles AND dir-names).
    for (const name of [".bashrc", ".zshrc", ".gitconfig", ".mcp.json", ".git", ".vscode", ".idea"]) {
      writeFileSync(path.join(proj, name), "");
    }
    // Legitimate content that must NOT be touched:
    writeFileSync(path.join(proj, ".gitmodules"), "[submodule]\n"); // real non-empty file
    mkdirSync(path.join(proj, ".vscode-real"), { recursive: true });
    const realIdea = path.join(base, "realidea");
    mkdirSync(path.join(realIdea, ".idea"), { recursive: true }); // a real .idea DIR (separate proj)

    const removed = removeSandboxPlaceholders(proj);
    assert.equal(removed, 7); // all 7 zero-byte placeholders gone
    for (const name of [".bashrc", ".zshrc", ".gitconfig", ".mcp.json", ".git", ".vscode", ".idea"]) {
      assert.equal(existsSync(path.join(proj, name)), false, name);
    }
    assert.equal(existsSync(path.join(proj, ".gitmodules")), true); // real file kept
    assert.equal(removeSandboxPlaceholders(realIdea), 0); // a real .idea dir is left alone

    const linked = path.join(base, "linked");
    const zeroTarget = path.join(base, "zero-target");
    mkdirSync(linked);
    writeFileSync(zeroTarget, "");
    symlinkSync(zeroTarget, path.join(linked, ".git"));
    assert.equal(removeSandboxPlaceholders(linked), 0);
    assert.equal(existsSync(path.join(linked, ".git")), true);

    const hardlinked = path.join(base, "hardlinked");
    const hardlinkTarget = path.join(base, "hardlink-target");
    mkdirSync(hardlinked);
    writeFileSync(hardlinkTarget, "");
    linkSync(hardlinkTarget, path.join(hardlinked, ".git"));
    assert.equal(removeSandboxPlaceholders(hardlinked), 0);
    assert.equal(existsSync(path.join(hardlinked, ".git")), true);

    // No placeholders → 0.
    const none = path.join(base, "none");
    mkdirSync(none, { recursive: true });
    assert.equal(removeSandboxPlaceholders(none), 0);

    assert.ok(SANDBOX_PLACEHOLDER_PATHS.includes(".mcp.json"));
    assert.equal(SANDBOX_PLACEHOLDER_PATHS.some((entry) => entry.startsWith(".claude")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolvePlanPath trims and strips a leading @", () => {
  assert.equal(resolvePlanPath("docs/plans/x.md"), "docs/plans/x.md");
  assert.equal(resolvePlanPath("  docs/plans/x.md  "), "docs/plans/x.md");
  assert.equal(resolvePlanPath("@docs/plans/x.md"), "docs/plans/x.md");
  assert.equal(resolvePlanPath(" @docs/plans/x.md"), "docs/plans/x.md");
  assert.equal(resolvePlanPath(undefined), "");
  assert.equal(resolvePlanPath(null), "");
});

test("isMarkdown matches .md / .markdown case-insensitively", () => {
  for (const p of ["notes.md", "deep/dir/plan.markdown", "READ.MD", "X.Markdown"]) {
    assert.equal(isMarkdown(p), true, p);
  }
  for (const p of ["readme.txt", "notmd", "file.mdx", "md", "a.md.bak"]) {
    assert.equal(isMarkdown(p), false, p);
  }
});

test("SAFE_OUTSIDE_RE matches device pseudo-files only", () => {
  assert.ok(SAFE_OUTSIDE_RE.test("/dev/null"));
  assert.ok(!SAFE_OUTSIDE_RE.test("/dev/sda"));
});

test("isProtectedWrite: symlinks cannot smuggle a write past the backstop", () => {
  const t = tmpdir();
  if (!existsSync(t)) mkdirSync(t, { recursive: true });
  const base = mkdtempSync(path.join(t, "perm-prot-"));
  try {
    const root = path.join(base, "proj");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });

    // Lexical matches still hold, incl. not-yet-existing protected paths.
    assert.equal(isProtectedWrite(root, ".git/config"), true);
    assert.equal(isProtectedWrite(root, ".env.production"), true);
    assert.equal(isProtectedWrite(root, "src/app.ts"), false);

    // In-project symlink → .git: the canonical target is protected.
    symlinkSync(path.join(root, ".git"), path.join(root, "innocent"));
    assert.equal(isProtectedWrite(root, "innocent/config"), true);

    // Symlink → an outside dotfile: caught by basename after resolution.
    const outside = path.join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, ".bashrc"), "x");
    symlinkSync(path.join(outside, ".bashrc"), path.join(root, "notes.txt"));
    assert.equal(isProtectedWrite(root, "notes.txt"), true);

    // A benign in-project symlink stays writable.
    writeFileSync(path.join(root, "real.md"), "");
    symlinkSync(path.join(root, "real.md"), path.join(root, "alias.md"));
    assert.equal(isProtectedWrite(root, "alias.md"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isProtectedWrite: a project under a protected-named dir isn't blanket-blocked", () => {
  const t = tmpdir();
  if (!existsSync(t)) mkdirSync(t, { recursive: true });
  const base = mkdtempSync(path.join(t, "perm-nm-"));
  try {
    // Debugging a dependency in place: the project root's own absolute path
    // contains node_modules, but in-project writes are judged root-relative.
    const root = path.join(base, "node_modules", "some-dep");
    mkdirSync(path.join(root, "src"), { recursive: true });
    assert.equal(isProtectedWrite(root, "src/index.js"), false);
    // The project's OWN node_modules (a segment below root) stays protected.
    assert.equal(isProtectedWrite(root, "node_modules/x/y.js"), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isOutside: follows symlinks that escape the project", () => {
  const t3 = tmpdir();
  if (!existsSync(t3)) mkdirSync(t3, { recursive: true });
  const root = mkdtempSync(path.join(t3, "perm-root-"));
  try {
    // An in-project symlink pointing outside the project resolves to outside.
    const escape = path.join(root, "link-to-etc");
    symlinkSync("/etc", escape);
    assert.equal(isOutside(root, "link-to-etc/passwd"), true);

    // An in-project symlink pointing back inside stays inside.
    writeFileSync(path.join(root, "real.txt"), "hi");
    symlinkSync(path.join(root, "real.txt"), path.join(root, "inside-link"));
    assert.equal(isOutside(root, "inside-link"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
