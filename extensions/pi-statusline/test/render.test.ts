import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../src/config.ts";
import { defaultConfig } from "../src/defaults.ts";
import { renderStatusline } from "../src/render.ts";
import type { StatuslineConfig } from "../src/types.ts";
import {
  clearSlot,
  createRegistry,
  fakeEnv,
  identityTheme,
  markupTheme,
  publish,
} from "./helpers.ts";

const WIDTH = 80;

function render(config: StatuslineConfig, options = {}, width = WIDTH): string[] {
  return renderStatusline(width, config, identityTheme(), fakeEnv(options));
}

function layout(lines: unknown[][]): StatuslineConfig {
  return validateConfig({ lines }).config;
}

test("the default layout reproduces pi's own footer", () => {
  const lines = render(defaultConfig(), {
    cwd: `${process.env.HOME ?? "/home/user"}/work/proj`,
    branch: "main",
    sessionName: "demo",
    usage: {
      input: 12_000,
      output: 3400,
      cacheRead: 80_000,
      cacheWrite: 2000,
      cost: 0.184,
      latestCacheHitRate: 94.12,
    },
  });

  assert.equal(lines.length, 2);
  assert.equal(lines[0], "~/work/proj (main) • demo");
  assert.equal(
    lines[1],
    `↑12k ↓3.4k R80k W2.0k CH94.1% $0.184 72.3%/200k${" ".repeat(21)}gpt-5 • high`,
  );
  assert.equal(lines[1]?.length, WIDTH);
});

test("zero-valued token counters disappear, as in stock pi", () => {
  const lines = render(defaultConfig(), { branch: null });
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "/work/proj");
  assert.equal(lines[1], `72.3%/200k${" ".repeat(58)}gpt-5 • high`);
});

test("the branch and session decorations collapse when absent", () => {
  const withBranch = render(defaultConfig(), { branch: "feature/x", sessionName: undefined });
  assert.equal(withBranch[0], "/work/proj (feature/x)");

  const withSession = render(defaultConfig(), { branch: null, sessionName: "demo" });
  assert.equal(withSession[0], "/work/proj • demo");
});

test("the provider only shows when more than one is configured", () => {
  const single = render(defaultConfig(), {});
  assert.equal(single[1]?.endsWith("gpt-5 • high"), true);
  assert.equal(single[1]?.includes("(openai)"), false);

  const multiple = render(defaultConfig(), { providerCount: 2 });
  assert.equal(multiple[1]?.endsWith("(openai) gpt-5 • high"), true);
});

test("thinking reads 'thinking off' when off and hides on non-reasoning models", () => {
  const off = render(defaultConfig(), { thinkingLevel: "off" });
  assert.equal(off[1]?.endsWith("gpt-5 • thinking off"), true);

  const plain = render(defaultConfig(), { reasoning: false });
  assert.equal(plain[1]?.endsWith("gpt-5"), true);
});

test("context shows ? while the token count is unknown after a compaction", () => {
  const lines = render(defaultConfig(), { contextPercent: null });
  assert.equal(lines[1]?.trimEnd().startsWith("?/200k"), true);
});

test("context tints itself past the warning and error thresholds", () => {
  const config = layout([[{ type: "context" }]]);
  const at = (percent: number) =>
    renderStatusline(WIDTH, config, markupTheme(), fakeEnv({ contextPercent: percent }))[0];

  assert.equal(at(10), "<dim>10.0%/200k</dim>");
  assert.equal(at(80), "<warning>80.0%/200k</warning>");
  assert.equal(at(95), "<error>95.0%/200k</error>");
});

