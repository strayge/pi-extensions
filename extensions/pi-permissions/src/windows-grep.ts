import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { bindPath, contains, resolvePermissionBinding } from "./paths.ts";
import type { FilesystemSnapshot, PathBinding } from "./schema.ts";
import { assertWindowsTrustedFile, createWindowsPrivateDirectory, windowsSystemDirectory } from "./windows-platform.ts";
import { windowsRuntimeResources } from "./windows-resources.ts";
import { windowsProcessParams, type WindowsRuntime } from "./windows-runtime.ts";

const CHUNK = 32768;
export interface WindowsGrepOptions { ignoreCase?: boolean; literal?: boolean; limit?: number }

/** Inspect installed native files only; wrappers and downloaders are never executed to discover ripgrep. */
export function discoverWindowsRipgrep(project: PathBinding): PathBinding {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  const directories = (process.env[pathKey ?? "PATH"] ?? "").split(path.delimiter).filter((entry) => /^[a-z]:[\\/]/i.test(entry));
  const candidates = [path.join(getAgentDir(), "bin", "rg.exe"), path.join(homedir(), "scoop", "apps", "ripgrep", "current", "rg.exe")];
  for (const directory of directories) {
    if (path.basename(directory).toLowerCase() === "shims") candidates.push(path.join(path.dirname(directory), "apps", "ripgrep", "current", "rg.exe"));
  }
  candidates.push(...directories.map((directory) => path.join(directory, "rg.exe")));
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || contains({ canonical: project.lexical }, { canonical: candidate })) continue;
      const binding = bindPath(candidate);
      if (binding.identity.type !== "file" || contains(project, binding)) continue;
      assertWindowsTrustedFile(binding.canonical);
      return bindPath(binding.canonical);
    } catch { /* An unsafe or unavailable candidate is not an execution facility. */ }
  }
  throw new Error("Windows grep requires an existing trusted native rg.exe outside the project. Install ripgrep or provide Pi's managed binary, then /reload; no unrestricted search fallback is used.");
}

