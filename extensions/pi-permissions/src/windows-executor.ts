import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, openSync, readSync, rmSync, fstatSync, statSync, writeFileSync, writeSync, fsyncSync, linkSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { assertBinding, bindPath, contains, identity, sameIdentity } from "./paths.ts";
import type { PathBinding } from "./schema.ts";
import { assertWindowsPrivate, assertWindowsTrustedFile, createWindowsPrivateDirectory, prepareWindowsComparison, windowsSystemDirectory, windowsSystemResources } from "./windows-platform.ts";
import { WindowsRpcClient, type WindowsNetworkDecision, type WindowsNetworkRequest, type WindowsRpcOptions, type WindowsStartParams } from "./windows-rpc.ts";

export const WINDOWS_EXECUTOR_RELEASE = {
  version: "0.166.0", target: "x86_64-pc-windows-msvc", bytes: 84244784,
  sha256: "eda5263b31e0354347e7bcdc434aff82f5c630ddba69f13449742a64e1836a37",
  url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-exec-server-x86_64-pc-windows-msvc.exe",
} as const;

export interface WindowsExecutorCandidate {
  executable: string;
  prefixArgs: string[];
  source: "installed" | "managed";
  binding: PathBinding;
  directory: PathBinding;
  size: bigint;
  modified: bigint;
}
export interface WindowsExecutorOptions {
  project: PathBinding;
  agentDir: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  policyTimeoutMs?: number;
  decideNetwork?: (request: WindowsNetworkRequest, signal: AbortSignal) => Promise<WindowsNetworkDecision>;
  networkRevision?: () => number;
  approveDownload?: (preview: { title: string; message: string }, signal?: AbortSignal) => Promise<boolean>;
}
export interface PreparedWindowsExecutor {
  directory: PathBinding;
  candidate: WindowsExecutorCandidate;
  environment: Record<string, unknown>;
  client: WindowsRpcClient;
  assertIdentity(): void;
  close(): Promise<void>;
}
export interface WindowsPreparationOperations {
  acquire?(options: WindowsExecutorOptions): Promise<void>;
  discover(options: WindowsExecutorOptions): ReturnType<typeof discoverWindowsExecutors>;
  connect(candidate: WindowsExecutorCandidate, options: WindowsRpcOptions): WindowsRpcClient;
  verify(client: WindowsRpcClient, directory: string, signal: AbortSignal | undefined, permitLoopback: (port?: number) => void): Promise<void>;
}
export class MissingWindowsExecutorError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) { super(`No compatible native Windows MXC executor was prepared${reasons.length ? `: ${reasons.join("; ")}` : ""}`); this.reasons = reasons; }
}

export function windowsRuntimePath(agentDir: string): string {
  return path.join(agentDir, "permissions", "runtime", "codex", WINDOWS_EXECUTOR_RELEASE.version, WINDOWS_EXECUTOR_RELEASE.target, "codex-exec-server.exe");
}

function trustedJson(file: string, root: PathBinding): Record<string, unknown> {
  const binding = bindPath(file);
  if (binding.missing.length || binding.identity.type !== "file" || path.dirname(binding.canonical) !== root.canonical)
    throw new Error("Installed metadata must be a regular file inside its canonical package");
  const fd = openSync(binding.canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertWindowsTrustedFile(binding.canonical, fd);
    const buffer = Buffer.alloc(65537); const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length === buffer.length) throw new Error("Installed metadata exceeds its size limit");
    assertBinding(binding);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { throw new Error("Installed package metadata is not valid UTF-8 JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid installed package metadata");
    return value as Record<string, unknown>;
  } finally { closeSync(fd); }
}

/** Advertised paths are data, not wrapper commands; escaping or redirecting the package is rejected. */
function packageEntry(root: PathBinding, value: unknown): string {
  if (typeof value !== "string" || !value || value.includes(":") || value.includes("\0") || path.isAbsolute(value) || value.split(/[\\/]/).some((part) => part === ".."))
    throw new Error("Installed package entry must stay inside its package");
  const binding = bindPath(path.resolve(root.canonical, value));
  if (!contains(root, binding)) throw new Error("Installed package entry escaped its canonical package");
  return binding.canonical;
}

export function assertWindowsExecutorIdentity(candidate: WindowsExecutorCandidate): void {
  assertBinding(candidate.directory); assertBinding(candidate.binding);
  const current = statSync(candidate.executable, { bigint: true });
  if (current.size !== candidate.size || current.mtimeNs !== candidate.modified) throw new Error("Windows executor changed; reload before running another command");
}

