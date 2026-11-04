import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultConfig } from "./config-load.ts";
import { decide } from "./evaluation.ts";
import { NetworkSession } from "./network.ts";
import { bindFile, bindPath, contains, sameIdentity } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import { RuntimeCoordinator, type RuntimeFamily } from "./sandbox.ts";
import type { FilesystemSnapshot, PathRule } from "./schema.ts";
import { prepareWindowsExecutor, type PreparedWindowsExecutor } from "./windows-executor.ts";
import { prepareWindowsComparison, windowsSystemDirectory, windowsSystemResources } from "./windows-platform.ts";
import { WindowsRpcClient, type WindowsStartParams } from "./windows-rpc.ts";
import { compileWindowsFilesystem, directWindowsShellOperations, discoverWindowsShell, WindowsRuntime, windowsCommandEnvironment, windowsProcessParams, WINDOWS_FILESYSTEM_LIMITATION } from "./windows-runtime.ts";

const windows = { skip: process.platform !== "win32" };
const native = { skip: process.platform !== "win32" || process.env.PI_NATIVE_WINDOWS_MXC !== "1", timeout: 180000 };
function fixture(rules: PathRule[] = []) {
  prepareWindowsComparison();
  const root = mkdtempSync(path.join(tmpdir(), "windows-runtime-"));
  const project = path.join(root, "project"); mkdirSync(project);
  const config = defaultConfig(); config.pathRules = rules;
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  const snapshot = (): FilesystemSnapshot => {
    const catalog = resolveCatalog(config, { family: "test", binding: bindPath(project) }, { agentDir: root, home: root });
    return { revision: 0, root: catalog.root, mode: "project", profile: catalog.profiles.project!, rules: catalog.rules, grants: [], exceptions: [] };
  };
  return { root, project, config, snapshot, close: () => rmSync(root, { recursive: true, force: true }) };
}
function access(snapshot: FilesystemSnapshot, file: string) {
  const policy = compileWindowsFilesystem(snapshot); assert.equal(policy.type, "restricted");
  if (policy.type !== "restricted") throw new Error("Expected restricted policy");
  const target = bindPath(file);
  const matching = policy.entries.filter((entry) => contains({ canonical: fileURLToPath(entry.path.path) }, target));
  matching.sort((a, b) => fileURLToPath(b.path.path).split(path.sep).length - fileURLToPath(a.path.path).split(path.sep).length);
  return matching[0]?.access ?? "deny";
}

function fake(mode = "hold") {
  const client = new WindowsRpcClient({ executable: process.execPath, prefixArgs: [fileURLToPath(new URL("./fixtures/windows-exec-server.mjs", import.meta.url))], cwd: process.cwd(),
    env: { ...process.env, PI_FAKE_EXECUTOR_MODE: mode }, requestTimeoutMs: 1000, shutdownTimeoutMs: 100 });
  let closed = false;
  const runtime = new WindowsRuntime({ client, assertIdentity() {}, close: async () => { closed = true; await client.close(); } } as unknown as PreparedWindowsExecutor);
  const params: WindowsStartParams = { processId: randomUUID(), argv: ["synthetic"], cwd: "file:///C:/fixture", env: {}, sandbox: { windowsSandboxLevel: "mxc" } };
  return { client, runtime, params, closed: () => closed };
}

test("Windows compiler preserves most-specific read exceptions, deny ties and independent ask receipts", windows, () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.project, "private", "opened"), { recursive: true });
    f.config.pathRules = [
      { path: "private", scope: "tree", read: "deny" },
      { path: "private/opened", scope: "tree", read: "ask" },
      { path: "private/opened", scope: "tree", read: "ask" },
    ];
    let snapshot = f.snapshot(); const target = path.join(f.project, "private", "opened");
    assert.equal(access(snapshot, target), "deny");
    snapshot = { ...snapshot, exceptions: [{ id: "one", ruleId: snapshot.rules[1]!.id, access: "read", lifetime: "session" }] };
    assert.equal(access(snapshot, target), "deny");
    snapshot.exceptions.push({ id: "two", ruleId: snapshot.rules[2]!.id, access: "read", lifetime: "session" });
    assert.equal(access(snapshot, target), "read");
    assert.equal(decide(snapshot, bindPath(target), "write").action, "deny");
    snapshot = { ...snapshot, rules: [...snapshot.rules, { ...snapshot.rules[1]!, id: "hard", read: "deny" }] };
    assert.equal(access(snapshot, target), "deny");
  } finally { f.close(); }
});

