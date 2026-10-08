import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import type {
  ExtensionCommandContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  confirmFinish,
  createFinishDialog,
  type FinishDialogProposal,
} from "../src/finish-dialog.ts";
import { createCustomSelectorHarness } from "./support.ts";

const inputDialog = Symbol.for("pi-extensions:input-dialog");

const proposal: FinishDialogProposal = {
  mainPath: "/main",
  worktreePath: "/feature",
  ignored: ["!! extensions/pi-cmux/node_modules/"],
  branch: "feat/pi-cmux",
  tip: "a".repeat(40),
  merged: true,
  risk: [],
};

function dialogFor(details = proposal, rows = 24) {
  return createFinishDialog(
    details,
    () => {},
    () => {},
    (_role, text) => text,
    () => rows,
  );
}

test("finish matches the compact layout without routine verification text", () => {
  const lines = dialogFor().render(100);
  assert.deepEqual(lines, [
    "Finish worktree · feat/pi-cmux",
    "",
    "Remove   /feature",
    "Return   /main",
    "",
    "[x] Delete branch feat/pi-cmux (merged)",
    "",
    "Ignored to delete:",
    "  extensions/pi-cmux/node_modules/",
    "",
    "Enter finish · Esc cancel · Space toggle branch · ↑/↓ scroll",
  ]);
  assert.ok(!lines.join("\n").includes(proposal.tip ?? ""));
  assert.ok(lines.length <= 24);
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
});

test("branch deletion shows exactly one warning with the actual commit count", () => {
  const roles: string[] = [];
  const dialog = createFinishDialog(
    { ...proposal, risk: Array.from({ length: 6 }, () => "b".repeat(40)) },
    () => {},
    () => {},
    (role, text) => {
      if (text.startsWith("Warning:")) roles.push(role);
      return text;
    },
    () => 24,
  );
  const lines = dialog.render(100);
  assert.deepEqual(
    lines.filter((line) => line.startsWith("Warning:")),
    ["Warning: 6 commits are not reachable from other branches/tags."],
  );
  assert.deepEqual(roles, ["warning"]);
  assert.doesNotMatch(lines.join("\n"), /Branch tip:|DATA LOSS|DATA-LOSS|[ab]{40}/);
});

test("an unverified merge with no at-risk commits has no branch warning", () => {
  const dialog = dialogFor({ ...proposal, merged: false });
  assert.match(dialog.render(100).join("\n"), /\[ \] Delete branch.*merge unverified/);
  dialog.handleInput(" ");
  assert.match(dialog.render(100).join("\n"), /\[x\] Delete branch/);
  assert.doesNotMatch(dialog.render(100).join("\n"), /Warning:|Branch tip:|DATA LOSS|DATA-LOSS/);
});

test("home-relative paths stay explicit without shortening unrelated prefixes", () => {
  const home = homedir();
  const text = dialogFor({
    ...proposal,
    mainPath: `${home}/.pi/pi-extensions`,
    worktreePath: `${home}-other/feature`,
  })
    .render(120)
    .join("\n");
  assert.ok(text.includes("Return   ~/.pi/pi-extensions"));
  assert.ok(text.includes(`Remove   ${home}-other/feature`));
});

test("untrusted control characters cannot create new sections or erase layout breaks", () => {
  const lines = dialogFor({
    ...proposal,
    mainPath: "/ma\u0000in\n",
    worktreePath: "/fea\u0007ture\t",
    branch: "feat/pi-\u001bcmux\n",
    tip: `${"a".repeat(8)}\u0007${"a".repeat(32)}`,
    ignored: ["!! node_modules/\nBRANCH\u0007"],
  }).render(100);
  assert.ok(lines.includes("Return   /main"));
  assert.ok(lines.includes("Remove   /feature"));
  assert.ok(lines.includes("[x] Delete branch feat/pi-cmux (merged)"));
  assert.ok(lines.includes("  node_modules/BRANCH"));
  assert.equal(lines.filter((line) => line === "BRANCH").length, 0);
  assert.ok(
    lines.every((line) =>
      [...line].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 0x1f && (code < 0x7f || code > 0x9f);
      }),
    ),
  );
});

