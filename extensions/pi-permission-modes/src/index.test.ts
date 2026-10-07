import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config-load.ts";
import permissionExtension from "./index.ts";
import { bindPath } from "./paths.ts";
import { LEGACY_STATE_FILE, STATE_FILE } from "./permission-state.ts";

type Hook = (event: never, context: ExtensionContext) => unknown;
function fixture() {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-reset-"))).canonical;
  const project = path.join(dir, "project"); const agentDir = path.join(dir, "agent"); const other = path.join(dir, "other");
  for (const folder of [project, agentDir, other, path.join(project, ".pi"), path.join(other, ".pi"), path.join(agentDir, "permission-mode")]) mkdirSync(folder, { mode: 0o700 });
  const oldHome = process.env.HOME; const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = dir; process.env.PI_CODING_AGENT_DIR = agentDir;
  const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  const global = path.join(agentDir, "permission-mode", "permission-mode.json");
  const projectFile = path.join(project, ".pi", "permission-mode.json");
  const state = path.join(agentDir, "permission-mode", STATE_FILE);
  writeFileSync(global, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(projectFile, '{"version":2}', { mode: 0o600 });
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
    dir, project, other, agentDir, global, projectFile, state, ctx, manager, notifications,
    execute: (name: string, input: Record<string, unknown>) => tools.get(name)!.execute("probe", input, undefined, undefined, ctx),
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

test("obsolete transcript entries carry no authority and unsupported configuration falls back to unrestricted tools", async () => {
  const f = fixture();
  try {
    f.manager.appendCustomEntry("perm-mode", { mode: "yolo" });
    f.manager.appendCustomEntry("permission-schema-v2", { acknowledged: true });
    await f.start();
    assert.equal(await f.blocked(), false);
    assert.match(await f.awareness(), /Filesystem profile: project/);
    writeFileSync(f.global, '{"version":1,"modes":{"code":{"bashAllow":["*"]}}}');
    await f.start("reload");
    assert.equal(await f.blocked(), false);
    assert.match(await f.awareness(), /Filesystem access is unrestricted and subprocess networking is open/);
    assert.equal(f.governed(), false);
    assert.match(f.notifications.join("\n"), /Unsupported permission configuration version/);
    assert.doesNotMatch(f.notifications.join("\n"), /legacy policy|acknowledge/);
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
      assert.ok(title.includes("Exact-file grant"));
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
      assert.ok(title.includes("Directory grant"));
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
  for (const malformed of ['{"modes":{"old":{}}}', '{"version":2,"unexpected":true}']) {
    const f = fixture();
    try {
      writeFileSync(f.global, malformed);
      await f.start(); assert.equal(await f.blocked(), false);
      const otherPolicy = path.join(f.other, ".pi", "permission-mode.json");
      writeFileSync(otherPolicy, "untouched"); f.ctx.cwd = f.other;
      await f.reloadExtension(); assert.equal(await f.blocked(), false);
      await f.reset(); await f.reloadExtension();
      assert.equal(readFileSync(otherPolicy, "utf8"), "untouched");
      assert.equal(readFileSync(f.projectFile, "utf8"), '{"version":2}');
      assert.ok(!readdirSync(path.dirname(f.projectFile)).some((name) => name.includes("backup")));
      const backup = readdirSync(path.dirname(f.global)).find((name) => name.startsWith("permission-mode.json.backup-"));
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
    writeFileSync(f.global, '{"version":1}');
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

test("reset removes backed-up legacy state so migration cannot resurrect old authority", async () => {
  const f = fixture();
  try {
    await f.start();
    const legacy = path.join(path.dirname(f.state), LEGACY_STATE_FILE);
    writeFileSync(legacy, "legacy authority", { mode: 0o600 });
    await f.reset();
    assert.equal(existsSync(legacy), false);
    const backup = readdirSync(path.dirname(legacy)).find((name) => name.startsWith(`${LEGACY_STATE_FILE}.backup-`));
    assert.equal(readFileSync(path.join(path.dirname(legacy), backup!), "utf8"), "legacy authority");
    await f.reloadExtension();
    assert.equal(f.governed(), true);
  } finally { await f.close(); }
});

test("cancelled reset leaves policy, state, and active authority untouched", async () => {
  const f = fixture();
  try {
    await f.start(); writeFileSync(f.state, "saved-state", { mode: 0o600 });
    const before = [f.global, f.projectFile, f.state].map((file) => readFileSync(file, "utf8"));
    f.confirm(false); await f.reset();
    assert.deepEqual([f.global, f.projectFile, f.state].map((file) => readFileSync(file, "utf8")), before);
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
    const otherPolicy = path.join(f.other, ".pi", "permission-mode.json"); writeFileSync(otherPolicy, "untouched");
    f.ctx.cwd = f.other;
    await f.reset(); await f.start("reload");
    assert.equal(readFileSync(otherPolicy, "utf8"), "untouched");
    assert.equal(readFileSync(f.projectFile, "utf8"), '{"version":2}');
    assert.ok(!readdirSync(path.dirname(f.projectFile)).some((name) => name.includes("backup")));
    assert.equal(await f.blocked(), false);
    assert.match(await f.awareness(), new RegExp(f.project));
  } finally { await f.close(); }
});
