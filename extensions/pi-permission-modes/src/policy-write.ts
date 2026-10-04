import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defaultConfig, mergeConfig } from "./config-load.ts";
import { assertBinding, bindPath, configLocation, configPath, contains, identity, resolvePermissionBinding, sameIdentity } from "./paths.ts";
import { decide, positiveTarget, resolveCatalog, type ResolutionContext } from "./policy.ts";
import type { Access, FileIdentity, FilesystemSnapshot, PathRule, PermissionBinding, ResolvedCatalog } from "./schema.ts";

export type GlobalMutation = { kind: "save"; binding: PermissionBinding; access: Access; scope: "file" | "tree" } | { kind: "revoke"; id: string } | { kind: "clear" };
export interface GlobalPreview { title: string; message: string }
interface FileVersion { bytes?: string; identity?: FileIdentity }
export interface PreparedPolicy {
  version: FileVersion;
  revision: number;
  catalog: ResolvedCatalog;
  document: Record<string, unknown>;
  mutation: GlobalMutation;
  ruleIds: Map<string, string>;
  preview: GlobalPreview;
}

/** Configuration is authoritative at rename; private session persistence is a subsequent cache write. */
export class GlobalPolicyWriter {
  readonly file: string;
  private readonly directory: ReturnType<typeof bindPath>;
  private readonly context: ResolutionContext;

