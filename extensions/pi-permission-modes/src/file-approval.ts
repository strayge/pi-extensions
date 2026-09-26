import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskApproval } from "./approvals.ts";
import { bindPath, modelPath } from "./paths.ts";
import type { NetAsk } from "./network.ts";

/** Only the root UI can approve authority; a headless child never silently grants it. */
export function approvalUI(context: () => ExtensionContext): AskApproval {
  return async (request, signal) => {
    const ctx = context();
    if (!ctx.hasUI) throw new Error(`Approval needs the parent UI: ${request.access} ${request.path}`);
    signal?.throwIfAborted();
    let directory = request.path;
    if (request.kind === "directory") {
      const action = await ctx.ui.select(
        `${request.access === "write" ? "R/W" : "R/O"} directory access: ${request.path}\n${request.reason}${request.create ? "\nThe approved directory will be created." : ""}`,
        ["Use this directory", "Edit directory scope", "Deny"],
        { signal },
      );
      signal?.throwIfAborted();
      if (action === "Edit directory scope") {
        const entered = await ctx.ui.input("Directory scope", request.path, { signal });
        if (!entered) return undefined;
        directory = bindPath(modelPath(entered, ctx.cwd)).canonical;
      } else if (action !== "Use this directory") return undefined;
    }
    const binding = bindPath(directory);
    const choice = await ctx.ui.select(
      `${request.kind === "exception" ? "Separate path-rule exception" : "Directory grant"}: ${request.access} ${directory}\n${request.reason}`,
      ["Allow for this session", "Remember for this project", "Deny"],
      { signal },
    );
    signal?.throwIfAborted();
    if (choice !== "Allow for this session" && choice !== "Remember for this project") return undefined;
    return {
      lifetime: choice === "Remember for this project" ? "project" : "session",
      ...(request.kind === "directory" ? { directory, binding } : {}),
    };
  };
}

export function networkUI(context: () => ExtensionContext, signal?: () => AbortSignal | undefined): NetAsk {
  return async (host, port) => {
    const ctx = context();
    if (!ctx.hasUI) return "dismiss";
    const choice = await ctx.ui.select(
      `Network access: ${host}${port ? `:${port}` : ""}`,
      ["Allow for this session", "Deny"],
      { signal: signal?.() },
    );
    return choice === "Allow for this session" ? "allow-session" : choice === "Deny" ? "deny" : "dismiss";
  };
}
