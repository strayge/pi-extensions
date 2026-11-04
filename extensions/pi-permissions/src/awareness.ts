import { positiveTarget } from "./evaluation.ts";
import type { PermissionOwner } from "./approvals.ts";
import { runtime } from "./sandbox.ts";
import { WINDOWS_EXECUTOR_RELEASE } from "./windows-executor.ts";
import { WINDOWS_CASE_AUTHORITY, WINDOWS_FILESYSTEM_LIMITATION, WINDOWS_GIT_BASH_NOTICE } from "./windows-runtime.ts";

export function permissionAwareness(owner: PermissionOwner, inspect = false): string {
  if (owner.reason)
    return `Filesystem policy is unavailable: ${owner.reason}. Governed operations fail closed until a valid /reload or explicit /perm reset.`;
  const snapshot = owner.snapshot();
  const network = owner.network.snapshot();
  const blocks = owner.sessionBlocks;
  const blockIds = new Set(blocks.map((b) => b.id));
  const grants = [
    ...snapshot.profile.grants.map(
      (g) => `${g.access === "write" ? "R/W" : "R/O"} ${g.binding.canonical} (${g.scope})`,
    ),
    ...snapshot.grants.map(
      (g) => `${g.access === "write" ? "R/W" : "R/O"} ${g.binding.canonical} (${"parent" in g.binding ? "file" : "tree"}, ${g.lifetime}, id ${g.id})`,
    ),
  ];
  const windows: string[] = [];
  if (process.platform === "win32") {
    windows.push(WINDOWS_CASE_AUTHORITY, WINDOWS_FILESYSTEM_LIMITATION, WINDOWS_GIT_BASH_NOTICE);
    const native = runtime.windowsRuntime(owner.id);
    if (native) {
      let readiness = "unhealthy; /reload required";
      if (native.prepared.client.healthy) {
        try { native.prepared.assertIdentity(); readiness = "prepared; live identity verified"; }
        catch (error) { readiness = `unhealthy: ${String(error)}; /reload required`; }
      }
      const version = native.prepared.environment.executorVersion;
      windows.push(`Native executor: ${native.prepared.candidate.source}${native.prepared.candidate.source === "managed" ? ` release ${WINDOWS_EXECUTOR_RELEASE.version}` : ""}; reported version ${typeof version === "string" ? version.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\u001b", " ").slice(0, 128) : "unknown"}; ${readiness}. ${native.prepared.candidate.executable}`);
      const resources = [...new Map([...native.bootstrapResources.values()].flat().map((resource) => [`${resource.scope}:${resource.binding.canonical}`, resource])).values()];
      windows.push(`Cached Windows bootstrap read resources: ${resources.length}.${inspect ? `\n${resources.map((resource) => `R/O ${resource.binding.canonical} (${resource.scope}; execution facility)`).join("\n") || "none discovered yet"}` : " Use /perm inspect for exact facilities."}`);
    } else windows.push("Native executor: not prepared. Fully open direct shells need none; contained grep needs root preparation.");
    if (owner.enforcementError) windows.push(`Execution diagnostics: ${owner.enforcementError}. No unrestricted retry is permitted.`);
    windows.push("Windows managed-network exception: direct host-loopback connections are permitted. A local proxy/service can bypass domain restrictions; this is not non-bypassable domain isolation.");
  }
  const confined = snapshot.profile.kind !== "unrestricted" || network.restricted;
  return [
    `Filesystem profile: ${snapshot.mode}; ${snapshot.profile.kind}. Frozen starting directory: ${owner.root}.`,
    snapshot.profile.kind === "unrestricted"
      ? "Filesystem limits and path rules are bypassed; network policy is independent."
      : `Resolved path and automatic resource access:\n${grants.join("\n")}`,
    `Path rules:\n${snapshot.rules.filter((r) => !blockIds.has(r.id)).map((r) => `${r.binding?.canonical ?? r.path} (${r.scope}): read=${r.read ?? "ordinary"}, write=${r.write ?? "ordinary"}${r.read === "allow" || r.write === "allow" ? `; global id global:${r.id}; ${positiveTarget(r.binding, r.scope).state}${r.blocked ? `: ${r.blocked}` : ""}` : ""}`).join("\n") || "none"}`,
    `Session blocks:\n${blocks.map((b) => `${b.id}: ${b.binding!.canonical} (${b.scope}), ${b.read === "deny" ? "R/O denial (also denies writes)" : "R/W denial (writes only; reads need ordinary permission)"}`).join("\n") || "none"}`,
    "Session blocks are shared with children, survive /reload and profile/global changes, and disappear on session close/restart/reopen. /perm revoke <block-id> removes one; /perm clear removes all. Running processes retain their original filesystem snapshot.",
    `Ask receipts:\n${snapshot.exceptions.map((e) => `${e.id}: ${e.access} ${snapshot.rules.find((r) => r.id === e.ruleId)?.path ?? e.ruleId} (${e.lifetime})`).join("\n") || "none"}`,
    "The most-specific custom allow/ask/deny wins; equal-specificity deny or pending ask still blocks. Session, project, and global allows have the same scope semantics. Use request_directory_access or request_path_exception proactively. Session grants are the default. Global grants are allow declarations in the user policy, require root UI confirmation and affect all scoped profiles/projects. /perm inspect shows current global:rule IDs; revoke removes every allow field of that declaration. /perm clear clears ordinary approvals and session blocks; /perm clear global removes configured allow fields only and leaves session blocks alone.",
    "Direct file tools use host-side checks, not an OS sandbox. Recursive grep/find omit unauthorized entries and discovered symlinks; unavailable ignore context causes explicit omissions or search unavailability.",
    process.platform === "win32"
      ? `Process mode: ${snapshot.processMode ?? "compatible"}. ${confined ? "MXC retires descendants when the foreground command exits in both modes; detached services are not preserved." : "Fully open direct execution uses compatible, best-effort descendant cleanup."}`
      : `Process mode: ${snapshot.processMode ?? "compatible"}. ${snapshot.processMode === "strict" ? "Confined subprocesses are retired with their command." : "Detached subprocesses remain sandboxed but cleanup is best-effort; they may outlive commands and retain their original filesystem snapshot."}`,
    process.platform === "win32"
      ? "Governed Windows shells require MXC unless filesystem access and networking are both unrestricted. Dynamic scripts inherit its path-based limitations. Commands are never automatically retried outside containment."
      : "Governed shells require an OS sandbox unless filesystem access and networking are both unrestricted. Dynamic scripts remain sandboxed. A restricted descendant may prevent renaming/removing its ancestors while ordinary sibling contents remain writable. Commands are never automatically retried after a permission failure.",
    ...windows,
    `Network: ${network.restricted ? "restricted" : "open"}; allowed=${network.allowedDomains.join(", ")}; denied=${network.deniedDomains.join(", ")}. Proxied processes use live policy for new connections. Established connections and already-launched open-network processes keep their access until exit.`,
    "Validated starting-worktree Git metadata receives automatic R/W access, subject to explicit path rules; its live boundary is not retargeted by Gitfile edits or reload. Children share this root's live authority; a different cwd is not a grant. Trusted custom tools/extensions, including their own processes and network clients, are outside these checks.",
  ].join("\n");
}
