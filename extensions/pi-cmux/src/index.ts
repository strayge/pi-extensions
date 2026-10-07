// SPDX-License-Identifier: GPL-3.0-or-later

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cmuxPiSessionExtension from "./upstream/cmux-session.ts";

/** Keep stock hooks inert regardless of extension load order. */
export default function (pi: ExtensionAPI): void {
  if (process.env.PI_CMUX_DISABLED === "1" || !process.env.CMUX_SURFACE_ID?.trim()) return;

  // Suppression lasts for this Pi process, including reload and child sessions.
  // Re-enabling stock hooks during shutdown would race other extension handlers.
  process.env.CMUX_PI_HOOKS_DISABLED = "1";
  cmuxPiSessionExtension(pi);
}
