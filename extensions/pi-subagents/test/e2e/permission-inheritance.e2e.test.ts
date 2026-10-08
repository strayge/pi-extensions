import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type AgentSession, createAgentSession, createEventBus, DefaultResourceLoader, type ExtensionAPI, initTheme, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PermissionOwner } from "../../../pi-permissions/src/approvals.ts";
import { defaultConfig } from "../../../pi-permissions/src/config-load.ts";
import permissionExtension from "../../../pi-permissions/src/index.ts";
import { bindPath } from "../../../pi-permissions/src/paths.ts";
import { resolveCatalog } from "../../../pi-permissions/src/policy.ts";
import { runtime } from "../../../pi-permissions/src/sandbox.ts";
import { resumeAgent, runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import { DEFAULT_AGENTS } from "../../src/default-agents.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 20000 });
const supported = process.platform === "darwin" || (process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/socat"));

async function fixture(persistSession = false) {
  initTheme("dark");
  const dir = bindPath(mkdtempSync(join(tmpdir(), "permission-runner-"))).canonical;
  const project = join(dir, "project"); const outside = join(dir, "outside"); const agentDir = join(dir, "agent");
  for (const folder of [project, outside, agentDir]) mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(outside, "sentinel"), "INHERITED-SECRET");
  const home = process.env.HOME; const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = dir; process.env.PI_CODING_AGENT_DIR = agentDir;
  const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
  config.modes.subproject = config.modes.project!;
  const root = { family: randomUUID(), binding: bindPath(project) };
  const owner = new PermissionOwner(resolveCatalog(config, root, { agentDir, home: dir }), { ask: async () => undefined });
  const faux = registerFauxProvider({ provider: "permission-faux", models: [{ id: "permission-model", contextWindow: 200000 }] });
  const model = faux.getModel(); const backend = fauxModelBackend(model);
  registerAgents(new Map([["permission-fixture", { ...DEFAULT_AGENTS.get("general-purpose")!, name: "permission-fixture", builtinToolNames: ["read", "bash"], extensions: [], skills: false, persistSession }]]));
  let pi!: ExtensionAPI;
  const loader = new DefaultResourceLoader({ cwd: project, agentDir, eventBus: createEventBus(), noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [(api) => { pi = api; permissionExtension(api, { owner, release: () => {} }); }],
  });
  await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
  const { session: parent } = await createAgentSession({ cwd: project, agentDir, resourceLoader: loader, model, modelRuntime: backend.modelRuntime, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(project) });
  await parent.bindExtensions({});
  const ctx = parent.extensionRunner!.createContext();
  const sessions: AgentSession[] = [];
  const script = (command: string) => faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command, timeout: 10 }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const lastTool = (session: AgentSession) => [...session.messages].reverse().find((message) => message.role === "toolResult");
  return { dir, project, outside, owner, faux, model, pi, ctx, sessions, script, lastTool, close: async () => {
    owner.block("test shutdown"); await owner.drain();
    for (const session of [...sessions, parent]) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    await runtime.shutdown(owner.id); faux.unregister(); registerAgents(new Map());
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  } };
}

describe.skipIf(!supported)("permission inheritance through the real central runner", () => {
  it.each([true, false])("isolated=%s children, resumes, and nested children retain root authority", async (isolated) => {
    const f = await fixture();
    try {
      f.script("cat sentinel");
      const child = await runAgent(f.ctx, "permission-fixture", "read sentinel", { pi: f.pi, model: f.model, isolated, cwd: f.outside, configCwd: f.project, onSessionCreated: (session) => f.sessions.push(session) });
      expect(child.failure).toBeUndefined();
      expect(f.lastTool(child.session)?.isError).toBe(true);
      expect(JSON.stringify(f.lastTool(child.session))).not.toContain("INHERITED-SECRET");
      f.owner.ask = async () => ({ lifetime: "session" }); await f.owner.requestDirectory(f.outside, "read", "parent grants read"); f.owner.ask = async () => undefined;
      f.script("cat sentinel"); await resumeAgent(child.session, "try approved read");
      expect(f.lastTool(child.session)?.isError).toBe(false); expect(JSON.stringify(f.lastTool(child.session))).toContain("INHERITED-SECRET");
      f.owner.revoke();
      f.script("cat sentinel");
      const nested = await runAgent(child.session.extensionRunner!.createContext(), "permission-fixture", "nested read", { pi: f.pi, model: f.model, isolated: true, nested: true, cwd: f.outside, configCwd: f.project, onSessionCreated: (session) => f.sessions.push(session) });
      expect(nested.failure).toBeUndefined(); expect(f.lastTool(nested.session)?.isError).toBe(true);
      expect(JSON.stringify(f.lastTool(nested.session))).not.toContain("INHERITED-SECRET");
      f.owner.block("parent retired");
      await expect(resumeAgent(child.session, "stale resume")).rejects.toThrow(/unavailable/);
    } finally { await f.close(); }
  });

  it("reopening a persisted child reacquires current parent policy instead of restoring old grants", async () => {
    const f = await fixture(true);
    try {
      f.owner.ask = async () => ({ lifetime: "session" }); await f.owner.requestDirectory(f.outside, "read", "approved read"); f.owner.ask = async () => undefined;
      f.script("cat sentinel");
      const first = await runAgent(f.ctx, "permission-fixture", "approved child", { pi: f.pi, model: f.model, isolated: true, cwd: f.outside, configCwd: f.project, onSessionCreated: (session) => f.sessions.push(session) });
      expect(f.lastTool(first.session)?.isError).toBe(false);
      const sessionFile = first.session.sessionManager.getSessionFile(); expect(sessionFile).toBeTruthy();
      f.owner.revoke(); f.script("cat sentinel");
      const reopened = await runAgent(f.ctx, "permission-fixture", "reopened child", { pi: f.pi, model: f.model, isolated: true, cwd: f.outside, configCwd: f.project, resumeSessionFile: sessionFile, onSessionCreated: (session) => f.sessions.push(session) });
      expect(f.lastTool(reopened.session)?.isError).toBe(true);
      expect(JSON.stringify(f.lastTool(reopened.session))).not.toContain("INHERITED-SECRET");
    } finally { await f.close(); }
  });

  it("parent cancellation terminates a live child shell before draining its inherited lease", async () => {
    const f = await fixture();
    let running: ReturnType<typeof runAgent> | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      const ready = new Promise<void>((resolve) => { watcher = watch(f.project, () => { if (existsSync(join(f.project, "ready"))) resolve(); }); });
      f.script("echo started > ready; sleep 30; echo escaped > marker");
      running = runAgent(f.ctx, "permission-fixture", "run contained shell", { pi: f.pi, model: f.model, isolated: true, onSessionCreated: (session) => f.sessions.push(session) });
      await Promise.race([ready, running.then(() => { throw new Error("child ended before its shell started"); })]);
      f.owner.block("parent shutdown");
      await Promise.all([f.owner.drain(), running]);
      expect(existsSync(join(f.project, "marker"))).toBe(false);
      await expect(resumeAgent(f.sessions[0]!, "stale resume")).rejects.toThrow(/unavailable/);
    } finally { watcher?.close(); f.owner.block("cleanup"); await running?.catch(() => {}); await f.close(); }
  });
});