/** Filesystem-only discovery never invokes PATH wrappers, where.exe, or an executable to ask its version. */
export function discoverWindowsExecutors(options: WindowsExecutorOptions, locations?: readonly string[]): { candidates: WindowsExecutorCandidate[]; rejected: string[] } {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Native Windows executor preparation currently supports Windows x64 only");
  assertBinding(options.project); prepareWindowsComparison();
  const env = options.env ?? process.env; const home = options.home ?? homedir();
  const roots = [path.join(home, ".codex", "packages", "standalone", "current")];
  const prefix = path.dirname(process.execPath);
  for (const location of [env.APPDATA && path.join(env.APPDATA, "npm"), prefix])
    if (location) roots.push(path.join(location, "node_modules", "@openai", "codex"));
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex"));
  for (const entry of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry) || !/^[a-z]:[\\/]/i.test(entry)) continue;
    try {
      if (contains(options.project, { canonical: path.resolve(entry) }) || contains({ canonical: options.project.lexical }, { canonical: path.resolve(entry) })) continue;
      const directory = bindPath(entry);
      if (directory.missing.length || contains(options.project, directory)) continue;
      // Canonical standalone bin links retain the owning versioned package, not the moving link.
      roots.push(path.dirname(directory.canonical), directory.canonical);
    } catch { /* Unavailable PATH entries are not runtime candidates. */ }
  }
  const candidates: WindowsExecutorCandidate[] = []; const rejected: string[] = [];
  const seenRoots = new Set<string>(); const seenFiles = new Set<string>();
  const add = (file: string, prefixArgs: string[], source: WindowsExecutorCandidate["source"]) => {
    const binding = bindPath(file);
    if (binding.missing.length || seenFiles.has(binding.canonical)) return;
    if (binding.identity.type !== "file" || path.extname(binding.canonical).toLowerCase() !== ".exe" || (source === "installed" && contains(options.project, binding)))
      throw new Error("Executor is not a supported installed executable outside the project");
    if (source === "managed" && binding.lexical !== binding.canonical) throw new Error("Managed runtime must not redirect outside its private cache");
    assertWindowsTrustedFile(binding.canonical); assertBinding(binding);
    const current = statSync(binding.canonical, { bigint: true });
    candidates.push({ executable: binding.canonical, prefixArgs, source, binding, directory: bindPath(path.dirname(binding.canonical)), size: current.size, modified: current.mtimeNs });
    seenFiles.add(binding.canonical);
  };
  for (const location of locations ?? roots) {
    try {
      if (contains(options.project, { canonical: path.resolve(location) }) || contains({ canonical: options.project.lexical }, { canonical: path.resolve(location) }) || !existsSync(location)) continue;
      const root = bindPath(location);
      if (seenRoots.has(root.canonical) || contains(options.project, root)) continue;
      seenRoots.add(root.canonical);
      const standalone = path.join(root.canonical, "codex-package.json");
      if (existsSync(standalone)) {
        const manifest = trustedJson(standalone, root);
        if (manifest.layoutVersion !== 1) throw new Error("Unknown installed Codex package layout");
        if (manifest.execServer !== undefined) add(packageEntry(root, manifest.execServer), [], "installed");
        if (manifest.entrypoint !== undefined) add(packageEntry(root, manifest.entrypoint), ["exec-server"], "installed");
        continue;
      }
      const npm = path.join(root.canonical, "package.json");
      if (!existsSync(npm) || trustedJson(npm, root).name !== "@openai/codex") continue;
      const vendors = [root.canonical, path.join(path.dirname(root.canonical), "codex-win32-x64")];
      for (const vendor of vendors) {
        const directory = path.join(vendor, "vendor", WINDOWS_EXECUTOR_RELEASE.target, "codex");
        add(path.join(directory, "codex-exec-server.exe"), [], "installed");
        add(path.join(directory, "codex.exe"), ["exec-server"], "installed");
      }
    } catch (error) { rejected.push(`${location}: ${String(error)}`); }
  }
  try { add(windowsRuntimePath(options.agentDir), [], "managed"); }
  catch (error) { rejected.push(`Managed executor: ${String(error)}`); }
  if (candidates.length > 16) throw new Error("Too many installed executor candidates; remove ambiguous installations before preparing Windows containment");
  return { candidates, rejected };
}

