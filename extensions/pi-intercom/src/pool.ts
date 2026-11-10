import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeCwd } from "./cwd.ts";

const execFileAsync = promisify(execFile);

export async function readWmuxWorkspace(env: NodeJS.ProcessEnv): Promise<string> {
  const surfaceId = env.WMUX_SURFACE_ID;
  if (!surfaceId) throw new Error("wmux surface id is missing");
  const args = ["current-workspace", "--surface", surfaceId];
  const options = { env, timeout: 3_000, maxBuffer: 64 * 1024, windowsHide: true };
  const { stdout } = env.WMUX_CLI
    ? await execFileAsync(env.WMUX_NODE || process.execPath, [env.WMUX_CLI, ...args], options)
    : await execFileAsync("wmux", args, options);
  const workspace: unknown = JSON.parse(stdout);
  if (
    typeof workspace !== "object" ||
    workspace === null ||
    !("id" in workspace) ||
    typeof workspace.id !== "string" ||
    !workspace.id.trim()
  ) {
    throw new Error("wmux returned no workspace id");
  }
  return workspace.id.trim();
}

/** Inherit the parent's pool, including an explicit empty (global) scope. */
export async function initializeIntercomPool(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  workspaceId: (env: NodeJS.ProcessEnv) => Promise<string> = readWmuxWorkspace,
): Promise<void> {
  if (env.PI_INTERCOM_SCOPE_ID !== undefined) return;

  let scope: string;
  if (env.CMUX_WORKSPACE_ID !== undefined || env.CMUX_SURFACE_ID) {
    const workspace = env.CMUX_WORKSPACE_ID?.trim();
    if (!workspace) {
      // Never join a broader pool when cmux identity is incomplete.
      throw new Error(
        "Cannot determine the cmux workspace for intercom; retry or select an explicit /intercom-pool.",
      );
    }
    scope = workspace;
  } else if (env.WMUX_SURFACE_ID) {
    try {
      scope = await workspaceId(env);
    } catch (error) {
      // Never broaden a workspace pool to a shared cwd or the global pool on lookup failure.
      throw new Error(
        "Cannot determine the wmux workspace for intercom; retry or select an explicit /intercom-pool.",
        { cause: error },
      );
    }
  } else {
    const directory = normalizeCwd(cwd);
    scope = `cwd:${process.platform === "win32" ? directory.toLowerCase() : directory}`;
  }

  // A manual switch made during the workspace lookup takes precedence.
  env.PI_INTERCOM_SCOPE_ID ??= scope;
}
