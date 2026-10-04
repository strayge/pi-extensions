import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { LoadedHistory, NormalizedCall } from "../src/history.ts";
import {
  createSpeedComponent,
  deriveSpeedReport,
  SPEED_RANGES,
  showSpeedReport,
  speedRange,
  speedReportLines,
  speedTrend,
} from "../src/speed.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-12T12:00:00Z");

function call(overrides: Partial<NormalizedCall> = {}): NormalizedCall {
  return {
    key: "call",
    kind: "assistant",
    provider: "provider",
    model: "model",
    timestamp: NOW - 1_000,
    timestampFidelity: "embedded",
    preciseTimestamp: true,
    stopReason: "stop",
    durationMs: 1_000,
    thinkingLevel: "high",
    thinkingLevelInferred: false,
    usage: {
      input: 10_000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    source: { kind: "session", id: "session" },
    conversationId: "session",
    ...overrides,
  };
}

function history(calls: NormalizedCall[]): LoadedHistory {
  return { now: NOW, calls, snapshots: [], warnings: [], subagents: [] };
}

function batch(
  count: number,
  previous: boolean,
  overrides: Partial<NormalizedCall> = {},
): NormalizedCall[] {
  return Array.from({ length: count }, (_, index) =>
    call({
      key: `${previous}:${index}`,
      timestamp: NOW - (previous ? DAY + 1_000 : 1_000) - index,
      ...overrides,
    }),
  );
}

test("observed medians use each whole request, not summed tokens over summed time", () => {
  const report = deriveSpeedReport(
    history([1, 3, 5, 7].map((seconds) => call({ durationMs: seconds * 1_000 }))),
    "1d",
  );
  assert.equal(report.rows[0]?.samples, 4);
  assert.equal(report.rows[0]?.medianSeconds, 4);
  assert.ok(Math.abs((report.rows[0]?.medianRate ?? 0) - (100 / 3 + 20) / 2) < 1e-8);
  assert.deepEqual(report.rows[0]?.changes, []);
  assert.equal(speedTrend([]), "insufficient");
});

test("cohorts require ten successful timed requests in each equal-length period", () => {
  for (const [current, previous] of [
    [9, 10],
    [10, 9],
    [10, 10],
  ]) {
    const report = deriveSpeedReport(
      history([
        ...batch(current as number, false, { durationMs: 2_000 }),
        ...batch(previous as number, true),
      ]),
      "1d",
    );
    assert.equal(report.rows[0]?.samples, current);
    assert.equal(report.rows[0]?.previousSamples, previous);
    assert.deepEqual(report.rows[0]?.changes, current === 10 && previous === 10 ? [-50] : []);
  }
});

test("Trend preserves conflicting cohort median changes as a range, not an aggregate", () => {
  const largeContext = { ...call().usage, cacheRead: 60_000 };
  const report = deriveSpeedReport(
    history([
      ...batch(10, false, { durationMs: 2_000 / 3 }),
      ...batch(10, true),
      ...batch(10, false, { usage: largeContext, durationMs: 1_250 }),
      ...batch(10, true, { usage: largeContext }),
    ]),
    "1d",
  );
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0]?.changes.length, 2);
  assert.equal(speedTrend(report.rows[0]?.changes ?? []), "-20.0%…+50.0% (2)");
  assert.equal(speedTrend([0]), "0.0%");
});

test("context, output, and response-type boundaries cannot supply one another's missing samples", () => {
  for (const change of [
    { usage: { ...call().usage, input: 16_000 } },
    { usage: { ...call().usage, input: 64_000 } },
    { usage: { ...call().usage, input: 128_000 } },
    { usage: { ...call().usage, output: 500 } },
    { usage: { ...call().usage, output: 2_000 } },
    { usage: { ...call().usage, output: 8_000 } },
    { stopReason: "toolUse" },
  ]) {
    const report = deriveSpeedReport(
      history([...batch(10, false, change), ...batch(10, true)]),
      "1d",
    );
    assert.deepEqual(report.rows[0]?.changes, []);
  }
});

test("provider/model, requested effort, inferred provenance, and unknown effort remain separate", () => {
  const variants: Partial<NormalizedCall>[] = [
    {},
    { provider: "other" },
    { model: "other" },
    { thinkingLevel: "low" },
    { thinkingLevelInferred: true },
    { thinkingLevel: undefined },
  ];
  const report = deriveSpeedReport(
    history(
      variants.flatMap((variant) => [...batch(10, false, variant), ...batch(10, true, variant)]),
    ),
    "1d",
  );
  assert.equal(report.rows.length, 6);
  assert.ok(
    report.rows.every(
      (row) => row.samples === 10 && row.previousSamples === 10 && row.changes[0] === 0,
    ),
  );
  const unmatched = deriveSpeedReport(
    history([...batch(10, false, { thinkingLevelInferred: true }), ...batch(10, true)]),
    "1d",
  );
  assert.equal(unmatched.rows.length, 1);
  assert.deepEqual(unmatched.rows[0]?.changes, []);
});

