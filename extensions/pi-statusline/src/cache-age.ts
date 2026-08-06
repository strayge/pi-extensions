/**
 * Prompt-cache staleness: how long it has been since the last response, and
 * whether that gap is long enough that the next request re-writes the cache
 * instead of reading it.
 *
 * The provider owns the real TTL and never reports it, so this is a local
 * estimate — the last response we know about plus a configured idle allowance.
 * pi's own `showCacheMissNotices` measures the same gap against its own
 * five-minute constant, and reports it only after the miss has been billed.
 */

import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RuntimeState } from "./runtime.ts";
import type { ContextItemConfig } from "./types.ts";

/** Anthropic and Codex both retain a prompt cache for an hour. */
export const DEFAULT_COLD_AFTER_MINUTES = 60;

export const DEFAULT_COLD_MARKER = "❄ ";
export const DEFAULT_COLD_COLOR = "accent";

const MINUTE_MS = 60_000;

export function coldAfterMs(item: ContextItemConfig): number {
  return (item.coldAfterMinutes ?? DEFAULT_COLD_AFTER_MINUTES) * MINUTE_MS;
}

/**
 * An undefined `lastResponseAt` reads as "nothing cached yet" rather than as a
 * stale cache: a session with no response behind it has nothing to lose.
 */
export function isCacheCold(item: ContextItemConfig, runtime: RuntimeState, now: number): boolean {
  if ((item.coldStyle ?? "off") === "off") return false;
  const last = runtime.lastResponseAt;
  if (last === undefined) return false;
  return now - last >= coldAfterMs(item);
}

/**
 * The timestamp of the newest assistant message already on disk.
 *
 * Resuming yesterday's session is the case the warning exists for, and nothing
 * in this process has seen a response yet — so the starting point has to come
 * from the session's own entries.
 */
export function lastResponseFromEntries(ctx: ExtensionContext): number | undefined {
  let entries: SessionEntry[];
  try {
    entries = ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    if (entry.message?.role !== "assistant") continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

/**
 * When the earliest visible context item will next flip to cold, or undefined
 * when none of them can.
 *
 * Drives a single timer rather than a poll: going cold is the one thing the
 * statusline shows that happens while nothing else is going on, so without a
 * wake-up it would first appear whenever the user next typed — which is exactly
 * too late to be worth knowing.
 */
export function nextColdTransition(
  items: ContextItemConfig[],
  runtime: RuntimeState,
  now: number,
): number | undefined {
  const last = runtime.lastResponseAt;
  if (last === undefined) return undefined;

  let soonest: number | undefined;
  for (const item of items) {
    if ((item.coldStyle ?? "off") === "off") continue;
    const at = last + coldAfterMs(item);
    if (at <= now) continue;
    if (soonest === undefined || at < soonest) soonest = at;
  }
  return soonest;
}
