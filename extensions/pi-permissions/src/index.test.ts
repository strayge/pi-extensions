import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEventBus, SessionManager, type BashOperations, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config-load.ts";
import permissionExtension from "./index.ts";
import { bindPath } from "./paths.ts";
import { STATE_FILE } from "./permission-state.ts";

type Hook = (event: never, context: ExtensionContext) => unknown;
function fixture() {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-reset-"))).canonical;
  const project = path.join(dir, "project"); const agentDir = path.join(dir, "agent"); const other = path.join(dir, "other");
  for (const folder of [project, agentDir, other, path.join(project, ".pi"), path.join(other, ".pi"), path.join(agentDir, "permissions")]) mkdirSync(folder, { mode: 0o700 });
  const oldHome = process.env.HOME; const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = dir; process.env.PI_CODING_AGENT_DIR = agentDir;
  const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  const global = path.join(agentDir, "permissions", "config.json");
  mkdirSync(path.join(project, ".pi", "permissions"));
  const projectFile = path.join(project, ".pi", "permissions", "config.json");
  const state = path.join(agentDir, "permissions", STATE_FILE);
  writeFileSync(global, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(projectFile, '{"version":3,"defaultMode":"yolo"}', { mode: 0o600 });
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const hooks = new Map<string, Hook[]>(); const notifications: string[] = [];
  const manager = SessionManager.inMemory(project); let confirm = true;
  const ctx = { ...({ cwd: project, hasUI: true, sessionManager: manager, ui: {
    confirm: async () => confirm, select: async () => undefined, input: async () => undefined,
    notify: (message: string) => notifications.push(message), setStatus: () => {}, theme: { fg: (_color: string, value: string) => value },
  } } as unknown as ExtensionCommandContext), tools: [], executeTool: async () => { throw new Error("Nested tools are not part of this fixture"); } };
  const pi = {
    events: createEventBus(), registerFlag: () => {}, registerShortcut: () => {},
    registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool), getFlag: () => undefined,
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
    on: (name: string, hook: Hook) => hooks.set(name, [...(hooks.get(name) ?? []), hook]),
  } as unknown as ExtensionAPI;
  permissionExtension(pi);
  const emit = async (name: string, event: object) => {
    const results = []; for (const hook of hooks.get(name) ?? []) results.push(await hook(event as never, ctx)); return results;
  };
  return {
    dir, project, other, agentDir, global, projectFile, state, ctx, manager, notifications, tools,
    execute: (name: string, input: Record<string, unknown>, signal?: AbortSignal) => tools.get(name)!.execute("probe", input, signal, undefined, ctx),
    userBash: () => emit("user_bash", { type: "user_bash", command: "printf ok", excludeFromContext: false }),
    governed: () => {
      let present = false;
      pi.events.emit("permission:present:v2", { parentSessionId: manager.getSessionId(), respond: () => { present = true; } });
      return present;
    },
    start: (reason = "start") => emit("session_start", { type: "session_start", reason }),
    reloadExtension: async () => {
      await emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
      hooks.clear(); commands.clear(); permissionExtension(pi);
      return emit("session_start", { type: "session_start", reason: "reload" });
    },
    blocked: async () => (await emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "probe", input: { path: "file" } })).some((r) => (r as { block?: boolean } | undefined)?.block),
    perm: (args: string) => commands.get("perm")!.handler(args, ctx),
    reset: () => commands.get("perm")!.handler("reset", ctx),
    confirm: (value: boolean) => { confirm = value; },
    awareness: async () => JSON.stringify(await emit("before_agent_start", { type: "before_agent_start" })),
    close: async () => {
      await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("macOS startup and state restoration share dependency inspection while reload discovers changes", { skip: process.platform !== "darwin" }, async (t) => {
  const f = fixture(); const spawn = childProcess.spawnSync;
  try {
    const first = path.join(f.dir, "first.dylib"); const second = path.join(f.dir, "second.dylib");
    for (const file of [first, second]) writeFileSync(file, "fixture");
    let dependency = first; let inspections = 0;
    const node = bindPath(process.execPath).canonical;
    t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawn>) => {
      if (args[0] !== "/usr/bin/otool") return spawn(...args);
      inspections++;
      const [flag, file] = args[1] as string[];
      const stdout = flag === "-l" ? "" : `${file}:\n${file === node ? `\t${dependency} (compatibility version 1.0.0, current version 1.0.0)\n` : ""}`;
      return { pid: 0, output: [], stdout, stderr: "", status: 0, signal: null };
    });
    syncBuiltinESMExports();
    const config = JSON.parse(readFileSync(f.global, "utf8"));
    for (const name of ["project", "subproject"]) config.modes[name].filesystem.resourceReads = ["pi"];
    writeFileSync(f.global, JSON.stringify(config));
    await f.start();
    assert.equal(f.governed(), true);
    assert.equal(inspections, 4);
    assert.ok((await f.awareness()).includes(first));
    f.ctx.ui.select = async () => "Remember for this project";
    await f.perm(`grant read ${f.other}`);
    await f.start("switch");
    assert.equal(f.governed(), true);
    assert.equal(inspections, 8);
    assert.match(await f.awareness(), /other \(tree, project, id /);
    dependency = second;
    await f.reloadExtension();
    assert.equal(f.governed(), true);
    assert.equal(inspections, 12);
    const awareness = await f.awareness();
    assert.ok(awareness.includes(second)); assert.ok(!awareness.includes(first));
    assert.match(awareness, /other \(tree, project, id /);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test("unrelated transcript entries carry no authority and unsupported configuration falls back to unrestricted tools", async () => {
  const f = fixture();
  try {
    f.manager.appendCustomEntry("unrelated-mode", { mode: "yolo" });
    f.manager.appendCustomEntry("unrelated-policy", { acknowledged: true });
    await f.start();
    assert.equal(await f.blocked(), false);
    assert.match(await f.awareness(), /Filesystem profile: project/);
    writeFileSync(f.global, '{"version":0}');
    await f.start("reload");
    assert.equal(await f.blocked(), false);
    assert.match(await f.awareness(), /Filesystem access is unrestricted and subprocess networking is open/);
    assert.equal(f.governed(), false);
    assert.match(f.notifications.join("\n"), /Unsupported permission configuration version/);
    await f.reset(); await f.start("reload");
    assert.equal(await f.blocked(), false);
    assert.match(await f.awareness(), /Filesystem profile: project/);
  } finally { await f.close(); }
});

test("perm grant detects files without granting their directory and retains ordinary directory grants", async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, ".gitconfig");
    writeFileSync(file, "GLOBAL-CONFIG");
    await f.start();
    let prompts = 0;
    f.ctx.ui.select = async (title, options) => {
      prompts++;
      assert.ok(title.startsWith("File access · Read-only\n\n"));
      assert.deepEqual(options, ["Allow for this session", "Remember for this project", "Save globally", "Deny and block for this session", "Deny"]);
      return "Remember for this project";
    };
    await f.perm("grant read ~/.gitconfig");
    assert.match(JSON.stringify(await f.execute("read", { path: file })), /GLOBAL-CONFIG/);
    assert.match(await f.awareness(), /\.gitconfig \(file, project, id /);
    assert.equal(prompts, 1);
    f.ctx.ui.select = async () => undefined;
    await assert.rejects(f.execute("write", { path: file, content: "denied" }), /denied/i);
    await assert.rejects(f.execute("read", { path: path.join(f.dir, "other-file") }), /denied/i);
    await f.reloadExtension();
    assert.match(JSON.stringify(await f.execute("read", { path: file })), /GLOBAL-CONFIG/);
    f.ctx.ui.select = async (title, options) => {
      assert.ok(title.startsWith("Directory access · Read-only\n\n"));
      assert.ok(options.includes("Edit directory scope"));
      return "Allow for this session";
    };
    await f.perm(`grant read ${f.other}`);
    assert.match(await f.awareness(), /other \(tree, session, id /);
    await assert.rejects(f.perm("grant read"), /Usage:/);
  } finally { await f.close(); }
});

test("global command routes distinguish declaration revocation from ordinary clear and reject unknown arguments", async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, "notes"); writeFileSync(file, "NOTE");
    await f.start(); f.ctx.ui.select = async () => "Save globally";
    await f.perm(`grant read ${file}`);
    assert.match(JSON.stringify(await f.execute("read", { path: file })), /NOTE/);
    await f.perm("inspect");
    const awareness = await f.awareness();
    const id = awareness.match(/global:[a-f0-9-]+/)![0];
    assert.equal(JSON.parse(readFileSync(f.global, "utf8")).pathRules.length, 1);
    f.ctx.ui.select = async () => "Allow for this session";
    await f.perm(`grant read ${f.other}`);
    await assert.rejects(f.perm("clear typo"), /Usage/);
    await assert.rejects(f.perm("clear global typo"), /Usage/);
    await assert.rejects(f.perm("revoke unknown"), /Unknown or stale/);
    await f.perm("clear");
    assert.equal(JSON.parse(readFileSync(f.global, "utf8")).pathRules.length, 1);
    await f.perm(`revoke ${id}`);
    assert.equal(JSON.parse(readFileSync(f.global, "utf8")).pathRules.length, 0);
    await assert.rejects(f.perm(`revoke ${id}`), /stale or unavailable/);
    f.ctx.ui.select = async () => "Save globally";
    await f.perm(`grant read ${file}`);
    await f.perm("clear global");
    assert.equal(JSON.parse(readFileSync(f.global, "utf8")).pathRules.length, 0);
  } finally { await f.close(); }
});