async function assertPinnedRuntime(candidate: WindowsExecutorCandidate, signal?: AbortSignal): Promise<void> {
  if (candidate.source !== "managed") return;
  if (!await matchesArtifact(candidate.executable, WINDOWS_EXECUTOR_RELEASE, signal)) throw new Error("Managed executor does not match the shipped release pin");
  assertWindowsExecutorIdentity(candidate);
}

function executorEnvironment(directory: string): Record<string, string> {
  const system = windowsSystemDirectory();
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("Native MXC requires the host LOCALAPPDATA");
  const home = path.join(directory, "codex-home"); createWindowsPrivateDirectory(home);
  return { SystemRoot: path.dirname(system), WINDIR: path.dirname(system), SystemDrive: path.parse(system).root.slice(0, 2), LOCALAPPDATA: local,
    PATH: system, CODEX_HOME: home, TEMP: directory, TMP: directory };
}

function privateRuntimeRoot(agentDir: string): string {
  const agent = bindPath(agentDir);
  if (agent.missing.length || agent.identity.type !== "directory" || agent.lexical !== agent.canonical) throw new Error("Executor agent directory must exist without redirection");
  const permissions = path.join(agent.canonical, "permissions"); createWindowsPrivateDirectory(permissions);
  const runtime = path.join(permissions, "runtime"); createWindowsPrivateDirectory(runtime); return runtime;
}
function privateRuntimeDirectory(agentDir: string): string {
  let directory = privateRuntimeRoot(agentDir);
  for (const component of ["codex", WINDOWS_EXECUTOR_RELEASE.version, WINDOWS_EXECUTOR_RELEASE.target]) { directory = path.join(directory, component); createWindowsPrivateDirectory(directory); }
  return directory;
}

async function matchesArtifact(file: string, pin: { bytes: number; sha256: string }, signal?: AbortSignal): Promise<boolean> {
  const binding = bindPath(file); if (binding.missing.length) return false;
  if (binding.identity.type !== "file" || binding.lexical !== binding.canonical) throw new Error("Runtime artifact must be a regular, non-redirected cache file");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertWindowsTrustedFile(file, fd); const before = fstatSync(fd, { bigint: true });
    if (before.size !== BigInt(pin.bytes)) return false;
    const hash = createHash("sha256"); const buffer = Buffer.alloc(65536); let position = 0;
    while (position < pin.bytes) {
      signal?.throwIfAborted(); const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, pin.bytes - position), position);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes)); position += bytes; await immediate();
    }
    const after = fstatSync(fd, { bigint: true }); assertBinding(binding); signal?.throwIfAborted();
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error("Runtime artifact changed during verification");
    return position === pin.bytes && hash.digest("hex") === pin.sha256;
  } finally { closeSync(fd); }
}

export function windowsDownloadPreview(agentDir: string): { title: string; message: string } {
  const pin = WINDOWS_EXECUTOR_RELEASE;
  return { title: "Download Windows execution service?", message: `No compatible native MXC executor was prepared.\n\nSource: ${pin.url}\nVersion: ${pin.version}\nTarget: ${pin.target}\nSize: ${pin.bytes} bytes (${(pin.bytes / 1048576).toFixed(1)} MiB)\nSHA-256: ${pin.sha256}\nDestination: ${windowsRuntimePath(agentDir)}\n\nInstalls only the standalone execution service, not the Codex coding agent. No Codex login or elevation is required.\nDeclining leaves initialization in the warned unrestricted-filesystem/open-network fallback. /reload can retry.` };
}

function removeOwnedRuntimeFile(parent: PathBinding, file: string, held: ReturnType<typeof identity>): void {
  assertBinding(parent);
  if (!sameIdentity(held, identity(file))) throw new Error("Runtime publication file changed before cleanup");
  unlinkSync(file);
}

/** Cooperating publishers serialize only verification/publication, never network transfer or user approval. */
async function withRuntimeInstallLock<T>(parent: PathBinding, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(parent.canonical, ".install.lock"); const deadline = performance.now() + 30000; let fd: number | undefined;
  while (fd === undefined) {
    signal?.throwIfAborted(); assertBinding(parent);
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw new Error("Runtime installer is locked; stop other writers and verify an orphan before manual recovery");
      await delay(50, undefined, { signal });
    }
  }
  const held = identity(fd);
  try { assertWindowsPrivate(lock, false, fd); signal?.throwIfAborted(); assertBinding(parent); return await operation(); }
  finally {
    closeSync(fd);
    removeOwnedRuntimeFile(parent, lock, held);
  }
}