test("coverage counts only current assistant requests and excludes failures, missing data, and accounting work", () => {
  const calls = [
    call(),
    call({ stopReason: "toolUse" }),
    ...["error", "aborted", "length", undefined].map((stopReason) => call({ stopReason })),
    ...[undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((durationMs) =>
      call({ durationMs }),
    ),
    ...[0, Number.NaN].map((output) => call({ usage: { ...call().usage, output } })),
    ...["usage", "compaction", "branch_summary"].map((kind) =>
      call({ kind: kind as NormalizedCall["kind"] }),
    ),
    call({ kind: undefined }),
    call({ timestamp: undefined }),
    call({ timestamp: NOW - DAY - 1, stopReason: "error" }),
  ];
  const report = deriveSpeedReport(history(calls), "1d");
  assert.deepEqual(report.coverage, {
    assistants: 13,
    observed: 2,
    unsuccessful: 4,
    untimed: 5,
    noOutput: 2,
  });
  assert.equal(report.rows[0]?.samples, 2);
  const missingOnly = deriveSpeedReport(history([call({ durationMs: undefined })]), "1d");
  assert.equal(missingOnly.rows.length, 1);
  assert.equal(missingOnly.rows[0]?.medianRate, undefined);
});

test("range boundaries use the frozen load time and do not count a boundary in both periods", () => {
  for (const range of SPEED_RANGES) {
    const length = Number.parseInt(range, 10) * DAY;
    const report = deriveSpeedReport(
      history([
        call({ timestamp: NOW }),
        call({ timestamp: NOW - length }),
        call({ timestamp: NOW - length - 1 }),
        call({ timestamp: NOW - 2 * length }),
        call({ timestamp: NOW - 2 * length - 1 }),
        call({ timestamp: NOW + 1 }),
      ]),
      range,
    );
    assert.equal(report.coverage.observed, 2);
    assert.equal(report.rows[0]?.previousSamples, 2);
    assert.equal(report.previousSince, NOW - 2 * length);
    assert.equal(report.now, NOW);
  }
  assert.equal(speedRange("30d"), undefined);
  assert.equal(speedRange("1d 2d"), undefined);
  const previousOnly = deriveSpeedReport(history(batch(10, true)), "1d");
  assert.deepEqual(previousOnly.rows, []);
});

test("warnings remain concise, scoped to comparison periods when dated, and do not expose source details", () => {
  const loaded = history([]);
  loaded.warnings = [
    { code: "unreadable-source", message: "secret", source: "/private/source" },
    { code: "invalid-usage", message: "secret", timestamp: NOW },
    { code: "invalid-usage", message: "secret", timestamp: NOW - 3 * DAY },
    { code: "malformed-snapshot", message: "secret" },
  ];
  const report = deriveSpeedReport(loaded, "1d");
  assert.deepEqual(report.warnings, ["unreadable-source (1)", "invalid-usage (1)"]);
  assert.doesNotMatch(speedReportLines(report, 140).join("\n"), /secret|private/);
});

test("single-table rendering and scrolling stay width/height safe for Unicode and hostile labels", () => {
  const report = deriveSpeedReport(
    history(
      Array.from({ length: 25 }, (_, index) =>
        call({
          provider: `提供者\u001b[31m\n${index}`,
          model: "模\u0007型👩‍💻".repeat(30),
          thinkingLevel: "high\u001b]8;;evil\u0007\n",
        }),
      ),
    ),
    "1d",
  );
  for (const width of [1, 2, 8, 40, 120]) {
    for (const height of [1, 2, 8, 20]) {
      let closed = false;
      let renders = 0;
      const component = createSpeedComponent(
        report,
        { fg: (_color, text) => text },
        () => {
          renders += 1;
        },
        () => {
          closed = true;
        },
        () => height,
      );
      for (const input of [
        "",
        "\u001b[B",
        "\u001b[6~",
        "\u001b[C",
        "\u001b[5~",
        "\u001b[A",
        "\u001b[D",
      ]) {
        if (input) component.handleInput?.(input);
        const lines = component.render(width);
        assert.ok(lines.length <= height);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(["\u0007", "\u001b[31m", "evil"].every((text) => !lines.join("").includes(text)));
      }
      assert.equal(renders, 6);
      component.handleInput?.("\u001b");
      assert.equal(closed, true);
    }
  }
  const lines = speedReportLines(report, 140);
  assert.equal(lines.filter((line) => line.startsWith("Provider/model")).length, 1);
  const component = createSpeedComponent(
    report,
    { fg: (_color, text) => text },
    () => {},
    () => {},
    () => 8,
  );
  const before = component.render(80);
  component.handleInput?.("\u001b[6~");
  assert.notDeepEqual(component.render(80), before);
});

test("TUI report opens one bounded table and cleans its abort listener after Escape or shutdown", async () => {
  for (const cancel of ["escape", "shutdown"]) {
    const controller = new AbortController();
    let calls = 0;
    const ctx = {
      mode: "tui",
      ui: {
        custom: async (
          factory: (
            tui: object,
            theme: object,
            keys: object,
            done: () => void,
          ) => { render(width: number): string[]; handleInput(data: string): void },
        ) =>
          new Promise<void>((resolve) => {
            calls += 1;
            const component = factory(
              { terminal: { rows: 8 }, requestRender() {} },
              { fg: (_color: string, text: string) => text },
              {},
              resolve,
            );
            assert.ok(component.render(80).length <= 8);
            assert.equal(getEventListeners(controller.signal, "abort").length, 1);
            queueMicrotask(() => {
              if (cancel === "escape") component.handleInput("\u001b");
              else controller.abort();
            });
          }),
      },
    };
    await showSpeedReport(ctx as never, history([call()]), "1d", controller.signal);
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});
