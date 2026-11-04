import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindPath, identity, sameIdentity } from "./paths.ts";
import { assertWindowsPrivate, assertWindowsTrustedFile, createWindowsPrivateDirectory, prepareWindowsComparison, windowsSystemDirectory } from "./windows-platform.ts";
import { acquireWindowsExecutor, assertWindowsExecutorIdentity, discoverWindowsExecutors, MissingWindowsExecutorError, prepareWindowsExecutor, verifyWindowsExecutor, WINDOWS_EXECUTOR_RELEASE, windowsRuntimePath, windowsDownloadPreview, type WindowsExecutorOptions, type WindowsPreparationOperations } from "./windows-executor.ts";
import { WindowsRpcClient, type WindowsStartParams, type WindowsProcessEvent } from "./windows-rpc.ts";
import { WindowsRuntime } from "./windows-runtime.ts";
import { createWindowsGrep } from "./windows-grep.ts";

const native = { skip: process.platform !== "win32" || process.arch !== "x64" };
const server = fileURLToPath(new URL("./fixtures/windows-exec-server.mjs", import.meta.url));
const capabilities = { windowsMxc: true, networkProxyLaunch: true, networkProxyReviewDomains: true };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "executor-")); const project = path.join(root, "project"); const agent = path.join(root, "agent"); const pkg = path.join(root, "package");
  for (const dir of [project, agent, path.join(pkg, "bin")]) mkdirSync(dir, { recursive: true });
  const manifest = path.join(pkg, "codex-package.json"); const executable = path.join(pkg, "bin", "codex-exec-server.exe");
  writeFileSync(manifest, JSON.stringify({ layoutVersion: 1, execServer: "bin/codex-exec-server.exe" })); writeFileSync(executable, "synthetic installed executable; never executed");
  const options: WindowsExecutorOptions = { project: bindPath(project), agentDir: agent, home: path.join(root, "empty-home"), env: { PATH: "", APPDATA: path.join(root, "empty-appdata") } };
  const scan = () => discoverWindowsExecutors(options, [pkg]);
  return { root, project, agent, pkg, manifest, executable, options, scan, sessions: () => readdirSync(path.join(agent, "permissions", "runtime", "sessions")), close: () => rmSync(root, { recursive: true, force: true }) };
}
function fake(f: ReturnType<typeof fixture>, environment: unknown = { platformOs: "windows", executorVersion: "0.0.0", capabilities }) {
  const clients: WindowsRpcClient[] = []; const settings: Parameters<WindowsPreparationOperations["connect"]>[1][] = [];
  const operations: WindowsPreparationOperations = {
    discover: f.scan,
    connect: (_candidate, options) => {
      settings.push(options);
      const client = new WindowsRpcClient({ ...options, executable: process.execPath, prefixArgs: [server], env: { ...options.env, PI_FAKE_EXECUTOR_MODE: "reverse-start", PI_FAKE_EXECUTOR_ENVIRONMENT: JSON.stringify(environment) } });
      clients.push(client); return client;
    },
    verify: async (client, directory) => {
      await client.startProcess({ processId: "gate", argv: ["synthetic"], cwd: pathToFileURL(directory).href, env: {}, sandbox: { windowsSandboxLevel: "mxc" }, networkProxy: { policyDecisionTimeoutMs: 1000 } }, () => {});
      await client.terminateProcess("gate"); await client.waitClosed("gate");
    },
  };
  return { clients, settings, operations };
}

const artifact = Buffer.from("synthetic standalone artifact; never executed");
const integrity = { bytes: artifact.length, sha256: createHash("sha256").update(artifact).digest("hex") };
function downloadResponse(body: ConstructorParameters<typeof Response>[0], headers?: Record<string, string>): Response {
  const response = new Response(body, { status: 200, headers }); Object.defineProperty(response, "url", { value: WINDOWS_EXECUTOR_RELEASE.url }); return response;
}

