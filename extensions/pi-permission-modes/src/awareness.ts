import { positiveTarget } from "./evaluation.ts";
import type { PermissionOwner } from "./approvals.ts";

export function permissionAwareness(owner: PermissionOwner): string {
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
    `Process mode: ${snapshot.processMode ?? "compatible"}. ${snapshot.processMode === "strict" ? "Confined subprocesses are retired with their command." : "Detached subprocesses remain sandboxed but cleanup is best-effort; they may outlive commands and retain their original filesystem snapshot."}`,
    "Governed shells require an OS sandbox unless filesystem access and networking are both unrestricted. Dynamic scripts remain sandboxed. A restricted descendant may prevent renaming/removing its ancestors while ordinary sibling contents remain writable. Commands are never automatically retried after a permission failure.",
    `Network: ${network.restricted ? "restricted" : "open"}; allowed=${network.allowedDomains.join(", ")}; denied=${network.deniedDomains.join(", ")}. Proxied processes use live policy for new connections. Established connections and already-launched open-network processes keep their access until exit.`,
    "Validated starting-worktree Git metadata receives automatic R/W access, subject to explicit path rules; its live boundary is not retargeted by Gitfile edits or reload. Children share this root's live authority; a different cwd is not a grant. Trusted custom tools/extensions, including their own processes and network clients, are outside these checks.",
  ].join("\n");
}
