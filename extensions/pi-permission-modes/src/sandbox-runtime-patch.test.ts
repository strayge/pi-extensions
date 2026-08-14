import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { wrapCommandWithSandboxLinux } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { macGetMandatoryDenyPatterns } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { getDangerousDirectories } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

test("patched sandbox runtime omits Claude-specific write protection", () => {
  const protectedDirectories = getDangerousDirectories();
  assert.equal(protectedDirectories.includes(".claude/commands"), false);
  assert.equal(protectedDirectories.includes(".claude/agents"), false);
  assert.ok(protectedDirectories.includes(".vscode"));
  assert.ok(protectedDirectories.includes(".idea"));
});

function inDirectory<T>(root: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

async function wrappedCommand(root: string, denyWithinAllow: string[] = []): Promise<string> {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return await wrapCommandWithSandboxLinux({
      command: "true",
      needsNetworkRestriction: false,
      readConfig: { denyOnly: [] },
      writeConfig: { allowOnly: [root], denyWithinAllow },
      allowAllUnixSockets: true,
      binShell: "bash",
    });
  } finally {
    process.chdir(previous);
  }
}

test("sandbox runtime skips impossible gitfile child protections only", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-runtime-git-"));
  try {
    const normal = path.join(base, "normal");
    mkdirSync(path.join(normal, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(normal, ".git", "config"), "[core]\n");
    const normalCommand = await wrappedCommand(normal);
    assert.ok(normalCommand.includes(`${normal}/.git/hooks`));
    assert.ok(normalCommand.includes(`${normal}/.git/config`));
    const normalMacPatterns = inDirectory(normal, () => macGetMandatoryDenyPatterns());
    assert.ok(normalMacPatterns.includes("**/.git/hooks/**"));
    assert.ok(normalMacPatterns.includes("**/.git/config"));

    const worktree = path.join(base, "worktree");
    mkdirSync(worktree);
    const gitFile = path.join(worktree, ".git");
    writeFileSync(gitFile, `gitdir: ${base}/metadata\n`);
    const worktreeCommand = await wrappedCommand(worktree, [gitFile]);
    assert.equal(worktreeCommand.includes(`${gitFile}/hooks`), false);
    assert.equal(worktreeCommand.includes(`${gitFile}/config`), false);
    assert.ok(worktreeCommand.includes(`--ro-bind ${gitFile} ${gitFile}`));
    assert.ok(worktreeCommand.includes(`${worktree}/.gitconfig`));
    const worktreeMacPatterns = inDirectory(worktree, () => macGetMandatoryDenyPatterns());
    assert.equal(worktreeMacPatterns.includes("**/.git/hooks/**"), false);
    assert.equal(worktreeMacPatterns.includes("**/.git/config"), false);
    assert.equal(worktreeMacPatterns.includes(`${gitFile}/hooks`), false);
    assert.equal(worktreeMacPatterns.includes(`${gitFile}/config`), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