test("context parts combine into every shape the old style list covered", () => {
  const meter = (item: Record<string, unknown>, options = {}) =>
    render(layout([[{ type: "context", ...item }]]), {
      contextPercent: 51.1,
      contextWindow: 272_000,
      contextTokens: 139_000,
      ...options,
    })[0]?.trimEnd();

  assert.equal(meter({}), "51.1%/272k");
  assert.equal(meter({ showWindow: false }), "51.1%");
  assert.equal(meter({ showPercent: false, showTokens: true }), "139k/272k");
  assert.equal(meter({ showPercent: false, showTokens: true, showWindow: false }), "139k");
  assert.equal(meter({ showTokens: true, showWindow: false }), "51.1% 139k");
  assert.equal(meter({ showBar: true, showPercent: false, showWindow: false }), "[████░░░░]");
  assert.equal(meter({ showBar: true, showWindow: false }), "[████░░░░] 51.1%");
  assert.equal(
    meter({ showBar: true, showPercent: false, showTokens: true, showWindow: false }),
    "[████░░░░] 139k",
  );
  assert.equal(meter({ showGauge: true, showPercent: false, showWindow: false }), "▅");
  assert.equal(meter({ showGauge: true, showWindow: false }), "▅ 51.1%");

  // Everything at once, with the window bound to the value it qualifies.
  assert.equal(
    meter({ showBar: true, showGauge: true, showTokens: true }),
    "[████░░░░] ▅ 51.1% 139k/272k",
  );
});

test("the percentage can trail the window and wear parentheses", () => {
  const meter = (item: Record<string, unknown>, options = {}) =>
    render(layout([[{ type: "context", ...item }]]), {
      contextPercent: 51.1,
      contextWindow: 272_000,
      contextTokens: 139_000,
      ...options,
    })[0]?.trimEnd();

  assert.equal(meter({ showTokens: true, percentAfterWindow: true }), "139k/272k 51.1%");
  assert.equal(meter({ showTokens: true, percentParens: true }), "(51.1%) 139k/272k");
  assert.equal(
    meter({ showTokens: true, percentAfterWindow: true, percentParens: true }),
    "139k/272k (51.1%)",
  );
  assert.equal(
    meter({ showBar: true, showTokens: true, percentAfterWindow: true, percentParens: true }),
    "[████░░░░] 139k/272k (51.1%)",
  );

  // Without tokens the window stands alone, and the percentage still trails it.
  assert.equal(meter({ percentAfterWindow: true }), "272k 51.1%");
  // Nothing to trail: the option is inert rather than leaving a stray space.
  assert.equal(meter({ percentAfterWindow: true, showWindow: false }), "51.1%");
  assert.equal(meter({ percentParens: true, showWindow: false }), "(51.1%)");

  // An unknown count is a single ?, placed where the window can qualify it.
  assert.equal(
    meter(
      { showTokens: true, percentAfterWindow: true, percentParens: true },
      { contextPercent: null },
    ),
    "?/272k",
  );
});

test("context bar width and window separator are configurable", () => {
  const meter = (item: Record<string, unknown>) =>
    render(layout([[{ type: "context", ...item }]]), {
      contextPercent: 51.1,
      contextWindow: 272_000,
      contextTokens: 139_000,
    })[0]?.trimEnd();

  assert.equal(meter({ showBar: true, barWidth: 4, showWindow: false }), "[██░░] 51.1%");
  assert.equal(meter({ windowSeparator: " / " }), "51.1% / 272k");
  // Out-of-range widths are clamped rather than dropped.
  assert.equal(meter({ showBar: true, barWidth: 0, showPercent: false, showWindow: false }), "[█]");
});

test("context meters degrade to a single ? while the count is unknown", () => {
  const meter = (item: Record<string, unknown>) =>
    render(layout([[{ type: "context", ...item }]]), {
      contextPercent: null,
      contextWindow: 272_000,
    })[0]?.trimEnd();

  // The bar and gauge cannot express "unknown", so they drop out entirely.
  assert.equal(meter({ showBar: true, showGauge: true, showTokens: true }), "?/272k");
  // Left with nothing to say, the item disappears and takes its line with it.
  assert.equal(meter({ showBar: true, showPercent: false, showWindow: false }), undefined);
  // The window belongs to the model, not the count, so it survives alone.
  assert.equal(meter({ showPercent: false, showTokens: false }), "272k");
});

