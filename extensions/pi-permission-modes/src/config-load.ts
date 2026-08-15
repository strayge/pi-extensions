/**
 * Mode-config loading and layered merge.
 *
 * Layers, in order:
 *   1. permission-mode.defaults.json (shipped) — the four built-in modes, loaded
 *      over a minimal in-code fallback (FALLBACK_CONFIG).
 *   2. <agentDir>/permission-mode/permission-mode.json (global) — FULL authority:
 *      may add modes, redefine built-ins, and change defaultMode / cycleOrder.
 *   3. <cwd>/.pi/permission-mode.json (project) — trusted projects may append
 *      permission rules, typed outside-file grants, and additive sandbox entries;
 *      untrusted projects are a most-restrictive overlay and their grants are
 *      ignored. Project configs cannot add modes or change defaults.
 *
 * Pure except for the filesystem reads in `loadModeConfig`; no `pi`/`ctx`
 * dependency so the merge/tighten semantics are unit-testable.
 *
 * This module also owns the SandboxConfig shape consumed by sandbox.ts (the
 * runtime takes `{network, filesystem}`), plus the read-only override and the
 * domain-safety check ported from the former config.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { isRootWidePattern, isValidStoredScope } from "./file-approval.ts";
import { sandboxMountPath } from "./paths.ts";
import {
  type Action,
  type FileScope,
  type FileSurface,
  type ModeDef,
  type PermissionModeConfig,
  type SandboxProfile,
  type SurfaceValue,
  type Surface,
  OUTSIDE_FILE_SURFACES,
  SURFACES,
} from "./schema.ts";

type OnError = (message: string) => void;
const noop: OnError = () => {};

/**
 * Emergency in-code fallback — a single safe, sandboxed, ask-everything mode used
 * ONLY when the shipped `permission-mode.defaults.json` can't be read. The real
 * defaults live in that JSON; a test asserts it reproduces the intended behavior,
 * so this never silently stands in for them in a healthy install.
 */
