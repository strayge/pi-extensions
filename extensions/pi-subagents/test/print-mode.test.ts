import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      { deliverAs: "steer", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("honors explicit follow-up result delivery", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    await tools.get("Agent").execute(
      "tool-call-follow-up",
      {
        prompt: "reply done",
        description: "deferred child",
        subagent_type: "general-purpose",
        run_in_background: true,
        result_delivery: "followUp",
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(300);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      { deliverAs: "followUp", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("keeps none-delivery results retrievable without injecting a message", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "manual result",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const spawn = await tools.get("Agent").execute(
      "tool-call-none",
      {
        prompt: "reply done",
        description: "manual child",
        subagent_type: "general-purpose",
        run_in_background: true,
        result_delivery: "none",
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );
    const spawnText = spawn.content[0].text as string;
    const id = spawnText.match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();

    await vi.advanceTimersByTimeAsync(500);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    const result = await tools.get("get_subagent_result").execute(
      "tool-get-none",
      { agent_id: id, wait: true },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );
    expect(result.content[0].text).toContain("manual result");

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});
