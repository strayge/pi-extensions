/**
 * mention-clone-tool-reachability.e2e.test.ts — reachability guard for the one
 * tool the mention clone is built around.
 *
 * `runMentionClone` hands a session ONE tool and expects the model to call it.
 * Whether that tool ever reaches the model is decided entirely inside Pi, by
 * `createAgentSession`'s allowlist plumbing — and the unit tests cannot see it:
 * their `createAgentSession` is a mock that hands `customTools[0]` straight to
 * the model turn, so a session option that silently strips the tool passes
 * every one of them.
 *
 * That is not hypothetical. The clone shipped with `noTools: "all"` on the
 * reading its doc comment invites ("start with no tools enabled" — no
 * built-ins, keep mine). Pi turns that flag into an EMPTY allowlist, and an
 * empty array is truthy, so `AgentSession` builds an empty `Set` and
 * `isAllowedTool` rejects every name — custom tools are filtered by the same
 * predicate as built-ins. Every mention was prompted with no tools, answered in
 * prose, and fell back to a direct start with a warning. The unit suite stayed
 * green throughout.
 *
 * So this asserts against a REAL session, on the two things a mock cannot
 * establish:
 *   1. the clone's `Agent` tool is actually active on it, and
 *   2. nothing else is — the invisible turn cannot read, write or run anything.
 *
 * No network/LLM: the faux provider also checks the actual request context.
 * Pi rebuilds it from SessionManager, not from agent.state.messages.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real pi-mono session construction; a cold first run under full-suite CPU
// contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

// Hoisted so the (lifted) mock factory can reach it. Everything except the
// capture is the real module — the point is to construct a REAL session.
const { sessions } = vi.hoisted(() => ({ sessions: [] as any[] }));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: async (opts: any) => {
      const created = await actual.createAgentSession(opts);
      sessions.push(created.session);
      return created;
    },
  };
});

import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

describe("mention clone tool reachability against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    sessions.length = 0;
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-clone-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("the clone's Agent tool is live on the real session, and it is the only one", async () => {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT",
      // mention-clone reads the runtime off the registry facade, the same shim
      // agent-runner carries for Pi >= 0.80.8.
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: { getEntries: () => [], getLeafId: () => undefined },
    };

    // Never called: the assertion is on what the session exposes, not on the
    // faux model deciding to use it.
    const agentTool = { name: "Agent", execute: vi.fn() } as any;

    // Never rejects by contract; a faux turn that cannot complete is fine,
    // because the tool set is fixed at construction.
    await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(sessions).toHaveLength(1);
    // The bug this file exists for: with an empty allowlist this is `[]`.
    expect(sessions[0].getActiveToolNames()).toEqual(["Agent"]);
  });

  it("sends the cloned history and live parent prompt with only Agent to the provider", async () => {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const parent = SessionManager.inMemory(cwd);
    parent.appendMessage({
      role: "system",
      content: "STALE-PARENT-PROMPT",
      toolsAdded: [{ name: "bash", description: "Parent-only tool", parameters: { type: "object", properties: {} } }],
      timestamp: 1,
    });
    parent.appendMessage({ role: "user", content: "PARENT-HISTORY-USER", timestamp: 2 });
    parent.appendMessage(fauxAssistantMessage("PARENT-HISTORY-ASSISTANT"));

    let providerContext: TranscriptContext | undefined;
    faux.setResponses([
      (context) => {
        providerContext = context;
        return fauxAssistantMessage("Done.");
      },
    ]);

    const result = await runMentionClone({
      ctx: {
        cwd,
        model,
        getSystemPrompt: () => "PARENT-LIVE-PROMPT",
        modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
        sessionManager: parent,
      } as any,
      type: "Explore",
      message: "NEW-MENTION-TASK",
      agentTool: { name: "Agent", description: "Delegate", parameters: { type: "object", properties: {} }, execute: vi.fn() } as any,
    });

    expect(result.spawned).toBe(false); // The scripted model replies instead of calling Agent.
    expect(providerContext).toBeDefined();
    expect(getCurrentSystemPrompt(providerContext!.messages)).toBe("PARENT-LIVE-PROMPT");
    expect(getCurrentTools(providerContext!.messages).map((tool) => tool.name)).toEqual(["Agent"]);
    expect(providerContext!.messages.map((message) => message.role)).toEqual([
      "system", "user", "assistant", "user",
    ]);
    expect(JSON.stringify(providerContext!.messages)).toContain("PARENT-HISTORY-USER");
    expect(JSON.stringify(providerContext!.messages)).toContain("PARENT-HISTORY-ASSISTANT");
    expect(JSON.stringify(providerContext!.messages)).toContain("NEW-MENTION-TASK");
    expect(JSON.stringify(providerContext!.messages)).not.toContain("STALE-PARENT-PROMPT");
  });
});
