/**
 * End-to-end dispatcher tests for index.ts — a fake `pi`/`ctx` harness drives
 * the registered handlers (tool_call, input, commands, lifecycle) against the
 * stock defaults, exercising the wiring the pure-module tests can't reach:
 * prompt flows, session grants, mode switching, protected-path blocks, and
 * "Allow forever" persistence.
 *
 * Hermetic: each setup runs in a fresh temp project root with
 * PI_CODING_AGENT_DIR pointed at a fresh temp agent dir (so no user config is
 * read and "Allow forever" writes land in the sandbox of the test), and the
 * --no-sandbox flag set (so the OS sandbox runtime is never initialized —
 * bash gating then follows the documented degraded path: prompt).
 *
 * The pi SDK is host-bundled (a peerDependency): when it can't be resolved
 * (e.g. a bare no-install checkout), every test here skips — mirroring the
 * WASM-skip pattern in bash-parse.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { overrideBashParserForTesting } from "./bash-parse.ts";

type SetupExtension = (pi: unknown) => Promise<void>;

// Resolve the extension entry once; undefined → SDK unavailable → skip all.
const setupExtension: SetupExtension | undefined = await (async () => {
  try {
    return (await import("./index.ts")).default as unknown as SetupExtension;
  } catch {
    return undefined;
  }
})();
const skip = setupExtension ? false : "pi SDK not installed (run npm install)";

// --- fake pi ----------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

class FakePi {
  flags = new Map<string, unknown>();
  handlers = new Map<string, Handler[]>();
  /** Statusline slot traffic, newest last — see the slot-publishing test. */
  emitted: Array<{ channel: string; data: Record<string, unknown> }> = [];
  events = {
    emit: (channel: string, data: Record<string, unknown>) => {
      this.emitted.push({ channel, data });
    },
    on: (_channel: string, _handler: (data: unknown) => void) => () => {},
  };
  commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
  shortcuts = new Map<string, (ctx: unknown) => Promise<unknown>>();
  tools = new Map<string, { name: string }>();
  activeTools: string[] = [];
  entries: Array<{ customType: string; data: unknown }> = [];

  registerFlag(name: string, def: { default?: unknown }) {
    if (!this.flags.has(name)) this.flags.set(name, def.default);
  }
  getFlag(name: string) {
    return this.flags.get(name);
  }
  registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<unknown> }) {
    this.commands.set(name, def.handler);
  }
  registerShortcut(key: string, def: { handler: (ctx: unknown) => Promise<unknown> }) {
    this.shortcuts.set(key, def.handler);
  }
  registerTool(tool: { name: string }) {
    this.tools.set(tool.name, tool);
  }
  getAllTools() {
    return [...this.tools.values()];
  }
  setActiveTools(names: string[]) {
    this.activeTools = names;
  }
  appendEntry(customType: string, data: unknown) {
    this.entries.push({ customType, data });
  }
  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  /** Deliver an event to the registered handlers, returning the first result. */
  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    for (const h of this.handlers.get(event) ?? []) {
      const r = await h(payload, ctx);
      if (r !== undefined) return r;
    }
    return undefined;
  }
}

// --- fake ctx ----------------------------------------------------------------

interface FakeCtx {
  hasUI: boolean;
  cwd: string;
  prompts: Array<{ title: string; options: string[] }>;
  notices: string[];
  status: string;
  answers: (string | undefined)[];
  selectHooks: Array<() => void>;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, level?: string): void;
    setStatus(key: string, value: string): void;
    theme: { fg(color: string, text: string): string };
  };
  sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
  getSystemPrompt(): string;
  isProjectTrusted?: () => boolean;
}

type FakeCtxOptions = {
  hasUI?: boolean;
  trusted?: boolean;
  entries?: Array<{ type: string; customType?: string; data?: unknown }>;
  activeAgent?: string;
  systemPrompt?: string;
};

function makeCtx(cwd: string, opts: FakeCtxOptions = {}): FakeCtx {
  const ctx: FakeCtx = {
    hasUI: opts.hasUI ?? true,
    cwd,
    prompts: [],
    notices: [],
    status: "",
    answers: [],
    selectHooks: [],
    ui: {
      async select(title, options) {
        ctx.prompts.push({ title, options });
        ctx.selectHooks.shift()?.();
        const answer = ctx.answers.shift();
        assert.ok(answer === undefined || options.includes(answer), `answer ${answer} was not offered by: ${options.join(", ")}`);
        return answer;
      },
      notify(message) {
        ctx.notices.push(message);
      },
      setStatus(_key, value) {
        ctx.status = value;
      },
      theme: { fg: (_color, text) => text },
    },
    sessionManager: { getEntries: () => opts.entries ?? [] },
    getSystemPrompt: () =>
      opts.systemPrompt ??
      (opts.activeAgent ? `<active_agent name="${opts.activeAgent}"/>\n\n# Environment\nWorking directory: ${cwd}` : "ROOT SYSTEM PROMPT"),
    isProjectTrusted: () => opts.trusted === true,
  };
  return ctx;
}

async function useUnsandboxedAskMode(h: Harness): Promise<void> {
  const dir = path.join(h.agentDir, "permission-mode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "permission-mode.json"),
    JSON.stringify({
      defaultMode: "confirm-unsandboxed",
      cycleOrder: ["confirm-unsandboxed"],
      modes: {
        "confirm-unsandboxed": {
          label: "Confirm unsandboxed",
          color: "error",
          sandbox: { enabled: false, writable: true },
          permission: { bash: "ask" },
        },
      },
    }),
  );
  await h.pi.emit("session_start", {}, h.ctx);
  await h.perm("confirm-unsandboxed");
}

async function useUnsandboxedSparseMode(h: Harness): Promise<void> {
  const dir = path.join(h.agentDir, "permission-mode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "permission-mode.json"),
    JSON.stringify({
      defaultMode: "sparse-unsandboxed",
      cycleOrder: ["sparse-unsandboxed"],
      modes: {
        "sparse-unsandboxed": {
          label: "Sparse unsandboxed",
          color: "error",
          sandbox: { enabled: false, writable: true },
          permission: {},
        },
      },
    }),
  );
  await h.pi.emit("session_start", {}, h.ctx);
  await h.perm("sparse-unsandboxed");
}

async function useUnsandboxedAllowMode(h: Harness): Promise<void> {
  const dir = path.join(h.agentDir, "permission-mode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "permission-mode.json"),
    JSON.stringify({
      defaultMode: "allow-unsandboxed",
      cycleOrder: ["allow-unsandboxed"],
      modes: {
        "allow-unsandboxed": {
          label: "Allow unsandboxed",
          color: "error",
          sandbox: { enabled: false, writable: true },
          permission: { bash: "allow", path: "allow", external_directory: "allow" },
        },
      },
    }),
  );
  await h.pi.emit("session_start", {}, h.ctx);
  await h.perm("allow-unsandboxed");
}

// --- harness ------------------------------------------------------------------