test("a replaced private executor namespace is rejected before grep helper creation", native, async () => {
  const f = fixture(); const driver = fake(f); const prepared = await prepareWindowsExecutor(f.options, driver.operations);
  const directory = prepared.directory.canonical; const moved = `${directory}-moved`;
  try {
    await prepared.client.close();
    renameSync(directory, moved); createWindowsPrivateDirectory(directory);
    // Keep liveness independent of the fake process's working-directory handle.
    const client = Object.create(prepared.client, { healthy: { value: true } }) as WindowsRpcClient;
    const runtime = new WindowsRuntime({ ...prepared, client });
    assert.throws(() => createWindowsGrep(runtime, bindPath(f.project)), /Filesystem identity changed/);
    assert.equal(existsSync(path.join(directory, "grep")), false);
  } finally {
    if (existsSync(moved)) { rmSync(directory, { recursive: true, force: true }); renameSync(moved, directory); }
    await prepared.close(); f.close();
  }
});

test("the shipped Windows release pin identifies only the measured standalone x64 artifact", () => {
  assert.equal(WINDOWS_EXECUTOR_RELEASE.bytes, 84244784);
  assert.match(WINDOWS_EXECUTOR_RELEASE.sha256, /^[a-f0-9]{64}$/);
  const url = new URL(WINDOWS_EXECUTOR_RELEASE.url);
  assert.equal(url.origin, "https://github.com"); assert.match(url.pathname, /\/openai\/codex\/releases\/download\/rust-v0\.166\.0\/codex-exec-server-x86_64-pc-windows-msvc\.exe$/);
});

test("discovery uses advertised standalone entries, rejects project packages and preserves executable fallback argv", native, () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.pkg, "bin", "codex.exe"), "synthetic");
    writeFileSync(f.manifest, JSON.stringify({ layoutVersion: 1, execServer: "bin/codex-exec-server.exe", entrypoint: "bin/codex.exe" }));
    writeFileSync(path.join(f.project, "codex-package.json"), readFileSync(f.manifest));
    const result = discoverWindowsExecutors(f.options, [f.project, f.pkg]);
    assert.equal(result.candidates.length, 2); assert.deepEqual(result.candidates.map((candidate) => candidate.prefixArgs), [[], ["exec-server"]]);
    assert.ok(result.candidates.every((candidate) => candidate.source === "installed" && candidate.executable.startsWith(f.pkg)));
  } finally { f.close(); }
});

test("PATH inspection ignores empty, relative and project entries without executing wrappers", native, () => {
  const f = fixture(); const descriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
  try {
    Object.defineProperty(process, "execPath", { ...descriptor, value: path.join(f.root, "empty-prefix", "node.exe") });
    f.options.env = { PATH: `;.;bin;${f.project};${path.join(f.pkg, "bin")}`, APPDATA: path.join(f.root, "empty-appdata") };
    const result = discoverWindowsExecutors(f.options);
    assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0]!.executable, f.executable);
    assert.equal(result.rejected.length, 0);
  } finally { Object.defineProperty(process, "execPath", descriptor); f.close(); }
});

test("unknown layouts, traversal, absolute entries and package junction escapes never become executable candidates", native, () => {
  const f = fixture();
  try {
    for (const manifest of [
      { layoutVersion: 9, execServer: "bin/codex-exec-server.exe" },
      { layoutVersion: 1, execServer: "../project/codex.exe" },
      { layoutVersion: 1, execServer: "C:codex.exe" },
      { layoutVersion: 1, execServer: path.join(windowsSystemDirectory(), "WindowsPowerShell", "v1.0", "powershell.exe") },
    ]) {
      writeFileSync(f.manifest, JSON.stringify(manifest)); const result = f.scan();
      assert.equal(result.candidates.length, 0); assert.equal(result.rejected.length, 1);
    }
    writeFileSync(f.manifest, Buffer.from([0xff])); assert.equal(f.scan().candidates.length, 0);
    rmSync(path.join(f.pkg, "bin"), { recursive: true }); writeFileSync(path.join(f.project, "codex.exe"), "project controlled");
    symlinkSync(f.project, path.join(f.pkg, "bin"), "junction"); writeFileSync(f.manifest, JSON.stringify({ layoutVersion: 1, execServer: "bin/codex.exe" }));
    assert.equal(f.scan().candidates.length, 0);
  } finally { f.close(); }
});

