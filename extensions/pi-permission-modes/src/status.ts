/**
 * Footer status indicator rendering for the current permission mode.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeColor, ModeDef } from "./schema.ts";
import type { SandboxController } from "./sandbox.ts";
import { type SlotColor, SLOT_COLORS } from "./statusline-slot.ts";

const PALETTE = new Set<string>(SLOT_COLORS);

/**
 * Every stock mode color is in the statusline's palette, so colors pass through
 * unchanged. The guard is for custom modes: `color` is only checked for
 * presence when config loads, not against the union it is typed as, and a name
 * the statusline does not know throws while the footer paints.
 */
const slotColor = (color: ModeColor): SlotColor => (PALETTE.has(color) ? (color as SlotColor) : "text");

export interface StatusParts {
  label: string;
  labelColor: ModeColor;
  /** Sandbox failure worth surfacing, already prefixed with `(!)`. */
  warning?: string;
  /** Absent when the network is in the state the mode asked for. */
  network?: { text: string; color: "success" | "dim" };
}

/**
 * The pieces of the status, before any theming.
 *
 *   Build                 filtering — the mode's normal state
 *   Build  Network: open  allowlist lifted for the session
 *   YOLO                  never sandboxes
 *
 * The network chip reports only a state the mode did not ask for, so a quiet
 * footer means everything is as configured. Keys live in `/perm` and `/net`
 * rather than on every line of every session.
 *
 * The two silences differ, which is what the `mode.sandbox.enabled` branch
 * buys: YOLO is silent because an open network is its design, while a mode
 * whose sandbox *failed* still reports `Network: open` beside its `(!)`,
 * because there the missing filtering is unintended.
 */
export function statusParts(mode: ModeDef, sandbox: SandboxController, networkOpen: boolean): StatusParts {
  const enforcing = mode.sandbox.enabled && sandbox.ready;
  const parts: StatusParts = { label: mode.label, labelColor: mode.color };
  if (mode.sandbox.enabled && sandbox.warn && !sandbox.disabled) parts.warning = `(!) ${sandbox.warn}`;
  if (enforcing) {
    if (networkOpen) parts.network = { text: "Network: open", color: "success" };
  } else if (mode.sandbox.enabled) {
    parts.network = { text: "Network: open", color: "dim" };
  }
  return parts;
}

/** A slot is one string, so a sandbox warning rides along with the mode label. */
export function statusSlots(parts: StatusParts): {
  mode: { text: string; color: SlotColor };
  network?: { text: string; color: SlotColor };
} {
  const label = parts.warning ? `${parts.label} ${parts.warning}` : parts.label;
  return {
    mode: { text: label, color: parts.warning ? "error" : slotColor(parts.labelColor) },
    network: parts.network,
  };
}

/** The combined chip, kept alongside the slots because a stock pi footer only reads this. */
export function updateStatus(
  ctx: ExtensionContext,
  mode: ModeDef,
  sandbox: SandboxController,
  networkOpen: boolean,
): StatusParts {
  const t = ctx.ui.theme;
  const parts = statusParts(mode, sandbox, networkOpen);
  let status = t.fg(parts.labelColor, parts.label);
  if (parts.warning) status += " " + t.fg("error", parts.warning);
  if (parts.network) status += "  " + t.fg(parts.network.color, parts.network.text);
  ctx.ui.setStatus("perm", status);
  return parts;
}
