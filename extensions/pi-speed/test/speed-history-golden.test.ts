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
  accountingEntry,
  assistantEntry,
  buildLineageFixture,
  DAY_MS,
  discoveryFixture,
  FIXED_NOW,
  type FixtureRow,
  metadataEntry,
  normalizationFixture,
  outputFixture,
  sessionHeader,
  streamEntry,
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
    { now: FIXED_NOW, listAll: async () => [] },
  );
  assert.equal(memoryHistory.calls[0]?.source.kind, "active");
  assert.equal(memoryHistory.calls[0]?.source.path, undefined);
  assert.equal(memoryHistory.calls[0]?.usage.output, 90);
  assert.equal(memoryHistory.calls[0]?.durationMs, 3_000);
  assert.equal(memoryHistory.calls[0]?.stream, undefined);
  assert.deepEqual(oneDay(memoryHistory).rows, []);
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
    listAll: async () => [listed(excluded), listed(retained)],
  });

  assert.deepEqual(
    history.calls.map((call) => call.entryId),
    ["retained-within-tolerance"],
  );
  assert.equal(history.calls[0]?.timestamp, FIXED_NOW - 60_000);
  assert.equal(history.calls[0]?.usage.output, 100);
  assert.equal(history.calls[0]?.durationMs, 1_000);
  assert.deepEqual(oneDay(history).rows, []);
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
  assert.deepEqual(callsWithId("accounting-claims-id"), []);
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
  assert.deepEqual(callsWithId("invalid-root-ordering"), []);
  assert.deepEqual(
    ["usage-order-choice", "compaction-order-choice", "summary-order-choice"].map(
      (entryId) => callsWithId(entryId)[0]?.source.path,
    ),
    [paths.usageFork, paths.compactionFork, paths.summaryFork],
  );
  assert.deepEqual(
    ["usage-order-end", "compaction-order-end", "summary-order-end"].map((entryId) =>
      callsWithId(entryId),
    ),
    [[], [], []],
  );
  assert.ok(history.warnings.some((warning) => warning.code === "broken-lineage"));
  assert.ok(history.warnings.some((warning) => warning.code === "cyclic-lineage"));
  assert.equal(history.warnings.filter((warning) => warning.code === "invalid-usage").length, 1);
  assert.deepEqual(reportSnapshot(oneDay(history)), fixture.expectedReport);

  const validRoot = join(root, "valid-accounting-root.jsonl");
  const validFork = join(root, "valid-accounting-fork.jsonl");
  const invalidRoot = join(root, "invalid-accounting-root.jsonl");
  const invalidFork = join(root, "invalid-accounting-fork.jsonl");
  const invalidAccounting = accountingEntry({ id: "invalid-accounting-claim" });
  delete invalidAccounting.provider;
  await writeJsonl(validRoot, [
    sessionHeader("valid-accounting-root"),
    accountingEntry({ id: "valid-accounting-claim", at: FIXED_NOW - 30_000 }),
  ]);
  await writeJsonl(validFork, [
    sessionHeader("valid-accounting-fork", validRoot),
    assistantEntry({ id: "valid-accounting-claim", start: FIXED_NOW - 20_000 }),
  ]);
  await writeJsonl(invalidRoot, [sessionHeader("invalid-accounting-root"), invalidAccounting]);
  await writeJsonl(invalidFork, [
    sessionHeader("invalid-accounting-fork", invalidRoot),
    assistantEntry({ id: "invalid-accounting-claim", start: FIXED_NOW - 20_000 }),
  ]);
  const attribution = await loadHistory(context(manager({ dir: root })), {
    now: FIXED_NOW,
    listAll: async () => [validFork, invalidFork, validRoot, invalidRoot].map(listed),
  });
  assert.equal(
    attribution.calls.some((call) => call.entryId === "valid-accounting-claim"),
    false,
  );
  assert.equal(
    attribution.calls.find((call) => call.entryId === "invalid-accounting-claim")?.source.path,
    invalidFork,
  );
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
    { now: FIXED_NOW, listAll: async () => [] },
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

  const missingRoute = assistantEntry({ id: "missing-exact-route", parentId: "route" });
  const missingMessage = missingRoute.message as FixtureRow;
  delete missingMessage.provider;
  delete missingMessage.model;
  const routeHistory = await loadHistory(
    context(
      manager({
        dir: root,
        entries: [
          {
            type: "model_change",
            id: "route",
            parentId: null,
            provider: "inherited-provider",
            modelId: "inherited-model",
          },
          missingRoute,
        ],
      }),
    ),
    { now: FIXED_NOW, listAll: async () => [] },
  );
  assert.deepEqual(routeHistory.calls, []);
  assert.equal(
    routeHistory.warnings.filter((warning) => warning.code === "unattributable-call").length,
    1,
  );
});

