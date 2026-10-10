import { randomUUID } from "node:crypto";
import { mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import { ApprovalQueue, type ApprovalTask } from "./approval-queue.ts";
import { NetworkSession, type NetAsk } from "./network.ts";
import { assertBinding, bindFile, bindPath, resolvePermissionBinding, revalidate, within } from "./paths.ts";
import { decide, freeze, resolveCatalog, type ResolutionContext } from "./policy.ts";
import type { PermissionStore, SavedState } from "./permission-state.ts";
import type { GlobalMutation, GlobalPolicyWriter, GlobalPreview } from "./policy-write.ts";
import type {
  Access,
  AccessGrant,
  FilesystemSnapshot,
  Lifetime,
  PathBinding,
  PermissionModeConfig,
  ResolvedCatalog,
  ResolvedRule,
  RuleException,
} from "./schema.ts";

export class StaleAuthorityError extends Error {}
export interface ApprovalRequest {
  kind: "directory" | "file" | "exception";
  path: string;
  access: Access;
  reason: string;
  create: boolean;
  ruleId?: string;
  scope?: "file" | "tree";
  /** UI intent only; deduplicated joins retain the first opening's intent. */
  agentWait?: boolean;
}
export type ApprovalAnswer = {
  action?: "grant";
  lifetime: Lifetime | "global";
  directory?: string;
  binding?: PathBinding;
} | {
  action: "block";
  lifetime?: never;
  directory?: string;
  binding?: PathBinding;
};
export type AskApproval = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalAnswer | undefined>;

/** The owner accepts intents, never replacement snapshots from executors or children. */
export class PermissionOwner {
  private catalog: ResolvedCatalog;
  private mode: string;
  private grants: AccessGrant[];
  private exceptions: RuleException[];
  private blocks: ResolvedRule[] = [];
  private revision = 0;
  private unavailable?: string;
  resetPending = false;
  enforcementError?: string;
  private leases = 0;
  private drained: (() => void)[] = [];
  private children = new Set<() => void>();
  readonly approvalQueue = new ApprovalQueue();
  private pending = new Map<string, ApprovalTask<PathBinding | undefined>>();
  private approvalCancellation = new AbortController();
  private readonly store?: PermissionStore;
  private readonly policyWriter?: GlobalPolicyWriter;
  private cacheStale = false;
  confirmGlobal?: (preview: GlobalPreview, signal?: AbortSignal, agentWait?: boolean) => Promise<boolean>;
  warn?: (message: string) => void;
  readonly network: NetworkSession;
  ask: AskApproval;
  askNetwork?: NetAsk;

  constructor(
    catalog: ResolvedCatalog,
    options: {
      store?: PermissionStore;
      policyWriter?: GlobalPolicyWriter;
      confirmGlobal?: (preview: GlobalPreview, signal?: AbortSignal, agentWait?: boolean) => Promise<boolean>;
      warn?: (message: string) => void;
      restored?: SavedState;
      grants?: AccessGrant[];
      exceptions?: RuleException[];
      ask: AskApproval;
      askNetwork?: NetAsk;
    },
  ) {
    this.catalog = catalog;
    this.store = options.store;
    this.policyWriter = options.policyWriter;
    this.confirmGlobal = options.confirmGlobal;
    this.warn = options.warn;
    this.mode = options.restored?.mode ?? catalog.config.defaultMode;
    this.grants = options.grants ?? options.restored?.grants ?? [];
    this.exceptions = (options.exceptions ?? options.restored?.exceptions ?? []).filter((e) =>
      catalog.rules.some((r) => r.id === e.ruleId),
    );
    this.ask = options.ask;
    this.askNetwork = options.askNetwork;
    if (!catalog.profiles[this.mode]) throw new Error(`Unknown filesystem profile: ${this.mode}`);
    const restoredNetwork =
      JSON.stringify(options.restored?.catalog.config.network) === JSON.stringify(catalog.config.network)
        ? options.restored?.network
        : undefined;
    this.network = new NetworkSession(
      catalog.config.network,
      (network) => this.persist(this.mode, this.grants, this.exceptions, network),
      restoredNetwork,
      () => !this.unavailable,
      (operation, signal) => this.approvalQueue.run(operation, signal ? AbortSignal.any([signal, this.approvalSignal]) : this.approvalSignal),
    );
    this.persist(this.mode, this.grants, this.exceptions, this.network.snapshot());
  }

  get id(): string {
    return this.catalog.root.family;
  }
  get config(): PermissionModeConfig {
    return this.catalog.config;
  }
  get reason(): string | undefined {
    return this.unavailable;
  }
  get approvalSignal(): AbortSignal {
    return this.approvalCancellation.signal;
  }
  get root(): string {
    return this.catalog.root.binding.canonical;
  }
  get rootIdentity() {
    return this.catalog.root;
  }
  get sessionBlocks(): readonly ResolvedRule[] {
    return freeze([...this.blocks]);
  }
  snapshot(): FilesystemSnapshot {
    if (this.unavailable) throw new Error(`Filesystem policy unavailable: ${this.unavailable}`);
    assertBinding(this.catalog.root.binding);
    return freeze({
      revision: this.revision,
      root: this.catalog.root,
      mode: this.mode,
      processMode: this.catalog.config.processMode ?? "compatible",
      profile: this.catalog.profiles[this.mode]!,
      rules: [...this.catalog.rules, ...this.blocks],
      grants: [...this.grants],
      exceptions: [...this.exceptions],
    });
  }

  private persist(
    mode: string,
    grants: AccessGrant[],
    exceptions: RuleException[],
    network = this.network.snapshot(),
    signal?: AbortSignal,
  ): void {
    if (this.cacheStale) throw new Error("Permission cache is stale; restart Pi before changing authority");
    this.store?.save({ catalog: this.catalog, mode, grants, exceptions, network }, this.root, signal);
  }

  check(revision: number): void {
    if (this.snapshot().revision !== revision)
      throw new StaleAuthorityError("Filesystem authority changed; reauthorize before execution");
  }

  lease(): () => void {
    this.snapshot();
    this.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.leases === 0) for (const resolve of this.drained.splice(0)) resolve();
    };
  }

  select(mode: string): void {
    this.snapshot();
    if (!this.catalog.profiles[mode])
      throw new Error(`Unknown profile ${mode}; use /perm to inspect configured profiles`);
    this.persist(mode, this.grants, this.exceptions);
    this.mode = mode;
    this.revision++;
  }

  revoke(id?: string): void {
    this.snapshot();
    if (id?.startsWith("block:")) {
      if (!this.blocks.some((block) => block.id === id)) throw new Error("Unknown or stale session block ID");
      this.blocks = this.blocks.filter((block) => block.id !== id);
    } else {
      const grants = id ? this.grants.filter((g) => g.id !== id) : [];
      const exceptions = id ? this.exceptions.filter((e) => e.id !== id) : [];
      this.persist(this.mode, grants, exceptions);
      this.grants = grants;
      this.exceptions = exceptions;
      if (!id) this.blocks = [];
    }
    this.revision++;
  }

  private warning(message: string): void {
    try { this.warn?.(message); } catch { /* Reporting cannot undo a committed policy change. */ }
  }

  async changeGlobal(mutation: GlobalMutation, signal?: AbortSignal, agentWait = true): Promise<void> {
    const cancellation = signal ? AbortSignal.any([signal, this.approvalSignal]) : this.approvalSignal;
    return this.approvalQueue.run(() => this.changeGlobalNow(mutation, cancellation, agentWait), cancellation);
  }

  private async changeGlobalNow(mutation: GlobalMutation, signal?: AbortSignal, agentWait = true): Promise<void> {
    this.snapshot();
    if (this.cacheStale) throw new Error("Permission cache is stale; restart before changing global authority");
    if (!this.policyWriter || !this.confirmGlobal) throw new Error("Global permission changes require the parent UI and trusted policy writer");
    const prepared = this.policyWriter.prepare(this.catalog, this.revision, mutation);
    if (!(await this.confirmGlobal(prepared.preview, signal, agentWait))) throw new Error("Global permission change cancelled");
    signal?.throwIfAborted();
    const catalog = this.policyWriter.commit(prepared, (revision) => this.check(revision), signal);
    const previous = this.catalog;
    this.catalog = catalog;
    this.exceptions = this.exceptions.flatMap((e) => {
      const old = previous.rules.find((r) => r.id === e.ruleId && r[e.access] === "ask");
      const current = old && catalog.rules.find((r) => r.id === (prepared.ruleIds.get(old.id) ?? old.id) && r[e.access] === "ask" && r.scope === old.scope && r.binding?.canonical === old.binding?.canonical);
      return current ? [{ ...e, ruleId: current.id }] : [];
    });
    this.revision++;
    try { this.persist(this.mode, this.grants, this.exceptions); }
    catch (error) {
      this.cacheStale = true;
      this.warning(`Global policy committed and active; private cache refresh failed: ${String(error)}. Restart Pi before further authority changes.`);
    }
  }

  attachChild(cancel: () => void): () => void {
    const release = this.lease();
    this.children.add(cancel);
    return () => {
      this.children.delete(cancel);
      release();
    };
  }

  async drain(): Promise<void> {
    for (const cancel of this.children) cancel();
    while (this.leases) await new Promise<void>((resolve) => this.drained.push(resolve));
  }

  async reload(config: PermissionModeConfig, _project: undefined, context: ResolutionContext): Promise<void> {
    this.block("Policy reload is draining governed operations and children");
    await this.drain();
    try {
      const replacement = resolveCatalog(config, this.catalog.root, context, this.catalog);
      if (!replacement.profiles[this.mode]) throw new Error(`Selected profile was removed: ${this.mode}`);
      for (const grant of this.grants) resolvePermissionBinding(grant.binding);
      const exceptions = this.exceptions.filter((e) => replacement.rules.some((r) => r.id === e.ruleId && r[e.access] === "ask"));
      const old = this.catalog;
      const oldExceptions = this.exceptions;
      this.catalog = replacement;
      this.exceptions = exceptions;
      try {
        this.network.reconfigure(replacement.config.network, old.config.network);
      } catch (error) {
        this.catalog = old;
        this.exceptions = oldExceptions;
        throw error;
      }
      this.approvalCancellation = new AbortController();
      this.unavailable = undefined;
      this.revision++;
    } catch (error) {
      this.unavailable = String(error);
      throw error;
    }
  }

  block(reason: string): void {
    this.unavailable = reason;
    this.revision++;
    this.approvalCancellation.abort();
  }

  async requestDirectory(directory: string, access: Access, reason: string, signal?: AbortSignal, agentWait = true): Promise<void> {
    const binding = bindPath(directory);
    if (!binding.missing.length && binding.identity.type !== "directory")
      throw new Error("Directory access requires a directory");
    await this.requestGrant(directory, access, reason, signal, agentWait);
  }

  async requestGrant(nativePath: string, access: Access, reason: string, signal?: AbortSignal, agentWait = true): Promise<void> {
    if (access !== "read" && access !== "write") throw new Error("Path access must be read or write");
    const binding = bindPath(nativePath);
    if (!binding.missing.length && binding.identity.type !== "directory" && binding.identity.type !== "file")
      throw new Error("Access grants require a directory or regular file");
    const snapshot = this.snapshot();
    const kind = !binding.missing.length && binding.identity.type === "file" ? "file" : "directory";
    const proposed = { scope: kind === "file" ? "file" as const : "tree" as const, access, binding: kind === "file" ? bindFile(binding) : binding };
    const decision = decide(snapshot, binding, access, proposed);
    if (decision.action === "deny") throw new Error(`Hard-denied path: ${nativePath}`);
    await this.approve(
      { kind, path: kind === "file" ? binding.lexical : binding.canonical, access, reason, create: binding.missing.length > 0, agentWait },
      snapshot.revision,
      signal,
    );
  }

  private async approve(request: ApprovalRequest, revision: number, signal?: AbortSignal, inline = false): Promise<PathBinding | undefined> {
    signal = signal ? AbortSignal.any([signal, this.approvalSignal]) : this.approvalSignal;
    signal.throwIfAborted();
    const key = JSON.stringify([revision, request.kind, request.path, request.access, request.ruleId]);
    let pending = this.pending.get(key);
    if (!pending) {
      request = freeze({ ...request });
      const frozen = bindPath(request.path);
      pending = this.approvalQueue.enqueue(async () => {
        const snapshot = this.snapshot();
        revision = snapshot.revision;
        assertBinding(frozen, request.kind === "exception");
        const proposed = request.kind === "exception" ? undefined : {
          scope: request.kind === "file" ? "file" as const : "tree" as const,
          access: request.access,
          binding: request.kind === "file" ? bindFile(frozen) : frozen,
        };
        const decision = decide(snapshot, frozen, request.access, proposed);
        if (decision.action === "deny") throw new Error(`Filesystem access denied: ${request.path}`);
        if (request.kind === "exception" && !decision.exceptions.some((exception) => exception.rule.id === request.ruleId && exception.access === request.access)) return undefined;
        const answer = await this.ask(request, signal);
        signal?.throwIfAborted();
        this.check(revision);
        assertBinding(frozen, request.kind === "exception");
        if (!answer) throw new Error(`Access denied: ${request.path}`);
        if (answer.action === "block") {
          if (request.access !== "read" && request.access !== "write") throw new Error("Invalid block access");
          if (answer.lifetime !== undefined) throw new Error("Session blocks have no grant lifetime");
          let scope: "file" | "tree";
          let binding: ResolvedRule["binding"];
          if (request.kind === "directory") {
            if (answer.directory && answer.directory !== frozen.lexical && !answer.binding)
              throw new Error("Edited approval must retain its pre-confirmation identity");
            const selected = answer.binding ?? frozen;
            assertBinding(selected);
            if (answer.directory && answer.directory !== selected.lexical && answer.directory !== selected.canonical)
              throw new Error("Edited block must match its displayed directory");
            if (!within(selected.canonical, frozen.canonical))
              throw new Error("Edited directory must contain the requested target");
            if (!selected.missing.length && selected.identity.type !== "directory")
              throw new Error("Session directory blocks require a directory scope");
            binding = selected;
            scope = "tree";
          } else {
            if (answer.directory || answer.binding) throw new Error("File and exception blocks cannot edit scope");
            if (request.kind === "file") {
              binding = bindFile(frozen);
              scope = "file";
            } else {
              const rule = this.catalog.rules.find((r) => r.id === request.ruleId);
              if (rule?.[request.access] !== "ask" || !rule.binding || rule.scope !== request.scope || rule.binding.lexical !== request.path)
                throw new Error("The requested rule exception is no longer available");
              binding = rule.binding;
              scope = rule.scope;
            }
          }
          const current = resolvePermissionBinding(binding, true);
          if (!current.missing.length && current.identity.type !== (scope === "file" ? "file" : "directory"))
            throw new Error("Block target type does not match scope");
          signal?.throwIfAborted();
          this.check(revision);
          const block: ResolvedRule = {
            id: `block:${randomUUID()}`, path: binding.canonical, scope, binding,
            definition: "session block", [request.access]: "deny",
          };
          this.blocks = [...this.blocks, freeze(block)];
          this.revision++;
          throw new Error(`Access denied; blocked for this session: ${request.path}`);
        }
        if (answer.lifetime !== "session" && answer.lifetime !== "project" && (answer.lifetime !== "global" || request.kind === "exception"))
          throw new Error("Invalid approval lifetime");
        let created: PathBinding | undefined;
        try {
        if (request.kind === "directory") {
          if (answer.directory && answer.directory !== frozen.lexical && !answer.binding)
            throw new Error("Edited approval must retain its pre-confirmation identity");
          let binding = answer.binding ?? frozen;
          assertBinding(binding);
          if (!within(binding.canonical, frozen.canonical))
            throw new Error("Edited directory must contain the requested target");
          if (!binding.missing.length && binding.identity.type !== "directory")
            throw new Error("Access grants require a directory");
          if (binding.missing.length) {
            if (request.access !== "write" || binding.missing.length !== 1)
              throw new Error("Approve the first missing directory with R/W before creating deeper paths");
            const decision = decide(this.snapshot(), binding, "write", { scope: "tree", access: "write", binding });
            if (decision.action === "deny") throw new Error(`Hard-denied path: ${binding.lexical}`);
            for (const exception of decision.exceptions) {
              await this.approve({
                kind: "exception", path: exception.rule.binding!.lexical, access: exception.access,
                ruleId: exception.rule.id, scope: exception.rule.scope, reason: request.reason, create: false, agentWait: request.agentWait,
              }, revision, signal, true);
              // Only the requested exception may advance authority while this directory answer is pending.
              this.check(++revision);
            }
            signal?.throwIfAborted();
            assertBinding(binding);
            mkdirSync(binding.canonical, { mode: 0o700 });
            binding = bindPath(binding.lexical);
            created = binding;
          }
          if (answer.lifetime === "global") await this.changeGlobalNow({ kind: "save", binding, access: request.access, scope: "tree" }, signal, request.agentWait);
          else {
            const grants = [...this.grants, { id: randomUUID(), binding, access: request.access, lifetime: answer.lifetime }];
            this.persist(this.mode, grants, this.exceptions, this.network.snapshot(), signal);
            this.grants = grants;
          }
        } else if (request.kind === "file") {
          if (answer.directory || answer.binding) throw new Error("Exact-file grants cannot edit directory scope");
          const binding = bindFile(frozen);
          if (answer.lifetime === "global") await this.changeGlobalNow({ kind: "save", binding, access: request.access, scope: "file" }, signal, request.agentWait);
          else {
            const grants = [...this.grants, { id: randomUUID(), binding, access: request.access, lifetime: answer.lifetime }];
            this.persist(this.mode, grants, this.exceptions, this.network.snapshot(), signal);
            this.grants = grants;
          }
        } else {
          if (answer.lifetime === "global") throw new Error("Ask receipts cannot be global");
          const rule = this.catalog.rules.find((r) => r.id === request.ruleId);
          if (rule?.[request.access] !== "ask") throw new Error("The requested rule exception is no longer available");
          const exceptions = [
            ...this.exceptions,
            { id: randomUUID(), ruleId: rule.id, access: request.access, lifetime: answer.lifetime },
          ];
          this.persist(this.mode, this.grants, exceptions, this.network.snapshot(), signal);
          this.exceptions = exceptions;
        }
        this.revision++;
        return created;
        } catch (error) {
          if (created) {
            try { if (!revalidate(created)) throw new Error("Created directory was replaced"); rmdirSync(created.canonical); }
            catch { this.warning(`Permission was not committed; retained created directory: ${created.lexical}`); }
          }
          throw error;
        }
      }, signal);
      pending.promise = pending.promise.finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    // Nested exceptions share the current dialog owner, even when a sibling queued them first.
    if (inline) void pending.run();
    return await pending.promise;
  }

  async authorize(
    nativePaths: string[],
    access: Access,
    reason: string,
    signal?: AbortSignal,
    agentWait = true,
  ): Promise<{ snapshot: FilesystemSnapshot; targets: PathBinding[] }> {
    const original = nativePaths.map(bindPath);
    const creations = new Map<string, PathBinding>();
    for (;;) {
      signal?.throwIfAborted();
      const snapshot = this.snapshot();
      const targets = original.map((binding) => {
        if (!revalidate(binding)) {
          const current = bindPath(binding.lexical);
          const created = creations.get(current.prefix);
          if (!binding.missing.length || !created || !revalidate(created) || created.canonical === binding.canonical || current.canonical !== binding.canonical || current.missing.length === 0)
            throw new Error(`Target changed during approval: ${binding.lexical}`);
          return current;
        }
        return binding;
      });
      let changed = false;
      try {
        for (const target of targets) {
          const decision = decide(snapshot, target, access);
          if (decision.action === "deny") throw new Error(`Filesystem access denied: ${target.lexical}`);
          if (decision.exceptions.length) {
            const exception = decision.exceptions[0]!;
            await this.approve(
              {
                kind: "exception",
                path: exception.rule.binding!.lexical,
                access: exception.access,
                ruleId: exception.rule.id,
                scope: exception.rule.scope,
                reason,
                create: false,
                agentWait,
              },
              snapshot.revision,
              signal,
            );
            changed = true;
            break;
          }
          if (decision.directory) {
            const directory = target.identity.type === "directory" && !target.missing.length ? target.canonical : path.dirname(target.canonical);
            const created = await this.approve(
              { kind: "directory", path: directory, access, reason, create: bindPath(directory).missing.length > 0, agentWait },
              snapshot.revision,
              signal,
            );
            if (created) creations.set(created.canonical, created);
            changed = true;
            break;
          }
        }
      } catch (error) {
        if (error instanceof StaleAuthorityError) continue;
        throw error;
      }
      if (changed) continue;
      this.check(snapshot.revision);
      for (const target of targets) assertBinding(target);
      return { snapshot, targets };
    }
  }

  async run<T>(
    paths: string[],
    access: Access,
    reason: string,
    signal: AbortSignal | undefined,
    execute: (snapshot: FilesystemSnapshot, targets: PathBinding[], signal: AbortSignal) => Promise<T>,
    agentWait = true,
  ): Promise<T> {
    const cancellation = signal ? AbortSignal.any([signal, this.approvalSignal]) : this.approvalSignal;
    for (;;) {
      const authorization = await this.authorize(paths, access, reason, cancellation, agentWait);
      const release = this.lease();
      try {
        this.check(authorization.snapshot.revision);
        const result = await execute(authorization.snapshot, authorization.targets, cancellation);
        cancellation.throwIfAborted();
        return result;
      } catch (error) {
        if (error instanceof StaleAuthorityError) continue;
        throw error;
      } finally {
        release();
      }
    }
  }
}
