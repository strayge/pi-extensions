import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskApproval } from "./approvals.ts";
import { editDirectoryScope } from "./directory-scope.ts";
import { bindPath } from "./paths.ts";
import type { NetAsk } from "./network.ts";

/** Only the root UI can approve authority; a headless child never silently grants it. */
export function approvalUI(context: () => ExtensionContext): AskApproval {
  return async (request, signal) => {
    const ctx = context();
    if (!ctx.hasUI) throw new Error(`Approval needs the parent UI: ${request.access} ${request.path}`);
    signal?.throwIfAborted();
    let directory = request.path;
    let binding = bindPath(directory);
    const requested = binding.canonical;
    for (;;) {
      const edited = request.kind === "directory" && directory !== request.path;
      const field = (label: string, value: string) => label.padEnd(edited ? 11 : 8) + value;
      const scope = request.kind === "file" || (request.kind === "exception" && request.scope === "file") ? "This file only" : "Directory and all descendants";
      const blocking = request.access === "read" ? "Blocking read access also blocks writes." : "Blocking write access does not block reads.\n      Reads still require permission.";
      const title = [
        `${request.kind === "exception" ? "Path-rule exception" : request.kind === "file" ? "File access" : "Directory access"} · ${request.access === "read" ? "Read-only" : "Read/write"}`,
        "",
        field("Path", directory),
        ...(edited ? [field("Requested", request.path)] : []),
        field("Scope", scope),
        "",
        "Reason",
        request.reason,
        "",
        request.kind === "exception" ? `Note: This requires separate approval under a path rule.\n      ${blocking}` : `Note: ${blocking}`,
        ...(request.kind === "directory" && binding.missing.length ? [
          "",
          "On approval",
          request.access === "write" ? "The displayed directory will be created.\nBlocking access does not create it." : "Read-only access does not create missing directories.",
        ] : []),
      ].join("\n");
      const choice = await ctx.ui.select(
        title,
        request.kind === "directory"
          ? ["Allow for this session", "Remember for this project", "Save globally", "Edit directory scope", "Deny and block for this session", "Deny"]
          : request.kind === "file"
            ? ["Allow for this session", "Remember for this project", "Save globally", "Deny and block for this session", "Deny"]
            : ["Allow for this session", "Remember for this project", "Deny and block for this session", "Deny"],
        { signal },
      );
      signal?.throwIfAborted();
      if (request.kind === "directory" && choice === "Edit directory scope") {
        const selected = await editDirectoryScope(ctx, requested, directory, request.access, signal);
        signal?.throwIfAborted();
        if (selected) {
          binding = selected;
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
