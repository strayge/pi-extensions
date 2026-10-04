import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.ts")>("../src/agent-runner.ts");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.ts";
import subagentsExtension from "../src/index.ts";

const textOf = (result: any): string => result.content[0].text;
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function saveCompletion(sessionManager: SessionManager, overrides: Record<string, unknown> = {}) {
  return sessionManager.appendCustomEntry("subagents:record", {
    id: "saved-agent",
    type: "general-purpose",
    description: "Saved review",
    status: "completed",
    result: "SAVED-RESULT",
    startedAt: Date.now() - 60_000,
    completedAt: Date.now() - 30_000,
    ...overrides,
  });
}

describe("historical result retrieval", () => {
  let tmpDir: string;
  let previousCwd: string;
  let previousHome: string | undefined;
  let previousAgentDir: string | undefined;
  let parent: SessionManager;
  let instances: Array<{ shutdown: () => Promise<void> }>;
  let pendingResolutions: Array<() => void>;

  async function boot(sessionManager = parent) {
    const tools = new Map<string, any>();
    const lifecycle = new Map<string, Array<(...args: any[]) => any>>();
    const ctx = {
      cwd: tmpDir,
      hasUI: false,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager,
      getSystemPrompt: () => "parent",
    } as any;
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      getAllTools: () => [...tools.values()],
      on: (event: string, handler: (...args: any[]) => any) => {
        const handlers = lifecycle.get(event) ?? [];
        handlers.push(handler);
        lifecycle.set(event, handlers);
      },
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn((type: string, data: unknown) => sessionManager.appendCustomEntry(type, data)),
      sendMessage: vi.fn(),
    } as any;
    subagentsExtension(pi);
    let closed = false;
    const instance = {
      tools,
      pi,
      ctx,
      shutdown: async () => {
        if (closed) return;
        closed = true;
        for (const handler of lifecycle.get("session_shutdown") ?? []) await handler({}, ctx);
      },
      read: async (id: string, options: Record<string, unknown> = {}) => textOf(await tools.get("get_subagent_result").execute(
        "read", { agent_id: id, ...options }, undefined, undefined, ctx,
      )),
    };
    instances.push(instance);
    for (const handler of lifecycle.get("session_start") ?? []) await handler({}, ctx);
    return instance;
  }

  async function spawn(instance: Awaited<ReturnType<typeof boot>>) {
    const result = await instance.tools.get("Agent").execute("spawn", {
      prompt: "review",
      description: "Review saved evidence",
      name: "review-history",
      subagent_type: "general-purpose",
      run_in_background: true,
    }, undefined, undefined, instance.ctx);
    await vi.advanceTimersByTimeAsync(350);
    return /Agent ID: (\S+)/.exec(textOf(result))![1];
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-historical-result-"));
    previousCwd = process.cwd();
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    process.env.PI_CODING_AGENT_DIR = tmpDir;
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, ".pi"));
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({
      schedulingEnabled: false,
      workflowsEnabled: false,
      outputTranscript: false,
      defaultJoinMode: "async",
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    parent = SessionManager.create(tmpDir, join(tmpDir, "sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
    parent.appendMessage(fauxAssistantMessage("parent acknowledgment"));
    instances = [];
    pendingResolutions = [];
    vi.mocked(resumeAgent).mockReset();
    vi.mocked(runAgent).mockReset().mockResolvedValue({
      responseText: "CHILD-RESULT",
      session: { messages: [], dispose: vi.fn() },
      aborted: false,
      steered: false,
    } as any);
  });

  afterEach(async () => {
    for (const resolve of pendingResolutions) resolve();
    await vi.advanceTimersByTimeAsync(0);
    for (const instance of instances) await instance.shutdown();
    vi.useRealTimers();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("recovers an unread result after one-hour cleanup without keeping its child session alive", async () => {
    const instance = await boot();
    const id = await spawn(instance);
    const manager = (globalThis as any)[MANAGER_KEY];
    const dispose = manager.getRecord(id).session.dispose;
    expect(manager.getRecord(id).resultConsumed).not.toBe(true);

    vi.setSystemTime(Date.now() + 61 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    const output = await instance.read(id, { wait: true });
    expect(output).toContain("Historical result:");
    expect(output).toContain(id);
    expect(output).toContain("CHILD-RESULT");
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
  });

  it("recovers a persisted completion after reopening the parent and loading a fresh extension", async () => {
    const first = await boot();
    const id = await spawn(first);
    const sessionFile = parent.getSessionFile()!;
    await first.shutdown();

    const reopened = SessionManager.open(sessionFile);
    const second = await boot(reopened);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id)).toBeUndefined();
    const output = await second.read(id);
    expect(output).toContain("Historical result:");
    expect(output).toContain("CHILD-RESULT");
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
    expect(second.pi.appendEntry).not.toHaveBeenCalled();
    expect(second.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("returns the latest saved completion with its identity and timestamps, not fabricated runtime statistics", async () => {
    saveCompletion(parent, { result: "OLDER-RESULT" });
    saveCompletion(parent, { result: "LATEST-RESULT", description: "Updated review" });
    const instance = await boot();

    const output = await instance.read("saved-agent", { wait: true, verbose: true });
    expect(output).toContain("LATEST-RESULT");
    expect(output).not.toContain("OLDER-RESULT");
    expect(output).toContain("Type: general-purpose | Status: completed");
    expect(output).toContain("Description: Updated review");
    expect(output).toContain("Started: 2026-10-01T11:59:00.000Z");
    expect(output).toContain("Completed: 2026-10-01T11:59:30.000Z");
    expect(output).toContain("does not describe any newer unfinished run");
    expect(output).toContain("Full conversation is unavailable");
    expect(output).not.toMatch(/Tool uses:|Tokens:|Cost:|Context:|Compactions:/);
  });

  it("ignores completions on abandoned branches, including newer completions under the same ID", async () => {
    const current = saveCompletion(parent, { result: "CURRENT-BRANCH-RESULT" });
    saveCompletion(parent, { result: "ABANDONED-NEWER-RESULT" });
    saveCompletion(parent, { id: "abandoned-only", result: "ABANDONED-ONLY-RESULT" });
    parent.branch(current);
    const instance = await boot();

    const output = await instance.read("saved-agent");
    expect(output).toContain("CURRENT-BRANCH-RESULT");
    expect(output).not.toContain("ABANDONED-NEWER-RESULT");
    expect(await instance.read("abandoned-only")).toContain("No saved completion");
    expect(parent.getEntries().length).toBeGreaterThan(parent.getBranch().length);
  });

  it("keeps a running resumed agent authoritative over its earlier saved completion", async () => {
    const instance = await boot();
    const id = await spawn(instance);
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => {
      pendingResolutions.push(() => resolve({ text: "RESUMED-RESULT" } as any));
    }));
    await instance.tools.get("Agent").execute("resume", {
      resume: id,
      prompt: "continue",
      description: "Continue review",
      subagent_type: "general-purpose",
      run_in_background: true,
    }, undefined, undefined, instance.ctx);

    const output = await instance.read(id);
    expect(output).toContain("Status: running");
    expect(output).toContain("Agent is still running");
    expect(output).not.toContain("Historical result:");
    expect(output).not.toContain("CHILD-RESULT");
    expect((globalThis as any)[MANAGER_KEY].getRecord(id).resultConsumed).not.toBe(true);
  });

  it.each(["error", "stopped"])("preserves saved %s status and partial output", async status => {
    saveCompletion(parent, { status, error: "FAILED-REVIEW", result: "PARTIAL-EVIDENCE" });
    const instance = await boot();

    const output = await instance.read("saved-agent");
    expect(output).toContain(`Status: ${status}`);
    expect(output).toContain("FAILED-REVIEW");
    expect(output).toContain("PARTIAL-EVIDENCE");
    if (status === "stopped") expect(output).toContain("task was NOT finished");
    else expect(output).toContain("Partial output before the failure");
  });

  it("keeps live handle lookup but requires the exact ID for historical results", async () => {
    const instance = await boot();
    const id = await spawn(instance);
    expect(await instance.read("review-history")).toContain("CHILD-RESULT");
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await instance.read("review-history")).toContain("No saved completion");
    expect(await instance.read(id)).toContain("CHILD-RESULT");
  });

  it("does not bypass live nested ownership rejection through a saved completion", async () => {
    const instance = await boot();
    const id = await spawn(instance);
    const record = (globalThis as any)[MANAGER_KEY].getRecord(id);
    record.parentAgentId = "another-owner";

    const output = await instance.read(id);
    expect(output).toContain("Agent not found");
    expect(output).not.toContain("CHILD-RESULT");
  });

  it("reports missing or unusable completions without falling back to an older result", async () => {
    saveCompletion(parent, { result: "OLDER-RESULT" });
    saveCompletion(parent, { result: { invalid: true } });
    const instance = await boot();

    expect(await instance.read("unknown-id")).toContain("No saved completion");
    const output = await instance.read("saved-agent");
    expect(output).toContain("No saved completion");
    expect(output).not.toContain("OLDER-RESULT");
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
  });
});
