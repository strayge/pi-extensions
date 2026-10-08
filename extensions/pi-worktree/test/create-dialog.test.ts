import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import type {
  ExtensionCommandContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  type CreateDialogProposal,
  confirmCreate,
  createWorktreeDialog,
} from "../src/create-dialog.ts";
import { createCustomSelectorHarness } from "./support.ts";

const inputDialog = Symbol.for("pi-extensions:input-dialog");

const proposal: CreateDialogProposal = {
  branch: "feat/example",
  base: { kind: "current-branch", label: "main", oid: `cdccf18b${"a".repeat(32)}` },
  path: "/worktrees/feat-example",
};

function dialogFor(details = proposal, rows = 24) {
  return createWorktreeDialog(
    details,
    () => {},
    () => {},
    (_role, text) => text,
    () => rows,
  );
}

test("create matches the compact layout without explanatory text or extra details", () => {
  const dialog = dialogFor();
  const lines = dialog.render(100);
  assert.deepEqual(lines, [
    "Create worktree · feat/example",
    "",
    "Branch   feat/example (new)",
    "Base     main · cdccf18b",
    "Path     /worktrees/feat-example",
    "",
    "Enter create & switch · Esc cancel · ↑/↓ scroll",
  ]);
  assert.ok(!lines.join("\n").includes(proposal.base.oid));
  dialog.handleInput("d");
  assert.deepEqual(dialog.render(100), lines);
});

for (const kind of ["existing-local-branch", "explicit-commit-ish"] as const) {
  test(`create accurately identifies ${kind} provenance`, () => {
    const existing = kind === "existing-local-branch";
    const text = dialogFor({
      ...proposal,
      base: { ...proposal.base, kind, label: existing ? proposal.branch : "origin/release" },
    })
      .render(100)
      .join("\n");
    assert.ok(text.includes(`Branch   feat/example (${existing ? "existing" : "new"})`));
    assert.ok(
      text.includes(
        existing ? "Base     feat/example · cdccf18b" : "Base     origin/release · cdccf18b",
      ),
    );
    assert.doesNotMatch(text, /New local branch|Current branch main/);
  });
}

test("create abbreviates home paths and escapes controls without concealing unusual filenames", () => {
  const text = dialogFor({
    ...proposal,
    base: { ...proposal.base, label: "main\u009b2J" },
    path: `${homedir()}/.worktrees/odd\n path`,
  })
    .render(100)
    .join("\n");
  assert.ok(text.includes('Base     "main\\u009b2J" · cdccf18b'));
  assert.ok(text.includes('Path     "~/.worktrees/odd\\u000a path"'));
  assert.ok(!text.includes("\u009b"));
  assert.equal(text.split("\n").filter((line) => line.startsWith("Path")).length, 1);
});

test("create approval and cancellation use the displayed keys", () => {
  const choices: boolean[] = [];
  const dialog = createWorktreeDialog(
    proposal,
    (choice) => choices.push(choice),
    () => {},
    (_role, text) => text,
    () => 24,
  );
  dialog.handleInput("\r");
  dialog.handleInput("\u001b");
  dialog.handleInput("\u0003");
  assert.deepEqual(choices, [true, false, false]);
});

test("long paths remain reviewable on short terminals and every rendered line fits", () => {
  const details = {
    ...proposal,
    branch: `feat/${"界".repeat(40)}`,
    path: `/worktrees/${"界/subdirectory/".repeat(25)}destination-end`,
  };
  for (const rows of [3, 5, 24]) {
    const dialog = dialogFor(details, rows);
    const reviewed: string[] = [];
    for (let index = 0; index < 100; index++) {
      const lines = dialog.render(80);
      assert.ok(lines.length <= rows);
      assert.ok(lines.every((line) => visibleWidth(line) <= 80));
      if (rows >= 4) assert.equal(lines.at(-2), "");
      reviewed.push(...lines);
      dialog.handleInput("\u001b[B");
    }
    const text = reviewed.join("\n");
    assert.ok(text.includes("destination-end"));
    assert.ok(text.includes("Base     main · cdccf18b"));
    for (const width of [0, 1, 8, 20, 42, 80]) {
      const lines = dialog.render(width);
      assert.ok(lines.length <= rows);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  }
});

test("RPC create uses one confirmation with full commit evidence and structured facts", async () => {
  const confirmations: Array<{
    title: string;
    message: string;
    options?: ExtensionUIDialogOptions;
  }> = [];
  const ctx = {
    mode: "rpc",
    ui: {
      async confirm(title: string, message: string, options?: ExtensionUIDialogOptions) {
        confirmations.push({ title, message, options });
        return true;
      },
    },
  } as unknown as ExtensionCommandContext;
  assert.equal(await confirmCreate(ctx, proposal, false), true);
  assert.equal(Reflect.get(confirmations[0]?.options ?? {}, inputDialog), false);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0]?.title, "Create worktree · feat/example");
  assert.ok(confirmations[0]?.message.includes(`Base     main · ${proposal.base.oid}`));
  assert.ok(confirmations[0]?.message.includes("Branch   feat/example (new)\nBase"));
  assert.doesNotMatch(confirmations[0]?.message ?? "", /conversation|copied|Current branch/);
});

test("create marks only agent factories and preserves the custom decision", async () => {
  for (const agent of [true, false]) {
    const ctx = {
      mode: "tui",
      ui: {
        async custom(factory: unknown, options?: unknown) {
          assert.equal(typeof factory, "function");
          assert.equal(Reflect.get(factory as object, inputDialog), agent ? true : undefined);
          assert.equal(options, undefined);
          const dialog = createCustomSelectorHarness(factory);
          assert.match(dialog.render().join("\n"), /Base {5}main · cdccf18b/);
          dialog.handleInput(agent ? "\r" : "\u001b");
          return dialog.result;
        },
      },
    } as unknown as ExtensionCommandContext;
    assert.equal(await confirmCreate(ctx, proposal, agent), agent);
  }
});

test("agent native create remains tracked and preserves rejection", async () => {
  const failure = new Error("confirmation failed");
  const ctx = {
    mode: "rpc",
    ui: {
      async confirm(_title: string, _message: string, options?: ExtensionUIDialogOptions) {
        assert.equal(options, undefined);
        throw failure;
      },
    },
  } as unknown as ExtensionCommandContext;
  await assert.rejects(confirmCreate(ctx, proposal, true), (error) => error === failure);
});
