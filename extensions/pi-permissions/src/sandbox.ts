import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { assertBinding, bindPath, identity, resolvePermissionBinding, sameIdentity, within } from "./paths.ts";
import { withProxyReady } from "./proxy-wait.ts";
import { assertNativeSemantics } from "./native-semantics.ts";
import { decide, positiveTarget } from "./evaluation.ts";
import { isHostAllowed, normalizeDomain } from "./network.ts";
import type { FileIdentity, FilesystemSnapshot, NetworkSnapshot, PathBinding, ProcessMode } from "./schema.ts";

type Manager = typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;
export interface RuntimePolicy {
  bindings: Record<string, PathBinding>;
  sourceFds?: Record<string, number>;
  guards: string[];
  rules: { path: string; directory: boolean; read: boolean; write: boolean }[];
  grants: { path: string; directory: boolean; write: boolean }[];
  program: { path: string; directory: boolean; read: boolean; write: boolean }[];
}

function literal(value: string): void {
  if (/[*?[\]{}\n\r]/.test(value)) throw new Error(`Sandbox cannot represent this literal path safely: ${value}`);
}

/** Runtime guards pin only ancestor entries, not their otherwise writable contents. */
export function compileFilesystem(snapshot: FilesystemSnapshot): {
  allowRead: string[];
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
  disabled?: boolean;
  explicitPolicy?: RuntimePolicy;
} {
  assertBinding(snapshot.root.binding);
  if (snapshot.profile.kind === "unrestricted")
    return { disabled: true, allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] };
  const bindings: Record<string, PathBinding> = {};
  const boundaries = new Map<string, { binding: PathBinding; directory: boolean }>();
  const grants: RuntimePolicy["grants"] = [];
  const addBoundary = (binding: PathBinding, directory: boolean) => {
    assertNativeSemantics(binding);
    literal(binding.canonical);
    const old = boundaries.get(binding.canonical);
    if (old && old.directory !== directory) throw new Error(`Conflicting native rule scopes: ${binding.canonical}`);
    boundaries.set(binding.canonical, { binding, directory });
  };
  for (const source of snapshot.profile.grants) {
    const positive = positiveTarget(source.binding, source.scope);
    if (!positive.binding) continue;
    addBoundary(positive.binding, source.scope === "tree");
    grants.push({ path: positive.binding.canonical, directory: source.scope === "tree", write: source.access === "write" });
  }
  for (const source of snapshot.grants) {
    const binding = resolvePermissionBinding(source.binding);
    if (binding.missing.length) throw new Error(`Permission target does not exist: ${binding.lexical}`);
    const directory = !("parent" in source.binding);
    addBoundary(binding, directory);
    grants.push({ path: binding.canonical, directory, write: source.access === "write" });
  }
  let effective = snapshot;
  if (process.platform === "linux") {
    const helper = fileURLToPath(new URL(`../vendor/seccomp/${process.arch}/apply-seccomp`, import.meta.resolve("@anthropic-ai/sandbox-runtime")));
    const binding = bindPath(helper);
    if (binding.missing.length || binding.identity.type !== "file") throw new Error(`Missing sandbox process-isolation helper: ${helper}`);
    addBoundary(binding, false);
    grants.push({ path: binding.canonical, directory: false, write: false });
    effective = { ...snapshot, profile: { ...snapshot.profile, grants: [...snapshot.profile.grants, { binding, scope: "file", access: "read", runtime: true }] } };
  }
  const negative: { binding: PathBinding; directory: boolean }[] = [];
  for (const rule of snapshot.rules) {
    const restriction = rule.read === "deny" || rule.read === "ask" || rule.write === "deny" || rule.write === "ask";
    if (!rule.binding) { if (restriction) throw new Error(`Restriction has no validated target: ${rule.path}`); continue; }
    const positive = positiveTarget(rule.binding, rule.scope);
    const read = rule.read === "allow" || (rule.read === "ask" && snapshot.exceptions.some((e) => e.ruleId === rule.id && e.access === "read"));
    const write = rule.write === "allow" || (rule.write === "ask" && snapshot.exceptions.some((e) => e.ruleId === rule.id && e.access === "write"));
    if (positive.binding && (read || write)) {
      addBoundary(positive.binding, rule.scope === "tree");
      grants.push({ path: positive.binding.canonical, directory: rule.scope === "tree", write });
    }
    if (!restriction) continue;
    const binding = resolvePermissionBinding(rule.binding, true);
    if (!binding.missing.length && binding.identity.type !== (rule.scope === "tree" ? "directory" : "file")) throw new Error(`Sandbox rule scope cannot be represented for this target type: ${binding.canonical}`);
    negative.push({ binding, directory: rule.scope === "tree" });
  }
  const policy: RuntimePolicy = { bindings, grants, guards: [], rules: [], program: [] };
  for (const entry of negative) {
    if (!grants.some((g) => (g.directory && within(g.path, entry.binding.canonical)) || g.path === entry.binding.canonical || (entry.directory && within(entry.binding.canonical, g.path)))) continue;
    addBoundary(entry.binding, entry.directory);
    if (entry.binding.lexical !== entry.binding.canonical) {
      let prefix = path.parse(entry.binding.lexical).root;
      for (const part of entry.binding.lexical.slice(prefix.length).split(path.sep).filter(Boolean)) {
        prefix = path.join(prefix, part);
        if (!existsSync(prefix)) break;
        if (lstatSync(prefix).isSymbolicLink() && grants.some((g) => g.write && g.directory && within(g.path, bindPath(path.dirname(prefix)).canonical)))
          throw new Error(`Writable restricted symlink cannot be guarded safely: ${prefix}`);
      }
    }
    for (let ancestor = path.dirname(entry.binding.canonical); ; ancestor = path.dirname(ancestor)) {
      if (grants.some((g) => g.write && g.directory && within(g.path, ancestor))) {
        const binding = bindPath(ancestor);
        if (binding.missing.length || binding.canonical !== ancestor || binding.identity.type !== "directory") throw new Error(`Restriction needs an existing, nonsymlink ancestor: ${ancestor}`);
        policy.guards.push(ancestor);
        if (decide(effective, binding, "read").action === "allow") addBoundary(binding, true);
      }
      if (path.dirname(ancestor) === ancestor) break;
    }
  }
  const depth = (value: string) => value.split(path.sep).filter(Boolean).length;
  policy.guards = [...new Set(policy.guards)].sort((a, b) => depth(a) - depth(b));
  for (const [target, entry] of [...boundaries].sort(([a], [b]) => depth(a) - depth(b) || a.localeCompare(b))) {
    const read = decide(effective, entry.binding, "read").action === "allow";
    const write = decide(effective, entry.binding, "write").action === "allow";
    policy.program.push({ path: target, directory: entry.directory, read, write });
    if (read) bindings[target] = entry.binding;
    if ((!read || !write) && negative.some((r) => r.binding.canonical === target))
      policy.rules.push({ path: target, directory: entry.directory, read: !read, write: !write });
  }
  return {
    allowRead: policy.program.filter((r) => r.read).map((r) => r.path),
    denyRead: ["/"],
    allowWrite: policy.program.filter((r) => r.write).map((r) => r.path),
    denyWrite: [],
    explicitPolicy: policy,
  };
}

