import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  type CreateAgentSessionRuntimeFactory,
  createEventBus,
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

/** Real Pi loading and tool dispatch need no provider request or personal policy edits. */
test("isolated SDK child keeps inherited direct-tool enforcement and sees parent grant/revoke", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-sdk-"));
  const project = path.join(dir, "project");
  const outside = path.join(dir, "outside");
  const agentDir = path.join(dir, "agent");
  for (const value of [project, outside, agentDir]) mkdirSync(value);
  writeFileSync(path.join(outside, "sentinel"), "shared-live-grant");
  const config = defaultConfig();
  config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  const root = { family: randomUUID(), binding: bindPath(project) };
  const owner = new PermissionOwner(resolveCatalog(config, root, { agentDir, home: dir }), {
    ask: async () => undefined,
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
    tools: ["read"],
  });
  try {
    await session.bindExtensions({});
    const read = session.agent.state.tools.find((tool) => tool.name === "read")!;
    assert.ok(read);
    await assert.rejects(read.execute("denied", { path: "sentinel" }), /denied/);
    owner.ask = async () => ({ lifetime: "session" });
    await owner.requestDirectory(outside, "read", "parent grant");
    owner.ask = async () => undefined;
    const result = await read.execute("allowed", { path: "sentinel" });
    assert.match(JSON.stringify(result.content), /shared-live-grant/);
    owner.revoke();
    await assert.rejects(read.execute("revoked", { path: "sentinel" }), /denied/);
    assert.ok(!session.getAllTools().some((tool) => tool.name === "show_plan"));
  } finally {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real root SDK session switches retire child leases and cannot inherit session grants", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-root-sdk-"));
  const project = path.join(dir, "project"); const outside = path.join(dir, "outside"); const agentDir = path.join(dir, "agent");
  for (const value of [project, outside, agentDir]) mkdirSync(value, { mode: 0o700 });
  mkdirSync(path.join(agentDir, "permission-mode"), { mode: 0o700 });
  writeFileSync(path.join(outside, "sentinel"), "session-only");
  const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  writeFileSync(path.join(agentDir, "permission-mode", "permission-mode.json"), JSON.stringify(config), { mode: 0o600 });
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