test("moving installation links resolve once to a pinned version rather than changing a live selection", native, () => {
  const f = fixture(); const current = path.join(f.root, "current"); const next = path.join(f.root, "next");
  try {
    mkdirSync(path.join(next, "bin"), { recursive: true }); writeFileSync(path.join(next, "codex-package.json"), readFileSync(f.manifest));
    writeFileSync(path.join(next, "bin", "codex-exec-server.exe"), "next synthetic version"); symlinkSync(f.pkg, current, "junction");
    const previous = discoverWindowsExecutors(f.options, [current]).candidates[0]!;
    assert.equal(previous.executable, f.executable); rmSync(current); symlinkSync(next, current, "junction");
    assertWindowsExecutorIdentity(previous);
    assert.equal(discoverWindowsExecutors(f.options, [current]).candidates[0]!.executable, path.join(next, "bin", "codex-exec-server.exe"));
  } finally { f.close(); }
});

test("installed code may be publicly readable but unrelated-user file or ancestor mutation is rejected", native, () => {
  const f = fixture(); const icacls = path.join(windowsSystemDirectory(), "icacls.exe");
  const grant = (file: string, rights: string) => { const result = spawnSync(icacls, [file, "/grant", `*S-1-1-0:${rights}`], { cwd: windowsSystemDirectory(), encoding: "utf8", timeout: 3000 }); assert.equal(result.status, 0, result.stderr); };
  try {
    grant(f.executable, "RX"); assertWindowsTrustedFile(f.executable); assert.throws(() => assertWindowsPrivate(f.executable, false));
    assertWindowsTrustedFile(path.join(windowsSystemDirectory(), "cmd.exe"));
    grant(f.executable, "W"); assert.throws(() => assertWindowsTrustedFile(f.executable), /mutation/); assert.equal(f.scan().candidates.length, 0);
    rmSync(f.executable); writeFileSync(f.executable, "synthetic");
    grant(f.pkg, "F"); assert.throws(() => assertWindowsTrustedFile(f.executable), /ancestor/);
  } finally { f.close(); }
});

test("capability-based preparation accepts version zero, keeps a minimal credential-free service environment and owns cleanup", native, async () => {
  const f = fixture(); const driver = fake(f);
  try {
    const prepared = await prepareWindowsExecutor(f.options, driver.operations);
    try {
      assert.equal(prepared.environment.executorVersion, "0.0.0"); assert.equal(prepared.client.healthy, true); prepared.assertIdentity();
      assert.deepEqual(Object.keys(driver.settings[0]!.env!).sort(), ["CODEX_HOME", "LOCALAPPDATA", "PATH", "SystemDrive", "SystemRoot", "TEMP", "TMP", "WINDIR"].sort());
      assert.ok(driver.settings[0]!.requestTimeoutMs! > driver.settings[0]!.policyTimeoutMs!);
      assert.equal(driver.settings[0]!.env!.LOCALAPPDATA, process.env.LOCALAPPDATA); assert.equal(f.sessions().length, 1);
      writeFileSync(f.executable, "changed"); assert.throws(() => prepared.assertIdentity(), /changed/);
    } finally { const closing = prepared.close(); assert.equal(prepared.close(), closing); await closing; }
    assert.equal(prepared.client.healthy, false); assert.deepEqual(f.sessions(), []);
  } finally { await Promise.allSettled(driver.clients.map((client) => client.close())); f.close(); }
});

