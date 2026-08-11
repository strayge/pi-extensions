/**
 * Session-scoped approvals — "Allow for session" memory.
 *
 * When an `ask` is granted "for session", the (mode, surface, target) is
 * remembered so the same action isn't re-prompted for the rest of the session.
 * The store is keyed per-mode (switching Build → Default → Build restores
 * Default's grants), session-lifetime only (never persisted to disk), and
 * cleared on session shutdown.
 *
 * The store is pure and unit-tested; `askWithSession` is the thin UI glue (a
 * three-way Allow once / Allow for session / Deny prompt).
 */

import type { Surface } from "./schema.ts";
import { matchPattern } from "./resolve.ts";

export class SessionApprovals {
  private store = new Map<string, Map<Surface, Set<string>>>();

  has(mode: string, surface: Surface, target: string): boolean {
    const values = this.store.get(mode)?.get(surface);
    if (!values) return false;
    return surface === "bash" ? [...values].some((pattern) => matchPattern(pattern, target)) : values.has(target);
  }

  remember(mode: string, surface: Surface, target: string): void {
    let bySurface = this.store.get(mode);
    if (!bySurface) {
      bySurface = new Map();
      this.store.set(mode, bySurface);
    }
    let set = bySurface.get(surface);
    if (!set) {
      set = new Set();
      bySurface.set(surface, set);
    }
    set.add(target);
  }

  clearMode(mode: string): void {
    this.store.delete(mode);
  }

  clearAll(): void {
    this.store.clear();
  }
}

/** Minimal UI surface needed by `askWithSession` (a subset of ctx.ui + hasUI). */
export interface ApprovalUI {
  hasUI: boolean;
  select(title: string, options: string[]): Promise<string | undefined>;
}

export const ALLOW_ONCE = "Allow once";
export const ALLOW_SESSION = "Allow for session";
export const ALLOW_FOREVER = "Allow forever";
export const ALWAYS_ALLOW = "Always allow…";
export const DENY = "Deny";
export type ApprovalScope = "once" | "session" | "forever-global" | "forever-project" | "deny";

export async function askApproval(
  ui: ApprovalUI,
  title: string,
  options: string[] = [ALLOW_ONCE, ALLOW_SESSION, ALLOW_FOREVER, DENY],
): Promise<ApprovalScope> {
  if (!ui.hasUI) return "deny";
  const choice = await ui.select(title, options);
  if (choice === ALLOW_ONCE) return "once";
  if (choice === ALLOW_SESSION) return "session";
  if (choice === ALLOW_FOREVER || choice === ALWAYS_ALLOW) return "forever-global";
  return "deny";
}

/**
 * Prompt for approval, honoring prior "Allow for session" grants. Returns true
 * to allow, false to deny. With no UI, denies (most-restrictive).
 *
 * `target` may be a single key or a list (e.g. every command name extracted
 * from a bash chain). The prompt is skipped only when EVERY target is already
 * granted — so "allow git this session" never silently covers
 * `git status && curl ... | sh`. Granting for session (or forever) remembers
 * ALL targets, so re-running the exact same approved chain passes silently.
 * An empty list never auto-allows.
 *
 * When `onForever` is provided, a fourth "Allow forever" option appears; choosing
 * it records the session grant AND invokes `onForever` (which persists the rule
 * to the user's config). Used for first-seen extension tools / skills.
 */
export async function askWithSession(
  ui: ApprovalUI,
  approvals: SessionApprovals,
  mode: string,
  surface: Surface,
  target: string | string[],
  title: string,
  onForever?: () => void | Promise<void>,
): Promise<boolean> {
  if (!ui.hasUI) return false; // no way to confirm → deny
  const targets = Array.isArray(target) ? target : [target];
  // Already granted this session — every target must be covered.
  if (targets.length > 0 && targets.every((t) => approvals.has(mode, surface, t))) return true;

  const options = onForever ? [ALLOW_ONCE, ALLOW_SESSION, ALLOW_FOREVER, DENY] : [ALLOW_ONCE, ALLOW_SESSION, DENY];
  const choice = await askApproval(ui, title, options);
  if (choice === "forever-global") {
    for (const t of targets) approvals.remember(mode, surface, t); // cover the rest of this session immediately
    await onForever?.();
    return true;
  }
  if (choice === "session") {
    for (const t of targets) approvals.remember(mode, surface, t);
    return true;
  }
  return choice === "once";
}
