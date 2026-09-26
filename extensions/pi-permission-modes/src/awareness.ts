import type { PermissionOwner } from "./approvals.ts";

export function permissionAwareness(owner: PermissionOwner): string {
  if (owner.reason)
    return `Filesystem policy is unavailable: ${owner.reason}. Governed operations fail closed until a valid /reload or explicit /perm reset.`;
  const snapshot = owner.snapshot();
  const network = owner.network.snapshot();
  const grants = [
    ...snapshot.profile.grants.map(
      (g) => `${g.access === "write" ? "R/W" : "R/O"} ${g.binding.canonical} (${g.scope})`,
    ),
    ...snapshot.grants.map(
      (g) => `${g.access === "write" ? "R/W" : "R/O"} ${g.binding.canonical} (${g.lifetime}, id ${g.id})`,
    ),
  ];
  return [
    `Filesystem profile: ${snapshot.mode}; ${snapshot.profile.kind}. Frozen starting directory: ${owner.root}.`,
    snapshot.profile.kind === "unrestricted"
      ? "Filesystem limits and path rules are bypassed; network policy is independent."
      : `Resolved directory and automatic resource access:\n${grants.join("\n")}`,
    `Path rules:\n${snapshot.rules.map((r) => `${r.binding.canonical} (${r.scope}): read=${r.read ?? "ordinary"}, write=${r.write ?? "ordinary"}`).join("\n") || "none"}`,
    "Directory grants do not bypass path rules. Use request_directory_access or request_path_exception proactively. Session grants are the default; project grants require explicit user approval.",
    "Direct file tools use host-side checks, not an OS sandbox. Recursive grep/find omit unauthorized entries and discovered symlinks; unavailable ignore context causes explicit omissions or search unavailability.",
    "Governed shells require an OS sandbox unless filesystem access and networking are both unrestricted. Dynamic scripts remain sandboxed. A restricted descendant may prevent renaming/removing its ancestors while ordinary sibling contents remain writable. Commands are never automatically retried after a permission failure.",
    `Network: ${network.restricted ? "restricted" : "open"}; allowed=${network.allowedDomains.join(", ")}; denied=${network.deniedDomains.join(", ")}. Proxied processes use live policy for new connections. Established connections and already-launched open-network processes keep their access until exit.`,
    "Children share this root's live authority; a different cwd is not a grant. Trusted custom tools/extensions, including their own processes and network clients, are outside these checks.",
  ].join("\n");
}
