import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readOnlyOverride } from "./config-load.ts";
import type { GitLayout } from "./paths.ts";
import { addGitWriteAccess, createSandboxedBashOps } from "./sandbox.ts";

const layout: GitLayout = {
  kind: "gitfile",
  gitFile: "/worktree/.git",
  gitDir: "/repo/.git/worktrees/worktree",
  commonDir: "/repo/.git",
  writePaths: ["/repo/.git"],
};

test("addGitWriteAccess exposes resolved metadata and protects the gitfile", () => {
  const allowWrite = [".", "/tmp", "/repo/.git"];
  const denyWrite = [".env"];
  const config = { filesystem: { allowWrite, denyWrite, denyRead: ["~/.ssh"] } };
  const augmented = addGitWriteAccess(config, layout);

  assert.deepEqual(augmented.filesystem, {
    allowWrite: [".", "/tmp", "/repo/.git"],
    denyWrite: [".env", "/worktree/.git"],
    denyRead: ["~/.ssh"],
  });
  assert.deepEqual(allowWrite, [".", "/tmp", "/repo/.git"]);
  assert.deepEqual(denyWrite, [".env"]);
});

test("addGitWriteAccess retains disjoint git metadata paths", () => {
  const disjoint: GitLayout = {
    ...layout,
    commonDir: "/shared/git",
    writePaths: ["/shared/git", "/private/worktree-git"],
  };
  const augmented = addGitWriteAccess({ filesystem: { allowWrite: ["."] } }, disjoint);
  assert.deepEqual(augmented.filesystem?.allowWrite, [".", "/shared/git", "/private/worktree-git"]);
});

test("addGitWriteAccess leaves ordinary projects unchanged", () => {
  const config = { filesystem: { allowWrite: ["."] } };
  assert.equal(addGitWriteAccess(config, { kind: "directory" }), config);
  assert.equal(addGitWriteAccess(config, { kind: "none" }), config);
});

test("read-only override removes project and Git write access", () => {
  const augmented = addGitWriteAccess({ filesystem: { allowWrite: ["."] } }, layout);
  assert.deepEqual(readOnlyOverride(augmented).filesystem?.allowWrite, []);
});

test("sandboxed bash performs runtime cleanup after success and wrapping failure", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "perm-sandbox-cleanup-"));
  try {
    let cleanups = 0;
    const manager = {
      wrapWithSandbox: async () => "true",
      cleanupAfterCommand: () => cleanups++,
    } as unknown as Parameters<typeof createSandboxedBashOps>[0];
    const result = await createSandboxedBashOps(manager).exec("true", cwd, { onData: () => {}, timeout: 5 });
    assert.equal(result.exitCode, 0);
    assert.equal(cleanups, 1);

    const failingManager = {
      wrapWithSandbox: async () => {
        throw new Error("wrap failed");
      },
      cleanupAfterCommand: () => cleanups++,
    } as unknown as Parameters<typeof createSandboxedBashOps>[0];
    await assert.rejects(
      createSandboxedBashOps(failingManager).exec("true", cwd, { onData: () => {}, timeout: 5 }),
      /wrap failed/,
    );
    assert.equal(cleanups, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
