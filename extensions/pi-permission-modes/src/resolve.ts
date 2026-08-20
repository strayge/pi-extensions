/**
 * Resolution engine — turns a mode, surface, and target into an action.
 *
 * Pattern maps remain last-match-wins. Independent policy sources compose with
 * the existing deny > ask > allow rule. File callers can ask for the result
 * for both the model spelling and the canonical execution target.
 */

import os from "node:os";
import { FILE_SURFACES, type Action, type ModeDef, type Surface, type SurfaceValue } from "./schema.ts";

const RANK: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

/** Expand a leading `~` or `$HOME` to the user's home directory. */
export function expandHome(s: string): string {
  const home = os.homedir();
  if (s === "~" || s === "$HOME") return home;
  if (s.startsWith("~/")) return home + s.slice(1);
  if (s.startsWith("$HOME/")) return home + s.slice(5);
  return s;
}

/** Options for matching a configured pattern against a target spelling. */
export interface MatchPatternOptions {
  /** Expand a target when its execution environment expands aliases (for Bash). */
  expandTarget?: boolean;
}

/**
 * Glob match: `*` matches any run of characters including `/`; `?` matches one
 * character. Configured patterns expand home aliases; targets stay literal by
 * default because file tools do not invoke a shell. Bash callers opt into target
 * expansion because the shell expands aliases before executing commands.
 */
export function matchPattern(pattern: string, target: string, options: MatchPatternOptions = {}): boolean {
  const p = expandHome(pattern);
  const t = options.expandTarget === true ? expandHome(target) : target;
  let re = "^";
  for (const ch of p) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re, "s").test(t);
}

/** Resolve one surface value using definition order and last-match-wins. */
export function resolveSurface(
  value: SurfaceValue | undefined,
  target: string,
  options: MatchPatternOptions = {},
): Action | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  let result: Action | undefined;
  for (const [pattern, action] of Object.entries(value)) {
    if (matchPattern(pattern, target, options)) result = action;
  }
  return result;
}

/** Most-restrictive of the given actions (deny > ask > allow); undefined ignored. */
export function mostRestrictive(...actions: (Action | undefined)[]): Action | undefined {
  let best: Action | undefined;
  let bestRank = -1;
  for (const action of actions) {
    if (action === undefined) continue;
    if (RANK[action] > bestRank) {
      best = action;
      bestRank = RANK[action];
    }
  }
  return best;
}

/** Resolution result retaining whether any explicit pattern matched. */
export interface SurfaceDecision {
  action: Action | undefined;
  matched: boolean;
}

/** Resolve a surface against both the lexical and canonical target spellings. */
export function resolveSurfaceTargets(
  value: SurfaceValue | undefined,
  targets: string | string[],
  options: MatchPatternOptions = {},
): SurfaceDecision {
  const values = (Array.isArray(targets) ? targets : [targets]).map((target) => resolveSurface(value, target, options));
  const action = mostRestrictive(...values);
  return { action, matched: values.some((value) => value !== undefined) };
}

function sourcesFor(mode: ModeDef): Array<Partial<Record<Surface, SurfaceValue>>> {
  return mode.projectOverlay ? [mode.permission, mode.projectOverlay] : [mode.permission];
}

const isFileSurface = (surface: Surface): boolean => FILE_SURFACES.includes(surface);
const isDirectFileSurface = (surface: Surface): boolean =>
  surface === "path" || surface === "external_directory" || (surface !== "bash" && isFileSurface(surface));

/** Resolve one surface across policy layers and both target spellings. */
export function resolvePolicySurface(mode: ModeDef, surface: Surface, targets: string | string[]): SurfaceDecision {
  const options = surface === "bash" ? { expandTarget: true } : {};
  const decisions = sourcesFor(mode).map((source) => resolveSurfaceTargets(source[surface], targets, options));
  return {
    action: mostRestrictive(...decisions.map((decision) => decision.action)),
    matched: decisions.some((decision) => decision.matched),
  };
}

/**
 * Decide an aggregate surface action. This compatibility helper preserves the
 * resolver's sparse fallback: an unmatched operation remains `ask`, while a
 * matching path or boundary surface can independently determine the result.
 */
export function decide(
  mode: ModeDef,
  surface: Surface,
  target: string,
  opts: { isOutside?: boolean; fallback?: Action; canonicalTarget?: string } = {},
): Action {
  const targets = opts.canonicalTarget ? [target, opts.canonicalTarget] : target;
  const layers: (Action | undefined)[] = [];
  const options = isDirectFileSurface(surface) ? { expandTarget: false } : {};
  for (const source of sourcesFor(mode)) {
    if (isFileSurface(surface)) layers.push(resolveSurfaceTargets(source.path, targets, options).action);
    if (opts.isOutside) layers.push(resolveSurfaceTargets(source.external_directory, targets, options).action);
    layers.push(resolveSurfaceTargets(source[surface], targets, options).action);
  }
  return mostRestrictive(...layers) ?? opts.fallback ?? "ask";
}

export interface BashPolicyDecision {
  bashAction?: Action;
  pathAction?: Action;
}

/**
 * Resolve the two policy surfaces for one parsed command. Bash patterns match
 * the joined command; path patterns retain the historic joined-command and
 * per-token matching. The actions are intentionally not collapsed so a Bash
 * grant cannot satisfy a path-originated ask.
 */
export function decideBashCommand(
  mode: ModeDef,
  name: string,
  args: string[],
  extraPathTargets: string[] = [],
): BashPolicyDecision {
  const tokens = [name, ...args];
  const joined = tokens.join(" ").trim();
  const bashValues: Action[] = [];
  const pathValues: Action[] = [];
  for (const source of sourcesFor(mode)) {
    const bash = resolveSurface(source.bash, joined, { expandTarget: true });
    if (bash !== undefined) bashValues.push(bash);
    const joinedPath = resolveSurface(source.path, joined, { expandTarget: true });
    if (joinedPath !== undefined) pathValues.push(joinedPath);
    for (const token of [...tokens, ...extraPathTargets]) {
      const pathAction = resolveSurface(source.path, token, { expandTarget: true });
      if (pathAction !== undefined) pathValues.push(pathAction);
    }
  }
  return {
    bashAction: mostRestrictive(...bashValues),
    pathAction: mostRestrictive(...pathValues),
  };
}

/** Resolve Bash and path surfaces against a fallback's complete command text. */
export function decideBashText(mode: ModeDef, command: string): BashPolicyDecision {
  const bashValues: Action[] = [];
  const pathValues: Action[] = [];
  for (const source of sourcesFor(mode)) {
    const bash = resolveSurface(source.bash, command, { expandTarget: true });
    if (bash !== undefined) bashValues.push(bash);
    const path = resolveSurface(source.path, command, { expandTarget: true });
    if (path !== undefined) pathValues.push(path);
  }
  const bashAction = mostRestrictive(...bashValues);
  const pathAction = mostRestrictive(...pathValues);
  // The heuristic parser has no command identity to authorize. Preserve the
  // historical fail-closed ask only when neither surface matched; a matching
  // path rule remains independent of the Bash surface.
  return { bashAction: bashAction ?? (pathAction === undefined ? "ask" : undefined), pathAction };
}

/** The aggregate action used only for sandbox/hard-safeguard routing. */
export function aggregateBashDecision(decision: BashPolicyDecision): Action | undefined {
  return mostRestrictive(decision.bashAction, decision.pathAction);
}
