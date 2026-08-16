import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginContextBudgetPrompt,
  finishContextBudgetPrompt,
  installContextBudgetGuard,
} from "../src/context-budget.js";
import { fauxModelRuntime, registerFauxProvider } from "./helpers/pi-ai.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("context budget guard with a real AgentSession", () => {
  it("makes one capped, tool-free hard-final provider attempt", async () => {
    let request: { model: any; context: any; options: any } | undefined;
    const harness = await createHarness((context, options, _state, model) => {
      request = { model, context, options };
      return fauxAssistantMessage("final answer");
    });

    beginContextBudgetPrompt(harness.session);
    await harness.session.prompt("x".repeat(416_000));
    const outcome = finishContextBudgetPrompt(harness.session);

    expect(harness.faux.state.callCount).toBe(1);
    expect(outcome.terminal).toBe(true);
    expect(request?.model.maxTokens).toBeGreaterThan(0);
    expect(request?.model.maxTokens).toBeLessThan(20_000);
    expect(request?.context.tools).toEqual([]);
    expect(request?.options.maxRetries).toBe(0);
  });

  it("does not call the provider when no safe final cap remains", async () => {
    const harness = await createHarness(() => fauxAssistantMessage("must not run"));

    beginContextBudgetPrompt(harness.session);
    await harness.session.prompt("x".repeat(472_000));
    const outcome = finishContextBudgetPrompt(harness.session);

    expect(harness.faux.state.callCount).toBe(0);
    expect(outcome.terminal).toBe(true);
    expect(harness.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Context budget has no safe room for a final provider attempt.",
    });
  });

  it("prevents provider dispatch for a signal aborted before prompt startup", async () => {
    const harness = await createHarness(() => fauxAssistantMessage("must not run"));

    beginContextBudgetPrompt(harness.session, AbortSignal.abort());
    await harness.session.prompt("ordinary prompt");
    const outcome = finishContextBudgetPrompt(harness.session);

    expect(harness.faux.state.callCount).toBe(0);
    expect(outcome.terminal).toBe(false);
    expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });
});

async function createHarness(respond: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0][number]) {
  const cwd = mkdtempSync(join(tmpdir(), "context-budget-e2e-"));
  const faux = registerFauxProvider({
    provider: "faux",
    models: [{ id: "guard", contextWindow: 120_000, maxTokens: 20_000 }],
  });
  faux.setResponses([respond]);
  const model = faux.getModel();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    model,
    modelRuntime: fauxModelRuntime(model) as never,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    noTools: "all",
  });
  installContextBudgetGuard(session, settingsManager);
  cleanups.push(() => {
    session.dispose();
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });
  return { session, faux };
}
