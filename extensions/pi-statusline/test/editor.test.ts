import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { validateConfig } from "../src/config.ts";
import { defaultConfig } from "../src/defaults.ts";
import {
  type EditorDeps,
  type EditorResult,
  hintLines,
  LayoutEditor,
  windowChips,
} from "../src/editor.ts";
import { createRuntime } from "../src/runtime.ts";
import { ITEM_TYPES, type StatuslineConfig } from "../src/types.ts";
import { createRegistry, type FakeOptions, fakeEnv, identityTheme, publish } from "./helpers.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_LEFT = "\x1b[1;5D";
const CTRL_RIGHT = "\x1b[1;5C";
const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";
const DELETE = "\x1b[3~";

interface Harness {
  editor: LayoutEditor;
  press: (...keys: string[]) => void;
  result: () => StatuslineConfig | undefined | "open";
  /** What the save reported back, e.g. an item validation had to drop. */
  warnings: () => string[];
}

/** `live` supplies footer data, which is what the preview needs to render. */
function harness(
  config: StatuslineConfig = defaultConfig(),
  live = false,
  options: FakeOptions = {},
): Harness {
  let saved: EditorResult | undefined | "open" = "open";
  const env = fakeEnv(options);

  const deps: EditorDeps = {
    getConfig: () => config,
    setConfig: () => {},
    slots: env.slots,
    runtime: createRuntime(),
    getFooterData: () => (live ? env.footerData : undefined),
  };

  const editor = new LayoutEditor(
    { requestRender: () => {} } as unknown as TUI,
    identityTheme(),
    { matches: () => false } as unknown as KeybindingsManager,
    env.ctx as unknown as ExtensionCommandContext,
    deps,
    (value) => {
      saved = value;
    },
  );

  return {
    editor,
    press: (...keys) => {
      for (const key of keys) editor.handleInput(key);
    },
    result: () => (saved === "open" ? "open" : saved?.config),
    warnings: () => (saved === "open" ? [] : (saved?.warnings ?? [])),
  };
}

/** Item types per line, which is what the editor is really manipulating. */
function shape(config: StatuslineConfig): string[][] {
  return config.lines.map((line) => line.map((item) => item.type));
}

test("renders without a preview when no footer is installed", () => {
  const { editor } = harness();
  const lines = editor.render(80);
  assert.equal(
    lines.some((line) => line.includes("(preview unavailable)")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("cwd")),
    true,
  );
});

test("saving returns the edited layout", () => {
  const { press, result } = harness();
  press("w");
  assert.deepEqual(shape(result() as StatuslineConfig), shape(defaultConfig()));
});

test("escape discards the edits", () => {
  const { press, result } = harness();
  press("d", ESC);
  assert.equal(result(), undefined);
});

test("the context item exposes every part of its meter", () => {
  const start = validateConfig({ lines: [[{ type: "context" }]] }).config;
  const { editor, press } = harness(start, true, {
    contextPercent: 51.1,
    contextWindow: 272_000,
    contextTokens: 139_000,
  });

  press(ENTER);
  const fields = editor.render(80).join("\n");
  for (const label of [
    "show bar",
    "show gauge",
    "show percent",
    "show tokens",
    "show window",
    "percent after window",
    "percent in parentheses",
    "bar width",
    "window separator",
    "threshold colors",
    "hide when zero",
  ]) {
    assert.equal(fields.includes(label), true, `missing field: ${label}`);
  }

  // Toggling the first field feeds straight back into the live preview.
  press(ENTER);
  const preview = editor.render(80).join("\n");
  assert.equal(preview.includes("[████░░░░] 51.1%/272k"), true);
});

test("the candidate item shows in the preview before it is confirmed", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { editor, press } = harness(start, true);

  // Everything above the catalog: the rendered preview and the chip rows. The
  // catalog itself is excluded, since its hints legitimately show values too.
  const above = (width = 80) => {
    const lines = editor.render(width);
    const catalog = lines.findIndex((line) => line.includes("add item:"));
    return catalog < 0 ? lines : lines.slice(0, catalog);
  };

  assert.equal(
    above().some((line) => line.includes("π")),
    false,
  );

  press("a");
  // The catalog opens on "brand", which renders as π.
  assert.equal(
    above().some((line) => line.includes("π")),
    true,
  );
  assert.equal(
    above().some((line) => line.includes("[+brand]")),
    true,
  );

  // Moving through the catalog updates the preview with the new candidate.
  press(DOWN);
  assert.equal(
    above().some((line) => line.includes("[+cwd]")),
    true,
  );
  assert.equal(
    above().some((line) => line.includes("π")),
    false,
  );
});

