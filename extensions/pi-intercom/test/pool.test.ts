import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getIntercomScopeId, setIntercomScopeId } from "../src/config.ts";
import { initializeIntercomPool, readWmuxWorkspace } from "../src/pool.ts";

test("explicit pools, including the global pool, bypass automatic detection", async () => {
  for (const scope of ["my-pool", "", "  "]) {
    const env = {
      WMUX_SURFACE_ID: "surface",
      CMUX_SURFACE_ID: "cmux-surface",
      CMUX_WORKSPACE_ID: "",
      PI_INTERCOM_SCOPE_ID: scope,
    };
    await initializeIntercomPool("/project", env, async () => {
      throw new Error("must not query wmux");
    });
    assert.equal(env.PI_INTERCOM_SCOPE_ID, scope);
  }
});

test("workspace identity takes precedence over cwd and is inherited by children", async () => {
  const parent: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "parent", WMUX_PIPE: "pipe-a" };
  const peer: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "peer", WMUX_PIPE: "pipe-a" };
  const elsewhere: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "other", WMUX_PIPE: "pipe-a" };
  await initializeIntercomPool("/repo-a", parent, async () => "workspace-a");
  await initializeIntercomPool("/repo-b", peer, async () => "workspace-a");
  await initializeIntercomPool("/repo-a", elsewhere, async () => "workspace-b");
  assert.equal(parent.PI_INTERCOM_SCOPE_ID, peer.PI_INTERCOM_SCOPE_ID);
  assert.notEqual(parent.PI_INTERCOM_SCOPE_ID, elsewhere.PI_INTERCOM_SCOPE_ID);

  const child = { ...parent };
  await initializeIntercomPool("/child-worktree", child, async () => {
    throw new Error("the child must inherit its parent's pool");
  });
  assert.equal(child.PI_INTERCOM_SCOPE_ID, parent.PI_INTERCOM_SCOPE_ID);
});

test("wmux pool names are just the workspace id", async () => {
  const env: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "surface", WMUX_PIPE: "pipe-a" };
  const id = "ws-80334311-2d5d-4f5e-b70d-dc546868f114";
  await initializeIntercomPool("/repo", env, async () => id);
  assert.equal(env.PI_INTERCOM_SCOPE_ID, id);
});

test("cmux pools use workspace identity across directories and inherit it in children", async () => {
  const workspace = "80334311-2d5d-4f5e-b70d-dc546868f114";
  const parent: NodeJS.ProcessEnv = { CMUX_WORKSPACE_ID: workspace, CMUX_SURFACE_ID: "parent" };
  const peer: NodeJS.ProcessEnv = { CMUX_WORKSPACE_ID: workspace, CMUX_SURFACE_ID: "peer" };
  const elsewhere: NodeJS.ProcessEnv = { CMUX_WORKSPACE_ID: "other-workspace" };
  await initializeIntercomPool("/repo-a", parent);
  await initializeIntercomPool("/repo-b", peer);
  await initializeIntercomPool("/repo-a", elsewhere);
  assert.equal(parent.PI_INTERCOM_SCOPE_ID, workspace);
  assert.equal(peer.PI_INTERCOM_SCOPE_ID, workspace);
  assert.notEqual(elsewhere.PI_INTERCOM_SCOPE_ID, workspace);

  const child: NodeJS.ProcessEnv = { ...parent, CMUX_WORKSPACE_ID: "different-workspace" };
  await initializeIntercomPool("/child-worktree", child);
  assert.equal(child.PI_INTERCOM_SCOPE_ID, workspace);
});

test("cmux workspace identity takes precedence over inherited wmux metadata", async () => {
  const env: NodeJS.ProcessEnv = { CMUX_WORKSPACE_ID: " workspace-a ", WMUX_SURFACE_ID: "stale" };
  await initializeIntercomPool("/repo", env, async () => {
    throw new Error("must not query wmux inside cmux");
  });
  assert.equal(env.PI_INTERCOM_SCOPE_ID, "workspace-a");
});

