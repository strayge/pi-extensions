import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { type LoadedHistory, loadHistory } from "../src/history.ts";
import { deriveSpeedReport, type SpeedReport, speedReportLines } from "../src/speed.ts";
import {
  assistantEntry,
  buildLineageFixture,
  DAY_MS,
  discoveryFixture,
  FIXED_NOW,
  type FixtureRow,
  normalizationFixture,
  outputFixture,
  sessionHeader,
} from "./fixtures/speed-history-fixtures.ts";

function manager(options: {
  id?: string;
  file?: string;
  dir: string;
  header?: FixtureRow;
  entries?: FixtureRow[];
}) {
  const header = options.header ?? sessionHeader(options.id ?? "active-fixture");
  return {
    getHeader: () => header,
    getEntries: () => options.entries ?? [],
    getSessionFile: () => options.file,
    getSessionId: () => options.id ?? String(header.id),
    getSessionDir: () => options.dir,
  };
}

function context(sessionManager: ReturnType<typeof manager>) {
  return { cwd: "/fixture-project", sessionManager } as never;
}

function listed(path: string) {
  return { path, modified: new Date(FIXED_NOW) };
}

async function workspace(t: { after: (callback: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "pi-speed-history-golden-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return realpath(path);
}

async function writeJsonl(path: string, rows: readonly unknown[], tail = "") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${tail}`);
}

function reportSnapshot(report: SpeedReport) {
  return {
    range: report.range,
    since: report.since,
    previousSince: report.previousSince,
    now: report.now,
    rows: report.rows,
    coverage: report.coverage,
    warnings: report.warnings,
  };
}

function oneDay(history: LoadedHistory) {
  return deriveSpeedReport(history, "1d");
}

test("golden discovery uses default listing, custom fallback, canonical aliases, and captured active entries", async (t) => {
  const root = await workspace(t);
  const defaultSession = join(root, "project-one", "default.jsonl");
  const defaultAlias = join(root, "project-one", "default-alias.jsonl");
  const persistedSubagent = join(root, "project-two", "subagent.jsonl");
  const staleSession = join(root, "project-two", "stale.jsonl");
  const customDir = join(root, "custom-sessions");
  const activeFile = join(customDir, "active.jsonl");
  const activeAlias = join(customDir, "active-alias.jsonl");
  const customSession = join(customDir, "other.jsonl");
  await writeJsonl(defaultSession, discoveryFixture.defaultSession);
  await symlink(defaultSession, defaultAlias);
  await writeJsonl(persistedSubagent, discoveryFixture.persistedSubagentSession);
  await writeJsonl(staleSession, [
    sessionHeader("stale"),
    assistantEntry({ id: "stale-horizon-call", provider: "provider-z", model: "stale" }),
  ]);
  await utimes(staleSession, new Date(FIXED_NOW - 31 * DAY_MS), new Date(FIXED_NOW - 31 * DAY_MS));
  await writeJsonl(activeFile, discoveryFixture.staleActiveDisk);
  await symlink(activeFile, activeAlias);
  await writeJsonl(customSession, discoveryFixture.customSession);

  const activeEntries = [...discoveryFixture.activeEntries] as FixtureRow[];
  const listingCalls: Array<string | undefined> = [];
  const history = await loadHistory(
    context(
      manager({
        id: "active-session",
        file: activeFile,
        dir: customDir,
        header: sessionHeader("active-session", defaultSession),
        entries: activeEntries,
      }),
    ),
    {
      now: FIXED_NOW,
      outputRoot: join(root, "no-outputs"),
      listAll: async (sessionDir) => {
        listingCalls.push(sessionDir);
        activeEntries.push(
          assistantEntry({
            id: "added-after-capture",
            provider: "provider-z",
            model: "late-mutation",
          }),
        );
        return sessionDir
          ? [listed(activeAlias), listed(activeFile), listed(customSession)]
          : [
              listed(defaultAlias),
              listed(persistedSubagent),
              listed(staleSession),
              listed(defaultSession),
            ];
      },
    },
  );

  assert.deepEqual(listingCalls, [undefined, customDir]);
  assert.deepEqual(history.calls.map((call) => call.entryId).sort(), [
    "active-call",
    "custom-call",
    "default-call",
    "persisted-subagent-call",
  ]);
  assert.equal(history.calls.filter((call) => call.entryId === "default-call").length, 1);
  assert.equal(
    history.calls.find((call) => call.entryId === "default-call")?.source.kind,
    "session",
  );
  assert.equal(history.calls.find((call) => call.entryId === "active-call")?.source.kind, "active");
  assert.equal(
    history.calls.find((call) => call.entryId === "persisted-subagent-call")?.source.kind,
    "session",
  );
  const report = oneDay(history);
  assert.deepEqual(reportSnapshot(report), discoveryFixture.expectedReport);
  assert.deepEqual(speedReportLines(report, 140), discoveryFixture.expectedVisibleLines);

  const memoryHistory = await loadHistory(
    context(manager({ dir: root, entries: [...discoveryFixture.memoryEntries] as FixtureRow[] })),
    { now: FIXED_NOW, outputRoot: join(root, "no-outputs"), listAll: async () => [] },
  );
  assert.equal(memoryHistory.calls[0]?.source.kind, "active");
  assert.equal(memoryHistory.calls[0]?.source.path, undefined);
  assert.deepEqual(oneDay(memoryHistory).rows, [
    {
      provider: "provider-c",
      model: "memory",
      samples: 1,
      previousSamples: 0,
      medianRate: 30,
      totalOutputTokens: 90,
      totalSeconds: 3,
      changes: [],
    },
  ]);
});

test("on-disk age pruning retains only the 30-day boundary tolerance", async (t) => {
  const root = await workspace(t);
  const retained = join(root, "retained.jsonl");
  const excluded = join(root, "excluded.jsonl");
  await writeJsonl(retained, [
    sessionHeader("retained"),
    assistantEntry({
      id: "retained-within-tolerance",
      provider: "provider-age",
      model: "boundary",
      start: FIXED_NOW - 60_000,
    }),
  ]);
  await writeJsonl(excluded, [
    sessionHeader("excluded"),
    assistantEntry({
      id: "excluded-beyond-tolerance",
      provider: "provider-age",
      model: "boundary",
      start: FIXED_NOW - 60_000,
    }),
  ]);
  await utimes(
    retained,
    new Date(FIXED_NOW - 30 * DAY_MS - 29 * 60_000),
    new Date(FIXED_NOW - 30 * DAY_MS - 29 * 60_000),
  );
  await utimes(
    excluded,
    new Date(FIXED_NOW - 30 * DAY_MS - 31 * 60_000),
    new Date(FIXED_NOW - 30 * DAY_MS - 31 * 60_000),
  );

  const history = await loadHistory(context(manager({ dir: root })), {
    now: FIXED_NOW,
    outputRoot: join(root, "no-outputs"),
    listAll: async () => [listed(excluded), listed(retained)],
  });

  assert.deepEqual(
    history.calls.map((call) => call.entryId),
    ["retained-within-tolerance"],
  );
  assert.deepEqual(oneDay(history).rows, [
    {
      provider: "provider-age",
      model: "boundary",
      samples: 1,
      previousSamples: 0,
      medianRate: 100,
      totalOutputTokens: 100,
      totalSeconds: 1,
      changes: [],
    },
  ]);
});

test("golden lineage keeps conservative roots and baseline canonical-copy claimants", async (t) => {
  const root = await workspace(t);
  const names = [
    "mainRoot",
    "mainFork",
    "unrelated",
    "missingRoot",
    "missingChild",
    "cycleA",
    "cycleB",
    "accountingRoot",
    "accountingFork",
    "ineligibleRoot",
    "ineligibleFork",
    "invalidRoot",
    "invalidFork",
    "usageRoot",
    "usageFork",
    "compactionRoot",
    "compactionFork",
    "summaryRoot",
    "summaryFork",
  ] as const;
  const paths = Object.fromEntries(names.map((name) => [name, join(root, `${name}.jsonl`)])) as {
    [Key in (typeof names)[number]]: string;
  };
  const fixture = buildLineageFixture({
    ...paths,
    missingParent: join(root, "missing-parent.jsonl"),
  });
  for (const [path, rows] of fixture.sessions) await writeJsonl(path, rows);

  const history = await loadHistory(context(manager({ dir: root })), {
    now: FIXED_NOW,
    outputRoot: join(root, "no-outputs"),
    listAll: async () => [...fixture.sessions.keys()].reverse().map(listed),
  });
  const calls = history.calls;
  const callsWithId = (entryId: string) => calls.filter((call) => call.entryId === entryId);

  assert.deepEqual(
    callsWithId("shared")
      .map((call) => call.source.path)
      .sort(),
    [paths.mainRoot, paths.unrelated].sort(),
  );
  assert.deepEqual(
    callsWithId("missing-copy").map((call) => call.source.path),
    [paths.missingRoot],
  );
  assert.equal(callsWithId("cycle-copy").length, 2);
  assert.deepEqual(
    callsWithId("accounting-claims-id").map((call) => [call.kind, call.source.path]),
    [["usage", paths.accountingRoot]],
  );
  assert.deepEqual(
    ["canonical-error", "canonical-untimed", "canonical-zero"].map((entryId) => {
      const call = callsWithId(entryId)[0];
      return [entryId, call?.source.path, call?.stopReason, call?.durationMs, call?.usage.output];
    }),
    [
      ["canonical-error", paths.ineligibleRoot, "error", 1_000, 100],
      ["canonical-untimed", paths.ineligibleRoot, "stop", undefined, 100],
      ["canonical-zero", paths.ineligibleRoot, "stop", 1_000, 0],
    ],
  );
  assert.deepEqual(
    callsWithId("invalid-does-not-claim").map((call) => call.source.path),
    [paths.invalidFork],
  );
  assert.deepEqual(
    callsWithId("invalid-root-ordering").map((call) => [call.kind, call.source.path]),
    [["usage", paths.invalidRoot]],
  );
  assert.deepEqual(
    ["usage-order-choice", "compaction-order-choice", "summary-order-choice"].map(
      (entryId) => callsWithId(entryId)[0]?.source.path,
    ),
    [paths.usageFork, paths.compactionFork, paths.summaryFork],
  );
  assert.deepEqual(
    ["usage-order-end", "compaction-order-end", "summary-order-end"].map(
      (entryId) => callsWithId(entryId)[0]?.kind,
    ),
    ["usage", "compaction", "branch_summary"],
  );
  assert.ok(history.warnings.some((warning) => warning.code === "broken-lineage"));
  assert.ok(history.warnings.some((warning) => warning.code === "cyclic-lineage"));
  assert.equal(history.warnings.filter((warning) => warning.code === "invalid-usage").length, 1);
  assert.deepEqual(reportSnapshot(oneDay(history)), fixture.expectedReport);
});

test("golden normalization preserves effort ancestry, usage validation, endpoints, and report boundaries", async (t) => {
  const root = await workspace(t);
  const history = await loadHistory(
    context(
      manager({
        dir: root,
        entries: [...normalizationFixture.entries] as FixtureRow[],
      }),
    ),
    { now: FIXED_NOW, outputRoot: join(root, "no-outputs"), listAll: async () => [] },
  );
  const calls = new Map(history.calls.map((call) => [call.entryId, call]));

  assert.deepEqual(
    normalizationFixture.expectedEffort.map(([entryId]) => {
      const call = calls.get(entryId as string);
      return [entryId, call?.thinkingLevel, call?.thinkingLevelInferred];
    }),
    normalizationFixture.expectedEffort,
  );
  assert.deepEqual(
    ["missing-start", "reversed", "equal", "missing-end", "missing-both"].map((entryId) => [
      entryId,
      calls.get(entryId)?.timestampFidelity,
      calls.get(entryId)?.durationMs,
    ]),
    [
      ["missing-start", "entry", undefined],
      ["reversed", "embedded", undefined],
      ["equal", "embedded", undefined],
      ["missing-end", "embedded", undefined],
      ["missing-both", "missing", undefined],
    ],
  );
  assert.equal(
    history.warnings.filter((warning) => warning.code === "untimestamped-call").length,
    1,
  );
  assert.equal(calls.has("bad-token"), false);
  assert.equal(calls.has("bad-cost"), false);
  assert.equal(history.warnings.filter((warning) => warning.code === "invalid-usage").length, 2);
  const report = oneDay(history);
  assert.deepEqual(reportSnapshot(report), normalizationFixture.expectedReport);
  assert.deepEqual(speedReportLines(report, 140), normalizationFixture.expectedVisibleLines);
});

test("temporary outputs cannot change visible speed rows, whether absent, matching, output-only, or malformed", async (t) => {
  const root = await workspace(t);
  const persisted = join(root, "sessions", "persisted.jsonl");
  await writeJsonl(persisted, outputFixture.persisted);
  const load = (outputRoot: string) =>
    loadHistory(context(manager({ dir: root })), {
      now: FIXED_NOW,
      outputRoot,
      listAll: async () => [listed(persisted)],
    });

  const absent = await load(join(root, "absent-outputs"));
  const outputs = join(root, "outputs");
  const transcript = join(outputs, "cwd", "output-root", "tasks", "agent.output");
  const persistedMessage = outputFixture.persisted[1]?.message;
  await writeJsonl(
    transcript,
    [
      { timestamp: new Date(FIXED_NOW).toISOString(), message: persistedMessage },
      { timestamp: new Date(FIXED_NOW).toISOString(), message: outputFixture.outputOnly },
    ],
    '{"incomplete"',
  );
  const malformed = join(outputs, "cwd", "other-root", "tasks", "broken.output");
  await mkdir(dirname(malformed), { recursive: true });
  await writeFile(malformed, "{malformed}\n");
  const present = await load(outputs);

  const absentReport = oneDay(absent);
  const presentReport = oneDay(present);
  assert.deepEqual(absentReport.rows, presentReport.rows);
  assert.deepEqual(speedReportLines(absentReport, 140), outputFixture.expectedVisibleLines);
  assert.deepEqual(speedReportLines(presentReport, 140), outputFixture.expectedVisibleLines);
  assert.equal(present.calls.filter((call) => call.source.kind === "output").length, 1);
  assert.equal(present.calls.find((call) => call.source.kind === "output")?.durationMs, undefined);
  assert.equal(presentReport.coverage.untimed, absentReport.coverage.untimed + 1);
  assert.ok(present.warnings.some((warning) => warning.code === "malformed-jsonl"));
});

test("malformed, incomplete, missing-header, and unreadable persisted files keep valid report data", async (t) => {
  const root = await workspace(t);
  const partial = join(root, "partial.jsonl");
  const noHeader = join(root, "no-header.jsonl");
  const changing = join(root, "changing.jsonl");
  const unreadable = join(root, "missing.jsonl");
  const valid = assistantEntry({
    id: "surviving-call",
    provider: "provider-m",
    model: "survivor",
    start: FIXED_NOW - 10_000,
    durationMs: 2_000,
    output: 60,
  });
  await mkdir(dirname(partial), { recursive: true });
  await writeFile(
    partial,
    `${JSON.stringify(sessionHeader("partial"))}\n{malformed}\n${JSON.stringify(valid)}\n{"partial"`,
  );
  await writeJsonl(noHeader, [valid]);
  await writeJsonl(changing, [sessionHeader("changing")]);

  const history = await loadHistory(context(manager({ dir: root })), {
    now: FIXED_NOW,
    outputRoot: join(root, "no-outputs"),
    listAll: async () => [listed(partial), listed(noHeader), listed(changing), listed(unreadable)],
    sourceReadStarted: async (path) => {
      if (path === changing) await appendFile(changing, '{"actively-writing"');
    },
  });
  const report = oneDay(history);
  assert.deepEqual(report.rows, [
    {
      provider: "provider-m",
      model: "survivor",
      samples: 1,
      previousSamples: 0,
      medianRate: 30,
      totalOutputTokens: 60,
      totalSeconds: 2,
      changes: [],
    },
  ]);
  assert.equal(history.warnings.filter((warning) => warning.code === "malformed-jsonl").length, 3);
  assert.equal(
    history.warnings.some(
      (warning) => warning.code === "malformed-jsonl" && warning.source === changing,
    ),
    false,
  );
  assert.equal(
    history.warnings.filter((warning) => warning.code === "unreadable-source").length,
    1,
  );
  assert.deepEqual(speedReportLines(report, 140), [
    "Speed · 1d vs previous 1d",
    "Provider/model      Median tok/s Total output tokens Total request time Trend       ",
    "provider-m/survivor 30.0         60                  2.0s               insufficient",
  ]);
});

test("history cancellation remains prompt at entry, discovery, and source-read boundaries", async (t) => {
  const root = await workspace(t);
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    loadHistory(context(manager({ dir: root })), {
      now: FIXED_NOW,
      signal: preAborted.signal,
      outputRoot: join(root, "no-outputs"),
      listAll: async () => assert.fail("pre-aborted loads must not discover sessions"),
    }),
    { name: "AbortError" },
  );

  const discoveryAbort = new AbortController();
  await assert.rejects(
    loadHistory(context(manager({ dir: root })), {
      now: FIXED_NOW,
      signal: discoveryAbort.signal,
      outputRoot: join(root, "no-outputs"),
      listAll: async () => {
        discoveryAbort.abort();
        return [];
      },
    }),
    { name: "AbortError" },
  );

  const session = join(root, "source.jsonl");
  await writeJsonl(session, [sessionHeader("source"), discoveryFixture.defaultSession[1]]);
  const sourceAbort = new AbortController();
  await assert.rejects(
    loadHistory(context(manager({ dir: root })), {
      now: FIXED_NOW,
      signal: sourceAbort.signal,
      outputRoot: join(root, "no-outputs"),
      listAll: async () => [listed(session)],
      sourceReadStarted: () => sourceAbort.abort(),
    }),
    { name: "AbortError" },
  );
});

test("one load captures now once before asynchronous discovery", async (t) => {
  const root = await workspace(t);
  let clock = FIXED_NOW;
  const originalDateNow = Date.now;
  Date.now = () => clock;
  let history: LoadedHistory;
  try {
    history = await loadHistory(
      context(
        manager({
          dir: root,
          entries: [
            assistantEntry({
              id: "frozen-boundary",
              provider: "provider-f",
              model: "frozen",
              start: FIXED_NOW - DAY_MS,
              durationMs: 1_000,
              output: 10,
            }),
          ],
        }),
      ),
      {
        outputRoot: join(root, "no-outputs"),
        listAll: async () => {
          clock += 10 * DAY_MS;
          return [];
        },
      },
    );
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(history.now, FIXED_NOW);
  const report = oneDay(history);
  assert.equal(report.now, FIXED_NOW);
  assert.equal(report.since, FIXED_NOW - DAY_MS);
  assert.equal(report.rows[0]?.samples, 1);
});