test("cancelling the catalog leaves no trace of the candidate", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { editor, press, result } = harness(start, true);

  press("a", ESC, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd"]]);
  assert.equal(
    editor.render(80).some((line) => line.includes("[+")),
    false,
  );
});

test("the candidate previews at the position it would be inserted", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }, { type: "model" }]] }).config;
  const { editor, press } = harness(start, true);

  press("a");
  const atStart = editor.render(80).find((line) => line.includes("[+brand]"));
  assert.match(atStart ?? "", /cwd.*\[\+brand\].*model/);
});

test("no rendered line ever exceeds the terminal width", () => {
  // The crash this guards: the default stats line holds nineteen chips, far
  // more than fit, and pi kills the session over an overlong render.
  const { editor, press } = harness(defaultConfig(), true);

  const checkAll = (label: string) => {
    for (const width of [200, 163, 120, 80, 40, 20]) {
      for (const [index, line] of editor.render(width).entries()) {
        assert.equal(
          visibleWidth(line) <= width,
          true,
          `${label}: line ${index} is ${visibleWidth(line)} wide at width ${width}`,
        );
      }
    }
  };

  checkAll("list mode");
  press(DOWN); // the long stats line
  checkAll("long line selected");
  for (let step = 0; step < 18; step++) press(RIGHT);
  checkAll("cursor at the far end");
  press("a");
  checkAll("catalog open");
  press(ESC, ENTER);
  checkAll("options open");
  press(DOWN, ENTER);
  for (let step = 0; step < 200; step++) press("x");
  checkAll("very long text input");
});

test("the chip window keeps the focused chip visible", () => {
  const chips = Array.from({ length: 10 }, (_, index) => ({
    text: `[item${index}]`,
    styled: `[item${index}]`,
  }));

  const start = windowChips(chips, 0, 30);
  assert.equal(start.visible.includes(chips[0] as never), true);
  assert.equal(start.leading, false);
  assert.equal(start.trailing, true);

  const end = windowChips(chips, 9, 30);
  assert.equal(end.visible.includes(chips[9] as never), true);
  assert.equal(end.leading, true);
  assert.equal(end.trailing, false);
});

test("the chip window shows everything when it all fits", () => {
  const chips = [
    { text: " cwd ", styled: " cwd " },
    { text: " model ", styled: " model " },
  ];
  const view = windowChips(chips, 1, 80);

  assert.deepEqual(view.visible, chips);
  assert.equal(view.leading, false);
  assert.equal(view.trailing, false);
});

test("the chip window scrolls by the minimum needed", () => {
  const chips = Array.from({ length: 6 }, () => ({ text: "[abcd]", styled: "[abcd]" }));
  // Room for three chips plus a trailing marker.
  const first = windowChips(chips, 2, 19);
  const second = windowChips(chips, 3, 19);

  assert.equal(first.visible.length, 3);
  assert.equal(first.leading, false);
  assert.equal(second.leading, true);
  assert.equal(second.visible.at(-1), chips[3]);
});

test("a chip wider than the row is still shown, for the caller to clamp", () => {
  const chips = [{ text: "[an-extremely-long-chip]", styled: "[an-extremely-long-chip]" }];
  const view = windowChips(chips, 0, 8);
  assert.deepEqual(view.visible, chips);
});

test("hints collapse to one line when the terminal is wide enough", () => {
  const hints = ["w save", "esc discard", "enter options"];
  assert.deepEqual(hintLines(hints, 80), ["  w save   esc discard   enter options"]);
});

test("hints wrap in order, keeping the most important first", () => {
  const hints = ["w save", "esc discard", "enter options", "del delete"];
  assert.deepEqual(hintLines(hints, 30), [
    "  w save   esc discard",
    "  enter options   del delete",
  ]);
});

test("hints never exceed two lines, truncating the tail instead", () => {
  const hints = ["w save", "esc discard", "enter options", "del delete", "a add", "r reset"];
  const lines = hintLines(hints, 24);

  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal(visibleWidth(line) <= 24, true);
  assert.equal(lines[1]?.includes("…"), true);
  assert.equal(lines[0], "  w save   esc discard");
});

test("a single hint wider than the terminal is truncated, not dropped", () => {
  const lines = hintLines(["ctrl+arrows move the selected item"], 12);
  assert.equal(lines.length, 1);
  assert.equal(visibleWidth(lines[0] ?? ""), 12);
});