export const FALLBACK_CONFIG: PermissionModeConfig = {
  defaultMode: "default",
  cycleOrder: ["default"],
  modes: {
    default: {
      label: "Default",
      color: "muted",
      sandbox: {
        enabled: true,
        writable: true,
        allowWrite: ["."],
        denyWrite: [],
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
        network: { allowedDomains: [], deniedDomains: [] },
      },
      permission: {
        path: { "*": "allow" },
        external_directory: "ask",
        read: "allow",
        grep: "allow",
        find: "allow",
        ls: "allow",
        write: "ask",
        edit: "ask",
        bash: { "*": "ask" },
        web_search: "ask",
        tool: "ask",
        skill: "ask",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Sandbox config shape (consumed by sandbox.ts / @anthropic-ai/sandbox-runtime)
// ---------------------------------------------------------------------------

export interface SandboxConfig {
  enabled?: boolean;
  network?: { allowedDomains?: string[]; deniedDomains?: string[] };
  filesystem?: { denyRead?: string[]; allowWrite?: string[]; denyWrite?: string[] };
}

/** Project a mode's sandbox profile into the runtime's config shape. */
export function profileToConfig(p: SandboxProfile): SandboxConfig {
  return {
    enabled: p.enabled,
    network: p.network,
    filesystem: { denyRead: p.denyRead, allowWrite: p.allowWrite, denyWrite: p.denyWrite },
  };
}

/**
 * Apply `sandboxMountPath` to every filesystem list before the config reaches the
 * sandbox runtime; entries it rejects are dropped and reported through `onError`.
 *
 * A list that was undefined stays undefined rather than becoming `[]`: the runtime
 * reads a per-command override as `custom ?? session config`, so an empty array
 * would replace the session's restrictions instead of inheriting them.
 */
export function canonicalizeSandboxPaths(config: Partial<SandboxConfig>, onError: OnError = noop): Partial<SandboxConfig> {
  const fs = config.filesystem;
  if (!fs) return config;
  const resolveList = (list: string[] | undefined, kind: string): string[] | undefined => {
    if (!list) return undefined;
    const out: string[] = [];
    for (const entry of list) {
      const resolved = sandboxMountPath(entry);
      if (resolved === null) {
        onError(`permission-mode: dropping sandbox ${kind} path "${entry}" — it resolves to a broader directory`);
        continue;
      }
      if (!out.includes(resolved)) out.push(resolved);
    }
    return out;
  };
  return {
    ...config,
    filesystem: {
      ...fs,
      denyRead: resolveList(fs.denyRead, "denyRead"),
      allowWrite: resolveList(fs.allowWrite, "allowWrite"),
      denyWrite: resolveList(fs.denyWrite, "denyWrite"),
    },
  };
}

/** Drop all project write access (Plan Mode runs bash read-only); reads/network stay. */
export function readOnlyOverride(config: SandboxConfig | undefined): Partial<SandboxConfig> {
  return { ...config, filesystem: { ...config?.filesystem, allowWrite: [] } };
}

/**
 * Reject domain patterns the sandbox-runtime schema would reject: bare `*`,
 * TLD-only wildcards like `*.com`, and anything carrying a protocol, path, or port.
 */
export function isUnsafeDomain(d: string): boolean {
  if (d === "*") return true;
  if (/[/:]/.test(d)) return true;
  if (/^\*\.[^.]+$/.test(d)) return true;
  return false;
}

const union = (a: string[] = [], b: string[] = []): string[] => [...new Set([...a, ...b])];
const intersect = (a: string[] = [], b: string[] = []): string[] => a.filter((x) => b.includes(x));

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isAction = (v: unknown): v is Action => v === "allow" || v === "ask" || v === "deny";

/**
 * JS objects iterate array-index-like keys ("0", "42", …) FIRST, regardless of
 * definition order — which silently breaks the last-match-wins semantics of a
 * pattern-map. Such keys are worth a warning (the pattern still works; only its
 * position in the map is not what the file suggests).
 */
const isIndexLikeKey = (k: string): boolean => /^(0|[1-9]\d*)$/.test(k);

/**
 * Clean a raw permission object: drop unknown surfaces and coerce invalid action
 * values to "deny" (fail-safe), reporting each via onError. Warns on
 * array-index-like pattern keys, whose iteration order JS silently front-loads.
 */
function cleanPermission(raw: unknown, where: string, onError: OnError): Partial<Record<Surface, unknown>> {
  const out: Partial<Record<Surface, unknown>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SURFACES.includes(key as Surface)) {
      onError(`permission-mode: ignoring unknown surface "${key}" in ${where}`);
      continue;
    }
    const surface = key as Surface;
    if (typeof value === "string") {
      if (isAction(value)) {
        out[surface] = value;
      } else {
        onError(`permission-mode: invalid action "${value}" for ${key} in ${where}; treating as deny`);
        out[surface] = "deny";
      }
    } else if (value && typeof value === "object") {
      const map: Record<string, Action> = {};
      for (const [pat, act] of Object.entries(value as Record<string, unknown>)) {
        if (isIndexLikeKey(pat)) {
          onError(
            `permission-mode: pattern "${pat}" for ${key} in ${where} is a bare number — JS reorders such keys to the FRONT of the map, so last-match-wins may not follow file order; prefix or quote it differently (e.g. "./${pat}")`,
          );
        }
        if (isAction(act)) map[pat] = act;
        else onError(`permission-mode: invalid action "${act}" for ${key}.${pat} in ${where}; dropping`);
      }
      out[surface] = map;
    }
  }
  return out;
}

function cleanOutsideFileGrants(
  raw: unknown,
  where: string,
  onError: OnError,
): Partial<Record<FileSurface, FileScope[]>> {
  const out: Partial<Record<FileSurface, FileScope[]>> = {};
  if (raw === undefined) return out;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    onError(`permission-mode: invalid outsideFileGrants in ${where}; dropping`);
    return out;
  }
  for (const [surfaceName, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!OUTSIDE_FILE_SURFACES.includes(surfaceName as FileSurface)) {
      onError(`permission-mode: ignoring unknown outside-file surface "${surfaceName}" in ${where}`);
      continue;
    }
    if (!Array.isArray(entries)) {
      onError(`permission-mode: invalid outsideFileGrants.${surfaceName} in ${where}; dropping`);
      continue;
    }
    const surface = surfaceName as FileSurface;
    const accepted: FileScope[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!isValidStoredScope(entry)) {
        onError(`permission-mode: dropping malformed or unbound outsideFileGrants.${surfaceName} entry in ${where}`);
        continue;
      }
      if (entry.kind === "glob" && isRootWidePattern(entry.value)) {
        onError(`permission-mode: dropping root-wide outsideFileGrants.${surfaceName} pattern "${entry.value}" in ${where}`);
        continue;
      }
      // Stored scopes were bound when approved or persisted. Re-resolving them
      // here would let a later symlink change retarget an existing grant.
      const key = `${entry.kind}:${entry.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push({ ...entry });
    }
    if (accepted.length > 0) out[surface] = accepted;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Global (full-authority) merge
// ---------------------------------------------------------------------------

function mergeMode(base: ModeDef, over: Partial<ModeDef>): ModeDef {
  return {
    ...base,
    ...over,
    sandbox: over.sandbox ? { ...base.sandbox, ...over.sandbox } : base.sandbox,
    // Surface-level shallow merge: an override replaces a whole surface's value.
    permission: { ...base.permission, ...(over.permission ?? {}) },
    hideTools: over.hideTools ?? base.hideTools,
    outsideFileGrants: over.outsideFileGrants ?? base.outsideFileGrants,
  };
}

function mergeGlobal(base: PermissionModeConfig, over: Partial<PermissionModeConfig>, onError: OnError): PermissionModeConfig {
  const modes: Record<string, ModeDef> = { ...base.modes };
  for (const [name, raw] of Object.entries(over.modes ?? {})) {
    const m = raw as Partial<ModeDef>;
    if (m.permission) m.permission = cleanPermission(m.permission, `global mode "${name}"`, onError) as ModeDef["permission"];
    if ("outsideFileGrants" in m && m.outsideFileGrants !== undefined) {
      m.outsideFileGrants = cleanOutsideFileGrants(m.outsideFileGrants, `global mode "${name}"`, onError);
    }
    const existing = modes[name];
    if (existing) {
      modes[name] = mergeMode(existing, m);
    } else if (m.sandbox && m.label && m.color) {
      modes[name] = m as ModeDef; // a complete new mode
    } else {
      onError(`permission-mode: ignoring incomplete new global mode "${name}" (needs label, color, sandbox)`);
    }
  }
  const cycleOrder = (over.cycleOrder ?? base.cycleOrder).filter((n) => modes[n]);
  let defaultMode = over.defaultMode ?? base.defaultMode;
  if (!modes[defaultMode]) defaultMode = cycleOrder[0] ?? base.defaultMode;
  return { defaultMode, cycleOrder, modes };
}

// ---------------------------------------------------------------------------
// Project merge
// ---------------------------------------------------------------------------

function tightenSandbox(base: SandboxProfile, over: Partial<SandboxProfile>, onError: OnError): SandboxProfile {
  const result: SandboxProfile = { ...base, network: { ...base.network } };
  // Project overlays cannot change whether a mode is sandboxed. In particular,
  // they must never disable containment, and allowing them to enable a sparse
  // globally-unsandboxed profile would create a surprising, potentially
  // incomplete runtime configuration. Repeating the inherited value is a
  // harmless no-op; changing it is ignored with a warning.
  if (over.enabled !== undefined && over.enabled !== base.enabled) {
    onError(`permission-mode: project config cannot change sandbox.enabled; ignoring sandbox.enabled=${over.enabled}`);
  }
  if (over.writable === false) result.writable = false; // can force read-only, never re-enable writes
  if (over.askOnBlockedHost === false) result.askOnBlockedHost = false; // silent-deny is stricter than asking
  if (over.allowWrite !== undefined) result.allowWrite = intersect(base.allowWrite, over.allowWrite);
  if (over.denyRead !== undefined) result.denyRead = union(base.denyRead, over.denyRead);
  if (over.denyWrite !== undefined) result.denyWrite = union(base.denyWrite, over.denyWrite);
  if (over.network) {
    if (over.network.allowedDomains !== undefined) {
      const safe = over.network.allowedDomains.filter((d) => {
        if (isUnsafeDomain(d)) {
          onError(`permission-mode: ignoring overly-broad allowedDomains pattern "${d}" in project config`);
          return false;
        }
        return true;
      });
      result.network!.allowedDomains = intersect(base.network?.allowedDomains, safe);
    }
    if (over.network.deniedDomains !== undefined) {
      result.network!.deniedDomains = union(base.network?.deniedDomains, over.network.deniedDomains);
    }
  }
  return result;
}

function appendPatterns(base: SurfaceValue | undefined, over: SurfaceValue): SurfaceValue {
  const left: Record<string, Action> = typeof base === "string" ? { "*": base } : { ...(base ?? {}) };
  const right: Record<string, Action> = typeof over === "string" ? { "*": over } : over;
  for (const [key, action] of Object.entries(right)) {
    delete left[key];
    left[key] = action;
  }
  return left;
}

function applyProject(
  config: PermissionModeConfig,
  project: Partial<PermissionModeConfig>,
  onError: OnError,
  projectTrusted: boolean,
): void {
  if (project.defaultMode || project.cycleOrder) {
    onError("permission-mode: project config cannot change defaultMode/cycleOrder; ignoring");
  }
  for (const [name, raw] of Object.entries(project.modes ?? {})) {
    const base = config.modes[name];
    if (!base) {
      onError(`permission-mode: project config cannot add new mode "${name}"; ignoring`);
      continue;
    }
    const pm = raw as Partial<ModeDef>;
    if (pm.sandbox) {
      if (projectTrusted) {
        const over = pm.sandbox;
        const tightenOnly: Partial<SandboxProfile> = {
          ...over,
          allowWrite: undefined,
          network: over.network ? { ...over.network, allowedDomains: undefined } : undefined,
        };
        const next = tightenSandbox(base.sandbox, tightenOnly, onError);
        next.allowWrite = union(base.sandbox.allowWrite, over.allowWrite);
        if (over.network?.allowedDomains !== undefined) {
          const safe = over.network.allowedDomains.filter((d) => {
            if (isUnsafeDomain(d)) {
              onError(`permission-mode: ignoring overly-broad allowedDomains pattern "${d}" in project config`);
              return false;
            }
            return true;
          });
          next.network = { ...next.network, allowedDomains: union(base.sandbox.network?.allowedDomains, safe) };
        }
        base.sandbox = next;
      } else base.sandbox = tightenSandbox(base.sandbox, pm.sandbox, onError);
    }
    if (pm.outsideFileGrants !== undefined) {
      if (projectTrusted) {
        base.trustedProjectOutsideFileGrants = cleanOutsideFileGrants(
          pm.outsideFileGrants,
          `trusted project mode "${name}"`,
          onError,
        );
      } else {
        onError(`permission-mode: ignoring outsideFileGrants for untrusted project mode "${name}"`);
      }
    }
    if (pm.permission) {
      const clean = cleanPermission(pm.permission, `project mode "${name}"`, onError) as ModeDef["permission"];
      if (projectTrusted) {
        base.trustedProjectPermission = clean;
        for (const [surface, value] of Object.entries(clean) as [Surface, SurfaceValue][]) {
          base.permission[surface] = appendPatterns(base.permission[surface], value);
        }
      } else {
        base.projectOverlay = clean;
      }
    }
    // label/color/systemPrompt/hideTools/bypassProtectedPaths from a project are
    // ignored: they're cosmetic or could loosen, neither of which a project may do.
  }
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Strip `$schema` and parse a config file, or undefined (reporting parse errors). */
function parseConfigFile(p: string, onError: OnError): Partial<PermissionModeConfig> | undefined {
  if (!existsSync(p)) return undefined;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as Partial<PermissionModeConfig>;
    delete (data as { $schema?: unknown }).$schema;
    return data;
  } catch (e) {
    onError(`permission-mode: could not parse ${p}: ${e}`);
    return undefined;
  }
}

/** Absolute path to the shipped stock defaults (resolved wherever installed). */
export function stockDefaultsFile(): string {
  return fileURLToPath(new URL("../permission-mode.defaults.json", import.meta.url));
}

/**
 * The shipped default modes: `permission-mode.defaults.json` applied (full
 * authority) over the minimal FALLBACK_CONFIG via the same merge pipeline as user
 * config. If the stock file is missing/invalid, the safe fallback is returned and
 * the problem is reported — the extension always has at least one valid mode.
 */
export function loadStockDefaults(onError: OnError = noop): PermissionModeConfig {
  const stock = parseConfigFile(stockDefaultsFile(), onError);
  if (!stock) {
    onError("permission-mode: stock defaults (permission-mode.defaults.json) missing or invalid — using minimal fallback; reinstall the extension");
    return clone(FALLBACK_CONFIG);
  }
  return mergeGlobal(clone(FALLBACK_CONFIG), stock, onError);
}

/** Path to the user's global config (the one `/perm init` and persistence write). */
export function globalConfigFile(agentDir: string): string {
  return path.join(agentDir, "permission-mode", "permission-mode.json");
}

/** Count project permission entries that can grant when the project is trusted. */
export function projectGrantCount(cwd: string, agentDir?: string): number {
  const file = path.join(cwd, CONFIG_DIR_NAME, "permission-mode.json");
  if (!existsSync(file)) return 0;
  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as Partial<PermissionModeConfig>;
    let base = loadStockDefaults();
    const global = agentDir ? parseConfigFile(globalConfigFile(agentDir), noop) : undefined;
    if (global) base = mergeGlobal(base, global, noop);
    const known = new Set(Object.keys(base.modes));
    let count = 0;
    for (const [name, mode] of Object.entries(data.modes ?? {})) {
      if (!known.has(name)) continue;
      const permission = cleanPermission((mode as Partial<ModeDef>).permission, `project mode "${name}"`, noop);
      for (const value of Object.values(permission)) {
        if (value === "allow") count++;
        else if (value && typeof value === "object") count += Object.values(value).filter((action) => action === "allow").length;
      }
      const grants = cleanOutsideFileGrants((mode as Partial<ModeDef>).outsideFileGrants, `project mode "${name}"`, noop);
      for (const scopes of Object.values(grants)) count += scopes?.length ?? 0;
    }
    return count;
  } catch {
    return 0;
  }
}

export function loadModeConfig(
  cwd: string,
  agentDir: string,
  onError: OnError = noop,
  projectTrusted = false,
): PermissionModeConfig {
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, "permission-mode.json");

  let config = loadStockDefaults(onError);
  const global = parseConfigFile(globalConfigFile(agentDir), onError);
  if (global) config = mergeGlobal(config, global, onError);
  const project = parseConfigFile(projectPath, onError);
  if (project) applyProject(config, project, onError, projectTrusted);
  return config;
}

/**
 * Persist "allow forever" network domains for a mode to the global config.
 *
 * mergeGlobal replaces a mode's `network` object wholesale, so the WHOLE
 * effective allowlist must be written, not just the new entries. The base is
 * stock + global WITHOUT the project layer — a project's tighten-only
 * intersection must never be baked into the user's global config. Returns the
 * path written.
 */
export function persistModeDomains(agentDir: string, modeName: string, domains: string[]): string {
  const file = globalConfigFile(agentDir);
  let base = loadStockDefaults();
  const global = parseConfigFile(file, noop);
  if (global) base = mergeGlobal(base, structuredClone(global), noop);
  const baseNetwork = base.modes[modeName]?.sandbox.network;

  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`cannot update malformed config ${file}: ${e}`);
    }
  }
  const modes = (data.modes ??= {}) as Record<string, { sandbox?: { network?: Record<string, unknown> } }>;
  const mode = (modes[modeName] ??= {});
  const sandbox = (mode.sandbox ??= {});
  sandbox.network = {
    ...baseNetwork,
    allowedDomains: [...new Set([...(baseNetwork?.allowedDomains ?? []), ...domains])],
    deniedDomains: baseNetwork?.deniedDomains ?? [],
  };

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/**
 * Persist a learned per-mode rule ("Allow forever") to the global config, e.g.
 * `modes.<mode>.permission.<surface>.<key> = "allow"`. Reads the existing file
 * (preserving the user's content incl. `$schema`), ensures the surface is a
 * pattern-map (seeding `"*": "ask"` so other names keep prompting), sets the
 * rule, and writes pretty JSON. Returns the path written.
 *
 * Project rules use `persistProjectRule`, which deliberately omits the global
 * fallback seeded here.
 */
export function persistModeRule(
  agentDir: string,
  modeName: string,
  surface: Surface,
  key: string,
  action: Action,
): string {
  const file = globalConfigFile(agentDir);
  return writeRuleInto(file, modeName, surface, key, action, true);
}

function writeRuleInto(file: string, modeName: string, surface: Surface, key: string, action: Action, seed: boolean): string {
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`cannot update malformed config ${file}: ${e}`);
    }
  }
  const modes = (data.modes ??= {}) as Record<string, { permission?: Record<string, SurfaceValue> }>;
  const mode = (modes[modeName] ??= {});
  const permission = (mode.permission ??= {});
  const current = permission[surface];
  const map: Record<string, Action> =
    typeof current === "string" ? { "*": current } : { ...(current as Record<string, Action> | undefined) };
  if (seed && !("*" in map)) map["*"] = "ask"; // keep prompting for other names
  delete map[key];
  map[key] = action;
  permission[surface] = map;

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/** Persist an allow rule in the trusted project's permission-mode file. */
export function persistProjectRule(cwd: string, modeName: string, surface: Surface, key: string, action: Action): string {
  return writeRuleInto(path.join(cwd, CONFIG_DIR_NAME, "permission-mode.json"), modeName, surface, key, action, false);
}

function writeJsonAtomically(file: string, data: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temporary, file);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // The original error is the useful failure for the caller.
    }
    throw error;
  }
}

function readMutableJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    throw new Error(`cannot update malformed config ${file}: ${error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`cannot update malformed config ${file}: root must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function persistOutsideFileGrantInto(file: string, modeName: string, surface: FileSurface, scope: FileScope): string {
  // The prompt already bound this value before approval. Resolving it again here
  // would make a symlink swap between approval and persistence retarget the grant.
  const bound = isValidStoredScope(scope) ? { ...scope } : undefined;
  if (!bound || (bound.kind === "glob" && isRootWidePattern(bound.value))) {
    throw new Error("cannot persist invalid, unbound, or root-wide outside-file scope");
  }
  const data = readMutableJson(file);
  const modesValue = data.modes;
  if (modesValue !== undefined && (!modesValue || typeof modesValue !== "object" || Array.isArray(modesValue))) {
    throw new Error(`cannot update malformed config ${file}: modes must be an object`);
  }
  const modes = (data.modes ??= {}) as Record<string, unknown>;
  const modeValue = modes[modeName];
  if (modeValue !== undefined && (!modeValue || typeof modeValue !== "object" || Array.isArray(modeValue))) {
    throw new Error(`cannot update malformed config ${file}: mode must be an object`);
  }
  const mode = (modes[modeName] ??= {}) as Record<string, unknown>;
  const grantsValue = mode.outsideFileGrants;
  if (grantsValue !== undefined && (!grantsValue || typeof grantsValue !== "object" || Array.isArray(grantsValue))) {
    throw new Error(`cannot update malformed config ${file}: outsideFileGrants must be an object`);
  }
  const grants = (mode.outsideFileGrants ??= {}) as Record<string, unknown>;
  const existing = cleanOutsideFileGrants(grants, `existing ${file}`, noop)[surface] ?? [];
  if (!existing.some((entry) => entry.kind === bound.kind && entry.value === bound.value)) existing.push({ ...bound });
  grants[surface] = existing;
  writeJsonAtomically(file, data);
  return file;
}

/** Persist a deny-safe typed outside-file grant in the global configuration. */
export function persistOutsideFileGrant(agentDir: string, modeName: string, surface: FileSurface, scope: FileScope): string {
  return persistOutsideFileGrantInto(globalConfigFile(agentDir), modeName, surface, scope);
}

/** Persist a deny-safe typed outside-file grant in a trusted project configuration. */
export function persistProjectOutsideFileGrant(cwd: string, modeName: string, surface: FileSurface, scope: FileScope): string {
  return persistOutsideFileGrantInto(path.join(cwd, CONFIG_DIR_NAME, "permission-mode.json"), modeName, surface, scope);
}
