import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { parseConfig } from "./config-load.ts";
import { NetworkSession } from "./network.ts";
import { assertBinding, bindPath, configLocation, resolvePermissionBinding } from "./paths.ts";
import { freeze, isRuntimeResource, resolveCatalog, survivingRules, type ResolutionContext } from "./policy.ts";
import type { AccessGrant, NetworkSnapshot, PathBinding, PermissionBinding, PermissionModeConfig, ResolvedCatalog, RuleException } from "./schema.ts";

export const STATE_FILE = "state-v4.json";
/** Only explicit reset may touch this unsupported authority document. */
export const LEGACY_STATE_FILE = "state-v3.json";

export interface SessionBinding { id: string; file: string; cwd: string }
export interface SavedState {
  binding: SessionBinding;
  catalog: ResolvedCatalog;
  mode: string;
  grants: AccessGrant[];
  exceptions: RuleException[];
  network: NetworkSnapshot;
  generation: number;
}
interface ProjectState { generation: number; grants: AccessGrant[]; exceptions: RuleException[]; catalog?: ResolvedCatalog }
interface Document { version: 4; sessions: Record<string, SavedState>; projects: Record<string, ProjectState> }

/** Runtime identities are rediscovered; private authority persists validated names instead. */
function key(value: unknown, context?: ResolutionContext): string {
  return JSON.stringify(value, (field, item) => {
    if (field === "worktreeGrants") return undefined;
    if (field === "identity" && item && typeof item.type === "string") return { type: item.type };
    if (field === "grants" && Array.isArray(item))
      return item.filter((grant) => !grant?.runtime && !(context && typeof grant?.definition === "string" && isRuntimeResource(grant, context)));
    return item;
  });
}
function secureFile(file: string, directory: boolean): void {
  const st = lstatSync(file);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) || (process.getuid && st.uid !== process.getuid()) || st.mode & 0o077)
    throw new Error(`Permission state must be private and owned by this user: ${file}`);
}
function shape(value: unknown, required: string[], optional: string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some((field) => !Object.hasOwn(value, field)) || Object.keys(value).some((field) => !required.includes(field) && !optional.includes(field)))
    throw new Error("Invalid saved permission state shape");
}
function generation(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid saved generation");
}
function savedBinding(binding: PathBinding, restore = true): void {
  shape(binding, ["lexical", "canonical", "prefix", "identity", "missing"]);
  shape(binding.identity, ["type"]);
  if ([binding.lexical, binding.canonical, binding.prefix].some((p) => typeof p !== "string" || p.includes("\0") || !path.isAbsolute(p)) ||
    !Array.isArray(binding.missing) || binding.missing.some((p) => typeof p !== "string" || !p || p === "." || p === ".." || p.includes(path.sep) || p.includes("\0")) ||
    binding.canonical !== path.join(binding.prefix, ...binding.missing) || !["file", "directory", "symlink", "other"].includes(binding.identity.type))
    throw new Error("Invalid saved path binding");
  if (restore) {
    const current = bindPath(binding.lexical);
    if (current.canonical !== binding.canonical || (!binding.missing.length && current.identity.type !== binding.identity.type))
      throw new Error(`Saved path target changed: ${binding.lexical}`);
    Object.assign(binding, current);
    assertBinding(binding);
  }
}
function savedPermissionBinding(binding: PermissionBinding, scope: string, restore = true): void {
  if (scope === "tree") { savedBinding(binding as PathBinding, restore); return; }
  if (scope !== "file") throw new Error("Invalid saved permission scope");
  shape(binding, ["lexical", "canonical", "parent"]);
  if (!("parent" in binding)) throw new Error("Invalid saved file permission");
  savedBinding(binding.parent, restore);
  if ([binding.lexical, binding.canonical].some((p) => typeof p !== "string" || p.includes("\0") || !path.isAbsolute(p)) ||
    binding.parent.canonical !== path.dirname(binding.canonical) || binding.parent.lexical !== binding.parent.canonical || binding.parent.identity.type !== "directory")
    throw new Error("Invalid saved file permission anchor");
}