test("temporary outputs are never read and cannot change visible speed rows", async (t) => {
  const root = await workspace(t);
  const persisted = join(root, "sessions", "persisted.jsonl");
  await writeJsonl(persisted, outputFixture.persisted);
  const outputs = join(root, "outputs");
  const transcript = join(outputs, "cwd", "output-root", "tasks", "agent.output");
  await writeJsonl(
    transcript,
    [
      {
        timestamp: new Date(FIXED_NOW).toISOString(),
        message: outputFixture.persisted[1]?.message,
      },
      { timestamp: new Date(FIXED_NOW).toISOString(), message: outputFixture.outputOnly },
    ],
    '{"incomplete"',
  );
  const malformed = join(outputs, "cwd", "other-root", "tasks", "broken.output");
  await mkdir(dirname(malformed), { recursive: true });
  await writeFile(malformed, "{malformed}\n");
  const reads: string[] = [];
  const history = await loadHistory(context(manager({ dir: root })), {
    now: FIXED_NOW,
    listAll: async () => [listed(persisted)],
    sourceReadStarted: (path) => reads.push(path),
  });

  const report = oneDay(history);
  assert.deepEqual(reads, [persisted]);
  assert.deepEqual(speedReportLines(report, 140), outputFixture.expectedVisibleLines);
  assert.equal(report.coverage.untimed, 1);
  assert.equal(history.calls[0]?.entryId, "persisted-output");
  assert.equal(history.calls[0]?.durationMs, 2_000);
  assert.equal(
    history.warnings.some((warning) => warning.source?.includes(".output")),
    false,
  );
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
    durationMs: 60_000,
    output: 900,
  });
  await mkdir(dirname(partial), { recursive: true });
  await writeFile(
    partial,
    `${JSON.stringify(sessionHeader("partial"))}\n{malformed}\n${JSON.stringify(valid)}\n${JSON.stringify(streamEntry(valid))}\n{"partial"`,
  );
  await writeJsonl(noHeader, [valid]);
  await writeJsonl(changing, [sessionHeader("changing")]);

  const history = await loadHistory(context(manager({ dir: root })), {
    now: FIXED_NOW,
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
      medianRate: 150,
      totalOutputTokens: 300,
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
    "Streaming speed · 1d vs previous 1d",
    "Provider/model      Median tok/s Total output tokens Total stream time  Trend       ",
    "provider-m/survivor 150.0        300                 2.0s               insufficient",
  ]);
});

test("active and disk annotations attach across all entries, survive reload, and use compact stream data", async (t) => {
  const root = await workspace(t);
  const disk = join(root, "disk.jsonl");
  const activeFile = join(root, "active.jsonl");
  const active = assistantEntry({ id: "active-stream", output: 900, end: "invalid" });
  const persisted = assistantEntry({ id: "disk-stream", output: 900, durationMs: 90_000 });
  const annotation = streamEntry(active, { durationMs: 1_000 });
  (annotation.data as FixtureRow).privatePayload = { secret: "never project this" };
  const activeEntries = [
    active,
    metadataEntry("later-branch", null),
    { ...annotation, parentId: "later-branch" },
    { ...annotation, customType: "other:stream", data: { secret: "unrelated" } },
  ];
  await writeJsonl(disk, [sessionHeader("disk"), persisted, streamEntry(persisted)]);
  await writeJsonl(activeFile, [sessionHeader("active"), ...activeEntries]);
  const loaded = await loadHistory(
    context(manager({ id: "active", file: activeFile, dir: root, entries: activeEntries })),
    { now: FIXED_NOW, listAll: async () => [listed(activeFile), listed(disk)] },
  );
  assert.equal(loaded.calls.length, 2);
  assert.equal(
    loaded.calls.find((call) => call.entryId === "active-stream")?.durationMs,
    undefined,
  );
  assert.equal(loaded.calls.find((call) => call.entryId === "disk-stream")?.durationMs, 90_000);
  assert.ok(loaded.calls.every((call) => call.stream?.totalOutputTokens === 900));
  assert.doesNotMatch(JSON.stringify(loaded), /privatePayload|secret|unrelated/);
  assert.deepEqual(oneDay(loaded).rows, [
    {
      provider: "fixture-provider",
      model: "fixture-model",
      samples: 2,
      previousSamples: 0,
      medianRate: 225,
      totalOutputTokens: 600,
      totalSeconds: 3,
      changes: [],
    },
  ]);
  const reloaded = await loadHistory(context(manager({ dir: root })), {
    now: FIXED_NOW,
    listAll: async () => [listed(disk), listed(activeFile)],
  });
  assert.deepEqual(oneDay(reloaded).rows, oneDay(loaded).rows);
  assert.deepEqual(
    reloaded.calls.map((call) => [call.entryId, call.stream]).sort(),
    loaded.calls.map((call) => [call.entryId, call.stream]).sort(),
  );
});

