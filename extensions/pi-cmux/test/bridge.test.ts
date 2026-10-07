import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { hookEnvironment, PiCmuxCommandDispatcher } from "../src/upstream/cmux-session.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface Command {
  args: string[];
  payload?: Record<string, unknown>;
}
const managerKey = Symbol.for("pi-subagents:manager");
const registry = globalThis as unknown as Record<symbol, unknown>;
const originalManager = registry[managerKey];
const originalEnvironment = { ...process.env };
let commands: Command[];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pi-cmux-test-"));
  commands = [];
  delete process.env.PI_CMUX_DISABLED;
  delete process.env.CMUX_PI_HOOKS_DISABLED;
  delete registry[managerKey];
  process.env.CMUX_SURFACE_ID = "test-surface";
  process.env.CMUX_WORKSPACE_ID = "test-workspace";
});
afterEach(async () => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  if (originalManager === undefined) delete registry[managerKey];
  else registry[managerKey] = originalManager;
  await rm(directory, { recursive: true, force: true });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
function hooks(name: string): Command[] {
  return commands.filter((command) => command.args[0] === "hooks" && command.args[2] === name);
}
function payload(name: string): Record<string, unknown> {
  const value = hooks(name)[0]?.payload;
  assert.ok(value, `Expected ${name} payload`);
  return value;
}
function background() {
  let running = true;
  let finishWait!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishWait = resolve;
  });
  let waits = 0;
  return {
    hasRunning: () => running,
    waitForAll: () => {
      waits += 1;
      return finished;
    },
    get waits() {
      return waits;
    },
    finish() {
      running = false;
      finishWait();
    },
  };
}
function setup(options: { child?: boolean; hasUI?: boolean; transport?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const api = {
    on(name: string, handler: Handler) {
      const entries = handlers.get(name) ?? [];
      entries.push(handler);
      handlers.set(name, entries);
      return () =>
        handlers.set(
          name,
          entries.filter((entry) => entry !== handler),
        );
    },
    events: {
      on(name: string, handler: (data: unknown) => void) {
        const entries = listeners.get(name) ?? new Set();
        entries.add(handler);
        listeners.set(name, entries);
        return () => entries.delete(handler);
      },
      emit(name: string, data: unknown) {
        for (const handler of listeners.get(name) ?? []) handler(data);
      },
    },
  };
  const pi = api as unknown as ExtensionAPI;
  let idle = true;
  const ui = {
    [Symbol.for("pi-subagents:child-extension-ui")]: options.child === true,
    confirm: async () => true,
    select: async () => "value",
    input: async () => "value",
  };
  const ctx = {
    cwd: directory,
    mode: "tui",
    hasUI: options.hasUI ?? false,
    ui,
    isIdle: () => idle,
    sessionManager: { getSessionId: () => (options.child ? "child" : "parent") },
  } as unknown as ExtensionContext;
  let metadataReady!: () => void;
  const metadata = new Promise<void>((resolve) => {
    metadataReady = resolve;
  });
  if (!options.transport) {
    mock.method(
      PiCmuxCommandDispatcher.prototype,
      "run",
      async (args: string[], _cwd: string, input: string | undefined) => {
        commands.push({ args, payload: input ? JSON.parse(input) : undefined });
        if (args[0] === "clear_git_branch") metadataReady();
        return { ok: true, status: 0, stdout: "{}", stderr: "", timeoutMs: 100, elapsedMs: 0 };
      },
    );
  }
  extension(pi);
  return {
    pi,
    ctx,
    ui,
    handlers,
    idle(value: boolean) {
      idle = value;
    },
    async event(name: string, event: unknown = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, { ...ctx });
    },
    async start() {
      for (const handler of handlers.get("session_start") ?? []) await handler({}, { ...ctx });
      if (!options.child && handlers.has("session_start")) await metadata;
      await flush();
    },
  };
}
async function turn(harness: ReturnType<typeof setup>, text = "Done") {
  harness.idle(false);
  await harness.event("before_agent_start", { prompt: "test" });
  await harness.event("agent_start");
  await harness.event("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  });
  harness.idle(true);
  await harness.event("agent_settled");
  await flush();
}
const started = "@eko24ive/pi-ask:started";
const completed = "@eko24ive/pi-ask:completed";

test("factory suppresses stock hooks before lifecycle dispatch", async () => {
  const harness = setup();
  assert.equal(process.env.CMUX_PI_HOOKS_DISABLED, "1");
  let stockCalls = 0;
  const stock: Handler = () => {
    if (process.env.CMUX_PI_HOOKS_DISABLED !== "1") stockCalls += 1;
  };
  const entries = harness.handlers.get("session_start");
  assert.ok(entries);
  entries.unshift(stock);
  entries.push(stock);
  await harness.start();
  assert.equal(stockCalls, 0);
  assert.equal(hooks("session-start").length, 1);
  await harness.event("session_shutdown");
  assert.equal(process.env.CMUX_PI_HOOKS_DISABLED, "1");
});

test("outside cmux the extension does not change the environment or register hooks", () => {
  delete process.env.CMUX_SURFACE_ID;
  const harness = setup();
  assert.equal(process.env.CMUX_PI_HOOKS_DISABLED, undefined);
  assert.equal(harness.handlers.size, 0);
});

test("own opt-out leaves the stock integration enabled", () => {
  process.env.PI_CMUX_DISABLED = "1";
  const harness = setup();
  assert.equal(process.env.CMUX_PI_HOOKS_DISABLED, undefined);
  assert.equal(harness.handlers.size, 0);
});

test("cmux subprocess environments strip suppression but retain routing and socket credentials", () => {
  setup();
  process.env.CMUX_SOCKET_PASSWORD = "test-socket-password";
  const gitEnvironment = hookEnvironment(directory);
  const cmuxEnvironment = hookEnvironment(directory, true);
  assert.equal(cmuxEnvironment.CMUX_PI_HOOKS_DISABLED, undefined);
  assert.equal(cmuxEnvironment.CMUX_SURFACE_ID, "test-surface");
  assert.equal(cmuxEnvironment.CMUX_WORKSPACE_ID, "test-workspace");
  assert.equal(cmuxEnvironment.CMUX_SOCKET_PASSWORD, "test-socket-password");
  assert.equal(gitEnvironment.CMUX_SOCKET_PASSWORD, undefined);
  assert.equal(process.env.CMUX_PI_HOOKS_DISABLED, "1");
});

test("ordinary turns notify only after final settlement and never twice", async () => {
  const harness = setup();
  await harness.start();
  harness.idle(false);
  await harness.event("before_agent_start", { prompt: "test" });
  await harness.event("agent_end", { messages: [] });
  await flush();
  assert.equal(hooks("stop").length, 0);
  harness.idle(true);
  await harness.event("agent_settled");
  await harness.event("agent_settled");
  await flush();
  assert.equal(hooks("stop").length, 1);
  assert.equal(hooks("notification").length, 1);
  await harness.event("session_shutdown");
});

test("running or queued background work defers completion without blocking settlement", async () => {
  const manager = background();
  registry[managerKey] = manager;
  const harness = setup();
  await harness.start();
  await turn(harness);
  await harness.event("agent_settled");
  assert.equal(manager.waits, 1);
  assert.equal(hooks("stop").length, 0);
  assert.equal(hooks("notification").length, 0);
  manager.finish();
  await flush();
  assert.equal(hooks("stop").length, 1);
  await harness.event("session_shutdown");
});

test("child sessions cannot publish or clear parent workspace state", async () => {
  const harness = setup({ child: true, hasUI: true });
  await harness.start();
  await turn(harness);
  await harness.event("tool_execution_start", { toolName: "bash", toolCallId: "tool" });
  await harness.event("tool_execution_end", { toolName: "bash", toolCallId: "tool" });
  harness.pi.events.emit(started, { flowId: "child-form" });
  harness.pi.events.emit(completed, { flowId: "child-form" });
  await harness.event("session_shutdown");
  assert.deepEqual(commands, []);
});

test("idle scheduler and mention spawns enter busy until background work finishes", async () => {
  const manager = background();
  registry[managerKey] = manager;
  const harness = setup();
  await harness.start();
  harness.pi.events.emit("subagents:started", { id: "scheduled" });
  await flush();
  assert.equal(hooks("prompt-submit").length, 1);
  assert.equal(hooks("stop").length, 0);
  manager.finish();
  await flush();
  assert.equal(hooks("stop").length, 1);
  await harness.event("session_shutdown");
});

test("new parent turns supersede a pending background completion", async () => {
  const manager = background();
  registry[managerKey] = manager;
  const harness = setup();
  await harness.start();
  await turn(harness);
  harness.idle(false);
  await harness.event("before_agent_start", { prompt: "next" });
  manager.finish();
  await flush();
  assert.equal(hooks("stop").length, 0);
  await turn(harness, "Next done");
  assert.equal(payload("stop").last_assistant_message, "Next done");
  await harness.event("session_shutdown");
});

for (const boundary of ["session_shutdown", "session_start"]) {
  test(`${boundary} invalidates detached waits from the preceding activation`, async () => {
    const manager = background();
    registry[managerKey] = manager;
    const harness = setup();
    await harness.start();
    await turn(harness);
    if (boundary === "session_shutdown") await harness.event(boundary);
    else await harness.start();
    const count = commands.length;
    manager.finish();
    await flush();
    assert.equal(commands.length, count);
    if (boundary !== "session_shutdown") await harness.event("session_shutdown");
  });
}

for (const cancelled of [false, true]) {
  test(`pi-ask ${cancelled ? "cancellation" : "submission"} resolves needs-input with the same turn`, async () => {
    const harness = setup({ hasUI: true });
    await harness.start();
    harness.idle(false);
    await harness.event("before_agent_start", { prompt: "ask" });
    harness.pi.events.emit(started, { version: 1, flowId: "form", source: "tool" });
    await flush();
    const question = payload("notification");
    assert.equal(question.event, "questionAsked");
    assert.equal(question.message, "needs_input");
    assert.deepEqual(question.notification, { type: "question" });
    harness.pi.events.emit(completed, { version: 1, flowId: "form", result: { cancelled } });
    await flush();
    assert.equal(payload("approval-response").turn_id, question.turn_id);
    assert.equal(payload("approval-response").cmux_pi_idle_dialog, false);
    await harness.event("session_shutdown");
  });
}

test("replayed idle forms return to idle without generating a task-completion notice", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  harness.pi.events.emit(started, { flowId: "replay", source: "ask:replay" });
  harness.pi.events.emit(completed, { flowId: "replay", result: {} });
  await flush();
  assert.equal(hooks("notification").length, 1);
  assert.equal(payload("approval-response").cmux_pi_idle_dialog, true);
  assert.equal(hooks("stop").length, 0);
  await harness.event("session_shutdown");
});

