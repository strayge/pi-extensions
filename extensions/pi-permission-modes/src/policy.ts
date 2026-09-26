import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig } from "./config-load.ts";
import { assertNativeSemantics } from "./native-semantics.ts";
import { assertBinding, bindPath, configPath, contains, revalidate, within } from "./paths.ts";
import type {
  Access,
  FilesystemSnapshot,
  PathBinding,
  PermissionModeConfig,
  ResolvedCatalog,
  ResolvedProfile,
  ResolvedRule,
  ResourceGrant,
  RootIdentity,
} from "./schema.ts";

export interface ResolutionContext {
  agentDir: string;
  home: string;
  piPackage?: string;
  node?: string;
}

export function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Locate only the package owning the active CLI, not an extension's development dependency. */
export function activePiPackage(entry = process.argv[1]): string | undefined {
  if (!entry || !existsSync(entry)) return undefined;
  let dir = path.dirname(bindPath(path.resolve(entry)).canonical);
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, "utf8"));
      if (json.name === "@earendil-works/pi-coding-agent") return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export const SYSTEM_PATHS: Record<string, string[]> = {
  linux: [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc/alternatives",
    "/etc/ssl/certs",
    "/etc/ca-certificates",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/nsswitch.conf",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/gai.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/localtime",
    "/etc/os-release",
  ],
  darwin: [
    "/System",
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/share",
    "/bin",
    "/sbin",
    "/Library/Apple",
    "/private/etc/hosts",
    "/private/etc/resolv.conf",
    "/private/etc/services",
    "/private/etc/ssl",
    "/private/var/db/dyld",
  ],
};

function resource(value: string): ResourceGrant | undefined {
  if (!existsSync(value)) return undefined;
  const binding = bindPath(value);
  return {
    definition: `resource:${value}`,
    binding,
    scope: binding.identity.type === "directory" ? "tree" : "file",
    access: "read",
  };
}

/** Runtime package roots are enumerated by exact name; their enclosing prefix is never granted. */
export function automaticResources(selectors: ("pi" | "system")[], context: ResolutionContext): ResourceGrant[] {
  const paths: string[] = [];
  if (selectors.includes("system")) {
    const baseline = SYSTEM_PATHS[process.platform];
    if (!baseline) throw new Error(`No system resource baseline for ${process.platform}`);
    paths.push(...baseline);
  }
  if (selectors.includes("pi")) {
    const piPackage = context.piPackage ?? activePiPackage();
    if (!piPackage) throw new Error("Cannot identify the active Pi package; provide trusted host package metadata");
    const node = bindPath(context.node ?? process.execPath).canonical;
    const prefix = path.dirname(path.dirname(node));
    paths.push(path.join(context.home, ".pi"), context.agentDir, piPackage, node);
    for (const name of ["npm", "corepack"]) {
      paths.push(path.join(prefix, "lib", "node_modules", name));
    }
    for (const launcher of ["npm", "npx", "corepack"]) paths.push(path.join(prefix, "bin", launcher));
  }
  return paths.map(resource).filter((r): r is ResourceGrant => !!r);
}

function definition(value: unknown): string {
  return JSON.stringify(value);
}

export function resolveCatalog(
  config: PermissionModeConfig,
  root: RootIdentity,
  context: ResolutionContext,
  previous?: ResolvedCatalog,
  fallback?: ResolvedCatalog,
): ResolvedCatalog {
  assertBinding(root.binding);
  const profiles: Record<string, ResolvedProfile> = Object.create(null);
  for (const [name, mode] of Object.entries(config.modes)) {
    const prior = previous?.profiles[name];
    const base = fallback?.profiles[name];
    if (base && definition(fallback?.config.modes[name]?.filesystem) === definition(mode.filesystem)) {
      for (const grant of base.grants) assertBinding(grant.binding);
      profiles[name] = base;
      continue;
    }
    if (prior && definition(previous?.config.modes[name]?.filesystem) === definition(mode.filesystem)) {
      for (const grant of prior.grants) assertBinding(grant.binding);
      profiles[name] = prior;
      continue;
    }
    if (mode.filesystem.kind === "unrestricted") {
      profiles[name] = { kind: "unrestricted", grants: [] };
      continue;
    }
    const grants: ResourceGrant[] = automaticResources(mode.filesystem.resourceReads, context).map((resource) => {
      const saved = prior?.grants.find((g) => g.definition === resource.definition) ?? base?.grants.find((g) => g.definition === resource.definition);
      if (saved) {
        assertBinding(saved.binding);
        return saved;
      }
      return resource;
    });
    for (const [access, values] of [
      ["read", mode.filesystem.readOnly],
      ["write", mode.filesystem.readWrite],
    ] as const) {
      for (const value of values) {
        const key = `root:${access}:${value}`;
        const saved = prior?.grants.find((g) => g.definition === key) ?? base?.grants.find((g) => g.definition === key);
        if (saved) {
          assertBinding(saved.binding);
          grants.push(saved);
          continue;
        }
        const binding = configPath(value, root, context.agentDir, context.home);
        if (!binding.missing.length && binding.identity.type !== "directory")
          throw new Error(`Profile roots must be directories: ${value}`);
        grants.push({ definition: key, binding, scope: "tree", access });
      }
    }
    profiles[name] = { kind: "scoped", grants };
  }
  const rules = config.pathRules.map((rule): ResolvedRule => {
    const key = definition(rule);
    const old = fallback?.rules.find((r) => r.definition === key) ?? previous?.rules.find((r) => r.definition === key);
    if (old) {
      assertBinding(old.binding, true);
      return old;
    }
    return {
      ...rule,
      id: randomUUID(),
      definition: key,
      binding: configPath(rule.path, root, context.agentDir, context.home),
    };
  });
  return freeze({ root, config: structuredClone(config), profiles, rules });
}