test("unknown required native/proxy/review capabilities fail preparation before probes and retire the connection", native, async () => {
  const f = fixture();
  try {
    for (const environment of [
      { platformOs: "linux", capabilities }, { platformOs: "windows" },
      ...Object.keys(capabilities).map((key) => ({ platformOs: "windows", capabilities: { ...capabilities, [key]: false } })),
    ]) {
      const driver = fake(f, environment); let verified = false;
      driver.operations.verify = async () => { verified = true; };
      await assert.rejects(prepareWindowsExecutor(f.options, driver.operations), /required native/);
      assert.equal(verified, false); assert.ok(driver.clients.every((client) => !client.healthy)); assert.deepEqual(f.sessions(), []);
    }
  } finally { f.close(); }
});

test("probe success without actual review, probe failure and post-probe replacement cannot publish readiness", native, async () => {
  const f = fixture();
  try {
    for (const mode of ["no-review", "failed", "replaced"]) {
      const driver = fake(f); const verify = driver.operations.verify;
      driver.operations.verify = async (...args) => {
        if (mode === "no-review") return;
        if (mode === "failed") throw new Error("synthetic enforcement mismatch");
        await verify(...args); writeFileSync(f.executable, "replaced after successful probe");
      };
      await assert.rejects(prepareWindowsExecutor(f.options, driver.operations), MissingWindowsExecutorError);
      assert.ok(driver.clients.every((client) => !client.healthy)); assert.deepEqual(f.sessions(), []);
    }
  } finally { f.close(); }
});

test("root retirement during preparation aborts without leaving a live executor or synthetic session directory", native, async () => {
  const f = fixture(); const driver = fake(f); const controller = new AbortController();
  let entered!: () => void; const waiting = new Promise<void>((resolve) => { entered = resolve; });
  driver.operations.verify = async (_client, _directory, signal) => new Promise<void>((_resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); entered(); });
  try {
    const preparing = prepareWindowsExecutor({ ...f.options, signal: controller.signal }, driver.operations);
    await waiting; controller.abort(new Error("root retired")); await assert.rejects(preparing, /root retired/);
    assert.ok(driver.clients.every((client) => !client.healthy)); assert.deepEqual(f.sessions(), []);
  } finally { await Promise.allSettled(driver.clients.map((client) => client.close())); f.close(); }
});

test("local probe failure and cancellation destroy retained half-open peers before listener cleanup", native, async () => {
  const f = fixture(); prepareWindowsComparison();
  try {
    for (const mode of ["failed", "canceled"]) {
      const directory = path.join(f.root, mode); mkdirSync(directory); const controller = new AbortController();
      let peer: net.Socket | undefined; let calls = 0; let failureAt = 0;
      const client = {
        startProcess: async (params: WindowsStartParams, event: (event: WindowsProcessEvent) => void) => {
          let result: Record<string, unknown>;
          if (++calls === 1) {
            const project = fileURLToPath(params.cwd); const outside = path.join(directory, "outside");
            const read = (file: string) => readFileSync(file, "utf8");
            result = { inside: read(path.join(project, "allowed.txt")), caseAlias: read(path.join(project, "ALLOWED.TXT")), reopened: read(path.join(project, "private", "reopened", "visible.txt")),
              outside: false, denied: false, caseGranted: read(path.join(outside, "Key", "data")), caseEquivalent: read(path.join(outside, "key", "data")), caseContrast: false, caseDenied: false,
              caseReopened: read(path.join(project, "PRIVATE", "reopened", "visible.txt")), insideWrite: true, outsideWrite: false, deniedWrite: false, reopenedWrite: false, caseGrantedWrite: false, caseDeniedWrite: false, caseReopenedWrite: false };
          } else {
            const port = Number(/connect\('127\.0\.0\.1',(\d+)\)/.exec(params.argv.at(-1)!)![1]);
            peer = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true }); peer.on("error", () => {}); peer.resume();
            await once(peer, "end", { signal: AbortSignal.timeout(2000) }); assert.equal(peer.writableEnded, false); failureAt = performance.now();
            if (mode === "failed") throw new Error("synthetic failed probe");
            controller.abort(new Error("cancel probe")); result = { direct: false };
          }
          event({ method: "process/output", processId: params.processId, seq: 1, stream: "stdout", chunk: Buffer.from(JSON.stringify(result)) });
          event({ method: "process/exited", processId: params.processId, seq: 2, exitCode: 0 }); event({ method: "process/closed", processId: params.processId, seq: 3 });
        },
        waitClosed: async () => {}, terminateProcess: async () => {},
      } as unknown as WindowsRpcClient;
      try {
        await assert.rejects(verifyWindowsExecutor(client, directory, controller.signal, () => {}), mode === "failed" ? /synthetic failed probe/ : /cancel probe/);
        assert.ok(performance.now() - failureAt < 2000);
      } finally { peer?.destroy(); }
    }
  } finally { f.close(); }
});

