import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { decide, positiveTarget } from "./evaluation.ts";
import { assertNativeSemantics } from "./native-semantics.ts";
import { assertBinding, bindPath, contains, resolvePermissionBinding } from "./paths.ts";
import type { FilesystemSnapshot, PathBinding, PermissionBinding, ResourceGrant } from "./schema.ts";
import { windowsShellResources } from "./windows-resources.ts";
import type { PreparedWindowsExecutor } from "./windows-executor.ts";
import type { WindowsStartParams } from "./windows-rpc.ts";
import { assertWindowsTrustedFile, windowsPermissionKey, windowsSystemDirectory } from "./windows-platform.ts";

export const WINDOWS_CASE_AUTHORITY = "Windows case-equivalent pathnames share authority, even for distinct objects in case-sensitive directories. File scope is nonrecursive; tree scope covers equivalent roots and descendants. Native identities and stored project/session keys remain distinct.";
export const WINDOWS_GIT_BASH_NOTICE = "Known Windows compatibility gate: the tested stock Git Bash/MSYS runtime fails to initialize under MXC (0xC0000142). PowerShell is available when installed and readable; no command is retried directly. Full Windows release acceptance remains incomplete.";
export const WINDOWS_FILESYSTEM_LIMITATION = "Windows MXC filesystem restrictions are best-effort, not a security boundary against evasive commands. Renaming or replacing a writable ancestor can bypass nested deny/ask or read-only restrictions; even ordinary refactoring can move protected paths. Direct file tools retain their host-side authorization checks.";
export const WINDOWS_POLICY_TIMEOUT_MS = 120000;
export type WindowsShellKind = "bash" | "powershell";
export interface WindowsShell { executable: PathBinding; args: string[] }
interface Boundary { binding: PathBinding; scope: "file" | "tree"; access: "read" | "write" | "deny" }

