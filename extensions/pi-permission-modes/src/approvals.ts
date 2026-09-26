import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { NetworkSession, type NetAsk } from "./network.ts";
import { assertBinding, bindPath, revalidate, within } from "./paths.ts";
import { decide, freeze, resolveCatalog, tightenCatalog, type ResolutionContext } from "./policy.ts";
import type { PermissionStore, SavedState } from "./permission-state.ts";
import type {
  Access,
  DirectoryGrant,
  FilesystemSnapshot,
  Lifetime,
  PathBinding,
  PermissionModeConfig,
  ResolvedCatalog,
  RuleException,
} from "./schema.ts";

export class StaleAuthorityError extends Error {}
export interface ApprovalRequest {
  kind: "directory" | "exception";
  path: string;
  access: Access;
  reason: string;
  create: boolean;
  ruleId?: string;
}
export interface ApprovalAnswer {
  lifetime: Lifetime;
  directory?: string;
  binding?: PathBinding;
}
export type AskApproval = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalAnswer | undefined>;

/** The owner accepts intents, never replacement snapshots from executors or children. */
export class PermissionOwner {
  private catalog: ResolvedCatalog;
  private mode: string;
  private grants: DirectoryGrant[];
  private exceptions: RuleException[];
  private revision = 0;
  private unavailable?: string;
  resetPending = false;
  enforcementError?: string;
  private leases = 0;
  private drained: (() => void)[] = [];
  private children = new Set<() => void>();
  private pending = new Map<string, Promise<void>>();
  private approvalCancellation = new AbortController();
  private readonly store?: PermissionStore;
  readonly network: NetworkSession;
  ask: AskApproval;
  askNetwork?: NetAsk;

  constructor(
    catalog: ResolvedCatalog,
    options: {
      store?: PermissionStore;
      restored?: SavedState;
      grants?: DirectoryGrant[];
      exceptions?: RuleException[];
      ask: AskApproval;
      askNetwork?: NetAsk;
    },
  ) {
    this.catalog = catalog;
    this.store = options.store;
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
  snapshot(): FilesystemSnapshot {
    if (this.unavailable) throw new Error(`Filesystem policy unavailable: ${this.unavailable}`);
    assertBinding(this.catalog.root.binding);
    return freeze({
      revision: this.revision,
      root: this.catalog.root,
      mode: this.mode,
      profile: this.catalog.profiles[this.mode]!,
      rules: this.catalog.rules,
      grants: [...this.grants],
      exceptions: [...this.exceptions],
    });
  }

  private persist(
    mode: string,
    grants: DirectoryGrant[],
    exceptions: RuleException[],
    network = this.network.snapshot(),
    signal?: AbortSignal,
  ): void {
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
    const grants = id ? this.grants.filter((g) => g.id !== id) : [];
    const exceptions = id ? this.exceptions.filter((e) => e.id !== id) : [];
    this.persist(this.mode, grants, exceptions);
    this.grants = grants;
    this.exceptions = exceptions;
    this.revision++;
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

  async reload(config: PermissionModeConfig, project: unknown, context: ResolutionContext): Promise<void> {
    this.block("Policy reload is draining governed operations and children");
    await this.drain();
    try {
      const global = resolveCatalog(config, this.catalog.root, context, this.catalog.base ?? this.catalog);
      const replacement = tightenCatalog(global, project, context, this.catalog);
      if (!replacement.profiles[this.mode]) throw new Error(`Selected profile was removed: ${this.mode}`);
      for (const grant of this.grants) assertBinding(grant.binding);
      const exceptions = this.exceptions.filter((e) => replacement.rules.some((r) => r.id === e.ruleId));
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

  async requestDirectory(directory: string, access: Access, reason: string, signal?: AbortSignal): Promise<void> {
    if (access !== "read" && access !== "write") throw new Error("Directory access must be read or write");
    const binding = bindPath(directory);
    const snapshot = this.snapshot();
    if (decide(snapshot, binding, access).action === "deny") throw new Error(`Hard-denied path: ${directory}`);
    if (decide(snapshot, binding, access).directory)
      await this.approve(
        { kind: "directory", path: binding.canonical, access, reason, create: binding.missing.length > 0 },
        snapshot.revision,
        signal,
      );
  }

  private async approve(request: ApprovalRequest, revision: number, signal?: AbortSignal): Promise<void> {
    signal = signal ? AbortSignal.any([signal, this.approvalSignal]) : this.approvalSignal;
    signal.throwIfAborted();
    const key = JSON.stringify([revision, request.kind, request.path, request.access, request.ruleId]);
    let pending = this.pending.get(key);
    if (!pending) {
      const frozen = bindPath(request.path);
      pending = (async () => {
        const answer = await this.ask(request, signal);
        signal?.throwIfAborted();
        this.check(revision);
        assertBinding(frozen, request.kind === "exception");
        if (!answer) throw new Error(`Access denied: ${request.path}`);
        if (answer.lifetime !== "session" && answer.lifetime !== "project")
          throw new Error("Invalid approval lifetime");
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
            assertBinding(binding);
            mkdirSync(binding.canonical, { mode: 0o700 });
            binding = bindPath(binding.lexical);
          }
          const grants = [
            ...this.grants,
            { id: randomUUID(), binding, access: request.access, lifetime: answer.lifetime },
          ];
          this.persist(this.mode, grants, this.exceptions, this.network.snapshot(), signal);
          this.grants = grants;
        } else {
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
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    await pending;
  }

  async authorize(
    nativePaths: string[],
    access: Access,
    reason: string,
    signal?: AbortSignal,
  ): Promise<{ snapshot: FilesystemSnapshot; targets: PathBinding[] }> {
    const original = nativePaths.map(bindPath);
    for (;;) {
      signal?.throwIfAborted();
      const snapshot = this.snapshot();
      const targets = original.map((binding) => {
        if (!revalidate(binding)) {
          const current = bindPath(binding.lexical);
          const createdGrant = this.grants.find(
            (g) =>
              binding.missing.length &&
              g.binding.canonical === current.prefix &&
              g.binding.canonical !== binding.canonical &&
              current.canonical === binding.canonical,
          );
          if (!createdGrant || !revalidate(createdGrant.binding) || current.missing.length === 0)
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
          if (decision.directory) {
            const directory =
              target.identity.type === "directory" && !target.missing.length
                ? target.canonical
                : path.dirname(target.canonical);
            await this.approve(
              { kind: "directory", path: directory, access, reason, create: bindPath(directory).missing.length > 0 },
              snapshot.revision,
              signal,
            );
            changed = true;
            break;
          }
          if (decision.exceptions.length) {
            const exception = decision.exceptions[0]!;
            await this.approve(
              {
                kind: "exception",
                path: exception.rule.binding.lexical,
                access: exception.access,
                ruleId: exception.rule.id,
                reason,
                create: false,
              },
              snapshot.revision,
              signal,
            );
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
    execute: (snapshot: FilesystemSnapshot, targets: PathBinding[]) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const authorization = await this.authorize(paths, access, reason, signal);
      const release = this.lease();
      try {
        this.check(authorization.snapshot.revision);
        const result = await execute(authorization.snapshot, authorization.targets);
        signal?.throwIfAborted();
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