test("root acquisition needs explicit consent and cancellation or refusal never invokes the downloader", native, async () => {
  const f = fixture();
  try {
    const preview = windowsDownloadPreview(f.agent);
    for (const value of [WINDOWS_EXECUTOR_RELEASE.url, WINDOWS_EXECUTOR_RELEASE.version, WINDOWS_EXECUTOR_RELEASE.target, String(WINDOWS_EXECUTOR_RELEASE.bytes), windowsRuntimePath(f.agent), "not the Codex coding agent", "unrestricted"])
      assert.ok(preview.message.includes(value));
    for (const mode of ["headless", "declined", "canceled", "failed"]) {
      let downloads = 0; const controller = new AbortController();
      const options: WindowsExecutorOptions = { ...f.options, signal: controller.signal };
      if (mode !== "headless") options.approveDownload = async () => { if (mode === "canceled") controller.abort(new Error("root retired")); return mode !== "declined"; };
      await assert.rejects(prepareWindowsExecutor(options, { discover: () => ({ candidates: [], rejected: [] }), acquire: async () => { downloads++; throw new Error("download failed"); } }));
      assert.equal(downloads, mode === "failed" ? 1 : 0);
    }
  } finally { f.close(); }
});

test("approved acquisition is followed by fresh preparation rather than treating download as readiness", native, async () => {
  const f = fixture(); const driver = fake(f); let scans = 0; const order: string[] = [];
  driver.operations.discover = () => ++scans === 1 ? { candidates: [], rejected: [] } : f.scan();
  driver.operations.acquire = async () => { order.push("acquire"); }; const verify = driver.operations.verify;
  driver.operations.verify = async (...args) => { order.push("verify"); await verify(...args); };
  try {
    const prepared = await prepareWindowsExecutor({ ...f.options, approveDownload: async () => { order.push("approve"); return true; } }, driver.operations);
    try { assert.equal(scans, 2); assert.deepEqual(order, ["approve", "acquire", "verify"]); assert.equal(prepared.client.healthy, true); }
    finally { await prepared.close(); }
  } finally { await Promise.allSettled(driver.clients.map((client) => client.close())); f.close(); }
});

test("download size/digest/header failures leave neither executable candidates nor partial files", native, async () => {
  const f = fixture();
  try {
    for (const mode of ["truncated", "oversized", "digest", "header"]) {
      const body = mode === "truncated" ? artifact.subarray(0, -1) : mode === "oversized" ? Buffer.concat([artifact, Buffer.from("x")]) : mode === "digest" ? Buffer.alloc(artifact.length, 65) : artifact;
      const fetcher: typeof fetch = async () => downloadResponse(body, mode === "header" ? { "content-length": "1" } : undefined);
      await assert.rejects(acquireWindowsExecutor(f.options, { integrity, fetch: fetcher }), /length|size|digest/);
      assert.deepEqual(readdirSync(path.dirname(windowsRuntimePath(f.agent))), []);
    }
  } finally { f.close(); }
});