test("hideWhenZero drops the meter until the context has something in it", () => {
  const meter = (item: Record<string, unknown>, options = {}) =>
    render(layout([[{ type: "context", ...item }]]), {
      contextPercent: 0,
      contextTokens: 0,
      contextWindow: 272_000,
      ...options,
    })[0]?.trimEnd();

  // Off by default, so an empty context still reads as a zeroed meter.
  assert.equal(meter({}), "0.0%/272k");
  // On, the window goes with it: nothing is left for it to qualify.
  assert.equal(meter({ hideWhenZero: true }), undefined);
  assert.equal(meter({ hideWhenZero: true, showBar: true, showTokens: true }), undefined);
  // The first tokens bring it back.
  assert.equal(
    meter({ hideWhenZero: true }, { contextPercent: 51.1, contextTokens: 139_000 }),
    "51.1%/272k",
  );
  // Unknown is not zero: the post-compaction ? survives.
  assert.equal(
    meter({ hideWhenZero: true }, { contextPercent: null, contextTokens: null }),
    "?/272k",
  );
});

/** The instant `fakeEnv` renders at, so a test can place a response before it. */
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const MINUTE = 60_000;

test("the cache-cold marker stays off until a layout asks for it", () => {
  const idle = { runtime: { lastResponseAt: NOW - 5 * 60 * MINUTE } };

  // The shipped default is stock pi, and an upgrade must not change it.
  assert.equal(render(defaultConfig(), idle)[1]?.trimEnd().endsWith("72.3%/200k"), false);
  assert.equal(render(defaultConfig(), idle)[1]?.includes("❄"), false);
  assert.equal(render(layout([[{ type: "context" }]]), idle)[0]?.trimEnd(), "72.3%/200k");
});

test("a cold cache is marked once the idle allowance has passed", () => {
  const meter = (item: Record<string, unknown>, minutesIdle: number) =>
    render(layout([[{ type: "context", coldStyle: "symbol", ...item }]]), {
      runtime: { lastResponseAt: NOW - minutesIdle * MINUTE },
    })[0]?.trimEnd();

  // An hour by default: Anthropic and Codex both retain the cache that long.
  assert.equal(meter({}, 59), "72.3%/200k");
  assert.equal(meter({}, 60), "❄ 72.3%/200k");
  assert.equal(meter({}, 600), "❄ 72.3%/200k");

  assert.equal(meter({ coldAfterMinutes: 5 }, 4), "72.3%/200k");
  assert.equal(meter({ coldAfterMinutes: 5 }, 6), "❄ 72.3%/200k");
  assert.equal(meter({ coldMarker: "~" }, 90), "~72.3%/200k");
});

test("nothing is marked cold before the first response of a session", () => {
  const config = layout([[{ type: "context", coldStyle: "both" }]]);
  // No response behind it means no cache to have gone cold, however long the
  // session has been sitting there.
  assert.equal(
    render(config, { runtime: { lastResponseAt: undefined } })[0]?.trimEnd(),
    "72.3%/200k",
  );
});

test("an empty context is never cold: there is nothing cached to expire", () => {
  const config = layout([[{ type: "context", coldStyle: "symbol" }]]);
  const lines = render(config, {
    contextPercent: 0,
    contextTokens: 0,
    runtime: { lastResponseAt: NOW - 2 * 60 * MINUTE },
  });
  assert.equal(lines[0]?.trimEnd(), "0.0%/200k");
});

test("the cold tint outranks the fill threshold, and both styles combine", () => {
  const at = (coldStyle: string, percent: number, minutesIdle: number) =>
    renderStatusline(
      WIDTH,
      layout([[{ type: "context", coldStyle }]]),
      markupTheme(),
      fakeEnv({ contextPercent: percent, runtime: { lastResponseAt: NOW - minutesIdle * MINUTE } }),
    )[0];

  // Warm, so the threshold keeps its say.
  assert.equal(at("both", 95, 10), "<error>95.0%/200k</error>");
  // Cold: a nearly full context is a standing condition, an expired cache is news.
  assert.equal(at("color", 95, 90), "<accent>95.0%/200k</accent>");
  assert.equal(at("both", 95, 90), "<accent>❄ 95.0%/200k</accent>");
  // `symbol` says it without spending the color, so the threshold survives.
  assert.equal(at("symbol", 95, 90), "<error>❄ 95.0%/200k</error>");
  assert.equal(at("both", 10, 90), "<accent>❄ 10.0%/200k</accent>");
});