interface Harness {
  pi: FakePi;
  ctx: FakeCtx;
  root: string;
  agentDir: string;
  /** Emit a tool_call and return its result ({block,reason} | undefined). */
  call(toolName: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined>;
  /** Run the /perm command (mode switch etc.). */
  perm(args: string): Promise<unknown>;
  cleanup(): void;
}

let callId = 0;

/**
 * Build the extension against a fresh temp project + agent dir, then emit
 * session_start so the config/lifecycle path runs exactly as in production
 * (minus the OS sandbox, which --no-sandbox keeps off).
 */
async function setup(
  opts: {
    hasUI?: boolean;
    trusted?: boolean;
    permFlag?: string;
    /** Simulate a parent-forwarded PI_PERMISSION_MODE. */
    envMode?: string;
    entries?: Array<{ type: string; customType?: string; data?: unknown }>;
    activeAgent?: string;
    systemPrompt?: string;
    /** Build the extension without emitting session_start yet. */
    startSession?: boolean;
  } = {},
): Promise<Harness> {
  const base = mkdtempSync(path.join(tmpdir(), "perm-idx-"));
  const root = path.join(base, "proj");
  const agentDir = path.join(base, "agent");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPermissionMode = process.env.PI_PERMISSION_MODE;
  const prevCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_PERMISSION_MODE;
  if (opts.envMode !== undefined) process.env.PI_PERMISSION_MODE = opts.envMode;

  const pi = new FakePi();
  pi.flags.set("no-sandbox", true);
  if (opts.permFlag !== undefined) pi.flags.set("perm", opts.permFlag);

  process.chdir(root); // index.ts captures root = process.cwd() at setup
  try {
    await setupExtension!(pi);
  } finally {
    process.chdir(prevCwd);
  }

  const ctx = makeCtx(root, opts);
  if (opts.startSession !== false) await pi.emit("session_start", {}, ctx);

  return {
    pi,
    ctx,
    root,
    agentDir,
    call: (toolName, input) =>
      pi.emit("tool_call", { type: "tool_call", toolCallId: `t${++callId}`, toolName, input }, ctx) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
    perm: (args) => pi.commands.get("perm")!(args, ctx),
    cleanup: () => {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevPermissionMode === undefined) delete process.env.PI_PERMISSION_MODE;
      else process.env.PI_PERMISSION_MODE = prevPermissionMode;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// --- tests --------------------------------------------------------------------

test("default mode: reads free, writes prompt, protected paths hard-block", { skip }, async () => {
  const h = await setup();
  try {
    // --no-sandbox: nothing filters, and a sandboxing mode says so.
    assert.match(h.ctx.status, /^Default  Network: open$/);

    // Reads pass silently.
    assert.equal(await h.call("read", { path: "src/app.ts" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);

    // Protected paths block WITHOUT prompting, and before any policy ask.
    const blocked = await h.call("write", { path: ".env" });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /protected/);
    assert.equal(h.ctx.prompts.length, 0);

    // A normal write prompts; Allow once passes, Deny blocks.
    h.ctx.answers.push("Allow this request once", "Deny");
    assert.equal(await h.call("write", { path: "notes.txt" }), undefined);
    const denied = await h.call("write", { path: "notes.txt" });
    assert.equal(denied?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("dispatcher uses Pi's file URL target and preserves ordinary spaces", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Deny");
    const external = await h.call("read", { path: pathToFileURL("/etc/passwd").href });
    assert.equal(external?.block, true);
    assert.match(external?.reason ?? "", /not approved/);
    assert.equal(h.ctx.prompts.length, 1);

    // A trailing ordinary space is meaningful to Pi and must not be trimmed
    // into the protected `.env` target.
    h.ctx.answers.push("Allow this request once");
    assert.equal(await h.call("write", { path: ".env " }), undefined);
    assert.equal(h.ctx.prompts.length, 2);

    const protectedUrl = pathToFileURL(path.join(h.root, ".env")).href;
    const blocked = await h.call("write", { path: protectedUrl });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /protected/);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("dispatcher uses ctx.cwd consistently for boundaries and protected writes", { skip }, async () => {
  const h = await setup();
  try {
    const contextCwd = path.join(h.root, "nested");
    mkdirSync(contextCwd, { recursive: true });
    h.ctx.cwd = contextCwd;
    mkdirSync(path.join(h.agentDir, "permission-mode"), { recursive: true });
    writeFileSync(
      path.join(h.agentDir, "permission-mode", "permission-mode.json"),
      JSON.stringify({ modes: { default: { permission: { external_directory: "deny" } } } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);

    // `..` resolves to the startup root, but it is outside the current tool cwd.
    const outside = await h.call("read", { path: ".." });
    assert.equal(outside?.block, true);
    assert.equal(h.ctx.prompts.length, 0);

    // A link in the current cwd reaches the startup root's protected .git.
    mkdirSync(path.join(h.root, ".git"));
    symlinkSync(path.join(h.root, ".git"), path.join(contextCwd, "git-link"), "dir");
    const protectedWrite = await h.call("write", { path: "git-link/config" });
    assert.equal(protectedWrite?.block, true);
    assert.match(protectedWrite?.reason ?? "", /protected/);
  } finally {
    h.cleanup();
  }
});

test("dispatcher denies Pi NFD read fallback candidates", { skip }, async () => {
  const h = await setup();
  try {
    const requested = path.join(h.root, "café.txt");
    const actual = path.join(h.root, "cafe\u0301.txt");
    writeFileSync(actual, "NFD");
    mkdirSync(path.dirname(path.join(h.agentDir, "permission-mode", "permission-mode.json")), { recursive: true });
    writeFileSync(
      path.join(h.agentDir, "permission-mode", "permission-mode.json"),
      JSON.stringify({ modes: { default: { permission: { read: { [actual]: "deny" } } } } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);

    const blocked = await h.call("read", { path: requested });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /blocked/);
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("dispatcher rewrites file URLs and read fallbacks to the authorized canonical target", { skip }, async () => {
  const h = await setup();
  try {
    const direct = path.join(h.root, "direct.txt");
    writeFileSync(direct, "direct");
    const urlInput = { path: pathToFileURL(direct).href };
    assert.equal(await h.call("read", urlInput), undefined);
    assert.equal(urlInput.path, direct);

    const requested = path.join(h.root, "café.txt");
    const fallback = path.join(h.root, "cafe\u0301.txt");
    writeFileSync(fallback, "fallback");
    const fallbackInput = { path: requested };
    assert.equal(await h.call("read", fallbackInput), undefined);
    assert.equal(fallbackInput.path, fallback);
  } finally {
    h.cleanup();
  }
});

test("dispatcher preserves an existing canonical symlink target selected before approval", { skip }, async () => {
  const h = await setup();
  try {
    const selected = path.join(h.root, "selected.txt");
    const replacement = path.join(h.root, "replacement.txt");
    const alias = path.join(h.root, "alias.txt");
    writeFileSync(selected, "selected");
    writeFileSync(replacement, "replacement");
    symlinkSync(selected, alias);
    h.ctx.selectHooks.push(() => {
      rmSync(alias);
      symlinkSync(replacement, alias);
    });
    h.ctx.answers.push("Remember globally");
    const input = { path: "alias.txt" };
    assert.equal(await h.call("write", input), undefined);
    assert.equal(input.path, selected);
    assert.match(h.ctx.prompts[0]?.title ?? "", /Requested: alias\.txt/);
    const saved = JSON.parse(readFileSync(path.join(h.agentDir, "permission-mode", "permission-mode.json"), "utf-8"));
    assert.deepEqual(saved.modes.default.permissionGrants, [
      { permission: "write", scope: { kind: "exact", value: selected } },
    ]);
  } finally {
    h.cleanup();
  }
});

test("dispatcher keeps the pre-backstop canonical write target when a symlink switches to protected", { skip }, async () => {
  const h = await setup();
  try {
    const selected = path.join(h.root, "selected.txt");
    const protectedFile = path.join(h.root, ".env");
    const alias = path.join(h.root, "alias.txt");
    writeFileSync(selected, "selected");
    writeFileSync(protectedFile, "protected");
    symlinkSync(selected, alias);
    h.ctx.selectHooks.push(() => {
      rmSync(alias);
      symlinkSync(protectedFile, alias);
    });
    h.ctx.answers.push("Allow this request once");
    const input = { path: "alias.txt" };
    assert.equal(await h.call("write", input), undefined);
    assert.equal(input.path, selected, "execution must retain the canonical target checked by the backstop");
  } finally {
    h.cleanup();
  }
});

test("dispatcher blocks write when a missing component becomes a .git symlink during approval", { skip }, async () => {
  const h = await setup();
  try {
    const protectedDir = path.join(h.root, ".git");
    const missingDir = path.join(h.root, "pending-write");
    const frozenTarget = path.join(missingDir, "config");
    mkdirSync(protectedDir);
    h.ctx.selectHooks.push(() => symlinkSync(protectedDir, missingDir, "dir"));
    h.ctx.answers.push("Remember globally");

    const input = { path: "pending-write/config" };
    const blocked = await h.call("write", input);
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /changed after authorization/);
    assert.equal(input.path, "pending-write/config", "a blocked call must not receive an execution path");
    assert.ok(h.ctx.notices.some((notice) => /authorized path changed before execution/.test(notice)));

    const saved = JSON.parse(readFileSync(path.join(h.agentDir, "permission-mode", "permission-mode.json"), "utf-8"));
    assert.deepEqual(saved.modes.default.permissionGrants, [
      { permission: "write", scope: { kind: "exact", value: frozenTarget } },
    ], "the separately persisted approval remains bound to the frozen target, not .git");
  } finally {
    h.cleanup();
  }
});

test("dispatcher blocks edit when a missing component becomes a protected symlink during approval", { skip }, async () => {
  const h = await setup();
  try {
    const protectedDir = path.join(h.root, ".vscode");
    const missingDir = path.join(h.root, "pending-edit");
    mkdirSync(protectedDir);
    h.ctx.selectHooks.push(() => symlinkSync(protectedDir, missingDir, "dir"));
    h.ctx.answers.push("Allow this request once");

    const input = { path: "pending-edit/settings.json" };
    const blocked = await h.call("edit", input);
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /changed after authorization/);
    assert.equal(input.path, "pending-edit/settings.json", "a blocked call must not receive an execution path");
  } finally {
    h.cleanup();
  }
});

test("dispatcher blocks a missing write target that switches outside during approval", { skip }, async () => {
  const h = await setup();
  try {
    const outsideDir = path.join(path.dirname(h.root), "outside");
    const missingDir = path.join(h.root, "pending-outside");
    mkdirSync(outsideDir);
    h.ctx.selectHooks.push(() => symlinkSync(outsideDir, missingDir, "dir"));
    h.ctx.answers.push("Allow this request once");

    const input = { path: "pending-outside/result.txt" };
    const blocked = await h.call("write", input);
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /changed after authorization/);
    assert.equal(input.path, "pending-outside/result.txt", "the outside target must not be accepted for execution");
  } finally {
    h.cleanup();
  }
});

test("dispatcher accepts an unchanged missing write target after approval", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Allow this request once");
    const input = { path: "still-missing/result.txt" };
    assert.equal(await h.call("write", input), undefined);
    assert.equal(input.path, path.join(h.root, "still-missing", "result.txt"));
  } finally {
    h.cleanup();
  }
});

test("dispatcher denies Pi curly-quote read fallback candidates", { skip }, async () => {
  const h = await setup();
  try {
    const requested = "Capture d'ecran.txt";
    const actual = path.join(h.root, "Capture d\u2019ecran.txt");
    writeFileSync(actual, "curly");
    mkdirSync(path.join(h.agentDir, "permission-mode"), { recursive: true });
    writeFileSync(
      path.join(h.agentDir, "permission-mode", "permission-mode.json"),
      JSON.stringify({ modes: { default: { permission: { read: { [actual]: "deny" } } } } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);

    const blocked = await h.call("read", { path: requested });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /blocked/);
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("dispatcher keeps literal $HOME file paths distinct from configured home aliases", { skip }, async () => {
  const h = await setup();
  try {
    mkdirSync(path.join(h.agentDir, "permission-mode"), { recursive: true });
    writeFileSync(
      path.join(h.agentDir, "permission-mode", "permission-mode.json"),
      JSON.stringify({ modes: { default: { permission: { read: { "*": "allow", "$HOME/*": "deny" } } } } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);

    // Pi opens this below the project, not below the user's home directory.
    assert.equal(await h.call("read", { path: "$HOME/literal.txt" }), undefined);
    const homeBlocked = await h.call("read", { path: "~/literal.txt" });
    assert.equal(homeBlocked?.block, true);
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("optional-path file tools deny omitted paths", { skip }, async () => {
  const h = await setup();
  try {
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ modes: { default: { permission: { grep: "deny", find: "deny", ls: "deny" } } } }));
    await h.pi.emit("session_start", {}, h.ctx);

    for (const [toolName, input] of [["grep", { pattern: "x" }], ["find", { pattern: "*" }], ["ls", {}]] as const) {
      const blocked = await h.call(toolName, input);
      assert.equal(blocked?.block, true, `${toolName} without path should be denied`);
      assert.match(blocked?.reason ?? "", /blocked/);
    }
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("optional-path file tools ask on omitted paths", { skip }, async () => {
  const h = await setup();
  try {
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ modes: { default: { permission: { grep: "ask", find: "ask", ls: "ask" } } } }));
    await h.pi.emit("session_start", {}, h.ctx);
    h.ctx.answers.push("Deny", "Deny", "Deny");

    for (const [toolName, input] of [["grep", { pattern: "x" }], ["find", { pattern: "*" }], ["ls", {}]] as const) {
      const blocked = await h.call(toolName, input);
      assert.equal(blocked?.block, true, `${toolName} without path should ask`);
    }
    assert.equal(h.ctx.prompts.length, 3);
  } finally {
    h.cleanup();
  }
});

test("outside file access offers project and global persistence in trusted projects", { skip }, async () => {
  const h = await setup({ trusted: true });
  try {
    const target = "../shared/input.txt";
    h.ctx.answers.push("Remember for this project");
    assert.equal(await h.call("read", { path: target }), undefined);
    assert.deepEqual(h.ctx.prompts[0].options, [
      "Allow this request once",
      "Allow scope for session",
      "Edit scope…",
      "Remember for this project",
      "Remember globally",
      "Deny",
    ]);

    const saved = JSON.parse(readFileSync(path.join(h.root, ".pi", "permission-mode.json"), "utf-8"));
    assert.deepEqual(saved.modes.default.permissionGrants, [
      { permission: "external_directory", scope: { kind: "exact", value: path.resolve(h.root, target) } },
    ]);
    assert.equal(await h.call("read", { path: target }), undefined);
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("outside file session grant suppresses repeat prompts", { skip }, async () => {
  const h = await setup();
  try {
    const target = "../shared/input.txt";
    h.ctx.answers.push("Allow scope for session");
    assert.equal(await h.call("read", { path: target }), undefined);
    assert.equal(h.ctx.prompts.length, 1);

    assert.equal(await h.call("read", { path: target }), undefined);
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("outside file persistence is operation-specific and survives config reload", { skip }, async () => {
  const h = await setup();
  try {
    const target = "../shared/output.txt";
    h.ctx.answers.push("Allow this request once", "Remember globally");
    assert.equal(await h.call("write", { path: target }), undefined);
    assert.deepEqual(h.ctx.prompts[0].options, [
      "Allow this request once",
      "Allow scope for session",
      "Edit scope…",
      "Remember globally",
      "Deny",
    ]);

    const saved = JSON.parse(readFileSync(path.join(h.agentDir, "permission-mode", "permission-mode.json"), "utf-8"));
    assert.deepEqual(saved.modes.default.permissionGrants, [
      { permission: "write", scope: { kind: "exact", value: path.resolve(h.root, target) } },
    ]);
    h.ctx.answers.push("Allow this request once");
    assert.equal(await h.call("write", { path: target }), undefined);
    assert.equal(h.ctx.prompts.length, 3);
    h.ctx.answers.push("Allow this request once");
    assert.equal((await h.call("read", { path: target }))?.block, undefined);
    assert.equal(h.ctx.prompts.length, 4);
  } finally {
    h.cleanup();
  }
});

test("outside file scope edits are recursive, operation-specific, and repeatable", { skip }, async () => {
  const h = await setup();
  try {
    const target = "../shared/input.txt";
    h.ctx.answers.push("Edit scope…", "Directory tree: ../shared/*", "Allow scope for session");
    assert.equal(await h.call("read", { path: target }), undefined);
    assert.equal(h.ctx.prompts.length, 3);
    assert.match(h.ctx.prompts[0].title, /Allow external directory/);
    assert.match(h.ctx.prompts[1].title, /Choose access scope/);

    assert.equal(await h.call("read", { path: "../shared/deep/child.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 3);
    // The typed read scope must not authorize a write to the same tree.
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("write", { path: "../shared/deep/child.txt" }))?.block, true);
    assert.equal(h.ctx.prompts.length, 4);
  } finally {
    h.cleanup();
  }
});

test("remembered outside scopes cannot override an explicit deny", { skip }, async () => {
  const h = await setup();
  try {
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        modes: {
          default: {
            permission: { external_directory: { "*": "deny" } },
            permissionGrants: [{ permission: "external_directory", scope: { kind: "glob", value: "/tmp/*" } }],
          },
        },
      }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    const blocked = await h.call("read", { path: "/tmp/deep/file.txt" });
    assert.equal(blocked?.block, true);
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("project restrictions hide global outside persistence", { skip }, async () => {
  const h = await setup({ trusted: true });
  try {
    const file = path.join(h.root, ".pi", "permission-mode.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ modes: { default: { permission: { external_directory: { "*": "ask" } } } } }));
    await h.pi.emit("session_start", {}, h.ctx);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("read", { path: "../shared/input.txt" }))?.block, true);
    assert.deepEqual(h.ctx.prompts[0].options, [
      "Allow this request once",
      "Allow scope for session",
      "Edit scope…",
      "Remember for this project",
      "Deny",
    ]);
  } finally {
    h.cleanup();
  }
});

test("read fallback project policy checks every authorized identity before using or offering global grants", { skip }, async () => {
  const h = await setup({ trusted: true });
  try {
    const requestedDisplay = "café.txt";
    const selectedDisplay = "cafe\u0301.txt";
    const selectedCanonical = path.join(h.root, selectedDisplay);
    writeFileSync(selectedCanonical, "fallback");

    const globalFile = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    mkdirSync(path.dirname(globalFile), { recursive: true });
    writeFileSync(globalFile, JSON.stringify({
      modes: {
        default: {
          permissionGrants: [{ permission: "read", scope: { kind: "exact", value: selectedCanonical } }],
        },
      },
    }));
    const projectFile = path.join(h.root, ".pi", "permission-mode.json");
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({
      modes: { default: { permission: { read: { [selectedDisplay]: "ask" } } } },
    }));
    await h.pi.emit("session_start", {}, h.ctx);

    h.ctx.answers.push("Deny");
    assert.equal((await h.call("read", { path: requestedDisplay }))?.block, true);
    assert.equal(h.ctx.prompts.length, 1, "the global grant must not suppress the project ask");
    assert.ok(!h.ctx.prompts[0]!.options.includes("Remember globally"));
    assert.ok(h.ctx.prompts[0]!.options.includes("Remember for this project"));
  } finally {
    h.cleanup();
  }
});

test("mixed project requirements keep global eligibility per permission", { skip }, async () => {
  const pathRestricted = await setup({ trusted: true });
  try {
    const projectFile = path.join(pathRestricted.root, ".pi", "permission-mode.json");
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({ modes: { default: { permission: { path: "ask" } } } }));
    await pathRestricted.pi.emit("session_start", {}, pathRestricted.ctx);
    pathRestricted.ctx.answers.push("Allow this request once", "Deny");
    assert.equal((await pathRestricted.call("write", { path: "src/mixed.ts" }))?.block, true);
    assert.ok(!pathRestricted.ctx.prompts[0]!.options.includes("Remember globally"));
    assert.ok(pathRestricted.ctx.prompts[1]!.options.includes("Remember globally"));
  } finally {
    pathRestricted.cleanup();
  }

  const writeRestricted = await setup({ trusted: true });
  try {
    const globalFile = path.join(writeRestricted.agentDir, "permission-mode", "permission-mode.json");
    mkdirSync(path.dirname(globalFile), { recursive: true });
    writeFileSync(globalFile, JSON.stringify({ modes: { default: { permission: { path: "ask" } } } }));
    const projectFile = path.join(writeRestricted.root, ".pi", "permission-mode.json");
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({ modes: { default: { permission: { write: "ask" } } } }));
    await writeRestricted.pi.emit("session_start", {}, writeRestricted.ctx);
    writeRestricted.ctx.answers.push("Allow this request once", "Deny");
    assert.equal((await writeRestricted.call("write", { path: "src/mixed.ts" }))?.block, true);
    assert.ok(writeRestricted.ctx.prompts[0]!.options.includes("Remember globally"));
    assert.ok(!writeRestricted.ctx.prompts[1]!.options.includes("Remember globally"));
  } finally {
    writeRestricted.cleanup();
  }
});

test("a project ask on one permission does not suppress another permission's global grant", { skip }, async () => {
  const h = await setup({ trusted: true });
  try {
    const target = path.join(h.root, "src", "granted.ts");
    const globalFile = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    mkdirSync(path.dirname(globalFile), { recursive: true });
    writeFileSync(globalFile, JSON.stringify({
      modes: { default: { permissionGrants: [{ permission: "write", scope: { kind: "exact", value: target } }] } },
    }));
    const projectFile = path.join(h.root, ".pi", "permission-mode.json");
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({ modes: { default: { permission: { path: "ask" } } } }));
    await h.pi.emit("session_start", {}, h.ctx);
    h.ctx.answers.push("Allow this request once");
    assert.equal(await h.call("write", { path: "src/granted.ts" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    assert.match(h.ctx.prompts[0]?.title ?? "", /Allow path/);
  } finally {
    h.cleanup();
  }
});

test("session start is silent; only a switch the user made announces the mode", { skip }, async () => {
  const h = await setup();
  try {
    // Silent at startup, including the re-pick a resumed session does.
    assert.deepEqual(h.ctx.notices, []);
    await h.pi.emit("session_start", {}, h.ctx);
    assert.deepEqual(h.ctx.notices, []);

    await h.perm("build");
    assert.equal(process.env.PI_PERMISSION_MODE, "build");
    assert.deepEqual(h.ctx.notices, ["Permission mode: Build"]);
  } finally {
    h.cleanup();
  }
});

test("fresh root reload keeps its startup environment snapshot", { skip }, async () => {
  const first = await setup();
  try {
    assert.equal(process.env.PI_PERMISSION_MODE, "default");
    assert.deepEqual(first.pi.entries, []);

    const fresh = await setup({ envMode: "default" });
    try {
      assert.equal(fresh.ctx.getSystemPrompt(), "ROOT SYSTEM PROMPT");
      process.env.PI_PERMISSION_MODE = "yolo";
      await fresh.pi.emit("session_tree", {}, fresh.ctx);
      assert.equal(process.env.PI_PERMISSION_MODE, "default");
      const before = (await fresh.pi.emit("before_agent_start", { systemPrompt: "BASE" }, fresh.ctx)) as { systemPrompt: string };
      assert.match(fresh.ctx.status, /^Default /);
      assert.match(before.systemPrompt, /Sandbox & permissions \(Default\)/);

      fresh.ctx.answers.push("Deny");
      assert.equal((await fresh.call("web_search", { query: "root" }))?.block, true);
      assert.match(fresh.ctx.status, /^Default /);
    } finally {
      fresh.cleanup();
    }
  } finally {
    first.cleanup();
  }
});

test("incidental active-agent prose does not enable environment following", { skip }, async () => {
  const h = await setup({
    envMode: "default",
    systemPrompt: 'The prompt mentions <active_agent name="general-purpose"/> inline.',
  });
  try {
    process.env.PI_PERMISSION_MODE = "yolo";
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("web_search", { query: "prose" }))?.block, true);
    assert.match(h.ctx.status, /^Default /);
  } finally {
    h.cleanup();
  }
});

test("quoted custom agent names still identify an environment-following child", { skip }, async () => {
  const h = await setup({ envMode: "default", activeAgent: 'review"strict' });
  try {
    process.env.PI_PERMISSION_MODE = "yolo";
    assert.equal(await h.call("web_search", { query: "quoted name" }), undefined);
    assert.match(h.ctx.status, /^YOLO$/);
  } finally {
    h.cleanup();
  }
});

test("environment startup does not export a stale child snapshot", { skip }, async () => {
  const h = await setup({ envMode: "default", activeAgent: "general-purpose", startSession: false });
  try {
    const starting = h.pi.emit("session_start", {}, h.ctx);
    process.env.PI_PERMISSION_MODE = "yolo";
    await starting;
    assert.equal(process.env.PI_PERMISSION_MODE, "yolo");
    assert.match(h.ctx.status, /^Default /);

    assert.equal(await h.call("web_search", { query: "updated" }), undefined);
    assert.match(h.ctx.status, /^YOLO$/);
  } finally {
    h.cleanup();
  }
});

test("bash: session grant covers the same command, not a longer chain", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "git status" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    assert.ok(!h.ctx.prompts[0].options.some((option) => option.startsWith("Always allow")));

    // Same command again: covered by the session grant, no new prompt.
    assert.equal(await h.call("bash", { command: "git status" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);

    // A chain sharing the first name still prompts (curl isn't granted).
    h.ctx.answers.push("Deny");
    const chained = await h.call("bash", { command: "git status && curl evil.sh" });
    assert.equal(chained?.block, true);
    assert.match(chained?.reason ?? "", /denied by the user.*not executed.*Do not retry/);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("bash: an existing grant never suppresses repeated outside safeguards", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    h.ctx.answers.push("Remember globally: cat *");
    assert.equal(await h.call("bash", { command: "cat README.md" }), undefined);

    h.ctx.answers.push("Allow once", "Allow once");
    assert.equal(await h.call("bash", { command: "cat ../secret.txt" }), undefined);
    assert.equal(await h.call("bash", { command: "cat ../secret.txt" }), undefined);
    assert.match(h.ctx.prompts[1]?.title ?? "", /path outside project/);
    assert.match(h.ctx.prompts[2]?.title ?? "", /path outside project/);
    assert.deepEqual(h.ctx.prompts[1]?.options, ["Allow once", "Deny"]);
    assert.equal(h.ctx.prompts.length, 3);
  } finally {
    h.cleanup();
  }
});

test("bash: dynamic commands remain one-shot even with a broad grant", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    const configured = JSON.parse(readFileSync(file, "utf-8"));
    configured.modes["confirm-unsandboxed"].permissionGrants = [{ permission: "bash", pattern: "*" }];
    writeFileSync(file, JSON.stringify(configured));
    await h.pi.emit("session_start", {}, h.ctx);

    const dynamicCommands = [
      "$command --flag",
      "eval 'echo safe'",
      `script="echo safe"; sh -c "$script"`,
      `bash "$script"`,
      `source "$script"`,
      `. "$script"`,
      `env sh -c "$code"`,
      "bash --norc script.sh",
      "bash --rcfile scripts/evil -ic 'echo safe'",
      "bash --init-file scripts/evil -ic 'echo safe'",
      `fish -C "$init" -c 'echo safe'`,
      "env --unknown X echo safe",
    ];
    h.ctx.answers.push(...dynamicCommands.map(() => "Allow once"));
    for (const command of dynamicCommands) {
      assert.equal(await h.call("bash", { command }), undefined);
      const prompt = h.ctx.prompts.at(-1)!;
      assert.match(prompt.title, /dynamically interpreted command/);
      assert.deepEqual(prompt.options, ["Allow once", "Deny"]);
    }

    const before = h.ctx.prompts.length;
    for (const command of [
      "sh -c 'echo safe'",
      "bash -lc 'echo safe'",
      "env sh -c 'echo safe'",
      "fish -C 'echo init' -c 'echo safe'",
    ]) {
      assert.equal(await h.call("bash", { command }), undefined);
    }
    assert.equal(h.ctx.prompts.length, before, "recursively understood literal scripts are covered by the grant");
  } finally {
    h.cleanup();
  }
});

test("bash: command-prefix assignments always require an ungrantable one-shot safeguard", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    const configured = JSON.parse(readFileSync(file, "utf-8"));
    configured.modes["confirm-unsandboxed"].permissionGrants = [{ permission: "bash", pattern: "*" }];
    writeFileSync(file, JSON.stringify(configured));
    await h.pi.emit("session_start", {}, h.ctx);

    const commands = [
      "PATH=./evil:$PATH git status",
      "BASH_ENV=./evil bash -c ':'",
      "ENV=./evil sh -c ':'",
      "VALUE=$dynamic git status",
      "ONLY=literal",
      "PATH=./evil env sh -c 'echo safe'",
      "DEST=../secret.txt git status",
    ];
    h.ctx.answers.push(...commands.map(() => "Allow once"));
    for (const command of commands) {
      assert.equal(await h.call("bash", { command }), undefined);
      const prompt = h.ctx.prompts.at(-1)!;
      assert.deepEqual(prompt.options, ["Allow once", "Deny"], command);
      assert.match(prompt.title, /dynamically interpreted command|path outside project/, command);
      assert.match(prompt.title, new RegExp(command.split(" ")[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), command);
    }
    assert.equal(h.ctx.prompts.length, commands.length, "existing grants cannot suppress assignment safeguards");
  } finally {
    h.cleanup();
  }
});

test("bash: assignment values and effective nested commands cannot bypass denies", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      defaultMode: "guarded",
      cycleOrder: ["guarded"],
      modes: {
        guarded: {
          label: "Guarded",
          color: "error",
          sandbox: { enabled: false, writable: true },
          permission: {
            bash: { "*": "allow", "git status": "deny", "sudo*": "deny" },
            path: { "*": "allow", "../secret*": "deny", "/etc/*": "deny" },
          },
        },
      },
    }));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.perm("guarded");

    for (const command of [
      "PATH=./evil git status",
      "PATH=./evil env sh -c 'sudo id'",
      "DEST=../secret.txt printf safe",
      "DEST=/etc/passwd printf safe",
    ]) {
      const blocked = await h.call("bash", { command });
      assert.equal(blocked?.block, true, command);
      assert.match(blocked?.reason ?? "", /blocked/, command);
    }
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("bash: command-prefix assignments block headless allow mode but YOLO bypasses safeguards", { skip }, async () => {
  const headless = await setup({ hasUI: false });
  try {
    await useUnsandboxedAllowMode(headless);
    for (const command of ["PATH=./evil:$PATH git status", "BASH_ENV=./evil bash -c ':'", "ONLY=literal"]) {
      assert.equal((await headless.call("bash", { command }))?.block, true, command);
    }
  } finally {
    headless.cleanup();
  }

  const yolo = await setup();
  try {
    await yolo.perm("yolo");
    for (const command of ["PATH=./evil:$PATH git status", "BASH_ENV=./evil bash -c ':'", "ONLY=literal"]) {
      assert.equal(await yolo.call("bash", { command }), undefined, command);
    }
    assert.equal(yolo.ctx.prompts.length, 0);
  } finally {
    yolo.cleanup();
  }
});

test("bash: wrapped and initialization commands cannot bypass denies", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      modes: {
        default: {
          permission: {
            bash: {
              "*": "allow",
              "sudo*": "deny",
              "rm*": "deny",
              "bash --rcfile scripts/evil*": "deny",
              "bash --init-file scripts/evil*": "deny",
            },
            path: { "*": "allow", "secret.txt": "deny" },
          },
        },
      },
    }));
    await h.pi.emit("session_start", {}, h.ctx);

    for (const command of [
      "env -u X bash -c 'sudo id'",
      "env --unset X sudo id",
      "stdbuf -o L sudo id",
      "timeout 5s sudo id",
      "xargs -I {} sudo id",
      "fish -C 'sudo id' -c 'echo safe'",
      "fish --init-command 'sudo id' -c 'echo safe'",
      "fish -C'rm *' -c 'echo safe'",
      "fish --init-command='rm *' -c 'echo safe'",
      "fish --init-command-exit='rm *' -c 'echo safe'",
      "fish --command='rm *'",
      "bash --rcfile scripts/evil -ic 'echo safe'",
      "bash --init-file scripts/evil -ic 'echo safe'",
      "env -u X bash -c 'cat secret.txt'",
    ]) {
      const blocked = await h.call("bash", { command });
      assert.equal(blocked?.block, true, command);
      assert.match(blocked?.reason ?? "", /blocked/);
    }
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("bash: wrapped privilege escalation remains a one-shot safeguard", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    const configured = JSON.parse(readFileSync(file, "utf-8"));
    configured.modes["confirm-unsandboxed"].permissionGrants = [{ permission: "bash", pattern: "*" }];
    writeFileSync(file, JSON.stringify(configured));
    await h.pi.emit("session_start", {}, h.ctx);

    const commands = [
      "env -u X bash -c 'sudo id'",
      "stdbuf -o L sudo id",
      "timeout 5s sudo id",
      "xargs -I {} sudo id",
      "fish -C 'sudo id' -c 'echo safe'",
    ];
    h.ctx.answers.push(...commands.map(() => "Allow once"));
    for (const command of commands) {
      assert.equal(await h.call("bash", { command }), undefined);
      const prompt = h.ctx.prompts.at(-1)!;
      assert.match(prompt.title, /privilege escalation/);
      assert.deepEqual(prompt.options, ["Allow once", "Deny"]);
    }
  } finally {
    h.cleanup();
  }
});

test("bash: parser ambiguity and deep wrappers safeguard unsandboxed allow policy", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAllowMode(h);
    const deepPrivilege = `${Array.from({ length: 12 }, () => "env").join(" ")} sudo id`;
    let depthExhausted = "echo safe";
    for (let depth = 0; depth < 5; depth++) {
      depthExhausted = `bash -c '${depthExhausted.replaceAll("'", "'\\''")}'`;
    }
    h.ctx.answers.push("Allow once", "Allow once", "Allow once");

    assert.equal(await h.call("bash", { command: "env -S 'sudo id'" }), undefined);
    assert.match(h.ctx.prompts[0]?.title ?? "", /dynamically interpreted command/);
    assert.deepEqual(h.ctx.prompts[0]?.options, ["Allow once", "Deny"]);

    assert.equal(await h.call("bash", { command: deepPrivilege }), undefined);
    assert.match(h.ctx.prompts[1]?.title ?? "", /privilege escalation/);
    assert.deepEqual(h.ctx.prompts[1]?.options, ["Allow once", "Deny"]);

    assert.equal(await h.call("bash", { command: depthExhausted }), undefined);
    assert.match(h.ctx.prompts[2]?.title ?? "", /script could not be fully parsed/);
    assert.deepEqual(h.ctx.prompts[2]?.options, ["Allow once", "Deny"]);
  } finally {
    h.cleanup();
  }
});

test("bash: parser safeguards block unsandboxed allow policy without UI", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    await useUnsandboxedAllowMode(h);
    const deepPrivilege = `${Array.from({ length: 12 }, () => "env").join(" ")} sudo id`;
    let depthExhausted = "echo safe";
    for (let depth = 0; depth < 5; depth++) {
      depthExhausted = `bash -c '${depthExhausted.replaceAll("'", "'\\''")}'`;
    }
    for (const command of ["env -S 'sudo id'", deepPrivilege, depthExhausted]) {
      const blocked = await h.call("bash", { command });
      assert.equal(blocked?.block, true, command);
      assert.match(blocked?.reason ?? "", /requires approval|privilege escalation/, command);
    }
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("bash: dynamic commands fail closed without UI", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    for (const command of ["$command --flag", `bash "$script"`, `env sh -c "$code"`]) {
      const blocked = await h.call("bash", { command });
      assert.equal(blocked?.block, true, command);
    }
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("bash: flattened global choices persist both narrow patterns", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    h.ctx.answers.push("Remember globally: git fetch *", "Allow once");
    assert.equal(await h.call("bash", { command: "git fetch origin" }), undefined);
    assert.deepEqual(h.ctx.prompts[0].options, [
      "Allow once",
      "Allow for session",
      "Remember globally: git fetch *",
      "Remember globally: git *",
      "Deny",
    ]);
    const saved = JSON.parse(readFileSync(path.join(h.agentDir, "permission-mode", "permission-mode.json"), "utf-8"));
    assert.deepEqual(saved.modes["confirm-unsandboxed"].permissionGrants, [
      { permission: "bash", pattern: "git fetch" },
      { permission: "bash", pattern: "git fetch *" },
    ]);
    assert.equal(await h.call("bash", { command: "git fetch-pack origin" }), undefined);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("bash: dismissing the flattened prompt denies", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    h.ctx.answers.push(undefined);
    const result = await h.call("bash", { command: "git fetch origin" });
    assert.equal(result?.block, true);
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("bash: multi-command persistence displays one flattened global scope", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    h.ctx.answers.push("Remember globally: git *", "Remember globally: npm *");
    assert.equal(await h.call("bash", { command: "git status && npm test" }), undefined);
    assert.deepEqual(h.ctx.prompts[0].options, [
      "Allow once",
      "Allow for session",
      "Remember globally: git status *",
      "Remember globally: git *",
      "Deny",
    ]);
    assert.deepEqual(h.ctx.prompts[1].options, [
      "Allow once",
      "Allow for session",
      "Remember globally: npm test *",
      "Remember globally: npm *",
      "Deny",
    ]);

    const saved = JSON.parse(readFileSync(path.join(h.agentDir, "permission-mode", "permission-mode.json"), "utf-8"));
    assert.deepEqual(saved.modes["confirm-unsandboxed"].permissionGrants, [
      { permission: "bash", pattern: "git" },
      { permission: "bash", pattern: "git *" },
      { permission: "bash", pattern: "npm" },
      { permission: "bash", pattern: "npm *" },
    ]);
  } finally {
    h.cleanup();
  }
});

test("bash: flattened project/global choices persist a project subcommand scope", { skip }, async () => {
  const h = await setup({ trusted: true });
  try {
    await useUnsandboxedAskMode(h);
    h.ctx.answers.push("Remember for this project: git fetch *");
    assert.equal(await h.call("bash", { command: "git fetch origin" }), undefined);
    assert.deepEqual(h.ctx.prompts[0].options, [
      "Allow once",
      "Allow for session",
      "Remember for this project: git fetch *",
      "Remember globally: git fetch *",
      "Remember for this project: git *",
      "Remember globally: git *",
      "Deny",
    ]);
    const file = path.join(h.root, ".pi", "permission-mode.json");
    const saved = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(saved.modes["confirm-unsandboxed"].permissionGrants, [
      { permission: "bash", pattern: "git fetch" },
      { permission: "bash", pattern: "git fetch *" },
    ]);

    assert.equal(await h.call("bash", { command: "git fetch upstream" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);

    h.ctx.answers.push("Deny");
    const sibling = await h.call("bash", { command: "git push origin main" });
    assert.equal(sibling?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("bash: a trusted project ask offers only project persistence", { skip }, async () => {
  const h = await setup({ trusted: true });
  try {
    await useUnsandboxedAskMode(h);
    const file = path.join(h.root, ".pi", "permission-mode.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ modes: { "confirm-unsandboxed": { permission: { bash: { "git *": "ask" } } } } }));
    await h.pi.emit("session_start", {}, h.ctx);

    h.ctx.answers.push("Remember for this project: git fetch *");
    assert.equal(await h.call("bash", { command: "git fetch origin" }), undefined);
    assert.deepEqual(h.ctx.prompts[0].options, [
      "Allow once",
      "Allow for session",
      "Remember for this project: git fetch *",
      "Remember for this project: git *",
      "Deny",
    ]);
  } finally {
    h.cleanup();
  }
});

test("/perm allow parses only leading flags and rejects untrusted project persistence", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("allow -p bash deploy -p --dry-run");
    assert.match(h.ctx.notices.at(-1) ?? "", /trusted project/);
    await h.perm("allow -g bash deploy -p --dry-run");
    const saved = JSON.parse(readFileSync(path.join(h.agentDir, "permission-mode", "permission-mode.json"), "utf-8"));
    assert.equal(saved.modes.default.permission.bash["deploy -p --dry-run"], "allow");
  } finally {
    h.cleanup();
  }
});

test("/perm init -p scaffolds the project schema and project grants notify once", { skip }, async () => {
  const h = await setup({ trusted: true });
  try {
    await h.perm("init -p");
    const file = path.join(h.root, ".pi", "permission-mode.json");
    const scaffold = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(scaffold.$schema, "https://raw.githubusercontent.com/strayge/pi-extensions/main/extensions/pi-permission-modes/schemas/permission-mode.schema.json");
    assert.deepEqual(scaffold.modes, {});

    writeFileSync(file, JSON.stringify({ modes: { default: { permission: { bash: { "git *": "allow" }, tool: "allow" } } } }));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("session_start", {}, h.ctx);
    assert.equal(h.ctx.notices.filter((notice) => /honoring 2 project grants/.test(notice)).length, 1);
  } finally {
    h.cleanup();
  }
});

test("project grants notice is hidden in active agent children", { skip }, async () => {
  const h = await setup({ trusted: true, activeAgent: "Agent" });
  try {
    const file = path.join(h.root, ".pi", "permission-mode.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ modes: { default: { permission: { bash: { "git *": "allow" } } } } }));

    await h.pi.emit("session_start", {}, h.ctx);

    assert.equal(h.ctx.notices.some((notice) => /honoring .* project grants/.test(notice)), false);
  } finally {
    h.cleanup();
  }
});

test("bash: sandbox safeguard is separate from per-command policy asks", { skip }, async () => {
  const h = await setup();
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({ modes: { default: { permission: { bash: { "*": "ask", "echo *": "allow" } } } } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);

    h.ctx.answers.push("Allow once", "Allow once", "Allow once");
    assert.equal(await h.call("bash", { command: "ls -la && echo okay && git status" }), undefined);
    assert.match(h.ctx.prompts[0]?.title ?? "", /sandbox unavailable/);
    assert.deepEqual(h.ctx.prompts[0]?.options, ["Allow once", "Deny"]);
    assert.match(h.ctx.prompts[1]?.title ?? "", /Commands to allow: ls -la/);
    assert.match(h.ctx.prompts[2]?.title ?? "", /Commands to allow: git status/);
  } finally {
    h.cleanup();
  }
});

test("bash: parsed commands are granted independently", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    h.ctx.answers.push("Allow for session", "Allow for session");
    assert.equal(await h.call("bash", { command: 'ls -la && echo "---" && ls src' }), undefined);
    assert.equal(h.ctx.prompts.length, 2);
    assert.match(h.ctx.prompts[0]?.title ?? "", /Commands to allow: ls -la/);
    assert.match(h.ctx.prompts[1]?.title ?? "", /Commands to allow: echo ---/);

    // The option-only ls grant is the documented broad ls/ls-* pair, so it
    // also covers the later ls entry in the same request.
    assert.equal(await h.call("bash", { command: 'ls -la && echo "---" && ls src' }), undefined);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("plan mode: Markdown-only writes, plan prompt injected, show_plan stays visible", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("plan");
    assert.match(h.ctx.status, /^Plan Mode /);

    // Markdown in-project: silent allow. Code: deny with the friendly reason.
    assert.equal(await h.call("write", { path: "docs/plans/2026-07-11_x.md" }), undefined);
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true);
    assert.match(denied?.reason ?? "", /Markdown/);
    assert.equal(h.ctx.prompts.length, 0);

    // The @plan sentinel resolves into the injected system prompt, and the
    // sandbox-awareness section rides along above it (degraded variant here,
    // since the harness runs --no-sandbox).
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /^BASE\n\n/);
    assert.match(res.systemPrompt, /Sandbox & permissions \(Plan Mode\)/);
    assert.match(res.systemPrompt, /Plan Mode is active/);
    assert.ok(res.systemPrompt.indexOf("Sandbox & permissions") < res.systemPrompt.indexOf("Plan Mode is active"));

    // Tool visibility ran and show_plan is present.
    assert.ok(h.pi.activeTools.includes("show_plan"));
  } finally {
    h.cleanup();
  }
});

test("yolo: never prompts, never blocks, protected paths bypassed", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("yolo");
    assert.match(h.ctx.status, /^YOLO$/);
    assert.equal(await h.call("bash", { command: "sudo rm -rf /" }), undefined);
    assert.equal(await h.call("bash", { command: "printf one\nprintf two" }), undefined);
    assert.equal(await h.call("bash", { command: "env -S 'sudo id'" }), undefined);
    assert.equal(
      await h.call("bash", { command: "fish -i -c 'for f in *.ts; echo $f; end'" }),
      undefined,
      "an incomplete parse must not override YOLO's explicit allow policy",
    );
    assert.equal(
      await h.call("bash", { command: `${Array.from({ length: 12 }, () => "env").join(" ")} sudo id` }),
      undefined,
    );
    assert.equal(await h.call("edit", { path: ".env" }), undefined);
    assert.equal(await h.call("write", { path: ".git/config" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);
    // Unsandboxed mode: no sandbox-awareness injection either.
    assert.equal(await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx), undefined);
  } finally {
    h.cleanup();
  }
});

test("web_search: ask in Default, session-wide grant", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Deny", "Allow for session");
    const denied = await h.call("web_search", { query: "anything" });
    assert.equal(denied?.block, true);
    assert.equal(await h.call("web_search", { query: "again" }), undefined);
    // Grant is surface-wide: a different query passes without a new prompt.
    assert.equal(await h.call("web_search", { query: "third" }), undefined);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("environment-following child reconciles Default, YOLO, and Default at policy boundaries", { skip }, async () => {
  const h = await setup({ envMode: "default", activeAgent: "general-purpose" });
  try {
    assert.match(h.ctx.status, /^Default /);
    h.ctx.answers.push("Deny", "Deny");
    assert.equal((await h.call("bash", { command: "printf initial" }))?.block, true);
    assert.equal((await h.call("web_search", { query: "initial" }))?.block, true);
    assert.equal(h.ctx.prompts.length, 2);

    process.env.PI_PERMISSION_MODE = "yolo";
    assert.equal(await h.call("bash", { command: "printf yolo" }), undefined);
    assert.equal(await h.call("web_search", { query: "yolo" }), undefined);
    assert.match(h.ctx.status, /^YOLO$/);
    assert.deepEqual(h.pi.entries, []);
    assert.deepEqual(h.ctx.notices, []);

    process.env.PI_PERMISSION_MODE = "not-a-mode";
    assert.equal(await h.call("web_search", { query: "invalid" }), undefined);
    assert.match(h.ctx.status, /^YOLO$/);
    assert.equal(h.ctx.prompts.length, 2);

    process.env.PI_PERMISSION_MODE = "default";
    const before = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(h.ctx.status, /^Default /);
    assert.match(before.systemPrompt, /Sandbox & permissions \(Default\)/);
    assert.equal(h.pi.entries.length, 0);
    assert.deepEqual(h.ctx.notices, []);

    h.ctx.answers.push("Deny", "Deny");
    assert.equal((await h.call("bash", { command: "printf default" }))?.block, true);
    assert.equal((await h.call("web_search", { query: "default" }))?.block, true);
    assert.equal(h.ctx.prompts.length, 4);
  } finally {
    h.cleanup();
  }
});

test("environment reconciliation also runs at the skill input boundary", { skip }, async () => {
  const h = await setup({ envMode: "default", activeAgent: "general-purpose" });
  try {
    process.env.PI_PERMISSION_MODE = "yolo";
    assert.equal(await h.pi.emit("input", { text: "/skill:deep-research" }, h.ctx), undefined);
    assert.equal(h.ctx.prompts.length, 0);

    process.env.PI_PERMISSION_MODE = "default";
    h.ctx.answers.push("Deny");
    assert.deepEqual(await h.pi.emit("input", { text: "/skill:deep-research" }, h.ctx), { action: "handled" });
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("flag and persisted startup modes remain authoritative over later environment changes", { skip }, async () => {
  const flagged = await setup({ permFlag: "default", envMode: "yolo", entries: [{ type: "custom", customType: "perm-mode", data: { mode: "build" } }] });
  try {
    assert.match(flagged.ctx.status, /^Default /);
    assert.equal(process.env.PI_PERMISSION_MODE, "default");
    process.env.PI_PERMISSION_MODE = "yolo";
    const before = (await flagged.pi.emit("before_agent_start", { systemPrompt: "BASE" }, flagged.ctx)) as { systemPrompt: string };
    assert.match(flagged.ctx.status, /^Default /);
    assert.match(before.systemPrompt, /Sandbox & permissions \(Default\)/);
    flagged.ctx.answers.push("Deny");
    assert.equal((await flagged.call("web_search", { query: "flag" }))?.block, true);
  } finally {
    flagged.cleanup();
  }

  const resumed = await setup({ envMode: "yolo", entries: [{ type: "custom", customType: "perm-mode", data: { mode: "default" } }] });
  try {
    assert.match(resumed.ctx.status, /^Default /);
    assert.equal(process.env.PI_PERMISSION_MODE, "default");
    process.env.PI_PERMISSION_MODE = "yolo";
    const before = (await resumed.pi.emit("before_agent_start", { systemPrompt: "BASE" }, resumed.ctx)) as { systemPrompt: string };
    assert.match(resumed.ctx.status, /^Default /);
    assert.match(before.systemPrompt, /Sandbox & permissions \(Default\)/);
    resumed.ctx.answers.push("Deny");
    assert.equal((await resumed.call("web_search", { query: "persisted" }))?.block, true);
  } finally {
    resumed.cleanup();
  }
});

test("headless fallback promotes to an explicit environment mode and enables its prompt", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    assert.match(h.ctx.status, /^Plan Mode /);
    const fallback = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.doesNotMatch(fallback.systemPrompt, /Plan Mode is active/);

    process.env.PI_PERMISSION_MODE = "plan";
    const promoted = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(h.ctx.status, /^Plan Mode /);
    assert.match(promoted.systemPrompt, /Plan Mode is active/);
    assert.deepEqual(h.pi.entries, []);
  } finally {
    h.cleanup();
  }
});

test("custom tools: first-use prompt in Default (with Allow forever), silent in Build", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("my_mcp_tool", { arg: 1 }), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    // First-use prompts offer the persistent fourth option.
    assert.ok(h.ctx.prompts[0].options.includes("Allow forever"));
    assert.equal(await h.call("my_mcp_tool", { arg: 2 }), undefined); // granted for session
    assert.equal(h.ctx.prompts.length, 1);

    await h.perm("build");
    assert.equal(await h.call("other_tool", {}), undefined); // Build trusts tools
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("custom tool denials explain whether an Agent launch occurred", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Deny", "Deny");
    const agent = await h.call("Agent", {});
    assert.deepEqual(agent, {
      block: true,
      reason: "Agent launch denied by the user; no subagent was started.",
    });
    const other = await h.call("stranger_tool", {});
    assert.deepEqual(other, {
      block: true,
      reason: 'Tool "stranger_tool" denied by the user; it was not executed.',
    });
  } finally {
    h.cleanup();
  }
});

test("'Allow forever' persists the rule to the global config and stops prompting", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Allow forever");
    assert.equal(await h.call("my_mcp_tool", {}), undefined);
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    assert.ok(existsSync(file), "rule persisted to the temp agent dir");
    const saved = JSON.parse(readFileSync(file, "utf-8")) as {
      modes: { default: { permission: { tool: Record<string, string> } } };
    };
    assert.equal(saved.modes.default.permission.tool.my_mcp_tool, "allow");
    assert.equal(saved.modes.default.permission.tool["*"], "ask"); // others keep prompting

    // The hot-reloaded config allows it now — and other tools still prompt.
    assert.equal(await h.call("my_mcp_tool", {}), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    h.ctx.answers.push("Deny");
    const other = await h.call("stranger_tool", {});
    assert.equal(other?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("skills: /skill:<name> is gated via the input event", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Deny", "Allow once");
    const denied = await h.pi.emit("input", { text: "/skill:deep-research" }, h.ctx);
    assert.deepEqual(denied, { action: "handled" }); // blocked → swallowed
    const allowed = await h.pi.emit("input", { text: "/skill:deep-research" }, h.ctx);
    assert.equal(allowed, undefined); // allowed → continues to expansion
    // Non-skill input is ignored.
    assert.equal(await h.pi.emit("input", { text: "hello" }, h.ctx), undefined);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("no UI: asks deny instead of hanging", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    const bash = await h.call("bash", { command: "ls" });
    assert.equal(bash?.block, true);
    const write = await h.call("write", { path: "x.txt" });
    assert.equal(write?.block, true);
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("headless fallback: restrictive policy WITHOUT the plan prompt, not exported to children", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    // The safety fallback is the read-only sandboxed mode (Plan) …
    assert.match(h.ctx.status, /^Plan Mode /);
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true); // … and its policy fully applies
    // … but the planning system prompt is NOT injected into the headless
    // worker — only the FACTUAL sandbox-awareness section is (boundary
    // knowledge helps; a planning prompt would misdirect).
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Sandbox & permissions/);
    assert.doesNotMatch(res.systemPrompt, /Plan Mode is active/);
    // The implicit fallback is not forwarded as if it were an explicit choice:
    // a grandchild derives its own fallback (and skips the prompt too).
    assert.equal(process.env.PI_PERMISSION_MODE, undefined);
  } finally {
    h.cleanup();
  }
});

test("headless child with an explicitly forwarded mode keeps its system prompt", { skip }, async () => {
  const h = await setup({ hasUI: false, envMode: "plan", activeAgent: "general-purpose" });
  try {
    assert.match(h.ctx.status, /^Plan Mode /);
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Plan Mode is active/); // explicit → injected
    assert.equal(process.env.PI_PERMISSION_MODE, "plan"); // and re-exported onward
  } finally {
    h.cleanup();
  }
});

test("statusline: mode and network publish as separate slots", { skip }, async () => {
  const h = await setup();
  const latest = (id: string) => h.pi.emitted.filter((e) => e.data.id === id).at(-1);
  try {
    assert.equal(latest("perm")?.channel, "statusline:publish");
    assert.equal(latest("perm")?.data.text, "Default");
    assert.ok(latest("perm")?.data.defaultPlacement, "asks for a placement, not the catch-all");
    assert.equal(latest("perm")?.data.color, "muted");

    // --no-sandbox: nothing filters, so the network slot is published too.
    assert.equal(latest("perm-network")?.channel, "statusline:publish");
    assert.equal(latest("perm-network")?.data.text, "Network: open");

    // YOLO reports no network state, so its slot is cleared rather than left
    // showing the previous mode's value.
    await h.perm("yolo");
    assert.equal(latest("perm")?.data.text, "YOLO");
    assert.equal(latest("perm-network")?.channel, "statusline:clear");
  } finally {
    h.cleanup();
  }
});

test("startup: --perm flag wins; a persisted session entry restores the mode", { skip }, async () => {
  const flagged = await setup({ permFlag: "yolo" });
  try {
    assert.match(flagged.ctx.status, /^YOLO$/);
  } finally {
    flagged.cleanup();
  }

  const resumed = await setup({ entries: [{ type: "custom", customType: "perm-mode", data: { mode: "build" } }] });
  try {
    assert.match(resumed.ctx.status, /^Build /);
  } finally {
    resumed.cleanup();
  }
});

test("shift+tab cycles modes and persists the choice as a session entry", { skip }, async () => {
  const h = await setup();
  try {
    await h.pi.shortcuts.get("shift+tab")!(h.ctx);
    assert.match(h.ctx.status, /^Plan Mode /); // default → plan (cycleOrder)
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-mode", data: { mode: "plan" } });
    await h.pi.shortcuts.get("shift+tab")!(h.ctx);
    assert.match(h.ctx.status, /^Build /);
  } finally {
    h.cleanup();
  }
});

test("/perm init scaffolds the global config once", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("init");
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    assert.ok(existsSync(file));
    // The scaffold is the stock defaults, ready to edit.
    const cfg = JSON.parse(readFileSync(file, "utf-8")) as { modes: Record<string, unknown> };
    assert.deepEqual(Object.keys(cfg.modes), ["default", "plan", "build", "yolo"]);
    // Second init refuses to overwrite.
    await h.perm("init");
    assert.match(h.ctx.notices.at(-1) ?? "", /already exists/);
  } finally {
    h.cleanup();
  }
});

test("project config tightens a mode through the dispatcher", { skip }, async () => {
  const h = await setup();
  try {
    const piDir = path.join(h.root, ".pi");
    mkdirSync(piDir, { recursive: true });
    const project = { modes: { build: { permission: { write: "deny" } } } };
    writeFileSync(path.join(piDir, "permission-mode.json"), JSON.stringify(project));
    await h.pi.emit("session_start", {}, h.ctx); // reload with the project overlay

    await h.perm("build");
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true); // build allows writes, but the overlay denies
    assert.equal(await h.call("read", { path: "src/app.ts" }), undefined); // reads untouched
  } finally {
    h.cleanup();
  }
});

test("project config cannot disable sandboxing or suppress Default bash prompts", { skip }, async () => {
  const h = await setup();
  try {
    const piDir = path.join(h.root, ".pi");
    mkdirSync(piDir, { recursive: true });
    const project = { modes: { default: { sandbox: { enabled: false } } } };
    writeFileSync(path.join(piDir, "permission-mode.json"), JSON.stringify(project));
    await h.pi.emit("session_start", {}, h.ctx);

    assert.match(h.ctx.notices.join("\n"), /cannot change sandbox\.enabled/);
    h.ctx.answers.push("Deny");
    const denied = await h.call("bash", { command: "touch owned" });
    assert.equal(denied?.block, true);
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("custom unsandboxed mode still honors bash ask", { skip }, async () => {
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);

    h.ctx.answers.push("Deny");
    const denied = await h.call("bash", { command: "touch owned" });
    assert.equal(denied?.block, true);
    assert.match(h.ctx.prompts[0]?.title ?? "", /will run unsandboxed/);
  } finally {
    h.cleanup();
  }
});

test("sparse unsandboxed parser fallback asks with UI", { skip }, async () => {
  const restoreParser = overrideBashParserForTesting(undefined);
  const h = await setup();
  try {
    await useUnsandboxedSparseMode(h);
    h.ctx.answers.push("Allow once", "Allow once");
    assert.equal(await h.call("bash", { command: "printf safe" }), undefined);
    assert.deepEqual(h.ctx.prompts[0]?.options, ["Allow once", "Deny"]);
    assert.match(h.ctx.prompts[0]?.title ?? "", /parser unavailable/);
    assert.deepEqual(h.ctx.prompts[1]?.options, ["Allow once", "Deny"]);
  } finally {
    h.cleanup();
    restoreParser();
  }
});

test("parser fallback approval cannot suppress a later parsed Bash ask", { skip }, async () => {
  const restoreFallback = overrideBashParserForTesting(undefined);
  const h = await setup();
  try {
    await useUnsandboxedAskMode(h);
    h.ctx.answers.push("Allow once", "Allow once");
    assert.equal(await h.call("bash", { command: "printf safe" }), undefined);
    assert.deepEqual(h.ctx.prompts[0]?.options, ["Allow once", "Deny"]);
    assert.deepEqual(h.ctx.prompts[1]?.options, ["Allow once", "Deny"]);

    const restoreParsed = overrideBashParserForTesting({
      parse: () => ({ commands: [{ name: "printf", args: ["safe"], isNested: false }], hasError: false }),
    });
    try {
      h.ctx.answers.push("Deny");
      const blocked = await h.call("bash", { command: "printf safe" });
      assert.equal(blocked?.block, true);
      assert.ok(h.ctx.prompts[2]?.options.includes("Allow for session"));
    } finally {
      restoreParsed();
    }
  } finally {
    h.cleanup();
    restoreFallback();
  }
});

test("sparse unsandboxed parser fallback fails closed without UI", { skip }, async () => {
  const restoreParser = overrideBashParserForTesting(undefined);
  const h = await setup({ hasUI: false });
  try {
    await useUnsandboxedSparseMode(h);
    const blocked = await h.call("bash", { command: "printf safe" });
    assert.equal(blocked?.block, true);
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
    restoreParser();
  }
});

test("network: /net allow + status, request tool degrades gracefully, alt+n informs", { skip }, async () => {
  const h = await setup();
  try {
    // Degraded (--no-sandbox): nothing filters — the tool says so instead of prompting.
    const tool = h.pi.tools.get("request_network_access") as unknown as {
      execute: (id: string, p: unknown, s?: unknown, u?: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const res = await tool.execute("t-net", { domains: ["api.example.com"], reason: "testing" }, undefined, undefined, h.ctx);
    assert.match(res.content[0].text, /not filtered/);
    assert.equal(h.ctx.prompts.length, 0);

    // /net allow normalizes and records session grants; /net status reports them.
    await h.pi.commands.get("net")!("allow api.example.com https://svc.io/health", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /allowed for this session: api\.example\.com, svc\.io/);
    await h.pi.commands.get("net")!("", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /Session grants: api\.example\.com, svc\.io/);

    // Overly-broad patterns are rejected outright.
    await h.pi.commands.get("net")!("allow *", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /usage: \/net allow/);

    // alt+n with nothing enforcing explains itself instead of silently toggling.
    await h.pi.shortcuts.get("alt+n")!(h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /not filtered in this mode\/state/);

    // /net reset clears the grants.
    await h.pi.commands.get("net")!("reset", h.ctx);
    await h.pi.commands.get("net")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /Session grants: \(none\)/);
  } finally {
    h.cleanup();
  }
});

test("injectSandboxInfo:false opts a mode out of the awareness injection", { skip }, async () => {
  const h = await setup();
  try {
    // Default (sandboxed, no systemPrompt) injects the awareness section …
    const before = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(before.systemPrompt, /Sandbox & permissions \(Default\)/);

    // … until the global config opts it out; then nothing is injected at all.
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({ modes: { default: { injectSandboxInfo: false } } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    assert.equal(await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx), undefined);
  } finally {
    h.cleanup();
  }
});
