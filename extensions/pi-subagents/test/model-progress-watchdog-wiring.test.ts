import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const recovered = {
  timeoutMinutes: 10,
  timeoutCount: 1,
  recoveryAttempted: true,
  recovered: true,
};

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function makeCtx(cwd: string) {
  return {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

function session() {
  return { dispose: vi.fn(), steer: vi.fn(async () => {}) } as any;
}

function resultText(result: any): string {
  return result.content.map((item: any) => item.text ?? "").join("\n");
}

describe("model-progress watchdog extension wiring", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-watchdog-wiring-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-watchdog-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("warns once without changing a foreground result or sending a model-visible message", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    await lifecycle.get("session_start")?.({}, ctx);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "substantive answer",
      session: session(),
      aborted: false,
      steered: false,
      modelProgressWatchdog: recovered,
    });

    const result = await tools.get("Agent").execute(
      "call-1",
      {
        prompt: "do it",
        description: "Recovered task",
        subagent_type: "general-purpose",
        run_in_background: false,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(resultText(result)).toContain("substantive answer");
    expect(resultText(result)).not.toContain("model progress");
    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Recovered task"), "warning");
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
      result: "substantive answer",
      modelProgressWatchdog: recovered,
    }));

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("warns for an owned nested recovery without persisting a child record", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    await lifecycle.get("session_start")?.({}, ctx);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, options: any) => {
      if (prompt === "nested work") {
        return {
          responseText: "nested answer",
          session: session(),
          aborted: false,
          steered: false,
          modelProgressWatchdog: recovered,
        };
      }
      const childId = options.nestedRuntime.manager.spawn(pi, ctx, "Explore", "nested work", {
        description: "Owned child",
        isBackground: true,
        parentAgentId: options.agentId,
        depth: 2,
      });
      await options.nestedRuntime.manager.getRecord(childId)!.promise;
      return { responseText: "parent answer", session: session(), aborted: false, steered: false };
    });

    await tools.get("Agent").execute(
      "call-2",
      {
        prompt: "parent work",
        description: "Parent task",
        subagent_type: "general-purpose",
        run_in_background: false,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Owned child"), "warning");
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
      description: "Parent task",
    }));
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
