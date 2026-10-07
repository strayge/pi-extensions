export const FIXED_NOW = Date.parse("2026-09-12T12:00:00.000Z");
export const DAY_MS = 24 * 60 * 60_000;

export type FixtureRow = Record<string, unknown>;

export function usage(
  output = 100,
  overrides: Partial<{
    input: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: Partial<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    }>;
  }> = {},
): FixtureRow {
  const input = overrides.input ?? 100;
  const cacheRead = overrides.cacheRead ?? 0;
  const cacheWrite = overrides.cacheWrite ?? 0;
  const cost = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    ...overrides.cost,
  };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: overrides.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost,
  };
}

export function sessionHeader(id: string, parentSession?: string): FixtureRow {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: new Date(FIXED_NOW - DAY_MS).toISOString(),
    cwd: "/fixture-project",
    ...(parentSession ? { parentSession } : {}),
  };
}

export function assistantEntry(options: {
  id: string;
  parentId?: string | null;
  provider?: string;
  model?: string;
  start?: number | string | null;
  end?: number | string | null;
  durationMs?: number;
  output?: number;
  stopReason?: string;
  thinkingLevel?: string;
  usage?: FixtureRow;
}): FixtureRow {
  const start = options.start === undefined ? FIXED_NOW - 60_000 : options.start;
  const durationMs = options.durationMs ?? 1_000;
  const end =
    options.end === undefined
      ? typeof start === "number"
        ? start + durationMs
        : FIXED_NOW - 59_000
      : options.end;
  return {
    type: "message",
    id: options.id,
    parentId: options.parentId ?? null,
    ...(end === null
      ? {}
      : { timestamp: typeof end === "number" ? new Date(end).toISOString() : end }),
    message: {
      role: "assistant",
      content: [{ type: "text", text: `fixture-${options.id}` }],
      provider: options.provider ?? "fixture-provider",
      model: options.model ?? "fixture-model",
      usage: options.usage ?? usage(options.output),
      stopReason: options.stopReason ?? "stop",
      ...(start === null ? {} : { timestamp: start }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    },
  };
}

export function thinkingEntry(
  id: string,
  parentId: string | null,
  thinkingLevel: string,
): FixtureRow {
  return { type: "thinking_level_change", id, parentId, thinkingLevel };
}

export function metadataEntry(id: string, parentId: string | null): FixtureRow {
  return { type: "custom", id, parentId, customType: "fixture:metadata", data: {} };
}

export function accountingEntry(options: {
  id: string;
  parentId?: string | null;
  at?: number;
  provider?: string;
  model?: string;
  output?: number;
}): FixtureRow {
  return {
    type: "usage",
    id: options.id,
    parentId: options.parentId ?? null,
    timestamp: new Date(options.at ?? FIXED_NOW - 60_000).toISOString(),
    kind: "cache_warm",
    provider: options.provider ?? "fixture-provider",
    model: options.model ?? "accounting-only",
    usage: usage(options.output),
  };
}

export function orderingEntry(
  type: "compaction" | "branch_summary",
  id: string,
  parentId: string,
  at: number,
): FixtureRow {
  return {
    type,
    id,
    parentId,
    timestamp: new Date(at).toISOString(),
    usage: usage(1),
    summary: "ordering metadata",
  };
}

export const discoveryFixture = {
  defaultSession: [
    sessionHeader("default-session"),
    assistantEntry({
      id: "default-call",
      provider: "provider-a",
      model: "alpha",
      start: FIXED_NOW - 20_000,
      durationMs: 2_000,
      output: 200,
    }),
  ],
  customSession: [
    sessionHeader("custom-session"),
    assistantEntry({
      id: "custom-call",
      provider: "provider-a",
      model: "alpha",
      start: FIXED_NOW - 10_000,
      durationMs: 1_000,
      output: 100,
    }),
  ],
  persistedSubagentSession: [
    sessionHeader("persisted-subagent"),
    assistantEntry({
      id: "persisted-subagent-call",
      provider: "provider-d",
      model: "subagent",
      start: FIXED_NOW - 9_000,
      durationMs: 1_000,
      output: 50,
    }),
  ],
  staleActiveDisk: [
    sessionHeader("active-session"),
    assistantEntry({
      id: "disk-copy-must-not-load",
      provider: "provider-z",
      model: "stale-disk",
      start: FIXED_NOW - 8_000,
    }),
  ],
  activeEntries: [
    assistantEntry({
      id: "default-call",
      provider: "provider-a",
      model: "alpha",
      start: FIXED_NOW - 20_000,
      durationMs: 2_000,
      output: 200,
    }),
    assistantEntry({
      id: "active-call",
      provider: "provider-b",
      model: "beta",
      start: FIXED_NOW - 7_000,
      durationMs: 4_000,
      output: 120,
    }),
  ],
  memoryEntries: [
    assistantEntry({
      id: "memory-call",
      provider: "provider-c",
      model: "memory",
      start: FIXED_NOW - 5_000,
      durationMs: 3_000,
      output: 90,
    }),
  ],
  expectedReport: {
    range: "1d",
    since: FIXED_NOW - DAY_MS,
    previousSince: FIXED_NOW - 2 * DAY_MS,
    now: FIXED_NOW,
    rows: [
      {
        provider: "provider-a",
        model: "alpha",
        samples: 2,
        previousSamples: 0,
        medianRate: 100,
        totalOutputTokens: 300,
        totalSeconds: 3,
        changes: [],
      },
      {
        provider: "provider-b",
        model: "beta",
        samples: 1,
        previousSamples: 0,
        medianRate: 30,
        totalOutputTokens: 120,
        totalSeconds: 4,
        changes: [],
      },
      {
        provider: "provider-d",
        model: "subagent",
        samples: 1,
        previousSamples: 0,
        medianRate: 50,
        totalOutputTokens: 50,
        totalSeconds: 1,
        changes: [],
      },
    ],
    coverage: { assistants: 4, observed: 4, unsuccessful: 0, untimed: 0, noOutput: 0 },
    warnings: [],
  },
  expectedVisibleLines: [
    "Speed · 1d vs previous 1d",
    "Provider/model      Median tok/s Total output tokens Total request time Trend       ",
    "provider-a/alpha    100.0        300                 3.0s               insufficient",
    "provider-b/beta     30.0         120                 4.0s               insufficient",
    "provider-d/subagent 50.0         50                  1.0s               insufficient",
  ],
} as const;

const inferredPrevious = Array.from({ length: 10 }, (_, index) =>
  assistantEntry({
    id: `alpha-previous-${index}`,
    parentId: "low-bridge",
    provider: "provider-a",
    model: "alpha",
    start: FIXED_NOW - DAY_MS - 3 * 60 * 60_000 - index * 1_000,
    durationMs: 1_000,
    output: 100,
  }),
);

const inferredCurrent = Array.from({ length: 10 }, (_, index) =>
  assistantEntry({
    id: `alpha-current-${index}`,
    parentId: "low-bridge",
    provider: "provider-a",
    model: "alpha",
    start: FIXED_NOW - 3 * 60 * 60_000 - index * 1_000,
    durationMs: 2_000,
    output: 100,
  }),
);

const badTokenUsage = usage(100);
badTokenUsage.output = -1;
const badCostUsage = usage(100);
(badCostUsage.cost as FixtureRow).total = -1;

export const normalizationFixture = {
  entries: [
    thinkingEntry("low", null, "low"),
    metadataEntry("low-bridge", "low"),
    thinkingEntry("high", null, "high"),
    metadataEntry("cycle-a", "cycle-b"),
    metadataEntry("cycle-b", "cycle-a"),
    ...inferredPrevious,
    ...inferredCurrent,
    assistantEntry({
      id: "alpha-explicit",
      parentId: "low-bridge",
      provider: "provider-a",
      model: "alpha",
      start: FIXED_NOW - 2 * 60 * 60_000,
      durationMs: 1_000,
      output: 300,
      thinkingLevel: "max",
    }),
    assistantEntry({
      id: "beta-unknown",
      parentId: "missing-parent",
      provider: "provider-a",
      model: "beta",
      start: FIXED_NOW - 60 * 60_000,
      durationMs: 500,
      output: 50,
    }),
    assistantEntry({
      id: "beta-high",
      parentId: "high",
      provider: "provider-a",
      model: "beta",
      start: FIXED_NOW - 50 * 60_000,
      durationMs: 1_000,
      output: 50,
    }),
    assistantEntry({
      id: "beta-cycle",
      parentId: "cycle-a",
      provider: "provider-a",
      model: "beta",
      start: FIXED_NOW - 40 * 60_000,
      durationMs: 2_000,
      output: 50,
    }),
    assistantEntry({
      id: "boundary-now",
      provider: "provider-a",
      model: "boundary",
      start: FIXED_NOW,
      durationMs: 1_000,
      output: 10,
    }),
    assistantEntry({
      id: "boundary-current-lower",
      provider: "provider-a",
      model: "boundary",
      start: FIXED_NOW - DAY_MS,
      durationMs: 1_000,
      output: 10,
    }),
    assistantEntry({
      id: "boundary-previous-upper",
      provider: "provider-a",
      model: "boundary",
      start: FIXED_NOW - DAY_MS - 1,
      durationMs: 1_000,
      output: 10,
    }),
    assistantEntry({
      id: "boundary-previous-lower",
      provider: "provider-a",
      model: "boundary",
      start: FIXED_NOW - 2 * DAY_MS,
      durationMs: 1_000,
      output: 10,
    }),
    assistantEntry({
      id: "before-comparison",
      provider: "provider-a",
      model: "outside",
      start: FIXED_NOW - 2 * DAY_MS - 1,
      durationMs: 1_000,
    }),
    assistantEntry({
      id: "future",
      provider: "provider-a",
      model: "outside",
      start: FIXED_NOW + 1,
      durationMs: 1_000,
    }),
    assistantEntry({
      id: "failed",
      provider: "provider-a",
      model: "ineligible",
      start: FIXED_NOW - 30 * 60_000,
      stopReason: "error",
    }),
    assistantEntry({
      id: "zero-output",
      provider: "provider-a",
      model: "ineligible",
      start: FIXED_NOW - 29 * 60_000,
      output: 0,
    }),
    assistantEntry({
      id: "missing-start",
      provider: "provider-a",
      model: "ineligible",
      start: null,
      end: FIXED_NOW - 28 * 60_000,
    }),
    assistantEntry({
      id: "reversed",
      provider: "provider-a",
      model: "ineligible",
      start: FIXED_NOW - 27 * 60_000,
      end: FIXED_NOW - 27 * 60_000 - 1,
    }),
    assistantEntry({
      id: "equal",
      provider: "provider-a",
      model: "ineligible",
      start: FIXED_NOW - 26 * 60_000,
      end: FIXED_NOW - 26 * 60_000,
    }),
    assistantEntry({
      id: "missing-end",
      provider: "provider-a",
      model: "ineligible",
      start: FIXED_NOW - 25 * 60_000,
      end: "invalid",
    }),
    assistantEntry({
      id: "missing-both",
      provider: "provider-a",
      model: "ineligible",
      start: null,
      end: null,
    }),
    assistantEntry({
      id: "bad-token",
      provider: "provider-a",
      model: "invalid",
      start: FIXED_NOW - 24 * 60_000,
      usage: badTokenUsage,
    }),
    assistantEntry({
      id: "bad-cost",
      provider: "provider-a",
      model: "invalid",
      start: FIXED_NOW - 23 * 60_000,
      usage: badCostUsage,
    }),
  ],
  expectedEffort: [
    ["alpha-current-0", "low", true],
    ["alpha-explicit", "max", false],
    ["beta-high", "high", true],
    ["beta-unknown", undefined, false],
    ["beta-cycle", undefined, false],
  ],
  expectedReport: {
    range: "1d",
    since: FIXED_NOW - DAY_MS,
    previousSince: FIXED_NOW - 2 * DAY_MS,
    now: FIXED_NOW,
    rows: [
      {
        provider: "provider-a",
        model: "alpha",
        samples: 11,
        previousSamples: 10,
        medianRate: 50,
        totalOutputTokens: 1_300,
        totalSeconds: 21,
        changes: [-50],
      },
      {
        provider: "provider-a",
        model: "beta",
        samples: 3,
        previousSamples: 0,
        medianRate: 50,
        totalOutputTokens: 150,
        totalSeconds: 3.5,
        changes: [],
      },
      {
        provider: "provider-a",
        model: "boundary",
        samples: 2,
        previousSamples: 2,
        medianRate: 10,
        totalOutputTokens: 20,
        totalSeconds: 2,
        changes: [],
      },
    ],
    coverage: { assistants: 22, observed: 16, unsuccessful: 1, untimed: 4, noOutput: 1 },
    warnings: ["invalid-usage (2)", "untimestamped-call (1)"],
  },
  expectedVisibleLines: [
    "Speed · 1d vs previous 1d",
    "Provider/model      Median tok/s Total output tokens Total request time Trend       ",
    "provider-a/alpha    50.0         1 300               21.0s              -50.0%      ",
    "provider-a/beta     50.0         150                 3.5s               insufficient",
    "provider-a/boundary 10.0         20                  2.0s               insufficient",
  ],
} as const;

export interface LineageFixturePaths {
  mainRoot: string;
  mainFork: string;
  unrelated: string;
  missingRoot: string;
  missingChild: string;
  missingParent: string;
  cycleA: string;
  cycleB: string;
  accountingRoot: string;
  accountingFork: string;
  ineligibleRoot: string;
  ineligibleFork: string;
  invalidRoot: string;
  invalidFork: string;
  usageRoot: string;
  usageFork: string;
  compactionRoot: string;
  compactionFork: string;
  summaryRoot: string;
  summaryFork: string;
}

/** Paths are injected so parentSession links remain literal persisted-fixture inputs. */
export function buildLineageFixture(paths: LineageFixturePaths) {
  const invalidUsage = usage(100);
  (invalidUsage.cost as FixtureRow).total = -1;
  const route = (id: string): FixtureRow => ({
    type: "model_change",
    id,
    parentId: null,
    provider: "provider-order",
    modelId: "ordering",
  });
  const orderingAssistant = (id: string, start: number, durationMs: number) =>
    assistantEntry({
      id,
      parentId: "route",
      provider: "provider-order",
      model: "ordering",
      start,
      durationMs,
      output: 100,
    });
  return {
    sessions: new Map<string, FixtureRow[]>([
      [
        paths.mainRoot,
        [
          sessionHeader("main-root"),
          assistantEntry({
            id: "shared",
            provider: "provider-l",
            model: "main",
            start: FIXED_NOW - 55 * 60_000,
            durationMs: 5_000,
            output: 100,
          }),
        ],
      ],
      [
        paths.mainFork,
        [
          sessionHeader("main-fork", paths.mainRoot),
          assistantEntry({
            id: "shared",
            provider: "provider-l",
            model: "main",
            start: FIXED_NOW - 45 * 60_000,
            durationMs: 1_000,
            output: 100,
          }),
        ],
      ],
      [
        paths.unrelated,
        [
          sessionHeader("unrelated"),
          assistantEntry({
            id: "shared",
            provider: "provider-l",
            model: "main",
            start: FIXED_NOW - 35 * 60_000,
            durationMs: 2_000,
            output: 100,
          }),
        ],
      ],
      [
        paths.missingRoot,
        [
          sessionHeader("missing-root", paths.missingParent),
          assistantEntry({
            id: "missing-copy",
            provider: "provider-l",
            model: "missing",
            start: FIXED_NOW - 50 * 60_000,
            durationMs: 2_000,
            output: 100,
          }),
        ],
      ],
      [
        paths.missingChild,
        [
          sessionHeader("missing-child", paths.missingRoot),
          assistantEntry({
            id: "missing-copy",
            provider: "provider-l",
            model: "missing",
            start: FIXED_NOW - 40 * 60_000,
            durationMs: 1_000,
            output: 100,
          }),
        ],
      ],
      [
        paths.cycleA,
        [
          sessionHeader("cycle-a", paths.cycleB),
          assistantEntry({
            id: "cycle-copy",
            provider: "provider-l",
            model: "cycle",
            start: FIXED_NOW - 30 * 60_000,
            durationMs: 4_000,
            output: 100,
          }),
        ],
      ],
      [
        paths.cycleB,
        [
          sessionHeader("cycle-b", paths.cycleA),
          assistantEntry({
            id: "cycle-copy",
            provider: "provider-l",
            model: "cycle",
            start: FIXED_NOW - 20 * 60_000,
            durationMs: 1_000,
            output: 100,
          }),
        ],
      ],
      [
        paths.accountingRoot,
        [
          sessionHeader("accounting-root"),
          accountingEntry({
            id: "accounting-claims-id",
            at: FIXED_NOW - 30 * 60_000,
            provider: "provider-hidden",
            model: "accounting",
          }),
        ],
      ],
      [
        paths.accountingFork,
        [
          sessionHeader("accounting-fork", paths.accountingRoot),
          assistantEntry({
            id: "accounting-claims-id",
            provider: "provider-hidden",
            model: "must-stay-hidden",
            start: FIXED_NOW - 20 * 60_000,
          }),
        ],
      ],
      [
        paths.ineligibleRoot,
        [
          sessionHeader("ineligible-root"),
          assistantEntry({
            id: "canonical-error",
            provider: "provider-hidden",
            model: "ineligible",
            start: FIXED_NOW - 40 * 60_000,
            stopReason: "error",
          }),
          assistantEntry({
            id: "canonical-untimed",
            provider: "provider-hidden",
            model: "ineligible",
            start: FIXED_NOW - 39 * 60_000,
            end: "invalid",
          }),
          assistantEntry({
            id: "canonical-zero",
            provider: "provider-hidden",
            model: "ineligible",
            start: FIXED_NOW - 38 * 60_000,
            output: 0,
          }),
        ],
      ],
      [
        paths.ineligibleFork,
        [
          sessionHeader("ineligible-fork", paths.ineligibleRoot),
          ...["canonical-error", "canonical-untimed", "canonical-zero"].map((id, index) =>
            assistantEntry({
              id,
              provider: "provider-hidden",
              model: "must-stay-hidden",
              start: FIXED_NOW - (20 - index) * 60_000,
            }),
          ),
        ],
      ],
      [
        paths.invalidRoot,
        [
          sessionHeader("invalid-root"),
          assistantEntry({
            id: "invalid-does-not-claim",
            provider: "provider-l",
            model: "invalid-copy",
            start: FIXED_NOW - 30 * 60_000,
            usage: invalidUsage,
          }),
          accountingEntry({
            id: "invalid-root-ordering",
            at: FIXED_NOW - 45 * 60_000,
            provider: "provider-l",
            model: "accounting-only",
          }),
        ],
      ],
      [
        paths.invalidFork,
        [
          sessionHeader("invalid-fork", paths.invalidRoot),
          assistantEntry({
            id: "invalid-does-not-claim",
            provider: "provider-l",
            model: "invalid-copy",
            start: FIXED_NOW - 20 * 60_000,
            durationMs: 2_000,
            output: 80,
          }),
        ],
      ],
      [
        paths.usageRoot,
        [
          sessionHeader("usage-order-root"),
          route("route"),
          orderingAssistant("usage-order-choice", FIXED_NOW - 4 * 60_000, 10_000),
          accountingEntry({ id: "usage-order-end", at: FIXED_NOW - 60_000 }),
        ],
      ],
      [
        paths.usageFork,
        [
          sessionHeader("usage-order-fork", paths.usageRoot),
          route("route"),
          orderingAssistant("usage-order-choice", FIXED_NOW - 2 * 60_000, 1_000),
        ],
      ],
      [
        paths.compactionRoot,
        [
          sessionHeader("compaction-order-root"),
          route("route"),
          orderingAssistant("compaction-order-choice", FIXED_NOW - 4 * 60_000, 10_000),
          orderingEntry("compaction", "compaction-order-end", "route", FIXED_NOW - 60_000),
        ],
      ],
      [
        paths.compactionFork,
        [
          sessionHeader("compaction-order-fork", paths.compactionRoot),
          route("route"),
          orderingAssistant("compaction-order-choice", FIXED_NOW - 2 * 60_000, 1_000),
        ],
      ],
      [
        paths.summaryRoot,
        [
          sessionHeader("summary-order-root"),
          route("route"),
          orderingAssistant("summary-order-choice", FIXED_NOW - 4 * 60_000, 10_000),
          orderingEntry("branch_summary", "summary-order-end", "route", FIXED_NOW - 60_000),
        ],
      ],
      [
        paths.summaryFork,
        [
          sessionHeader("summary-order-fork", paths.summaryRoot),
          route("route"),
          orderingAssistant("summary-order-choice", FIXED_NOW - 2 * 60_000, 1_000),
        ],
      ],
    ]),
    expectedReport: {
      range: "1d",
      since: FIXED_NOW - DAY_MS,
      previousSince: FIXED_NOW - 2 * DAY_MS,
      now: FIXED_NOW,
      rows: [
        {
          provider: "provider-l",
          model: "cycle",
          samples: 2,
          previousSamples: 0,
          medianRate: 62.5,
          totalOutputTokens: 200,
          totalSeconds: 5,
          changes: [],
        },
        {
          provider: "provider-l",
          model: "invalid-copy",
          samples: 1,
          previousSamples: 0,
          medianRate: 40,
          totalOutputTokens: 80,
          totalSeconds: 2,
          changes: [],
        },
        {
          provider: "provider-l",
          model: "main",
          samples: 2,
          previousSamples: 0,
          medianRate: 35,
          totalOutputTokens: 200,
          totalSeconds: 7,
          changes: [],
        },
        {
          provider: "provider-l",
          model: "missing",
          samples: 1,
          previousSamples: 0,
          medianRate: 50,
          totalOutputTokens: 100,
          totalSeconds: 2,
          changes: [],
        },
        {
          provider: "provider-order",
          model: "ordering",
          samples: 3,
          previousSamples: 0,
          medianRate: 100,
          totalOutputTokens: 300,
          totalSeconds: 3,
          changes: [],
        },
      ],
      coverage: { assistants: 12, observed: 9, unsuccessful: 1, untimed: 1, noOutput: 1 },
      warnings: ["cyclic-lineage (1)", "broken-lineage (1)", "invalid-usage (1)"],
    },
  };
}

export const outputFixture = {
  persisted: [
    sessionHeader("output-root"),
    assistantEntry({
      id: "persisted-output",
      provider: "provider-o",
      model: "persisted",
      start: FIXED_NOW - 5_000,
      durationMs: 2_000,
      output: 100,
    }),
  ],
  outputOnly: assistantEntry({
    id: "output-only",
    provider: "provider-o",
    model: "temporary-only",
    start: FIXED_NOW - 4_000,
    durationMs: 1_000,
    output: 999,
  }).message as FixtureRow,
  expectedVisibleLines: [
    "Speed · 1d vs previous 1d",
    "Provider/model       Median tok/s Total output tokens Total request time Trend       ",
    "provider-o/persisted 50.0         100                 2.0s               insufficient",
  ],
} as const;