/** One search resolves and pins facilities once; no metadata helper is launched for each candidate file. */
export function createWindowsGrep(native: WindowsRuntime, project: PathBinding) {
  native.prepared.assertIdentity();
  if (!native.prepared.client.healthy) throw new Error("Windows grep executor is unhealthy; /reload is required");
  let resources = native.bootstrapResources.get("grep");
  if (!resources) {
    const rg = discoverWindowsRipgrep(project);
    const bridge = bindPath(fileURLToPath(new URL("./windows-grep-bridge.mjs", import.meta.url)));
    const directory = path.join(native.prepared.directory.canonical, "grep"); createWindowsPrivateDirectory(directory);
    const all = [...windowsRuntimeResources(bindPath(process.execPath).canonical, [bridge.canonical]), ...windowsRuntimeResources(rg.canonical)];
    all.push({ binding: bindPath(directory), scope: "tree", access: "read", runtime: true, definition: "windows-grep:cwd" });
    resources = [...new Map(all.map((resource) => [resource.binding.canonical, resource])).values()];
    const executable = resources.find((resource) => resource.binding.canonical === rg.canonical)!;
    executable.definition = "windows-grep:executable";
    native.bootstrapResources.set("grep", resources);
  }
  const rg = resources.find((resource) => resource.definition === "windows-grep:executable")!.binding.canonical;
  const node = bindPath(process.execPath).canonical;
  const bridge = fileURLToPath(new URL("./windows-grep-bridge.mjs", import.meta.url));
  const pinned = resources;
  const cwd = resources.find((resource) => resource.definition === "windows-grep:cwd")!.binding.canonical;
  return async (input: Buffer | string, pattern: string, options: WindowsGrepOptions, signal: AbortSignal | undefined, beforeRead: () => void): Promise<number[]> => {
    signal?.throwIfAborted(); beforeRead();
    for (const resource of pinned) resolvePermissionBinding(resource.binding);
    const args = ["--no-config", "--json", "--line-number", "--color=never", "--max-count", String(Math.max(1, options.limit ?? 100)), ...(options.ignoreCase ? ["--ignore-case"] : []), ...(options.literal ? ["--fixed-strings"] : []), "--", pattern];
    const snapshot: FilesystemSnapshot = { revision: 0, root: { family: "grep-facilities", binding: project }, mode: "grep", profile: { kind: "scoped", grants: pinned }, rules: [], grants: [], exceptions: [] };
    // Fixed canonical entry paths avoid Node's drive-root realpath probes without granting drive-wide reads.
    const params = windowsProcessParams(snapshot, [node, "--preserve-symlinks", "--preserve-symlinks-main", bridge, rg, JSON.stringify(args)], cwd, { SYSTEMROOT: path.dirname(windowsSystemDirectory()) }, true);
    params.pipeStdin = true; params.enforceManagedNetwork = false; delete params.networkProxy;
    const client = native.prepared.client; const matches: number[] = [];
    let pending = ""; let diagnostic = ""; let ready!: () => void; let rejectReady!: (error: unknown) => void;
    const waiting = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; }); void waiting.catch(() => {});
    const controller = new AbortController(); const inputSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    let stream: ReturnType<typeof createReadStream> | undefined;
    const running = native.exec(params, { signal: inputSignal, timeout: 60, onData: (chunk) => {
      pending += chunk.toString("utf8");
      if (Buffer.byteLength(pending) > 2 * 1024 * 1024) throw new Error("Windows grep output record exceeds its bound");
      for (;;) {
        const end = pending.indexOf("\n"); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let event: { type?: string; data?: { line_number?: number } };
        try { event = JSON.parse(line); } catch { diagnostic = (diagnostic + line + "\n").slice(-8192); continue; }
        if (event.type === "pi-grep-ready") ready();
        else if (event.type === "match") {
          const number = event.data?.line_number;
          if (!Number.isSafeInteger(number) || number! < 1) throw new Error("Windows grep returned an invalid line number");
          if (matches.length < Math.max(1, options.limit ?? 100)) matches.push(number!);
        }
      }
    } }, () => { beforeRead(); for (const resource of pinned) resolvePermissionBinding(resource.binding); });
    void running.then((result) => rejectReady(new Error(diagnostic || pending || `Windows grep closed before input readiness (${result.exitCode})`)), rejectReady);
    const feed = (async () => {
      await waiting; inputSignal.throwIfAborted(); beforeRead();
      if (typeof input === "string") stream = createReadStream(input, { signal: inputSignal, highWaterMark: CHUNK });
      const chunks: AsyncIterable<Buffer> = stream ?? (async function* () { for (let offset = 0; offset < input.length; offset += CHUNK) yield (input as Buffer).subarray(offset, offset + CHUNK); })();
      for await (const chunk of chunks) {
        inputSignal.throwIfAborted(); beforeRead();
        const frame = Buffer.allocUnsafe(4 + chunk.length); frame.writeUInt32BE(chunk.length); chunk.copy(frame, 4);
        await client.writeProcess(params.processId, frame);
      }
      inputSignal.throwIfAborted(); const end = Buffer.alloc(4); end.writeUInt32BE(0xffffffff); await client.writeProcess(params.processId, end);
    })();
    void feed.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([running, feed.then(() => running)]);
      controller.abort(); stream?.destroy();
      const error = await Promise.race([feed.then(() => undefined, (error: unknown) => error), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Windows grep input did not drain")), 5000); })]);
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(diagnostic || `ripgrep failed (${result.exitCode})`);
      if (error && !(error instanceof Error && /not accepting input|stdinClosed|unknownProcess|aborted/i.test(error.message))) throw error;
      signal?.throwIfAborted(); beforeRead(); return matches;
    } catch (error) {
      clearTimeout(timer); controller.abort(); stream?.destroy();
      await client.terminateProcess(params.processId).catch(() => {}); await running.catch(() => {});
      await Promise.race([feed.catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(() => { void native.prepared.close().catch(() => {}).finally(resolve); }, 5000); })]);
      if (signal?.aborted) throw new Error("Operation aborted");
      throw error;
    } finally { clearTimeout(timer); controller.abort(); stream?.destroy(); }
  };
}
