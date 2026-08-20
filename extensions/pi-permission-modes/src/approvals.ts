/** Session-scoped approvals and prompt primitives. */

import type { PermissionGrant, Surface } from "./schema.ts";
import { permissionGrantIdentity } from "./permission-requirements.ts";
import { matchPattern } from "./resolve.ts";

export class SessionApprovals {
  private store = new Map<string, Map<Surface, Set<string>>>();
  private grantsByMode = new Map<string, PermissionGrant[]>();

  has(mode: string, surface: Surface, target: string): boolean {
    if (surface === "bash") {
      return this.grantsByMode.get(mode)?.some(
        (grant) => grant.permission === "bash" && matchPattern(grant.pattern, target, { expandTarget: true }),
      ) ?? false;
    }
    return this.store.get(mode)?.get(surface)?.has(target) ?? false;
  }

  grants(mode: string): PermissionGrant[] {
    return (this.grantsByMode.get(mode) ?? []).map((grant) =>
      grant.permission === "bash" ? { ...grant } : { permission: grant.permission, scope: { ...grant.scope } },
    );
  }

  remember(mode: string, surface: Surface, target: string): void {
    if (surface === "bash") {
      this.rememberGrant(mode, { permission: "bash", pattern: target });
      return;
    }
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

  rememberGrant(mode: string, grant: PermissionGrant): void {
    const grants = this.grantsByMode.get(mode) ?? [];
    const identity = permissionGrantIdentity(grant);
    if (!grants.some((entry) => permissionGrantIdentity(entry) === identity)) {
      grants.push(grant.permission === "bash" ? { ...grant } : { permission: grant.permission, scope: { ...grant.scope } });
    }
    this.grantsByMode.set(mode, grants);
  }

  clearMode(mode: string): void {
    this.store.delete(mode);
    this.grantsByMode.delete(mode);
  }

  clearAll(): void {
    this.store.clear();
    this.grantsByMode.clear();
  }
}

/** Minimal UI surface needed by `askWithSession`. */
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

/** Prompt for a surface approval while honoring the legacy untyped session store. */
export async function askWithSession(
  ui: ApprovalUI,
  approvals: SessionApprovals,
  mode: string,
  surface: Surface,
  target: string | string[],
  title: string,
  onForever?: () => void | Promise<void>,
): Promise<boolean> {
  if (!ui.hasUI) return false;
  const targets = Array.isArray(target) ? target : [target];
  if (targets.length > 0 && targets.every((value) => approvals.has(mode, surface, value))) return true;

  const options = onForever ? [ALLOW_ONCE, ALLOW_SESSION, ALLOW_FOREVER, DENY] : [ALLOW_ONCE, ALLOW_SESSION, DENY];
  const choice = await askApproval(ui, title, options);
  if (choice === "forever-global") {
    for (const value of targets) approvals.remember(mode, surface, value);
    await onForever?.();
    return true;
  }
  if (choice === "session") {
    for (const value of targets) approvals.remember(mode, surface, value);
    return true;
  }
  return choice === "once";
}
