import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { macExecutableFiles } from "./macos.ts";
import { assertBinding, bindFile, bindPath, configPath, resolvePermissionBinding, within } from "./paths.ts";
import type {
  PermissionModeConfig,
  PathRule,
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
    "/Library/Developer/CommandLineTools",
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
  const scope = binding.identity.type === "directory" ? "tree" : "file";
  return {
    definition: `resource:${value}`,
    binding: scope === "file" ? bindFile(binding) : binding,
    scope,
    access: "read",
  };
}

/** Agent data remains a durable boundary even though its read access is automatic. */
export function isRuntimeResource(grant: ResourceGrant, context: ResolutionContext): boolean {
  return !!grant.definition?.startsWith("resource:") &&
    grant.definition !== `resource:${path.join(context.home, ".pi")}` &&
    grant.definition !== `resource:${context.agentDir}`;
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
    if (process.platform === "darwin") {
      paths.push(...macExecutableFiles(node));
      for (const brew of ["/opt/homebrew", "/usr/local"]) {
        if (within(brew, node)) paths.push(path.join(brew, "etc/openssl@3/openssl.cnf"), path.join(brew, "etc/ca-certificates/cert.pem"));
      }
    }
    for (const name of ["npm", "corepack"]) {
      paths.push(path.join(prefix, "lib", "node_modules", name));
    }
    for (const launcher of ["npm", "npx", "corepack"]) {
      const file = path.join(prefix, "bin", launcher);
      paths.push(file);
      // Homebrew keeps npm outside the Node keg; follow only the exact launcher-owning package.
      if (process.platform === "darwin" && existsSync(file)) {
        const packageRoot = path.dirname(path.dirname(bindPath(file).canonical));
        const manifest = path.join(packageRoot, "package.json");
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === (launcher === "corepack" ? "corepack" : "npm"))
          paths.push(packageRoot);
      }
    }
  }
  return paths.map(resource).filter((r): r is ResourceGrant => !!r).map((grant) => {
    if (isRuntimeResource(grant, context)) grant.runtime = true;
    return grant;
  });
}

export { decide, positiveTarget, type Decision } from "./evaluation.ts";

function definition(value: unknown): string {
  return JSON.stringify(value);
}

/** Source reservation must precede alias matching so new asks cannot borrow an old receipt. */
export function survivingRules(current: PathRule[], previous: ResolvedRule[], lexicals: (string | undefined)[]): (ResolvedRule | undefined)[] {
  const signature = (r: PathRule) => JSON.stringify([r.path, r.scope, r.read, r.write]);
  const sources: (ResolvedRule | undefined)[] = current.map(() => undefined);
  const used = new Set<string>();
  const compatible = (rule: PathRule, old: ResolvedRule) =>
    (rule.read === "ask" || rule.read === "deny" || rule.write === "ask" || rule.write === "deny") && rule.scope === old.scope &&
    (["read", "write"] as const).every((access) => old[access] === rule[access] ||
      ((old[access] === "allow" || old[access] === undefined) && (rule[access] === "allow" || rule[access] === undefined)));
  const reserve = (matches: (rule: PathRule, old: ResolvedRule, index: number) => boolean) => {
    const candidates = current.map((rule, index) => sources[index] ? [] : previous.filter((old) => !used.has(old.id) && matches(rule, old, index)));
    const claims = new Map<string, number>();
    for (const options of candidates) for (const source of options) claims.set(source.id, (claims.get(source.id) ?? 0) + 1);
    for (const [index, options] of candidates.entries()) {
      if (options.length > 1 || options.some((source) => claims.get(source.id)! > 1)) throw new Error(`Ambiguous surviving restrictive declaration: ${current[index]!.path}`);
      const source = options[0];
      if (source) { sources[index] = source; used.add(source.id); }
    }
  };
  reserve((rule, old) => signature(rule) === signature(old));
  reserve((rule, old) => rule.path === old.path && compatible(rule, old));
  reserve((rule, old, index) => compatible(rule, old) && lexicals[index] !== undefined &&
    (old.binding?.lexical === lexicals[index] || old.binding?.canonical === lexicals[index]));
  return sources.map((source, index) => {
    const lexical = lexicals[index];
    // Canonicalization drops an obsolete alias, not its validated destination or pins.
    return source && source.path !== current[index]!.path && source.binding && lexical
      ? { ...source, binding: { ...source.binding, lexical } }
      : source;
  });
}

export function resolveCatalog(
  config: PermissionModeConfig,
  root: RootIdentity,
  context: ResolutionContext,
  previous?: ResolvedCatalog,
): ResolvedCatalog {
  assertBinding(root.binding);
  const profiles: Record<string, ResolvedProfile> = Object.create(null);
  for (const [name, mode] of Object.entries(config.modes)) {
    const prior = previous?.profiles[name];
    const unchanged = prior && definition(previous?.config.modes[name]?.filesystem) === definition(mode.filesystem) ? prior : undefined;
    for (const grant of unchanged?.grants ?? [])
      if (!grant.runtime) resolvePermissionBinding(grant.binding);
    if (mode.filesystem.kind === "unrestricted") {
      profiles[name] = { kind: "unrestricted", grants: [] };
      continue;
    }
    const grants: ResourceGrant[] = automaticResources(mode.filesystem.resourceReads, context).map((resource) => {
      const saved = prior?.grants.find((g) => g.definition === resource.definition);
      if (saved && !resource.runtime) {
        resolvePermissionBinding(saved.binding);
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
        const saved = prior?.grants.find((g) => g.definition === key);
        if (saved) {
          resolvePermissionBinding(saved.binding);
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
  const survivors = previous && survivingRules(config.pathRules, previous.rules, config.pathRules.map((rule) =>
    rule.read === "ask" || rule.read === "deny" || rule.write === "ask" || rule.write === "deny" ? configPath(rule.path, root, context.agentDir, context.home).lexical : undefined));
  const rules = config.pathRules.map((rule, index): ResolvedRule => {
    const key = definition(rule);
    const negative = rule.read === "ask" || rule.read === "deny" || rule.write === "ask" || rule.write === "deny";
    const old = survivors?.[index];
    if (old) {
      if (negative) {
        if (!old.binding) throw new Error(`Restriction has no validated target: ${rule.path}`);
        resolvePermissionBinding(old.binding, true);
      }
      return old.definition === key ? old : { ...old, ...rule, read: rule.read, write: rule.write, definition: key };
    }
    try {
      const binding = configPath(rule.path, root, context.agentDir, context.home);
      if (negative && !binding.missing.length && binding.identity.type !== (rule.scope === "file" ? "file" : "directory"))
        throw new Error(`Restriction target type does not match scope: ${rule.path}`);
      return { ...rule, id: randomUUID(), definition: key, binding: rule.scope === "file" ? bindFile(binding) : binding };
    } catch (error) {
      if (negative) throw error;
      return { ...rule, id: randomUUID(), definition: key, blocked: String(error) };
    }
  });
  return freeze({ root, config: structuredClone(config), profiles, rules });
}

export function validateCatalog(catalog: ResolvedCatalog): void {
  assertBinding(catalog.root.binding);
  for (const profile of Object.values(catalog.profiles))
    for (const grant of profile.grants) resolvePermissionBinding(grant.binding);
  for (const rule of catalog.rules)
    if (rule.read === "ask" || rule.read === "deny" || rule.write === "ask" || rule.write === "deny") {
      if (!rule.binding) throw new Error(`Restriction has no validated target: ${rule.path}`);
      resolvePermissionBinding(rule.binding, true);
    }
}
