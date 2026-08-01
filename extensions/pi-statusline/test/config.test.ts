import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../src/config.ts";
import { defaultConfig } from "../src/defaults.ts";
import {
  ITEM_COLORS,
  type SepItemConfig,
  type SlotItemConfig,
  type TextItemConfig,
} from "../src/types.ts";

test("the default layout survives a validation round-trip", () => {
  const { config, warnings } = validateConfig(JSON.parse(JSON.stringify(defaultConfig())));
  assert.deepEqual(warnings, []);
  assert.deepEqual(config, defaultConfig());
});

test("a non-object root falls back to defaults", () => {
  const { config, warnings } = validateConfig("nonsense");
  assert.deepEqual(config, defaultConfig());
  assert.equal(warnings.length, 1);
});

test("missing lines falls back to the default layout", () => {
  const { config, warnings } = validateConfig({ version: 1 });
  assert.deepEqual(config.lines, defaultConfig().lines);
  assert.match(warnings.join(" "), /lines/);
});

test("unknown item types are dropped with a warning, keeping the rest", () => {
  const { config, warnings } = validateConfig({
    lines: [[{ type: "cwd" }, { type: "nope" }, { type: "model" }]],
  });
  assert.deepEqual(
    config.lines[0]?.map((item) => item.type),
    ["cwd", "model"],
  );
  assert.match(warnings.join(" "), /unknown type/);
});

test("bare strings are accepted as item shorthand", () => {
  const { config } = validateConfig({ lines: [["cwd", "split", "model"]] });
  assert.deepEqual(
    config.lines[0]?.map((item) => item.type),
    ["cwd", "split", "model"],
  );
});

test("items missing a required field are dropped", () => {
  const { config, warnings } = validateConfig({
    lines: [[{ type: "slot" }, { type: "text" }, { type: "slot", id: "usage" }]],
  });
  assert.deepEqual(
    config.lines[0]?.map((item) => item.type),
    ["slot"],
  );
  assert.equal((config.lines[0]?.[0] as SlotItemConfig | undefined)?.id, "usage");
  assert.equal(warnings.length, 2);
});

test("unknown item options are stripped but the item is kept", () => {
  const { config } = validateConfig({
    lines: [[{ type: "cwd", style: "basename", bogus: 1, priority: 70, color: "accent" }]],
  });
  assert.deepEqual(config.lines[0]?.[0], {
    type: "cwd",
    color: "accent",
    priority: 70,
    style: "basename",
  });
});

test("context toggles survive a round-trip, non-booleans dropped", () => {
  const { config } = validateConfig({
    lines: [[{ type: "context", hideWhenZero: true, showTokens: "yes" }]],
  });
  assert.deepEqual(config.lines[0]?.[0], { type: "context", hideWhenZero: true });
});

test("invalid enum values fall back to the item default", () => {
  const { config } = validateConfig({ lines: [[{ type: "cwd", style: "sideways" }]] });
  assert.deepEqual(config.lines[0]?.[0], { type: "cwd" });
});

test("an empty separator string is preserved", () => {
  const { config } = validateConfig({ lines: [[{ type: "sep", text: "" }]] });
  assert.equal((config.lines[0]?.[0] as SepItemConfig | undefined)?.text, "");
});

test("groupGap is clamped to a sane range", () => {
  assert.equal(validateConfig({ groupGap: -5, lines: [] }).config.groupGap, 0);
  assert.equal(validateConfig({ groupGap: 999, lines: [] }).config.groupGap, 40);
  assert.equal(validateConfig({ groupGap: "two", lines: [] }).config.groupGap, 2);
});

test("a non-array line is skipped without losing the others", () => {
  const { config, warnings } = validateConfig({ lines: [{ type: "cwd" }, [{ type: "model" }]] });
  assert.equal(config.lines.length, 1);
  assert.equal(config.lines[0]?.[0]?.type, "model");
  assert.match(warnings.join(" "), /line 1/);
});

test("text items keep their literal text", () => {
  const { config } = validateConfig({ lines: [[{ type: "text", text: "on branch" }]] });
  assert.equal((config.lines[0]?.[0] as TextItemConfig | undefined)?.text, "on branch");
});

test("an unknown color is dropped with a warning, keeping the item", () => {
  // `theme.fg` throws on a color pi does not define, and the footer's render is
  // fatal, so this may never reach the renderer.
  const { config, warnings } = validateConfig({
    lines: [[{ type: "cwd", color: "bright-purple" }]],
  });
  assert.deepEqual(config.lines[0]?.[0], { type: "cwd" });
  assert.match(warnings.join(" "), /unknown color/);
});

test("every documented color is accepted, as is auto", () => {
  for (const color of [...ITEM_COLORS, "auto"]) {
    const { config, warnings } = validateConfig({ lines: [[{ type: "cwd", color }]] });
    assert.deepEqual(warnings, [], `${color} should be accepted`);
    assert.equal((config.lines[0]?.[0] as { color?: string } | undefined)?.color, color);
  }
});

test("control characters are stripped from literals, padding and all else kept", () => {
  const { config } = validateConfig({
    lines: [
      [
        { type: "text", text: "a\nb" },
        { type: "sep", text: " • " },
        { type: "cwd", prefix: " (", suffix: ")\r\n" },
      ],
    ],
  });
  // A newline measures as zero columns, so it would slip past every width check
  // and then desync pi's line accounting.
  assert.equal((config.lines[0]?.[0] as TextItemConfig | undefined)?.text, "ab");
  // Spacing is the point of a separator, so it survives untouched.
  assert.equal((config.lines[0]?.[1] as SepItemConfig | undefined)?.text, " • ");
  assert.deepEqual(config.lines[0]?.[2], { type: "cwd", prefix: " (", suffix: ")" });
});

test("decoration on a separator is dropped with a warning", () => {
  const { config, warnings } = validateConfig({
    lines: [[{ type: "sep", text: " • ", icon: "x", prefix: "[", suffix: "]", bold: true }]],
  });
  // The renderer emits a separator's text verbatim, so these would do nothing.
  assert.deepEqual(config.lines[0]?.[0], { type: "sep", text: " • ", bold: true });
  assert.match(warnings.join(" "), /separator; icon, prefix, suffix ignored/);
});
