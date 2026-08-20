import type { Action, ModeDef, PermissionGrant, PathGrantPermission } from "./schema.ts";
import type { NormalizedTarget } from "./paths.ts";
import { matchPattern, mostRestrictive, resolvePolicySurface } from "./resolve.ts";
import { scopeMatches } from "./file-approval.ts";

export type PermissionRequirement =
  | {
      kind: "path";
      permission: PathGrantPermission;
      displayTarget: string;
      canonicalTarget: string;
      action: Action;
    }
  | {
      kind: "command";
      permission: "bash";
      command: string;
      action: Action;
    };

export interface RequirementResult {
  denied: PermissionRequirement[];
  pending: PermissionRequirement[];
}

function pathRequirement(
  permission: PathGrantPermission,
  target: NormalizedTarget,
  decision: { action: Action | undefined; matched: boolean },
): PermissionRequirement | undefined {
  if (!decision.matched || decision.action === undefined) return undefined;
  return {
    kind: "path",
    permission,
    displayTarget: target.displayTarget,
    canonicalTarget: target.canonicalTarget,
    action: decision.action,
  };
}

/**
 * Construct direct-file requirements without turning sparse policy into an
 * independent ask on every absent surface. A completely unmatched call keeps
 * the historical operation-level ask fallback.
 */
export function buildFileRequirements(
  mode: ModeDef,
  operation: Exclude<PathGrantPermission, "path" | "external_directory">,
  target: NormalizedTarget,
  outside: boolean,
): PermissionRequirement[] {
  const targets = [target.displayTarget, target.canonicalTarget];
  const requirements: PermissionRequirement[] = [];
  const pathRequirementValue = pathRequirement("path", target, resolvePolicySurface(mode, "path", targets));
  if (pathRequirementValue) requirements.push(pathRequirementValue);

  if (outside) {
    const boundaryRequirement = pathRequirement(
      "external_directory",
      target,
      resolvePolicySurface(mode, "external_directory", targets),
    );
    if (boundaryRequirement) requirements.push(boundaryRequirement);
  }

  const operationDecision = resolvePolicySurface(mode, operation, targets);
  const operationRequirement = pathRequirement(operation, target, operationDecision);
  if (operationRequirement) requirements.push(operationRequirement);

  if (requirements.length === 0) {
    requirements.push({
      kind: "path",
      permission: operation,
      displayTarget: target.displayTarget,
      canonicalTarget: target.canonicalTarget,
      action: "ask",
    });
  }
  return requirements;
}

/** Create a typed Bash requirement for an originating `bash: ask`. */
export function buildCommandRequirement(command: string, action: Action | undefined): PermissionRequirement | undefined {
  return action === "ask" ? { kind: "command", permission: "bash", command, action } : undefined;
}

/** A stable identity used to deduplicate persisted and session grants. */
export function permissionGrantIdentity(grant: PermissionGrant): string {
  return grant.permission === "bash"
    ? `bash:${grant.pattern}`
    : `${grant.permission}:${grant.scope.kind}:${grant.scope.value}`;
}

/** Deduplicate grants without changing their first-seen order. */
export function deduplicatePermissionGrants(grants: PermissionGrant[]): PermissionGrant[] {
  const seen = new Set<string>();
  const result: PermissionGrant[] = [];
  for (const grant of grants) {
    const identity = permissionGrantIdentity(grant);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(grant.permission === "bash" ? { ...grant } : { permission: grant.permission, scope: { ...grant.scope } });
  }
  return result;
}

/** True when a remembered grant satisfies this requirement. */
export function grantMatchesRequirement(grant: PermissionGrant, requirement: PermissionRequirement): boolean {
  if (requirement.kind === "command") {
    return grant.permission === "bash" && matchBashGrant(grant.pattern, requirement.command);
  }
  return (
    grant.permission === requirement.permission && scopeMatches(grant.scope, requirement.canonicalTarget, undefined, true)
  );
}

/** Match the full command against a remembered Bash pattern. */
export function matchBashGrant(pattern: string, command: string): boolean {
  return matchPattern(pattern, command, { expandTarget: true });
}

/**
 * Evaluate policy outcomes and remembered grants. Grants are consulted only for
 * asks, so a configured deny is always returned in `denied`.
 */
export function evaluateRequirements(
  requirements: PermissionRequirement[],
  grants: PermissionGrant[] = [],
): RequirementResult {
  const denied: PermissionRequirement[] = [];
  const pending: PermissionRequirement[] = [];
  const uniqueRequirements = new Map<string, PermissionRequirement>();
  for (const requirement of requirements) {
    const identity =
      requirement.kind === "command"
        ? `command:${requirement.permission}:${requirement.command}`
        : `path:${requirement.permission}:${requirement.canonicalTarget}`;
    const existing = uniqueRequirements.get(identity);
    if (!existing) {
      uniqueRequirements.set(identity, requirement);
    } else {
      uniqueRequirements.set(identity, {
        ...existing,
        action: mostRestrictive(existing.action, requirement.action) ?? requirement.action,
      } as PermissionRequirement);
    }
  }
  for (const requirement of uniqueRequirements.values()) {
    if (requirement.action === "deny") {
      denied.push(requirement);
    } else if (requirement.action === "ask" && !grants.some((grant) => grantMatchesRequirement(grant, requirement))) {
      pending.push(requirement);
    }
  }
  return { denied, pending };
}
