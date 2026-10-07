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
    history(
      [1, 3, 5, 7].map((seconds, index) =>
        call({
          durationMs: seconds * 1_000,
          thinkingLevel: ["high", "low", undefined, "high"][index],
          thinkingLevelInferred: index === 3,
        }),
      ),
    ),
    "1d",
  );
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0]?.samples, 4);
  assert.equal(report.rows[0]?.totalOutputTokens, 400);
  assert.equal(report.rows[0]?.totalSeconds, 16);
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

test("exact provider/model rows pool effort and inferred provenance without pooling trend cohorts", () => {
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
  assert.equal(report.rows.length, 3);
  const pooled = report.rows.find((row) => row.provider === "provider" && row.model === "model");
  assert.equal(pooled?.samples, 40);
  assert.equal(pooled?.previousSamples, 40);
  assert.equal(pooled?.totalOutputTokens, 4_000);
  assert.equal(pooled?.totalSeconds, 40);
  assert.deepEqual(pooled?.changes, [0, 0, 0, 0]);
  assert.ok(report.rows.every((row) => row.medianRate === 100));
  for (const variant of variants.slice(1)) {
    const unmatched = deriveSpeedReport(
      history([...batch(10, false, variant), ...batch(10, true)]),
      "1d",
    );
    assert.equal(unmatched.rows.length, 1);
    assert.deepEqual(unmatched.rows[0]?.changes, []);
  }
  const split = deriveSpeedReport(
    history([...batch(5, false), ...batch(5, false, { thinkingLevel: "low" }), ...batch(10, true)]),
    "1d",
  );
  assert.equal(split.rows[0]?.samples, 10);
  assert.deepEqual(split.rows[0]?.changes, []);
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
  assert.equal(report.rows[0]?.totalOutputTokens, 200);
  assert.equal(report.rows[0]?.totalSeconds, 2);
  const missingOnly = deriveSpeedReport(
    history([call({ durationMs: undefined }), ...batch(10, true)]),
    "1d",
  );
  assert.deepEqual(missingOnly.rows, []);
  assert.match(
    speedReportLines(missingOnly, 140).join("\n"),
    /No measured requests in selected period/,
  );
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
  const loaded = history(
    Array.from({ length: 25 }, (_, index) =>
      call({
        provider: `提供者\u001b[31m\n${index}`,
        model: "模\u0007型👩‍💻".repeat(30),
        thinkingLevel: "high\u001b]8;;evil\u0007\n",
      }),
    ),
  );
  const report = deriveSpeedReport(loaded, "1d");
  for (const width of [0, 1, 2, 8, 40, 120]) {
    for (const height of [0, 1, 2, 3, 4, 8, 20]) {
      let closed = false;
      let renders = 0;
      const component = createSpeedComponent(
        loaded,
        "1d",
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
        "\u001b[1;2C",
        "\u001b[5~",
        "\u001b[A",
        "\u001b[D",
        "\u001b[1;2D",
      ]) {
        if (input) component.handleInput?.(input);
        const lines = component.render(width);
        assert.ok(lines.length <= height);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(["\u0007", "\u001b[31m", "evil"].every((text) => !lines.join("").includes(text)));
      }
      assert.equal(renders, 8);
      component.handleInput?.("\u001b");
      assert.equal(closed, true);
    }
  }
  const lines = speedReportLines(report, 140);
  assert.equal(lines.filter((line) => line.startsWith("Provider/model")).length, 1);
  const component = createSpeedComponent(
    loaded,
    "1d",
    { fg: (_color, text) => text },
    () => {},
    () => {},
    () => 8,
  );
  const before = component.render(80);
  component.handleInput?.("\u001b[6~");
  const after = component.render(80);
  assert.notDeepEqual(after, before);
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3));
  assert.doesNotMatch(
    lines.join("\n"),
    /Coverage|Warnings|N now\/prev|Effort|Request s|inferred|confidence|discoverable/,
  );
});

test("table labels distinguish pooled medians and measured totals with compact units", () => {
  const report = deriveSpeedReport(
    history([
      call({ model: "seconds", usage: { ...call().usage, output: 1_234 } }),
      call({ model: "minutes", durationMs: 90_000 }),
      call({ model: "hours", durationMs: 5_400_000 }),
      call({
        model: "days",
        durationMs: 129_600_000,
        usage: { ...call().usage, output: 1_250_000 },
      }),
    ]),
    "1d",
  );
  const lines = speedReportLines(report, 140);
  assert.match(lines[1] ?? "", /Median tok\/s\s+Total output tokens\s+Total request time\s+Trend/);
  assert.match(lines.join("\n"), /1 234\s+1\.0s/);
  assert.match(lines.join("\n"), /1\.25 M\s+1\.5d/);
  assert.match(lines.join("\n"), /100\s+1\.5m/);
  assert.match(lines.join("\n"), /100\s+1\.5h/);
  assert.equal(lines.length, 6);
});