test("identity mismatches, malformed annotations, and conflicting valid duplicates never supply speed", async (t) => {
  const root = await workspace(t);
  const disk = join(root, "identity.jsonl");
  const entries: FixtureRow[] = [];
  const rejected = [
    { entryId: "wrong-entry" },
    { provider: "wrong-provider" },
    { model: "wrong-model" },
    { api: "wrong-api" },
    { messageTimestamp: FIXED_NOW },
    { totalOutputTokens: 901 },
    { version: 2 },
    { outputTokens: 249 },
    { outputTokens: 1_000 },
    { durationMs: 999 },
    { chunks: 1 },
    { chunks: 2.5 },
    { durationMs: Number.NaN },
  ];
  for (const [index, override] of rejected.entries()) {
    const assistant = assistantEntry({ id: `rejected-${index}`, output: 900 });
    const annotation = streamEntry(assistant);
    Object.assign(annotation.data as FixtureRow, override);
    entries.push(assistant, annotation);
  }
  const conflict = assistantEntry({ id: "conflict", output: 900 });
  entries.push(
    conflict,
    streamEntry(conflict),
    streamEntry(conflict, { durationMs: 3_000 }),
    streamEntry(conflict),
  );
  const accepted = assistantEntry({ id: "identical-duplicates", output: 900 });
  entries.push(accepted, streamEntry(accepted), streamEntry(accepted));
  const repaired = assistantEntry({ id: "invalid-does-not-conflict", output: 900 });
  entries.push(repaired, streamEntry(repaired, { chunks: 1 }), streamEntry(repaired));
  await writeJsonl(disk, [sessionHeader("identity"), ...entries]);
  for (const fromDisk of [false, true]) {
    const loaded = await loadHistory(
      context(manager({ dir: root, entries: fromDisk ? [] : entries })),
      {
        now: FIXED_NOW,
        listAll: async () => (fromDisk ? [listed(disk)] : []),
      },
    );
    assert.equal(loaded.calls.length, rejected.length + 3);
    assert.deepEqual(
      loaded.calls
        .filter((call) => call.stream)
        .map((call) => call.entryId)
        .sort(),
      ["identical-duplicates", "invalid-does-not-conflict"],
    );
    assert.ok(loaded.calls.every((call) => call.durationMs === 1_000));
    assert.equal(oneDay(loaded).coverage.untimed, rejected.length + 1);
    assert.equal(oneDay(loaded).rows[0]?.samples, 2);
  }
});

test("canonical lineage claimants retain their own telemetry without importing measured fork copies", async (t) => {
  const root = await workspace(t);
  const canonical = join(root, "canonical.jsonl");
  const fork = join(root, "fork.jsonl");
  const unrelated = join(root, "unrelated.jsonl");
  const missing = assistantEntry({ id: "unmeasured-canonical", output: 900 });
  const measured = assistantEntry({ id: "measured-canonical", output: 900 });
  const accounting = accountingEntry({ id: "accounting-claim", output: 900 });
  const accountingCopy = assistantEntry({ id: "accounting-claim", output: 900 });
  await writeJsonl(canonical, [
    sessionHeader("canonical"),
    missing,
    measured,
    streamEntry(measured),
    accounting,
  ]);
  await writeJsonl(fork, [
    sessionHeader("fork", canonical),
    missing,
    streamEntry(missing),
    measured,
    streamEntry(measured, { durationMs: 4_000 }),
    accountingCopy,
    streamEntry(accountingCopy),
    accountingEntry({ id: "later-accounting", at: FIXED_NOW - 10_000 }),
  ]);
  await writeJsonl(unrelated, [sessionHeader("unrelated"), missing, streamEntry(missing)]);
  const loaded = await loadHistory(context(manager({ dir: root })), {
    now: FIXED_NOW,
    listAll: async () => [fork, unrelated, canonical].map(listed),
  });
  assert.equal(loaded.calls.length, 3);
  const canonicalCalls = loaded.calls.filter((call) => call.source.path === canonical);
  assert.equal(canonicalCalls.find((call) => call.entryId === missing.id)?.stream, undefined);
  assert.equal(
    canonicalCalls.find((call) => call.entryId === measured.id)?.stream?.durationMs,
    2_000,
  );
  assert.equal(
    loaded.calls.some((call) => call.source.path === fork),
    false,
  );
  assert.equal(
    loaded.calls.some((call) => call.entryId === accounting.id),
    false,
  );
  assert.equal(oneDay(loaded).coverage.untimed, 1);
  assert.equal(oneDay(loaded).rows[0]?.samples, 2);
  assert.equal(oneDay(loaded).rows[0]?.totalSeconds, 4);
});

test("history cancellation remains prompt at entry, discovery, and source-read boundaries", async (t) => {
  const root = await workspace(t);
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    loadHistory(context(manager({ dir: root })), {
      now: FIXED_NOW,
      signal: preAborted.signal,
      listAll: async () => assert.fail("pre-aborted loads must not discover sessions"),
    }),
    { name: "AbortError" },
  );

  const discoveryAbort = new AbortController();
  await assert.rejects(
    loadHistory(context(manager({ dir: root })), {
      now: FIXED_NOW,
      signal: discoveryAbort.signal,
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
  assert.equal(history.calls[0]?.timestamp, FIXED_NOW - DAY_MS);
  assert.equal(history.calls[0]?.durationMs, 1_000);
  assert.equal(report.coverage.untimed, 1);
  assert.deepEqual(report.rows, []);
});