  constructor(context: ResolutionContext) {
    this.context = context;
    this.directory = bindPath(configLocation(path.join(context.agentDir, "permission-mode")));
    this.file = path.join(this.directory.canonical, "permission-mode.json");
    this.checkDirectory();
  }
  private checkDirectory(): void {
    assertBinding(this.directory);
    const st = lstatSync(this.directory.canonical);
    if (this.directory.missing.length || this.directory.lexical !== this.directory.canonical || !st.isDirectory() || st.mode & 0o077 || (process.getuid && st.uid !== process.getuid()))
      throw new Error("Global policy directory must be private, user-owned and nonsymlinked");
  }
  private capture(): FileVersion {
    this.checkDirectory();
    let fd: number;
    try { fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.mode & 0o077 || (process.getuid && st.uid !== process.getuid())) throw new Error("Global policy must be a private user-owned regular file");
      const pinned = identity(fd);
      const bytes = readFileSync(fd, "utf8");
      if (!sameIdentity(identity(this.file), pinned)) throw new Error("Global policy changed while being read");
      this.checkDirectory();
      return { bytes, identity: pinned };
    } finally { closeSync(fd); }
  }
  prepare(current: ResolvedCatalog, revision: number, mutation: GlobalMutation): PreparedPolicy {
    const version = this.capture();
    const defaults = defaultConfig(this.context.agentDir, this.context.home);
    const raw = version.bytes === undefined ? { version: 3, pathRules: current.config.pathRules } : JSON.parse(version.bytes);
    const effective = version.bytes === undefined ? defaults : mergeConfig(defaults, raw);
    if (!isDeepStrictEqual(structuredClone(effective), current.config)) throw new Error("Trusted policy changed; reload before changing global permissions");
    const document = structuredClone(raw) as Record<string, unknown>;
    const rules = effective.pathRules.map((rule) => ({ ...rule }));
    const signatures: string[] = [];
    const successors = new Map<string, PathRule>();
    const rebind = new Set<string>();
    let message: string;
    if (mutation.kind === "save") {
      const target = resolvePermissionBinding(mutation.binding);
      if (target.missing.length || target.identity.type !== (mutation.scope === "file" ? "file" : "directory")) throw new Error("Global permissions need a valid existing positive target");
      const bare: FilesystemSnapshot = { revision, root: current.root, mode: effective.defaultMode, profile: { kind: "scoped", grants: [] }, rules: current.rules, grants: [], exceptions: [] };
      const decision = decide(bare, target, mutation.access, mutation);
      if (decision.action !== "allow") {
        const blockers = decision.exceptions.length ? decision.exceptions.map((e) => e.rule.path) : current.rules.filter((r) => r.binding && contains(r.binding, target, r.scope) && (r.read === "deny" || r.write === "deny")).map((r) => r.path);
        throw new Error(`Global permission remains ${decision.action}: ${blockers.join(", ") || target.lexical}. Edit the restrictive rule manually.`);
      }
      const matching = current.rules.filter((r) => {
        if (r.scope !== mutation.scope) return false;
        if (r.binding?.canonical === target.canonical) return true;
        if (positiveTarget(r.binding, r.scope).state !== "blocked") return false;
        try { return configPath(r.path, current.root, this.context.agentDir, this.context.home).canonical === target.canonical; }
        catch { return false; }
      });
      for (const source of matching) {
        if (mutation.access === "read" && source.write === "allow" && positiveTarget(source.binding, source.scope).state !== "active")
          throw new Error("Blocked write authority requires explicit R/W reauthorization; an R/O save cannot restore it");
        if (source.read === "ask" || source.read === "deny" || source.write === "ask" || source.write === "deny") {
          if (!source.binding) throw new Error(`Surviving restriction has no validated binding: ${source.path}`);
          resolvePermissionBinding(source.binding, true);
        }
        rebind.add(source.id);
      }
      if (matching.length > 1 && matching.some((r) => r.read === "ask" || r.read === "deny" || r.write === "ask" || r.write === "deny"))
        throw new Error("Independent restrictive declarations cannot be consolidated; edit policy manually");
      const inherited: Pick<PathRule, "read" | "write"> = {};
      for (const access of ["read", "write"] as const) {
        const values = new Set(matching.map((r) => r[access]).filter((value) => value !== undefined));
        if (values.size > 1) throw new Error("Conflicting declarations at this boundary; edit policy manually");
        inherited[access] = values.values().next().value;
      }
      signatures.push(...matching.map((r) => r.definition));
      const index = matching.length ? rules.findIndex((r) => signatures.includes(JSON.stringify(r))) : rules.length;
      if (index < 0) throw new Error("Global declaration is stale; reload before saving");
      const replacement: PathRule = { ...inherited, path: target.canonical, scope: mutation.scope, read: "allow", ...(mutation.access === "write" ? { write: "allow" } : {}) };
      for (const source of matching) successors.set(source.id, replacement);
      const retained = rules.filter((r) => !signatures.includes(JSON.stringify(r)));
      retained.splice(index, 0, replacement);
      rules.splice(0, rules.length, ...retained);
      message = `${mutation.access === "write" ? "R/W" : "R/O"} ${target.canonical} (${mutation.scope}). Applies to all scoped profiles and projects. A tree grant covers the displayed directory, not just its triggering file; more-specific restrictions remain protected.`;
    } else {
      const affected = current.rules.filter((r) => (mutation.kind === "clear" || r.id === mutation.id) && (r.read === "allow" || r.write === "allow"));
      if (mutation.kind === "revoke" && affected.length !== 1) throw new Error("Global declaration ID is stale or unavailable; reload before revoking");
      signatures.push(...affected.map((r) => r.definition));
      for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i]!;
        if (!signatures.includes(JSON.stringify(rule))) continue;
        if (rule.read === "allow") delete rule.read;
        if (rule.write === "allow") delete rule.write;
        if (!rule.read && !rule.write) rules.splice(i, 1);
        else successors.set(current.rules[i]!.id, rule);
      }
      message = `Remove all current allow fields from ${affected.length} global declaration(s):\n${affected.map((r) => `global:${r.id}: ${r.path} (${r.scope})`).join("\n")}\nAsk/deny fields, ordinary approvals, profiles, networking and process mode remain unchanged.`;
    }
    document.pathRules = rules;
    const config = mergeConfig(defaults, document);
    // Rebinding is explicit only for the approved save target; other declarations retain their pins.
    const previous = mutation.kind === "save" ? { ...current, rules: current.rules.filter((r) => !rebind.has(r.id)) } : {
      ...current,
      rules: current.rules.map((source) => {
        const successor = successors.get(source.id);
        const next = successor && config.pathRules.find((r) => r.path === successor.path && r.scope === successor.scope && r.read === successor.read && r.write === successor.write);
        if (!next) return source;
        // Removing an allow is not consent to move an independent restrictive boundary.
        if (!source.binding) throw new Error(`Surviving restriction has no validated binding: ${source.path}`);
        resolvePermissionBinding(source.binding, true);
        return { ...source, ...next, read: next.read, write: next.write, id: randomUUID(), definition: JSON.stringify(next) };
      }),
    };
    const catalog = resolveCatalog(config, current.root, this.context, previous);
    const ruleIds = new Map<string, string>();
    for (const [id, successor] of successors) {
      const next = catalog.rules.find((r) => r.path === successor.path && r.scope === successor.scope && r.read === successor.read && r.write === successor.write)!;
      ruleIds.set(id, next.id);
    }
    return { version, revision, catalog, document, mutation, ruleIds, preview: { title: mutation.kind === "save" ? "Save global filesystem permission?" : "Remove global filesystem permissions?", message } };
  }
  commit(prepared: PreparedPolicy, checkRevision: (revision: number) => void, signal?: AbortSignal): ResolvedCatalog {
    this.checkDirectory();
    const lock = path.join(this.directory.canonical, ".authority.lock");
    let fd: number;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new Error("Permission authority is locked or unsafe; reload/retry after verifying other writers"); }
    let temporary: string | undefined;
    try {
      signal?.throwIfAborted();
      checkRevision(prepared.revision);
      const current = this.capture();
      if (current.bytes !== prepared.version.bytes || (current.identity && prepared.version.identity ? !sameIdentity(current.identity, prepared.version.identity) : !!current.identity !== !!prepared.version.identity)) throw new Error("Global policy changed during confirmation; reload and confirm again");
      if (prepared.mutation.kind === "save") {
        const target = resolvePermissionBinding(prepared.mutation.binding);
        if (target.missing.length || target.identity.type !== (prepared.mutation.scope === "file" ? "file" : "directory")) throw new Error("Global positive target changed during confirmation");
      }
      const catalog = resolveCatalog(prepared.catalog.config, prepared.catalog.root, this.context, prepared.catalog);
      temporary = path.join(this.directory.canonical, `.policy-${randomUUID()}.tmp`);
      const out = openSync(temporary, "wx", 0o600);
      try { writeFileSync(out, `${JSON.stringify(prepared.document, null, 2)}\n`); fsyncSync(out); } finally { closeSync(out); }
      signal?.throwIfAborted();
      checkRevision(prepared.revision);
      this.checkDirectory();
      const last = this.capture();
      if (last.bytes !== current.bytes || (last.identity && current.identity ? !sameIdentity(last.identity, current.identity) : !!last.identity !== !!current.identity)) throw new Error("Global policy changed before commit");
      renameSync(temporary, this.file);
      temporary = undefined;
      try {
        const directory = openSync(this.directory.canonical, constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } catch { /* The policy rename has committed; a flush failure cannot reverse it. */ }
      return catalog;
    } finally {
      if (temporary) { try { unlinkSync(temporary); } catch {} }
      try {
        const held = identity(fd); closeSync(fd);
        if (sameIdentity(held, identity(lock))) unlinkSync(lock);
      } catch { try { closeSync(fd); } catch {} }
    }
  }
}
