/**
 * Footer status indicator rendering for the current permission mode.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDef } from "./schema.ts";
import type { SandboxController } from "./sandbox.ts";

/**
 * Render the `perm` status chip:
 *
 *   Build                 filtering — the mode's normal state
 *   Build  Network: open  allowlist lifted for the session
 *   YOLO                  never sandboxes
 *
 * The chip reports only a network state the mode did not ask for, so a quiet
 * footer means everything is as configured. Keys live in `/perm` and `/net`
 * rather than on every line of every session.
 *
 * The two silences differ, which is what the `mode.sandbox.enabled` branch
 * below buys: YOLO is silent because an open network is its design, while a
 * mode whose sandbox *failed* still reports `Network: open` beside its `(!)`,
 * because there the missing filtering is unintended.
 */
export function updateStatus(ctx: ExtensionContext, mode: ModeDef, sandbox: SandboxController, networkOpen: boolean): void {
  const t = ctx.ui.theme;
  const enforcing = mode.sandbox.enabled && sandbox.ready;
  let status = t.fg(mode.color, mode.label);
  if (mode.sandbox.enabled && sandbox.warn && !sandbox.disabled) status += " " + t.fg("error", `(!) ${sandbox.warn}`);
  if (enforcing) {
    if (networkOpen) status += "  " + t.fg("success", "Network: open");
  } else if (mode.sandbox.enabled) {
    status += "  " + t.fg("dim", "Network: open");
  }
  ctx.ui.setStatus("perm", status);
}