test("the rendered list hints fit the width at every terminal size", () => {
  const { editor } = harness();

  for (const width of [200, 80, 52, 24]) {
    const rendered = editor.render(width);
    const hints = rendered.slice(width >= 143 ? -1 : -2);
    assert.equal(hints.length, width >= 143 ? 1 : 2);
    for (const hint of hints) assert.equal(visibleWidth(hint) <= width, true);
    // Leaving the editor is the first thing offered, at any width.
    assert.equal(hints[0]?.startsWith("  w save   esc discard"), true);
  }
});

test("the catalog offers a ready-made entry per live extension, after the types", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const harnessed = harness(start, true, {
    slots: [{ id: "usage", text: "codex 59% 5h" }],
    statuses: { "github-pr": "PR #12" },
  });

  harnessed.press("a");
  // The cursor starts on the first item type, not on an extension.
  assert.equal(
    harnessed.editor
      .render(80)
      .find((row) => row.includes("▸"))
      ?.includes("brand"),
    true,
  );

  const rows = catalogRows(harnessed);
  // Both channels surface: a published slot and a plain setStatus key, sorted
  // by id and sitting at the very end of the list.
  assert.match(rows.get("slot:usage") ?? "", /codex 59% 5h/);
  assert.match(rows.get("slot:github-pr") ?? "", /PR #12/);
  assert.deepEqual([...rows.keys()].slice(-2), ["slot:github-pr", "slot:usage"]);
});

/**
 * Walk the open catalog and collect the highlighted row for every entry. Only
 * eight rows are on screen at a time, so scrolling is the only way to see them.
 */
function catalogRows(harnessed: Harness): Map<string, string> {
  const rows = new Map<string, string>();
  let previous = "";

  for (let step = 0; step < ITEM_TYPES.length + 8; step += 1) {
    const row = harnessed.editor.render(120).find((line) => line.includes("▸")) ?? "";
    if (row === previous) break;
    previous = row;
    const label =
      row
        .trim()
        .replace("▸ ", "")
        .split(/\s{2,}/)[0] ?? "";
    rows.set(label, row);
    harnessed.press(DOWN);
  }

  return rows;
}

test("built-in items preview their live value where they have one", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const harnessed = harness(start, true);
  harnessed.press("a");
  const rows = catalogRows(harnessed);

  // fakeEnv's session: /work/proj on main, gpt-5, thinking high.
  assert.match(rows.get("cwd") ?? "", /\/work\/proj/);
  assert.match(rows.get("branch") ?? "", /main/);
  assert.match(rows.get("model") ?? "", /gpt-5/);
  assert.match(rows.get("brand") ?? "", /π/);
});

test("items with nothing to say fall back to a marked example", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const harnessed = harness(start, true);
  harnessed.press("a");
  const rows = catalogRows(harnessed);

  // No session name and no tokens yet, so these cannot show a real value.
  assert.match(rows.get("session") ?? "", /ex\.: refactor-footer/);
  assert.match(rows.get("tokens_in") ?? "", /ex\.: 12k/);
});

test("structural items are described rather than sampled", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const harnessed = harness(start, true);
  harnessed.press("a");
  const rows = catalogRows(harnessed);

  assert.match(rows.get("split") ?? "", /right-aligns what follows/);
  assert.match(rows.get("sep") ?? "", /spacer between items/);
  assert.equal(rows.get("sep")?.includes("ex.:"), false);
});

test("every catalog entry explains itself", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const harnessed = harness(start, true);
  harnessed.press("a");
  const rows = catalogRows(harnessed);

  assert.equal(rows.size, ITEM_TYPES.length);
  for (const [label, row] of rows) {
    assert.equal(row.trim().length > label.length, true, `${label} has no hint`);
  }
});

test("the catalog still lists every type without a footer to preview from", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { editor, press } = harness(start);

  press("a");
  const rows = editor.render(120);
  assert.equal(
    rows.some((line) => line.includes("cwd") && line.includes("ex.: ~/project")),
    true,
  );
});

test("choosing a live extension inserts a slot bound to its id", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { editor, press, result } = harness(start, true, {
    slots: [{ id: "usage", text: "42%" }],
  });

  press("a");
  while (!(editor.render(80).find((row) => row.includes("▸")) ?? "").includes("slot:usage")) {
    press(DOWN);
  }
  press(ENTER, "w");

  assert.deepEqual((result() as StatuslineConfig).lines[0], [
    { type: "cwd" },
    { type: "slot", id: "usage" },
  ]);
});

test("an extension that is quiet right now is not offered", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { editor, press } = harness(start, true, { slots: [{ id: "usage", text: "" }] });

  press("a");
  assert.equal(
    editor.render(80).some((row) => row.includes("slot:usage")),
    false,
  );
});

