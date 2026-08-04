/**
 * The schema half of the slot protocol: registration, rendering through a
 * producer's own callback, and the option push back to it.
 *
 * `render` runs inside the paint path, where a throw is fatal and an over-wide
 * line kills the session, so most of what is asserted here is what the registry
 * refuses to pass on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildItemValue } from "../src/items.ts";
import { changedSlotOptions, slotOptionsById } from "../src/options-sync.ts";
import { renderStatusline } from "../src/render.ts";
import type { SlotOptions, StatuslineConfig } from "../src/types.ts";
import {
  busFor,
  createRegistry,
  fakeEnv,
  markupTheme,
  publish,
  register,
  unregister,
} from "./helpers.ts";

function config(lines: StatuslineConfig["lines"]): StatuslineConfig {
  return { version: 1, groupGap: 2, lines };
}

function envWith(registration: unknown, options: { preview?: boolean } = {}) {
  const registry = createRegistry();
  register(registry, registration);
  return fakeEnv({ registry, preview: options.preview });
}

function value(item: unknown, env: ReturnType<typeof fakeEnv>) {
  return buildItemValue(item as never, { ...env, placedStatusKeys: new Set() });
}

test("a registered producer renders the slot from its own callback", () => {
  const env = envWith({
    id: "usage",
    version: 1,
    fields: [{ key: "barWidth", label: "bar width", kind: "number" }],
    render: (options: SlotOptions) => `bar:${options.barWidth ?? 8}`,
  });

  assert.equal(value({ type: "slot", id: "usage" }, env)?.text, "bar:8");
  assert.equal(
    value({ type: "slot", id: "usage", options: { barWidth: 20 } }, env)?.text,
    "bar:20",
  );
});

test("two items of the same slot render with their own options", () => {
  const env = envWith({
    id: "usage",
    version: 1,
    fields: [{ key: "mode", label: "mode", kind: "enum", options: ["short", "long"] }],
    render: (options: SlotOptions) => (options.mode === "long" ? "long form" : "short"),
  });

  assert.equal(
    value({ type: "slot", id: "usage", options: { mode: "long" } }, env)?.text,
    "long form",
  );
  assert.equal(value({ type: "slot", id: "usage" }, env)?.text, "short");
});

test("render wins over the last published text, and outlives having none", () => {
  const registry = createRegistry();
  publish(registry, { id: "usage", text: "published" });
  register(registry, { id: "usage", version: 1, fields: [], render: () => "rendered" });
  const env = fakeEnv({ registry });

  assert.equal(value({ type: "slot", id: "usage" }, env)?.text, "rendered");

  unregister(registry, "usage");
  assert.equal(value({ type: "slot", id: "usage" }, env)?.text, "published");
});

test("a slot renders before anything has been published", () => {
  const env = envWith({ id: "usage", version: 1, fields: [], render: () => "42%" });
  assert.equal(value({ type: "slot", id: "usage" }, env)?.text, "42%");
});

test("a throwing render costs the slot, not the session, and is reported once", () => {
  const registry = createRegistry();
  publish(registry, { id: "usage", text: "published" });
  register(registry, {
    id: "usage",
    version: 1,
    fields: [],
    render: () => {
      throw new Error("boom");
    },
  });
  const env = fakeEnv({ registry });

  // Falls back to the published text rather than disappearing or throwing.
  assert.equal(value({ type: "slot", id: "usage" }, env)?.text, "published");
  value({ type: "slot", id: "usage" }, env);

  const failures = registry.takeRenderFailures();
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /usage.*boom/);
  assert.deepEqual(registry.takeRenderFailures(), []);
});

test("escapes, control characters and unknown colors are stripped from a render", () => {
  const env = envWith({
    id: "usage",
    version: 1,
    fields: [],
    render: () => [
      { text: `${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m`, color: "neon" },
      { text: "a\nb" },
    ],
  });

  const rendered = value({ type: "slot", id: "usage" }, env);
  assert.equal(rendered?.text, "redab");
  assert.equal(rendered?.segments?.[0]?.color, undefined);
});

test("the outer edges of a rendered value are trimmed, inner padding is kept", () => {
  const env = envWith({
    id: "usage",
    version: 1,
    fields: [],
    render: () => [{ text: "  bar" }, { text: " · " }, { text: "3h  " }],
  });

  assert.equal(value({ type: "slot", id: "usage" }, env)?.text, "bar · 3h");
});

test("a render with nothing to say leaves the item empty", () => {
  const env = envWith({ id: "usage", version: 1, fields: [], render: () => undefined });
  assert.equal(value({ type: "slot", id: "usage" }, env), undefined);

  const blank = envWith({ id: "usage", version: 1, fields: [], render: () => "   " });
  assert.equal(value({ type: "slot", id: "usage" }, blank), undefined);
});

test("only declared options reach the producer, in the shape declared", () => {
  let seen: SlotOptions | undefined;
  const env = envWith({
    id: "usage",
    version: 1,
    fields: [
      { key: "barWidth", label: "bar width", kind: "number", min: 1, max: 40 },
      { key: "mode", label: "mode", kind: "enum", options: ["a", "b"] },
      { key: "on", label: "on", kind: "boolean" },
    ],
    render: (options: SlotOptions) => {
      seen = options;
      return "x";
    },
  });

  value(
    {
      type: "slot",
      id: "usage",
      options: { barWidth: 400, mode: "nonsense", on: "yes", undeclared: 1 },
    },
    env,
  );

  // Clamped, dropped for not being one of the declared values, dropped for
  // being the wrong type, and dropped for never having been declared.
  assert.deepEqual(seen, { barWidth: 40 });
});

test("the preview flag reaches the producer", () => {
  const render = (_options: SlotOptions, renderEnv: { preview: boolean }) =>
    renderEnv.preview ? "sample" : "live";

  assert.equal(
    value({ type: "slot", id: "usage" }, envWith({ id: "usage", version: 1, fields: [], render }))
      ?.text,
    "live",
  );
  assert.equal(
    value(
      { type: "slot", id: "usage" },
      envWith({ id: "usage", version: 1, fields: [], render }, { preview: true }),
    )?.text,
    "sample",
  );
});

test("segment colors survive to the theme, and an explicit item color flattens them", () => {
  const registry = createRegistry();
  register(registry, {
    id: "usage",
    version: 1,
    fields: [],
    render: () => [{ text: "bar", color: "error" }, { text: " 42%" }],
  });
  const env = fakeEnv({ registry });

  const own = renderStatusline(80, config([[{ type: "slot", id: "usage" }]]), markupTheme(), env);
  assert.equal(own[0], "<error>bar</error><dim> 42%</dim>");

  const forced = renderStatusline(
    80,
    config([[{ type: "slot", id: "usage", color: "accent" }]]),
    markupTheme(),
    env,
  );
  assert.equal(forced[0], "<accent>bar</accent><accent> 42%</accent>");
});

test("the catch-all renders a registered producer from its own defaults", () => {
  const registry = createRegistry();
  publish(registry, { id: "usage", text: "published" });
  register(registry, {
    id: "usage",
    version: 1,
    fields: [{ key: "mode", label: "mode", kind: "enum", options: ["a", "b"] }],
    render: (options: SlotOptions) => `mode:${options.mode ?? "a"}`,
  });
  const env = fakeEnv({ registry });

  assert.equal(value({ type: "extensions" }, env)?.text, "mode:a");
});

test("a registration is dropped when the producer goes away", () => {
  const registry = createRegistry();
  register(registry, { id: "usage", version: 1, fields: [], render: () => "x" });
  const env = fakeEnv({ registry });
  assert.equal(value({ type: "slot", id: "usage" }, env)?.text, "x");

  registry.clear();
  assert.equal(value({ type: "slot", id: "usage" }, env), undefined);
});

test("a schema with unusable fields keeps only the usable ones", () => {
  const registry = createRegistry();
  register(registry, {
    id: "usage",
    version: 1,
    fields: [
      { key: "ok", label: "ok", kind: "boolean" },
      { key: "", label: "no key", kind: "boolean" },
      { key: "bad", label: "bad kind", kind: "colour" },
      { key: "empty", label: "empty enum", kind: "enum", options: [] },
      { key: "ok", label: "duplicate", kind: "string" },
    ],
  });

  const fields = registry.registration("usage")?.fields ?? [];
  assert.deepEqual(
    fields.map((field) => field.key),
    ["ok"],
  );
});

test("changed options are pushed once, per id, with every instance", () => {
  const registry = createRegistry();
  const pushed: unknown[] = [];
  busFor(registry).on("statusline:options", (data) => pushed.push(data));
  register(registry, {
    id: "usage",
    version: 3,
    fields: [{ key: "barWidth", label: "bar width", kind: "number" }],
  });

  const before = config([[{ type: "slot", id: "usage" }]]);
  const after = config([
    [
      { type: "slot", id: "usage", options: { barWidth: 12 } },
      { type: "slot", id: "usage" },
    ],
  ]);

  for (const [id, instances] of changedSlotOptions(before, after)) {
    registry.pushOptions(id, instances);
  }

  assert.deepEqual(pushed, [
    { id: "usage", version: 3, instances: [{ options: { barWidth: 12 } }, { options: {} }] },
  ]);
});

test("an unchanged layout pushes nothing", () => {
  const before = config([[{ type: "slot", id: "usage", options: { barWidth: 12 } }]]);
  const after = config([[{ type: "slot", id: "usage", options: { barWidth: 12 } }]]);
  assert.equal(changedSlotOptions(before, after).size, 0);
});

test("removing the item entirely is not an option change", () => {
  const before = config([[{ type: "slot", id: "usage", options: { barWidth: 12 } }]]);
  const after = config([[]]);
  assert.equal(changedSlotOptions(before, after).size, 0);
});

test("slot options are collected in layout order", () => {
  const collected = slotOptionsById(
    config([
      [{ type: "slot", id: "usage", options: { a: 1 } }],
      [
        { type: "slot", id: "other" },
        { type: "slot", id: "usage", options: { a: 2 } },
      ],
    ]),
  );

  assert.deepEqual(collected.get("usage"), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(collected.get("other"), [{}]);
});