/** Evaluate native boundaries instead of inheriting Unix mount/ancestor-guard semantics. */
export function compileWindowsFilesystem(snapshot: FilesystemSnapshot): { type: "unrestricted" } | { type: "restricted"; entries: { path: { type: "path"; path: string }; access: Boundary["access"] }[] } {
  assertBinding(snapshot.root.binding);
  if (snapshot.profile.kind === "unrestricted") return { type: "unrestricted" };
  const sources: { binding: PermissionBinding; scope: "file" | "tree"; restrictive: boolean }[] = [
    ...snapshot.profile.grants.map((g) => ({ binding: g.binding, scope: g.scope, restrictive: false })),
    ...snapshot.grants.map((g) => ({ binding: g.binding, scope: "parent" in g.binding ? "file" as const : "tree" as const, restrictive: false })),
  ];
  for (const rule of snapshot.rules) {
    const restrictive = rule.read === "deny" || rule.read === "ask" || rule.write === "deny" || rule.write === "ask";
    if (!rule.binding) { if (restrictive) throw new Error(`Restriction has no validated target: ${rule.path}`); continue; }
    sources.push({ binding: rule.binding, scope: rule.scope, restrictive });
  }
  const boundaries = new Map<string, Boundary>();
  for (const source of sources) {
    const binding = source.restrictive ? resolvePermissionBinding(source.binding, true) : positiveTarget(source.binding, source.scope).binding;
    if (!binding) continue;
    assertNativeSemantics(binding);
    if (source.restrictive && windowsPermissionKey(source.binding.lexical) !== windowsPermissionKey(binding.canonical))
      throw new Error(`Windows cannot preserve both lexical and canonical restriction families through this alias: ${source.binding.lexical}`);
    if (!binding.missing.length && binding.identity.type !== (source.scope === "tree" ? "directory" : "file"))
      throw new Error(`Windows policy scope does not match the selected object: ${binding.canonical}`);
    // The pinned interface has no explicit file/tree field for a nonexistent path.
    if (binding.missing.length && source.scope === "file") throw new Error(`Windows cannot represent a missing nonrecursive file restriction: ${binding.canonical}`);
    const read = decide(snapshot, binding, "read").action === "allow";
    const write = decide(snapshot, binding, "write").action === "allow";
    if (write && !read) throw new Error("Windows cannot represent write access without read access");
    if (binding.missing.length && read) throw new Error(`Windows cannot preserve a read-only restriction before its target exists: ${binding.canonical}`);
    const boundary: Boundary = { binding, scope: source.scope, access: write ? "write" : read ? "read" : "deny" };
    const key = `${windowsPermissionKey(binding.canonical)}:${source.scope}`;
    const previous = boundaries.get(key);
    if (previous && previous.access !== boundary.access) throw new Error("Windows case-family policy decisions disagree");
    boundaries.set(key, boundary);
  }
  const values = [...boundaries.values()];
  for (const boundary of values) {
    if (values.some((other) => other.scope !== boundary.scope && windowsPermissionKey(other.binding.canonical) === windowsPermissionKey(boundary.binding.canonical)))
      throw new Error(`Windows cannot combine file and tree declarations at the same case-family boundary: ${boundary.binding.canonical}`);
  }
  return { type: "restricted", entries: values.map(({ binding, access }) => ({ path: { type: "path", path: pathToFileURL(binding.canonical).href }, access })) };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/** No inherited credentials, profile scripts, launcher variables or proxy configuration are needed to start a shell. */
export function windowsCommandEnvironment(shell: WindowsShell, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const system = windowsSystemDirectory();
  const paths = (envValue(env, "PATH") ?? "").split(path.delimiter).filter((entry) => /^[a-z]:[\\/]/i.test(entry));
  const result: Record<string, string> = { SYSTEMROOT: path.dirname(system), PATH: [...new Set([path.dirname(shell.executable.canonical), system, ...paths])].join(path.delimiter) };
  for (const name of ["TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
    const value = envValue(env, name); if (value) result[name] = value;
  }
  return result;
}

/** Candidate discovery is filesystem-only, including when an explicit shell path is supplied. */
export function discoverWindowsShell(kind: WindowsShellKind, project: PathBinding, options: { shellPath?: string; env?: NodeJS.ProcessEnv } = {}): WindowsShell {
  assertBinding(project);
  const env = options.env ?? process.env; const candidates: string[] = [];
  if (options.shellPath) candidates.push(options.shellPath);
  else {
    for (const name of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
      const directory = envValue(env, name); if (!directory || !path.isAbsolute(directory)) continue;
      if (kind === "bash") candidates.push(path.join(directory, name === "LOCALAPPDATA" ? "Programs/Git/usr/bin/bash.exe" : "Git/usr/bin/bash.exe"));
      else candidates.push(path.join(directory, "PowerShell", "7", "pwsh.exe"));
    }
    const entries = (envValue(env, "PATH") ?? "").split(path.delimiter).filter((entry) => /^[a-z]:[\\/]/i.test(entry));
    for (const name of kind === "bash" ? ["bash.exe"] : ["pwsh.exe", "powershell.exe"])
      for (const directory of entries) candidates.push(path.join(directory, name));
    if (kind === "powershell") candidates.push(path.join(windowsSystemDirectory(), "WindowsPowerShell", "v1.0", "powershell.exe"));
  }
  const rejected: string[] = [];
  for (const candidate of candidates) {
    try {
      if (!/^[a-z]:[\\/]/i.test(candidate) || contains({ canonical: project.lexical }, { canonical: path.resolve(candidate) })) throw new Error("Shell must be an absolute installed executable outside the project");
      const binding = bindPath(candidate);
      if (binding.missing.length || binding.identity.type !== "file" || !/\.exe$/i.test(binding.canonical) || contains(project, binding)) throw new Error("Not an installed executable outside the project");
      if (kind === "bash" && contains({ canonical: path.dirname(windowsSystemDirectory()) }, binding)) throw new Error("WSL Bash/stdin transports are not supported");
      assertWindowsTrustedFile(binding.canonical); assertBinding(binding); assertBinding(project);
      return { executable: binding, args: kind === "bash" ? ["--noprofile", "--norc", "-c"] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] };
    } catch (error) { rejected.push(`${candidate}: ${String(error)}`); }
  }
  throw new Error(`Native ${kind} unavailable: install a trusted native interpreter outside the project; no unsandboxed fallback. ${rejected.join("; ")}`);
}

function shellArgv(shell: WindowsShell, command: string): string[] {
  const source = shell.args.at(-1) === "-Command" ? `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}` : command;
  return [shell.executable.canonical, ...shell.args, source];
}

/** No executor is acquired for the fully unrestricted, open-network path. */
export function directWindowsShellOperations(shell: WindowsShell): BashOperations {
  return { exec: async (command, cwd, options) => {
    options.signal?.throwIfAborted(); assertBinding(shell.executable);
    const system = windowsSystemDirectory(); const taskkill = path.join(system, "taskkill.exe"); assertWindowsTrustedFile(taskkill);
    const argv = shellArgv(shell, command);
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env: options.env ?? process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let timedOut = false; let finished = false; let failure: unknown;
      let timer: ReturnType<typeof setTimeout> | undefined; let drain: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (!child.pid || child.exitCode !== null) return;
        const killer = spawn(taskkill, ["/F", "/T", "/PID", String(child.pid)], { cwd: system, env: { SYSTEMROOT: path.dirname(system), PATH: system }, windowsHide: true, stdio: "ignore" });
        const deadline = setTimeout(() => { killer.kill(); child.kill(); }, 3000); deadline.unref();
        killer.once("error", () => { clearTimeout(deadline); child.kill(); }); killer.once("close", () => { clearTimeout(deadline); child.kill(); });
      };
      const finish = (exitCode: number | null, error?: Error) => {
        if (finished) return; finished = true; clearTimeout(timer); clearTimeout(drain); options.signal?.removeEventListener("abort", stop);
        child.stdout.destroy(); child.stderr.destroy();
        if (failure) reject(failure); else if (error) reject(error); else if (options.signal?.aborted) reject(new Error("Operation aborted")); else if (timedOut) reject(new Error(`timeout:${options.timeout}`)); else resolve({ exitCode });
      };
      const data = (chunk: Buffer) => { try { options.onData(chunk); } catch (error) { failure = error; stop(); } };
      child.stdout.on("data", data); child.stderr.on("data", data);
      child.once("error", (error) => finish(null, error));
      child.once("exit", (code) => { drain = setTimeout(() => finish(code), 250); }); child.once("close", (code) => finish(code));
      if (options.timeout && options.timeout > 0) timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout * 1000);
      options.signal?.addEventListener("abort", stop, { once: true }); if (options.signal?.aborted) stop();
    });
  } };
}