test("Windows compiler keeps file grants nonrecursive and dormant positives do not grant parents", windows, () => {
  const f = fixture();
  try {
    const file = path.join(f.root, "selected.txt"); writeFileSync(file, "selected");
    f.config.pathRules = [{ path: path.join(f.root, "missing"), scope: "tree", read: "allow" }];
    const snapshot = f.snapshot(); snapshot.grants.push({ id: "file", binding: bindFile(bindPath(file)), access: "read", lifetime: "session" });
    const policy = compileWindowsFilesystem(snapshot); assert.equal(policy.type, "restricted");
    if (policy.type !== "restricted") return;
    assert.ok(policy.entries.some((entry) => fileURLToPath(entry.path.path) === file));
    assert.ok(!policy.entries.some((entry) => fileURLToPath(entry.path.path) === f.root || fileURLToPath(entry.path.path).endsWith("missing")));
    writeFileSync(file + ".replacement", "replacement");
    // Replacement of the regular leaf leaves its approved parent/name authority intact.
    renameSync(file + ".replacement", file);
    assert.doesNotThrow(() => compileWindowsFilesystem(snapshot));
  } finally { f.close(); }
});


test("unrepresentable missing file scope is rejected rather than widened", windows, () => {
  const f = fixture([{ path: "absent.txt", scope: "file", read: "deny" }]);
  try { assert.throws(() => compileWindowsFilesystem(f.snapshot()), /missing nonrecursive file/); }
  finally { f.close(); }
});

test("missing write-only deny/ask restrictions cannot silently retain inherited writes", windows, () => {
  for (const write of ["deny", "ask"] as const) {
    const f = fixture([{ path: "future", scope: "tree", write }]);
    try { assert.throws(() => compileWindowsFilesystem(f.snapshot()), /before its target exists/); }
    finally { f.close(); }
  }
});

test("future restrictions retain pinned ancestors and Windows yolo does not import Unix mounts", windows, () => {
  const f = fixture([{ path: "future/child", scope: "tree", read: "deny" }]);
  try {
    const snapshot = f.snapshot(); assert.equal(access(snapshot, path.join(f.project, "future", "child")), "deny");
    mkdirSync(path.join(f.project, "future")); mkdirSync(path.join(f.project, "future", "child"));
    assert.equal(access(snapshot, path.join(f.project, "future", "child")), "deny");
    const params = windowsProcessParams({ ...snapshot, profile: { kind: "unrestricted", grants: [] } }, ["synthetic"], f.project, {}, true);
    assert.deepEqual((params.sandbox.permissions as { file_system: unknown }).file_system, { type: "unrestricted" });
    assert.equal(params.networkProxy?.policyDecisionTimeoutMs, 120000);
    assert.ok(params.networkProxy);
    const proxy = params.networkProxy.proxy as { domains: unknown; reviewDomains: unknown };
    assert.deepEqual(proxy.domains, {}); assert.deepEqual(proxy.reviewDomains, ["*"]);
  } finally { f.close(); }
});

