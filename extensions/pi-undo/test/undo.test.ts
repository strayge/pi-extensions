import assert from "node:assert/strict";
import test from "node:test";
import undoExtension from "../src/index.ts";

function harness() {
  const user = {
    id: "user",
    parentId: null,
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "fix teh bug" }] },
  };
  let branch = [user, { id: "reply", type: "message", message: { role: "assistant" } }];
  let editor = "";
  let sessionId = "session";
  let queued: string[] = [];
  let cancelled = false;
  let idle: () => Promise<void> = async () => {};
  let beforeNavigate: () => void = () => {};
  const notices: string[] = [];
  const navigations: [string, unknown][] = [];
  const sent: unknown[][] = [];
  const anchors: string[] = [];
  let aborts = 0;
  let command: (args: string, ctx: unknown) => Promise<void>;
  let shortcut: () => void;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      getEditorText: () => editor,
      setEditorText: (text: string) => {
        editor = text;
      },
      notify: (text: string) => notices.push(text),
    },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => sessionId,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    abort() {
      aborts++;
      editor = [...queued, editor].filter(Boolean).join("\n\n");
      queued = [];
    },
    waitForIdle: () => idle(),
    async navigateTree(id: string, options: unknown) {
      navigations.push([id, options]);
      beforeNavigate();
      if (cancelled) return { cancelled: true };
      branch = branch.slice(
        0,
        branch.findIndex((entry) => entry.id === id),
      );
      // Model the built-in TUI's automatic text restoration for an empty editor.
      if (!editor.trim()) {
        editor =
          typeof user.message.content === "string"
            ? user.message.content
            : user.message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
      }
      return { cancelled: false };
    },
  };
  undoExtension({
    registerCommand(name: string, options: { handler: typeof command }) {
      assert.equal(name, "undo");
      command = options.handler;
    },
    registerShortcut(key: string, options: { handler: typeof shortcut }) {
      assert.equal(key, "alt+u");
      shortcut = options.handler;
    },
    sendUserMessage(...args: unknown[]) {
      sent.push(args);
    },
    appendEntry(type: string) {
      anchors.push(type);
      branch.push({ id: "anchor", type, message: { role: "custom" } });
    },
  } as never);
  return {
    ctx,
    user,
    notices,
    navigations,
    sent,
    anchors,
    run: () => command("", ctx),
    shortcut: () => shortcut(),
    get aborts() {
      return aborts;
    },
    get editor() {
      return editor;
    },
    set editor(value: string) {
      editor = value;
    },
    get branch() {
      return branch;
    },
    set branch(value: typeof branch) {
      branch = value;
    },
    set queued(value: string[]) {
      queued = value;
    },
    set sessionId(value: string) {
      sessionId = value;
    },
    set idle(value: typeof idle) {
      idle = value;
    },
    set beforeNavigate(value: typeof beforeNavigate) {
      beforeNavigate = value;
    },
    set cancelled(value: boolean) {
      cancelled = value;
    },
  };
}

test("shortcut dispatches the command rather than sending model input", () => {
  const h = harness();
  h.shortcut();
  assert.deepEqual(h.sent, [["/undo", { expandPromptTemplates: true }]]);
});

test("undo aborts, waits, and rewinds before the latest user without a summary", async () => {
  const h = harness();
  h.idle = async () => assert.equal(h.aborts, 1);
  await h.run();
  assert.deepEqual(h.navigations, [["user", { summarize: false }]]);
  assert.equal(h.editor, "fix teh bug");
  assert.deepEqual(h.branch, []);
});

test("queued text and an existing draft follow the restored prompt", async () => {
  const h = harness();
  h.editor = "also add a test";
  h.queued = ["queued correction"];
  await h.run();
  assert.equal(h.editor, "fix teh bug\nqueued correction\n\nalso add a test");
});

test("drafts written while abort or navigation settles are preserved", async () => {
  const h = harness();
  h.idle = async () => {
    h.editor = "during abort";
  };
  h.beforeNavigate = () => {
    h.editor += " and navigation";
  };
  await h.run();
  assert.equal(h.editor, "fix teh bug\nduring abort and navigation");
});

test("a user message at the leaf gets an anchor so Pi does not skip navigation", async () => {
  const h = harness();
  h.branch = [h.user];
  await h.run();
  assert.deepEqual(h.anchors, ["pi-undo-anchor"]);
  assert.deepEqual(h.branch, []);
  assert.equal(h.editor, "fix teh bug");
});

test("cancellation leaves the editor and active branch unchanged", async () => {
  const h = harness();
  h.editor = "draft";
  h.cancelled = true;
  await h.run();
  assert.equal(h.editor, "draft");
  assert.equal(h.branch.at(-1)?.id, "reply");
});

test("image prompts restore only text, without a warning", async () => {
  const h = harness();
  h.user.message.content.push({ type: "image", data: "image", mimeType: "image/png" } as never);
  await h.run();
  assert.equal(h.editor, "fix teh bug");
  assert.deepEqual(h.notices, []);
});

test("session switches and newly sent prompts cancel a pending undo", async () => {
  for (const change of ["session", "prompt"]) {
    const h = harness();
    h.idle = async () => {
      if (change === "session") h.sessionId = "other";
      else h.branch = [...h.branch, { ...h.user, id: "new-user" }];
    };
    await h.run();
    assert.deepEqual(h.navigations, []);
    assert.match(h.notices[0] ?? "", /conversation changed/);
  }
});

test("concurrent undo calls are ignored until the first finishes", async () => {
  const h = harness();
  let release: () => void = () => {};
  h.idle = () => new Promise<void>((resolve) => (release = resolve));
  const first = h.run();
  await h.run();
  assert.equal(h.aborts, 1);
  release();
  await first;
  assert.equal(h.navigations.length, 1);
});

test("errors are reported and do not leave undo locked", async () => {
  const h = harness();
  h.idle = async () => {
    throw new Error("busy");
  };
  await h.run();
  assert.match(h.notices[0] ?? "", /Undo failed: busy/);
  h.idle = async () => {};
  await h.run();
  assert.equal(h.editor, "fix teh bug");
});

test("empty sessions and noninteractive contexts are left untouched", async () => {
  const h = harness();
  h.branch = [];
  await h.run();
  h.ctx.hasUI = false;
  await h.run();
  assert.equal(h.aborts, 0);
  assert.deepEqual(h.navigations, []);
  assert.equal(h.notices.length, 2);
});