test("ask flow matching ignores duplicate events and unmatched completions", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  harness.pi.events.emit(started, {});
  harness.pi.events.emit(started, { flowId: "form" });
  harness.pi.events.emit(started, { flowId: "form" });
  harness.pi.events.emit(completed, { flowId: "other" });
  harness.pi.events.emit(completed, { flowId: "form" });
  harness.pi.events.emit(completed, { flowId: "form" });
  await flush();
  assert.equal(hooks("notification").length, 1);
  assert.equal(hooks("approval-response").length, 1);
  await harness.event("session_shutdown");
});

test("answering an idle form cannot mark a newly started background agent idle", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  harness.pi.events.emit(started, { flowId: "replay", source: "ask:replay" });
  const manager = background();
  registry[managerKey] = manager;
  harness.pi.events.emit("subagents:started", { id: "scheduled" });
  harness.pi.events.emit(completed, { flowId: "replay", result: {} });
  await flush();
  assert.equal(payload("approval-response").cmux_pi_idle_dialog, false);
  assert.equal(hooks("stop").length, 0);
  manager.finish();
  await flush();
  assert.equal(hooks("stop").length, 1);
  await harness.event("session_shutdown");
});

test("background completion cannot mark an open form idle", async () => {
  const manager = background();
  registry[managerKey] = manager;
  const harness = setup({ hasUI: true });
  await harness.start();
  await turn(harness);
  harness.pi.events.emit(started, { flowId: "replay", source: "ask:replay" });
  manager.finish();
  await flush();
  assert.equal(hooks("stop").length, 0);
  harness.pi.events.emit(completed, { flowId: "replay", result: {} });
  await flush();
  assert.equal(hooks("stop").length, 1);
  await harness.event("session_shutdown");
});

