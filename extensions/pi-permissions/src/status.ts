import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PermissionOwner } from "./approvals.ts";
import { positiveTarget } from "./evaluation.ts";
import { publishStatuslineItem } from "./statusline-slot.ts";

export function createStatus(pi: ExtensionAPI) {
  const filesystem = publishStatuslineItem(pi, { id: "perm", priority: 20 });
  const network = publishStatuslineItem(pi, { id: "perm-network", priority: 21 });
  return (ctx: ExtensionContext, owner?: PermissionOwner, error?: string) => {
    let label = error ? "Unrestricted (policy failed)" : "Filesystem unavailable";
    let color: "error" | "accent" = "error";
    if (owner && !owner.reason && !error) {
      try {
        const snapshot = owner.snapshot();
        label = owner.config.modes[snapshot.mode]!.label.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\u001b", "");
        const blocked = snapshot.rules.filter((r) => (r.read === "allow" || r.write === "allow") && positiveTarget(r.binding, r.scope).state === "blocked").length;
        if (blocked) label += ` · ${blocked} blocked allow(s)`;
        color = snapshot.profile.kind === "unrestricted" || owner.enforcementError || blocked ? "error" : "accent";
      } catch { /* Replaced authority stays unavailable, including during status rendering. */ }
    }
    const net = !error && owner?.network.snapshot().restricted === true ? "Network restricted" : undefined;
    filesystem(truncateToWidth(label, 80), color);
    network(net, "muted");
    ctx.ui.setStatus("perm", `${ctx.ui.theme.fg(color, truncateToWidth(label, 65))}${net ? ` · ${net}` : ""}`);
  };
}