test("the catalog is snapshotted so a refresh cannot shift the cursor", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const env = { slots: [{ id: "usage", text: "42%" }] };
  const { editor, press } = harness(start, true, env);

  press("a", DOWN, DOWN);
  const before = editor.render(80).find((row) => row.includes("▸"));
  // A background publish while the catalog is open must not renumber the rows.
  publish(createRegistry(), { id: "later", text: "new" });
  assert.equal(
    editor.render(80).find((row) => row.includes("▸")),
    before,
  );
});

test("enter opens the options for the selected item", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { editor, press } = harness(start);

  press(ENTER);
  assert.equal(
    editor.render(80).some((line) => line.includes("cwd options:")),
    true,
  );
});

test("the delete key removes the selected item", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }, { type: "model" }]] }).config;
  const { press, result } = harness(start);

  press(DELETE, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["model"]]);
});

test("e and d still work as fallbacks", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }, { type: "model" }]] }).config;
  const { editor, press } = harness(start);

  press("e");
  assert.equal(
    editor.render(80).some((line) => line.includes("cwd options:")),
    true,
  );

  press(ESC, "d");
  assert.equal(
    editor.render(80).some((line) => line.includes("model")),
    true,
  );
});

test("adding an item inserts it after the cursor", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }, { type: "model" }]] }).config;
  const { press, result } = harness(start);

  // "a" opens the catalog, which starts at the first type ("brand").
  press("a", ENTER, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd", "brand", "model"]]);
});

test("the catalog scrolls and cancels", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { press, result } = harness(start);

  press("a", DOWN, DOWN, ESC, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd"]]);
});

test("delete removes the selected item and keeps the cursor in range", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }, { type: "model" }]] }).config;
  const { press, result } = harness(start);

  press(RIGHT, "d", "d", "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [[]]);
});

test("< and > reorder within the line", () => {
  const start = validateConfig({
    lines: [[{ type: "cwd" }, { type: "model" }, { type: "cost" }]],
  }).config;
  const { press, result } = harness(start);

  press(RIGHT, ">", "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd", "cost", "model"]]);
});

test("ctrl+left and ctrl+right move the selected item within its line", () => {
  const start = validateConfig({
    lines: [[{ type: "cwd" }, { type: "model" }, { type: "cost" }]],
  }).config;
  const { press, result } = harness(start);

  press(RIGHT, CTRL_RIGHT, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd", "cost", "model"]]);

  const back = harness(start);
  back.press(RIGHT, RIGHT, CTRL_LEFT, CTRL_LEFT, "w");
  assert.deepEqual(shape(back.result() as StatuslineConfig), [["cost", "cwd", "model"]]);
});

test("moving stops at the ends of the line", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }, { type: "model" }]] }).config;
  const { press, result } = harness(start);

  press(CTRL_LEFT, CTRL_LEFT, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd", "model"]]);
});

test("ctrl+up and ctrl+down carry the item to the adjacent line", () => {
  const start = validateConfig({
    lines: [[{ type: "cwd" }, { type: "model" }], [{ type: "cost" }]],
  }).config;
  const { press, result } = harness(start);

  press(RIGHT, CTRL_DOWN, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd"], ["cost", "model"]]);
});

test("an item carried to a shorter line lands at its end", () => {
  const start = validateConfig({
    lines: [[{ type: "cwd" }, { type: "sep" }, { type: "model" }], []],
  }).config;
  const { press, result } = harness(start);

  press(RIGHT, RIGHT, CTRL_DOWN, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd", "sep"], ["model"]]);
});

test("the cursor follows the item it carried to another line", () => {
  const start = validateConfig({
    lines: [[{ type: "cwd" }, { type: "model" }], [{ type: "cost" }]],
  }).config;
  const { press, result } = harness(start);

  // Carry "model" down, then straight back up: it returns to where it started.
  press(RIGHT, CTRL_DOWN, CTRL_UP, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd", "model"], ["cost"]]);
});

test("carrying stops at the first and last line", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { press, result } = harness(start);

  press(CTRL_UP, CTRL_DOWN, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd"]]);
});

test("separators and splitters have their own keys", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { press, result } = harness(start);

  press(",", "s", "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd", "sep", "split"]]);
});

test("new lines are added after the current one and can be dropped", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { press, result } = harness(start);

  press("n", "a", ENTER, "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [["cwd"], ["brand"]]);

  const second = harness(start);
  second.press("n", "x", "w");
  assert.deepEqual(shape(second.result() as StatuslineConfig), [["cwd"]]);
});

test("dropping the only line leaves an empty one to work with", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { press, result } = harness(start);

  press("x", "w");
  assert.deepEqual(shape(result() as StatuslineConfig), [[]]);
});