test("the cold tint outranks an explicit color on the item", () => {
  // Otherwise `coldColor` is dead on any item that sets `color` — which is a
  // trap, not a precedence rule: the two keys sit next to each other.
  const at = (minutesIdle: number) =>
    renderStatusline(
      WIDTH,
      layout([[{ type: "context", coldStyle: "both", coldColor: "error", color: "accent" }]]),
      markupTheme(),
      fakeEnv({ runtime: { lastResponseAt: NOW - minutesIdle * MINUTE } }),
    )[0];

  assert.equal(at(10), "<accent>72.3%/200k</accent>");
  assert.equal(at(90), "<error>❄ 72.3%/200k</error>");
});

test("a full context item keeps its shape while cold", () => {
  // Every part switched on at once, the way a real layout arrives.
  const config = layout([
    [
      {
        type: "context",
        showGauge: true,
        showTokens: true,
        showWindow: false,
        percentAfterWindow: true,
        percentParens: true,
        hideWhenZero: true,
        coldStyle: "both",
        coldColor: "error",
        color: "accent",
        priority: 85,
      },
    ],
  ]);
  const at = (minutesIdle: number) =>
    renderStatusline(
      WIDTH,
      config,
      markupTheme(),
      fakeEnv({
        contextPercent: 51.1,
        contextTokens: 139_000,
        contextWindow: 272_000,
        runtime: { lastResponseAt: NOW - minutesIdle * MINUTE },
      }),
    )[0];

  assert.equal(at(10), "<accent>▅ 139k (51.1%)</accent>");
  assert.equal(at(90), "<error>❄ ▅ 139k (51.1%)</error>");
});

test("the cold marker never resurrects a meter that had nothing to say", () => {
  const config = layout([
    [
      {
        type: "context",
        coldStyle: "symbol",
        showPercent: false,
        showWindow: false,
      },
    ],
  ]);
  assert.equal(render(config, { runtime: { lastResponseAt: NOW - 90 * MINUTE } })[0], undefined);
});

test("an explicit color overrides the threshold tint", () => {
  const config = layout([[{ type: "context", color: "accent" }]]);
  const line = renderStatusline(WIDTH, config, markupTheme(), fakeEnv({ contextPercent: 95 }))[0];
  assert.equal(line, "<accent>95.0%/200k</accent>");
});

test("extension statuses get their own line, sorted, and vanish when empty", () => {
  const none = render(defaultConfig(), {});
  assert.equal(none.length, 2);

  const some = render(defaultConfig(), { statuses: { usage: "42%", "github-pr": "PR #12" } });
  assert.equal(some.length, 3);
  assert.equal(some[2], "PR #12 42%");
});

test("icons and prefixes decorate the value", () => {
  const config = layout([[{ type: "model", icon: "🤖", prefix: "[", suffix: "]", short: true }]]);
  const line = renderStatusline(
    WIDTH,
    config,
    identityTheme(),
    fakeEnv({ modelId: "anthropic/claude-opus-5-20260101" }),
  )[0];
  assert.equal(line, "[🤖 claude-opus-5]");
});

test("hidden items are skipped entirely", () => {
  const config = layout([[{ type: "cwd" }, { type: "sep" }, { type: "model", hidden: true }]]);
  assert.equal(render(config)[0], "/work/proj");
});

test("a published slot lands where the config names it", () => {
  const config = layout([[{ type: "cwd" }, { type: "split" }, { type: "slot", id: "usage" }]]);
  const lines = render(config, { slots: [{ id: "usage", text: "42%", icon: "📊" }] });
  assert.equal(lines[0]?.trimEnd().endsWith("📊 42%"), true);
  assert.equal(lines[0]?.startsWith("/work/proj"), true);
});

test("a named slot is not repeated in the catch-all", () => {
  const config = layout([[{ type: "slot", id: "usage" }, { type: "sep" }, { type: "extensions" }]]);
  const lines = render(config, {
    slots: [
      { id: "usage", text: "42%" },
      { id: "other", text: "x" },
    ],
  });
  assert.equal(lines[0], "42% x");
});

test("an extension that both publishes and sets a status renders once", () => {
  // What pi-usage does: setStatus keeps a stock pi footer readable, while the
  // published slot makes the entry placeable. One extension, one entry.
  const lines = render(defaultConfig(), {
    statuses: { usage: "42%" },
    slots: [{ id: "usage", text: "42%", icon: "\ud83d\udcca" }],
  });

  assert.equal(lines[2], "\ud83d\udcca 42%");
});

