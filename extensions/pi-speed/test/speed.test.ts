import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { LoadedHistory, NormalizedCall } from "../src/history.ts";
import type { StreamMeasurement } from "../src/measurement.ts";
import {
  createSpeedComponent,
  deriveSpeedReport,
  medianRequestRate,
  showSpeedReport,
  speedReportLines,
} from "../src/speed.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-12T12:00:00Z");

function stream(overrides: Partial<StreamMeasurement> = {}): StreamMeasurement {
  return {
    version: 1,
    entryId: "response",
    provider: "provider",
    model: "model",
    api: "test-api",
    messageTimestamp: NOW - 1_000,
    outputTokens: 300,
    totalOutputTokens: 900,
    durationMs: 1_000,
    chunks: 2,
    ...overrides,
  };
}

function call(overrides: Partial<NormalizedCall> = {}): NormalizedCall {
  return {
    kind: "assistant",
    provider: "provider",
    model: "model",
    timestamp: NOW - 1_000,
    timestampFidelity: "embedded",
    stopReason: "stop",
    durationMs: 90_000,
    stream: stream(),
    thinkingLevel: "high",
    thinkingLevelInferred: false,
    usage: {
      input: 10_000,
      output: 900,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10_900,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    source: { kind: "session", id: "session" },
    ...overrides,
  };
}

function history(calls: NormalizedCall[]): LoadedHistory {
  return { now: NOW, calls, warnings: [] };
}

const plainTheme = { fg: (_color: string, text: string) => text };

test("daily medians pool effort but use individual stream rates, not legacy timing or summed totals", () => {
  const report = deriveSpeedReport(
    history([
      ...[1, 3, 5, 7].map((seconds, index) =>
        call({
          stream: stream({ durationMs: seconds * 1_000 }),
          thinkingLevel: ["high", "low", undefined, "high"][index],
          thinkingLevelInferred: index === 3,
        }),
      ),
      call({ timestamp: NOW - 1.5 * DAY, stream: stream({ durationMs: 2_000 }) }),
      call({ timestamp: NOW - 1.5 * DAY, stopReason: "toolUse" }),
    ]),
  );
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0]?.days.length, 7);
  assert.deepEqual(report.rows[0]?.days.slice(0, 2), [
    { samples: 4, medianRate: 80 },
    { samples: 2, medianRate: 225 },
  ]);
  assert.ok(
    report.rows[0]?.days.slice(2).every((day) => day.samples === 0 && day.medianRate === undefined),
  );
});

test("all seven rolling buckets use the frozen load time and assign exact boundaries only once", () => {
  for (let day = 0; day < 7; day += 1) {
    const report = deriveSpeedReport(
      history([
        call({ timestamp: NOW - day * DAY - 1 }),
        call({ timestamp: NOW - (day + 1) * DAY }),
        call({ timestamp: NOW - (day + 1) * DAY - 1 }),
        call({ timestamp: NOW }),
        call({ timestamp: NOW - 7 * DAY - 1 }),
        call({ timestamp: NOW + 1 }),
        call({ timestamp: undefined }),
        call({ timestamp: Number.NaN }),
      ]),
    );
    assert.equal(report.now, NOW);
    assert.equal(report.since, NOW - 7 * DAY);
    const days = report.rows[0]?.days;
    assert.equal(days?.[day]?.samples, day === 0 ? 3 : 2);
    assert.equal(days?.[0]?.samples, day === 0 ? 3 : 1);
    if (day < 6) assert.equal(days?.[day + 1]?.samples, 1);
    assert.equal(
      days?.reduce((sum, value) => sum + value.samples, 0),
      day === 6 ? 3 : 4,
    );
  }
});

test("exact provider/model rows stay separate, sort by model, and include older-only models", () => {
  const report = deriveSpeedReport(
    history([
      call({ provider: "second", model: "shared", stream: stream({ durationMs: 2_000 }) }),
      call({ provider: "first", model: "shared" }),
      call({ provider: "first", model: "alpha", timestamp: NOW - 6.5 * DAY }),
      call({ model: "too-old", timestamp: NOW - 7 * DAY - 1 }),
      call({ model: "unmeasured", stream: undefined }),
    ]),
  );
  assert.deepEqual(
    report.rows.map((row) => [row.model, row.provider]),
    [
      ["alpha", "first"],
      ["shared", "first"],
      ["shared", "second"],
    ],
  );
  assert.equal(report.rows[0]?.days[0]?.medianRate, undefined);
  assert.equal(report.rows[0]?.days[6]?.medianRate, 300);
  assert.equal(report.rows[1]?.days[0]?.medianRate, 300);
  assert.equal(report.rows[2]?.days[0]?.medianRate, 150);
  const lines = speedReportLines(report, 200);
  assert.match(lines[1] ?? "", /^alpha\s+—/);
  assert.match(lines[2] ?? "", /^shared \(first\)\s+300\.0/);
  assert.match(lines[3] ?? "", /^shared \(second\)\s+150\.0/);
  assert.doesNotMatch(lines.join("\n"), /first\/alpha|too-old|unmeasured/);
});

