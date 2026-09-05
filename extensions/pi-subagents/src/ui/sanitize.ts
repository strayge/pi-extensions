/**
 * sanitize.ts — keep transcript data from being interpreted as terminal instructions.
 *
 * Tool output rendered in the conversation viewer reaches the user's terminal
 * byte-for-byte through `wrapTextWithAnsi`/`Markdown`, which preserve ANSI.
 * Anything a tool emitted — a hostile MCP response, an accidental `cat` of a
 * binary — can therefore repaint the terminal: `\x1b[2J` clears the screen,
 * `\x1b[?25l` hides the cursor, `\x1b]0;…` retitles the window, `\x07` beeps.
 *
 * Display path only: this must never touch model input (`inherit_context`
 * builds the parent context from the same messages — stripping there would
 * corrupt data rather than protect a terminal).
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

function skipCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return value.length;
}

function skipEscape(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x2f) break;
    index++;
  }
  const final = value.charCodeAt(index);
  return final >= 0x30 && final <= 0x7e ? index + 1 : index;
}

function skipStringSequence(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && value[index + 1] === "\\") return index + 2;
  }
  return value.length;
}

/**
 * Strip terminal escape sequences and neutralize remaining control characters.
 *
 * Line endings are normalized first (`\r\n` and lone `\r` → `\n`). pi-tui's
 * wrappers currently split those correctly on their own, so this is
 * defense-in-depth as much as behavior: one regex pins the contract instead of
 * trusting a host utility's undocumented handling.
 */
export function sanitizeTranscriptText(value: string): string {
  const normalized = stripTerminalSequences(value.replace(/\r\n?/g, "\n"));
  let sanitized = "";

  for (let index = 0; index < normalized.length;) {
    const code = normalized.charCodeAt(index);

    if (code === 0x1b) {
      const next = normalized[index + 1];
      if (next === "[") {
        index = skipCsi(normalized, index + 2);
      } else if (next === "]" || next === "_" || next === "P" || next === "^" || next === "X") {
        index = skipStringSequence(normalized, index + 2);
      } else {
        index = skipEscape(normalized, index + 1);
      }
      continue;
    }

    if (code === 0x9b) {
      index = skipCsi(normalized, index + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = skipStringSequence(normalized, index + 1);
      continue;
    }

    if (code === 0x0a) sanitized += "\n";
    else if (code === 0x09) sanitized += "   ";
    else if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) sanitized += " ";
    else sanitized += normalized[index];
    index++;
  }

  return sanitized;
}