/** Publication is not execution approval: preparation independently enforces the shipped release pin. */
export async function acquireWindowsExecutor(options: WindowsExecutorOptions, operations: { fetch?: typeof globalThis.fetch; integrity?: { bytes: number; sha256: string } } = {}): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Standalone acquisition currently supports Windows x64 only");
  options.signal?.throwIfAborted();
  const pin = operations.integrity ?? WINDOWS_EXECUTOR_RELEASE;
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > 536870912 || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error("Invalid runtime integrity pin");
  const directory = privateRuntimeDirectory(options.agentDir); const parent = bindPath(directory);
  const target = path.join(directory, "codex-exec-server.exe");
  if (await withRuntimeInstallLock(parent, options.signal, () => matchesArtifact(target, pin, options.signal))) return;
  const temporary = path.join(directory, `.${randomUUID()}.partial`); const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const held = identity(fd); const cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(300000), ...(options.signal ? [options.signal] : [])]);
  let opened = true;
  try {
    const response = await (operations.fetch ?? globalThis.fetch)(WINDOWS_EXECUTOR_RELEASE.url, { signal, headers: { "Accept-Encoding": "identity" }, credentials: "omit" });
    if (response.status !== 200 || new URL(response.url).protocol !== "https:" || !response.body) throw new Error(`Runtime download returned an invalid response (${response.status})`);
    const length = response.headers.get("content-length");
    if (length !== null && length !== String(pin.bytes)) throw new Error("Runtime download length differs from its pin");
    let bytes = 0; const hash = createHash("sha256");
    for await (const chunk of response.body) {
      signal.throwIfAborted(); bytes += chunk.byteLength;
      if (bytes > pin.bytes) throw new Error("Runtime download exceeds its pinned size");
      hash.update(chunk);
      for (let offset = 0; offset < chunk.byteLength;) { const written = writeSync(fd, chunk, offset, Math.min(65536, chunk.byteLength - offset)); if (!written) throw new Error("Runtime download write made no progress"); offset += written; }
    }
    if (bytes !== pin.bytes || hash.digest("hex") !== pin.sha256) throw new Error("Runtime download failed size/digest verification");
    fsyncSync(fd); assertWindowsPrivate(temporary, false, fd); closeSync(fd); opened = false;
    await withRuntimeInstallLock(parent, signal, async () => {
      if (await matchesArtifact(target, pin, signal)) return;
      if (!sameIdentity(held, identity(temporary))) throw new Error("Staged runtime changed before publication");
      signal.throwIfAborted();
      if (existsSync(target)) renameSync(temporary, target);
      else { linkSync(temporary, target); unlinkSync(temporary); }
      if (!await matchesArtifact(target, pin, signal)) throw new Error("Published runtime failed integrity verification");
    });
  } finally {
    cancellation.abort(); if (opened) closeSync(fd);
    assertBinding(parent);
    if (existsSync(temporary)) removeOwnedRuntimeFile(parent, temporary, held);
  }
}

/** Only the root startup/explicit transition supplies consent; tools and inherited children never acquire services. */
export async function prepareWindowsExecutor(options: WindowsExecutorOptions, operations: Partial<WindowsPreparationOperations> = {}): Promise<PreparedWindowsExecutor> {
  try { return await prepareWindowsCandidate(options, operations); }
  catch (error) {
    if (!(error instanceof MissingWindowsExecutorError) || !options.approveDownload) throw error;
    options.signal?.throwIfAborted();
    if (!await options.approveDownload(windowsDownloadPreview(options.agentDir), options.signal)) throw new Error("Windows execution service download declined");
    options.signal?.throwIfAborted();
    await (operations.acquire ?? acquireWindowsExecutor)(options); options.signal?.throwIfAborted();
    return prepareWindowsCandidate(options, operations, true);
  }
}

