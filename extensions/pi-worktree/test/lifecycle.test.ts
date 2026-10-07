import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ExecResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { prepareRemoval, validateRemoval } from "../src/command.ts";
import { createFinishDialog } from "../src/finish-dialog.ts";
import { branchDeletionRisk, deleteApprovedBranch, listWorktrees } from "../src/git.ts";
import { registerWorktreeLifecycle, type WorktreeRequest } from "../src/lifecycle.ts";
import { createWorktreeSettingsRuntime } from "../src/settings.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-lifecycle-")));
  const main = join(root, "main");
  const feature = join(root, "feature");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Lifecycle Test");
  git(main, "config", "user.email", "lifecycle@example.invalid");
  writeFileSync(join(main, "tracked"), "initial\n");
  writeFileSync(join(main, ".gitignore"), "ignored*\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "initial");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  return {
    root,
    main,
    feature,
    addFeature() {
      git(main, "worktree", "add", "-b", "feat/change", feature);
    },
    diverge() {
      writeFileSync(join(feature, "tracked"), "feature\n");
      git(feature, "commit", "-am", "feature change");
    },
    close() {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function transactionRace(root: string, before: string, after = "", beforeRestore = "") {
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const originalPath = process.env.PATH;
  const bin = join(root, "git-wrapper");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}\n
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const realGit = ${JSON.stringify(realGit)};
const args = process.argv.slice(2);
const run = (args) => execFileSync(realGit, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (args[0] === "update-ref" && args[1] === "--stdin") {
  ${before}
  const result = spawnSync(realGit, args, { input: fs.readFileSync(0), encoding: "utf8" });
  ${after}
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(result.status ?? 1);
}
if (args[0] === "update-ref" && args[1] === "--no-deref" && args[2] === "--create-reflog") {
  ${beforeRestore}
}
const result = spawnSync(realGit, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  return () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  };
}

type Runtime = ReturnType<ReturnType<typeof harness>["runtime"]>;

function harness(f: ReturnType<typeof fixture>, initialCwd: string) {
  const settings = createWorktreeSettingsRuntime({
    path: join(f.root, "settings.json"),
    home: f.root,
  });
  const messages: Array<{ cwd: string; text: string; triggerTurn?: boolean }> = [];
  const operations: Array<{ cwd: string; args: string[] }> = [];
  const dialogs: Array<{ title: string; message?: string; choices?: string[] }> = [];
  const preparedPaths: string[] = [];
  const pending: Array<{ runtime: Runtime; text: string }> = [];
  const hooks: {
    confirm: boolean;
    cancelSwitch: boolean;
    failSwitch: boolean;
    hasUI: boolean;
    queuedInput: boolean;
    onWaitForIdle?: () => void;
    select?: (title: string, choices: string[]) => string | undefined;
    onConfirm?: () => void;
    onReplace?: () => void;
    exec?: (cwd: string, args: string[]) => ExecResult | undefined;
  } = { confirm: true, cancelSwitch: false, failSwitch: false, hasUI: true, queuedInput: false };
  let active: Runtime;
  function runtime(cwd: string, manager = SessionManager.inMemory(cwd)) {
    let current = true;
    const commands = new Map<
      string,
      (args: string, ctx: ExtensionCommandContext) => Promise<void>
    >();
    let tool: ToolDefinition;
    const handlers = new Map<
      string,
      Array<(event: unknown, ctx: ExtensionCommandContext) => unknown>
    >();
    const assertCurrent = () => {
      assert.ok(current, "old runtime API was reused after replacement");
    };
    const raw = {
      registerCommand(
        name: string,
        command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) {
        commands.set(name, command.handler);
      },
      registerTool(definition: ToolDefinition) {
        tool = definition;
      },
      on(name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      getAllTools() {
        return [{ name: "inspect", annotations: { readOnlyHint: true } }];
      },
      appendEntry(type: string, data: unknown) {
        assertCurrent();
        manager.appendCustomEntry(type, data);
      },
      sendUserMessage(
        text: string,
        options: { expandPromptTemplates?: boolean; deliverAs?: string },
      ) {
        assertCurrent();
        assert.equal(options.expandPromptTemplates, true);
        assert.equal(options.deliverAs, "followUp");
        pending.push({ runtime: state, text });
      },
      sendMessage(
        value: { customType: string; content: string | []; details?: unknown; display?: boolean },
        options: { triggerTurn?: boolean },
      ) {
        assertCurrent();
        manager.appendCustomMessageEntry(
          value.customType,
          value.content,
          value.display ?? true,
          value.details,
        );
        if (typeof value.content === "string")
          messages.push({ cwd, text: value.content, triggerTurn: options.triggerTurn });
      },
      async exec(
        _command: string,
        args: string[],
        options: { cwd?: string } = {},
      ): Promise<ExecResult> {
        assertCurrent();
        const directory = options.cwd ?? cwd;
        operations.push({ cwd: directory, args });
        const injected = hooks.exec?.(directory, args);
        if (injected) return injected;
        try {
          return { stdout: git(directory, ...args), stderr: "", code: 0, killed: false };
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string; status?: number };
          return {
            stdout: String(failure.stdout ?? ""),
            stderr: String(failure.stderr ?? ""),
            code: failure.status ?? 1,
            killed: false,
          };
        }
      },
    };
    const pi = raw as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      mode: "rpc",
      hasUI: hooks.hasUI,
      sessionManager: manager,
      hasPendingMessages() {
        return hooks.queuedInput;
      },
      ui: {
        notify(text: string) {
          assertCurrent();
          messages.push({ cwd, text });
        },
        async confirm(title: string, message?: string) {
          assertCurrent();
          dialogs.push({ title, message });
          hooks.onConfirm?.();
          return hooks.confirm;
        },
        async select(title: string, choices: string[]) {
          assertCurrent();
          dialogs.push({ title, choices });
          return hooks.select ? hooks.select(title, choices) : choices[0];
        },
      },
      async waitForIdle() {
        assertCurrent();
        hooks.onWaitForIdle?.();
      },
      async switchSession(
        path: string,
        options: { withSession?: (ctx: unknown) => Promise<void> },
      ) {
        assertCurrent();
        preparedPaths.push(path);
        if (hooks.failSwitch) throw new Error("injected replacement failure");
        if (hooks.cancelSwitch) return { cancelled: true };
        const destination = SessionManager.open(path);
        hooks.onReplace?.();
        current = false;
        active = runtime(destination.getCwd(), destination);
        await options.withSession?.({
          ...active.ctx,
          async sendUserMessage(text: string) {
            const [command, token] = text.slice(1).split(" ");
            assert.ok(command && token);
            await active.commands.get(command)?.(token, active.ctx);
          },
          async sendMessage(
            value: { customType: string; content: string },
            options: { triggerTurn?: boolean },
          ) {
            active.raw.sendMessage(value, options);
          },
        });
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;
    registerWorktreeLifecycle(pi, settings, () => ({ isCurrent: () => current }));
    for (const start of handlers.get("session_start") ?? []) start({}, ctx);
    const state = {
      ctx,
      manager,
      pi,
      raw,
      commands,
      emit(name: string, event: unknown) {
        return (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
      },
      get tool() {
        return tool;
      },
      invalidate() {
        current = false;
      },
    };
    return state;
  }
  active = runtime(initialCwd);
  return {
    runtime,
    hooks,
    messages,
    operations,
    dialogs,
    preparedPaths,
    pending,
    get active() {
      return active;
    },
    async propose(request: WorktreeRequest) {
      const result = await active.tool.execute(
        "tool",
        request,
        new AbortController().signal,
        undefined,
        active.ctx as unknown as Parameters<ToolDefinition["execute"]>[4],
      );
      active.manager.appendCustomEntry("test-tool-result", { result });
      return result;
    },
    async drain() {
      while (pending.length) {
        const next = pending.shift();
        assert.ok(next);
        const [command, token] = next.text.slice(1).split(" ");
        assert.ok(command && token);
        await next.runtime.commands.get(command)?.(token, next.runtime.ctx);
      }
    },
  };
}

test("prefilled create has one confirmation and carries the active conversation and pending result", async () => {
  const f = fixture();
  try {
    const h = harness(f, f.main);
    h.active.manager.appendMessage({
      role: "user",
      content: "keep the full conversation",
      timestamp: 1,
    });
    const result = await h.propose({ action: "create", branch: "feat/new", path: f.feature });
    assert.equal(result.terminate, true);
    assert.match(JSON.stringify(result.content), /pending/i);
    assert.equal(existsSync(f.feature), false);
    await h.drain();
    assert.equal(h.dialogs.length, 1);
    assert.equal(h.dialogs[0]?.title, "Create worktree · feat/new");
    assert.ok(h.dialogs[0]?.message?.includes("Branch   feat/new (new)"));
    assert.ok(h.dialogs[0]?.message?.includes("Base     main"));
    assert.ok(h.dialogs[0]?.message?.includes(`Path     ${f.feature}`));
    assert.equal(h.active.ctx.cwd, f.feature);
    assert.equal(
      h.active.manager.getBranch().filter((entry) => entry.type === "message").length,
      1,
    );
    assert.ok(
      h.active.manager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "test-tool-result"),
    );
    assert.match(h.messages.at(-1)?.text ?? "", /created and switched/);
    assert.equal(h.messages.at(-1)?.cwd, f.feature);
    assert.equal(h.messages.at(-1)?.triggerTurn, true);
  } finally {
    f.close();
  }
});

test("create previews and reuses an existing branch at its own tip", async () => {
  const f = fixture();
  try {
    const tip = git(f.main, "rev-parse", "HEAD");
    git(f.main, "branch", "feat/reuse");
    git(f.main, "commit", "--allow-empty", "-m", "advance main");
    const h = harness(f, f.main);
    await h.propose({ action: "create", branch: "feat/reuse", path: f.feature });
    await h.drain();
    assert.equal(h.dialogs.length, 1);
    assert.ok(h.dialogs[0]?.message?.includes("Branch   feat/reuse (existing)"));
    assert.ok(h.dialogs[0]?.message?.includes(`Base     feat/reuse · ${tip}`));
    assert.equal(h.active.ctx.cwd, f.feature);
    assert.equal(git(f.feature, "rev-parse", "HEAD"), tip);
    assert.equal(git(f.feature, "symbolic-ref", "--short", "HEAD"), "feat/reuse");
    assert.equal(
      h.operations
        .find((entry) => entry.args[0] === "worktree" && entry.args[1] === "add")
        ?.args.includes("-b"),
      false,
    );
  } finally {
    f.close();
  }
});

test("create defaults path and base without additional questions", async () => {
  const f = fixture();
  try {
    const h = harness(f, f.main);
    await h.propose({ action: "create", branch: "feat/default" });
    await h.drain();
    assert.equal(h.active.ctx.cwd, join(f.root, ".worktrees", "main", "feat-default"));
    assert.equal(h.dialogs.length, 1);
  } finally {
    f.close();
  }
});

for (const mode of ["confirmation", "replacement-cancel", "replacement-fail"] as const) {
  test(`create ${mode} retains the original workspace and factual outcome`, async () => {
    const f = fixture();
    try {
      const h = harness(f, f.main);
      h.hooks.confirm = mode !== "confirmation";
      h.hooks.cancelSwitch = mode === "replacement-cancel";
      h.hooks.failSwitch = mode === "replacement-fail";
      await h.propose({ action: "create", branch: "feat/new", path: f.feature });
      await h.drain();
      assert.equal(h.active.ctx.cwd, f.main);
      assert.equal(existsSync(f.feature), mode !== "confirmation");
      assert.match(h.messages.at(-1)?.text ?? "", /cancelled|failed/);
      assert.equal(
        h.operations.some((entry) => entry.args[0] === "worktree" && entry.args[1] === "remove"),
        false,
      );
    } finally {
      f.close();
    }
  });
}

for (const merged of [true, false]) {
  for (const reverse of [false, true]) {
    test(`finish ${merged ? "merged" : "uncertain"} ${reverse ? "overrides" : "uses"} deletion default in one approval`, async () => {
      const f = fixture();
      try {
        f.addFeature();
        if (!merged) f.diverge();
        const h = harness(f, f.feature);
        h.hooks.select = (title, choices) => {
          if (!merged) {
            assert.ok(title.includes(git(f.feature, "rev-parse", "HEAD")));
            assert.match(title, /DATA-LOSS WARNING/);
          } else {
            assert.doesNotMatch(title, /VERIFICATION|Branch tip/);
          }
          assert.match(choices[0] ?? "", merged ? /DELETE/ : /KEEP/);
          return choices[reverse ? 1 : 0];
        };
        await h.propose({ action: "finish" });
        await h.drain();
        assert.equal(h.dialogs.length, 1);
        assert.equal(h.active.ctx.cwd, f.main);
        assert.equal(existsSync(f.feature), false);
        const deleted = merged !== reverse;
        assert.equal(git(f.main, "branch", "--list", "feat/change") === "", deleted);
        const removal = h.operations.find(
          (entry) => entry.args[0] === "worktree" && entry.args[1] === "remove",
        );
        assert.equal(removal?.cwd, f.main);
        assert.equal(h.messages.at(-1)?.cwd, f.main);
        const approval = h.active.manager
          .getBranch()
          .find((entry) => entry.type === "custom" && entry.customType === "worktree-approved");
        assert.ok(approval?.type === "custom");
        const token = (approval.data as { token: string }).token;
        const count = h.operations.length;
        await h.active.commands.get("worktree-arrive")?.(token, h.active.ctx);
        assert.equal(h.operations.length, count, "consumed approval cannot replay");
      } finally {
        f.close();
      }
    });
  }
}

for (const mode of ["dialog", "switch-cancel", "switch-fail"] as const) {
  test(`finish ${mode} never removes its source`, async () => {
    const f = fixture();
    try {
      f.addFeature();
      const h = harness(f, f.feature);
      if (mode === "dialog") h.hooks.select = () => undefined;
      h.hooks.cancelSwitch = mode === "switch-cancel";
      h.hooks.failSwitch = mode === "switch-fail";
      await h.propose({ action: "finish" });
      await h.drain();
      assert.equal(h.active.ctx.cwd, f.feature);
      assert.ok(existsSync(f.feature));
      assert.notEqual(git(f.main, "branch", "--list", "feat/change"), "");
      assert.match(h.messages.at(-1)?.text ?? "", /cancelled|failed/);
      if (mode !== "dialog") {
        const prepared = h.preparedPaths.at(-1);
        assert.ok(prepared);
        const retained = h.runtime(f.main, SessionManager.open(prepared));
        const approval = retained.manager
          .getBranch()
          .find((entry) => entry.type === "custom" && entry.customType === "worktree-approved");
        assert.ok(approval?.type === "custom");
        const before = h.operations.length;
        await retained.commands.get("worktree-arrive")?.(
          (approval.data as { token: string }).token,
          retained.ctx,
        );
        assert.equal(
          h.operations.length,
          before,
          "cancelled prepared sessions cannot activate cleanup",
        );
        assert.ok(existsSync(f.feature));
      }
    } finally {
      f.close();
    }
  });
}

for (const dirty of ["tracked", "untracked", "index-flag"] as const) {
  test(`finish refuses ${dirty} data before any approval or switch`, async () => {
    const f = fixture();
    try {
      f.addFeature();
      if (dirty === "index-flag") git(f.feature, "update-index", "--assume-unchanged", "tracked");
      else
        writeFileSync(join(f.feature, dirty === "tracked" ? "tracked" : "untracked"), "local data");
      const h = harness(f, f.feature);
      await h.propose({ action: "finish" });
      await h.drain();
      assert.equal(h.dialogs.length, 0);
      assert.equal(h.active.ctx.cwd, f.feature);
      assert.ok(existsSync(f.feature));
      assert.match(h.messages.at(-1)?.text ?? "", /Removal refused/);
    } finally {
      f.close();
    }
  });
}

for (const mutation of ["branch", "ignored", "recovery", "main", "dirty", "locked"] as const) {
  test(`finish revalidates ${mutation} after switch and preserves data on failure`, async () => {
    const f = fixture();
    try {
      f.addFeature();
      const h = harness(f, f.feature);
      h.hooks.onReplace = () => {
        if (mutation === "branch") f.diverge();
        if (mutation === "ignored")
          writeFileSync(join(f.feature, "ignored-new"), "new ignored data");
        if (mutation === "dirty") writeFileSync(join(f.feature, "tracked"), "late local data");
        if (mutation === "locked") git(f.main, "worktree", "lock", f.feature);
        if (mutation === "main") git(f.main, "commit", "--allow-empty", "-m", "main moved");
        if (mutation === "recovery") {
          git(f.feature, "commit", "--allow-empty", "-m", "temporary recovery commit");
          git(f.feature, "reset", "--hard", "HEAD~1");
        }
      };
      await h.propose({ action: "finish" });
      await h.drain();
      assert.equal(h.active.ctx.cwd, f.main);
      assert.ok(existsSync(f.feature));
      assert.notEqual(git(f.main, "branch", "--list", "feat/change"), "");
      assert.match(h.messages.at(-1)?.text ?? "", /partial result/);
      assert.equal(
        h.operations.some((entry) => entry.args[0] === "update-ref"),
        false,
      );
    } finally {
      f.close();
    }
  });
}

test("cleanup failure stays in main and allows a fresh finish retry without restart", async () => {
  const f = fixture();
  try {
    f.addFeature();
    const h = harness(f, f.feature);
    h.hooks.exec = (_cwd, args) =>
      args[0] === "worktree" && args[1] === "remove"
        ? { stdout: "", stderr: "injected cleanup failure", code: 1, killed: false }
        : undefined;
    await h.propose({ action: "finish" });
    await h.drain();
    assert.equal(h.active.ctx.cwd, f.main);
    assert.ok(existsSync(f.feature));
    assert.match(h.messages.at(-1)?.text ?? "", /partial result/);
    h.hooks.exec = undefined;
    await h.propose({ action: "finish" });
    await h.drain();
    assert.equal(existsSync(f.feature), false);
    assert.equal(git(f.main, "branch", "--list", "feat/change"), "");
  } finally {
    f.close();
  }
});

test("branch deletion race retains the moved branch after successful removal", async () => {
  const f = fixture();
  try {
    f.addFeature();
    const h = harness(f, f.feature);
    const targetOid = git(f.main, "rev-parse", "HEAD");
    const newOid = git(
      f.main,
      "commit-tree",
      `${targetOid}^{tree}`,
      "-p",
      targetOid,
      "-m",
      "moved branch",
    );
    const restorePath = transactionRace(
      f.root,
      `run(["update-ref", "refs/heads/feat/change", ${JSON.stringify(newOid)}]);`,
    );
    try {
      await h.propose({ action: "finish" });
      await h.drain();
    } finally {
      restorePath();
    }
    assert.equal(h.active.ctx.cwd, f.main);
    assert.equal(existsSync(f.feature), false);
    assert.equal(git(f.main, "rev-parse", "refs/heads/feat/change"), newOid);
    assert.match(h.messages.at(-1)?.text ?? "", /branch deletion failed/);
  } finally {
    f.close();
  }
});

test("headless and concurrent/replayed proposals have no side effects", async () => {
  const f = fixture();
  try {
    const h = harness(f, f.main);
    Object.defineProperty(h.active.ctx, "hasUI", { value: false, configurable: true });
    await assert.rejects(
      h.propose({ action: "create", branch: "feat/new", path: f.feature }),
      /headless/,
    );
    assert.equal(h.operations.length, 0);
    assert.equal(h.pending.length, 0);
    Object.defineProperty(h.active.ctx, "hasUI", { value: true });
    h.hooks.confirm = false;
    await h.propose({ action: "create", branch: "feat/new", path: f.feature });
    const queued = h.pending[0];
    assert.ok(queued);
    await assert.rejects(h.propose({ action: "finish" }), /already pending/);
    await h.drain();
    const before = h.operations.length;
    const token = queued.text.split(" ")[1];
    assert.ok(token);
    await h.active.commands.get("worktree-apply")?.(token, h.active.ctx);
    assert.equal(h.operations.length, before);
  } finally {
    f.close();
  }
});

test("stale source-session proposal is rejected before Git runs", async () => {
  const f = fixture();
  try {
    const h = harness(f, f.main);
    await h.propose({ action: "create", branch: "feat/new", path: f.feature });
    const queued = h.pending.shift();
    assert.ok(queued);
    const token = queued.text.split(" ")[1];
    assert.ok(token);
    const wrong = h.runtime(f.main);
    await queued.runtime.commands.get("worktree-apply")?.(token, wrong.ctx);
    assert.equal(h.operations.length, 0);
  } finally {
    f.close();
  }
});

test("switch only accepts exact registered path and continues in the replacement workspace", async () => {
  const f = fixture();
  try {
    f.addFeature();
    const h = harness(f, f.main);
    await h.propose({ action: "switch", path: `${f.feature}/.` });
    await h.drain();
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.active.ctx.cwd, f.main);
    await h.propose({ action: "switch", path: f.feature });
    await h.drain();
    assert.equal(h.dialogs.length, 1);
    assert.equal(h.active.ctx.cwd, f.feature);
    assert.match(h.messages.at(-1)?.text ?? "", /Active workspace/);
  } finally {
    f.close();
  }
});

test("approved removal cannot delete the current worktree or stale administrative identity", async () => {
  const f = fixture();
  try {
    f.addFeature();
    const h = harness(f, f.feature);
    const feature = (await listWorktrees(h.active.pi, f.feature)).find((record) => !record.isMain);
    assert.ok(feature);
    const plan = await prepareRemoval(h.active.pi, h.active.ctx, feature, true);
    await assert.rejects(validateRemoval(h.active.pi, h.active.ctx, plan), /current worktree/);
    const main = h.runtime(f.main);
    plan.administrativePath = join(f.root, "wrong-admin");
    await assert.rejects(
      validateRemoval(main.pi, main.ctx, plan),
      /ENOENT|administrative recovery/,
    );
    assert.ok(existsSync(f.feature));
  } finally {
    f.close();
  }
});

test("branch deletion refuses checkout elsewhere and main-target movement", async () => {
  const f = fixture();
  try {
    f.addFeature();
    const h = harness(f, f.main);
    const [target, feature] = await listWorktrees(h.active.pi, f.main);
    assert.ok(target && feature);
    await assert.rejects(
      deleteApprovedBranch(h.active.pi, f.main, feature, target, []),
      /checked out/,
    );
    git(f.main, "worktree", "remove", f.feature);
    git(f.main, "commit", "--allow-empty", "-m", "main changed");
    await assert.rejects(
      deleteApprovedBranch(h.active.pi, f.main, feature, target, []),
      /main checkout changed/,
    );
    assert.notEqual(git(f.main, "branch", "--list", "feat/change"), "");
  } finally {
    f.close();
  }
});

test("create refuses path and branch races after its sole approval", async () => {
  const f = fixture();
  try {
    const h = harness(f, f.main);
    h.hooks.onConfirm = () => mkdirSync(f.feature);
    await h.propose({ action: "create", branch: "feat/new", path: f.feature });
    await h.drain();
    assert.equal(h.active.ctx.cwd, f.main);
    assert.equal(git(f.main, "branch", "--list", "feat/new"), "");
    assert.match(h.messages.at(-1)?.text ?? "", /already exists/);
    rmSync(f.feature, { recursive: true });
    h.hooks.onConfirm = () => git(f.main, "branch", "feat/new");
    await h.propose({ action: "create", branch: "feat/new", path: f.feature });
    await h.drain();
    assert.equal(existsSync(f.feature), false);
    assert.match(h.messages.at(-1)?.text ?? "", /changed after confirmation/);
  } finally {
    f.close();
  }
});

test("finish renderer exposes uncertain-deletion warning in the same screen and respects all widths", () => {
  const tip = "1".repeat(40);
  let choice: boolean | undefined;
  const component = createFinishDialog(
    {
      mainPath: `/long/main/${"界".repeat(30)}`,
      worktreePath: `/long/feature/${"界".repeat(30)}`,
      ignored: [],
      branch: "feat/界".repeat(20),
      tip,
      merged: false,
      risk: [tip],
    },
    (value) => {
      choice = value;
    },
    () => {},
    (_role, text) => text,
    () => 24,
  );
  assert.equal(
    component.render(80).some((line) => line.includes("DATA-LOSS")),
    false,
  );
  component.handleInput(" ");
  assert.ok(component.render(80).some((line) => line.includes("DATA-LOSS")));
  for (let index = 0; index < 100; index++) component.handleInput("\u001b[B");
  assert.ok(component.render(80).join("\n").includes(tip));
  for (const width of [0, 1, 2, 5, 10, 40, 80, 160]) {
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
  }
  component.handleInput("\r");
  assert.equal(choice, true);
});

test("inherited tool execution in a child session cannot queue or mutate the root workspace", async () => {
  const f = fixture();
  try {
    const h = harness(f, f.main);
    const child = h.runtime(f.main);
    await assert.rejects(
      h.active.tool.execute(
        "child",
        { action: "create", branch: "feat/child", path: f.feature },
        new AbortController().signal,
        undefined,
        child.ctx as unknown as Parameters<ToolDefinition["execute"]>[4],
      ),
      /foreground session/,
    );
    assert.equal(h.pending.length, 0);
    assert.equal(h.operations.length, 0);
    assert.equal(existsSync(f.feature), false);
  } finally {
    f.close();
  }
});

test("an abandoned active branch invalidates a queued proposal", async () => {
  const f = fixture();
  try {
    const h = harness(f, f.main);
    const parent = h.active.manager.appendMessage({
      role: "user",
      content: "parent",
      timestamp: 1,
    });
    h.active.manager.appendMessage({ role: "user", content: "proposal branch", timestamp: 2 });
    await h.propose({ action: "create", branch: "feat/new", path: f.feature });
    h.active.manager.branch(parent);
    await h.drain();
    assert.equal(h.operations.length, 0);
    assert.equal(h.dialogs.length, 0);
  } finally {
    f.close();
  }
});

test("source approval replay cannot delete a recreated same-path same-tip worktree", async () => {
  const f = fixture();
  try {
    f.addFeature();
    const h = harness(f, f.feature);
    await h.propose({ action: "finish" });
    await h.drain();
    const approved = h.active.manager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === "worktree-approved");
    assert.ok(approved?.type === "custom");
    const token = (approved.data as { token: string }).token;
    f.addFeature();
    h.active.manager.branch(approved.id);
    const count = h.operations.length;
    await h.active.commands.get("worktree-arrive")?.(token, h.active.ctx);
    assert.equal(h.operations.length, count, "consumption applies across session tree navigation");
    assert.ok(existsSync(f.feature));
    assert.notEqual(git(f.main, "branch", "--list", "feat/change"), "");
    const feature = (await listWorktrees(h.active.pi, f.main)).find((record) => !record.isMain);
    assert.ok(feature);
    const plan = await prepareRemoval(h.active.pi, h.active.ctx, feature, true);
    git(f.main, "worktree", "remove", f.feature);
    git(f.main, "worktree", "add", f.feature, "feat/change");
    await assert.rejects(validateRemoval(h.active.pi, h.active.ctx, plan), /recreated|replaced/);
  } finally {
    f.close();
  }
});

test("finish retains upstream ignored and administrative recovery warnings in the sole dialog", async () => {
  const f = fixture();
  try {
    f.addFeature();
    git(f.feature, "commit", "--allow-empty", "-m", "temporary");
    const recovery = git(f.feature, "rev-parse", "HEAD");
    git(f.feature, "reset", "--hard", "HEAD~1");
    writeFileSync(join(f.feature, "ignored-cache"), "approved cache");
    const h = harness(f, f.feature);
    h.hooks.select = (title, choices) => {
      assert.match(title, /Ignored to delete:/);
      assert.ok(title.includes("ignored-cache"));
      assert.match(title, /Administrative recovery warning/);
      assert.ok(title.includes(recovery));
      return choices[0];
    };
    await h.propose({ action: "finish" });
    await h.drain();
    assert.equal(h.dialogs.length, 1);
    assert.equal(existsSync(f.feature), false);
  } finally {
    f.close();
  }
});

for (const request of [
  { action: "create", branch: "feat/new" },
  { action: "switch", path: "/registered/path" },
  { action: "finish" },
] as const) {
  test(`${request.action} refuses existing queued input without proposal, Git, or confirmation`, async () => {
    const f = fixture();
    try {
      const h = harness(f, f.main);
      h.hooks.queuedInput = true;
      await assert.rejects(
        h.propose(request),
        /NOT accepted.*Current workspace unchanged.*Process queued input.*reissue/,
      );
      assert.equal(h.operations.length, 0);
      assert.equal(h.dialogs.length, 0);
      assert.equal(h.pending.length, 0);
      assert.equal(h.active.manager.getBranch().length, 0);
      assert.equal(h.hooks.queuedInput, true);
      const status = await h.propose({ action: "status" });
      assert.ok(status.content.length);
      assert.equal(h.pending.length, 0);
    } finally {
      f.close();
    }
  });
}

for (const moment of ["before-idle", "after-idle"] as const) {
  test(`queued input at ${moment} refuses the dispatched transition without draining it`, async () => {
    const f = fixture();
    try {
      const h = harness(f, f.main);
      await h.propose({ action: "create", branch: "feat/new", path: f.feature });
      if (moment === "before-idle") h.hooks.queuedInput = true;
      else
        h.hooks.onWaitForIdle = () => {
          h.hooks.queuedInput = true;
        };
      await h.drain();
      assert.equal(h.operations.length, 0);
      assert.equal(h.dialogs.length, 0);
      assert.equal(h.active.ctx.cwd, f.main);
      assert.equal(h.hooks.queuedInput, true);
      assert.match(h.messages.at(-1)?.text ?? "", /NOT accepted.*Current workspace unchanged/);
    } finally {
      f.close();
    }
  });
}

test("late ordinary input and mutating sibling tools are rejected only while transition is pending", async () => {
  const f = fixture();
  try {
    const h = harness(f, f.main);
    h.hooks.confirm = false;
    await h.propose({ action: "create", branch: "feat/new", path: f.feature });
    assert.deepEqual(
      h.active.emit("input", { type: "input", text: "late follow-up", source: "rpc" }),
      [{ action: "handled" }],
    );
    assert.match(h.messages.at(-1)?.text ?? "", /not accepted.*Resubmit/);
    for (const name of ["write", "edit", "bash", "unknown_mutator"]) {
      const [blocked] = h.active.emit("tool_call", { toolName: name, input: {} });
      assert.equal((blocked as { block: boolean }).block, true);
      assert.equal((blocked as { terminate: boolean }).terminate, true);
    }
    for (const name of ["read", "inspect", "worktree"]) {
      assert.deepEqual(
        h.active.emit("tool_call", { toolName: name, input: { action: "status" } }),
        [undefined],
      );
    }
    h.hooks.onConfirm = () => {
      assert.deepEqual(h.active.emit("input", { text: "during approval", source: "rpc" }), [
        { action: "handled" },
      ]);
    };
    await h.drain();
    assert.deepEqual(h.active.emit("input", { text: "after completion", source: "rpc" }), [
      undefined,
    ]);
    assert.deepEqual(h.active.emit("tool_call", { toolName: "write", input: {} }), [undefined]);
  } finally {
    f.close();
  }
});

function reflogOnlyFeature(f: ReturnType<typeof fixture>) {
  f.addFeature();
  f.diverge();
  const recovery = git(f.feature, "rev-parse", "HEAD");
  git(f.main, "worktree", "remove", f.feature);
  git(f.main, "branch", "-f", "feat/change", "main");
  const log = git(
    f.main,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "logs/refs/heads/feat/change",
  );
  git(f.main, "worktree", "add", f.feature, "feat/change");
  return { recovery, log };
}

for (const removeBranch of [false, true]) {
  test(`finish ${removeBranch ? "explicitly approves deletion of" : "keeps recoverability from"} shared reflog-only history`, async () => {
    const f = fixture();
    try {
      const { recovery, log } = reflogOnlyFeature(f);
      const h = harness(f, f.feature);
      const tip = git(f.feature, "rev-parse", "HEAD");
      assert.deepEqual(
        await branchDeletionRisk(h.active.pi, f.feature, "refs/heads/feat/change", tip, tip),
        [recovery],
      );
      const originalLog = readFileSync(log, "utf8");
      h.hooks.select = (title, choices) => {
        assert.ok(title.includes(recovery));
        assert.match(title, /reflog/i);
        assert.match(choices[0] ?? "", /DELETE/);
        return choices.find((choice) => choice.includes(removeBranch ? "DELETE" : "KEEP"));
      };
      await h.propose({ action: "finish" });
      await h.drain();
      assert.equal(h.dialogs.length, 1);
      assert.equal(existsSync(f.feature), false);
      assert.equal(existsSync(log), !removeBranch);
      if (!removeBranch) assert.equal(readFileSync(log, "utf8"), originalLog);
      assert.equal(
        git(f.main, "rev-list", "--reflog", "--all").split("\n").includes(recovery),
        !removeBranch,
      );
    } finally {
      f.close();
    }
  });
}

test("branch deletion risk includes raw OLD reflog OIDs and rejects new recovery-only risk", async () => {
  const f = fixture();
  try {
    const { recovery, log } = reflogOnlyFeature(f);
    const h = harness(f, f.main);
    const [target, feature] = await listWorktrees(h.active.pi, f.main);
    assert.ok(target?.head && feature?.head);
    const lastEntry = readFileSync(log, "utf8").trimEnd().split("\n").at(-1);
    assert.ok(lastEntry?.startsWith(recovery));
    writeFileSync(log, `${lastEntry}\n`);
    assert.deepEqual(
      await branchDeletionRisk(
        h.active.pi,
        f.main,
        "refs/heads/feat/change",
        feature.head,
        target.head,
      ),
      [recovery],
    );
    git(f.main, "worktree", "remove", f.feature);
    await assert.rejects(
      deleteApprovedBranch(h.active.pi, f.main, feature, target, []),
      /recovery reachability changed/,
    );
    assert.equal(git(f.main, "rev-parse", "refs/heads/feat/change"), feature.head);
    assert.equal(readFileSync(log, "utf8"), `${lastEntry}\n`);
  } finally {
    f.close();
  }
});

for (const unsafe of ["malformed", "dangling-symlink"] as const) {
  test(`branch recovery inventory fails closed for ${unsafe} reflog`, async () => {
    const f = fixture();
    try {
      f.addFeature();
      const h = harness(f, f.main);
      const tip = git(f.main, "rev-parse", "HEAD");
      const log = git(
        f.main,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "logs/refs/heads/feat/change",
      );
      if (unsafe === "malformed") writeFileSync(log, "invalid raw reflog\n");
      else {
        rmSync(log);
        symlinkSync(join(f.root, "missing-reflog"), log);
      }
      await assert.rejects(
        branchDeletionRisk(h.active.pi, f.main, "refs/heads/feat/change", tip, tip),
        /malformed|symbolic link/,
      );
    } finally {
      f.close();
    }
  });
}

async function approvedDeletion(f: ReturnType<typeof fixture>) {
  f.addFeature();
  const h = harness(f, f.main);
  const [target, feature] = await listWorktrees(h.active.pi, f.main);
  assert.ok(target?.head && feature?.head && feature.branchRef);
  git(f.main, "worktree", "remove", f.feature);
  const risk = await branchDeletionRisk(
    h.active.pi,
    f.main,
    feature.branchRef,
    feature.head,
    target.head,
  );
  return { h, target, feature, risk };
}

for (const detached of [false, true]) {
  test(`transaction rejects concurrent ${detached ? "detached HEAD" : "target branch"} movement without deleting source`, async () => {
    const f = fixture();
    try {
      const { h, target, feature, risk } = await approvedDeletion(f);
      if (detached) {
        git(f.main, "checkout", "--detach");
        target.branchRef = undefined;
        target.branch = undefined;
        target.detached = true;
      }
      const log = git(
        f.main,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "logs/refs/heads/feat/change",
      );
      const originalLog = readFileSync(log, "utf8");
      const restorePath = transactionRace(
        f.root,
        'run(["commit", "--allow-empty", "-m", "target moved"]);',
      );
      try {
        await assert.rejects(
          deleteApprovedBranch(h.active.pi, f.main, feature, target, risk),
          /failed.*Restoration conflicted/s,
        );
      } finally {
        restorePath();
      }
      assert.equal(git(f.main, "rev-parse", "refs/heads/feat/change"), feature.head);
      assert.equal(readFileSync(log, "utf8"), originalLog);
    } finally {
      f.close();
    }
  });
}

test("membership race restores the approved tip but accurately reports prior reflog loss", async () => {
  const f = fixture();
  try {
    const { recovery, log } = reflogOnlyFeature(f);
    const h = harness(f, f.main);
    const [target, feature] = await listWorktrees(h.active.pi, f.main);
    assert.ok(target?.head && feature?.head && feature.branchRef);
    const risk = await branchDeletionRisk(
      h.active.pi,
      f.main,
      feature.branchRef,
      feature.head,
      target.head,
    );
    git(f.main, "worktree", "remove", f.feature);
    const restorePath = transactionRace(
      f.root,
      `run(["worktree", "add", ${JSON.stringify(f.feature)}, "feat/change"]);`,
    );
    try {
      await assert.rejects(
        deleteApprovedBranch(h.active.pi, f.main, feature, target, risk),
        /became checked out.*tip.*restored.*previous branch reflog.*NOT restore/s,
      );
    } finally {
      restorePath();
    }
    assert.equal(git(f.main, "rev-parse", "refs/heads/feat/change"), feature.head);
    assert.equal(git(f.feature, "rev-parse", "HEAD"), feature.head);
    assert.equal(readFileSync(log, "utf8").includes(recovery), false);
  } finally {
    f.close();
  }
});

for (const problem of [
  "post-check",
  "ambiguous-command",
  "cancellation",
  "destination-changed",
] as const) {
  test(`${problem} after transaction commit attempts bounded expected-absent restoration`, async () => {
    const f = fixture();
    try {
      const { h, target, feature, risk } = await approvedDeletion(f);
      const controller = new AbortController();
      if (problem === "post-check" || problem === "cancellation") {
        h.hooks.exec = (_cwd, args) => {
          if (
            args[0] === "worktree" &&
            args[1] === "list" &&
            git(f.main, "branch", "--list", "feat/change") === ""
          ) {
            if (problem === "cancellation") controller.abort();
            else
              return { stdout: "", stderr: "injected post-check failure", code: 1, killed: false };
          }
          return undefined;
        };
      }
      const after =
        problem === "ambiguous-command"
          ? "result.status = 1;"
          : problem === "destination-changed"
            ? 'run(["commit", "--allow-empty", "-m", "late target move"]);'
            : "";
      const restorePath = transactionRace(f.root, "", after);
      try {
        await assert.rejects(
          deleteApprovedBranch(h.active.pi, f.main, feature, target, risk, controller.signal),
          /restored.*NOT restore/s,
        );
      } finally {
        restorePath();
      }
      assert.equal(git(f.main, "rev-parse", "refs/heads/feat/change"), feature.head);
      if (problem === "cancellation") assert.equal(controller.signal.aborted, true);
    } finally {
      f.close();
    }
  });
}

test("restoration never overwrites a ref concurrently recreated before expected-absent CAS", async () => {
  const f = fixture();
  try {
    const { h, target, feature, risk } = await approvedDeletion(f);
    const newOid = git(
      f.main,
      "commit-tree",
      `${feature.head}^{tree}`,
      "-p",
      feature.head ?? "",
      "-m",
      "recreated ref",
    );
    const restorePath = transactionRace(
      f.root,
      "",
      "result.status = 1;",
      `run(["update-ref", "refs/heads/feat/change", ${JSON.stringify(newOid)}]);`,
    );
    try {
      await assert.rejects(
        deleteApprovedBranch(h.active.pi, f.main, feature, target, risk),
        /Restoration conflicted.*not overwritten/,
      );
    } finally {
      restorePath();
    }
    assert.equal(git(f.main, "rev-parse", "refs/heads/feat/change"), newOid);
  } finally {
    f.close();
  }
});

test("cancellation before transaction cannot delete or replace the branch", async () => {
  const f = fixture();
  try {
    const { h, target, feature, risk } = await approvedDeletion(f);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      deleteApprovedBranch(h.active.pi, f.main, feature, target, risk, controller.signal),
      /cancelled/,
    );
    assert.equal(git(f.main, "rev-parse", "refs/heads/feat/change"), feature.head);
  } finally {
    f.close();
  }
});