test("reset restores the default layout", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { press, result } = harness(start);

  press("r", "w");
  assert.deepEqual(shape(result() as StatuslineConfig), shape(defaultConfig()));
});

test("boolean options toggle in place", () => {
  const start = validateConfig({ lines: [[{ type: "model" }]] }).config;
  const { press, result } = harness(start);

  // The first option for "model" is the boolean "short".
  press("e", ENTER, ESC, "w");
  const item = (result() as StatuslineConfig).lines[0]?.[0] as { short?: boolean };
  assert.equal(item.short, true);
});

test("enum options cycle and clear back to auto", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { press, result } = harness(start);

  // Fields for cwd: style, icon, prefix, suffix, color, ...
  press("e", DOWN, DOWN, DOWN, DOWN, ENTER, ESC, "w");
  const item = (result() as StatuslineConfig).lines[0]?.[0] as { color?: string };
  assert.equal(item.color, "dim");
});

test("text options are edited inline", () => {
  const start = validateConfig({ lines: [[{ type: "sep", text: " " }]] }).config;
  const { press, result } = harness(start);

  press("e", ENTER, "\x7f", " ", "•", " ", ENTER, ESC, "w");
  const item = (result() as StatuslineConfig).lines[0]?.[0] as { text?: string };
  assert.equal(item.text, " • ");
});

test("pasted text lands in the field instead of being read as escapes", () => {
  const paste = (...chunks: string[]) => {
    const start = validateConfig({ lines: [[{ type: "sep", text: " " }]] }).config;
    const { press, result } = harness(start);
    press("e", ENTER, "\x7f", ...chunks, ENTER, ESC, "w");
    const item = (result() as StatuslineConfig).lines[0]?.[0] as { text?: string } | undefined;
    return item?.text;
  };

  assert.equal(paste("\x1b[200~ | \x1b[201~"), " | ");
  // Terminals are free to split a paste across chunks.
  assert.equal(paste("\x1b[200~", " |", " ", "\x1b[201~"), " | ");
  // Newlines cannot survive in a single-line field, but the text around them does.
  assert.equal(paste("\x1b[200~a\nb\x1b[201~"), "ab");
  // Typing continues normally either side of a paste.
  assert.equal(paste("<", "\x1b[200~x\x1b[201~", ">"), "<x>");
});

test("an unterminated paste does not leave the field swallowing keys", () => {
  const start = validateConfig({ lines: [[{ type: "sep", text: " " }]] }).config;
  const { press, result } = harness(start);

  // No closing marker: the field flushes once the buffer passes its cap, so
  // Enter still commits rather than being eaten as paste content.
  press("e", ENTER, "\x7f", `\x1b[200~${"x".repeat(5000)}`, ENTER, ESC, "w");
  const item = (result() as StatuslineConfig).lines[0]?.[0] as { text?: string };
  assert.equal(item.text?.startsWith("xxxx"), true);
});

test("a non-numeric priority is rejected with a message", () => {
  const start = validateConfig({ lines: [[{ type: "cwd" }]] }).config;
  const { editor, press, result } = harness(start);

  // Last field for cwd is "priority".
  press("e", UP, ENTER, "a", "b", "c", ENTER);
  assert.equal(
    editor.render(80).some((line) => line.includes("must be a number")),
    true,
  );

  press(ESC, "w");
  const item = (result() as StatuslineConfig).lines[0]?.[0] as { priority?: number };
  assert.equal(item.priority, undefined);
});

test("a required field refuses to be cleared instead of vanishing on save", () => {
  const start = validateConfig({ lines: [[{ type: "slot", id: "usage" }]] }).config;
  const { editor, press, result } = harness(start);

  // Blanking the id would make the item invalid, and validation would drop it
  // at save time — long after the keypress that caused it.
  press("e", ENTER, "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", ENTER);
  assert.equal(
    editor.render(80).some((line) => line.includes("cannot be empty")),
    true,
  );

  press(ESC, "w");
  const item = (result() as StatuslineConfig).lines[0]?.[0] as { id?: string };
  assert.equal(item.id, "usage");
});

test("anything validation drops on save is reported rather than swallowed", () => {
  // Nothing the editor itself produces is invalid, so this reaches past it: a
  // layout mangled by hand is still normalized on the way out, and the save has
  // to say what it lost.
  const start = { version: 1, groupGap: 2, lines: [[{ type: "slot" }]] } as StatuslineConfig;
  const { press, result, warnings } = harness(start);

  press("w");
  assert.deepEqual(shape(result() as StatuslineConfig), [[]]);
  assert.match(warnings().join(" "), /slot item without "id"/);
});