/** Validate cache shape without opening obsolete targets; only current policy supplies authority. */
function savedCatalog(catalog: ResolvedCatalog, cwd: string, context: ResolutionContext, current?: PermissionModeConfig): ResolvedCatalog {
  shape(catalog, ["root", "config", "profiles", "rules"]);
  shape(catalog.root, ["family", "binding"]);
  savedBinding(catalog.root.binding);
  if (typeof catalog.root.family !== "string" || !catalog.root.family || catalog.root.binding.canonical !== cwd || catalog.root.binding.identity.type !== "directory" || catalog.root.binding.missing.length)
    throw new Error("Saved catalog starting root mismatch");
  const config = parseConfig(catalog.config);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(config)), catalog.config)) throw new Error("Saved catalog configuration is not canonical");
  shape(catalog.profiles, Object.keys(config.modes));
  for (const [name, profile] of Object.entries(catalog.profiles)) {
    shape(profile, ["kind", "grants"]);
    const definition = config.modes[name]!.filesystem;
    if (profile.kind !== definition.kind || !Array.isArray(profile.grants) || (definition.kind === "unrestricted" && profile.grants.length)) throw new Error("Invalid saved profile grants");
    for (const grant of profile.grants) {
      shape(grant, ["definition", "binding", "scope", "access"]);
      savedPermissionBinding(grant.binding, grant.scope, false);
      if (definition.kind !== "scoped" || (grant.access !== "read" && grant.access !== "write") || typeof grant.definition !== "string" ||
        (grant.definition.startsWith("resource:") ? grant.access !== "read" || !definition.resourceReads.length :
          grant.scope !== "tree" || !(grant.access === "write" ? definition.readWrite : definition.readOnly).some((p) => grant.definition === `root:${grant.access}:${p}`)))
        throw new Error("Saved profile is incompatible with its configuration");
    }
  }
  if (!Array.isArray(catalog.rules) || catalog.rules.length !== config.pathRules.length) throw new Error("Invalid saved path rules");
  const ids = new Set<string>();
  for (const [index, rule] of catalog.rules.entries()) {
    shape(rule, ["id", "definition", "path", "scope"], ["binding", "blocked", "read", "write"]);
    if (rule.binding) savedPermissionBinding(rule.binding, rule.scope, false);
    else if (typeof rule.blocked !== "string" || rule.read === "deny" || rule.read === "ask" || rule.write === "deny" || rule.write === "ask") throw new Error("Invalid unbound saved rule");
    const declaration = config.pathRules[index]!;
    if (typeof rule.id !== "string" || !rule.id || ids.has(rule.id) || rule.definition !== JSON.stringify(declaration) ||
      rule.path !== declaration.path || rule.scope !== declaration.scope || rule.read !== declaration.read || rule.write !== declaration.write)
      throw new Error("Saved path rule is incompatible with its configuration");
    ids.add(rule.id);
  }
  const expected = resolveCatalog(current ?? config, catalog.root, context);
  for (const [name, profile] of Object.entries(expected.profiles)) {
    for (const grant of profile.grants) {
      if (grant.runtime) continue;
      const old = catalog.profiles[name]?.grants.find((g) => g.definition === grant.definition);
      if (!old) continue;
      savedPermissionBinding(old.binding, old.scope);
      if (old.scope !== grant.scope || old.access !== grant.access || old.binding.canonical !== grant.binding.canonical || old.binding.lexical !== grant.binding.lexical)
        throw new Error("Saved profile target changed");
      resolvePermissionBinding(old.binding);
    }
  }
  const survivors = survivingRules(expected.config.pathRules, catalog.rules, expected.rules.map((rule) => rule.binding?.lexical));
  const rules = expected.rules.map((rule, index) => {
    const old = survivors[index];
    const negative = rule.read === "deny" || rule.read === "ask" || rule.write === "deny" || rule.write === "ask";
    if (!old) return rule;
    if (!old.binding) return { ...old, id: old.id };
    try {
      savedPermissionBinding(old.binding, old.scope);
      if (rule.binding && (old.binding.canonical !== rule.binding.canonical || old.binding.lexical !== rule.binding.lexical)) throw new Error("Saved path rule target changed");
      if (negative) resolvePermissionBinding(old.binding, true);
      return { ...rule, id: old.id, binding: old.binding };
    } catch (error) {
      if (negative) throw error;
      return { ...rule, id: old.id, binding: undefined, blocked: String(error) };
    }
  });
  return freeze({ ...expected, rules });
}
function validateRecords(grants: AccessGrant[], exceptions: RuleException[], catalog?: ResolvedCatalog, project = false): void {
  if (!Array.isArray(grants) || !Array.isArray(exceptions)) throw new Error("Malformed permission records");
  const ids = new Set<string>();
  for (const record of [...grants, ...exceptions]) {
    shape(record, ["id", "access", "lifetime", ...(grants.includes(record as AccessGrant) ? ["binding"] : ["ruleId"])]);
    if (typeof record.id !== "string" || !record.id || ids.has(record.id) || !["read", "write"].includes(record.access) || !["session", "project"].includes(record.lifetime) || (project && record.lifetime !== "project")) throw new Error("Malformed permission record");
    ids.add(record.id);
    if ("binding" in record) {
      const file = "parent" in record.binding;
      savedPermissionBinding(record.binding, file ? "file" : "tree");
      const binding = resolvePermissionBinding(record.binding);
      if (binding.identity.type !== (file ? "file" : "directory") || binding.missing.length) throw new Error("Invalid saved access grant");
    } else if (typeof record.ruleId !== "string" || !catalog?.rules.some((rule) => rule.id === record.ruleId && rule[record.access] === "ask")) throw new Error("Invalid saved rule exception");
  }
}

