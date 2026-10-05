import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.ts")>("../src/agent-runner.ts");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.ts";
import subagentsExtension from "../src/index.ts";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const textOf = (result: any): string => result.content[0].text;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("completion notification boundaries", () => {
  let cwd: string;
  let previousCwd: string;
  let previousHome: string | undefined;
  let previousAgentDir: string | undefined;
  let instance: Awaited<ReturnType<typeof boot>> | undefined;
  let pendingResolutions: Array<() => void>;
  let childSession: any;

  async function boot(joinMode = "async", idle = false, maxConcurrent = 10) {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
      schedulingEnabled: false,
      workflowsEnabled: false,
      outputTranscript: false,
      defaultJoinMode: joinMode,
      maxConcurrent,
    }));
    const tools = new Map<string, any>();
    const hooks = new Map<string, Array<(...args: any[]) => any>>();
    const listeners = new Map<string, (...args: any[]) => any>();
    const parent = SessionManager.inMemory(cwd);
    const ctx = {
      cwd,
      hasUI: false,
      isIdle: () => idle,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: parent,
      getSystemPrompt: () => "parent",
    } as any;
    const pi = {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerCommand: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      getAllTools: () => [...tools.values()],
      on: (event: string, handler: (...args: any[]) => any) => {
        const handlers = hooks.get(event) ?? [];
        handlers.push(handler);
        hooks.set(event, handlers);
      },
      events: {
        emit: vi.fn(),
        on: (event: string, listener: (...args: any[]) => any) => {
          listeners.set(event, listener);
          return () => listeners.delete(event);
        },
      },
      appendEntry: (type: string, data: unknown) => parent.appendCustomEntry(type, data),
      sendMessage: vi.fn(),
    } as any;
    subagentsExtension(pi);
    let closed = false;
    const emit = async (name: string, event: any = {}) => {
      let result: any;
      for (const handler of hooks.get(name) ?? []) result = await handler(event, ctx) ?? result;
      return result;
    };
    const booted = {
      tools, pi, ctx, parent, listeners, emit,
      setIdle: (value: boolean) => { idle = value; },
      spawn: async (name?: string) => {
        const result = await tools.get("Agent").execute("spawn", {
          prompt: "review", description: "Review task", subagent_type: "general-purpose",
          run_in_background: true, name,
        }, undefined, undefined, ctx);
        await vi.advanceTimersByTimeAsync(0);
        return /Agent ID: (\S+)/.exec(textOf(result))![1];
      },
      read: async (id: string) => textOf(await tools.get("get_subagent_result").execute(
        "read", { agent_id: id }, undefined, undefined, ctx,
      )),
      resume: async (id: string, background = true) => {
        await tools.get("Agent").execute("resume", {
          prompt: "follow-up", description: "Follow-up", subagent_type: "general-purpose",
          resume: id, run_in_background: background,
        }, undefined, undefined, ctx);
        await vi.advanceTimersByTimeAsync(0);
      },
      boundary: (kind = "turn_end", overrides: any = {}) => emit(kind, {
        type: kind, entries: [], outcome: "completed", continue: false, ...overrides,
      }),
      shutdown: async () => {
        if (closed) return;
        closed = true;
        await emit("session_shutdown");
      },
    };
    instance = booted;
    await emit("session_start");
    if (!idle) await emit("agent_start");
    return booted;
  }

  function pendingChild(output: string) {
    const gate = deferred<void>();
    pendingResolutions.push(() => gate.resolve());
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(childSession);
      await gate.promise;
      return { responseText: output, session: childSession, aborted: false, steered: false } as any;
    });
    return async () => { gate.resolve(); await vi.advanceTimersByTimeAsync(0); };
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-notification-boundary-"));
    previousCwd = process.cwd();
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.chdir(cwd);
    process.env.HOME = cwd;
    process.env.PI_CODING_AGENT_DIR = cwd;
    mkdirSync(join(cwd, ".pi"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    instance = undefined;
    pendingResolutions = [];
    childSession = { messages: [], subscribe: vi.fn(() => vi.fn()), dispose: vi.fn(), abort: vi.fn(async () => {}) };
    vi.mocked(runAgent).mockReset().mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(childSession);
      return { responseText: "FIRST-OUTPUT", session: childSession, aborted: false, steered: false } as any;
    });
    vi.mocked(resumeAgent).mockReset().mockResolvedValue({ text: "SECOND-OUTPUT" } as any);
  });

  afterEach(async () => {
    for (const resolve of pendingResolutions) resolve();
    await vi.advanceTimersByTimeAsync(0);
    await instance?.shutdown();
    vi.useRealTimers();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("delivers while the parent continues, without handing the host a follow-up", async () => {
    const app = await boot();
    const id = await app.spawn();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(app.pi.sendMessage).not.toHaveBeenCalled();
    const previous = { type: "custom", customType: "another-extension", data: "keep" };
    const result = await app.boundary("turn_end", { entries: [previous] });
    expect(result.continue).toBe(true);
    expect(result.entries[0]).toBe(previous);
    expect(result.entries[1]).toMatchObject({ type: "custom_message", customType: "subagent-notification", display: true });
    expect(result.entries[1].content).toContain(id);
    expect(result.entries[1].content).toContain("FIRST-OUTPUT");
    expect(await app.boundary("agent_before_settle")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(app.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("uses the final settlement boundary when completion misses turn_end", async () => {
    const app = await boot();
    const finish = pendingChild("LATE-OUTPUT");
    await app.spawn();
    expect(await app.boundary()).toBeUndefined();
    await finish();
    const result = await app.boundary("agent_before_settle");
    expect(result.continue).toBe(true);
    expect(result.entries[0].content).toContain("LATE-OUTPUT");
  });

  it("consumes a held completion by handle without forcing a continuation", async () => {
    const app = await boot();
    await app.spawn("named-review");
    expect(await app.read("named-review")).toContain("FIRST-OUTPUT");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await app.boundary()).toBeUndefined();
    expect(app.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("filters RPC consumption after the notification hold expired", async () => {
    const app = await boot();
    const id = await app.spawn();
    await vi.advanceTimersByTimeAsync(1_000);
    app.listeners.get("subagents:rpc:consume")!({ requestId: "consume", agentId: id });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.pi.events.emit).toHaveBeenCalledWith("subagents:rpc:consume:reply:consume", expect.objectContaining({ success: true }));
    expect(await app.boundary()).toBeUndefined();
  });

  it("finishes a group even when one member was read before finalization", async () => {
    const app = await boot("smart");
    const first = await app.spawn();
    const second = await app.spawn();
    await app.read(first);
    const result = await app.boundary();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toContain(second);
    expect(result.entries[0].content).not.toContain(first);
    expect(result.entries[0].content).not.toContain("partial");
    expect(await app.boundary()).toBeUndefined();
  });

  it("filters consumed members of an already assembled group", async () => {
    const app = await boot("group");
    const first = await app.spawn();
    const second = await app.spawn();
    await vi.advanceTimersByTimeAsync(1_000);
    await app.read(second);
    const result = await app.boundary();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toContain(first);
    expect(result.entries[0].content).not.toContain(second);
    expect(result.entries[0].details.others).toBeUndefined();
  });

  it("keeps partial and straggler deliveries separate", async () => {
    const app = await boot("smart");
    const finishFirst = pendingChild("PARTIAL-OUTPUT");
    const first = await app.spawn();
    const finishSecond = pendingChild("STRAGGLER-OUTPUT");
    const second = await app.spawn();
    await vi.advanceTimersByTimeAsync(100);
    await finishFirst();
    await vi.advanceTimersByTimeAsync(30_000);
    const partial = await app.boundary();
    expect(partial.entries[0].content).toContain("partial");
    expect(partial.entries[0].content).toContain(first);
    expect(partial.entries[0].content).not.toContain(second);
    await finishSecond();
    const final = await app.boundary();
    expect(final.entries[0].content).toContain(second);
    expect(final.entries[0].content).not.toContain(first);
  });

  it("preserves the old run's unread snapshot when only the resumed result is read", async () => {
    const app = await boot();
    const id = await app.spawn();
    await app.resume(id);
    expect(await app.read(id)).toContain("SECOND-OUTPUT");
    const result = await app.boundary();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toContain("Earlier run");
    expect(result.entries[0].content).toContain("FIRST-OUTPUT");
    expect(result.entries[0].content).not.toContain("SECOND-OUTPUT");
    expect(result.entries[0].details.description).toContain("earlier run");
  });

  it("does not revive an already consumed run when resume resets the record flag", async () => {
    const app = await boot();
    const id = await app.spawn();
    await app.read(id);
    await app.resume(id);
    const result = await app.boundary();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toContain("SECOND-OUTPUT");
    expect(result.entries[0].content).not.toContain("FIRST-OUTPUT");
  });

  it("foreground resume does not consume the preceding background run", async () => {
    const app = await boot();
    const id = await app.spawn();
    await app.resume(id, false);
    const result = await app.boundary();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toContain("Earlier run");
    expect(result.entries[0].content).toContain("FIRST-OUTPUT");
    expect(result.entries[0].content).not.toContain("SECOND-OUTPUT");
  });

  it("a background resume after a foreground resume gets a fresh unread invocation", async () => {
    const app = await boot();
    const id = await app.spawn();
    await app.read(id);
    await app.resume(id, false);
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "AFTER-FOREGROUND" } as any);
    await app.resume(id);
    const result = await app.boundary();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toContain("AFTER-FOREGROUND");
    expect(result.entries[0].content).not.toContain("FIRST-OUTPUT");
  });

  it("marks the old notice as earlier as soon as an async resume is queued", async () => {
    const app = await boot("async", false, 1);
    const id = await app.spawn();
    const finishBlocker = pendingChild("BLOCKER");
    await app.spawn();
    await app.resume(id);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id).status).toBe("queued");
    const result = await app.boundary();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toContain("Earlier run");
    expect(result.entries[0].content).toContain("FIRST-OUTPUT");
    await finishBlocker();
    const later = await app.boundary();
    expect(later.entries.map((entry: any) => entry.content).join("\n")).toContain("SECOND-OUTPUT");
  });

  it("reading a stopped queued resume does not consume its predecessor", async () => {
    const app = await boot("async", false, 1);
    const id = await app.spawn();
    pendingChild("BLOCKER");
    await app.spawn();
    await app.resume(id);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id).status).toBe("queued");
    app.listeners.get("subagents:rpc:stop")!({ requestId: "stop", agentId: id });
    await vi.advanceTimersByTimeAsync(0);
    expect(await app.read(id)).toContain("Status: stopped");
    const result = await app.boundary();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toContain("Earlier run");
    expect(result.entries[0].content).toContain("FIRST-OUTPUT");
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
  });

  it("does not overwrite an older grouped completion when its agent is resumed", async () => {
    const app = await boot("smart");
    const first = await app.spawn();
    const finishSecond = pendingChild("OTHER-OUTPUT");
    const second = await app.spawn();
    await vi.advanceTimersByTimeAsync(100);
    await app.resume(first);
    await finishSecond();
    const result = await app.boundary();
    const content = result.entries.map((entry: any) => entry.content).join("\n");
    expect(content).toContain("FIRST-OUTPUT");
    expect(content).toContain("SECOND-OUTPUT");
    expect(content).toContain("OTHER-OUTPUT");
    expect(content).toContain(second);
    expect(content).toContain("Earlier run");
  });

  it("historical retrieval consumes a notice that outlived the live-agent cache", async () => {
    const app = await boot();
    const id = await app.spawn();
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id)).toBeUndefined();
    expect(childSession.dispose).toHaveBeenCalled();
    expect(await app.read(id)).toContain("Historical result:");
    expect(await app.boundary()).toBeUndefined();
    expect(app.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("unread notices survive cache cleanup without a live child session", async () => {
    const app = await boot();
    const id = await app.spawn();
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id)).toBeUndefined();
    const result = await app.boundary();
    expect(result.entries[0].content).toContain("FIRST-OUTPUT");
  });

  it("wakes an idle parent once for completions waiting at cancellation", async () => {
    const app = await boot();
    await app.spawn();
    await app.spawn();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await app.boundary("turn_end", { outcome: "aborted" })).toBeUndefined();
    app.setIdle(true);
    await app.emit("agent_settled", { outcome: "aborted" });
    expect(app.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(app.pi.sendMessage.mock.calls.map((call: any[]) => call[1].triggerTurn)).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(app.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("still wakes a cancelled parent when its detached child finishes later", async () => {
    const app = await boot();
    const finish = pendingChild("AFTER-CANCEL");
    await app.spawn();
    const controller = new AbortController();
    controller.abort();
    app.ctx.signal = controller.signal;
    app.setIdle(true);
    await app.emit("agent_settled", { outcome: "aborted" });
    await finish();
    await vi.advanceTimersByTimeAsync(200);
    expect(app.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(app.pi.sendMessage.mock.calls[0][0].content).toContain("AFTER-CANCEL");
    expect(app.pi.sendMessage.mock.calls[0][1].triggerTurn).toBe(true);
  });

  it("waits for manual compaction to expose idle state before waking", async () => {
    const app = await boot("async", true);
    app.setIdle(false);
    await app.spawn();
    await vi.advanceTimersByTimeAsync(600);
    expect(app.pi.sendMessage).not.toHaveBeenCalled();
    app.setIdle(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(app.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("drops held group timers and ready intents on shutdown", async () => {
    const app = await boot("smart");
    await app.spawn();
    await app.spawn();
    await vi.advanceTimersByTimeAsync(100);
    await app.shutdown();
    app.setIdle(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await app.boundary()).toBeUndefined();
    expect(app.pi.sendMessage).not.toHaveBeenCalled();
  });
});