test("parallel filesystem and network requests keep each global confirmation with its approval", async () => {
  const f = fixture();
  try {
    const second = path.join(f.dir, "second"); mkdirSync(second);
    const config = JSON.parse(readFileSync(f.global, "utf8"));
    config.network = { default: "restricted", allowedDomains: [], deniedDomains: [] };
    writeFileSync(f.global, JSON.stringify(config));
    await f.start();
    let active = false;
    const dialogs: string[] = [];
    const respond = async <T>(label: string, answer: T): Promise<T> => {
      assert.equal(active, false, "a permission dialog must not replace another active dialog");
      active = true;
      dialogs.push(label);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return answer;
      } finally { active = false; }
    };
    f.ctx.ui.select = (title) => title.startsWith("Network access:")
      ? respond("network", "Allow for this session")
      : respond(title.includes(f.other) ? "first" : "second", "Save globally");
    f.ctx.ui.confirm = (_title, message) => respond(message.includes(f.other) ? "confirm first" : "confirm second", true);
    const results = await Promise.allSettled([
      f.execute("request_directory_access", { directory: f.other, access: "read", reason: "First directory" }),
      f.execute("request_directory_access", { directory: second, access: "read", reason: "Second directory" }),
      f.execute("request_network_access", { domains: ["queued.example.test"], reason: "Network request" }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    assert.deepEqual(dialogs, ["first", "confirm first", "second", "confirm second", "network"]);
    assert.deepEqual(JSON.parse(readFileSync(f.global, "utf8")).pathRules, [
      { path: f.other, scope: "tree", read: "allow" },
      { path: second, scope: "tree", read: "allow" },
    ]);
    assert.match(await f.awareness(), /queued\.example\.test/);
  } finally { await f.close(); }
});

test("cancelled network tools skip queued dialogs and cannot publish late active answers", async () => {
  for (const queued of [true, false]) {
    const f = fixture();
    try {
      const config = JSON.parse(readFileSync(f.global, "utf8"));
      config.network = { default: "restricted", allowedDomains: [], deniedDomains: [] };
      writeFileSync(f.global, JSON.stringify(config));
      await f.start();
      const dialogs: string[] = [];
      let answer!: (value: string) => void;
      let displayedSignal: AbortSignal | undefined;
      f.ctx.ui.select = (title, _items, options) => {
        dialogs.push(title.startsWith("Network access:") ? "network" : "filesystem");
        displayedSignal = options?.signal;
        return new Promise((resolve) => { answer = resolve; });
      };
      const first = queued ? f.execute("request_directory_access", { directory: f.other, access: "read", reason: "Active dialog" }) : undefined;
      const controller = new AbortController();
      const rejected = assert.rejects(f.execute("request_network_access", {
        domains: ["cancelled.example.test"], reason: "Cancelled tool",
      }, controller.signal), /abort/i);
      controller.abort();
      assert.equal(displayedSignal?.aborted, !queued);
      if (queued) {
        await rejected;
        assert.deepEqual(dialogs, ["filesystem"]);
        answer("Allow for this session");
        await first;
      } else {
        answer("Allow for this session");
        await rejected;
      }
      assert.doesNotMatch(await f.awareness(), /cancelled\.example\.test/);
      f.ctx.ui.select = async () => "Allow for this session";
      await f.execute("request_network_access", { domains: ["next.example.test"], reason: "Next tool" });
      assert.match(await f.awareness(), /next\.example\.test/);
    } finally { await f.close(); }
  }
});

test("fresh and retained global callbacks inherit filesystem origin while manual policy edits opt out", async () => {
  const f = fixture();
  const marker = Symbol.for("pi-extensions:input-dialog");
  try {
    const file = path.join(f.dir, "notes"); writeFileSync(file, "NOTE");
    await f.start();
    f.ctx.ui.select = async () => "Remember for this project";
    await f.perm(`grant read ${f.project}`);
    let manual = true;
    let selections = 0; let confirmations = 0;
    f.ctx.ui.select = async (_title, _items, options) => {
      selections++;
      assert.equal(Reflect.get(options!, marker), manual ? false : undefined);
      assert.ok(options?.signal);
      return "Save globally";
    };
    f.ctx.ui.confirm = async (_title, _message, options) => {
      confirmations++;
      assert.equal(Reflect.get(options!, marker), manual ? false : undefined);
      assert.equal(Reflect.get({ ...options }, marker), manual ? false : undefined);
      return true;
    };
    for (const retained of [false, true]) {
      if (retained) await f.reloadExtension();
      manual = true;
      await f.perm(`grant read ${file}`);
      const id = (await f.awareness()).match(/global:[a-f0-9-]+/)![0];
      await f.perm(`revoke ${id}`);
      manual = false;
      await f.execute("request_directory_access", { directory: f.other, access: "read", reason: "Agent directory", agentWait: false });
      manual = true;
      await f.perm("clear global");
      assert.deepEqual(JSON.parse(readFileSync(f.global, "utf8")).pathRules, []);
      for (const saved of [f.global, f.state]) assert.doesNotMatch(readFileSync(saved, "utf8"), /agentWait|input-dialog/);
    }
    assert.equal(selections, 4); assert.equal(confirmations, 8);
    for (const tool of f.tools.values()) assert.doesNotMatch(JSON.stringify(tool.parameters), /agentWait|input-dialog/);
  } finally { await f.close(); }
});

test("user shells opt out discovered filesystem accesses and working-directory approval without changing agent defaults", async () => {
  const f = fixture(); const marker = Symbol.for("pi-extensions:input-dialog");
  try {
    const file = path.join(f.other, "notes"); writeFileSync(file, "NOTE");
    await f.start();
    const origins: unknown[] = [];
    f.ctx.ui.select = async (_title, _items, options) => { origins.push(Reflect.get(options!, marker)); return undefined; };
    const [{ operations }] = await f.userBash() as { operations: BashOperations }[];
    await assert.rejects(operations.exec(`cat ${JSON.stringify(file)}`, f.project, { onData: () => {} }), /denied/);
    await assert.rejects(operations.exec("printf ok", f.other, { onData: () => {} }), /denied/);
    await assert.rejects(f.execute("bash", { command: `cat ${JSON.stringify(file)}`, agentWait: false }), /denied/);
    await assert.rejects(f.execute("request_path_exception", { path: file, access: "read", reason: "Agent file", agentWait: false }), /denied/);
    assert.deepEqual(origins, [false, false, undefined, undefined]);
    assert.equal(existsSync(f.state), false, "denied requests must not persist authority or UI metadata");
  } finally { await f.close(); }
});

test("both shell initialization orders keep shared-runtime network waits tracked with distinct-host prompts and same-host dedup", async (t) => {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const marker = Symbol.for("pi-extensions:input-dialog");
  for (const manualFirst of [true, false]) {
    const f = fixture();
    let ask: Parameters<typeof SandboxManager.initialize>[1];
    let host = "first.example.test";
    let initializations = 0;
    try {
      const config = JSON.parse(readFileSync(f.global, "utf8"));
      config.network = { default: "restricted", allowedDomains: [], deniedDomains: [] };
      writeFileSync(f.global, JSON.stringify(config));
      t.mock.method(SandboxManager, "reset", async () => {});
      t.mock.method(SandboxManager, "initialize", async (_config: Parameters<typeof SandboxManager.initialize>[0], callback: typeof ask) => {
        initializations++;
        ask = callback;
      });
      t.mock.method(SandboxManager, "wrapWithSandbox", async () => {
        assert.ok(ask);
        assert.deepEqual(await Promise.all([ask({ host, port: 443 }), ask({ host: host.toUpperCase(), port: 80 })]), [true, true]);
        return "printf ok";
      });
      t.mock.method(SandboxManager, "cleanupAfterCommand", () => {});
      t.mock.method(SandboxManager, "annotateStderrWithSandboxFailures", () => "");
      await f.start();
      const prompts: string[] = [];
      f.ctx.ui.select = async (title, _items, options) => {
        prompts.push(title);
        assert.ok(title.startsWith("Network access:"));
        assert.ok(options?.signal);
        assert.equal(Reflect.get(options!, marker), undefined);
        return "Allow for this session";
      };
      const [{ operations }] = await f.userBash() as { operations: BashOperations }[];
      const shell = async (manual: boolean) => {
        if (manual) assert.equal((await operations.exec("printf manual", f.project, { onData: () => {}, timeout: 5 })).exitCode, 0);
        else assert.match(JSON.stringify(await f.execute("bash", { command: "printf agent", timeout: 5 })), /ok/);
      };
      await shell(manualFirst);
      host = "second.example.test";
      await shell(!manualFirst);
      assert.equal(initializations, 1, "same-family shell origins must not reset the captured network callback");
      assert.deepEqual(prompts, ["Network access: first.example.test:443", "Network access: second.example.test:443"]);
    } finally { await f.close(); t.mock.restoreAll(); }
  }
});

test("session block commands, clear-global separation, reload and close lifecycle", async () => {
  const f = fixture();
  try {
    const file = path.join(f.project, "notes"); writeFileSync(file, "NOTE");
    await f.start(); f.ctx.ui.select = async () => "Allow for this session";
    await f.perm(`grant read ${f.other}`);
    f.ctx.ui.select = async () => "Deny and block for this session";
    await assert.rejects(f.perm(`grant read ${file}`), /blocked/);
    const id = (await f.awareness()).match(/block:[a-f0-9-]+/)![0];
    await assert.rejects(f.execute("read", { path: file }), /access denied/);
    await f.perm("clear global");
    assert.match(await f.awareness(), new RegExp(id));
    assert.match(await f.awareness(), /other \(tree, session, id /);
    await f.reloadExtension();
    assert.match(await f.awareness(), new RegExp(id));
    await assert.rejects(f.execute("read", { path: file }), /access denied/);
    await f.perm(`revoke ${id}`);
    await assert.rejects(f.perm(`revoke ${id}`), /Unknown or stale/);
    assert.match(JSON.stringify(await f.execute("read", { path: file })), /NOTE/);
    await assert.rejects(f.perm(`grant write ${file}`), /blocked/);
    await f.perm("clear");
    assert.match(await f.awareness(), /Session blocks:\\nnone/);
    assert.doesNotMatch(await f.awareness(), /other \(tree, session, id /);
    await assert.rejects(f.perm(`grant read ${file}`), /blocked/);
    await f.start("switch");
    assert.match(await f.awareness(), /Session blocks:\\nnone/);
    assert.match(JSON.stringify(await f.execute("read", { path: file })), /NOTE/);
  } finally { await f.close(); }
});

test("failed startup freezes reset and reload to the original project even across extension reload", async () => {
  for (const malformed of ['{"modes":{"invalid":{}}}', '{"version":4,"unexpected":true}']) {
    const f = fixture();
    try {
      writeFileSync(f.global, malformed);
      await f.start(); assert.equal(await f.blocked(), false);
      mkdirSync(path.join(f.other, ".pi", "permissions"));
      const otherPolicy = path.join(f.other, ".pi", "permissions", "config.json");
      writeFileSync(otherPolicy, "untouched"); f.ctx.cwd = f.other;
      await f.reloadExtension(); assert.equal(await f.blocked(), false);
      await f.reset(); await f.reloadExtension();
      assert.equal(readFileSync(otherPolicy, "utf8"), "untouched");
      assert.equal(readFileSync(f.projectFile, "utf8"), '{"version":3,"defaultMode":"yolo"}');
      assert.ok(!readdirSync(path.dirname(f.projectFile)).some((name) => name.includes("backup")));
      const backup = readdirSync(path.dirname(f.global)).find((name) => name.startsWith("config.json.backup-"));
      assert.equal(readFileSync(path.join(path.dirname(f.global), backup!), "utf8"), malformed);
      assert.equal(await f.blocked(), false);
      assert.match(await f.awareness(), new RegExp(f.project));
    } finally { await f.close(); }
  }
});

test("failed initialization delegates filesystem tools and shell networking to Pi without restrictions", async () => {
  const f = fixture();
  const server = createServer((_request, response) => response.end("network-open"));
  try {
    const validPolicy = readFileSync(f.global, "utf8");
    writeFileSync(f.global, '{"version":0}');
    await f.start();
    assert.equal(await f.blocked(), false);
    assert.deepEqual(await f.userBash(), [undefined]);
    assert.match(f.notifications.join("\n"), /Filesystem and network restrictions are disabled/);
    const file = path.join(f.other, "outside.txt");
    await f.execute("write", { path: file, content: "before" });
    await f.execute("edit", { path: file, edits: [{ oldText: "before", newText: "after" }] });
    assert.equal(readFileSync(file, "utf8"), "after");
    assert.match(JSON.stringify(await f.execute("read", { path: file })), /after/);
    assert.match(JSON.stringify(await f.execute("ls", { path: f.other })), /outside.txt/);
    assert.match(JSON.stringify(await f.execute("find", { path: f.other, pattern: "*.txt" })), /outside.txt/);
    assert.match(JSON.stringify(await f.execute("grep", { path: file, pattern: "after" })), /after/);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const script = `console.log(await (await fetch('http://127.0.0.1:${address.port}')).text())`;
    const result = await f.execute("bash", { command: `${JSON.stringify(process.execPath)} --input-type=module -e ${JSON.stringify(script)}` });
    assert.match(JSON.stringify(result), /network-open/);
    writeFileSync(f.global, validPolicy);
    await f.reloadExtension();
    assert.equal(f.governed(), true);
    await assert.rejects(f.execute("read", { path: file }), /approval|denied/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test("replacing a saved resource directory enables fallback and a restored boundary recovers on reload", async () => {
  const f = fixture();
  try {
    const config = JSON.parse(readFileSync(f.global, "utf8"));
    config.modes.project.filesystem.readOnly = [f.other];
    writeFileSync(f.global, JSON.stringify(config));
    await f.start();
    assert.equal(f.governed(), true);
    const old = `${f.other}-old`;
    renameSync(f.other, old); mkdirSync(f.other);
    await f.reloadExtension();
    assert.match(f.notifications.join("\n"), /Filesystem identity changed or is unavailable/);
    assert.equal(await f.blocked(), false);
    assert.equal(f.governed(), false);
    const outside = path.join(f.other, "fallback.txt");
    await f.execute("write", { path: outside, content: "unrestricted" });
    assert.equal(readFileSync(outside, "utf8"), "unrestricted");
    rmSync(f.other, { recursive: true }); renameSync(old, f.other);
    await f.reloadExtension();
    assert.equal(f.governed(), true);
    await assert.rejects(f.execute("write", { path: path.join(f.other, "denied.txt"), content: "denied" }), /approval|denied/i);
  } finally { await f.close(); }
});

test("unrelated agent directories are untouched through grants, self-protection, and reset", async () => {
  const f = fixture();
  try {
    const unrelatedDirectory = path.join(f.agentDir, "unrelated");
    mkdirSync(unrelatedDirectory, { mode: 0o700 });
    const unrelatedConfig = defaultConfig(); unrelatedConfig.defaultMode = "yolo";
    unrelatedConfig.pathRules = [{ path: f.other, scope: "tree", read: "allow", write: "allow" }];
    const unrelatedFiles = new Map([
      ["config.json", JSON.stringify(unrelatedConfig)],
      [STATE_FILE, "malformed private authority"],
      [".authority.lock", "unrelated writer"],
    ]);
    for (const [name, bytes] of unrelatedFiles) writeFileSync(path.join(unrelatedDirectory, name), bytes, { mode: 0o600 });
    rmSync(f.global);
    await f.start();
    assert.equal(f.governed(), true);
    assert.match(await f.awareness(), /Filesystem profile: project/);
    assert.doesNotMatch(await f.awareness(), /global id global:/);
    f.ctx.ui.select = async () => "Remember for this project";
    await f.perm(`grant read ${f.other}`);
    assert.equal(JSON.parse(readFileSync(f.state, "utf8")).version, 4);
    assert.equal(existsSync(f.global), false);
    const file = path.join(f.dir, "notes"); writeFileSync(file, "NOTE");
    f.ctx.ui.select = async () => "Save globally";
    await f.perm(`grant read ${file}`);
    const policy = JSON.parse(readFileSync(f.global, "utf8"));
    assert.equal(policy.version, 3);
    assert.ok(policy.pathRules.some((rule: { path: string; write?: string }) => rule.path === "$AGENT_DIR/permissions" && rule.write === "ask"));
    assert.ok(policy.pathRules.some((rule: { path: string; read?: string }) => rule.path === file && rule.read === "allow"));
    f.ctx.ui.select = async () => "Allow for this session";
    await f.perm(`grant write ${f.agentDir}`);
    f.ctx.ui.select = async () => undefined;
    const before = [f.global, f.state].map((target) => readFileSync(target, "utf8"));
    await assert.rejects(f.execute("write", { path: f.global, content: "overwrite protected policy" }), /denied/i);
    assert.deepEqual([f.global, f.state].map((target) => readFileSync(target, "utf8")), before);
    assert.equal(existsSync(path.join(path.dirname(f.global), ".authority.lock")), false);
    await f.reset();
    assert.equal(existsSync(f.state), false);
    for (const [index, target] of [f.global, f.state].entries()) {
      const name = readdirSync(path.dirname(target)).find((entry) => entry.startsWith(`${path.basename(target)}.backup-`));
      assert.equal(readFileSync(path.join(path.dirname(target), name!), "utf8"), before[index]);
    }
    assert.deepEqual(readdirSync(unrelatedDirectory).sort(), [...unrelatedFiles.keys()].sort());
    for (const [name, bytes] of unrelatedFiles) assert.equal(readFileSync(path.join(unrelatedDirectory, name), "utf8"), bytes);
    assert.match(f.notifications.join("\n"), /Permission policy initialized/);
    await f.reloadExtension();
    assert.equal(f.governed(), true);
    assert.match(await f.awareness(), /Filesystem profile: project/);
    assert.doesNotMatch(await f.awareness(), /other \(tree, project, id /);
    for (const [name, bytes] of unrelatedFiles) assert.equal(readFileSync(path.join(unrelatedDirectory, name), "utf8"), bytes);
  } finally { await f.close(); }
});

test("reset leaves unrelated files beside policy and state untouched", async () => {
  const f = fixture();
  try {
    const unrelated = path.join(path.dirname(f.state), "unrelated.json");
    writeFileSync(unrelated, "unrelated data", { mode: 0o600 });
    await f.start();
    assert.equal(f.governed(), true);
    await f.reset();
    assert.equal(readFileSync(unrelated, "utf8"), "unrelated data");
    assert.ok(!readdirSync(path.dirname(unrelated)).some((name) => name.startsWith("unrelated.json.backup-")));
    await f.reloadExtension();
    assert.equal(f.governed(), true);
    assert.equal(readFileSync(unrelated, "utf8"), "unrelated data");
  } finally { await f.close(); }
});

test("init and reset previews explain losses and defaults while cancellation preserves active authority", async () => {
  const f = fixture();
  try {
    await f.start(); writeFileSync(f.state, "saved-state", { mode: 0o600 });
    const before = [f.global, f.projectFile, f.state].map((file) => readFileSync(file, "utf8"));
    let prompts = 0;
    f.ctx.ui.confirm = async (title, message, options) => {
      prompts++;
      assert.equal(Reflect.get(options!, Symbol.for("pi-extensions:input-dialog")), false);
      assert.equal(title, "Initialize permission policy?");
      assert.equal(message, "Backed up\nconfig.json and state-v4.json in the user permissions directory before reset\n\nDiscarded\nStored approvals across projects.\n\nUnchanged\nAll other files and directories.\n\nNew defaults\nFilesystem   Project access\nNetworking   Unrestricted");
      return false;
    };
    for (const action of ["init", "reset"]) {
      await f.perm(action);
      assert.deepEqual([f.global, f.projectFile, f.state].map((file) => readFileSync(file, "utf8")), before);
    }
    assert.equal(prompts, 2);
    assert.equal(await f.blocked(), false);
    assert.ok(!readdirSync(path.dirname(f.global)).some((name) => name.includes("backup")));
  } finally { await f.close(); }
});

test("backup, config-write, and removal failures preserve or roll back every source file", async (t) => {
  for (const failure of ["backup", "write", "remove"] as const) {
    const f = fixture();
    try {
      await f.start(); writeFileSync(f.state, "saved-state", { mode: 0o600 });
      const files = [f.global, f.projectFile, f.state]; const before = files.map((file) => readFileSync(file, "utf8"));
      if (failure === "backup") {
        const copy = fs.copyFileSync;
        t.mock.method(fs, "copyFileSync", (...args: Parameters<typeof copy>) => {
          if (String(args[0]) === f.state) throw new Error("injected backup failure"); return copy(...args);
        });
      } else if (failure === "write") {
        const write = fs.writeFileSync;
        t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
          if (String(args[0]).endsWith(".tmp")) throw new Error("injected write failure"); return write(...args);
        });
      } else {
        const unlink = fs.unlinkSync;
        t.mock.method(fs, "unlinkSync", (...args: Parameters<typeof unlink>) => {
          if (String(args[0]) === f.state) throw new Error("injected removal failure"); return unlink(...args);
        });
      }
      syncBuiltinESMExports();
      await assert.rejects(f.reset(), /injected/);
      assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before, failure);
      assert.equal(await f.blocked(), true);
      assert.ok(!existsSync(path.join(path.dirname(f.global), ".authority.lock")));
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
  }
});

test("reset respects state locking and retains the original project root across reload", async () => {
  const f = fixture();
  try {
    await f.start();
    const lock = path.join(path.dirname(f.global), ".authority.lock");
    writeFileSync(lock, "other writer", { mode: 0o600 });
    const before = readFileSync(f.global, "utf8");
    await assert.rejects(f.reset(), /EEXIST/); assert.equal(readFileSync(f.global, "utf8"), before); rmSync(lock);
    mkdirSync(path.join(f.other, ".pi", "permissions"));
    const otherPolicy = path.join(f.other, ".pi", "permissions", "config.json"); writeFileSync(otherPolicy, "untouched");
    f.ctx.cwd = f.other;
    await f.reset(); await f.start("reload");
    assert.equal(readFileSync(otherPolicy, "utf8"), "untouched");
    assert.equal(readFileSync(f.projectFile, "utf8"), '{"version":3,"defaultMode":"yolo"}');
    assert.ok(!readdirSync(path.dirname(f.projectFile)).some((name) => name.includes("backup")));
    assert.equal(await f.blocked(), false);
    assert.match(await f.awareness(), new RegExp(f.project));
  } finally { await f.close(); }
});