test("coverage excludes failures and missing measurements across all seven days", () => {
  const calls = [
    call(),
    call({ stopReason: "toolUse", timestamp: NOW - 6.5 * DAY }),
    ...["error", "aborted", "length", undefined].map((stopReason) => call({ stopReason })),
    call({ stream: undefined }),
    ...[0, 999, Number.NaN, Number.POSITIVE_INFINITY].map((durationMs) =>
      call({ stream: stream({ durationMs }) }),
    ),
    ...[0, 249].map((outputTokens) => call({ stream: stream({ outputTokens }) })),
    call({ timestamp: NOW - 7 * DAY - 1, stopReason: "error" }),
  ];
  const report = deriveSpeedReport(history(calls));
  assert.deepEqual(report.coverage, {
    assistants: 13,
    observed: 2,
    unsuccessful: 4,
    untimed: 5,
    noOutput: 2,
  });
  const missingOnly = deriveSpeedReport(history([call({ stream: undefined })]));
  assert.deepEqual(missingOnly.rows, []);
  assert.match(
    speedReportLines(missingOnly, 140).join("\n"),
    /No measured requests in the last seven days/,
  );
});

test("shared medians validate stream floors and shape and never fall back to legacy usage or timing", () => {
  const eligible = call({ stream: stream({ outputTokens: 250, durationMs: 1_000, chunks: 2 }) });
  assert.equal(medianRequestRate([eligible]), 250);
  for (const invalid of [
    { outputTokens: 249 },
    { durationMs: 999 },
    { chunks: 1 },
    { chunks: 2.5 },
    { totalOutputTokens: 299 },
    { entryId: "" },
    { outputTokens: 300.5 },
  ]) {
    const rejected = call({ stream: stream(invalid) });
    assert.equal(medianRequestRate([rejected]), undefined);
    assert.deepEqual(deriveSpeedReport(history([rejected])).rows, []);
  }
  const malformed = call({ stream: { ...stream(), version: 2 } as unknown as StreamMeasurement });
  assert.equal(medianRequestRate([malformed]), undefined);
  const legacy = call({ stream: undefined, durationMs: 1_000 });
  assert.equal(medianRequestRate([legacy]), undefined);
  assert.equal(deriveSpeedReport(history([legacy])).coverage.untimed, 1);
  assert.equal(medianRequestRate([call({ durationMs: undefined })]), 300);
});

test("warnings stay concise and scoped to the seven-day window without exposing source details", () => {
  const loaded = history([]);
  loaded.warnings = [
    { code: "unreadable-source", message: "secret", source: "/private/source" },
    { code: "invalid-usage", message: "secret", timestamp: NOW },
    { code: "invalid-usage", message: "secret", timestamps: [NOW - 6.5 * DAY] },
    { code: "invalid-usage", message: "secret", timestamp: NOW - 7 * DAY - 1 },
    { code: "malformed-snapshot", message: "secret" },
  ];
  const report = deriveSpeedReport(loaded);
  assert.deepEqual(report.warnings, ["unreadable-source (1)", "invalid-usage (2)"]);
  assert.doesNotMatch(speedReportLines(report, 140).join("\n"), /secret|private/);
});

test("the table contains only model and seven daily speeds, expanding columns for larger values", () => {
  const report = deriveSpeedReport(
    history(
      Array.from({ length: 7 }, (_, day) =>
        call({
          timestamp: NOW - day * DAY - 1_000,
          stream: stream({ outputTokens: (day + 1) * 300, totalOutputTokens: (day + 1) * 300 }),
        }),
      ),
    ),
  );
  const lines = speedReportLines(report, 140);
  assert.equal(lines[0]?.trim().replace(/\s+/g, " "), "Model 24h 2d 3d 4d 5d 6d 7d");
  assert.equal(
    lines[1]?.trim().replace(/\s+/g, " "),
    "model 300.0 600.0 900.0 1 200.0 1 500.0 1 800.0 2 100.0",
  );
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines.join("\n"), /Streaming speed|Range:|Total|Trend|Coverage|Warnings/);
});