test("canceling mid-stream removes a binary staging file and releases publication resources", native, async () => {
  const f = fixture(); const controller = new AbortController(); let reading!: () => void;
  const ready = new Promise<void>((resolve) => { reading = resolve; });
  const fetcher: typeof fetch = async (_input, init) => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(stream) { init!.signal!.addEventListener("abort", () => stream.error(init!.signal!.reason), { once: true }); },
      pull(stream) { if (++pulls === 1) stream.enqueue(artifact.subarray(0, 8)); else reading(); },
    }, { highWaterMark: 0 });
    return downloadResponse(body);
  };
  try {
    const downloading = acquireWindowsExecutor({ ...f.options, signal: controller.signal }, { integrity, fetch: fetcher });
    await ready; assert.ok(readdirSync(path.dirname(windowsRuntimePath(f.agent))).some((file) => file.endsWith(".partial")));
    controller.abort(new Error("root retired")); await assert.rejects(downloading, /retired|abort/i);
    assert.deepEqual(readdirSync(path.dirname(windowsRuntimePath(f.agent))), []);
  } finally { f.close(); }
});

test("concurrent publication keeps one verified winner, reuses it without network and atomically repairs only corrupt bytes", native, async () => {
  const f = fixture(); let requests = 0; let release!: () => void; const together = new Promise<void>((resolve) => { release = resolve; });
  const fetcher: typeof fetch = async () => { if (++requests === 2) release(); await together; return downloadResponse(artifact); };
  try {
    const target = windowsRuntimePath(f.agent);
    const installed = await Promise.all([1, 2].map(async () => { await acquireWindowsExecutor(f.options, { integrity, fetch: fetcher }); return identity(target); }));
    assert.equal(requests, 2); assert.ok(sameIdentity(installed[0]!, installed[1]!)); assert.equal(readFileSync(target, "utf8"), artifact.toString()); assertWindowsPrivate(target, false);
    assert.deepEqual(readdirSync(path.dirname(target)), ["codex-exec-server.exe"]);
    await acquireWindowsExecutor(f.options, { integrity, fetch: async () => { throw new Error("must reuse without network"); } });
    assert.ok(sameIdentity(installed[0]!, identity(target)));
    writeFileSync(target, Buffer.alloc(artifact.length, 65));
    await acquireWindowsExecutor(f.options, { integrity, fetch: async () => downloadResponse(artifact) });
    assert.equal(readFileSync(target, "utf8"), artifact.toString()); assert.equal(sameIdentity(installed[0]!, identity(target)), false);
    assert.deepEqual(readdirSync(path.dirname(target)), ["codex-exec-server.exe"]);
  } finally { f.close(); }
});

test("unsupported acquisition architecture is rejected before filesystem or network work", native, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "arch")!; let fetched = false;
  try {
    Object.defineProperty(process, "arch", { ...descriptor, value: "arm64" });
    await assert.rejects(acquireWindowsExecutor({ project: {} as WindowsExecutorOptions["project"], agentDir: "unused" }, { fetch: async () => { fetched = true; throw new Error("must not fetch"); } }), /Windows x64 only/);
    assert.equal(fetched, false);
  } finally { Object.defineProperty(process, "arch", descriptor); }
});

test("a corrupt private managed artifact is rejected before execution and is not repaired or trusted by a receipt", native, async () => {
  const f = fixture(); const driver = fake(f);
  try {
    const file = windowsRuntimePath(f.agent); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "corrupt");
    driver.operations.discover = (options) => discoverWindowsExecutors(options, []);
    await assert.rejects(prepareWindowsExecutor(f.options, driver.operations), /shipped release pin/);
    assert.equal(driver.clients.length, 0); assert.equal(readFileSync(file, "utf8"), "corrupt"); assert.deepEqual(f.sessions(), []);
  } finally { f.close(); }
});
