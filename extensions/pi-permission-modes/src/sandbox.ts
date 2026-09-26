import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { assertBinding, bindPath, identity, sameIdentity, within } from "./paths.ts";
import { withProxyReady } from "./proxy-wait.ts";
import { assertNativeSemantics } from "./native-semantics.ts";
import type { FileIdentity, FilesystemSnapshot, NetworkSnapshot, PathBinding } from "./schema.ts";

type Manager = typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;
export interface RuntimePolicy {
  bindings: Record<string, PathBinding>;
  sourceFds?: Record<string, number>;
  guards: string[];
  rules: { path: string; directory: boolean; read: boolean; write: boolean }[];
  grants: { path: string; directory: boolean; write: boolean }[];
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
  const grants = [...snapshot.profile.grants, ...snapshot.grants.map((g) => ({ ...g, scope: "tree" as const }))].map(
    (g) => {
      assertBinding(g.binding);
      assertNativeSemantics(g.binding);
      if (g.binding.missing.length)
        throw new Error(`Approved root does not exist: ${g.binding.lexical}. Request explicit directory creation.`);
      literal(g.binding.canonical);
      bindings[g.binding.canonical] = g.binding;
      return { path: g.binding.canonical, directory: g.scope === "tree", write: g.access === "write" };
    },
  );
  if (process.platform === "linux") {
    const helper = fileURLToPath(new URL(`../vendor/seccomp/${process.arch}/apply-seccomp`, import.meta.resolve("@anthropic-ai/sandbox-runtime")));
    const binding = bindPath(helper);
    if (binding.missing.length || binding.identity.type !== "file") throw new Error(`Missing sandbox process-isolation helper: ${helper}`);
    assertNativeSemantics(binding);
    bindings[binding.canonical] = binding;
    grants.push({ path: binding.canonical, directory: false, write: false });
  }
  const policy: RuntimePolicy = { bindings, grants, guards: [], rules: [] };
  for (const rule of snapshot.rules) {
    assertBinding(rule.binding, true);
    assertNativeSemantics(rule.binding);
    const active = (access: "read" | "write") =>
      !!rule[access] &&
      (rule[access] === "deny" || !snapshot.exceptions.some((e) => e.ruleId === rule.id && e.access === access));
    const read = active("read");
    const write = read || active("write");
    if (!write) continue;
    const target = rule.binding.canonical;
    const current = bindPath(rule.binding.lexical);
    if (!current.missing.length && current.identity.type !== (rule.scope === "tree" ? "directory" : "file")) throw new Error(`Sandbox rule scope cannot be represented for this target type: ${target}`);
    literal(target);
    // A writable lexical symlink entry cannot be pinned by a Linux bind (which follows it).
    if (rule.binding.lexical !== target) {
      let prefix = path.parse(rule.binding.lexical).root;
      for (const part of rule.binding.lexical.slice(prefix.length).split(path.sep).filter(Boolean)) {
        prefix = path.join(prefix, part);
        if (!existsSync(prefix)) break;
        if (lstatSync(prefix).isSymbolicLink()) {
          const parent = bindPath(path.dirname(prefix)).canonical;
          if (grants.some((g) => g.write && g.directory && within(g.path, parent)))
            throw new Error(`Writable restricted symlink cannot be guarded safely: ${prefix}`);
        }
      }
    }
    // Denial projection must never turn an otherwise unreadable ancestor into a read grant.
    const affected = grants.flatMap((grant) => {
      if ((grant.directory && within(grant.path, target)) || grant.path === target) return [{ path: target, directory: rule.scope === "tree" }];
      if (rule.scope === "tree" && within(target, grant.path)) return [{ path: grant.path, directory: grant.directory }];
      return [];
    });
    for (const part of affected) {
      const existing = policy.rules.find((entry) => entry.path === part.path);
      if (existing && existing.directory !== part.directory) throw new Error(`Conflicting future rule scopes: ${part.path}`);
      if (existing) { existing.read ||= read; existing.write ||= write; }
      else policy.rules.push({ ...part, read, write });
      if (!read) bindings[part.path] ??= current;
      let ancestor = path.dirname(part.path);
      for (;;) {
        if (grants.some((g) => g.write && g.directory && within(g.path, ancestor))) {
          const binding = bindPath(ancestor);
          if (binding.missing.length || binding.canonical !== ancestor || binding.identity.type !== "directory")
            throw new Error(`Restriction needs an existing, nonsymlink ancestor: ${ancestor}`);
          bindings[ancestor] ??= binding;
          policy.guards.push(ancestor);
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
  }
  policy.rules = policy.rules
    .filter(
      (rule, index, rules) =>
        !rules.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.directory &&
            other.read &&
            within(other.path, rule.path) &&
            (other.path !== rule.path || otherIndex < index),
        ),
    )
    .sort((a, b) => a.path.length - b.path.length);
  policy.guards = [...new Set(policy.guards)]
    .filter((guard) => !policy.rules.some((rule) => rule.directory && within(rule.path, guard)))
    .sort((a, b) => a.length - b.length);
  const sources = new Set([...grants.map((g) => g.path), ...policy.guards, ...policy.rules.filter((r) => !r.read).map((r) => r.path)]);
  for (const file of Object.keys(bindings)) if (!sources.has(file)) delete bindings[file];
  // Broad allow roots are applied before final rule masks by the opt-in runtime patch.
  return {
    allowRead: [...new Set(grants.map((g) => g.path))],
    denyRead: ["/"],
    allowWrite: [...new Set(grants.filter((g) => g.write).map((g) => g.path))],
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
            bwrapPath: "/usr/bin/bwrap",
            socatPath: "/usr/bin/socat",
            ripgrep: { command: "/usr/bin/rg" },
          },
          ({ host, port }) => family.decideHost(host, port),
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
        const confined = snapshot.profile.kind !== "unrestricted" || network.restricted;
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
            release = prepareFutureRules(fs.explicitPolicy);
            pins = pinSources(fs.explicitPolicy);
            wrapped = await manager.wrapWithSandbox(
              network.restricted ? withProxyReady(command) : command,
              "/bin/bash",
              {
                filesystem: fs,
                network: { allowedDomains: [], deniedDomains: [], disabled: !network.restricted },
              } as Parameters<Manager["wrapWithSandbox"]>[2],
              options.signal,
            );
          }
          options.signal?.throwIfAborted();
          compileFilesystem(snapshot);
          beforeSpawn();
          preparing = false;
          family.reportEnforcement?.();
          return await runProcess("/bin/bash", ["-c", wrapped], cwd, options, pins.fds);
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

const coordinatorKey = Symbol.for("pi.permission-modes.runtime.v2");
const processState = globalThis as typeof globalThis & { [coordinatorKey]?: RuntimeCoordinator };
export const runtime = (processState[coordinatorKey] ??= new RuntimeCoordinator());

export async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  fds: number[] = [],
): Promise<{ exitCode: number | null }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe", ...fds] });
    let timeout = false;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer =
      options.timeout && options.timeout > 0
        ? setTimeout(() => {
            timeout = true;
            kill();
          }, options.timeout * 1000)
        : undefined;
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    child.stdout!.on("data", options.onData);
    child.stderr!.on("data", options.onData);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode) => {
      cleanup();
      if (options.signal?.aborted) reject(new Error("Operation aborted"));
      else if (timeout) reject(new Error(`timeout:${options.timeout}`));
      else resolve({ exitCode });
    });
  });
}