test("empty speed columns retain a five-character minimum width", () => {
  const lines = speedReportLines(deriveSpeedReport(history([call()])), 140);
  assert.deepEqual(lines, [
    "Model 24h   2d    3d    4d    5d    6d    7d   ",
    "model 300.0 —     —     —     —     —     —    ",
  ]);
});

test("single-table rendering stays width and height safe for Unicode and hostile labels", () => {
  const loaded = history(
    Array.from({ length: 25 }, (_, index) =>
      call({
        provider: `提供者\u001b[31m\n${index}`,
        model: "模\u0007型👩‍💻".repeat(30),
      }),
    ),
  );
  for (const width of [0, 1, 2, 8, 40, 120]) {
    for (const height of [0, 1, 2, 3, 4, 8, 20]) {
      let closed = false;
      let renders = 0;
      const component = createSpeedComponent(
        loaded,
        plainTheme,
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
        if (width > 0 && height >= 4) assert.equal(lines.at(-2), "");
        assert.ok(["\u0007", "\u001b[31m"].every((text) => !lines.join("").includes(text)));
      }
      assert.equal(renders, 8);
      component.handleInput?.("\u001b");
      assert.equal(closed, true);
    }
  }
});

test("row scrolling, column panning, and resizing use one captured report and keep navigation bounded", () => {
  const calls = Array.from({ length: 25 }, (_, index) =>
    call({ model: `m${String(index).padStart(2, "0")}` }),
  );
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
    plainTheme,
    () => {},
    () => {},
    () => panelHeight,
  );
  const first = component.render(20);
  assert.match(first[0] ?? "", /^Model/);
  assert.match(first[1] ?? "", /^m00/);
  component.handleInput?.("\u001b[D");
  assert.deepEqual(component.render(20), first);
  component.handleInput?.("\u001b[6~");
  const second = component.render(20);
  assert.match(second[1] ?? "", /^m05/);
  assert.equal(second[0], first[0]);
  component.handleInput?.("\u001b[C");
  assert.notDeepEqual(component.render(20)[0], first[0]);
  for (let i = 0; i < 30; i += 1) component.handleInput?.("\u001b[C");
  const right = component.render(20);
  assert.match(right[0] ?? "", /7d\s*$/);
  component.handleInput?.("\u001b[C");
  assert.deepEqual(component.render(20), right);
  for (let i = 0; i < 30; i += 1) component.handleInput?.("\u001b[6~");
  const bottom = component.render(140);
  assert.match(bottom.at(-3) ?? "", /^m24/);
  component.handleInput?.("\u001b[6~");
  assert.deepEqual(component.render(140), bottom);
  panelHeight = 20;
  const taller = component.render(140);
  assert.equal(taller.length, 20);
  assert.match(taller.at(-3) ?? "", /^m24/);
  component.handleInput?.("\u001b[5~");
  assert.match(component.render(140)[1] ?? "", /^m00/);
  assert.equal(reads, 1);
  assert.equal(loaded.now, NOW);
  assert.deepEqual(
    speedReportLines(deriveSpeedReport(loaded), 20, 10_000).slice(0, 2),
    speedReportLines(deriveSpeedReport(loaded), 20, 20_000).slice(0, 2),
  );
});

test("RPC presents the fixed table with only a Close option and forwards cancellation", async () => {
  const loaded = history([call(), call({ timestamp: NOW - 1.5 * DAY })]);
  const signal = new AbortController().signal;
  let dialogs = 0;
  const ctx = {
    mode: "rpc",
    ui: {
      select: async (
        title: string,
        options: string[],
        selectedOptions: { signal: AbortSignal },
      ) => {
        dialogs += 1;
        assert.deepEqual(options, ["Close"]);
        assert.equal(selectedOptions.signal, signal);
        assert.equal(
          Reflect.get({ ...selectedOptions }, Symbol.for("pi-extensions:input-dialog")),
          false,
        );
        assert.match(title, /^Model\s+24h\s+2d\s+3d/);
        assert.match(title, /model\s+300\.0\s+300\.0\s+—/);
        return "Close";
      },
    },
  };
  await showSpeedReport(ctx as never, loaded, signal);
  assert.equal(dialogs, 1);
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
          return cancel === "cancel" ? undefined : "Close";
        },
      },
    };
    await showSpeedReport(ctx as never, history([]), controller.signal);
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
              plainTheme,
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
    await showSpeedReport(ctx as never, history([call()]), controller.signal);
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});