interface Placeholder {
  identity: FileIdentity;
  directory: boolean;
  users: number;
}
const placeholders = new Map<string, Placeholder>();

/** Mountpoints for future restrictions are owned and removed by identity, never by filename alone. */
function prepareFutureRules(policy?: RuntimePolicy): () => void {
  const acquired: string[] = [];
  const release = () => {
    for (const file of acquired.reverse()) {
      const record = placeholders.get(file);
      if (!record || --record.users > 0) continue;
      placeholders.delete(file);
      try {
        if (!sameIdentity(identity(file), record.identity)) continue;
        if (record.directory) rmdirSync(file);
        else unlinkSync(file);
      } catch {
        /* A replaced or populated mountpoint must never be removed. */
      }
    }
  };
  try {
    for (const rule of policy?.rules ?? []) {
      const known = placeholders.get(rule.path);
      if (known) {
        known.users++;
        acquired.push(rule.path);
        continue;
      }
      if (existsSync(rule.path)) continue;
      const parent = bindPath(path.dirname(rule.path));
      if (parent.missing.length) throw new Error(`Future restriction has a missing ancestor: ${rule.path}`);
      if (rule.directory) mkdirSync(rule.path, { mode: 0o500 });
      else closeSync(openSync(rule.path, "wx", 0o400));
      placeholders.set(rule.path, { identity: identity(rule.path), directory: rule.directory, users: 1 });
      acquired.push(rule.path);
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

/** Descriptor mounts keep approved sources stable until bwrap consumes and closes the descriptors. */
function pinSources(policy?: RuntimePolicy): { fds: number[]; close(): void } {
  const fds: number[] = [];
  const close = () => { for (const fd of fds.splice(0)) closeSync(fd); };
  try {
    if (policy) {
      policy.sourceFds = {};
      for (const [file, binding] of Object.entries(policy.bindings)) {
        assertBinding(binding, binding.missing.length > 0);
        const expected = binding.missing.length ? placeholders.get(file)?.identity : binding.identity;
        if (!expected) throw new Error(`No owned mountpoint identity: ${file}`);
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | (expected.type === "directory" ? constants.O_DIRECTORY : 0));
        fds.push(fd);
        if (!sameIdentity(identity(fd), expected)) throw new Error(`Sandbox source identity changed: ${file}`);
        policy.sourceFds[file] = fds.length + 2;
      }
    }
    return { fds, close };
  } catch (error) { close(); throw error; }
}

export interface RuntimeFamily {
  id: string;
  network(): NetworkSnapshot;
  decideHost(host: string, port?: number): Promise<boolean>;
  reportEnforcement?(error?: string): void;
}

async function waitFor(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error("Operation aborted"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Format only the current invocation's violation block and actionable network hint. */
export function formatSandboxDiagnostics(annotated: string, network: NetworkSnapshot): string {
  const block = annotated.match(/<sandbox_violations>\r?\n[\s\S]*?\r?\n<\/sandbox_violations>/)?.[0];
  if (!block) return "";
  const hosts = [...block.matchAll(/^deny network-outbound\s+(\S+):\d+\s+\((?:user denied|host is not on the allow list)\)$/gm)]
    .map((match) => normalizeDomain(match[1]!))
    .filter((host): host is string => Boolean(host))
    .filter((host, index, all) => all.indexOf(host) === index)
    .filter((host) => network.restricted && !isHostAllowed(host, network.deniedDomains) && !isHostAllowed(host, network.allowedDomains));
  return `${block}${hosts.length ? `\nHint: request_network_access can approve: ${hosts.join(", ")}.` : ""}`;
}

async function reportSandboxDiagnostics(
  manager: Manager,
  commandId: string,
  options: Parameters<BashOperations["exec"]>[2],
  family: RuntimeFamily,
): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    const diagnostics = formatSandboxDiagnostics(
      manager.annotateStderrWithSandboxFailures(commandId, ""),
      family.network(),
    );
    if (diagnostics) options.onData(Buffer.from(`\n${diagnostics}\n`));
  } catch {
    /* Diagnostics are informational and cannot change execution or cleanup. */
  }
}

/** One coordinator owns the process-global manager, including incompatible-family serialization. */
export class RuntimeCoordinator {
  private manager?: Manager;
  private family?: RuntimeFamily;
  private users = 0;
  private initializing?: Promise<void>;
  private idle: (() => void)[] = [];
  private admission: Promise<void> = Promise.resolve();

  private async acquire(family: RuntimeFamily, signal?: AbortSignal): Promise<Manager> {
    let unlock!: () => void;
    const before = this.admission;
    this.admission = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    try {
      await waitFor(before, signal);
    } catch (error) {
      void before.then(unlock);
      throw error;
    }
    try {
      while (this.family && this.family.id !== family.id && this.users) {
        let done!: () => void;
        const idle = new Promise<void>((resolve) => {
          done = resolve;
          this.idle.push(resolve);
        });
        try {
          await waitFor(idle, signal);
        } finally {
          this.idle = this.idle.filter((resolve) => resolve !== done);
        }
      }
      signal?.throwIfAborted();
      if (!this.manager) this.manager = (await import("@anthropic-ai/sandbox-runtime")).SandboxManager;
      if (this.family?.id !== family.id) {
        await this.manager.reset();
        this.family = family;
        this.initializing = this.manager.initialize(
          {
            filesystem: { disabled: true, denyRead: [], allowWrite: [], denyWrite: [] },
            network: { allowedDomains: [], deniedDomains: [] },
            ...(process.platform === "linux" ? {
              bwrapPath: "/usr/bin/bwrap",
              socatPath: "/usr/bin/socat",
              ripgrep: { command: "/usr/bin/rg" },
            } : {}),
          },
          ({ host, port }) => family.decideHost(host, port),
          // The Linux monitor uses init-time grants, not concurrent per-command policies.
          process.platform === "darwin",
        );
      }
      await this.initializing;
      signal?.throwIfAborted();
      this.users++;
      return this.manager;
    } finally {
      unlock();
    }
  }

  operations(
    snapshot: FilesystemSnapshot,
    family: RuntimeFamily,
    beforeSpawn: () => void,
    noSandbox = false,
  ): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        let preparing = true;
        try {
        const network = family.network();
        const commandId = randomUUID();
        const confined = snapshot.profile.kind !== "unrestricted" || network.restricted;
        const processMode = confined ? snapshot.processMode ?? "compatible" : "compatible";
        if (confined && noSandbox)
          throw new Error("--no-sandbox cannot disable a required filesystem or network layer");
        if (confined && process.platform !== "linux" && process.platform !== "darwin")
          throw new Error(`Required sandbox is unavailable on ${process.platform}`);
        const fs = compileFilesystem(snapshot);
        let manager: Manager | undefined;
        let release = () => {};
        let pins = { fds: [] as number[], close: () => {} };
        try {
          options.signal?.throwIfAborted();
          let wrapped = command;
          if (confined) {
            manager = await this.acquire(family, options.signal);
            if (process.platform === "linux") {
              release = prepareFutureRules(fs.explicitPolicy);
              pins = pinSources(fs.explicitPolicy);
            }
            wrapped = await manager.wrapWithSandbox(
              network.restricted ? withProxyReady(command) : command,
              "/bin/bash",
              {
                filesystem: fs,
                network: { allowedDomains: [], deniedDomains: [], disabled: !network.restricted },
                processMode,
              } as Parameters<Manager["wrapWithSandbox"]>[2],
              options.signal,
              { commandId, commandText: command },
            );
          }
          options.signal?.throwIfAborted();
          const validateLaunch = () => {
            const current = compileFilesystem(snapshot);
            if (process.platform === "darwin" && JSON.stringify([current.explicitPolicy?.program, current.explicitPolicy?.guards]) !== JSON.stringify([fs.explicitPolicy?.program, fs.explicitPolicy?.guards]))
              throw new Error("Filesystem permission program changed after sandbox profile generation; reauthorize before execution");
          };
          validateLaunch();
          beforeSpawn();
          if (process.platform === "darwin") validateLaunch();
          preparing = false;
          family.reportEnforcement?.();
          try {
            return await runProcess("/bin/bash", ["-c", wrapped], cwd, options, pins.fds, processMode);
          } finally {
            if (manager) await reportSandboxDiagnostics(manager, commandId, options, family);
          }
        } finally {
          pins.close();
          release();
          if (manager) {
            manager.cleanupAfterCommand();
            if (--this.users === 0) {
              const pending = this.idle.splice(0);
              for (const resolve of pending) resolve();
            }
          }
        }
        } catch (error) {
          if (preparing && !options.signal?.aborted) family.reportEnforcement?.(String(error));
          throw error;
        }
      },
    };
  }

  async shutdown(family: string): Promise<void> {
    let unlock!: () => void;
    const before = this.admission;
    this.admission = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await before;
    try {
      if (this.family?.id !== family) return;
      while (this.users) await new Promise<void>((resolve) => this.idle.push(resolve));
      await this.manager?.reset();
      this.family = undefined;
      this.initializing = undefined;
    } finally {
      unlock();
    }
  }
}

