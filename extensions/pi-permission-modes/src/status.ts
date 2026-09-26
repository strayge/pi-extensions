import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PermissionOwner } from "./approvals.ts";
import { publishStatuslineItem } from "./statusline-slot.ts";

export function createStatus(pi: ExtensionAPI) {
  const filesystem = publishStatuslineItem(pi, { id: "perm", priority: 20 });
  const network = publishStatuslineItem(pi, { id: "perm-network", priority: 21 });
  return (ctx: ExtensionContext, owner?: PermissionOwner, error?: string) => {
    let mode = "Filesystem unavailable";
    let color: "error" | "accent" = "error";
    if (owner && !owner.reason && !error) {
      try {
        const snapshot = owner.snapshot();
        mode = `${snapshot.profile.kind === "unrestricted" ? "FS unrestricted" : "FS scoped · sandbox required"}${owner.enforcementError ? " · shell unavailable" : ""} · ${owner.config.modes[snapshot.mode]!.label.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\u001b", "")}`;
        color = snapshot.profile.kind === "unrestricted" || owner.enforcementError ? "error" : "accent";
      } catch { /* Replaced authority stays unavailable, including during status rendering. */ }
    }
    const net = owner?.network.snapshot().restricted === false ? "Network open" : "Network restricted";
    filesystem(truncateToWidth(mode, 80), color);
    network(net, owner?.network.snapshot().restricted === false ? "warning" : "muted");
    ctx.ui.setStatus("perm", `${ctx.ui.theme.fg(color, truncateToWidth(mode, 65))} · ${net}`);
  };
}