test("keeping an uncertain branch hides deletion warnings until it is selected", () => {
  let choice: boolean | undefined;
  const dialog = createFinishDialog(
    { ...proposal, merged: false, risk: ["b".repeat(40)] },
    (value) => {
      choice = value;
    },
    () => {},
    (_role, text) => text,
    () => 24,
  );
  assert.match(dialog.render(100).join("\n"), /\[ \] Delete branch/);
  assert.doesNotMatch(dialog.render(100).join("\n"), /Warning:|DATA LOSS|DATA-LOSS/);
  dialog.handleInput(" ");
  const selected = dialog.render(100).join("\n");
  assert.match(selected, /\[x\] Delete branch/);
  assert.ok(selected.includes("Warning: 1 commit is not reachable from other branches/tags."));
  assert.doesNotMatch(selected, /Branch tip:|DATA LOSS|DATA-LOSS|b{40}/);
  dialog.handleInput(" ");
  assert.doesNotMatch(dialog.render(100).join("\n"), /Warning:/);
  dialog.handleInput(" ");
  dialog.handleInput("\r");
  assert.equal(choice, true);
});

test("worktree recovery loss stays pinned even when the branch is retained", () => {
  const recoveryWarning =
    "Administrative recovery warning: HEAD reflog commits may later be garbage-collected.";
  for (const rows of [8, 24]) {
    const dialog = dialogFor(
      {
        ...proposal,
        merged: false,
        ignored: Array.from({ length: 30 }, (_, index) => `!! ignored-${index}/`),
        recoveryWarning,
      },
      rows,
    );
    assert.match(dialog.render(100).join("\n"), /DATA LOSS: worktree removal/);
    for (let index = 0; index < 100; index++) dialog.handleInput("\u001b[B");
    const lines = dialog.render(100);
    assert.match(lines.join("\n"), /DATA LOSS: worktree removal/);
    assert.ok(lines.length <= rows);
  }
});

test("short terminals keep all cleanup evidence reachable while pinning loss warnings", () => {
  const recoveryTip = "c".repeat(40);
  for (const rows of [3, 4, 5]) {
    const dialog = dialogFor(
      {
        ...proposal,
        risk: ["b".repeat(40)],
        recoveryWarning: `Administrative recovery warning: HEAD reflog: ${recoveryTip}`,
      },
      rows,
    );
    const reviewed: string[] = [];
    for (let index = 0; index < 80; index++) {
      const lines = dialog.render(100);
      assert.ok(lines.length <= rows);
      assert.ok(lines.every((line) => visibleWidth(line) <= 100));
      if (rows >= 4) assert.equal(lines.at(-2), "");
      assert.match(lines.join("\n"), /DATA LOSS/);
      assert.match(lines.join("\n"), /\[x\] Delete branch/);
      reviewed.push(...lines);
      dialog.handleInput("\u001b[B");
    }
    const text = reviewed.join("\n");
    assert.ok(text.includes("Return   /main"));
    assert.ok(text.includes("Remove   /feature"));
    assert.ok(text.includes("Ignored to delete:"));
    assert.ok(text.includes("extensions/pi-cmux/node_modules/"));
    assert.ok(text.includes(recoveryTip));
    assert.ok(text.includes("Warning: 1 commit is not reachable from other branches/tags."));
    assert.ok(!text.includes("b".repeat(40)));
  }
});

test("detached worktrees have no branch toggle or branch deletion warning", () => {
  const dialog = dialogFor({ ...proposal, branch: undefined, ignored: [] });
  const before = dialog.render(100).join("\n");
  assert.match(before, /No branch will be deleted/);
  assert.ok(!before.includes("Ignored to delete:"));
  assert.doesNotMatch(before, /Delete branch|DATA LOSS|DATA-LOSS/);
  dialog.handleInput(" ");
  assert.equal(dialog.render(100).join("\n"), before);
});