test("native shell discovery ignores project and relative PATH entries without invoking shadowed where.exe", windows, () => {
  const f = fixture(); const originalCwd = process.cwd(); const originalPath = process.env.PATH; const originalOptions = process.env.NODE_OPTIONS;
  try {
    const sentinel = path.join(f.project, "sentinel"); const preload = path.join(f.project, "preload.cjs");
    copyFileSync(process.execPath, path.join(f.project, "where.exe"));
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'shadow executed')`);
    for (const name of ["pwsh.exe", "bash.exe"]) writeFileSync(path.join(f.project, name), "not an installed executable");
    process.chdir(f.project); process.env.PATH = f.project; process.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
    const shell = discoverWindowsShell("powershell", bindPath(f.project), { env: { Path: `.;relative;${f.project}` } });
    assert.equal(shell.executable.canonical, bindPath(path.join(windowsSystemDirectory(), "WindowsPowerShell", "v1.0", "powershell.exe")).canonical);
    assert.throws(() => discoverWindowsShell("bash", bindPath(f.project), { env: { PATH: `.;relative;${f.project}` } }), /unavailable/);
    assert.throws(() => discoverWindowsShell("powershell", bindPath(f.project), { shellPath: path.join(f.project, "pwsh.exe") }), /outside the project/);
    assert.equal(existsSync(sentinel), false);
    const env = windowsCommandEnvironment(shell, { path: f.project, systemroot: f.project, SECRET_TOKEN: "secret", NODE_OPTIONS: "--require bad", HTTPS_PROXY: "bad", tEmP: f.root });
    assert.equal(env.SYSTEMROOT, path.dirname(windowsSystemDirectory())); assert.equal(env.TEMP, f.root);
    assert.equal(env.SECRET_TOKEN, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(Object.keys(env).filter((key) => key.toLowerCase() === "path").length, 1);
    const control = spawnSync(path.join(f.project, "where.exe"), ["-e", ""], { cwd: f.project, env: process.env, timeout: 3000 });
    assert.equal(control.status, 0, control.stderr?.toString()); assert.equal(existsSync(sentinel), true);
  } finally {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalOptions;
    f.close();
  }
});

test("Windows coordinator shares one prepared connection per family, never installs from a tool, and drains families independently", windows, async () => {
  const root = fixture(); const first = fake("complete"); const second = fake("complete"); const coordinator = new RuntimeCoordinator();
  const network = new NetworkSession({ default: "restricted", allowedDomains: ["allowed.example"], deniedDomains: [] }, () => {});
  const family: RuntimeFamily = { id: "one", network: () => network.snapshot(), decideHost: (host, port) => network.decide(host, port), decideHostWithRevision: (host, port, signal) => network.decideWithRevision(host, port, undefined, signal) };
  let preparations = 0;
  try {
    await first.client.initialize(); await second.client.initialize();
    const options = { project: bindPath(root.project), agentDir: root.root };
    await assert.rejects(coordinator.operations(root.snapshot(), family, () => {}, false, { kind: "powershell" }).exec("synthetic", root.project, { onData() {} }), /not prepared by the root/);
    const prepare = async (options: Parameters<typeof prepareWindowsExecutor>[0]) => {
      preparations++; assert.ok(options.decideNetwork); const decision = options.decideNetwork({ processId: "synthetic", request: { host: "allowed.example", port: 443, protocol: "https_connect" } }, new AbortController().signal);
      network.change({ deniedDomains: ["allowed.example"] }); assert.deepEqual(await decision, { allow: true, revision: 0 }); assert.equal(options.networkRevision!(), 1);
      return first.runtime.prepared;
    };
    await Promise.all([coordinator.prepareWindows(family, options, prepare), coordinator.prepareWindows(family, options, prepare)]);
    assert.equal(preparations, 1); assert.equal(coordinator.windowsRuntime("one")?.prepared.client, first.client);
    let checks = 0;
    await assert.rejects(coordinator.operations(root.snapshot(), family, () => { checks++; }, true, { kind: "powershell" }).exec("synthetic", root.project, { onData() {} }), /--no-sandbox/); assert.equal(checks, 0);
    assert.deepEqual(await coordinator.operations(root.snapshot(), family, () => { checks++; }, false, { kind: "powershell" }).exec("synthetic", root.project, { onData() {} }), { exitCode: 7 }); assert.equal(checks, 1); assert.equal(preparations, 1);
    await coordinator.prepareWindows({ ...family, id: "two" }, options, async () => second.runtime.prepared);
    await coordinator.shutdown("one"); assert.equal(first.client.healthy, false); assert.equal(second.client.healthy, true);
    await assert.rejects(coordinator.operations(root.snapshot(), family, () => {}, false, { kind: "powershell" }).exec("synthetic", root.project, { onData() {} }), /not prepared by the root/);
  } finally { await coordinator.shutdown("one"); await coordinator.shutdown("two"); await first.client.close().catch(() => {}); await second.client.close().catch(() => {}); root.close(); }
});

test("Windows direct PowerShell uses an absolute trusted interpreter without preparing MXC", windows, async () => {
  const root = fixture();
  try {
    const shell = discoverWindowsShell("powershell", bindPath(root.project), { env: {} }); let output = "";
    assert.deepEqual(await directWindowsShellOperations(shell).exec("[Console]::Write($env:PI_TEST_DIRECT_ENV); exit 6", root.project, { onData: (chunk) => { output += chunk; }, timeout: 10, env: { ...process.env, PI_TEST_DIRECT_ENV: "direct-native" } }), { exitCode: 6 });
    assert.equal(output, "direct-native");
    await assert.rejects(directWindowsShellOperations(shell).exec("Start-Sleep -Seconds 30", root.project, { onData() {}, timeout: 0.05 }), /timeout:/);
  } finally { root.close(); }
});

test("runtime streams output and preserves normal nonzero exits without replay", async () => {
  const f = fake("complete"); let output = ""; let checks = 0;
  try { await f.client.initialize(); assert.deepEqual(await f.runtime.exec(f.params, { onData: (chunk) => { output += chunk; } }, () => { checks++; }), { exitCode: 7 }); assert.match(output, /only workload output/); assert.equal(checks, 1); assert.equal(f.client.healthy, true); }
  finally { await f.client.close(); }
});

test("runtime drains cancellation and timeout and preserves the healthy root connection", async () => {
  for (const reason of ["abort", "timeout"]) {
    const f = fake(); const abort = new AbortController();
    try {
      await f.client.initialize(); const result = f.runtime.exec(f.params, { onData() {}, signal: abort.signal, timeout: reason === "timeout" ? 0.02 : undefined }, () => {});
      const assertion = assert.rejects(result, reason === "abort" ? /aborted/ : /timeout:/);
      if (reason === "abort") { await delay(20); abort.abort(); }
      await assertion; assert.equal(f.client.healthy, true);
    } finally { await f.client.close(); }
  }
});

test("a refusing executor is retired after bounded command cancellation without replay", { timeout: 9000 }, async () => {
  const f = fake("refuse-terminate");
  try {
    await f.client.initialize();
    await assert.rejects(f.runtime.exec(f.params, { onData() {}, timeout: 0.02 }, () => {}), /timeout:/);
    assert.equal(f.closed(), true); assert.equal(f.client.healthy, false);
  } finally { await f.client.close().catch(() => {}); }
});

test("runtime output callback failure retires the command rather than escaping the event loop", async () => {
  const f = fake("complete");
  try { await f.client.initialize(); await assert.rejects(f.runtime.exec(f.params, { onData() { throw new Error("consumer failed"); } }, () => {}), /consumer failed/); }
  finally { await f.client.close(); }
});

test("revision-tagged network decisions cannot be relabeled after an intervening policy change", async () => {
  const network = new NetworkSession({ default: "restricted", allowedDomains: ["allowed.example"], deniedDomains: [] }, () => {});
  const verdict = network.decideWithRevision("allowed.example");
  network.change({ deniedDomains: ["allowed.example"] });
  assert.deepEqual(await verdict, { allow: true, revision: 0 });
  assert.equal(network.snapshot().revision, 1);
  assert.deepEqual(await network.decideWithRevision("allowed.example"), { allow: false, revision: 1 });
  const approved = await network.decideWithRevision("new.example", 443, async () => "allow-session");
  assert.deepEqual(approved, { allow: true, revision: 2 });
});

test("native compiled case-family decisions agree with the evaluator, including mixed file/directory leaves", native, async () => {
  const f = fixture(); let prepared: PreparedWindowsExecutor | undefined;
  try {
    const outside = path.join(f.root, "outside"); mkdirSync(outside);
    for (const directory of [f.project, outside]) {
      const control = spawnSync(path.join(windowsSystemDirectory(), "fsutil.exe"), ["file", "setCaseSensitiveInfo", directory, "enable"], { windowsHide: true, timeout: 3000 });
      assert.equal(control.status, 0, control.stderr?.toString());
    }
    for (const name of ["private", "PRIVATE", "readonly"]) {
      mkdirSync(path.join(f.project, name, "opened"), { recursive: true });
      writeFileSync(path.join(f.project, name, "secret"), "synthetic"); writeFileSync(path.join(f.project, name, "opened", "data"), "visible");
    }
    for (const name of ["Key", "key", "Key"]) { mkdirSync(path.join(outside, name)); writeFileSync(path.join(outside, name, "data"), "synthetic"); }
    for (const name of ["approved.txt", "APPROVED.txt"]) writeFileSync(path.join(outside, name), "synthetic");
    mkdirSync(path.join(outside, "Approved.txt")); writeFileSync(path.join(outside, "Approved.txt", "child"), "not granted");
    assert.equal(sameIdentity(bindPath(path.join(outside, "Key")).identity, bindPath(path.join(outside, "key")).identity), false);
    f.config.pathRules = [{ path: "private", scope: "tree", read: "deny" }, { path: "private/opened", scope: "tree", read: "allow" }, { path: "readonly", scope: "tree", write: "deny" }];
    const snapshot = f.snapshot();
    snapshot.grants.push({ id: "file", binding: bindFile(bindPath(path.join(outside, "approved.txt"))), access: "write", lifetime: "session" });
    snapshot.profile = { ...snapshot.profile, grants: [...snapshot.profile.grants,
      { binding: bindPath(path.join(outside, "Key")), scope: "tree", access: "read" },
      ...[bindPath(process.execPath).canonical, ...windowsSystemResources()].map((file) => ({ binding: bindPath(file), scope: "file" as const, access: "read" as const, runtime: true as const }))] };
    const targets = ["private/secret", "PRIVATE/secret", "private/opened/data", "PRIVATE/opened/data", "readonly/secret"].map((file) => path.join(f.project, file));
    targets.push(...["Key/data", "key/data", "Key/data", "approved.txt", "APPROVED.txt", "Approved.txt/child"].map((file) => path.join(outside, file)));
    const expected = targets.map((file) => ({ read: decide(snapshot, bindPath(file), "read").action === "allow", write: decide(snapshot, bindPath(file), "write").action === "allow" }));
    prepared = await prepareWindowsExecutor({ project: bindPath(f.project), agentDir: f.root });
    const runtime = new WindowsRuntime(prepared); let output = "";
    const code = `const fs=require('node:fs');const r=${JSON.stringify(targets)}.map(p=>{const r={read:false,write:false};try{fs.readFileSync(p);r.read=true}catch{}try{fs.writeFileSync(p,'changed');r.write=true}catch{}return r});process.stdout.write(JSON.stringify(r))`;
    const params = windowsProcessParams(snapshot, [bindPath(process.execPath).canonical, "-e", code], f.project, { SYSTEMROOT: path.dirname(windowsSystemDirectory()) }, false);
    assert.deepEqual(await runtime.exec(params, { onData: (chunk) => { output += chunk; }, timeout: 20 }, () => {}), { exitCode: 0 });
    assert.deepEqual(JSON.parse(output), expected);
    const destination = path.join(outside, "junction-target"); mkdirSync(destination);
    symlinkSync(destination, path.join(f.project, "link"), "junction");
    const equivalent = path.join(f.project, "LINK"); mkdirSync(equivalent); writeFileSync(path.join(equivalent, "secret"), "synthetic");
    assert.equal(sameIdentity(bindPath(equivalent).identity, bindPath(path.join(f.project, "link")).identity), false);
    f.config.pathRules = [{ path: "link", scope: "tree", read: "deny" }];
    const aliases = f.snapshot();
    assert.equal(decide(aliases, bindPath(path.join(equivalent, "secret")), "read").action, "deny");
    assert.throws(() => compileWindowsFilesystem(aliases), /lexical and canonical restriction families/);
  } finally { await prepared?.close(); f.close(); }
});

test("native future-tree materialization preserves deny but cannot preserve a missing read-only boundary", native, async () => {
  const f = fixture(); let prepared: PreparedWindowsExecutor | undefined;
  try {
    prepared = await prepareWindowsExecutor({ project: bindPath(f.project), agentDir: f.root }); const runtime = new WindowsRuntime(prepared);
    for (const access of ["deny", "read"] as const) {
      const future = path.join(f.project, `future-${access}`); const child = path.join(future, "child");
      f.config.pathRules = access === "deny" ? [{ path: future, scope: "tree", read: "deny" }] : [{ path: future, scope: "tree", write: "deny" }];
      const snapshot = f.snapshot(); snapshot.profile = { ...snapshot.profile, grants: [...snapshot.profile.grants, ...[bindPath(process.execPath).canonical, ...windowsSystemResources()].map((file) => ({ binding: bindPath(file), scope: "file" as const, access: "read" as const, runtime: true as const }))] };
      if (access === "read") assert.throws(() => compileWindowsFilesystem(snapshot), /before its target exists/);
      const code = `const fs=require('node:fs');process.stdin.once('data',()=>{const r={};try{r.read=fs.readFileSync(${JSON.stringify(child)},'utf8')}catch(e){r.read=e.code}try{fs.writeFileSync(${JSON.stringify(child)},'changed');r.write=true}catch(e){r.write=e.code}process.stdout.write(JSON.stringify(r));process.exit(0)});process.stdout.write('READY\\n')`;
      const params = windowsProcessParams(access === "deny" ? snapshot : { ...snapshot, rules: [] }, [bindPath(process.execPath).canonical, "-e", code], f.project, { SYSTEMROOT: path.dirname(windowsSystemDirectory()) }, false);
      if (access === "read") {
        // Deliberately exercise the rejected raw representation, not the production compiler.
        const permissions = params.sandbox.permissions as { file_system: { entries: unknown[] } };
        permissions.file_system.entries.push({ path: { type: "path", path: pathToFileURL(future).href }, access });
      }
      params.pipeStdin = true; let output = ""; let ready!: () => void;
      const waiting = new Promise<void>((resolve) => { ready = resolve; });
      const running = runtime.exec(params, { onData: (chunk) => { output += chunk.toString(); if (output.includes("READY\n")) ready(); }, timeout: 15 }, () => {});
      try {
        await Promise.race([waiting, running.then(() => { throw new Error("Process closed before future-target handshake"); })]);
        mkdirSync(future); writeFileSync(child, "synthetic");
        await prepared.client.writeProcess(params.processId, Buffer.from("next")); assert.deepEqual(await running, { exitCode: 0 });
        assert.deepEqual(JSON.parse(output.slice(output.indexOf("\n") + 1)), access === "deny" ? { read: "EPERM", write: "EPERM" } : { read: "synthetic", write: true });
      } finally { await prepared.client.terminateProcess(params.processId); await running.catch(() => {}); }
    }
  } finally { await prepared?.close(); f.close(); }
});

test("native stalled stdin preserves reverse/control progress and cancellation retires running descendants", native, async () => {
  const f = fixture(); let prepared: PreparedWindowsExecutor | undefined; let running: Promise<void> | undefined; let feeding: Promise<void> | undefined;
  const wait = async (condition: () => boolean, label: string) => {
    const deadline = performance.now() + 8000;
    while (!condition()) { assert.ok(performance.now() < deadline, label); await delay(20); }
  };
  try {
    let reviews = 0;
    prepared = await prepareWindowsExecutor({ project: bindPath(f.project), agentDir: f.root, policyTimeoutMs: 1000,
      networkRevision: () => 0, decideNetwork: async () => { reviews++; return { allow: false, revision: 0 }; } });
    const runtime = new WindowsRuntime(prepared); const snapshot = f.snapshot();
    snapshot.profile = { ...snapshot.profile, grants: [...snapshot.profile.grants, ...[bindPath(process.execPath).canonical, ...windowsSystemResources()].map((file) => ({ binding: bindPath(file), scope: "file" as const, access: "read" as const, runtime: true as const }))] };
    const heartbeat = path.join(f.project, "descendant-heartbeat");
    const childCode = `const fs=require('node:fs');let n=0;fs.writeFileSync(${JSON.stringify(heartbeat)},String(n));console.log('CHILD:'+process.pid);setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n)),25)`;
    const code = `const net=require('node:net'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));setInterval(()=>{const p=new URL(process.env.HTTPS_PROXY);const s=net.connect({host:p.hostname,port:Number(p.port)});let data='';s.setTimeout(1000);s.on('connect',()=>s.write('CONNECT stall.example.invalid:443 HTTP/1.1\\r\\nHost: stall.example.invalid:443\\r\\n\\r\\n'));s.on('data',b=>{data+=b;if(data.includes('\\r\\n\\r\\n')){console.log('NETWORK:'+data.split(' ')[1]);s.destroy()}});s.on('error',()=>s.destroy());s.on('timeout',()=>s.destroy())},200)`;
    const params = windowsProcessParams(snapshot, [bindPath(process.execPath).canonical, "-e", code], f.project, { SYSTEMROOT: path.dirname(windowsSystemDirectory()) }, true); params.pipeStdin = true;
    let output = ""; let outcome: unknown; let feedDone = false; let accepted = 0; const cancellation = new AbortController();
    running = runtime.exec(params, { onData: (chunk) => { output += chunk.toString(); }, timeout: 45, signal: cancellation.signal }, () => {}).then((value) => { outcome = value; }, (error) => { outcome = error; });
    await wait(() => /CHILD:\d+/.test(output) || outcome !== undefined, "Native descendant did not start"); assert.equal(outcome, undefined, String(outcome));
    const pid = Number(output.match(/CHILD:(\d+)/)![1]); process.kill(pid, 0);
    const initial = readFileSync(heartbeat, "utf8"); await wait(() => readFileSync(heartbeat, "utf8") !== initial, "Descendant never produced a live heartbeat");
    const client = prepared.client; const chunk = Buffer.alloc(32768, 65);
    feeding = (async () => { for (let i = 0; i < 256; i++) { await client.writeProcess(params.processId, chunk); accepted++; } })().then(() => { feedDone = true; }, () => { feedDone = true; });
    await wait(() => accepted > 0 || feedDone, "Native input never accepted a chunk");
    let previous = accepted; let stable = performance.now();
    await wait(() => { if (accepted !== previous) { previous = accepted; stable = performance.now(); } return feedDone || performance.now() - stable >= 300; }, "Native input did not become backpressured");
    assert.equal(feedDone, false, "Native input completed before backpressure was established");
    const beforeReviews = reviews; const beforeOutput = output.length;
    await wait(() => reviews > beforeReviews && output.slice(beforeOutput).includes("NETWORK:403"), "Reverse decisions stalled behind native stdin");
    let readDone = false; let readError: unknown;
    const reading = client.readProcess(params.processId).then(() => { readDone = true; }, (error) => { readError = error; readDone = true; });
    await wait(() => readDone, "Native process/read stalled behind stdin"); await reading; assert.equal(readError, undefined); assert.equal(feedDone, false);
    const aborted = performance.now();
    cancellation.abort();
    await wait(() => outcome !== undefined && feedDone, "Native cancellation did not drain the stalled writer"); await running; await feeding;
    assert.match(String(outcome), /Operation aborted/); assert.ok(performance.now() - aborted < 8000); assert.equal(client.healthy, true);
    await wait(() => { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } }, "Native cancellation left its running descendant alive");
    const reuse = windowsProcessParams(snapshot, [bindPath(process.execPath).canonical, "-e", "process.stdout.write('healthy-after-cancel')"], f.project, { SYSTEMROOT: path.dirname(windowsSystemDirectory()) }, false);
    let reused = ""; assert.deepEqual(await runtime.exec(reuse, { onData: (chunk) => { reused += chunk; }, timeout: 10 }, () => {}), { exitCode: 0 }); assert.equal(reused, "healthy-after-cancel");
  } finally { await prepared?.close(); await running; await feeding; f.close(); }
});

test("native managed networking rechecks live allows, revocation and expiry in one running process", native, async () => {
  const f = fixture(); let prepared: PreparedWindowsExecutor | undefined;
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); socket.end(); });
  listener.maxConnections = 8;
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  try {
    const address = listener.address(); assert.ok(address && typeof address !== "string");
    const network = new NetworkSession({ default: "restricted", allowedDomains: ["127.0.0.1"], deniedDomains: [] }, () => {}); let reviews = 0;
    prepared = await prepareWindowsExecutor({ project: bindPath(f.project), agentDir: f.root, policyTimeoutMs: 1000, networkRevision: () => network.snapshot().revision,
      decideNetwork: ({ request }, signal) => { reviews++; return network.decideWithRevision(request.host, request.port, async (_host, _port, signal) => new Promise((resolve) => { signal!.addEventListener("abort", () => resolve("dismiss"), { once: true }); }), signal); } });
    const snapshot = f.snapshot(); snapshot.profile = { ...snapshot.profile, grants: [...snapshot.profile.grants, ...[bindPath(process.execPath).canonical, ...windowsSystemResources()].map((file) => ({ binding: bindPath(file), scope: "file" as const, access: "read" as const, runtime: true as const }))] };
    const code = `const net=require('node:net'),readline=require('node:readline');let n=0;async function run(){const p=new URL(process.env.HTTPS_PROXY);const r=await new Promise(resolve=>{let data='';const s=net.connect({host:p.hostname,port:Number(p.port)});s.setTimeout(5000);s.on('connect',()=>s.write('CONNECT 127.0.0.1:${address.port} HTTP/1.1\\r\\nHost: 127.0.0.1:${address.port}\\r\\n\\r\\n'));s.on('data',b=>{data+=b;if(data.includes('\\r\\n\\r\\n')){s.destroy();resolve(data.split(' ')[1])}});s.on('error',()=>resolve('error'));s.on('timeout',()=>{s.destroy();resolve('timeout')})});process.stdout.write(r+'\\n');if(++n===4)process.exit(0)}readline.createInterface({input:process.stdin}).on('line',()=>void run());void run()`;
    const params = windowsProcessParams(snapshot, [bindPath(process.execPath).canonical, "-e", code], f.project, { SYSTEMROOT: path.dirname(windowsSystemDirectory()) }, true);
    params.pipeStdin = true; params.networkProxy!.policyDecisionTimeoutMs = 1000;
    const lines: string[] = []; let buffer = ""; let wake: (() => void) | undefined;
    const runtime = new WindowsRuntime(prepared);
    const running = runtime.exec(params, { onData: (chunk) => { buffer += chunk.toString(); for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (/^(?:200|403|error|timeout)$/.test(line)) { lines.push(line); wake?.(); } } }, timeout: 30 }, () => {});
    void running.catch(() => { wake?.(); });
    const next = async () => {
      const deadline = AbortSignal.timeout(8000);
      while (!lines.length) await new Promise<void>((resolve, reject) => { const abort = () => reject(new Error("Missing native network result")); wake = () => { deadline.removeEventListener("abort", abort); resolve(); }; deadline.addEventListener("abort", abort, { once: true }); if (deadline.aborted) abort(); });
      return lines.shift();
    };
    try {
      assert.equal(await next(), "200");
      network.change({ deniedDomains: ["127.0.0.1"] }); await prepared.client.writeProcess(params.processId, Buffer.from("next\n")); assert.equal(await next(), "403");
      network.change({ deniedDomains: [], allowedDomains: ["127.0.0.1"] }); await prepared.client.writeProcess(params.processId, Buffer.from("next\n")); assert.equal(await next(), "200");
      network.change({ deniedDomains: [], allowedDomains: [] }); await prepared.client.writeProcess(params.processId, Buffer.from("next\n")); assert.equal(await next(), "403");
      assert.deepEqual(await running, { exitCode: 0 }); assert.equal(reviews, 4); assert.equal(prepared.client.healthy, true);
    } finally { await prepared.client.terminateProcess(params.processId); await running.catch(() => {}); }
  } finally {
    await prepared?.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve())); f.close();
  }
});

test("native compiled MXC policy denies ordinary access but explicitly retains the accepted ancestor-rename limitation", native, async () => {
  const f = fixture(); let prepared: PreparedWindowsExecutor | undefined;
  try {
    const parent = path.join(f.project, "parent"); mkdirSync(path.join(parent, "nested"), { recursive: true });
    const secret = path.join(parent, "nested", "secret.txt"); writeFileSync(secret, "synthetic-only");
    f.config.pathRules = [{ path: "parent/nested/secret.txt", scope: "file", read: "deny" }];
    let snapshot = f.snapshot();
    snapshot = { ...snapshot, profile: { ...snapshot.profile, grants: [...snapshot.profile.grants, ...[bindPath(process.execPath).canonical, ...windowsSystemResources()].map((file) => ({ binding: bindPath(file), access: "read" as const, scope: "file" as const, runtime: true as const }))] } };
    prepared = await prepareWindowsExecutor({ project: bindPath(f.project), agentDir: f.root });
    const runtime = new WindowsRuntime(prepared); const moved = path.join(f.project, "parent-moved");
    const code = `const fs=require('node:fs');const r={};try{fs.readFileSync(${JSON.stringify(secret)});r.beforeRead=true}catch(e){r.beforeRead=e.code}try{fs.writeFileSync(${JSON.stringify(secret)},'changed');r.beforeWrite=true}catch(e){r.beforeWrite=e.code}fs.renameSync(${JSON.stringify(parent)},${JSON.stringify(moved)});r.afterRead=fs.readFileSync(${JSON.stringify(path.join(moved, "nested", "secret.txt"))},'utf8');fs.writeFileSync(${JSON.stringify(path.join(moved, "nested", "secret.txt"))},'changed');r.afterWrite=true;process.stdout.write(JSON.stringify(r))`;
    let output = "";
    const params = windowsProcessParams(snapshot, [bindPath(process.execPath).canonical, "-e", code], f.project, { SYSTEMROOT: path.dirname(windowsSystemDirectory()) }, false);
    assert.deepEqual(await runtime.exec(params, { onData: (chunk) => { output += chunk; }, timeout: 20 }, () => {}), { exitCode: 0 });
    assert.deepEqual(JSON.parse(output), { beforeRead: "EPERM", beforeWrite: "EPERM", afterRead: "synthetic-only", afterWrite: true });
    assert.match(WINDOWS_FILESYSTEM_LIMITATION, /best-effort/);
    assert.match(readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8"), /parent-moved/);
    assert.throws(() => compileWindowsFilesystem(snapshot), /identity changed|unavailable/);
  } finally { await prepared?.close(); f.close(); }
});