test("incomplete cmux identity never silently joins a broader pool", async () => {
  for (const workspace of [undefined, "", "  "]) {
    const env: NodeJS.ProcessEnv = { CMUX_SURFACE_ID: "surface", CMUX_WORKSPACE_ID: workspace };
    await assert.rejects(
      initializeIntercomPool("/repo", env),
      /Cannot determine the cmux workspace/,
    );
    assert.equal(env.PI_INTERCOM_SCOPE_ID, undefined);
    env.CMUX_WORKSPACE_ID = "recovered";
    await initializeIntercomPool("/repo", env);
    assert.equal(env.PI_INTERCOM_SCOPE_ID, "recovered");
  }
});

test("outside wmux and cmux, canonical cwd selects the pool", async () => {
  const a: NodeJS.ProcessEnv = {};
  const b: NodeJS.ProcessEnv = {};
  const other: NodeJS.ProcessEnv = {};
  await initializeIntercomPool(process.cwd(), a);
  await initializeIntercomPool(resolve(process.cwd(), "test", ".."), b);
  await initializeIntercomPool(resolve(process.cwd(), "test"), other);
  assert.ok(a.PI_INTERCOM_SCOPE_ID);
  assert.match(a.PI_INTERCOM_SCOPE_ID, /^cwd:/);
  assert.equal(a.PI_INTERCOM_SCOPE_ID, b.PI_INTERCOM_SCOPE_ID);
  assert.notEqual(a.PI_INTERCOM_SCOPE_ID, other.PI_INTERCOM_SCOPE_ID);
});

test("wmux lookup failure never silently joins a broader pool", async () => {
  const env: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "surface" };
  await assert.rejects(
    initializeIntercomPool("/repo", env, async () => {
      throw new Error("wmux unavailable");
    }),
    /Cannot determine the wmux workspace/,
  );
  assert.equal(env.PI_INTERCOM_SCOPE_ID, undefined);
  await initializeIntercomPool("/repo", env, async () => "recovered");
  assert.equal(env.PI_INTERCOM_SCOPE_ID, "recovered");
});

test("a manual pool switch wins over an in-flight workspace lookup", async () => {
  const env: NodeJS.ProcessEnv = { WMUX_SURFACE_ID: "surface" };
  await initializeIntercomPool("/repo", env, async () => {
    env.PI_INTERCOM_SCOPE_ID = "";
    return "workspace";
  });
  assert.equal(env.PI_INTERCOM_SCOPE_ID, "");
});

test("the global opt-in survives reloads and is inherited by children", async (t) => {
  const previous = process.env.PI_INTERCOM_SCOPE_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_INTERCOM_SCOPE_ID;
    else process.env.PI_INTERCOM_SCOPE_ID = previous;
  });
  setIntercomScopeId(undefined);
  assert.equal(getIntercomScopeId(), undefined);
  assert.equal(process.env.PI_INTERCOM_SCOPE_ID, "");
  const child = { ...process.env };
  await initializeIntercomPool("/repo", child, async () => {
    throw new Error("global opt-in must bypass wmux");
  });
  assert.equal(getIntercomScopeId(child), undefined);
  assert.equal(child.PI_INTERCOM_SCOPE_ID, "");
});

test("wmux lookup addresses the launching surface and validates its response", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "intercom wmux "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = join(directory, "wmux.cjs");
  writeFileSync(
    cli,
    `if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["current-workspace", "--surface", "surface-a"])) process.exit(2);
console.log(process.env.TEST_WORKSPACE_RESPONSE);
`,
  );
  const env = {
    ...process.env,
    WMUX_CLI: cli,
    WMUX_NODE: process.execPath,
    WMUX_SURFACE_ID: "surface-a",
    TEST_WORKSPACE_RESPONSE: '{"id":"workspace-a"}',
  };
  assert.equal(await readWmuxWorkspace(env), "workspace-a");
  for (const response of ["not json", "null", "{}", '{"id":""}', '{"id":42}']) {
    await assert.rejects(readWmuxWorkspace({ ...env, TEST_WORKSPACE_RESPONSE: response }));
  }
});