export function windowsProcessParams(snapshot: FilesystemSnapshot, argv: string[], cwd: string, env: Record<string, string>, restrictedNetwork: boolean): WindowsStartParams {
  const directory = bindPath(cwd); assertBinding(directory);
  const file_system = compileWindowsFilesystem(snapshot);
  const permissions = { type: "managed", file_system: file_system.type === "restricted" ? { ...file_system, entries: [{ path: { type: "special", value: { kind: "minimal" } }, access: "read" }, ...file_system.entries] } : file_system, network: restrictedNetwork ? "restricted" : "enabled" };
  return { processId: randomUUID(), argv, cwd: pathToFileURL(directory.canonical).href, env,
    sandbox: { permissions, cwd: pathToFileURL(directory.canonical).href, workspaceRoots: [pathToFileURL(snapshot.root.binding.canonical).href], windowsSandboxLevel: "mxc" },
    ...(restrictedNetwork ? { enforceManagedNetwork: true, networkProxy: { policyDecisionTimeoutMs: WINDOWS_POLICY_TIMEOUT_MS, proxy: { enabled: true, credentialMasking: false, enableSocks5: false, enableSocks5Udp: false, allowUpstreamProxy: false,
      dangerouslyAllowAllUnixSockets: false, mode: "full", domains: {}, reviewDomains: ["*"], unixSockets: null, allowLocalBinding: true } } } : {}),
  };
}

