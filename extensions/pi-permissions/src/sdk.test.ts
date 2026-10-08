import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  type CreateAgentSessionRuntimeFactory,
  createEventBus,
  initTheme,
  DefaultResourceLoader,
  type ExtensionUIContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import permissionExtension, { type PermissionBridgeRequest } from "./index.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import { GlobalPolicyWriter } from "./policy-write.ts";
import { runtime } from "./sandbox.ts";

/** Real Pi loading and tool dispatch need no provider request or personal policy edits. */
test("isolated SDK child keeps inherited direct and shell enforcement and sees parent grant/revoke", async () => {
  initTheme("dark");
  const dir = mkdtempSync(path.join(tmpdir(), "permission-sdk-"));
  const project = path.join(dir, "project");
  const outside = path.join(dir, "outside");
  const agentDir = path.join(dir, "agent");
  for (const value of [project, outside, agentDir]) mkdirSync(value);
  writeFileSync(path.join(outside, "sentinel"), "shared-live-grant");
  const config = defaultConfig();
  config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
  config.modes.subproject = config.modes.project!;
  const root = { family: randomUUID(), binding: bindPath(project) };
  const resolution = { agentDir, home: dir };
  mkdirSync(path.join(agentDir, "permissions"), { mode: 0o700 });
  writeFileSync(path.join(agentDir, "permissions", "config.json"), JSON.stringify(config), { mode: 0o600 });
  const owner = new PermissionOwner(resolveCatalog(config, root, resolution), {
    ask: async () => undefined, policyWriter: new GlobalPolicyWriter(resolution), confirmGlobal: async () => true,
  });
  const loader = new DefaultResourceLoader({
    cwd: outside,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => permissionExtension(pi, { owner, release: () => {} })],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: outside,
    agentDir,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(outside),
    tools: ["read", "bash"],
  });
  try {
    await session.bindExtensions({});
    const read = session.agent.state.tools.find((tool) => tool.name === "read")!;
    assert.ok(read);
    const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
    await assert.rejects(read.execute("denied", { path: "sentinel" }), /denied/);
    await assert.rejects(bash.execute("shell-denied", { command: "cat sentinel" }), /denied/);
    owner.ask = async () => ({ lifetime: "session" });
    await owner.requestDirectory(outside, "read", "parent grant");
    owner.ask = async () => undefined;
    const result = await read.execute("allowed", { path: "sentinel" });
    assert.match(JSON.stringify(result.content), /shared-live-grant/);
    const shellResult = await bash.execute("shell-allowed", { command: "cat sentinel", timeout: 10 });
    assert.match(JSON.stringify(shellResult.content), /shared-live-grant/);
    owner.revoke();
    await assert.rejects(read.execute("revoked", { path: "sentinel" }), /denied/);
    await assert.rejects(bash.execute("shell-revoked", { command: "cat sentinel" }), /denied/);
    owner.ask = async () => ({ lifetime: "global" });
    await owner.requestDirectory(outside, "read", "global parent grant");
    owner.ask = async () => undefined;
    assert.equal(owner.snapshot().grants.length, 0);
    assert.match(JSON.stringify((await read.execute("global", { path: "sentinel" })).content), /shared-live-grant/);
    assert.match(JSON.stringify((await bash.execute("global-shell", { command: "cat sentinel", timeout: 10 })).content), /shared-live-grant/);
    owner.ask = async () => ({ action: "block" });
    await assert.rejects(owner.requestDirectory(outside, "read", "parent session block"), /blocked/);
    owner.ask = async () => assert.fail("Children must use the root's live denial without another dialog");
    await assert.rejects(read.execute("blocked-child", { path: "sentinel" }), /denied/);
    await assert.rejects(bash.execute("blocked-child-shell", { command: "cat sentinel" }), /denied/);
    await owner.changeGlobal({ kind: "clear" });
    assert.equal(owner.sessionBlocks.length, 1);
    await assert.rejects(read.execute("global-revoked", { path: "sentinel" }), /denied/);
    owner.revoke(owner.sessionBlocks[0]!.id);
    let entered!: () => void; let answer!: (value: { lifetime: "session" }) => void;
    const prompting = new Promise<void>((resolve) => { entered = resolve; });
    owner.ask = () => { entered(); return new Promise((resolve) => { answer = resolve; }); };
    const stale = read.execute("stale-child", { path: "sentinel" });
    await prompting;
    await owner.changeGlobal({ kind: "save", scope: "tree", binding: bindPath(outside), access: "read" });
    answer({ lifetime: "session" });
    assert.match(JSON.stringify((await stale).content), /shared-live-grant/);
    assert.equal(owner.snapshot().grants.length, 0);
    assert.ok(!session.getAllTools().some((tool) => tool.name === "show_plan"));
  } finally {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    // This fixture supplies the parent owner; child shutdown does not retire its runtime.
    await runtime.shutdown(owner.id);
    session.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi's actual extension loader keeps stock tools usable when root policy initialization fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-fallback-sdk-"));
  const project = path.join(dir, "project"); const outside = path.join(dir, "outside"); const agentDir = path.join(dir, "agent");
  for (const value of [project, outside, agentDir, path.join(agentDir, "permissions")]) mkdirSync(value, { mode: 0o700 });
  writeFileSync(path.join(agentDir, "permissions", "config.json"), '{"version":0}', { mode: 0o600 });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: project, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(project), tools: ["read", "write", "bash"],
    }));
    await session.bindExtensions({});
    const tool = (name: string) => session!.agent.state.tools.find((tool) => tool.name === name)!;
    const file = path.join(outside, "sentinel");
    await tool("write").execute("write", { path: file, content: "unrestricted" });
    assert.match(JSON.stringify((await tool("read").execute("read", { path: file })).content), /unrestricted/);
    assert.match(JSON.stringify((await tool("bash").execute("bash", { command: `cat ${JSON.stringify(file)}` })).content), /unrestricted/);
  } finally {
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real loader refreshes runtime resources on reload and restores pathname grants after a fresh root", async () => {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-restart-sdk-"))).canonical;
  const project = path.join(dir, "project"); const outside = path.join(dir, "outside");
  const agentDir = path.join(dir, "agent"); const piPackage = path.join(dir, "pi-runtime");
  for (const value of [project, outside, agentDir, piPackage, path.join(project, ".pi"), path.join(agentDir, "permissions")]) mkdirSync(value, { mode: 0o700 });
  const entry = path.join(piPackage, "cli.js");
  const manifest = JSON.stringify({ name: "@earendil-works/pi-coding-agent" });
  writeFileSync(entry, ""); writeFileSync(path.join(piPackage, "package.json"), manifest);
  const config = defaultConfig(); config.pathRules = [{ path: "credential", scope: "file", read: "deny" }];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["pi"] };
  config.modes.subproject = config.modes.project!;
  writeFileSync(path.join(agentDir, "permissions", "config.json"), JSON.stringify(config), { mode: 0o600 });
  mkdirSync(path.join(project, ".pi", "permissions"));
  writeFileSync(path.join(project, ".pi", "permissions", "config.json"), '{"version":3,"defaultMode":"yolo"}');
  writeFileSync(path.join(outside, "sentinel"), "original");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR; const previousHome = process.env.HOME; const previousEntry = process.argv[1];
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.HOME = dir; process.argv[1] = entry;
  let allow = true;
  const notifications: string[] = [];
  const ui = new Proxy({
    select: async (_title: string, options: string[]) => allow ? options.find((option) => option === "Remember for this project") ?? options[0] : undefined,
    notify: (text: string) => notifications.push(text), theme: { fg: (_color: string, text: string) => text },
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ExtensionUIContext;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const load = async () => {
    const loader = new DefaultResourceLoader({ cwd: project, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: project, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(project), tools: ["read", "write"] }));
    await session.bindExtensions({ uiContext: ui });
  };
  const tool = (name: string) => session!.agent.state.tools.find((tool) => tool.name === name)!;
  try {
    await load();
    await tool("read").execute("remember", { path: path.join(outside, "sentinel") });
    allow = false;
    renameSync(piPackage, `${piPackage}-old`); mkdirSync(piPackage);
    writeFileSync(entry, ""); writeFileSync(path.join(piPackage, "package.json"), manifest);
    writeFileSync(path.join(piPackage, "updated"), "runtime refreshed");
    await session!.extensionRunner!.emit({ type: "session_start", reason: "reload" });
    assert.match(JSON.stringify((await tool("read").execute("runtime", { path: path.join(piPackage, "updated") })).content), /runtime refreshed/);
    await session!.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" }); session!.dispose(); session = undefined;
    renameSync(project, `${project}-old`); mkdirSync(project); mkdirSync(path.join(project, ".pi"));
    mkdirSync(path.join(project, ".pi", "permissions"));
    writeFileSync(path.join(project, ".pi", "permissions", "config.json"), '{"version":3,"defaultMode":"yolo"}'); writeFileSync(path.join(project, "credential"), "secret");
    renameSync(outside, `${outside}-old`); mkdirSync(outside); writeFileSync(path.join(outside, "sentinel"), "restored pathname grant");
    await load();
    assert.match(JSON.stringify((await tool("read").execute("restore", { path: path.join(outside, "sentinel") })).content), /restored pathname grant/);
    await assert.rejects(tool("write").execute("readonly", { path: path.join(outside, "denied"), content: "no" }), /denied|approval/i);
    await assert.rejects(tool("read").execute("protected", { path: path.join(project, "credential") }), /denied/i);
    assert.doesNotMatch(notifications.join("\n"), /restrictions are disabled|failed to initialize/i);
  } finally {
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    process.argv[1] = previousEntry;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real root SDK session switches retire child leases and cannot inherit session grants", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-root-sdk-"));
  const project = path.join(dir, "project"); const outside = path.join(dir, "outside"); const agentDir = path.join(dir, "agent");
  for (const value of [project, outside, agentDir]) mkdirSync(value, { mode: 0o700 });
  mkdirSync(path.join(agentDir, "permissions"), { mode: 0o700 });
  writeFileSync(path.join(outside, "sentinel"), "session-only");
  const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  writeFileSync(path.join(agentDir, "permissions", "config.json"), JSON.stringify(config), { mode: 0o600 });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const events = createEventBus();
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: SettingsManager.inMemory(), resourceLoaderOptions: { eventBus: events, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [permissionExtension] } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["read", "request_directory_access"] });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  let allow = true;
  const ui = new Proxy({ select: async (_title: string, options: string[]) => allow ? options[0] : undefined, theme: { fg: (_color: string, text: string) => text } }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ExtensionUIContext;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  try {
    runtime = await createAgentSessionRuntime(factory, { cwd: project, agentDir, sessionManager: SessionManager.inMemory(project) });
    runtime.setRebindSession(async (next) => { session = next; await next.bindExtensions({ uiContext: ui }); });
    session = runtime.session;
    await session.bindExtensions({ uiContext: ui });
    const read = () => session!.agent.state.tools.find((tool) => tool.name === "read")!;
    await read().execute("grant", { path: path.join(outside, "sentinel") });
    allow = false;
    assert.match(JSON.stringify((await read().execute("reuse", { path: path.join(outside, "sentinel") })).content), /session-only/);
    let attachment: Parameters<PermissionBridgeRequest["respond"]>[0] | undefined;
    events.emit("permission:attach:v2", { version: 2, parentSessionId: session.sessionManager.getSessionId(), cancel: () => attachment?.release(), respond: (value: typeof attachment) => { attachment = value; }, reject: (reason: string) => { throw new Error(reason); } });
    assert.ok(attachment);
    await runtime.newSession();
    assert.throws(() => attachment!.resume(() => {}), /unavailable/);
    await assert.rejects(read().execute("fresh", { path: path.join(outside, "sentinel") }), /denied/);
  } finally {
    await runtime?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