test("the published slot wins over a status of the same name", () => {
  const lines = render(defaultConfig(), {
    statuses: { usage: "stale" },
    slots: [{ id: "usage", text: "fresh" }],
  });

  assert.equal(lines[2], "fresh");
});

test("clearing the slot falls back to the status text", () => {
  const lines = render(defaultConfig(), {
    statuses: { usage: "42%" },
    slots: [{ id: "usage", text: "" }],
  });

  assert.equal(lines.length, 2);
});

test("placing the slot by name removes it from the catch-all entirely", () => {
  const config = layout([[{ type: "slot", id: "usage" }], [{ type: "extensions" }]]);
  const lines = render(config, {
    statuses: { usage: "42%", lsp: "ready" },
    slots: [{ id: "usage", text: "42%" }],
  });

  assert.equal(lines[0], "42%");
  assert.equal(lines[1], "ready");
});

test("an unplaced slot falls into the catch-all", () => {
  const lines = render(defaultConfig(), { slots: [{ id: "usage", text: "42%", icon: "📊" }] });
  assert.equal(lines[2], "📊 42%");
});

test("a slot item falls back to a setStatus key of the same name", () => {
  const config = layout([[{ type: "slot", id: "caffeinate", icon: "💊" }]]);
  const lines = render(config, { statuses: { caffeinate: "awake" } });
  assert.equal(lines[0], "💊 awake");
});

test("defaultPlacement puts a slot on the requested line and side", () => {
  const lines = render(defaultConfig(), {
    slots: [
      {
        id: "usage",
        text: "42%",
        defaultPlacement: { line: 1, side: "right" },
      },
    ],
  });
  assert.equal(lines[1]?.trimEnd().endsWith("gpt-5 • high 42%"), true);
  assert.equal(lines.length, 2);
});

test("defaultPlacement clamps a line index past the end of the layout", () => {
  const config = layout([[{ type: "cwd" }]]);
  const lines = render(config, {
    slots: [{ id: "usage", text: "42%", defaultPlacement: { line: 9, side: "right" } }],
  });
  assert.equal(lines[0], "/work/proj 42%");
});

test("clearing a slot removes it again", () => {
  const registry = createRegistry();
  publish(registry, { id: "usage", text: "42%" });
  assert.equal(registry.all().length, 1);
  clearSlot(registry, "usage");
  assert.equal(registry.all().length, 0);
});

test("republished identical items do not trigger a repaint", () => {
  let repaints = 0;
  const registry = createRegistry(() => {
    repaints += 1;
  });
  publish(registry, { id: "usage", text: "42%" });
  publish(registry, { id: "usage", text: "42%" });
  assert.equal(repaints, 1);
  publish(registry, { id: "usage", text: "43%" });
  assert.equal(repaints, 2);
});

test("malformed slot payloads are ignored", () => {
  const registry = createRegistry();
  publish(registry, { text: "no id" } as never);
  publish(registry, { id: "x" } as never);
  assert.equal(registry.all().length, 0);
});

test("a published color pi does not define is dropped, not passed to the theme", () => {
  // `theme.fg` throws on an unknown color and the footer's render is fatal, so
  // one producer's typo would otherwise take the whole session down.
  const registry = createRegistry();
  publish(registry, { id: "usage", text: "42%", color: "bright-purple" } as never);
  assert.deepEqual(registry.all(), [{ id: "usage", text: "42%" }]);

  publish(registry, { id: "usage", text: "42%", color: "accent" } as never);
  assert.equal(registry.get("usage")?.color, "accent");
});

test("a published icon is flattened like its text", () => {
  const registry = createRegistry();
  publish(registry, { id: "usage", text: "42%", icon: "a\nb" } as never);
  assert.equal(registry.get("usage")?.icon, "a b");
});

test("a lower-priority item sheds before the model on a narrow terminal", () => {
  const lines = render(
    defaultConfig(),
    { usage: { input: 12_000, output: 3400, cost: 0.184 } },
    28,
  );
  assert.equal(lines[1]?.includes("gpt-5"), true);
  assert.equal(lines[1]?.includes("↑12k"), false);
});