test("RPC approval keeps structured line breaks and a single branch warning", async () => {
  let title = "";
  const ctx = {
    mode: "rpc",
    ui: {
      async select(text: string, choices: string[], options?: ExtensionUIDialogOptions) {
        assert.equal(Reflect.get(options ?? {}, inputDialog), false);
        title = text;
        assert.match(choices[0] ?? "", /KEEP branch/);
        return choices[0];
      },
    },
  } as unknown as ExtensionCommandContext;
  assert.equal(
    await confirmFinish(ctx, { ...proposal, merged: false, risk: ["b".repeat(40)] }, false),
    false,
  );
  assert.ok(title.includes("Remove   /feature\nReturn   /main"));
  assert.ok(title.includes("Ignored to delete:\n  extensions/pi-cmux/node_modules/"));
  assert.doesNotMatch(title, /VERIFICATION|Main checkout HEAD|conversation/);
  assert.ok(title.includes("Warning: 1 commit is not reachable from other branches/tags."));
  assert.equal(title.match(/Warning:/g)?.length, 1);
  assert.doesNotMatch(title, /Branch tip:|DATA LOSS|DATA-LOSS|[ab]{40}/);
});

test("finish marks only agent factories and preserves branch choices and cancellation", async () => {
  for (const agent of [true, false]) {
    const ctx = {
      mode: "tui",
      ui: {
        async custom(factory: unknown, options?: unknown) {
          assert.equal(typeof factory, "function");
          assert.equal(Reflect.get(factory as object, inputDialog), agent ? true : undefined);
          assert.equal(options, undefined);
          const dialog = createCustomSelectorHarness(factory);
          assert.match(dialog.render().join("\n"), /\[x\] Delete branch/);
          dialog.handleInput(" ");
          dialog.handleInput(agent ? "\r" : "\u001b");
          return dialog.result;
        },
      },
    } as unknown as ExtensionCommandContext;
    assert.equal(await confirmFinish(ctx, proposal, agent), agent ? false : undefined);
  }
});

test("agent native finish remains tracked with unchanged deletion and cancellation results", async () => {
  for (const cancel of [false, true]) {
    const ctx = {
      mode: "rpc",
      ui: {
        async select(_title: string, choices: string[], options?: ExtensionUIDialogOptions) {
          assert.equal(options, undefined);
          return cancel ? undefined : choices[0];
        },
      },
    } as unknown as ExtensionCommandContext;
    assert.equal(await confirmFinish(ctx, proposal, true), cancel ? undefined : true);
  }
});

for (const merged of [false, true]) {
  test(`large branch histories show only a count with merged=${merged}`, () => {
    const dialog = createFinishDialog(
      {
        ...proposal,
        branch: "feat/large-history",
        tip: "a".repeat(40),
        merged,
        risk: Array.from({ length: 100 }, (_, index) => index.toString(16).padStart(40, "0")),
      },
      () => {},
      () => {},
      (_role, text) => text,
      () => 24,
    );
    if (!merged) dialog.handleInput(" ");
    const first = dialog.render(80);
    assert.ok(first.length <= 24);
    assert.ok(
      first.join("\n").includes("Warning: 100 commits are not reachable from other branches/tags."),
    );
    assert.equal(first.filter((line) => line.startsWith("Warning:")).length, 1);
    assert.doesNotMatch(first.join("\n"), /Branch tip:|DATA LOSS|DATA-LOSS|[a-f0-9]{40}/);
    assert.ok(first.every((line) => visibleWidth(line) <= 80));
    for (let index = 0; index < 200; index++) dialog.handleInput("\u001b[B");
    const last = dialog.render(80);
    assert.ok(last.length <= 24);
    assert.ok(last.join("\n").includes("Remove   /feature\nReturn   /main"));
    assert.ok(
      last.join("\n").includes("Warning: 100 commits are not reachable from other branches/tags."),
    );
    for (const width of [1, 8, 20, 42, 80]) {
      const lines = dialog.render(width);
      assert.ok(lines.length <= 24);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  });
}