test("standard dialogs still notify and resolve, and shutdown unsubscribes pi-ask", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  await harness.ctx.ui.confirm("Global permission grant", "Confirm authority change");
  await harness.ctx.ui.select("Directory or network approval", ["Allow", "Deny"]);
  await harness.ctx.ui.input("Directory scope", directory);
  await flush();
  assert.equal(hooks("notification").length, 3);
  assert.equal(hooks("approval-response").length, 3);
  await harness.event("session_shutdown");
  const count = commands.length;
  harness.pi.events.emit(started, { flowId: "later" });
  harness.pi.events.emit(completed, { flowId: "later" });
  await flush();
  assert.equal(commands.length, count);
});

test("real cmux command transport receives unsuppressed environments and preserves lifecycle order", async () => {
  const cli = path.join(directory, "cmux");
  const log = path.join(directory, "commands.jsonl");
  const fixture = await readFile(new URL("./fixtures/cmux.mjs", import.meta.url), "utf8");
  await writeFile(cli, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
  process.env.CMUX_PI_CMUX_BIN = cli;
  process.env.CMUX_TEST_PI_LOG = log;
  const harness = setup({ transport: true });
  await harness.event("session_start");
  await turn(harness);
  await harness.event("session_shutdown");
  const records = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(records.length > 0);
  assert.ok(records.every((record) => record.stockDisabled === undefined));
  assert.deepEqual(
    records.filter((record) => record.args[0] === "hooks").map((record) => record.args[2]),
    ["session-start", "prompt-submit", "notification", "stop"],
  );
  assert.ok(
    records.some((record) => record.args.includes("resume") && record.args.includes("clear")),
  );
  assert.equal(process.env.CMUX_PI_HOOKS_DISABLED, "1");
});