/** A prepared root connection is reused without replay; both process modes have native MXC descendant cleanup. */
export class WindowsRuntime {
  readonly prepared: PreparedWindowsExecutor;
  readonly bootstrapResources = new Map<string, ResourceGrant[]>();
  constructor(prepared: PreparedWindowsExecutor) { this.prepared = prepared; }

  async exec(params: WindowsStartParams, options: Parameters<BashOperations["exec"]>[2], beforeSpawn: () => void): Promise<{ exitCode: number | null }> {
    options.signal?.throwIfAborted(); this.prepared.assertIdentity(); beforeSpawn();
    const client = this.prepared.client; let exitCode: number | null = null; let stopped = false; let timeout = false; let outputError: unknown;
    let termination: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let retirement: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true; termination ??= client.terminateProcess(params.processId); void termination.catch(() => {});
      retirement ??= setTimeout(() => { void this.prepared.close().catch(() => {}); }, 5000);
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.timeout && options.timeout > 0) timer = setTimeout(() => { timeout = true; stop(); }, options.timeout * 1000);
    try {
      if (options.signal?.aborted) { stop(); options.signal.throwIfAborted(); }
      await client.startProcess(params, (event) => {
        if (event.exitCode !== undefined) exitCode = event.exitCode;
        if (event.chunk && !outputError) {
          try { options.onData(event.chunk); } catch (error) { outputError = error; stop(); }
        }
      });
      // Cancellation may precede native process registration; terminate again after start settles.
      if (stopped) { await termination; termination = client.terminateProcess(params.processId); }
      await termination;
      await client.waitClosed(params.processId);
      if (outputError) throw outputError;
      if (options.signal?.aborted) throw new Error("Operation aborted");
      if (timeout) throw new Error(`timeout:${options.timeout}`);
      if (exitCode === null) throw new Error("Windows executor closed a process without an exit result");
      return { exitCode };
    } catch (error) {
      try { await client.terminateProcess(params.processId); await client.waitClosed(params.processId); }
      catch { await this.prepared.close().catch(() => {}); }
      if (outputError) throw outputError;
      if (options.signal?.aborted) throw new Error("Operation aborted");
      if (timeout) throw new Error(`timeout:${options.timeout}`);
      throw error;
    } finally { clearTimeout(timer); clearTimeout(retirement); options.signal?.removeEventListener("abort", stop); }
  }

  /** Interpreter dependencies must already be explicit, inspectable resources in the caller's snapshot. */
  operations(snapshot: FilesystemSnapshot, shell: WindowsShell, network: () => boolean, beforeSpawn: () => void): BashOperations {
    return { exec: async (command, cwd, options) => {
      assertBinding(shell.executable);
      const key = `shell:${shell.executable.canonical}`;
      let resources = this.bootstrapResources.get(key);
      if (!resources) { resources = windowsShellResources(shell); this.bootstrapResources.set(key, resources); }
      for (const resource of resources) resolvePermissionBinding(resource.binding);
      const effective = snapshot.profile.kind === "unrestricted" ? snapshot : { ...snapshot, profile: { ...snapshot.profile, grants: [...snapshot.profile.grants, ...resources] } };
      const env = windowsCommandEnvironment(shell);
      const params = windowsProcessParams(effective, shellArgv(shell, command), cwd, env, network());
      const compiled = JSON.stringify(params.sandbox);
      return this.exec(params, options, () => { beforeSpawn(); assertBinding(shell.executable); if (JSON.stringify(windowsProcessParams(effective, params.argv, cwd, env, network()).sandbox) !== compiled) throw new Error("Windows filesystem policy changed before launch"); });
    } };
  }
}
