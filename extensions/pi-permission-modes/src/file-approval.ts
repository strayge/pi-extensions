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
    let binding = bindPath(directory);
    for (;;) {
      const choice = await ctx.ui.select(
        `${request.kind === "exception" ? "Separate path-rule exception" : request.kind === "file" ? "Exact-file grant" : "Directory grant"}: ${request.access === "write" ? "R/W" : "R/O"} ${directory}\n${request.reason}\nScope: ${request.kind === "directory" ? "tree" : request.kind === "file" ? "file" : request.scope}. ${request.access === "read" ? "R/O denial also denies writes." : "R/W denial blocks writes only; reads still require ordinary permission."}${request.kind === "directory" && binding.missing.length ? "\nThe approved directory will be created. Blocking never creates a directory." : ""}`,
        request.kind === "directory"
          ? ["Allow for this session", "Remember for this project", "Save globally", "Edit directory scope", "Deny and block for this session", "Deny"]
          : request.kind === "file"
            ? ["Allow for this session", "Remember for this project", "Save globally", "Deny and block for this session", "Deny"]
            : ["Allow for this session", "Remember for this project", "Deny and block for this session", "Deny"],
        { signal },
      );
      signal?.throwIfAborted();
      if (request.kind === "directory" && choice === "Edit directory scope") {
        const entered = await ctx.ui.input("Directory scope", directory, { signal });
        signal?.throwIfAborted();
        if (entered) {
          binding = bindPath(modelPath(entered, ctx.cwd));
          directory = binding.canonical;
        }
        continue;
      }
      if (choice === "Deny and block for this session") return {
        action: "block",
        ...(request.kind === "directory" ? { directory, binding } : {}),
      };
      if (choice !== "Allow for this session" && choice !== "Remember for this project" && (choice !== "Save globally" || request.kind === "exception")) return undefined;
      return {
        action: "grant",
        lifetime: choice === "Save globally" ? "global" : choice === "Remember for this project" ? "project" : "session",
        ...(request.kind === "directory" ? { directory, binding } : {}),
      };
    }
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