const coordinatorKey = Symbol.for("pi.permissions.runtime.v3");
const processState = globalThis as typeof globalThis & { [coordinatorKey]?: RuntimeCoordinator };
export const runtime = (processState[coordinatorKey] ??= new RuntimeCoordinator());

export async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  fds: number[] = [],
  processMode: ProcessMode = "compatible",
): Promise<{ exitCode: number | null }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe", ...fds] });
    let timeout = false;
    let finished = false;
    let exitCode: number | null = null;
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const stop = () => {
      kill();
      if (processMode === "compatible" && !finished && !outputTimer) {
        // Detached descendants may retain the pipes even after the foreground process exits.
        outputTimer = setTimeout(() => {
          child.stdout!.destroy();
          child.stderr!.destroy();
          finish(exitCode);
        }, 250);
      }
    };
    const timer =
      options.timeout && options.timeout > 0
        ? setTimeout(() => {
            timeout = true;
            stop();
          }, options.timeout * 1000)
        : undefined;
    const finish = (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (outputTimer) clearTimeout(outputTimer);
      options.signal?.removeEventListener("abort", stop);
      child.stdout!.off("data", options.onData);
      child.stderr!.off("data", options.onData);
      if (error) reject(error);
      else if (options.signal?.aborted) reject(new Error("Operation aborted"));
      else if (timeout) reject(new Error(`timeout:${options.timeout}`));
      else resolve({ exitCode: code });
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    child.stdout!.on("data", options.onData);
    child.stderr!.on("data", options.onData);
    child.once("exit", (code) => {
      exitCode = code;
      stop();
    });
    child.once("error", (error) => {
      kill();
      finish(null, error);
    });
    child.once("close", (code) => finish(code));
  });
}