/** Successful probes belong to this live connection and binary identity, never a persisted approval cache. */
async function prepareWindowsCandidate(options: WindowsExecutorOptions, operations: Partial<WindowsPreparationOperations>, managedOnly = false): Promise<PreparedWindowsExecutor> {
  options.signal?.throwIfAborted();
  if (options.decideNetwork && !options.networkRevision) throw new Error("Windows executor review requires the live root network revision");
  const policyTimeoutMs = options.policyTimeoutMs ?? 120000;
  if (!Number.isSafeInteger(policyTimeoutMs) || policyTimeoutMs < 1 || policyTimeoutMs > 2147478647) throw new Error("Invalid Windows approval deadline");
  const discovery = operations.discover ? operations.discover(options) : discoverWindowsExecutors(options, managedOnly ? [] : undefined);
  const runtime = privateRuntimeRoot(options.agentDir);
  const sessions = path.join(runtime, "sessions"); createWindowsPrivateDirectory(sessions);
  for (const candidate of discovery.candidates) {
    options.signal?.throwIfAborted();
    const directory = path.join(sessions, randomUUID()); createWindowsPrivateDirectory(directory);
    const binding = bindPath(directory); let client: WindowsRpcClient | undefined;
    try {
      if (candidate.source === "managed") privateRuntimeDirectory(options.agentDir);
      await assertPinnedRuntime(candidate, options.signal); assertWindowsExecutorIdentity(candidate);
      let probeReviews = 0; let probeRevision = 0; let probePort: number | undefined;
      const permitLoopback = (port?: number) => { probePort = port; probeRevision++; };
      let decide: NonNullable<WindowsRpcOptions["decideNetwork"]> = async ({ request }) => {
        probeReviews++; return { allow: request.host === "127.0.0.1" && request.port === probePort && request.protocol === "https_connect", revision: probeRevision };
      };
      let revision = () => probeRevision;
      const settings: WindowsRpcOptions = { executable: candidate.executable, prefixArgs: candidate.prefixArgs, cwd: directory,
        env: executorEnvironment(directory), requestTimeoutMs: Math.max(15000, policyTimeoutMs + 5000), policyTimeoutMs,
        decideNetwork: (request, signal) => decide(request, signal), networkRevision: () => revision() };
      client = operations.connect ? operations.connect(candidate, settings) : new WindowsRpcClient(settings);
      const response = await client.initialize(options.signal, 15000);
      const environment = response.environmentInfo as Record<string, unknown>;
      const capabilities = environment.capabilities as Record<string, unknown> | undefined;
      if (environment.platformOs !== "windows" || !capabilities || capabilities.windowsMxc !== true || capabilities.networkProxyLaunch !== true || capabilities.networkProxyReviewDomains !== true)
        throw new Error("Executor lacks required native MXC/managed-proxy/review capabilities");
      await (operations.verify ?? verifyWindowsExecutor)(client, directory, options.signal, permitLoopback);
      if (!probeReviews) throw new Error("Executor did not invoke live managed-network review during enforcement probes");
      assertWindowsExecutorIdentity(candidate); assertBinding(options.project); assertBinding(binding); options.signal?.throwIfAborted();
      decide = options.decideNetwork ?? (async () => ({ allow: false, revision: -1 })); revision = options.networkRevision ?? (() => -1);
      const prepared = client; let closing: Promise<void> | undefined;
      return { directory: binding, candidate, environment, client: prepared, assertIdentity: () => { assertBinding(options.project); assertBinding(binding); assertWindowsExecutorIdentity(candidate); },
        close: () => closing ??= (async () => { try { await prepared.close(); } finally { assertBinding(binding); rmSync(directory, { recursive: true }); } })() };
    } catch (error) {
      let retirement: unknown;
      try { await client?.close(); } catch (failure) { retirement = failure; }
      assertBinding(binding); rmSync(directory, { recursive: true }); options.signal?.throwIfAborted();
      if (retirement) throw new Error("Windows executor failed to retire after preparation failure", { cause: retirement });
      discovery.rejected.push(`${candidate.executable}: ${String(error)}`);
    }
  }
  throw new MissingWindowsExecutorError(discovery.rejected);
}

function policyEntry(file: string, access: "read" | "write" | "deny") {
  return { path: { type: "path", path: pathToFileURL(file).href }, access };
}

