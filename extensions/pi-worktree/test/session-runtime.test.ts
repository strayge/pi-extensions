import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import worktreeExtension from "../src/index.ts";
import { createWorktreeSettingsRuntime } from "../src/settings.ts";

for (const queuedBeforeProposal of [false, true]) {
  test(queuedBeforeProposal
    ? "real runtime refuses a transition with already queued user input"
    : "agent tool changes the real runtime cwd and delivers completion without losing the tool result", {
    timeout: 30_000,
  }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-runtime-")));
    const agentDir = join(root, "agent");
    const main = join(root, "repo");
    const target = join(root, "worktrees", "feature");
    mkdirSync(main);
    mkdirSync(agentDir);
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: main, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Worktree Test");
    git("config", "user.email", "worktree@example.invalid");
    writeFileSync(join(main, "tracked.txt"), "initial\n");
    git("add", ".");
    git("commit", "-m", "initial");
    const requests: Array<{ cwd: string; messages: unknown[] }> = [];
    const errors: string[] = [];
    let confirmations = 0;
    let resolveContinuation!: () => void;
    const continuation = new Promise<void>((resolve) => {
      resolveContinuation = resolve;
    });
    let resolveFinish!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinish = resolve;
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    try {
      const factory: CreateAgentSessionRuntimeFactory = async ({
        cwd,
        sessionManager,
        sessionStartEvent,
      }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          modelRuntime,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
            defaultTools: ["worktree"],
          }),
          resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
              (pi) => {
                pi.registerProvider("worktree-test", {
                  api: "openai-completions",
                  apiKey: "test-only",
                  baseUrl: "https://example.invalid",
                  models: [
                    {
                      id: "fake",
                      name: "Fake",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 128_000,
                      maxTokens: 1_000,
                    },
                  ],
                  streamSimple: (model, context) => {
                    requests.push({ cwd, messages: structuredClone(context.messages) });
                    const first = requests.length === 1;
                    const finishing = !queuedBeforeProposal && requests.length === 3;
                    if (first && queuedBeforeProposal) {
                      assert.ok(runtime);
                      void runtime.session.followUp(
                        "Queued user work must not be silently moved to another checkout.",
                      );
                    }
                    const toolRequest = first || finishing;
                    const message: AssistantMessage = {
                      role: "assistant",
                      api: model.api,
                      provider: model.provider,
                      model: model.id,
                      timestamp: Date.now(),
                      stopReason: toolRequest ? "toolUse" : "stop",
                      content: toolRequest
                        ? [
                            {
                              type: "toolCall",
                              id: first ? "create-worktree" : "finish-worktree",
                              name: "worktree",
                              arguments: first
                                ? { action: "create", branch: "feat/runtime", path: target }
                                : { action: "finish" },
                            },
                          ]
                        : [{ type: "text", text: "Agent chooses its next action." }],
                      usage: {
                        input: 1,
                        output: 1,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 2,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                      },
                    };
                    const stream = createAssistantMessageEventStream();
                    stream.push({ type: "start", partial: message });
                    stream.push({
                      type: "done",
                      reason: toolRequest ? "toolUse" : "stop",
                      message,
                    });
                    if (requests.length === 2) resolveContinuation();
                    if (requests.length === 4) resolveFinish();
                    return stream;
                  },
                });
                worktreeExtension(pi, {
                  settings: createWorktreeSettingsRuntime({
                    path: join(agentDir, "pi-worktree.json"),
                  }),
                });
              },
            ],
          },
        });
        const result = await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: modelRuntime.getModel("worktree-test", "fake"),
          thinkingLevel: "off",
          tools: ["worktree"],
        });
        return { ...result, services, diagnostics: services.diagnostics };
      };
      runtime = await createAgentSessionRuntime(factory, {
        cwd: main,
        agentDir,
        sessionManager: SessionManager.inMemory(main),
      });
      const bind = async (session: AgentSession) => {
        const ui = {
          confirm: async () => {
            confirmations++;
            if (confirmations === 1) {
              assert.ok(runtime);
              const disposition = await runtime.session.followUp(
                "Late queued user work must be refused during approval.",
              );
              assert.equal(disposition, "handled");
            }
            return true;
          },
          select: async (_title: string, options: string[]) => {
            confirmations++;
            return options[0];
          },
          notify: () => {},
        } as unknown as ExtensionUIContext;
        const currentRuntime = runtime;
        assert.ok(currentRuntime);
        await session.bindExtensions({
          uiContext: ui,
          mode: "rpc",
          onError: (event) => {
            errors.push(event.error);
          },
          commandContextActions: {
            waitForIdle: () => session.waitForIdle(),
            newSession: (options) => currentRuntime.newSession(options),
            fork: (entryId, options) => currentRuntime.fork(entryId, options),
            navigateTree: (entryId, options) => session.navigateTree(entryId, options),
            switchSession: (path, options) => currentRuntime.switchSession(path, options),
            reload: async () => {
              throw new Error("Unexpected reload");
            },
          },
        });
      };
      runtime.setRebindSession(bind);
      await bind(runtime.session);
      await runtime.session.prompt("Create the agreed feature worktree; keep this conversation.");
      await continuation;
      await runtime.session.waitForIdle();
      if (queuedBeforeProposal) {
        assert.equal(confirmations, 0);
        assert.equal(runtime.cwd, main);
        assert.equal(existsSync(target), false);
        assert.ok(requests.every((request) => request.cwd === main));
        assert.match(JSON.stringify(requests), /queued|pending/i);
        const result = runtime.session.messages.find((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && result.isError);
        assert.deepEqual(errors, []);
        return;
      }
      assert.equal(confirmations, 1);
      assert.equal(runtime.cwd, target);
      assert.equal(requests.length, 2);
      assert.equal(requests[1]?.cwd, target);
      assert.ok(existsSync(join(target, "tracked.txt")));
      const transcript = requests[1]?.messages as Array<{
        role: string;
        content?: unknown;
        toolCallId?: string;
      }>;
      assert.ok(
        transcript.some(
          (message) => message.role === "toolResult" && message.toolCallId === "create-worktree",
        ),
      );
      assert.ok(
        transcript
          .filter((message) => message.role === "user")
          .every(
            (message) =>
              message.content !== "" &&
              (!Array.isArray(message.content) || message.content.length > 0),
          ),
      );
      assert.match(JSON.stringify(transcript), /Create the agreed feature worktree/);
      assert.match(
        JSON.stringify(transcript),
        new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      writeFileSync(join(target, "implemented.txt"), "feature\n");
      execFileSync("git", ["add", "."], { cwd: target });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: target });
      git("merge", "--no-ff", "feat/runtime", "-m", "merge feature");
      await runtime.session.prompt(
        "The feature is merged. Return to main and clean up the worktree.",
      );
      await finished;
      await runtime.session.waitForIdle();
      assert.equal(confirmations, 2);
      assert.equal(runtime.cwd, main);
      assert.equal(requests.length, 4);
      assert.equal(requests[3]?.cwd, main);
      assert.equal(existsSync(target), false);
      assert.equal(git("branch", "--list", "feat/runtime"), "");
      const returnedTranscript = requests[3]?.messages as Array<{
        role: string;
        content?: unknown;
        toolCallId?: string;
      }>;
      assert.ok(
        returnedTranscript.some(
          (message) => message.role === "toolResult" && message.toolCallId === "finish-worktree",
        ),
      );
      assert.ok(
        returnedTranscript
          .filter((message) => message.role === "user")
          .every(
            (message) =>
              message.content !== "" &&
              (!Array.isArray(message.content) || message.content.length > 0),
          ),
      );
      assert.match(JSON.stringify(returnedTranscript), /Agent chooses its next action/);
      assert.match(JSON.stringify(returnedTranscript), /feature is merged/);
      assert.deepEqual(errors, []);
    } finally {
      await runtime?.dispose();
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
