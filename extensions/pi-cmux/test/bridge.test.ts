import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
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
  const custom: ExtensionContext["ui"]["custom"] = (factory) =>
    new Promise((resolve, reject) => {
      try {
        // Model Pi's promise boundary, including early/idempotent done and factory failures.
        Promise.resolve(factory({} as never, {} as never, {} as never, resolve)).catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  const ui: Pick<ExtensionContext["ui"], "confirm" | "select" | "input" | "custom"> & {
    [key: symbol]: unknown;
  } = {
    [Symbol.for("pi-subagents:child-extension-ui")]: options.child === true,
    confirm: async () => true,
    select: async () => "value",
    input: async () => "value",
    custom,
  };
  const ctx = {
    cwd: directory,
    mode: "tui",
    hasUI: options.hasUI ?? false,
    ui,
    isIdle: () => idle,
    sessionManager: { getSessionId: () => (options.child ? "child" : "parent") },
  } as unknown as ExtensionContext;
  let metadata = deferred();
  if (!options.transport) {
    mock.method(
      PiCmuxCommandDispatcher.prototype,
      "run",
      async (args: string[], _cwd: string, input: string | undefined) => {
        commands.push({ args, payload: input ? JSON.parse(input) : undefined });
        if (args[0] === "clear_git_branch") metadata.resolve();
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
      metadata = deferred();
      for (const handler of handlers.get("session_start") ?? []) await handler({}, { ...ctx });
      if (!options.child && handlers.has("session_start")) await metadata.promise;
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
const inputDialog = Symbol.for("pi-extensions:input-dialog");
const component = { render: () => [], invalidate() {} };

function nativeOptions(marker: unknown) {
  const options: ExtensionUIDialogOptions = {};
  return Object.assign(options, { [inputDialog]: marker });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function question(harness: ReturnType<typeof setup>, ...markers: unknown[]) {
  const marker = markers.length > 0 ? markers[0] : true;
  let close!: (value: unknown) => void;
  const factory: Parameters<ExtensionContext["ui"]["custom"]>[0] = (_tui, _theme, _keys, done) => {
    close = done;
    return component;
  };
  const result = harness.ctx.ui.custom(Object.assign(factory, { [inputDialog]: marker }));
  return { result, close };
}

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

test("completion notices cannot mistake answer prose for an approval or error", async () => {
  const harness = setup();
  await harness.start();
  const text = "Reviewed permission approvals and error handling. No files changed.";
  await turn(harness, text);
  assert.equal(payload("notification").message, "Task completed");
  assert.deepEqual(payload("notification").notification, { type: "completed" });
  assert.equal(payload("stop").last_assistant_message, text);
  assert.equal(payload("stop").cmux_notification_routed, true);
  await harness.event("session_shutdown");
});

test("assistant questions retain their input request and notification text", async () => {
  const harness = setup();
  await harness.start();
  const text = "Which option would you prefer?";
  await turn(harness, text);
  assert.equal(payload("notification").message, text);
  assert.deepEqual(payload("notification").notification, { type: "question" });
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
  test(`marked custom ${cancelled ? "cancellation" : "submission"} resolves needs-input with the same turn`, async () => {
    const harness = setup({ hasUI: true });
    await harness.start();
    harness.idle(false);
    await harness.event("before_agent_start", { prompt: "ask" });
    const form = question(harness);
    await flush();
    const notice = payload("notification");
    assert.equal(notice.event, "questionAsked");
    assert.equal(notice.message, "needs_input");
    assert.deepEqual(notice.notification, { type: "question" });
    form.close({ cancelled });
    assert.deepEqual(await form.result, { cancelled });
    await flush();
    assert.equal(payload("approval-response").turn_id, notice.turn_id);
    assert.equal(payload("approval-response").cmux_pi_idle_dialog, false);
    await harness.event("session_shutdown");
  });
}

test("idle forms return to idle without generating a task-completion notice", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  const form = question(harness);
  form.close(undefined);
  await form.result;
  await flush();
  assert.equal(hooks("notification").length, 1);
  assert.equal(payload("approval-response").cmux_pi_idle_dialog, true);
  assert.equal(hooks("stop").length, 0);
  await harness.event("session_shutdown");
});

test("pi-ask events alone do nothing, and cannot close or duplicate a marked form", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  harness.pi.events.emit(started, { flowId: "events-only" });
  harness.pi.events.emit(completed, { flowId: "events-only" });
  await flush();
  assert.equal(hooks("notification").length, 0);
  assert.equal(hooks("approval-response").length, 0);
  const form = question(harness);
  harness.pi.events.emit(started, { flowId: "form" });
  harness.pi.events.emit(started, { flowId: "form" });
  harness.pi.events.emit(completed, { flowId: "form" });
  await turn(harness);
  assert.equal(hooks("notification").length, 1);
  assert.equal(hooks("approval-response").length, 0);
  assert.equal(hooks("stop").length, 0);
  form.close("answer");
  await form.result;
  await flush();
  assert.equal(hooks("approval-response").length, 1);
  assert.equal(hooks("stop").length, 1);
  await harness.event("session_shutdown");
});

for (const newerWork of ["main", "background"]) {
  test(`answering an idle form cannot mark a newer ${newerWork} turn idle`, async () => {
    const harness = setup({ hasUI: true });
    await harness.start();
    const form = question(harness);
    let manager: ReturnType<typeof background> | undefined;
    if (newerWork === "background") {
      manager = background();
      registry[managerKey] = manager;
      harness.pi.events.emit("subagents:started", { id: "scheduled" });
    } else {
      harness.idle(false);
      await harness.event("before_agent_start", { prompt: "new work" });
    }
    form.close(undefined);
    await form.result;
    await flush();
    assert.equal(payload("approval-response").cmux_pi_idle_dialog, false);
    assert.equal(hooks("stop").length, 0);
    if (manager) {
      manager.finish();
      await flush();
      assert.equal(hooks("stop").length, 1);
    }
    await harness.event("session_shutdown");
  });
}

test("background completion cannot mark an open form idle", async () => {
  const manager = background();
  registry[managerKey] = manager;
  const harness = setup({ hasUI: true });
  await harness.start();
  await turn(harness);
  const form = question(harness);
  manager.finish();
  await flush();
  assert.equal(hooks("stop").length, 0);
  form.close(undefined);
  await form.result;
  await flush();
  assert.equal(hooks("stop").length, 1);
  await harness.event("session_shutdown");
});

test("standard dialogs still notify and resolve", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  await harness.ctx.ui.confirm("Global permission grant", "Confirm authority change");
  await harness.ctx.ui.select("Directory or network approval", ["Allow", "Deny"]);
  await harness.ctx.ui.input("Directory scope", directory);
  await flush();
  assert.equal(hooks("notification").length, 3);
  assert.equal(hooks("approval-response").length, 3);
  await harness.event("session_shutdown");
});

test("real cmux command transport receives unsuppressed environments and preserves lifecycle order", async () => {
  const cli = path.join(directory, "cmux");
  const log = path.join(directory, "commands.jsonl");
  const fixture = await readFile(new URL("./fixtures/cmux.mjs", import.meta.url), "utf8");
  await writeFile(cli, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
  process.env.CMUX_PI_CMUX_BIN = cli;
  process.env.CMUX_TEST_PI_LOG = log;
  const harness = setup({ transport: true });
  const stopped = deferred();
  const run = PiCmuxCommandDispatcher.prototype.run;
  mock.method(
    PiCmuxCommandDispatcher.prototype,
    "run",
    async function (this: PiCmuxCommandDispatcher, ...args: Parameters<typeof run>) {
      const result = await run.apply(this, args);
      if (args[0][2] === "stop") stopped.resolve();
      return result;
    },
  );
  await harness.event("session_start");
  await turn(harness);
  await stopped.promise;
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

test("only literal true on the custom factory opts in; options and lookalike titles do not", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  for (const marker of [undefined, false, 1, "true", {}]) {
    const form = question(harness, marker);
    await flush();
    assert.equal(hooks("notification").length, 0);
    form.close(marker);
    assert.equal(await form.result, marker);
  }
  await harness.ctx.ui.custom(
    (_tui, _theme, _keys, done) => {
      done("needs_input");
      return component;
    },
    Object.assign({ overlay: true }, { [inputDialog]: true }),
  );
  await flush();
  assert.equal(hooks("notification").length, 0);
  assert.equal(hooks("approval-response").length, 0);
  await harness.event("session_shutdown");
});

test("factories, options, arguments, binding, and generic results are forwarded unchanged", async () => {
  const harness = setup({ hasUI: true });
  const result = { answer: 42 };
  const factory = Object.assign(
    (_tui: unknown, _theme: unknown, _keys: unknown, done: (value: typeof result) => void) => {
      done(result);
      return component;
    },
    { [inputDialog]: true },
  );
  const options = { overlay: true };
  const nativeOptions = Object.assign(
    { timeout: 123, signal: new AbortController().signal },
    { [inputDialog]: false },
  );
  const choices = ["Allow", "Deny"];
  const seen: unknown[][] = [];
  mock.method(
    harness.ui,
    "custom",
    function (this: typeof harness.ui, ...args: Parameters<typeof harness.ui.custom>) {
      assert.equal(this, harness.ui);
      assert.equal(args[0], factory);
      assert.equal(args[1], options);
      seen.push(args);
      return Promise.resolve(result);
    },
  );
  for (const method of ["confirm", "select", "input"] as const) {
    mock.method(
      harness.ui,
      method,
      function (this: typeof harness.ui, ...args: Parameters<(typeof harness.ui)[typeof method]>) {
        assert.equal(this, harness.ui);
        seen.push(args);
        return Promise.resolve(method === "confirm" ? false : "original");
      },
    );
  }
  await harness.start();
  const customResult: typeof result = await harness.ctx.ui.custom<typeof result>(factory, options);
  assert.equal(customResult, result);
  assert.equal(await harness.ctx.ui.confirm("title", "message", nativeOptions), false);
  assert.equal(await harness.ctx.ui.select("title", choices, nativeOptions), "original");
  assert.equal(await harness.ctx.ui.input("title", "placeholder", nativeOptions), "original");
  assert.deepEqual(seen.slice(1), [
    ["title", "message", nativeOptions],
    ["title", choices, nativeOptions],
    ["title", "placeholder", nativeOptions],
  ]);
  assert.equal(seen[2]?.[1], choices);
  assert.ok(seen.slice(1).every((args) => args[2] === nativeOptions));
  assert.equal(Object.getOwnPropertyDescriptor(nativeOptions, inputDialog)?.enumerable, true);
  assert.equal({ ...nativeOptions }[inputDialog], false);
  assert.equal(factory[inputDialog], true);
  await flush();
  assert.equal(hooks("notification").length, 1);
  assert.equal(hooks("approval-response").length, 1);
  seen.length = 0;
  await harness.ctx.ui.confirm("legacy", "no options");
  assert.equal(seen[0]?.length, 2);
  await flush();
  assert.equal(hooks("notification").length, 2);
  await harness.event("session_shutdown");
});

test("native opt-out is literal false for all three methods; other values retain legacy tracking", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  for (const marker of [false, undefined, true, 0, "false"]) {
    const options = nativeOptions(marker);
    await harness.ctx.ui.confirm("title", "message", options);
    await harness.ctx.ui.select("title", ["value"], options);
    await harness.ctx.ui.input("title", "placeholder", options);
  }
  await flush();
  assert.equal(hooks("notification").length, 12);
  assert.equal(hooks("approval-response").length, 12);
  await harness.event("session_shutdown");
});

test("unresolved manual menus and loaders neither hold completion nor clear a tracked question", async () => {
  const manager = background();
  registry[managerKey] = manager;
  const harness = setup({ hasUI: true });
  const manualNative = deferred<string | undefined>();
  mock.method(harness.ui, "select", () => manualNative.promise);
  await harness.start();
  const menu = question(harness, false);
  const loader = question(harness, undefined);
  const native = harness.ctx.ui.select("manual", ["one"], nativeOptions(false));
  await turn(harness);
  manager.finish();
  await flush();
  assert.equal(hooks("stop").length, 1);
  const form = question(harness);
  menu.close(undefined);
  loader.close(undefined);
  manualNative.resolve(undefined);
  await Promise.all([menu.result, loader.result, native]);
  await flush();
  assert.equal(hooks("approval-response").length, 0);
  form.close("answer");
  await form.result;
  await flush();
  assert.equal(hooks("approval-response").length, 1);
  await harness.event("session_shutdown");
});

for (const customFirstClose of [false, true]) {
  test(`overlapping custom/native waits retain the first cohort (${customFirstClose ? "custom" : "native"} closes first)`, async () => {
    const harness = setup({ hasUI: true });
    const native = deferred<boolean>();
    mock.method(harness.ui, "confirm", () => native.promise);
    await harness.start();
    const form = question(harness);
    await flush();
    const first = payload("notification");
    harness.idle(false);
    await harness.event("before_agent_start", { turnId: "new-turn", prompt: "work" });
    harness.ctx.cwd = path.join(directory, "other-context");
    const approval = harness.ctx.ui.confirm("approval", "allow?");
    await flush();
    assert.equal(hooks("notification").length, 1);
    if (customFirstClose) {
      form.close("answer");
      await form.result;
    } else {
      native.resolve(true);
      await approval;
    }
    await flush();
    assert.equal(hooks("approval-response").length, 0);
    await harness.event("agent_end", { messages: [] });
    harness.idle(true);
    await harness.event("agent_settled");
    await flush();
    assert.equal(hooks("stop").length, 0);
    if (customFirstClose) {
      native.resolve(true);
      await approval;
    } else {
      form.close("answer");
      await form.result;
    }
    await flush();
    assert.equal(hooks("approval-response").length, 1);
    assert.equal(payload("approval-response").turn_id, first.turn_id);
    assert.equal(payload("approval-response").cwd, directory);
    assert.equal(payload("approval-response").cmux_pi_idle_dialog, false);
    assert.equal(hooks("stop").length, 1);
    await harness.event("session_shutdown");
  });
}

for (const method of ["confirm", "select", "input"] as const) {
  test(`a synchronous ${method} throw releases its wait and preserves the error`, async () => {
    const harness = setup({ hasUI: true });
    const error = new Error("synchronous failure");
    mock.method(harness.ui, method, () => {
      throw error;
    });
    await harness.start();
    assert.throws(
      () => {
        if (method === "select") harness.ctx.ui.select("title", []);
        else if (method === "confirm") harness.ctx.ui.confirm("title", "message");
        else harness.ctx.ui.input("title");
      },
      (caught) => caught === error,
    );
    await turn(harness);
    assert.equal(hooks("approval-response").length, 1);
    assert.equal(hooks("stop").length, 1);
    await harness.event("session_shutdown");
  });
}

test("native rejection and synchronous/asynchronous factory failure release exactly once", async () => {
  const harness = setup({ hasUI: true });
  const error = new Error("dialog failure");
  mock.method(harness.ui, "input", () => Promise.reject(error));
  await harness.start();
  await assert.rejects(harness.ctx.ui.input("title"), (caught) => caught === error);
  for (const asynchronous of [false, true]) {
    const factory = Object.assign(
      () => {
        if (asynchronous) return Promise.reject(error);
        throw error;
      },
      { [inputDialog]: true },
    );
    await assert.rejects(harness.ctx.ui.custom(factory), (caught) => caught === error);
  }
  await turn(harness);
  assert.equal(hooks("approval-response").length, 3);
  assert.equal(hooks("stop").length, 1);
  await harness.event("session_shutdown");
});

test("early and repeated done follow the custom result promise, not asynchronous component creation", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  const creation = deferred<typeof component>();
  const result = harness.ctx.ui.custom(
    Object.assign(
      (_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
        done("first");
        done("second");
        return creation.promise;
      },
      { [inputDialog]: true },
    ),
  );
  assert.equal(await result, "first");
  await turn(harness);
  assert.equal(hooks("approval-response").length, 1);
  assert.equal(hooks("stop").length, 1);
  creation.reject(new Error("late factory failure"));
  await flush();
  assert.equal(hooks("approval-response").length, 1);
  await harness.event("session_shutdown");
});

for (const boundary of ["session_start", "session_shutdown"]) {
  test(`${boundary} restores four methods and invalidates late receipt callbacks`, async () => {
    const harness = setup({ hasUI: true });
    const originals = { ...harness.ui };
    await harness.start();
    const stale = question(harness);
    await flush();
    if (boundary === "session_start") await harness.start();
    else await harness.event(boundary);
    if (boundary === "session_shutdown") {
      for (const method of ["confirm", "select", "input", "custom"] as const)
        assert.equal(harness.ui[method], originals[method]);
      await harness.start();
    }
    const current = question(harness);
    stale.close("stale answer");
    await stale.result;
    await flush();
    assert.equal(hooks("approval-response").length, 0);
    await turn(harness);
    const stops = boundary === "session_shutdown" ? 1 : 0;
    assert.equal(hooks("stop").length, stops);
    current.close("new answer");
    await current.result;
    await flush();
    assert.equal(hooks("approval-response").length, 1);
    assert.equal(hooks("stop").length, stops + 1);
    await harness.event("session_shutdown");
  });
}

test("cleanup preserves later third-party replacements and stale wrapper calls cannot acquire receipts", async () => {
  const harness = setup({ hasUI: true });
  const originals = { ...harness.ui };
  await harness.start();
  const oldConfirm = harness.ui.confirm;
  const replacementConfirm = async () => false;
  const replacementCustom: typeof harness.ui.custom = async () => undefined as never;
  harness.ui.confirm = replacementConfirm;
  harness.ui.custom = replacementCustom;
  await harness.event("session_shutdown");
  assert.equal(harness.ui.confirm, replacementConfirm);
  assert.equal(harness.ui.custom, replacementCustom);
  assert.equal(harness.ui.select, originals.select);
  assert.equal(harness.ui.input, originals.input);
  await harness.start();
  const before = commands.length;
  assert.equal(await oldConfirm("stale", "wrapper"), true);
  await flush();
  assert.equal(commands.length, before);
  await harness.event("session_shutdown");
  assert.equal(harness.ui.confirm, replacementConfirm);
  assert.equal(harness.ui.custom, replacementCustom);
});

for (const options of [{ hasUI: false }, { child: true, hasUI: true }]) {
  test(`excluded UI is left untouched (${options.child ? "child" : "no UI"})`, async () => {
    const harness = setup(options);
    const originals = { ...harness.ui };
    await harness.start();
    for (const method of ["confirm", "select", "input", "custom"] as const)
      assert.equal(harness.ui[method], originals[method]);
    const form = question(harness);
    form.close(undefined);
    await form.result;
    await flush();
    assert.equal(hooks("notification").length, 0);
    await harness.event("session_shutdown");
  });
}

function stallRun(name: string, shouldStall: (command: Command) => boolean = () => true) {
  const entered = deferred();
  const released = deferred();
  const run = PiCmuxCommandDispatcher.prototype.run;
  let stalled = false;
  mock.method(
    PiCmuxCommandDispatcher.prototype,
    "run",
    async function (this: PiCmuxCommandDispatcher, ...args: Parameters<typeof run>) {
      const command = { args: args[0], payload: args[2] ? JSON.parse(args[2]) : undefined };
      const result = await run.apply(this, args);
      if (!stalled && command.args[2] === name && shouldStall(command)) {
        stalled = true;
        entered.resolve();
        await released.promise;
      }
      return result;
    },
  );
  return { entered: entered.promise, release: () => released.resolve() };
}

function stallFeed() {
  const entered = deferred();
  const released = deferred();
  const finish = PiCmuxCommandDispatcher.prototype.finishFeedForSession;
  let stalled = false;
  mock.method(
    PiCmuxCommandDispatcher.prototype,
    "finishFeedForSession",
    async function (this: PiCmuxCommandDispatcher, sessionId: string) {
      if (!stalled) {
        stalled = true;
        entered.resolve();
        await released.promise;
      }
      await finish.call(this, sessionId);
    },
  );
  return { entered: entered.promise, release: () => released.resolve() };
}

for (const stage of ["queued", "feed-stalled"]) {
  test(`a late marked form defers ${stage} completion and retries the original claim once`, async () => {
    const harness = setup({ hasUI: true });
    await harness.start();
    const stall = stage === "queued" ? stallRun("prompt-submit") : stallFeed();
    await turn(harness, "original answer");
    await stall.entered;
    const originalTurn = payload("prompt-submit").turn_id;
    const form = question(harness);
    stall.release();
    await flush();
    assert.equal(
      hooks("notification").filter((entry) => entry.payload?.message === "Task completed").length,
      0,
    );
    assert.equal(hooks("stop").length, 0);
    assert.equal(payload("notification").message, "needs_input");
    await harness.event("agent_settled");
    form.close(undefined);
    await form.result;
    await flush();
    assert.equal(hooks("stop").length, 1);
    assert.equal(payload("stop").turn_id, originalTurn);
    assert.equal(payload("stop").last_assistant_message, "original answer");
    assert.equal(payload("stop").cmux_notification_routed, true);
    assert.equal(hooks("notification").length, 2);
    await harness.event("agent_settled");
    await harness.event("session_shutdown");
    assert.equal(hooks("stop").length, 1);
  });
}

test("final receipt closing before the queued reset retries completion without another settlement", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  const answered = deferred<string>();
  const finish = PiCmuxCommandDispatcher.prototype.finishFeedForSession;
  mock.method(
    PiCmuxCommandDispatcher.prototype,
    "finishFeedForSession",
    async function (this: PiCmuxCommandDispatcher, sessionId: string) {
      await finish.call(this, sessionId);
      let close!: (answer: string) => void;
      const factory: Parameters<typeof harness.ctx.ui.custom<string>>[0] = async (
        _tui,
        _theme,
        _keys,
        done,
      ) => {
        close = done;
        return component;
      };
      const result = harness.ctx.ui.custom(Object.assign(factory, { [inputDialog]: true }));
      // The publisher sees this wait before its receipt releases, but the
      // receipt's finally runs before the queued publisher's outer finally.
      queueMicrotask(() => close("answer"));
      void result.then(answered.resolve, answered.reject);
    },
  );
  harness.idle(false);
  await harness.event("before_agent_start", { prompt: "work" });
  await harness.event("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "Original answer" }] }],
  });
  harness.idle(true);
  await harness.event("agent_settled");
  assert.equal(await answered.promise, "answer");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completions = hooks("notification").filter(
    (entry) => entry.payload?.message === "Task completed",
  );
  assert.equal(completions.length, 1);
  assert.equal(hooks("approval-response").length, 1);
  assert.equal(hooks("stop").length, 1);
  const originalTurn = payload("prompt-submit").turn_id;
  assert.equal(completions[0]?.payload?.turn_id, originalTurn);
  assert.equal(payload("stop").turn_id, originalTurn);
  assert.equal(payload("stop").last_assistant_message, "Original answer");
  await harness.event("session_shutdown");
  assert.equal(hooks("stop").length, 1);
  assert.equal(
    hooks("notification").filter((entry) => entry.payload?.message === "Task completed").length,
    1,
  );
});

for (const notificationOK of [true, false]) {
  test(`a form between notification and Stop retains ${notificationOK ? "routed" : "failed"} notification progress`, async () => {
    const harness = setup({ hasUI: true });
    await harness.start();
    if (!notificationOK) {
      const run = PiCmuxCommandDispatcher.prototype.run;
      mock.method(
        PiCmuxCommandDispatcher.prototype,
        "run",
        async function (this: PiCmuxCommandDispatcher, ...args: Parameters<typeof run>) {
          const result = await run.apply(this, args);
          const data = args[2] ? JSON.parse(args[2]) : undefined;
          return data?.message === "Task completed" ? { ...result, ok: false, status: 1 } : result;
        },
      );
    }
    const stall = stallRun(
      "notification",
      (command) => command.payload?.message === "Task completed",
    );
    await turn(harness);
    await stall.entered;
    const form = question(harness);
    stall.release();
    await flush();
    assert.equal(hooks("stop").length, 0);
    assert.equal(hooks("notification").length, 2);
    form.close("answer");
    await form.result;
    await flush();
    assert.equal(hooks("notification").length, 2);
    assert.equal(hooks("stop").length, 1);
    assert.equal(payload("stop").cmux_notification_routed, notificationOK ? true : undefined);
    await harness.event("session_shutdown");
    assert.equal(hooks("stop").length, 1);
  });
}

for (const newerWork of ["main", "background"]) {
  test(`new ${newerWork} work supersedes a deferred claim without publishing its old completion`, async () => {
    const harness = setup({ hasUI: true });
    await harness.start();
    const stall = stallFeed();
    await turn(harness, "stale answer");
    await stall.entered;
    const staleTurn = payload("prompt-submit").turn_id;
    const form = question(harness);
    stall.release();
    await flush();
    const lateFeed = mock.method(PiCmuxCommandDispatcher.prototype, "enqueueFeed", () => {});
    await harness.event("tool_execution_end", { toolName: "read", toolCallId: "late-result" });
    await flush();
    assert.equal(lateFeed.mock.callCount(), 0);
    let manager: ReturnType<typeof background> | undefined;
    if (newerWork === "main") await turn(harness, "new answer");
    else {
      manager = background();
      registry[managerKey] = manager;
      harness.pi.events.emit("subagents:started", { id: "new background work" });
    }
    form.close(undefined);
    await form.result;
    await flush();
    if (manager) {
      assert.equal(hooks("stop").length, 0);
      manager.finish();
      await flush();
    }
    assert.equal(hooks("stop").length, 1);
    assert.notEqual(payload("stop").turn_id, staleTurn);
    assert.equal(
      payload("stop").last_assistant_message,
      newerWork === "main" ? "new answer" : undefined,
    );
    assert.equal(
      hooks("notification").filter((entry) => entry.payload?.message === "Task completed").length,
      1,
    );
    await harness.event("session_shutdown");
  });
}

for (const boundary of ["session_start", "session_shutdown"]) {
  test(`${boundary} invalidates in-flight completion and queued dialog effects`, async () => {
    const harness = setup({ hasUI: true });
    await harness.start();
    const stall = stallFeed();
    await turn(harness, "stale answer");
    await stall.entered;
    const stale = question(harness);
    const boundaryResult = boundary === "session_start" ? harness.start() : harness.event(boundary);
    stall.release();
    await boundaryResult;
    await flush();
    assert.equal(hooks("notification").length, 0);
    assert.equal(hooks("stop").length, boundary === "session_shutdown" ? 1 : 0);
    stale.close("late answer");
    await stale.result;
    await flush();
    assert.equal(hooks("approval-response").length, 0);
    if (boundary === "session_start") {
      await turn(harness, "fresh answer");
      assert.equal(payload("stop").last_assistant_message, "fresh answer");
      await harness.event("session_shutdown");
      assert.equal(hooks("stop").length, 1);
    }
  });
}

for (const shutdown of [false, true]) {
  test(`feed failure survives deferral and uses Stop fallback on ${shutdown ? "shutdown" : "retry"}`, async () => {
    const harness = setup({ hasUI: true });
    await harness.start();
    mock.method(
      PiCmuxCommandDispatcher.prototype,
      "enqueueFeed",
      (...[_key, command]: Parameters<PiCmuxCommandDispatcher["enqueueFeed"]>) => {
        if (command.terminal) command.onFailure?.();
      },
    );
    harness.idle(false);
    await harness.event("before_agent_start", { prompt: "work" });
    await harness.event("tool_execution_end", { toolName: "read", toolCallId: "failed" });
    const stall = stallFeed();
    const notice = stallRun("notification", (entry) => entry.payload?.message === "needs_input");
    await harness.event("agent_end", { messages: [] });
    harness.idle(true);
    await harness.event("agent_settled");
    await stall.entered;
    const form = question(harness);
    stall.release();
    await notice.entered;
    assert.equal(hooks("stop").length, 0);
    notice.release();
    if (shutdown) await harness.event("session_shutdown");
    form.close(undefined);
    await form.result;
    await flush();
    assert.equal(hooks("notification").length, 1);
    assert.equal(payload("notification").message, "needs_input");
    assert.equal(payload("stop").turn_id, payload("prompt-submit").turn_id);
    assert.equal(payload("stop").cmux_notification_routed, undefined);
    if (!shutdown) {
      await harness.event("agent_settled");
      await harness.event("session_shutdown");
    }
    assert.equal(hooks("stop").length, 1);
    assert.equal(hooks("approval-response").length, shutdown ? 0 : 1);
  });
}

test("intentional interruption suppression survives deferral and shutdown does not duplicate Stop", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  const stall = stallFeed();
  harness.idle(false);
  await harness.event("before_agent_start", { prompt: "work" });
  await harness.event("agent_end", {
    messages: [
      { role: "assistant", stopReason: "stop", cmuxSuppressNotification: true, content: [] },
    ],
  });
  harness.idle(true);
  await harness.event("agent_settled");
  await stall.entered;
  const form = question(harness);
  stall.release();
  await flush();
  form.close(undefined);
  await form.result;
  await flush();
  assert.equal(hooks("notification").length, 1);
  assert.equal(payload("stop").cmux_notification_routed, true);
  await harness.event("session_shutdown");
  assert.equal(hooks("stop").length, 1);
});

for (const runningWork of ["main", "background"]) {
  test(`in-flight publication rechecks ${runningWork} settlement and retries without a dialog`, async () => {
    const harness = setup();
    await harness.start();
    const stall = stallFeed();
    await turn(harness);
    await stall.entered;
    let manager: ReturnType<typeof background> | undefined;
    if (runningWork === "main") harness.idle(false);
    else {
      manager = background();
      registry[managerKey] = manager;
    }
    stall.release();
    await flush();
    assert.equal(hooks("notification").length, 0);
    assert.equal(hooks("stop").length, 0);
    if (manager) {
      assert.equal(manager.waits, 1);
      manager.finish();
    } else {
      harness.idle(true);
      await harness.event("agent_settled");
    }
    await flush();
    assert.equal(hooks("notification").length, 1);
    assert.equal(hooks("stop").length, 1);
    await harness.event("session_shutdown");
  });
}

test("shutdown after an in-flight notification preserves routing and emits one shutdown Stop", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  const stall = stallRun(
    "notification",
    (command) => command.payload?.message === "Task completed",
  );
  await turn(harness);
  await stall.entered;
  const form = question(harness);
  const shutdown = harness.event("session_shutdown");
  stall.release();
  await shutdown;
  assert.equal(hooks("notification").length, 1);
  assert.equal(hooks("stop").length, 1);
  assert.equal(payload("stop").terminationReason, "session_shutdown");
  assert.equal(payload("stop").turn_id, payload("notification").turn_id);
  assert.equal(payload("stop").cmux_notification_routed, true);
  const before = commands.length;
  form.close(undefined);
  await form.result;
  await flush();
  assert.equal(commands.length, before);
});

test("an activation during shutdown drainage cannot clear or stop its replacement session", async () => {
  const harness = setup({ hasUI: true });
  await harness.start();
  const stall = stallFeed();
  const shutdown = harness.event("session_shutdown");
  await stall.entered;
  const activation = harness.start();
  stall.release();
  await Promise.all([shutdown, activation]);
  assert.equal(hooks("stop").length, 0);
  assert.equal(
    commands.filter((entry) => entry.args.includes("resume") && entry.args.includes("clear"))
      .length,
    0,
  );
  const form = question(harness);
  await turn(harness, "replacement answer");
  assert.equal(hooks("stop").length, 0);
  form.close(undefined);
  await form.result;
  await flush();
  assert.equal(payload("stop").last_assistant_message, "replacement answer");
  await harness.event("session_shutdown");
  assert.equal(hooks("stop").length, 1);
});
