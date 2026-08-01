/**
 * Quota-versus-clock arithmetic and the bar that draws it.
 *
 * A percentage on its own is ambiguous — 95% used with four hours to go is
 * trouble, 95% with five minutes to go is fine. Both Codex windows have a fixed
 * length, so the fraction of the window already elapsed is exact rather than
 * estimated, and the two can be compared directly.
 */

import type { UsageBucket, UsageValueMode } from "./types.ts";

const FILL = "█";
const EMPTY = "░";
/** Marks where the clock stands, for comparison against where the fill ends. */
const TICK = "┃";

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** The percentage this bucket should show, derived from its sibling if absent. */
export function bucketPercent(bucket: UsageBucket, value: UsageValueMode): number | undefined {
  const direct = value === "used" ? bucket.used : bucket.remaining;
  if (direct !== undefined) return direct;

  const opposite = value === "used" ? bucket.remaining : bucket.used;
  if (opposite === undefined) return undefined;
  if (bucket.unit === "percent") return 100 - opposite;
  if (bucket.limit !== undefined && bucket.limit > 0) return bucket.limit - opposite;
  return undefined;
}

/** The same, as a share of the limit — what a bar can actually draw. */
export function bucketPercentOfLimit(
  bucket: UsageBucket,
  value: UsageValueMode,
): number | undefined {
  const amount = bucketPercent(bucket, value);
  if (amount === undefined) return undefined;
  if (bucket.unit === "percent") return clampPercent(amount);
  if (bucket.limit === undefined || bucket.limit <= 0) return undefined;
  return clampPercent((amount / bucket.limit) * 100);
}

/**
 * A window is active until its reset passes; `undefined` means there is none.
 * Between the end of a Codex 5h window and the next message there is no window
 * at all, so there is nothing to count down to.
 */
export function minutesUntilReset(bucket: UsageBucket, now: number): number | undefined {
  if (bucket.resetsAt === undefined || !Number.isFinite(bucket.resetsAt)) return undefined;
  const minutes = (bucket.resetsAt * 1000 - now) / 60_000;
  return minutes > 0 ? minutes : undefined;
}

/** How far through the window the clock has moved, 0–1. */
export function windowElapsedFraction(bucket: UsageBucket, now: number): number | undefined {
  const left = minutesUntilReset(bucket, now);
  if (left === undefined) return undefined;
  const window = bucket.windowMinutes;
  if (window === undefined || !Number.isFinite(window) || window <= 0) return undefined;
  return Math.min(1, Math.max(0, 1 - left / window));
}

/**
 * Minutes to 100% at the rate established so far in this window.
 *
 * Straight-line extrapolation: 3% burned in the first 2% of the window reaches
 * the cap at 66.7% of it. Early in a window that rests on very little history,
 * which is why callers treat it as an estimate rather than a deadline.
 */
export function minutesToExhaustion(bucket: UsageBucket, now: number): number | undefined {
  if (bucket.unit !== "percent") return undefined;
  const left = minutesUntilReset(bucket, now);
  const window = bucket.windowMinutes;
  if (left === undefined || window === undefined || window <= 0) return undefined;

  const used = bucket.used;
  if (used === undefined || used <= 0) return undefined;
  if (used >= 100) return 0;

  const elapsed = window - left;
  if (elapsed <= 0) return undefined;
  return (100 - used) / (used / elapsed);
}

/** True when the bucket is on track to run out before it resets. */
export function isAtRisk(bucket: UsageBucket, now: number): boolean {
  const left = minutesUntilReset(bucket, now);
  const toEmpty = minutesToExhaustion(bucket, now);
  if (left === undefined || toEmpty === undefined) return false;
  return toEmpty < left;
}

/**
 * `markerAt` is a 0–1 position for the clock tick. It overwrites the cell it
 * lands on rather than adding one, so the bar keeps the width it was given.
 */
export function renderBar(percent: number, width: number, markerAt?: number): string {
  const cells = Math.max(1, Math.round(width));
  const filled = Math.round((clampPercent(percent) / 100) * cells);
  const bar: string[] = Array.from({ length: cells }, (_, index) =>
    index < filled ? FILL : EMPTY,
  );
  if (markerAt !== undefined && Number.isFinite(markerAt)) {
    const index = Math.min(cells - 1, Math.max(0, Math.round(markerAt * cells)));
    bar[index] = TICK;
  }
  return `[${bar.join("")}]`;
}

/**
 * Where the tick belongs for a given polarity.
 *
 * Under `used` the bar fills as the clock advances, so both run the same way and
 * fill past the tick means burning too fast. Under `remaining` the bar drains,
 * so the tick mirrors and fill *above* it is the healthy side.
 */
export function paceMarkerPosition(
  bucket: UsageBucket,
  value: UsageValueMode,
  now: number,
): number | undefined {
  const elapsed = windowElapsedFraction(bucket, now);
  if (elapsed === undefined) return undefined;
  return value === "used" ? elapsed : 1 - elapsed;
}