test("range navigation derives from the same frozen history, resets scroll/pan, and bounds endpoints", () => {
  const calls = [
    ...Array.from({ length: 25 }, (_, index) =>
      call({ model: `m${String(index).padStart(2, "0")}` }),
    ),
    call({ model: "a-old", timestamp: NOW - 1.5 * DAY }),
  ];
  const loaded = history(calls);
  let reads = 0;
  Object.defineProperty(loaded, "calls", {
    get: () => {
      reads += 1;
      return calls;
    },
  });
  let panelHeight = 8;
  const component = createSpeedComponent(
    loaded,
    "1d",
    { fg: (_color, text) => text },
    () => {},
    () => {},
    () => panelHeight,
  );
  const first = component.render(40);
  assert.match(first[3] ?? "", /provider\/m00/);
  component.handleInput?.("\u001b[D");
  assert.deepEqual(component.render(40), first);
  assert.equal(reads, 1);
  component.handleInput?.("\u001b[6~");
  component.handleInput?.("\u001b[1;2C");
  assert.notDeepEqual(component.render(40), first);
  assert.equal(reads, 1);
  component.handleInput?.("\u001b[C");
  const second = component.render(40);
  assert.match(second[0] ?? "", /\[2d\]/);
  assert.match(second[1] ?? "", /2d vs previous 2d/);
  assert.match(second[3] ?? "", /provider\/a-old/);
  assert.equal(reads, 2);
  assert.equal(loaded.now, NOW);
  component.handleInput?.("\u001b[D");
  assert.deepEqual(component.render(40), first);
  for (const range of SPEED_RANGES.slice(1)) {
    component.handleInput?.("\u001b[C");
    assert.ok(component.render(140)[1]?.includes(`${range} vs previous ${range}`));
  }
  const last = component.render(140);
  const lastReads = reads;
  component.handleInput?.("\u001b[C");
  assert.deepEqual(component.render(140), last);
  assert.equal(reads, lastReads);
  for (let index = 0; index < 20; index += 1) component.handleInput?.("\u001b[6~");
  const bottom = component.render(140);
  assert.match(bottom.at(-2) ?? "", /provider\/m24/);
  assert.deepEqual(bottom.slice(0, 3), last.slice(0, 3));
  component.handleInput?.("\u001b[6~");
  assert.deepEqual(component.render(140), bottom);
  panelHeight = 20;
  const taller = component.render(140);
  assert.equal(taller.length, 20);
  assert.match(taller.at(-2) ?? "", /provider\/m24/);
  component.handleInput?.("\u001b[1;2C");
  assert.deepEqual(component.render(140), taller);
  component.handleInput?.("\u001b[5~");
  assert.match(component.render(140)[3] ?? "", /provider\/a-old/);
});

test("active range uses the current theme on every render, including narrow selectors", () => {
  let accentCalls: string[] = [];
  let color = "31";
  const component = createSpeedComponent(
    history([call()]),
    "7d",
    {
      fg: (tone, text) => {
        if (tone === "accent") accentCalls.push(text);
        return `\u001b[${color}m${text}\u001b[0m`;
      },
    },
    () => {},
    () => {},
    () => 8,
  );
  assert.ok(component.render(140)[0]?.includes("\u001b[31m[7d]"));
  assert.deepEqual(accentCalls, ["[7d]"]);
  color = "32";
  accentCalls = [];
  assert.ok(component.render(140)[0]?.includes("\u001b[32m[7d]"));
  const narrow = component.render(5);
  assert.ok(narrow[0]?.includes("[7d]"));
  assert.ok(narrow.every((line) => visibleWidth(line) <= 5));
});

test("RPC range choices update the report directly from the loaded history without a separate picker", async () => {
  const loaded = history([call(), call({ timestamp: NOW - 1.5 * DAY })]);
  const signal = new AbortController().signal;
  const titles: string[] = [];
  const choices = ["2d", "14d", "Close"];
  const ctx = {
    mode: "rpc",
    ui: {
      select: async (
        title: string,
        options: string[],
        selectedOptions: { signal: AbortSignal },
      ) => {
        titles.push(title);
        assert.deepEqual(options, [...SPEED_RANGES, "Close"]);
        assert.equal(selectedOptions.signal, signal);
        return choices.shift();
      },
    },
  };
  await showSpeedReport(ctx as never, loaded, "1d", signal);
  assert.equal(titles.length, 3);
  assert.match(titles[0] ?? "", /1d vs previous 1d/);
  assert.match(titles[0] ?? "", /100\s+1\.0s/);
  assert.match(titles[1] ?? "", /2d vs previous 2d/);
  assert.match(titles[1] ?? "", /200\s+2\.0s/);
  assert.match(titles[2] ?? "", /14d vs previous 14d/);
  assert.ok(
    titles.every((title) => title.includes("Median tok/s") && !/Coverage|Warnings/.test(title)),
  );
});

test("RPC cancellation, shutdown, and already-aborted reports stop opening dialogs", async () => {
  for (const cancel of ["cancel", "shutdown", "already-aborted"]) {
    const controller = new AbortController();
    let dialogs = 0;
    if (cancel === "already-aborted") controller.abort();
    const ctx = {
      mode: "rpc",
      ui: {
        select: async () => {
          dialogs += 1;
          if (cancel === "shutdown") controller.abort();
          return cancel === "cancel" ? undefined : "2d";
        },
      },
    };
    await showSpeedReport(ctx as never, history([]), "1d", controller.signal);
    assert.equal(dialogs, cancel === "already-aborted" ? 0 : 1);
  }
});

test("TUI report opens one bounded table and cleans its abort listener after Escape, shutdown, or disposal", async () => {
  for (const cancel of ["escape", "shutdown", "dispose"]) {
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
          ) => {
            render(width: number): string[];
            handleInput(data: string): void;
            dispose?(): void;
          },
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
              else if (cancel === "shutdown") controller.abort();
              else {
                component.dispose?.();
                component.dispose?.();
                assert.equal(getEventListeners(controller.signal, "abort").length, 0);
                resolve();
              }
            });
          }),
      },
    };
    await showSpeedReport(ctx as never, history([call()]), "1d", controller.signal);
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});