/** A whole-document lock prevents stale sessions from resurrecting private project grants. */
export class PermissionStore {
  readonly directory: string;
  private sessionGeneration = 0;
  private projectGeneration = 0;
  private binding?: SessionBinding;
  private context?: ResolutionContext;

  constructor(agentDir: string) {
    const parent = bindPath(configLocation(agentDir));
    this.directory = path.join(parent.canonical, "permission-mode");
    if (parent.missing.length || parent.lexical !== parent.canonical) throw new Error("Permission agent directory must exist without symlink redirection");
    try { mkdirSync(this.directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    secureFile(this.directory, true);
  }
  private transaction<T>(operation: (document: Document) => { result: T; write?: boolean }, signal?: AbortSignal): T {
    const lock = path.join(this.directory, ".authority.lock");
    let fd: number;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new Error(`Permission state is locked or unsafe: ${lock}. Stop other writers and verify an orphan before manual recovery.`); }
    const file = path.join(this.directory, STATE_FILE);
    let temporary: string | undefined;
    try {
      signal?.throwIfAborted();
      secureFile(this.directory, true);
      let document: Document = { version: 4, sessions: {}, projects: {} };
      try {
        secureFile(file, false);
        document = JSON.parse(readFileSync(file, "utf8")) as Document;
        shape(document, ["version", "sessions", "projects"]);
        if (document.version !== 4 || !document.sessions || typeof document.sessions !== "object" || Array.isArray(document.sessions) || !document.projects || typeof document.projects !== "object" || Array.isArray(document.projects))
          throw new Error("Unsupported or malformed permission state; explicitly run /perm reset");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { lstatSync(path.join(this.directory, LEGACY_STATE_FILE)); }
        catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") throw legacyError; }
        if (bindPath(path.join(this.directory, LEGACY_STATE_FILE)).missing.length === 0)
          throw new Error("Unsupported legacy permission state; explicitly run /perm reset. Approvals are not migrated.");
      }
      const outcome = operation(document);
      signal?.throwIfAborted();
      if (outcome.write) {
        temporary = path.join(this.directory, `.state-${randomUUID()}.tmp`);
        const out = openSync(temporary, "wx", 0o600);
        try { writeFileSync(out, `${key(document, this.context)}\n`); fsyncSync(out); } finally { closeSync(out); }
        signal?.throwIfAborted();
        renameSync(temporary, file);
        temporary = undefined;
        try {
          const dir = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
          try { fsyncSync(dir); } finally { closeSync(dir); }
        } catch { /* Atomic rename committed; a directory-flush failure cannot roll it back. */ }
      }
      return outcome.result;
    } finally {
      if (temporary) { try { unlinkSync(temporary); } catch {} }
      try {
        const held = fstatSync(fd); closeSync(fd);
        const current = lstatSync(lock);
        if (held.dev === current.dev && held.ino === current.ino) unlinkSync(lock);
      } catch { try { closeSync(fd); } catch {} }
    }
  }

  load(binding: SessionBinding | undefined, cwd: string, context: ResolutionContext = { agentDir: path.dirname(this.directory), home: homedir() }, current?: PermissionModeConfig): { session?: SavedState; project: ProjectState } {
    this.binding = binding;
    this.context = { ...context, macExecutableFilesCache: undefined };
    return this.transaction((document) => {
      const project = document.projects[key(cwd)] ?? { generation: 0, grants: [], exceptions: [] };
      shape(project, ["generation", "grants", "exceptions"], ["catalog"]);
      if (Object.hasOwn(project, "catalog") && !project.catalog) throw new Error("Invalid saved project catalog");
      if (!project.catalog && (project.generation !== 0 || project.grants?.length || project.exceptions?.length)) throw new Error("Saved project authority needs its frozen catalog");
      const projectCatalog = project.catalog ? savedCatalog(project.catalog, cwd, context, current) : undefined;
      validateRecords(project.grants, project.exceptions, project.catalog, true);
      if (projectCatalog) {
        project.exceptions = project.exceptions.filter((e) => projectCatalog.rules.some((r) => r.id === e.ruleId && r[e.access] === "ask"));
        project.catalog = projectCatalog;
      }
      generation(project.generation);
      this.projectGeneration = project.generation;
      const session = binding ? document.sessions[key(binding.id)] : undefined;
      if (session) {
        shape(session, ["binding", "catalog", "mode", "grants", "exceptions", "network", "generation"]);
        shape(session.binding, ["id", "file", "cwd"]);
        if (key(session.binding) !== key(binding)) throw new Error("Session permission binding mismatch: ID, session file, and starting cwd must all match");
        const catalog = savedCatalog(session.catalog, cwd, context, current);
        if (typeof session.mode !== "string" || !Object.hasOwn(session.catalog.profiles, session.mode)) throw new Error("Invalid saved session mode");
        validateRecords(session.grants, session.exceptions, session.catalog);
        shape(session.network, ["revision", "restricted", "allowedDomains", "deniedDomains"]);
        new NetworkSession(session.catalog.config.network, () => {}, session.network);
        if (!catalog.profiles[session.mode]) throw new Error("Invalid saved session authority");
        generation(session.generation);
        // Project receipts and older session caches must name the same current declaration.
        const ruleIds = new Map<string, string>();
        const rules = catalog.rules.map((rule) => {
          const shared = projectCatalog?.rules.find((r) => r.definition === rule.definition && r.binding?.canonical === rule.binding?.canonical);
          ruleIds.set(rule.id, shared?.id ?? rule.id);
          return shared ? { ...rule, id: shared.id } : rule;
        });
        session.exceptions = session.exceptions.filter((e) => catalog.rules.some((r) => r.id === e.ruleId && r[e.access] === "ask"))
          .map((e) => ({ ...e, ruleId: ruleIds.get(e.ruleId)! }));
        if (!isDeepStrictEqual(session.catalog.config.network, catalog.config.network))
          session.network = new NetworkSession(catalog.config.network, () => {}).snapshot();
        session.catalog = freeze({ ...catalog, rules });
        this.sessionGeneration = session.generation;
      }
      return { result: { session, project } };
    });
  }
  save(state: Omit<SavedState, "binding" | "generation">, cwd: string, signal?: AbortSignal): void {
    const generations = this.transaction((document) => {
      const projectKey = key(cwd);
      const project = document.projects[projectKey];
      const sessionKey = this.binding ? key(this.binding.id) : undefined;
      const current = sessionKey ? document.sessions[sessionKey] : undefined;
      if ((project?.generation ?? 0) !== this.projectGeneration || (current?.generation ?? 0) !== this.sessionGeneration)
        throw new Error("Permission state changed in another session; reload before changing authority");
      const projectGrants = state.grants.filter((g) => g.lifetime === "project");
      const projectExceptions = state.exceptions.filter((e) => e.lifetime === "project");
      const changed = key(projectGrants) !== key(project?.grants ?? []) || key(projectExceptions) !== key(project?.exceptions ?? []);
      document.projects[projectKey] = { generation: this.projectGeneration + Number(changed), grants: projectGrants, exceptions: projectExceptions, catalog: state.catalog };
      if (sessionKey && this.binding) document.sessions[sessionKey] = { ...state, binding: this.binding, generation: this.sessionGeneration + 1 };
      return { result: { session: this.sessionGeneration + Number(!!sessionKey), project: this.projectGeneration + Number(changed) }, write: !!sessionKey || changed };
    }, signal);
    this.sessionGeneration = generations.session;
    this.projectGeneration = generations.project;
  }
}
