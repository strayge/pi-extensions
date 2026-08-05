/**
 * Audible nudge when pi needs your attention.
 *
 * Fires a chime + terminal bell once a turn settles, but only while the
 * terminal is NOT focused — a chime for a turn you are already watching is
 * noise. Focus is tracked via xterm focus reporting, so this needs a terminal
 * that supports it (Kitty, Ghostty, iTerm2, WezTerm, Windows Terminal, foot,
 * Alacritty, ...).
 *
 * Every handler is gated on the session owning the terminal. Extensions load
 * into nested agent sessions too (subagent runners bind all discovered
 * extensions), and those sessions emit their own session_start/agent_settled —
 * ungated, a finishing subagent would chime as if the user's turn had ended.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type FocusState = "unknown" | "focused" | "blurred";

let focus: FocusState = "unknown";
let unsubTerminalInput: (() => void) | undefined;

function safeSpawn(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/**
 * A "bip-bop": two short rising sine sweeps, the second starting a whole tone
 * below the first. The notes are exponential chirps rising ~1.5 octaves in
 * ~50ms rather than steady tones — that sweep is what makes them read as
 * plucky "bips" instead of flat beeps.
 *
 * Each sox chain (separated by ":") is one note: sweep, envelope, level. The
 * trailing `pad` on the second chain is the 190ms of silence between them.
 */
function playSound(): void {
  // biome-ignore format: one sox chain per line; flattening this is unreadable
  safeSpawn("play", [
    "-qn",
    "synth", "0.05", "sine", "625/1877", "fade", "t", "0.004", "0.05", "0.034", "vol", "0.32",
    ":",
    "synth", "0.05", "sine", "556/1509", "fade", "t", "0.005", "0.05", "0.030", "vol", "0.29",
    "pad", "0.19", "0",
  ]);
  // Bell keeps the extension useful when sox is missing.
  process.stdout.write("\x07");
}

function notify(): void {
  if (focus !== "blurred") return;
  playSound();
}

/**
 * True only for the session driving the terminal. Nested sessions (subagents)
 * bind no UI context and stay in "print" mode, so this also keeps the focus
 * escape sequences and the terminal-input subscription out of their hands.
 */
function ownsTerminal(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "tui";
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ownsTerminal(ctx)) return;
    process.stdout.write("\x1b[?1004h");

    unsubTerminalInput = ctx.ui.onTerminalInput((data) => {
      if (data === "\x1b[I") {
        focus = "focused";
        return { consume: true };
      }
      if (data === "\x1b[O") {
        focus = "blurred";
        return { consume: true };
      }
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ownsTerminal(ctx)) return;
    unsubTerminalInput?.();
    unsubTerminalInput = undefined;
    process.stdout.write("\x1b[?1004l");
    focus = "unknown";
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ownsTerminal(ctx)) return;
    if (ctx.isIdle()) notify();
  });

  pi.registerCommand("attention", {
    description: "Show attention state or test notifications",
    handler: async (args, ctx) => {
      if (args === "test") {
        playSound();
        ctx.ui.notify("Test: fired chime + bell", "info");
        return;
      }
      ctx.ui.notify(`Focus: ${focus}`, "info");
    },
  });
}
