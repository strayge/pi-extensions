/**
 * Value formatting shared by the item builders.
 *
 * `formatTokens` and `formatCwd` mirror pi's built-in footer exactly; changing
 * their rounding would make the default layout diverge from stock pi.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

const ESCAPE = 0x1b;
const CSI_PARAMETER = /[0-9;?]/;

/** Eight fill levels in one column. Block elements, so never double-width. */
const GAUGE_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function formatGauge(percent: number): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const index = Math.min(
    GAUGE_LEVELS.length - 1,
    Math.floor((clamped / 100) * GAUGE_LEVELS.length),
  );
  return GAUGE_LEVELS[index] as string;
}

export function formatBar(percent: number, width: number): string {
  const cells = Math.max(1, Math.round(width));
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells);
  return `[${"█".repeat(filled)}${"░".repeat(cells - filled)}]`;
}

export function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Trim a model id down to its recognisable core: drop a `vendor/` prefix and a
 * trailing release date, the two parts that carry no information when the
 * statusline is short on room.
 */
export function shortenModel(id: string): string {
  const withoutVendor = id.includes("/") ? (id.split("/").at(-1) ?? id) : id;
  return withoutVendor.replace(/-\d{8}$/, "").replace(/^(anthropic|openai|google)-/, "");
}

/**
 * Flatten a value to a single line.
 *
 * Only layout-breaking whitespace is touched; ANSI sequences survive, so an
 * extension that colors its own status keeps that color — same as stock pi.
 */
export function sanitize(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * Remove ANSI escape sequences outright, parameters included.
 *
 * Applied to text another extension rendered, where `sanitizeLiteral`'s visible
 * residue would be the wrong answer: a producer is handed a `color` per segment,
 * so an escape it emitted anyway is a mistake, and the reset at the end of one
 * would cancel the styling of everything after it on the line.
 */
export function stripAnsi(text: string): string {
  const characters = [...text];
  let result = "";
  for (let index = 0; index < characters.length; index += 1) {
    if ((characters[index]?.codePointAt(0) ?? 0) !== ESCAPE) {
      result += characters[index];
      continue;
    }
    // CSI is `ESC [ params intermediates final`; the final byte is dropped by
    // the loop's own increment. Any other escape loses its introducer, which
    // covers everything a status producer can plausibly emit.
    index += 1;
    if (characters[index] !== "[") continue;
    index += 1;
    while (index < characters.length && CSI_PARAMETER.test(characters[index] ?? "")) index += 1;
  }
  return result;
}

/**
 * Strip control characters from a literal the config author typed.
 *
 * Distinct from `sanitize`, which trims and collapses runs of spaces: padding is
 * the point of `" • "` and `" ("`, so spacing has to survive here. What cannot
 * survive is a control character — a newline measures as zero columns, so it
 * passes every width check and then desyncs pi's line accounting for the rest
 * of the session.
 *
 * An ANSI sequence loses its ESC and leaves its parameters behind as visible
 * text. That is deliberate: `color` and `bold` are the supported way to style an
 * item, and residue makes an unsupported escape obvious rather than quietly
 * swallowing the characters around it.
 */
export function sanitizeLiteral(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    result += character;
  }
  return result;
}