/** Repository policy is checked against the same resolved bindings later executed. */
export function tightenCatalog(
  global: ResolvedCatalog,
  raw: unknown,
  context: ResolutionContext,
  previous?: ResolvedCatalog,
): ResolvedCatalog {
  if (raw === undefined) return global;
  const overlay = raw as Record<string, unknown>;
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay))
    throw new Error("Project policy must be an object");
  if (overlay.defaultMode !== undefined || overlay.cycleOrder !== undefined)
    throw new Error("Project policy cannot select profiles");
  const config = mergeConfig(global.config, raw);
  const candidate = resolveCatalog(config, global.root, context, previous, global);
  for (const [name, p] of Object.entries(candidate.profiles)) {
    const base = global.profiles[name];
    if (!base) throw new Error("Project policy cannot add profiles");
    if (base.kind === "unrestricted") continue;
    if (p.kind === "unrestricted") throw new Error("Project policy cannot remove filesystem confinement");
    for (const grant of p.grants) {
      if (
        !base.grants.some(
          (g) =>
            (g.access === "write" || grant.access === "read") &&
            (g.scope === "tree" || grant.scope === "file") &&
            contains(g.binding, grant.binding, g.scope),
        )
      )
        throw new Error(`Project policy widens ${name}: ${grant.binding.lexical}`);
    }
  }
  for (const rule of global.rules) {
    if (
      !candidate.rules.some(
        (r) =>
          r.binding.canonical === rule.binding.canonical &&
          r.binding.lexical === rule.binding.lexical &&
          r.scope === rule.scope &&
          (!rule.read || r.read === "deny" || r.read === rule.read) &&
          (!rule.write || r.write === "deny" || r.write === rule.write),
      )
    )
      throw new Error("Project policy cannot remove global path rules");
  }
  const before = global.config.network;
  const after = config.network;
  if (
    (before.default === "restricted" && after.default === "open") ||
    after.allowedDomains.some((d) => !before.allowedDomains.includes(d)) ||
    before.deniedDomains.some((d) => !after.deniedDomains.includes(d))
  )
    throw new Error("Project policy cannot widen network access");
  return freeze({ ...candidate, base: global });
}

export interface Decision {
  action: "allow" | "ask" | "deny";
  directory: boolean;
  exceptions: { rule: ResolvedRule; access: Access }[];
}

export function ruleMatches(rule: ResolvedRule, target: PathBinding): boolean {
  return (
    contains(rule.binding, target, rule.scope) ||
    (rule.scope === "file" ? rule.binding.lexical === target.lexical : within(rule.binding.lexical, target.lexical))
  );
}

/** Write authority includes read authority; every independent ask needs its own exception. */
export function decide(snapshot: FilesystemSnapshot, target: PathBinding, access: Access): Decision {
  assertBinding(snapshot.root.binding);
  if (snapshot.profile.kind === "unrestricted") return { action: "allow", directory: false, exceptions: [] };
  assertNativeSemantics(target);
  const grants: ResourceGrant[] = [
    ...snapshot.profile.grants,
    ...snapshot.grants.map((g): ResourceGrant => ({ ...g, scope: "tree" })),
  ];
  const directory = !grants.some((grant) => {
    if (access === "write" && grant.access !== "write") return false;
    if (!contains(grant.binding, target, grant.scope)) return false;
    assertBinding(grant.binding);
    return true;
  });
  const exceptions: Decision["exceptions"] = [];
  for (const rule of snapshot.rules) {
    assertBinding(rule.binding, true);
    assertNativeSemantics(rule.binding);
    if (!ruleMatches(rule, target)) continue;
    for (const operation of access === "write" ? (["read", "write"] as const) : (["read"] as const)) {
      if (rule[operation] === "deny") return { action: "deny", directory, exceptions: [] };
      if (rule[operation] === "ask" && !snapshot.exceptions.some((e) => e.ruleId === rule.id && e.access === operation))
        exceptions.push({ rule, access: operation });
    }
  }
  return { action: directory || exceptions.length ? "ask" : "allow", directory, exceptions };
}

export function validateCatalog(catalog: ResolvedCatalog): void {
  if (catalog.base) {
    if (catalog.base.base || JSON.stringify(catalog.base.root) !== JSON.stringify(catalog.root)) throw new Error("Invalid frozen global catalog");
    validateCatalog(catalog.base);
  }
  assertBinding(catalog.root.binding);
  for (const profile of Object.values(catalog.profiles))
    for (const grant of profile.grants) assertBinding(grant.binding);
  for (const rule of catalog.rules)
    if (!revalidate(rule.binding, true)) throw new Error(`Rule identity changed: ${rule.binding.lexical}`);
}