async function runProbe(client: WindowsRpcClient, directory: string, entries: ReturnType<typeof policyEntry>[], code: string, proxy: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const processId = `probe-${randomUUID()}`; let output = ""; let errors = ""; let exitCode: number | undefined;
  const abort = () => { void client.terminateProcess(processId).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const params: WindowsStartParams = { processId, argv: [bindPath(process.execPath).canonical, "-e", code], cwd: pathToFileURL(directory).href,
    env: { SystemRoot: path.dirname(windowsSystemDirectory()), TEMP: directory, TMP: directory }, sandbox: { permissions: { type: "managed", file_system: { type: "restricted", entries: [
      { path: { type: "special", value: { kind: "minimal" } }, access: "read" },
      policyEntry(bindPath(process.execPath).canonical, "read"), ...windowsSystemResources().map((file) => policyEntry(file, "read")), ...entries,
    ] }, network: "restricted" }, cwd: pathToFileURL(directory).href, workspaceRoots: [pathToFileURL(directory).href], windowsSandboxLevel: "mxc" } };
  if (proxy) {
    params.enforceManagedNetwork = true;
    params.networkProxy = { policyDecisionTimeoutMs: 1000, proxy: { enabled: true, credentialMasking: false, enableSocks5: false, enableSocks5Udp: false, allowUpstreamProxy: false,
      dangerouslyAllowAllUnixSockets: false, mode: "full", domains: {}, reviewDomains: ["*"], unixSockets: null, allowLocalBinding: true } };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.startProcess(params, (event) => {
      if (event.chunk) {
        if (event.stream === "stdout") output += event.chunk.toString("utf8"); else errors += event.chunk.toString("utf8");
        if (Buffer.byteLength(output) + Buffer.byteLength(errors) > 32768) throw new Error("Executor probe output exceeded its bound");
      }
      if (event.exitCode !== undefined) exitCode = event.exitCode;
    }, 15000);
    if (signal?.aborted) abort();
    await Promise.race([client.waitClosed(processId), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort(); reject(new Error("Executor enforcement probe deadline")); }, 8000); })]);
    signal?.throwIfAborted();
    if (exitCode !== 0) throw new Error(`Executor enforcement probe failed (${exitCode}): ${errors.slice(-2048)}${output.slice(-2048)}`);
    const result: unknown = JSON.parse(output.trim());
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Executor probe omitted structured results");
    return result as Record<string, unknown>;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** All destinations are synthetic files or a local listener; probes never need internet, login or elevation. */
