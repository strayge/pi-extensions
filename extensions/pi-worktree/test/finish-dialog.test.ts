import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  confirmFinish,
  createFinishDialog,
  type FinishDialogProposal,
} from "../src/finish-dialog.ts";

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
  assert.doesNotMatch(dialog.render(100).join("\n"), /DATA LOSS|DATA-LOSS/);
  dialog.handleInput(" ");
  assert.match(dialog.render(100).join("\n"), /\[x\] Delete branch/);
  assert.match(dialog.render(100).join("\n"), /DATA LOSS/);
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
    assert.ok(text.includes("b".repeat(40)));
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

test("RPC approval keeps structured line breaks and full deletion evidence", async () => {
  let title = "";
  const ctx = {
    mode: "rpc",
    ui: {
      async select(text: string, choices: string[]) {
        title = text;
        assert.match(choices[0] ?? "", /KEEP branch/);
        return choices[0];
      },
    },
  } as unknown as ExtensionCommandContext;
  assert.equal(await confirmFinish(ctx, { ...proposal, merged: false }), false);
  assert.ok(title.includes("Remove   /feature\nReturn   /main"));
  assert.ok(title.includes("Ignored to delete:\n  extensions/pi-cmux/node_modules/"));
  assert.doesNotMatch(title, /VERIFICATION|Main checkout HEAD|conversation/);
  assert.ok(title.includes(`Branch tip: ${proposal.tip}`));
  assert.match(title, /DATA-LOSS WARNING/);
});

for (const merged of [false, true]) {
  test(`large recovery warnings remain scrollable with merged=${merged}`, () => {
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
    assert.match(first.join("\n"), /DATA LOSS/);
    assert.ok(first.every((line) => visibleWidth(line) <= 80));
    for (let index = 0; index < 200; index++) dialog.handleInput("\u001b[B");
    const last = dialog.render(80);
    assert.ok(last.length <= 24);
    assert.ok(last.join("\n").includes("Remove   /feature\nReturn   /main"));
    assert.match(last.join("\n"), /0000000000000000000000000000000000000063/);
    assert.match(last.join("\n"), /DATA LOSS/);
    for (const width of [1, 8, 20, 42, 80]) {
      const lines = dialog.render(width);
      assert.ok(lines.length <= 24);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  });
}
