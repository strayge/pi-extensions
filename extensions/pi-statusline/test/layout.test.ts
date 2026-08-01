import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isBlankLine, type LayoutCell, layoutLine } from "../src/layout.ts";

function item(key: string, text: string, priority = 50): LayoutCell {
  return { key, text, styled: text, kind: "item", priority };
}

function sep(text = " "): LayoutCell {
  return { key: "sep", text, styled: text, kind: "sep", priority: 0 };
}

function split(): LayoutCell {
  return { key: "split", text: "", styled: "", kind: "split", priority: 0 };
}

test("joins items and separators in order", () => {
  const cells = [item("cwd", "~/work"), sep(" • "), item("session", "demo")];
  assert.equal(layoutLine(cells, 40, 2), "~/work • demo");
});

test("drops separators around empty values", () => {
  const cells = [item("cwd", "~/work"), sep(" • "), item("session", "")];
  assert.equal(layoutLine(cells, 40, 2), "~/work");
});

test("drops leading separators and collapses runs", () => {
  const cells = [sep(" "), item("a", ""), sep(" • "), sep(" • "), item("b", "b")];
  assert.equal(layoutLine(cells, 40, 2), "b");
});

test("right-aligns the group after a split", () => {
  const cells = [item("left", "abc"), split(), item("right", "xyz")];
  assert.equal(layoutLine(cells, 10, 2), "abc    xyz");
});

test("keeps the configured gap between groups", () => {
  const cells = [item("left", "abcd"), split(), item("right", "wxyz")];
  assert.equal(layoutLine(cells, 10, 2), "abcd  wxyz");
});

test("sheds rather than shrinking the gap below its minimum", () => {
  const cells = [item("left", "abcd"), split(), item("right", "wxyz")];
  assert.equal(layoutLine(cells, 9, 2), "abcd");
});

test("a lower-priority left group loses to the right group", () => {
  const cells = [item("left", "abcd", 10), split(), item("right", "wxyz", 90)];
  assert.equal(layoutLine(cells, 9, 2), "     wxyz");
});

test("supports a center group with two splits", () => {
  const cells = [item("l", "L"), split(), item("c", "C"), split(), item("r", "R")];
  const line = layoutLine(cells, 21, 2);
  assert.equal(line.trimEnd().endsWith("R"), true);
  assert.equal(line.startsWith("L"), true);
  assert.equal(line.indexOf("C"), 10);
});

test("sheds the lowest priority item first", () => {
  const cells = [
    item("keep", "KEEP", 90),
    sep(),
    item("drop", "DROP", 10),
    sep(),
    item("mid", "MID", 50),
  ];
  assert.equal(layoutLine(cells, 9, 2), "KEEP MID");
});

test("sheds equal priorities from the right", () => {
  const cells = [item("a", "AAA"), sep(), item("b", "BBB"), sep(), item("c", "CCC")];
  assert.equal(layoutLine(cells, 8, 2), "AAA BBB");
});

test("truncates rather than dropping the last item standing", () => {
  const cells = [item("cwd", "~/a/very/long/path/indeed", 99)];
  const line = layoutLine(cells, 10, 2);
  assert.equal(visibleWidth(line), 10);
  assert.equal(line.includes("…"), true);
});

test("shedding re-collapses orphaned separators", () => {
  const cells = [item("a", "AAAA", 90), sep(" • "), item("b", "BBBB", 10)];
  assert.equal(layoutLine(cells, 6, 2), "AAAA");
});

test("zero width renders nothing", () => {
  assert.equal(layoutLine([item("a", "A")], 0, 2), "");
});

test("isBlankLine sees through separators and splits", () => {
  assert.equal(isBlankLine([sep(" • "), split(), sep()]), true);
  assert.equal(isBlankLine([item("a", ""), sep(), item("b", "")]), true);
  assert.equal(isBlankLine([item("a", ""), sep(), item("b", "x")]), false);
});