export async function verifyWindowsExecutor(client: WindowsRpcClient, directory: string, signal: AbortSignal | undefined, permitLoopback: (port?: number) => void): Promise<void> {
  const project = path.join(directory, "project"); const outside = path.join(directory, "outside");
  const denied = path.join(project, "private"); const reopened = path.join(denied, "reopened");
  const system = windowsSystemDirectory(); const fsutil = path.join(system, "fsutil.exe"); assertWindowsTrustedFile(fsutil);
  for (const file of [project, outside]) {
    mkdirSync(file);
    const result = spawnSync(fsutil, ["file", "setCaseSensitiveInfo", file, "enable"], { cwd: system, env: { SystemRoot: path.dirname(system), PATH: system }, timeout: 3000, windowsHide: true });
    if (result.status !== 0) throw new Error("Could not establish a private NTFS case-family conformance fixture");
  }
  const equivalentDeny = path.join(project, "PRIVATE"); const equivalentReopen = path.join(equivalentDeny, "reopened");
  const caseGrant = path.join(outside, "Key"); const caseEquivalent = path.join(outside, "key"); const caseContrast = path.join(outside, "Key");
  for (const file of [denied, reopened, equivalentDeny, equivalentReopen, caseGrant, caseEquivalent, caseContrast]) mkdirSync(file);
  if (sameIdentity(bindPath(caseGrant).identity, bindPath(caseEquivalent).identity) || !contains({ canonical: caseGrant }, { canonical: caseEquivalent }) || contains({ canonical: caseGrant }, { canonical: caseContrast }))
    throw new Error("Could not establish distinct case-family/comparer controls");
  const token = randomUUID(); const other = `${token}-case`; const allowed = path.join(project, "allowed.txt"); const visible = path.join(reopened, "visible.txt");
  writeFileSync(allowed, token); writeFileSync(path.join(project, "ALLOWED.TXT"), other); writeFileSync(path.join(outside, "secret"), "outside");
  writeFileSync(path.join(denied, "secret"), "private"); writeFileSync(path.join(equivalentDeny, "secret"), "private-case"); writeFileSync(visible, token); writeFileSync(path.join(equivalentReopen, "visible.txt"), other);
  for (const [file, value] of [[caseGrant, token], [caseEquivalent, other], [caseContrast, "lookalike"]]) writeFileSync(path.join(file!, "data"), value!);
  const reads = { inside: allowed, caseAlias: path.join(project, "ALLOWED.TXT"), outside: path.join(outside, "secret"), denied: path.join(denied, "secret"), reopened: visible,
    caseGranted: path.join(caseGrant, "data"), caseEquivalent: path.join(caseEquivalent, "data"), caseContrast: path.join(caseContrast, "data"), caseDenied: path.join(equivalentDeny, "secret"), caseReopened: path.join(equivalentReopen, "visible.txt") };
  const writes = { inside: path.join(project, "created"), outside: path.join(outside, "created"), denied: path.join(denied, "created"), reopened: path.join(reopened, "created"),
    caseGranted: path.join(caseGrant, "created"), caseDenied: path.join(equivalentDeny, "created"), caseReopened: path.join(equivalentReopen, "created") };
  const code = `const fs=require('node:fs');const r={};for(const[k,p]of Object.entries(${JSON.stringify(reads)})){try{r[k]=fs.readFileSync(p,'utf8')}catch{r[k]=false}}for(const[k,p]of Object.entries(${JSON.stringify(writes)})){try{fs.writeFileSync(p,'probe');r[k+'Write']=true}catch{r[k+'Write']=false}}process.stdout.write(JSON.stringify(r));`;
  const result = await runProbe(client, project, [policyEntry(project, "write"), policyEntry(denied, "deny"), policyEntry(reopened, "read"), policyEntry(caseGrant, "read")], code, false, signal);
  if (result.inside !== token || result.caseAlias !== other || result.reopened !== token || result.outside !== false || result.denied !== false ||
    result.caseGranted !== token || result.caseEquivalent !== other || result.caseContrast !== false || result.caseDenied !== false || result.caseReopened !== other ||
    result.insideWrite !== true || Object.keys(writes).some((key) => key !== "inside" && result[`${key}Write`] !== false))
    throw new Error("Executor did not enforce required filesystem/case-family boundaries");
  const sockets = new Set<net.Socket>(); let closing = false;
  const listener = net.createServer((socket) => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => socket.destroy()); socket.end();
  });
  listener.maxConnections = 4;
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  try {
    const address = listener.address(); if (!address || typeof address === "string") throw new Error("Probe listener was not bound");
    const network = `const net=require('node:net');const r={};async function connect(host,port,payload){return await new Promise(resolve=>{let data='';const s=net.connect({host,port});s.setTimeout(1000);s.on('connect',()=>{if(!payload){s.destroy();resolve(true)}else s.write(payload)});s.on('data',b=>{data+=b;if(data.includes('\\r\\n\\r\\n')){s.destroy();resolve(data)}else if(data.length>8192){s.destroy();resolve(false)}});s.on('end',()=>resolve(data));s.on('error',()=>resolve(false));s.on('timeout',()=>{s.destroy();resolve(false)})})};(async()=>{r.direct=await connect('127.0.0.1',${address.port});if(process.env.HTTPS_PROXY){const p=new URL(process.env.HTTPS_PROXY);r.proxy=await connect(p.hostname,Number(p.port),'CONNECT 127.0.0.1:${address.port} HTTP/1.1\\r\\nHost: 127.0.0.1:${address.port}\\r\\n\\r\\n')}process.stdout.write(JSON.stringify(r))})()`;
    const restricted = await runProbe(client, project, [policyEntry(project, "write")], network, false, signal);
    if (restricted.direct !== false || restricted.proxy !== undefined) throw new Error("Executor restricted-network probe allowed direct host access");
    const managed = await runProbe(client, project, [policyEntry(project, "write")], network, true, signal);
    if (managed.direct !== true || typeof managed.proxy !== "string" || !managed.proxy.startsWith("HTTP/1.1 403"))
      throw new Error(`Executor managed-network review or accepted loopback behavior is incompatible: ${JSON.stringify(managed).slice(0, 512)}`);
    permitLoopback(address.port);
    const approved = await runProbe(client, project, [policyEntry(project, "write")], network, true, signal);
    if (approved.direct !== true || typeof approved.proxy !== "string" || !approved.proxy.startsWith("HTTP/1.1 200"))
      throw new Error("Executor did not honor a live synthetic network approval");
  } finally {
    permitLoopback(); closing = true; for (const socket of sockets) socket.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Executor probe listener cleanup deadline")), 1000);
        listener.close((error) => error ? reject(error) : resolve());
      });
    } finally { clearTimeout(timer); }
  }
  rmSync(project, { recursive: true }); rmSync(outside, { recursive: true });
}
