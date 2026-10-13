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
import {
  CACHE_GAP_BUCKETS,
  callsInRange,
  deriveHistoryRange,
  fingerprintCall,
  type LoadedHistory,
  loadHistory,
  type NormalizedCall,
  reduceQuotaMovement,
} from "../src/history.ts";
import type { UsageBucket, UsageSnapshot, UsageSnapshotIdentity } from "../src/types.ts";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

function usage(input = 10) {
  return {
    input,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: input + 9,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
  };
}

function assistant(
  id: string,
  parentId: string | null,
  provider = "provider-a",
  model = "model-a",
  at: number | null = NOW - 1_000,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: at === null ? "invalid" : new Date(at).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: `reply-${id}` }],
      provider,
      model,
      usage: usage(),
      stopReason: "stop",
      ...(at === null ? {} : { timestamp: at }),
    },
  };
}

function standaloneUsage(
  id: string,
  parentId: string | null,
  kind = "cache_warm",
  provider = "provider-b",
  model = "model-b",
  at = NOW - 500,
) {
  return {
    type: "usage",
    id,
    parentId,
    timestamp: new Date(at).toISOString(),
    kind,
    provider,
    model,
    usage: usage(),
  };
}

function header(id: string, parentSession?: string) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: new Date(NOW - 10_000).toISOString(),
    cwd: "/project",
    ...(parentSession ? { parentSession } : {}),
  };
}

function snapshot(observationId: string) {
  return {
    version: 1,
    observationId,
    identity: { kind: "account", id: "0123456789abcdefABCDEF01" },
    modelId: "model-a",
    report: {
      providerId: "provider-a",
      providerName: "Provider A",
      capturedAt: NOW - 500,
      source: "test",
      semantics: { kind: "consumer-subscription", label: "Subscription" },
      buckets: [],
      metrics: [],
    },
  };
}

function custom(id: string, parentId: string | null, customType: string, data: unknown) {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: new Date(NOW - 500).toISOString(),
    customType,
    data,
  };
}

async function writeJsonl(path: string, values: unknown[], tail = "") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n${tail}`);
}

function manager(options: {
  id?: string;
  file?: string;
  dir: string;
  header?: Record<string, unknown>;
  entries?: Record<string, unknown>[];
}) {
  const sessionHeader = options.header ?? header(options.id ?? "active-id");
  return {
    getHeader: () => sessionHeader,
    getEntries: () => options.entries ?? [],
    getSessionFile: () => options.file,
    getSessionId: () => options.id ?? String(sessionHeader.id),
    getSessionDir: () => options.dir,
  };
}

function context(sessionManager: ReturnType<typeof manager>) {
  return { cwd: "/project", sessionManager } as never;
}

function info(path: string) {
  return { path, modified: new Date(NOW) };
}

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "pi-usage-history-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return realpath(path);
}

test("merges active unflushed entries, custom sessions, branch-safe billed calls, and records", async (t) => {
  const root = await workspace(t);
  const customDir = join(root, "custom");
  const activeFile = join(customDir, "active.jsonl");
  await mkdir(customDir, { recursive: true });
  await writeFile(activeFile, "");
  const other = join(customDir, "other.jsonl");
  await writeJsonl(other, [header("other-id"), assistant("other-call", null)]);
  const entries = [
    {
      type: "model_change",
      id: "route-a",
      parentId: null,
      timestamp: new Date(NOW - 9_000).toISOString(),
      provider: "provider-a",
      modelId: "model-a",
    },
    assistant("active-call", "route-a"),
    {
      type: "message",
      id: "user-after-active",
      parentId: "active-call",
      timestamp: new Date(NOW - 8_500).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "topology only" }] },
    },
    {
      type: "model_change",
      id: "route-b",
      parentId: "route-a",
      timestamp: new Date(NOW - 8_000).toISOString(),
      provider: "provider-b",
      modelId: "model-b",
    },
    {
      type: "compaction",
      id: "compact",
      parentId: "user-after-active",
      timestamp: new Date(NOW - 700).toISOString(),
      summary: "compact",
      usage: usage(20),
    },
    {
      type: "branch_summary",
      id: "branch",
      parentId: "route-b",
      timestamp: new Date(NOW - 600).toISOString(),
      fromId: "active-call",
      summary: "branch",
      usage: usage(30),
    },
    {
      type: "message",
      id: "tool",
      parentId: "branch",
      timestamp: new Date(NOW - 400).toISOString(),
      message: { role: "toolResult", usage: usage(999) },
    },
    custom("record", "tool", "subagents:record", { id: "agent-record", result: "ignored" }),
    {
      type: "custom",
      id: "record-without-time",
      parentId: "record",
      customType: "subagents:record",
      data: { id: "agent-untimestamped" },
    },
  ];
  const calls: Array<string | undefined> = [];
  const result = await loadHistory(
    context(manager({ file: activeFile, dir: customDir, entries })),
    {
      now: NOW,
      outputRoot: join(root, "outputs"),
      listAll: async (dir) => {
        calls.push(dir);
        return dir ? [info(activeFile), info(other)] : [info(other)];
      },
    },
  );

  assert.deepEqual(calls, [undefined, customDir]);
  assert.equal(result.calls.length, 4);
  assert.equal(result.calls.filter((call) => call.entryId === "active-call").length, 1);
  assert.deepEqual(
    result.calls
      .filter((call) => call.entryId === "compact" || call.entryId === "branch")
      .map((call) => `${call.provider}/${call.model}`)
      .sort(),
    ["provider-a/model-a", "provider-b/model-b"],
  );
  assert.deepEqual(result.subagents, [
    { id: "agent-record", timestamps: [NOW - 500] },
    { id: "agent-untimestamped", timestamps: [] },
  ]);
});

test("accounts active standalone usage without changing the inherited model route", async (t) => {
  const root = await workspace(t);
  const route = {
    type: "model_change",
    id: "route-a",
    parentId: null,
    timestamp: new Date(NOW - 2_000).toISOString(),
    provider: "provider-a",
    modelId: "model-a",
  };
  const warm = standaloneUsage(
    "warm",
    "route-a",
    "cache_warm",
    "provider-b",
    "model-b",
    NOW - 1_000,
  );
  const other = standaloneUsage(
    "other",
    "route-a",
    "background",
    "provider-b",
    "model-b",
    NOW - 500,
  );
  const result = await loadHistory(context(manager({ dir: root, entries: [route, warm, other] })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [],
  });

  assert.deepEqual(
    result.calls.map((call) => [call.entryId, call.provider, call.model]),
    [
      ["warm", "provider-b", "model-b"],
      ["other", "provider-b", "model-b"],
    ],
  );
  assert.notEqual(result.calls[0]?.contentHash, result.calls[1]?.contentHash);
  assert.deepEqual(deriveHistoryRange(result, 60_000).overview.totals, {
    input: 20,
    output: 4,
    cacheRead: 6,
    cacheWrite: 8,
    total: 38,
    cost: 0.74,
    calls: 2,
  });
});

test("canonical path merging and JSONL parsing warn for malformed interior and stable partial tails", async (t) => {
  const root = await workspace(t);
  const session = join(root, "session.jsonl");
  await mkdir(dirname(session), { recursive: true });
  await writeFile(
    session,
    `${JSON.stringify(header("root"))}\n{malformed}\n${JSON.stringify(assistant("call", null))}\n{"partial"`,
  );
  const alias = join(root, "alias.jsonl");
  await symlink(session, alias);
  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(session), info(alias)],
  });

  assert.equal(result.calls.length, 1);
  assert.equal(result.warnings.filter((item) => item.code === "malformed-jsonl").length, 2);
});

test("warns for definitively malformed and stable incomplete terminal lines", async (t) => {
  const root = await workspace(t);
  const malformed = join(root, "malformed.jsonl");
  const incomplete = join(root, "incomplete.jsonl");
  await writeFile(malformed, `${JSON.stringify(header("malformed"))}\n{malformed}`);
  await writeFile(incomplete, `${JSON.stringify(header("incomplete"))}\n{"partial"`);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(malformed), info(incomplete)],
  });

  assert.equal(result.warnings.filter((item) => item.code === "malformed-jsonl").length, 2);
  assert.deepEqual(
    result.warnings
      .filter((item) => item.code === "malformed-jsonl")
      .map((item) => item.source)
      .sort(),
    [incomplete, malformed].sort(),
  );
});

test("suppresses an incomplete terminal record only when the source actively changes", async (t) => {
  const root = await workspace(t);
  const session = join(root, "changing.jsonl");
  await writeJsonl(session, [header("changing"), assistant("call", null)]);
  let appended = false;
  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(session)],
    sourceReadStarted: async (path) => {
      if (path === session && !appended) {
        appended = true;
        await appendFile(path, '{"actively-writing"');
      }
    },
  });

  assert.equal(result.calls.length, 1);
  assert.equal(
    result.warnings.some((item) => item.code === "malformed-jsonl"),
    false,
  );
});

test("prunes source files using filesystem mtime beyond the boundary tolerance", async (t) => {
  const root = await workspace(t);
  const stale = join(root, "stale.jsonl");
  const boundary = join(root, "boundary.jsonl");
  await writeJsonl(stale, [header("stale"), assistant("stale-call", null)]);
  await writeJsonl(boundary, [header("boundary"), assistant("boundary-call", null)]);
  const cutoff = NOW - 30 * 24 * 60 * 60 * 1000 - 30 * 60 * 1000;
  await utimes(stale, new Date(cutoff - 1), new Date(cutoff - 1));
  await utimes(boundary, new Date(cutoff), new Date(cutoff));

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(stale), info(boundary)],
  });

  assert.deepEqual(
    result.calls.map((call) => call.entryId),
    ["boundary-call"],
  );
});

test("projects source rows and does not retain irrelevant or fingerprinted content", async (t) => {
  const root = await workspace(t);
  const marker = "hostile-large-tool-result".repeat(10_000);
  const call = assistant("projected", null);
  (call.message as Record<string, unknown>).content = [{ type: "text", text: marker }];
  const toolResult = {
    type: "message",
    id: "tool-result",
    parentId: "projected",
    timestamp: new Date(NOW).toISOString(),
    message: { role: "toolResult", content: [{ type: "text", text: marker }] },
  };
  const result = await loadHistory(context(manager({ dir: root, entries: [call, toolResult] })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [],
  });

  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.content, undefined);
  assert.match(result.calls[0]?.contentHash ?? "", /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /hostile-large-tool-result/);
});

test("output-only subagents use timestamp-only non-assistant rows for range counts", async (t) => {
  const root = await workspace(t);
  const outputs = join(root, "outputs");
  const recentSecret = "recent-user-secret".repeat(1_000);
  await writeJsonl(join(outputs, "cwd", "root", "tasks", "recent.output"), [
    {
      type: "user",
      timestamp: new Date(NOW - 60_000).toISOString(),
      message: { role: "user", timestamp: NOW - 60_000, content: recentSecret },
    },
    {
      type: "toolResult",
      timestamp: new Date(NOW - 30_000).toISOString(),
      message: { role: "toolResult", content: recentSecret, details: { secret: recentSecret } },
    },
  ]);
  await writeJsonl(join(outputs, "cwd", "root", "tasks", "old.output"), [
    {
      type: "user",
      timestamp: new Date(NOW - 10 * 24 * 60 * 60_000).toISOString(),
      message: { role: "user", content: "old secret" },
    },
  ]);

  const history = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: outputs,
    listAll: async () => [],
  });

  assert.equal(history.calls.length, 0);
  assert.deepEqual(history.subagents, [
    { id: "old", timestamps: [NOW - 10 * 24 * 60 * 60_000] },
    { id: "recent", timestamps: [NOW - 60_000, NOW - 30_000] },
  ]);
  assert.equal(deriveHistoryRange(history, 24 * 60 * 60_000).overview.subagents, 1);
  assert.equal(deriveHistoryRange(history, 30 * 24 * 60 * 60_000).overview.subagents, 2);
  assert.equal(JSON.stringify(history).includes("recent-user-secret"), false);
});

test("derives provider tokens from components instead of persisted totalTokens", async (t) => {
  const root = await workspace(t);
  const call = assistant("inconsistent-total", null);
  const persistedUsage = (call.message as { usage: ReturnType<typeof usage> }).usage;
  persistedUsage.totalTokens = 999;

  const result = await loadHistory(context(manager({ dir: root, entries: [call] })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [],
  });

  assert.equal(result.calls[0]?.usage.totalTokens, 19);
});

test("rejects malformed usage fields while preserving valid integer zero usage", async (t) => {
  const root = await workspace(t);
  const validZero = assistant("zero", null);
  (validZero.message as Record<string, unknown>).usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const invalid: Record<string, unknown>[] = [];
  for (const [name, mutate] of [
    ["missing-token", (value: Record<string, unknown>) => delete value.input],
    ["negative-token", (value: Record<string, unknown>) => (value.output = -1)],
    ["fractional-token", (value: Record<string, unknown>) => (value.cacheRead = 0.5)],
    ["unsafe-token", (value: Record<string, unknown>) => (value.cacheWrite = Number.MAX_VALUE)],
    [
      "overflowing-sum",
      (value: Record<string, unknown>) => {
        value.input = Number.MAX_SAFE_INTEGER;
        value.output = 1;
        value.cacheRead = 0;
        value.cacheWrite = 0;
      },
    ],
    ["missing-cost", (value: Record<string, unknown>) => delete value.cost],
    [
      "negative-cost",
      (value: Record<string, unknown>) => ((value.cost as Record<string, unknown>).total = -0.1),
    ],
    [
      "nonfinite-cost",
      (value: Record<string, unknown>) =>
        ((value.cost as Record<string, unknown>).input = Number.POSITIVE_INFINITY),
    ],
  ] as const) {
    const entry = assistant(name, null);
    const value = structuredClone((entry.message as Record<string, unknown>).usage) as Record<
      string,
      unknown
    >;
    mutate(value);
    (entry.message as Record<string, unknown>).usage = value;
    invalid.push(entry);
  }
  const result = await loadHistory(
    context(manager({ dir: root, entries: [validZero, ...invalid] })),
    { now: NOW, outputRoot: join(root, "outputs"), listAll: async () => [] },
  );

  assert.deepEqual(
    result.calls.map((call) => call.entryId),
    ["zero"],
  );
  assert.equal(result.calls[0]?.usage.totalTokens, 0);
  assert.equal(
    result.warnings.filter((item) => item.code === "invalid-usage").length,
    invalid.length,
  );
  assert.ok(result.warnings.every((item) => !item.message.includes(root)));
});

test("usage projection drops unknown nested and large fields before loaded history is retained", async (t) => {
  const root = await workspace(t);
  const secret = "usage-secret".repeat(10_000);
  const sessionCall = assistant("session-secret", null);
  const sessionUsage = (sessionCall.message as Record<string, unknown>).usage as Record<
    string,
    unknown
  >;
  sessionUsage.providerPayload = { authorization: secret };
  (sessionUsage.cost as Record<string, unknown>).debug = { response: secret };
  const malformed = assistant("malformed-secret", "session-secret");
  (malformed.message as Record<string, unknown>).usage = {
    input: secret,
    unknown: { secret },
    cost: { total: secret, payload: secret },
  };
  const outputs = join(root, "outputs");
  const outputCall = assistant("output-secret", null);
  const outputUsage = (outputCall.message as Record<string, unknown>).usage as Record<
    string,
    unknown
  >;
  outputUsage.unknown = { token: secret };
  await writeJsonl(join(outputs, "cwd", "root", "tasks", "agent.output"), [
    { timestamp: NOW, message: outputCall.message },
  ]);

  const history = await loadHistory(
    context(manager({ dir: root, entries: [sessionCall, malformed] })),
    { now: NOW, outputRoot: outputs, listAll: async () => [] },
  );

  assert.equal(history.calls.length, 2);
  assert.equal(history.warnings.filter((item) => item.code === "invalid-usage").length, 1);
  const serialized = JSON.stringify(history);
  assert.equal(serialized.includes("usage-secret"), false);
  assert.doesNotMatch(serialized, /providerPayload|authorization|debug|payload/);
});

test("warns for malformed snapshots and retains their usable capture timestamp", async (t) => {
  const root = await workspace(t);
  const session = join(root, "malformed-snapshot.jsonl");
  const malformed = snapshot("malformed-observation");
  malformed.report.buckets.push({ id: "bucket", label: "Bucket", unit: "invalid" } as never);
  await writeJsonl(session, [
    header("root"),
    custom("snapshot", null, "pi-usage:snapshot", malformed),
  ]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(session)],
  });

  assert.equal(result.snapshots.length, 0);
  assert.deepEqual(
    result.warnings.find((item) => item.code === "malformed-snapshot"),
    {
      code: "malformed-snapshot",
      message: "Usage snapshot has an invalid version-1 shape",
      source: session,
      timestamp: NOW - 500,
    },
  );
});

test("malformed snapshot fallback drops non-finite capturedAt", async (t) => {
  const root = await workspace(t);
  const malformed = snapshot("non-finite") as unknown as Record<string, unknown>;
  (malformed.report as Record<string, unknown>).capturedAt = Number.POSITIVE_INFINITY;
  (malformed.report as Record<string, unknown>).buckets = "invalid";
  const history = await loadHistory(
    context(
      manager({
        dir: root,
        entries: [custom("snapshot", null, "pi-usage:snapshot", malformed)],
      }),
    ),
    { now: NOW, outputRoot: join(root, "outputs"), listAll: async () => [] },
  );
  const warning = history.warnings.find((item) => item.code === "malformed-snapshot");
  assert.ok(warning);
  assert.equal(warning.timestamp, undefined);
  assert.equal(JSON.stringify(history).includes("null"), false);
});

test("rejects snapshot identities outside the version-1 24-hex contract", async (t) => {
  const root = await workspace(t);
  const invalid = snapshot("invalid-identity");
  invalid.identity.id = "not-a-24-character-hash";
  const session = join(root, "invalid-identity.jsonl");
  await writeJsonl(session, [
    header("root"),
    custom("snapshot", null, "pi-usage:snapshot", invalid),
  ]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(session)],
  });
  assert.equal(result.snapshots.length, 0);
  assert.ok(result.warnings.some((item) => item.code === "malformed-snapshot"));
});

test("LoadedHistory retains only validated snapshot scalars", async (t) => {
  const root = await workspace(t);
  const value = snapshot("projected-snapshot") as unknown as Record<string, unknown>;
  const identity = value.identity as Record<string, unknown>;
  const report = value.report as Record<string, unknown>;
  const semantics = report.semantics as Record<string, unknown>;
  const bucket = {
    id: "codex:primary",
    label: "Primary limit",
    groupId: "codex",
    groupLabel: "Codex",
    modelKeys: ["private-model-key"],
    unit: "percent",
    used: 10,
    remaining: 90,
    limit: 100,
  };
  const additionalBucket = {
    id: "gpt-5.3-codex-spark:primary",
    label: "Primary limit",
    groupId: "gpt-5.3-codex-spark",
    groupLabel: "GPT-5.3 Codex Spark",
    modelKeys: ["gpt-5.3-codex-spark"],
    unit: "percent",
    used: 20,
  };
  const legacyBucket = { id: "legacy", label: "Legacy limit", unit: "percent", used: 30 };
  report.buckets = [bucket, additionalBucket, legacyBucket];
  identity.secret = "identity-credential-secret";
  semantics.authorization = "semantics-credential-secret";
  report.unknownAuth = { token: "report-credential-secret" };
  bucket.headers = { authorization: "bucket-credential-secret" };
  const session = join(root, "projected-snapshot.jsonl");
  await writeJsonl(session, [header("root"), custom("snapshot", null, "pi-usage:snapshot", value)]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(session)],
  });

  assert.equal(result.snapshots.length, 1);
  const serialized = JSON.stringify(result);
  for (const secret of [
    "identity-credential-secret",
    "semantics-credential-secret",
    "report-credential-secret",
    "bucket-credential-secret",
    "unknownAuth",
    "authorization",
    "headers",
    "modelKeys",
    "private-model-key",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(result.snapshots[0]?.snapshot.identity, {
    kind: "account",
    id: "0123456789abcdefABCDEF01",
  });
  assert.deepEqual(result.snapshots[0]?.snapshot.report.semantics, {
    kind: "consumer-subscription",
    label: "Subscription",
  });
  assert.deepEqual(result.snapshots[0]?.snapshot.report.buckets, [
    {
      id: "codex:primary",
      label: "Primary limit",
      groupId: "codex",
      groupLabel: "Codex",
      unit: "percent",
      used: 10,
      remaining: 90,
      limit: 100,
    },
    {
      id: "gpt-5.3-codex-spark:primary",
      label: "Primary limit",
      groupId: "gpt-5.3-codex-spark",
      groupLabel: "GPT-5.3 Codex Spark",
      unit: "percent",
      used: 20,
    },
    { id: "legacy", label: "Legacy limit", unit: "percent", used: 30 },
  ]);
  const quotaBuckets = deriveHistoryRange(result, 60_000).quotas.providers[0]?.identities[0]
    ?.buckets;
  assert.deepEqual(
    quotaBuckets
      ?.map((item) => ({
        id: item.id,
        groupId: item.latest.groupId,
        groupLabel: item.latest.groupLabel,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "codex:primary", groupId: "codex", groupLabel: "Codex" },
      {
        id: "gpt-5.3-codex-spark:primary",
        groupId: "gpt-5.3-codex-spark",
        groupLabel: "GPT-5.3 Codex Spark",
      },
      { id: "legacy", groupId: undefined, groupLabel: undefined },
    ],
  );
});

test("deduplicates inherited entry IDs only in verified lineages and snapshots globally", async (t) => {
  const root = await workspace(t);
  const original = join(root, "original.jsonl");
  const fork = join(root, "fork.jsonl");
  const unrelated = join(root, "unrelated.jsonl");
  const call = assistant("short-id", null);
  const snap = custom("snap", "short-id", "pi-usage:snapshot", snapshot("observation"));
  await writeJsonl(original, [header("original"), call, snap]);
  await writeJsonl(fork, [
    header("fork", original),
    call,
    snap,
    assistant("later", "short-id", "provider-a", "model-a", NOW),
  ]);
  await writeJsonl(unrelated, [header("unrelated"), call]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(fork), info(unrelated), info(original)],
  });

  assert.equal(result.calls.filter((item) => item.entryId === "short-id").length, 2);
  assert.equal(result.calls.filter((item) => item.entryId === "later").length, 1);
  assert.equal(result.snapshots.length, 1);
});

test("canonicalizes fork predecessors after inherited entry deduplication", async (t) => {
  const root = await workspace(t);
  const original = join(root, "original-cache.jsonl");
  const fork = join(root, "fork-cache.jsonl");
  const first = assistant("a", null, "provider-a", "model-a", NOW - 60_000);
  await writeJsonl(original, [header("original-cache"), first]);
  await writeJsonl(fork, [
    header("fork-cache", original),
    first,
    assistant("b", "a", "provider-a", "model-a", NOW - 1_000),
  ]);

  const history = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(fork), info(original)],
  });
  const calls = history.calls.filter((call) => call.lineageId);
  const predecessor = calls.find((call) => call.entryId === "a");
  const successor = calls.find((call) => call.entryId === "b");
  assert.equal(successor?.predecessorKey, predecessor?.key);
  assert.equal(deriveHistoryRange(history, 2 * 60_000).cache.rows[0]?.gaps["<1m"].samples, 1);
});

test("treats the first session below a missing parent as a deduplicable lineage root", async (t) => {
  const root = await workspace(t);
  const survivor = join(root, "survivor.jsonl");
  const descendant = join(root, "descendant.jsonl");
  const copied = assistant("copied", null);
  await writeJsonl(survivor, [header("survivor", join(root, "deleted.jsonl")), copied]);
  await writeJsonl(descendant, [header("descendant", survivor), copied]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(descendant), info(survivor)],
  });

  assert.equal(result.calls.length, 1);
  assert.ok(result.warnings.some((item) => item.code === "broken-lineage"));
});

test("does not deduplicate entry IDs across broken or cyclic lineages", async (t) => {
  const root = await workspace(t);
  const first = join(root, "first.jsonl");
  const second = join(root, "second.jsonl");
  const broken = join(root, "broken.jsonl");
  await writeJsonl(first, [header("first", second), assistant("same", null)]);
  await writeJsonl(second, [header("second", first), assistant("same", null)]);
  await writeJsonl(broken, [
    header("broken", join(root, "missing.jsonl")),
    assistant("same", null),
  ]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(first), info(second), info(broken)],
  });

  assert.equal(result.calls.length, 3);
  assert.ok(result.warnings.some((item) => item.code === "cyclic-lineage"));
  assert.ok(result.warnings.some((item) => item.code === "broken-lineage"));
});

test("accounts persisted standalone usage, copied lineage entries, and invalid records", async (t) => {
  const root = await workspace(t);
  const original = join(root, "original-usage.jsonl");
  const fork = join(root, "fork-usage.jsonl");
  const invalid = join(root, "invalid-usage.jsonl");
  const route = {
    type: "model_change",
    id: "route-a",
    parentId: null,
    timestamp: new Date(NOW - 2_000).toISOString(),
    provider: "provider-a",
    modelId: "model-a",
  };
  const warm = standaloneUsage("warm", "route-a", "cache_warm", "provider-b", "model-b");
  await writeJsonl(original, [header("original-usage"), route, warm]);
  await writeJsonl(fork, [header("fork-usage", original), route, warm]);
  await writeJsonl(invalid, [
    header("invalid-usage"),
    {
      ...standaloneUsage("bad", null),
      usage: { ...usage(), input: -1 },
    },
    standaloneUsage("unattributed", null, "cache_warm", "", ""),
  ]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(fork), info(original), info(invalid)],
  });

  assert.equal(result.calls.filter((call) => call.entryId === "warm").length, 1);
  assert.equal(result.calls[0]?.provider, "provider-b");
  assert.equal(result.calls[0]?.model, "model-b");
  assert.deepEqual(deriveHistoryRange(result, 60_000).overview.totals, {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 19,
    cost: 0.37,
    calls: 1,
  });
  assert.equal(result.warnings.filter((item) => item.code === "invalid-usage").length, 1);
  assert.equal(result.warnings.filter((item) => item.code === "unattributable-call").length, 1);
});

test("warns when usage-bearing persisted calls have no exact inherited route", async (t) => {
  const root = await workspace(t);
  const session = join(root, "orphan.jsonl");
  await writeJsonl(session, [
    header("orphan"),
    {
      type: "compaction",
      id: "compact-recent",
      parentId: "missing-entry",
      timestamp: new Date(NOW - 500).toISOString(),
      summary: "orphaned recent",
      usage: usage(),
    },
    {
      type: "compaction",
      id: "compact-old",
      parentId: "missing-entry",
      timestamp: new Date(NOW - 6 * 24 * 60 * 60_000).toISOString(),
      summary: "orphaned old",
      usage: usage(),
    },
  ]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [info(session)],
  });

  assert.equal(result.calls.length, 0);
  assert.equal(
    deriveHistoryRange(result, 24 * 60 * 60_000).warnings.filter(
      (item) => item.code === "unattributable-call",
    ).length,
    1,
  );
  assert.equal(
    deriveHistoryRange(result, 7 * 24 * 60 * 60_000).warnings.filter(
      (item) => item.code === "unattributable-call",
    ).length,
    2,
  );
});

test("warns when usage-bearing output calls have no exact route", async (t) => {
  const root = await workspace(t);
  const outputs = join(root, "outputs");
  const message = assistant("output", null).message as Record<string, unknown>;
  delete message.provider;
  const transcript = join(outputs, "cwd", "root", "tasks", "nested.output");
  const oldMessage = assistant(
    "old-output",
    null,
    "provider-a",
    "model-a",
    NOW - 6 * 24 * 60 * 60_000,
  ).message as Record<string, unknown>;
  delete oldMessage.provider;
  await writeJsonl(transcript, [
    { type: "assistant", message, timestamp: new Date(NOW).toISOString() },
    {
      type: "assistant",
      message: oldMessage,
      timestamp: new Date(NOW - 6 * 24 * 60 * 60_000).toISOString(),
    },
  ]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: outputs,
    listAll: async () => [],
  });

  assert.equal(result.calls.length, 0);
  assert.ok(
    result.warnings.some(
      (item) =>
        item.code === "unattributable-call" && item.source === transcript && item.line === 1,
    ),
  );
  assert.equal(
    deriveHistoryRange(result, 24 * 60 * 60_000).warnings.filter(
      (item) => item.code === "unattributable-call",
    ).length,
    1,
  );
  assert.equal(
    deriveHistoryRange(result, 7 * 24 * 60 * 60_000).warnings.filter(
      (item) => item.code === "unattributable-call",
    ).length,
    2,
  );
});

test("suppresses only an unambiguous same-lineage persisted/output assistant copy", async (t) => {
  const root = await workspace(t);
  const sessions = join(root, "sessions");
  const parent = join(sessions, "parent.jsonl");
  const child = join(sessions, "child.jsonl");
  const call = assistant("persisted", null);
  await writeJsonl(parent, [header("root-session")]);
  await writeJsonl(child, [header("child-session", parent), call]);
  const outputs = join(root, "pi-subagents-test");
  await writeJsonl(join(outputs, "encoded", "root-session", "tasks", "agent-a.output"), [
    {
      type: "assistant",
      agentId: "agent-a",
      timestamp: new Date(NOW).toISOString(),
      message: call.message,
    },
    {
      type: "toolResult",
      agentId: "agent-a",
      timestamp: new Date(NOW).toISOString(),
      message: { role: "toolResult", usage: usage(999) },
    },
  ]);
  for (const agent of ["agent-b", "agent-c"]) {
    await writeJsonl(join(outputs, "encoded", `unrelated-${agent}`, "tasks", `${agent}.output`), [
      {
        type: "assistant",
        agentId: agent,
        timestamp: new Date(NOW).toISOString(),
        message: call.message,
      },
    ]);
  }

  const result = await loadHistory(context(manager({ dir: sessions })), {
    now: NOW,
    outputRoot: outputs,
    listAll: async () => [info(parent), info(child)],
  });

  assert.equal(result.calls.length, 3);
  assert.equal(result.calls.filter((item) => item.source.kind === "output").length, 2);
  assert.deepEqual(result.subagents, [
    { id: "agent-a", timestamps: [NOW - 1_000, NOW] },
    { id: "agent-b", timestamps: [NOW - 1_000] },
    { id: "agent-c", timestamps: [NOW - 1_000] },
  ]);
});

test("retains all calls when multiple outputs share one persisted fingerprint", async (t) => {
  const root = await workspace(t);
  const sessions = join(root, "sessions");
  const persisted = join(sessions, "root.jsonl");
  const recentCall = assistant("persisted-recent", null);
  const oldCall = assistant(
    "persisted-old",
    null,
    "provider-a",
    "model-a",
    NOW - 6 * 24 * 60 * 60_000,
  );
  await writeJsonl(persisted, [header("root-session"), recentCall, oldCall]);
  const outputs = join(root, "outputs");
  for (const agent of ["agent-a", "agent-b"]) {
    await writeJsonl(join(outputs, "cwd", "root-session", "tasks", `${agent}.output`), [
      {
        type: "assistant",
        message: recentCall.message,
        timestamp: new Date(NOW).toISOString(),
      },
      {
        type: "assistant",
        message: oldCall.message,
        timestamp: new Date(NOW - 6 * 24 * 60 * 60_000).toISOString(),
      },
    ]);
  }

  const result = await loadHistory(context(manager({ dir: sessions })), {
    now: NOW,
    outputRoot: outputs,
    listAll: async () => [info(persisted)],
  });

  assert.equal(result.calls.length, 6);
  assert.equal(result.calls.filter((item) => item.source.kind === "output").length, 4);
  assert.equal(result.warnings.filter((item) => item.code === "ambiguous-output-match").length, 2);
  assert.equal(
    deriveHistoryRange(result, 24 * 60 * 60_000).warnings.filter(
      (item) => item.code === "ambiguous-output-match",
    ).length,
    1,
  );
  assert.equal(
    deriveHistoryRange(result, 7 * 24 * 60 * 60_000).warnings.filter(
      (item) => item.code === "ambiguous-output-match",
    ).length,
    2,
  );
});

test("discovers root-cwd output transcripts without an encoded cwd component", async (t) => {
  const root = await workspace(t);
  const outputs = join(root, "outputs");
  await writeJsonl(join(outputs, "root-session", "tasks", "root-agent.output"), [
    {
      type: "assistant",
      message: assistant("output", null).message,
      timestamp: new Date(NOW).toISOString(),
    },
  ]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: outputs,
    listAll: async () => [],
  });

  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.source.rootSessionId, "root-session");
  assert.deepEqual(result.subagents, [{ id: "root-agent", timestamps: [NOW - 1_000] }]);
});

test("warns when the transcript root exists but cannot be enumerated", async (t) => {
  const root = await workspace(t);
  const outputRoot = join(root, "not-a-directory");
  await writeFile(outputRoot, "content");

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot,
    listAll: async () => [],
  });

  assert.ok(
    result.warnings.some((item) => item.code === "unreadable-source" && item.source === outputRoot),
  );
});

test("retains ambiguous output associations and output-only nested calls with a warning", async (t) => {
  const root = await workspace(t);
  const first = join(root, "first.jsonl");
  const second = join(root, "second.jsonl");
  const call = assistant("one", null);
  await writeJsonl(first, [header("duplicate-root"), call]);
  await writeJsonl(second, [header("duplicate-root"), assistant("two", null)]);
  const outputs = join(root, "outputs");
  await writeJsonl(join(outputs, "cwd", "duplicate-root", "tasks", "nested.output"), [
    { type: "assistant", message: call.message, timestamp: new Date(NOW).toISOString() },
  ]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: outputs,
    listAll: async () => [info(first), info(second)],
  });

  assert.equal(result.calls.length, 3);
  assert.ok(result.warnings.some((item) => item.code === "ambiguous-output-match"));
  assert.deepEqual(result.subagents, [{ id: "nested", timestamps: [NOW - 1_000] }]);
});

test("uses output flush time only as an imprecise fallback", async (t) => {
  const root = await workspace(t);
  const outputs = join(root, "outputs");
  const message = assistant("output", null).message;
  delete (message as { timestamp?: number }).timestamp;
  await writeJsonl(join(outputs, "cwd", "root", "tasks", "nested.output"), [
    { type: "assistant", message, timestamp: new Date(NOW - 123).toISOString() },
  ]);

  const result = await loadHistory(context(manager({ dir: root })), {
    now: NOW,
    outputRoot: outputs,
    listAll: async () => [],
  });

  assert.equal(result.calls[0]?.timestamp, NOW - 123);
  assert.equal(result.calls[0]?.timestampFidelity, "flush");
  assert.equal(result.calls[0]?.preciseTimestamp, false);
});

test("cancellation during active-path canonicalization prevents session listing", async (t) => {
  const root = await workspace(t);
  const activeFile = join(root, "active.jsonl");
  await writeFile(activeFile, "");
  const controller = new AbortController();
  let listAllCalls = 0;
  const active = manager({ dir: root, file: activeFile });
  const wrapped = {
    ...active,
    getSessionFile() {
      queueMicrotask(() => controller.abort());
      return activeFile;
    },
  };

  await assert.rejects(
    loadHistory(context(wrapped), {
      now: NOW,
      signal: controller.signal,
      outputRoot: join(root, "outputs"),
      listAll: async () => {
        listAllCalls += 1;
        return [];
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(listAllCalls, 0);
});

test("cancellation stops immediately after listAll and inside owned enumeration", async (t) => {
  const root = await workspace(t);
  const controller = new AbortController();
  let sessionDirRead = false;
  const active = manager({ dir: root });
  const wrapped = {
    ...active,
    getSessionDir() {
      sessionDirRead = true;
      return root;
    },
  };
  await assert.rejects(
    loadHistory(context(wrapped), {
      now: NOW,
      signal: controller.signal,
      outputRoot: join(root, "outputs"),
      listAll: async () => {
        controller.abort();
        return [];
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(sessionDirRead, false);

  const secondController = new AbortController();
  const listed = info(join(root, "never-read.jsonl"));
  Object.defineProperty(listed, "path", {
    get() {
      secondController.abort();
      return join(root, "never-read.jsonl");
    },
  });
  await assert.rejects(
    loadHistory(context(active), {
      now: NOW,
      signal: secondController.signal,
      outputRoot: join(root, "outputs"),
      listAll: async () => [listed],
    }),
    { name: "AbortError" },
  );
});

test("invalid-usage warnings follow call timestamps while untimestamped diagnostics remain visible", async (t) => {
  const root = await workspace(t);
  const invalidAt = (id: string, at: number | null) => {
    const entry = assistant(id, null, "provider-a", "model-a", at);
    (entry.message as Record<string, unknown>).usage = {
      input: -1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    return entry;
  };
  const history = await loadHistory(
    context(
      manager({
        dir: root,
        entries: [
          invalidAt("old-invalid", NOW - 10 * 24 * 60 * 60_000),
          invalidAt("untimestamped-invalid", null),
        ],
      }),
    ),
    { now: NOW, outputRoot: join(root, "outputs"), listAll: async () => [] },
  );

  const oneDay = deriveHistoryRange(history, 24 * 60 * 60_000).warnings.filter(
    (item) => item.code === "invalid-usage",
  );
  const thirtyDays = deriveHistoryRange(history, 30 * 24 * 60 * 60_000).warnings.filter(
    (item) => item.code === "invalid-usage",
  );
  assert.equal(oneDay.length, 1);
  assert.equal(oneDay[0]?.timestamp, undefined);
  assert.equal(thirtyDays.length, 2);
  assert.ok(thirtyDays.some((item) => item.timestamp === NOW - 10 * 24 * 60 * 60_000));
});

test("retains untimestamped usage for later exclusion and uses closed rolling boundaries", async (t) => {
  const root = await workspace(t);
  const entries = [
    assistant("lower", null, "provider-a", "model-a", NOW - 24 * 60 * 60 * 1000),
    assistant("upper", "lower", "provider-a", "model-a", NOW),
    assistant("before", "upper", "provider-a", "model-a", NOW - 24 * 60 * 60 * 1000 - 1),
    assistant("future", "before", "provider-a", "model-a", NOW + 1),
    assistant("missing", "future", "provider-a", "model-a", null),
  ];
  const result = await loadHistory(context(manager({ dir: root, entries })), {
    now: NOW,
    outputRoot: join(root, "outputs"),
    listAll: async () => [],
  });

  assert.equal(result.calls.length, 5);
  assert.deepEqual(
    callsInRange(result, 24 * 60 * 60 * 1000)
      .map((call) => call.entryId)
      .sort(),
    ["lower", "upper"],
  );
  assert.ok(result.warnings.some((item) => item.code === "untimestamped-call"));
});

function normalizedCall(options: {
  key: string;
  at?: number;
  provider?: string;
  model?: string;
  conversation?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  precise?: boolean;
  sourceKind?: "session" | "output";
  agentId?: string;
}): NormalizedCall {
  const input = options.input ?? 0;
  const output = options.output ?? 0;
  const cacheRead = options.cacheRead ?? 0;
  const cacheWrite = options.cacheWrite ?? 0;
  const provider = options.provider ?? "provider-a";
  const model = options.model ?? "model-a";
  return {
    key: options.key,
    provider,
    model,
    timestamp: options.at,
    timestampFidelity:
      options.at === undefined ? "missing" : options.precise === false ? "flush" : "embedded",
    preciseTimestamp: options.precise !== false && options.at !== undefined,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: options.cost ?? 0 },
    },
    content: [],
    source: {
      kind: options.sourceKind ?? "session",
      id: `source-${options.conversation ?? "root"}`,
      ...(options.agentId ? { agentId: options.agentId, rootSessionId: "root" } : {}),
    },
    conversationId: options.conversation ?? "root",
    lineageId: options.sourceKind === "output" ? undefined : (options.conversation ?? "root"),
  };
}

function loaded(calls: NormalizedCall[], snapshots: UsageSnapshot[] = []): LoadedHistory {
  return {
    now: NOW,
    calls,
    snapshots: snapshots.map((item) => ({
      snapshot: item,
      source: { kind: "session", id: `snapshot-${item.observationId}` },
    })),
    warnings: [],
    subagents: [],
  };
}

function quotaSnapshot(options: {
  id: string;
  at: number;
  bucket: UsageBucket;
  provider?: string;
  identity?: UsageSnapshotIdentity;
  providerName?: string;
}): UsageSnapshot {
  return {
    version: 1,
    observationId: options.id,
    identity: options.identity ?? { kind: "account", id: "account-a" },
    modelId: "model-a",
    report: {
      providerId: options.provider ?? "provider-a",
      providerName: options.providerName ?? "Provider A",
      capturedAt: options.at,
      source: "test",
      semantics: { kind: "consumer-subscription", label: "Subscription" },
      buckets: [options.bucket],
      metrics: [],
    },
  };
}

function percentBucket(used: number, extra: Partial<UsageBucket> = {}): UsageBucket {
  return { id: "window", label: "Window", unit: "percent", used, ...extra };
}

test("aggregates exact token and cost totals, cache denominators, model order, roots, and rolling bounds", () => {
  const calls = [
    normalizedCall({
      key: "a",
      at: NOW - 1,
      provider: "z",
      model: "small",
      input: 2,
      output: 3,
      cacheRead: 5,
      cacheWrite: 7,
      cost: 1.25,
      conversation: "root-a",
    }),
    normalizedCall({
      key: "b",
      at: NOW - 2,
      provider: "a",
      model: "large",
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 2.5,
      conversation: "root-b",
    }),
    normalizedCall({
      key: "c",
      at: NOW - 3,
      provider: "b",
      model: "tie",
      input: 30,
      conversation: "root-c",
    }),
    normalizedCall({ key: "old", at: NOW - 24 * 60 * 60 * 1000 - 1, input: 999 }),
  ];
  const history = loaded(calls);
  history.subagents = [
    { id: "inside", timestamps: [NOW] },
    { id: "outside", timestamps: [NOW - 24 * 60 * 60 * 1000 - 1] },
    { id: "untimestamped", timestamps: [] },
  ];
  const view = deriveHistoryRange(history, 24 * 60 * 60 * 1000);

  assert.deepEqual(view.overview.totals, {
    input: 52,
    output: 13,
    cacheRead: 5,
    cacheWrite: 7,
    total: 77,
    cost: 3.75,
    calls: 3,
  });
  assert.equal(view.overview.cachedInputShare, (5 * 100) / 64);
  assert.equal(view.overview.callsReadingCache, 100 / 3);
  assert.equal(view.overview.rootSessions, 3);
  assert.equal(view.overview.subagents, 1);
  assert.deepEqual(
    view.models.map((row) => row.route),
    ["a/large", "b/tie", "z/small"],
  );

  const zero = deriveHistoryRange(
    loaded([normalizedCall({ key: "zero", at: NOW, output: 5 })]),
    1_000,
  );
  assert.equal(zero.overview.cachedInputShare, undefined);
  assert.equal(zero.overview.callsReadingCache, 0);
  assert.equal(deriveHistoryRange(loaded([]), 1_000).overview.callsReadingCache, undefined);
});

test("cache reuse covers every exact gap boundary and the fifty-percent threshold", () => {
  const boundaries = [
    [59_999, "<1m"],
    [60_000, "1–5m"],
    [5 * 60_000, "5–10m"],
    [10 * 60_000, "10–30m"],
    [30 * 60_000, "30–60m"],
    [60 * 60_000, "1h+"],
  ] as const;
  const calls: NormalizedCall[] = [];
  boundaries.forEach(([gap], index) => {
    const start = NOW - 2 * 60 * 60_000 + index;
    calls.push(
      normalizedCall({
        key: `p-${index}`,
        at: start,
        conversation: `c-${index}`,
        input: 40,
        output: 20,
        cacheRead: 20,
        cacheWrite: 20,
      }),
      normalizedCall({
        key: `n-${index}`,
        at: start + gap,
        conversation: `c-${index}`,
        cacheRead: 50,
      }),
    );
  });
  for (const [suffix, cacheRead] of [
    ["below", 49.999],
    ["at", 50],
    ["above", 51],
  ] as const) {
    calls.push(
      normalizedCall({
        key: `threshold-p-${suffix}`,
        at: NOW - 10_000,
        conversation: `threshold-${suffix}`,
        input: 100,
      }),
      normalizedCall({
        key: `threshold-n-${suffix}`,
        at: NOW - 9_000,
        conversation: `threshold-${suffix}`,
        cacheRead,
      }),
    );
  }
  const row = deriveHistoryRange(loaded(calls), 3 * 60 * 60_000).cache.rows[0];
  assert.ok(row);
  for (const [, bucket] of boundaries) assert.ok((row.gaps[bucket]?.samples ?? 0) >= 1);
  assert.equal(row.gaps["<1m"].samples, 4);
  assert.equal(row.gaps["<1m"].hits, 3);
  assert.equal(row.gaps["<1m"].percentage, 75);
  assert.deepEqual(
    CACHE_GAP_BUCKETS.filter((bucket) => row.gaps[bucket].percentage === undefined),
    [],
  );
});

test("persisted cache transitions follow branch ancestry instead of crossing siblings", async (t) => {
  const root = await workspace(t);
  const activeFile = join(root, "active.jsonl");
  await writeFile(activeFile, "");
  const entries = [
    assistant("a", null, "provider-a", "model-a", NOW - 70_000),
    assistant("b", "a", "provider-a", "model-a", NOW - 20_000),
    assistant("c", "a", "provider-a", "model-a", NOW),
  ];
  const history = await loadHistory(context(manager({ dir: root, file: activeFile, entries })), {
    now: NOW,
    listAll: async () => [],
    outputRoot: join(root, "outputs"),
  });
  const row = deriveHistoryRange(history, 2 * 60_000).cache.rows[0];
  assert.equal(row?.gaps["<1m"].samples, 1);
  assert.equal(row?.gaps["1–5m"].samples, 1);
});

test("cache transitions reject route switches, invalid gaps, zero context, and imprecise timing", () => {
  const calls = [
    normalizedCall({ key: "route-a", at: NOW - 10_000, conversation: "switch", input: 10 }),
    normalizedCall({
      key: "route-b",
      at: NOW - 9_000,
      conversation: "switch",
      provider: "provider-b",
      cacheRead: 10,
    }),
    normalizedCall({ key: "zero-a", at: NOW - 8_000, conversation: "zero" }),
    normalizedCall({ key: "zero-b", at: NOW - 7_000, conversation: "zero", cacheRead: 10 }),
    normalizedCall({
      key: "imprecise-a",
      at: NOW - 6_000,
      conversation: "imprecise",
      input: 10,
      precise: false,
      sourceKind: "output",
    }),
    normalizedCall({
      key: "imprecise-b",
      at: NOW - 5_000,
      conversation: "imprecise",
      cacheRead: 10,
      sourceKind: "output",
    }),
    normalizedCall({
      key: "miss-a",
      at: NOW - 4_000,
      conversation: "miss",
      model: "model-miss",
      input: 100,
    }),
    normalizedCall({
      key: "miss-b",
      at: NOW - 3_000,
      conversation: "miss",
      model: "model-miss",
    }),
  ];
  const view = deriveHistoryRange(loaded(calls), 60_000);
  const miss = view.cache.rows.find((row) => row.model === "model-miss");
  assert.deepEqual(miss?.gaps["<1m"], { hits: 0, samples: 1, percentage: 0 });
  for (const row of view.cache.rows.filter((item) => item !== miss)) {
    assert.equal(
      Object.values(row.gaps).reduce((sum, cell) => sum + cell.samples, 0),
      0,
    );
    assert.ok(Object.values(row.gaps).every((cell) => cell.percentage === undefined));
  }
  assert.ok(view.warnings.some((item) => item.code === "imprecise-gap-timing"));
});

test("imprecise gap warnings require an otherwise eligible transition", () => {
  const cases = [
    ["lone", [normalizedCall({ key: "only", at: NOW, precise: false, sourceKind: "output" })]],
    [
      "route-switch",
      [
        normalizedCall({
          key: "a",
          at: NOW - 1_000,
          input: 10,
          precise: false,
          sourceKind: "output",
        }),
        normalizedCall({ key: "b", at: NOW, provider: "other", input: 10 }),
      ],
    ],
    [
      "no-predecessor",
      [
        {
          ...normalizedCall({
            key: "root",
            at: NOW,
            input: 10,
            precise: false,
            sourceKind: "output",
          }),
          predecessorKey: null,
        },
      ],
    ],
  ] as const;
  for (const [name, calls] of cases) {
    const view = deriveHistoryRange(loaded([...calls]), 60_000);
    assert.equal(
      view.warnings.some((item) => item.code === "imprecise-gap-timing"),
      false,
      name,
    );
  }
});

test("quota percentage units and running-peak reset heuristic preserve raw state", () => {
  assert.deepEqual(reduceQuotaMovement([10, 30, 25, 40]), {
    latestPercentage: 40,
    observedPeak: 40,
    observedConsumption: 30,
    observedResets: 0,
  });
  assert.deepEqual(reduceQuotaMovement([20, 80, 30, 60, 20, 50]), {
    latestPercentage: 50,
    observedPeak: 80,
    observedConsumption: 170,
    observedResets: 2,
  });

  const snapshots = [
    quotaSnapshot({
      id: "percent",
      at: NOW - 3_000,
      bucket: { id: "percent", label: "Percent", unit: "percent", remaining: 75 },
    }),
    quotaSnapshot({
      id: "usd",
      at: NOW - 2_000,
      bucket: { id: "usd", label: "Dollars", unit: "usd", used: 5, limit: 20, remaining: 15 },
    }),
    quotaSnapshot({
      id: "count",
      at: NOW - 1_000,
      bucket: { id: "count", label: "Requests", unit: "count", remaining: 30, limit: 40 },
    }),
    quotaSnapshot({
      id: "nolimit",
      at: NOW,
      bucket: { id: "nolimit", label: "No limit", unit: "count", used: 7 },
    }),
  ];
  const buckets =
    deriveHistoryRange(loaded([], snapshots), 60_000).quotas.providers[0]?.identities[0]?.buckets ??
    [];
  assert.deepEqual(
    buckets.map((bucket) => [bucket.id, bucket.latestPercentage]),
    [
      ["usd", 25],
      ["nolimit", undefined],
      ["percent", 25],
      ["count", 25],
    ],
  );
  assert.equal(buckets.find((bucket) => bucket.id === "usd")?.latest.remaining, 15);
  assert.equal(buckets.find((bucket) => bucket.id === "nolimit")?.capacity, undefined);
});

test("capacity isolates providers, includes subagents, extrapolates tokens and positive cost, and detects window gaps", () => {
  const first = NOW - 2 * 60 * 60_000;
  const last = NOW - 10_000;
  const calls = [
    normalizedCall({ key: "root", at: first, input: 60, output: 40, cost: 2 }),
    normalizedCall({
      key: "subagent",
      at: last,
      input: 100,
      cost: 3,
      sourceKind: "output",
      agentId: "agent",
    }),
    normalizedCall({ key: "other", at: last, provider: "provider-b", input: 10_000, cost: 100 }),
  ];
  const snapshots = [
    quotaSnapshot({
      id: "start",
      at: first - 1_000,
      bucket: percentBucket(10, { windowMinutes: 30 }),
    }),
    quotaSnapshot({
      id: "end",
      at: last + 1_000,
      bucket: percentBucket(30, { windowMinutes: 30 }),
    }),
  ];
  for (const unit of ["usd", "count"] as const) {
    snapshots.push(
      quotaSnapshot({
        id: `${unit}-start`,
        at: first - 1_000,
        bucket: { id: unit, label: unit, unit, used: 10, limit: 100 },
      }),
      quotaSnapshot({
        id: `${unit}-end`,
        at: last + 1_000,
        bucket: { id: unit, label: unit, unit, used: 30, limit: 100 },
      }),
    );
  }
  const buckets =
    deriveHistoryRange(loaded(calls, snapshots), 3 * 60 * 60_000).quotas.providers.find(
      (provider) => provider.providerId === "provider-a",
    )?.identities[0]?.buckets ?? [];
  for (const bucket of buckets) {
    assert.equal(bucket.capacity?.observedConsumedPercent, 20);
    assert.equal(bucket.capacity?.estimated100PercentTokens, 1_000);
    assert.equal(bucket.capacity?.estimated100PercentCost, 25);
  }
  const percent = buckets.find((bucket) => bucket.unit === "percent");
  assert.equal(percent?.capacity?.lowerBound, true);
  assert.ok(percent?.capacity?.warnings.some((message) => message.includes("lower bound")));
});

test("capacity includes nonzero starts after observed resets", () => {
  const first = NOW - 60_000;
  const last = NOW - 10_000;
  const values = [20, 80, 30, 60, 20, 50];
  const snapshots = values.map((value, index) =>
    quotaSnapshot({
      id: `reset-${index}`,
      at: first - 1_000 + index * ((last - first + 2_000) / (values.length - 1)),
      bucket: percentBucket(value),
    }),
  );
  const bucket = deriveHistoryRange(
    loaded(
      [
        normalizedCall({ key: "first", at: first, input: 85 }),
        normalizedCall({ key: "last", at: last, input: 85 }),
      ],
      snapshots,
    ),
    2 * 60_000,
  ).quotas.providers[0]?.identities[0]?.buckets[0];
  assert.equal(bucket?.capacity?.observedConsumedPercent, 170);
  assert.equal(bucket?.capacity?.estimated100PercentTokens, 100);
});

test("capacity boundary decisions prefer outer samples, allow inner fallback, and omit only stale buckets", () => {
  const first = NOW - 60 * 60_000;
  const last = NOW - 10 * 60_000;
  const calls = [
    normalizedCall({ key: "first", at: first, input: 50 }),
    normalizedCall({ key: "last", at: last, input: 50 }),
  ];
  const snapshots: UsageSnapshot[] = [];
  const add = (bucketId: string, id: string, at: number, used: number) =>
    snapshots.push(
      quotaSnapshot({
        id: `${bucketId}-${id}`,
        at,
        bucket: { ...percentBucket(used), id: bucketId, label: bucketId },
      }),
    );
  add("outer", "start", first - 20 * 60_000, 10);
  add("outer", "inner-start", first + 1_000, 11);
  add("outer", "end", last + 20 * 60_000, 30);
  add("inner", "start", first + 5 * 60_000, 10);
  add("inner", "end", last - 5 * 60_000, 30);
  add("stale", "start", first - 31 * 60_000, 10);
  add("stale", "end", last + 31 * 60_000, 30);
  add("partial", "start", first - 1_000, 10);
  const buckets =
    deriveHistoryRange(loaded(calls, snapshots), 2 * 60 * 60_000).quotas.providers[0]?.identities[0]
      ?.buckets ?? [];
  const outer = buckets.find((bucket) => bucket.id === "outer");
  assert.ok(outer?.capacity);
  assert.equal(outer?.capacity?.observedConsumedPercent, 20);
  assert.ok(outer?.capacityWarnings.some((message) => message.includes("more than 10m")));
  const inner = buckets.find((bucket) => bucket.id === "inner");
  assert.ok(inner?.capacity);
  assert.ok(inner?.capacityWarnings.some((message) => message.includes("early usage")));
  assert.ok(inner?.capacityWarnings.some((message) => message.includes("late usage")));
  assert.equal(buckets.find((bucket) => bucket.id === "stale")?.capacity, undefined);
  assert.deepEqual(buckets.find((bucket) => bucket.id === "stale")?.capacityWarnings, []);
  assert.equal(buckets.find((bucket) => bucket.id === "partial")?.capacity, undefined);
  assert.ok((buckets.find((bucket) => bucket.id === "partial")?.capacityWarnings.length ?? 0) > 0);
});

test("capacity boundaries and window gaps use only percentage-bearing observations", () => {
  const first = NOW - 60 * 60_000;
  const last = NOW - 10 * 60_000;
  const calls = [
    normalizedCall({ key: "first", at: first, input: 50 }),
    normalizedCall({ key: "last", at: last, input: 50 }),
  ];
  const snapshots = [
    quotaSnapshot({
      id: "raw-near-start",
      at: first - 1_000,
      bucket: { id: "stale-percent", label: "Stale percent", unit: "percent" },
    }),
    quotaSnapshot({
      id: "percent-too-late",
      at: first + 31 * 60_000,
      bucket: { ...percentBucket(10), id: "stale-percent", label: "Stale percent" },
    }),
    quotaSnapshot({
      id: "stale-percent-end",
      at: last + 1_000,
      bucket: { ...percentBucket(30), id: "stale-percent", label: "Stale percent" },
    }),
    quotaSnapshot({
      id: "gap-start",
      at: first - 1_000,
      bucket: { ...percentBucket(10), id: "gap", label: "Gap", windowMinutes: 30 },
    }),
    quotaSnapshot({
      id: "gap-raw-middle",
      at: first + 20 * 60_000,
      bucket: { id: "gap", label: "Gap", unit: "percent", windowMinutes: 30 },
    }),
    quotaSnapshot({
      id: "gap-end",
      at: first + 40 * 60_000,
      bucket: { ...percentBucket(30), id: "gap", label: "Gap", windowMinutes: 30 },
    }),
  ];

  const buckets =
    deriveHistoryRange(loaded(calls, snapshots), 2 * 60 * 60_000).quotas.providers[0]?.identities[0]
      ?.buckets ?? [];
  const stale = buckets.find((bucket) => bucket.id === "stale-percent");
  assert.equal(stale?.observations.length, 3);
  assert.equal(stale?.capacity, undefined);
  assert.ok(
    stale?.capacityWarnings.some((warning) => warning.includes("both activity boundaries")),
  );
  const gap = buckets.find((bucket) => bucket.id === "gap");
  assert.equal(gap?.observations.length, 3);
  assert.equal(gap?.capacity?.lowerBound, true);
  assert.ok(gap?.capacity?.warnings.some((warning) => warning.includes("lower bound")));
});

test("boundary-only quota observations remain historical and retain capacity warnings", () => {
  const since = NOW - 24 * 60 * 60_000;
  const view = deriveHistoryRange(
    loaded(
      [normalizedCall({ key: "call", at: since + 5 * 60_000, input: 100 })],
      [
        quotaSnapshot({
          id: "boundary",
          at: since - 60_000,
          bucket: percentBucket(25),
        }),
      ],
    ),
    24 * 60 * 60_000,
  );
  const bucket = view.quotas.providers[0]?.identities[0]?.buckets[0];
  assert.equal(bucket?.observations.length, 0);
  assert.equal(bucket?.current, undefined);
  assert.equal(bucket?.historicalBoundary?.percentage, 25);
  assert.ok(
    bucket?.capacityWarnings.some((warning) => warning.includes("both activity boundaries")),
  );
});

test("one snapshot at equal activity boundaries is not a usable capacity pair", () => {
  const at = NOW - 10_000;
  const bucket = deriveHistoryRange(
    loaded(
      [normalizedCall({ key: "only", at, input: 100 })],
      [quotaSnapshot({ id: "only", at, bucket: percentBucket(20) })],
    ),
    60_000,
  ).quotas.providers[0]?.identities[0]?.buckets[0];
  assert.equal(bucket?.capacity, undefined);
  assert.ok(
    bucket?.capacityWarnings.some((message) => message.includes("both activity boundaries")),
  );
});

test("bucketless snapshots preserve providers and identities and suppress ambiguous capacity", () => {
  const first = NOW - 20_000;
  const last = NOW - 10_000;
  const calls = [
    normalizedCall({ key: "first", at: first, input: 50 }),
    normalizedCall({ key: "last", at: last, input: 50 }),
  ];
  const metricOnly = quotaSnapshot({
    id: "metric-only",
    at: NOW - 5_000,
    provider: "metrics-provider",
    identity: { kind: "account", id: "metrics-account" },
    bucket: percentBucket(1),
  });
  metricOnly.report.buckets = [];
  metricOnly.report.metrics = [{ id: "balance", label: "Balance", unit: "usd", value: 10 }];

  const bucketedStart = quotaSnapshot({
    id: "bucket-start",
    at: first - 1,
    bucket: percentBucket(10),
  });
  const bucketedEnd = quotaSnapshot({ id: "bucket-end", at: last + 1, bucket: percentBucket(20) });
  const siblingIdentity = quotaSnapshot({
    id: "bucketless-sibling",
    at: first,
    identity: { kind: "credential", id: "sibling" },
    bucket: percentBucket(1),
  });
  siblingIdentity.report.buckets = [];

  const providers = deriveHistoryRange(
    loaded(calls, [metricOnly, bucketedStart, bucketedEnd, siblingIdentity]),
    60_000,
  ).quotas.providers;
  const metricsProvider = providers.find((provider) => provider.providerId === "metrics-provider");
  assert.equal(metricsProvider?.identities.length, 1);
  assert.deepEqual(metricsProvider?.identities[0]?.buckets, []);
  const mixed = providers.find((provider) => provider.providerId === "provider-a");
  assert.equal(mixed?.identities.length, 2);
  const bucket = mixed?.identities.find((identity) => identity.identity.id === "account-a")
    ?.buckets[0];
  assert.equal(bucket?.capacity, undefined);
  assert.ok(bucket?.capacityWarnings.some((message) => message.includes("overlapping")));
});

test("overlapping identities and absent local consumption suppress capacity but preserve histories", () => {
  const first = NOW - 20_000;
  const last = NOW - 10_000;
  const calls = [
    normalizedCall({ key: "first", at: first, input: 50 }),
    normalizedCall({ key: "last", at: last, input: 50 }),
  ];
  const snapshots: UsageSnapshot[] = [];
  for (const identity of [
    { kind: "account", id: "one" },
    { kind: "credential", id: "two" },
  ] as UsageSnapshotIdentity[]) {
    snapshots.push(
      quotaSnapshot({
        id: `${identity.id}-start`,
        at: first - 1,
        identity,
        bucket: percentBucket(10),
      }),
      quotaSnapshot({
        id: `${identity.id}-end`,
        at: last + 1,
        identity,
        bucket: percentBucket(20),
      }),
    );
  }
  const provider = deriveHistoryRange(loaded(calls, snapshots), 60_000).quotas.providers[0];
  assert.equal(provider?.identities.length, 2);
  assert.ok(provider?.identities.every((identity) => identity.buckets[0]?.capacity === undefined));
  assert.ok(
    provider?.identities.every((identity) =>
      identity.buckets[0]?.capacityWarnings.some((warning) => warning.includes("overlapping")),
    ),
  );

  const noCalls = deriveHistoryRange(loaded([], snapshots), 60_000).quotas.providers[0];
  assert.ok(noCalls?.identities.every((identity) => identity.buckets[0]?.capacity === undefined));
});

test("Anthropic credential rotations share quota movement and provider-scoped capacity", () => {
  const first = NOW - 10 * 60 * 60_000;
  const last = NOW - 10 * 60_000;
  const before: UsageSnapshotIdentity = { kind: "credential", id: "before-refresh" };
  const after: UsageSnapshotIdentity = { kind: "credential", id: "after-refresh" };
  const snapshots = [
    { at: first - 1_000, identity: before, session: 0, weekly: 2 },
    { at: first + 20 * 60_000, identity: before, session: 18, weekly: 3 },
    { at: last - 20 * 60_000, identity: after, session: 0, weekly: 3 },
    { at: last + 1_000, identity: after, session: 34, weekly: 6 },
  ].map((sample, index) => {
    const value = quotaSnapshot({
      id: `anthropic-${index}`,
      at: sample.at,
      identity: sample.identity,
      provider: "anthropic",
      providerName: "Anthropic",
      bucket: percentBucket(sample.session, {
        id: "five_hour",
        label: "Session",
        windowMinutes: 300,
      }),
    });
    value.report.buckets.push(
      percentBucket(sample.weekly, { id: "seven_day", label: "Weekly", windowMinutes: 10_080 }),
    );
    return value;
  });
  for (const id of ["openai-one", "openai-two"]) {
    snapshots.push(
      quotaSnapshot({
        id,
        at: last,
        provider: "openai",
        identity: { kind: "account", id },
        bucket: percentBucket(20),
      }),
    );
  }
  const history = loaded(
    [
      normalizedCall({ key: "first", provider: "anthropic", at: first, input: 50, cost: 1 }),
      normalizedCall({ key: "last", provider: "anthropic", at: last, input: 50, cost: 1 }),
      normalizedCall({ key: "other", provider: "openai", at: last, input: 7_000, cost: 9 }),
    ],
    snapshots.reverse(),
  );
  const savedSnapshots = JSON.stringify(history.snapshots);
  const providers = deriveHistoryRange(history, 12 * 60 * 60_000).quotas.providers;
  const anthropic = providers.find((provider) => provider.providerId === "anthropic");
  assert.equal(anthropic?.identities.length, 1);
  const buckets = anthropic?.identities[0]?.buckets;
  const session = buckets?.find((bucket) => bucket.id === "five_hour");
  const weekly = buckets?.find((bucket) => bucket.id === "seven_day");
  assert.deepEqual(
    session?.observations.map((sample) => sample.percentage),
    [0, 18, 0, 34],
  );
  assert.equal(session?.observedConsumption, 52);
  assert.equal(session?.observedResets, 1);
  assert.equal(session?.capacity?.estimated100PercentTokens, (100 * 100) / 52);
  assert.equal(session?.capacity?.lowerBound, true);
  assert.ok(session?.capacity?.warnings.some((warning) => warning.includes("lower bound")));
  assert.equal(weekly?.observedConsumption, 4);
  assert.equal(weekly?.capacity?.estimated100PercentTokens, 2_500);
  assert.equal(weekly?.capacity?.estimated100PercentCost, 50);
  assert.deepEqual(weekly?.capacityWarnings, []);
  assert.equal(
    providers.find((provider) => provider.providerId === "openai")?.identities.length,
    2,
  );
  assert.equal(JSON.stringify(history.snapshots), savedSnapshots);
});

test("Anthropic live credentials share history without filling missing sample boundaries", () => {
  const first = NOW - 2 * 60 * 60_000;
  const last = NOW - 10 * 60_000;
  const snapshots = [
    quotaSnapshot({
      id: "start",
      at: first - 1_000,
      provider: "anthropic",
      identity: { kind: "credential", id: "before-refresh" },
      bucket: percentBucket(10),
    }),
    quotaSnapshot({
      id: "stale-end",
      at: last - 31 * 60_000,
      provider: "anthropic",
      identity: { kind: "credential", id: "after-refresh" },
      bucket: percentBucket(20),
    }),
  ];
  const live = quotaSnapshot({
    id: "live",
    at: NOW,
    provider: "anthropic",
    identity: { kind: "credential", id: "live-credential" },
    bucket: percentBucket(40),
  });
  const view = deriveHistoryRange(
    loaded(
      [
        normalizedCall({ key: "first", provider: "anthropic", at: first, input: 50 }),
        normalizedCall({ key: "last", provider: "anthropic", at: last, input: 50 }),
      ],
      snapshots,
    ),
    3 * 60 * 60_000,
    { live: { ...live.report, identity: live.identity, report: live.report } },
  );
  const provider = view.quotas.providers[0];
  assert.equal(provider?.identities.length, 1);
  const bucket = provider?.identities[0]?.buckets[0];
  assert.equal(bucket?.observations.length, 2);
  assert.equal(bucket?.observedConsumption, 10);
  assert.equal(bucket?.current?.percentage, 40);
  assert.equal(bucket?.capacity, undefined);
  assert.deepEqual(bucket?.capacityWarnings, [
    "quota samples do not cover both activity boundaries",
  ]);
  assert.deepEqual(live.identity, { kind: "credential", id: "live-credential" });
});

test("provider and identity labels come from the greatest capture time", () => {
  const newer = quotaSnapshot({
    id: "newer-labels",
    at: NOW - 1_000,
    bucket: percentBucket(20),
    providerName: "New Provider Name",
  });
  newer.report.accountLabel = "New Account Label";
  const older = quotaSnapshot({
    id: "older-labels",
    at: NOW - 2_000,
    bucket: percentBucket(10),
    providerName: "Old Provider Name",
  });
  older.report.accountLabel = "Old Account Label";

  const provider = deriveHistoryRange(loaded([], [newer, older]), 60_000).quotas.providers[0];
  assert.equal(provider?.providerName, "New Provider Name");
  assert.equal(provider?.identities[0]?.label, "New Account Label");
});

test("zero-cost capacity and live-only quota state never invent recorded cost or history", () => {
  const first = NOW - 20_000;
  const last = NOW - 10_000;
  const snapshots = [
    quotaSnapshot({ id: "start", at: first - 1, bucket: percentBucket(10) }),
    quotaSnapshot({ id: "end", at: last + 1, bucket: percentBucket(20) }),
  ];
  const view = deriveHistoryRange(
    loaded(
      [
        normalizedCall({ key: "first", at: first, input: 50 }),
        normalizedCall({ key: "last", at: last, input: 50 }),
      ],
      snapshots,
    ),
    60_000,
    {
      live: {
        providerId: "live-provider",
        providerName: "Live Provider",
        identity: { kind: "account", id: "live-account" },
        report: {
          providerId: "live-provider",
          providerName: "Live Provider",
          capturedAt: NOW,
          source: "live",
          semantics: { kind: "api-key", label: "API" },
          buckets: [percentBucket(90)],
          metrics: [],
        },
      },
    },
  );
  const historical = view.quotas.providers.find((provider) => provider.providerId === "provider-a");
  assert.equal(historical?.identities[0]?.buckets[0]?.capacity?.estimated100PercentCost, undefined);
  const live = view.quotas.providers[0];
  assert.equal(live?.providerId, "live-provider");
  assert.equal(live?.noHistoryInRange, true);
  assert.equal(live?.identities[0]?.buckets[0]?.latestPercentage, 90);
  assert.equal(live?.identities[0]?.buckets[0]?.observations.length, 0);
  assert.equal(live?.identities[0]?.buckets[0]?.observedConsumption, 0);
  assert.equal(live?.identities[0]?.buckets[0]?.capacity, undefined);
  assert.equal(live?.liveReport?.buckets[0]?.used, 90);
});

test("live quota values remain separate from observed history and include new buckets", () => {
  const snapshots = [
    quotaSnapshot({ id: "observed-start", at: NOW - 20_000, bucket: percentBucket(10) }),
    quotaSnapshot({ id: "observed-end", at: NOW - 10_000, bucket: percentBucket(20) }),
  ];
  const baseline = deriveHistoryRange(loaded([], snapshots), 60_000);
  const view = deriveHistoryRange(loaded([], snapshots), 60_000, {
    live: {
      providerId: "provider-a",
      providerName: "Provider A",
      identity: { kind: "account", id: "account-a" },
      report: {
        providerId: "provider-a",
        providerName: "Provider A",
        capturedAt: NOW,
        source: "live",
        semantics: { kind: "api-key", label: "API" },
        buckets: [
          percentBucket(90),
          { ...percentBucket(45), id: "live-extra", label: "Live extra" },
        ],
        metrics: [],
      },
    },
  });

  const buckets = view.quotas.providers[0]?.identities[0]?.buckets;
  const historical = buckets?.find((bucket) => bucket.id === "window");
  assert.equal(historical?.latestPercentage, 20);
  assert.equal(historical?.current?.percentage, 90);
  assert.equal(historical?.observations.length, 2);
  assert.equal(
    historical?.observedConsumption,
    baseline.quotas.providers[0]?.identities[0]?.buckets[0]?.observedConsumption,
  );
  const extra = buckets?.find((bucket) => bucket.id === "live-extra");
  assert.equal(extra?.current?.percentage, 45);
  assert.equal(extra?.observations.length, 0);
  assert.equal(extra?.capacity, undefined);
});

function codexWeeklySnapshot(
  id: string,
  minutesAgo: number,
  used: number,
  extra: Partial<UsageBucket> = {},
): UsageSnapshot {
  return quotaSnapshot({
    id,
    at: NOW - minutesAgo * 60_000,
    provider: "openai-codex",
    bucket: percentBucket(used, {
      id: "codex:primary",
      groupId: "codex",
      windowMinutes: 10_080,
      resetsAt: NOW / 1000 + 604_800,
      ...extra,
    }),
  });
}

function codexModelCall(key: string, minutesAgo: number, cost: number, model = "sol") {
  return normalizedCall({
    key,
    at: NOW - minutesAgo * 60_000,
    provider: "openai-codex",
    model,
    output: 100,
    cost,
  });
}

function codexModelRows(history: LoadedHistory, durationMs = 60 * 60_000) {
  return (
    deriveHistoryRange(history, durationMs)
      .quotas.providers.find((provider) => provider.providerId === "openai-codex")
      ?.identities[0]?.buckets.find((bucket) => bucket.id === "codex:primary")?.modelEstimates ?? []
  );
}

test("model quota averages tolerate 20% helper cost and retain zero-movement interval costs", () => {
  const history = loaded(
    [
      codexModelCall("sol-a", 44, 8),
      {
        ...codexModelCall("luna-a", 42, 2, "luna"),
        usage: { ...usage(1_000_000), cost: { ...usage().cost, total: 2 } },
      },
      codexModelCall("sol-b", 29, 16),
      codexModelCall("luna-b", 28, 4, "luna"),
      codexModelCall("sol-flat", 14, 1),
      normalizedCall({ key: "other-provider", at: NOW - 25 * 60_000, cost: 100 }),
    ],
    [
      codexWeeklySnapshot("start", 45, 10),
      codexWeeklySnapshot("flat-a", 40, 10),
      codexWeeklySnapshot("increase-a", 35, 12),
      codexWeeklySnapshot("end-a", 30, 12),
      codexWeeklySnapshot("flat-b", 25, 12),
      codexWeeklySnapshot("increase-b", 20, 15),
      codexWeeklySnapshot("end-b", 15, 15),
      codexWeeklySnapshot("flat-c", 10, 15),
      codexWeeklySnapshot("end", 0, 15),
    ],
  );
  const rows = codexModelRows(history);
  assert.deepEqual(
    rows.find((row) => row.model === "sol"),
    {
      model: "sol",
      recordedCost: 25,
      sampleCost: 25,
      observedConsumedPercent: 5,
      intervals: 3,
      estimated100PercentCost: 500,
    },
  );
  assert.equal(rows.find((row) => row.model === "luna")?.recordedCost, 6);
  assert.equal(rows.find((row) => row.model === "luna")?.estimated100PercentCost, undefined);
});

test("model quota dominance includes 80% but excludes a share just below it", () => {
  for (const helperCost of [2, 2.001]) {
    const row = codexModelRows(
      loaded(
        [codexModelCall("sol", 14, 8), codexModelCall("helper", 13, helperCost, "luna")],
        [codexWeeklySnapshot("start", 15, 10), codexWeeklySnapshot("end", 0, 12)],
      ),
    ).find((item) => item.model === "sol");
    assert.ok(row);
    assert.equal(row.recordedCost, 8);
    assert.equal(row.sampleCost, helperCost === 2 ? 8 : 0);
    assert.equal(row.observedConsumedPercent, helperCost === 2 ? 2 : 0);
    assert.equal(row.estimated100PercentCost, helperCost === 2 ? 400 : undefined);
  }
});

test("model quota epochs tolerate reset jitter relative to the first observation", () => {
  const reset = NOW / 1000 + 604_800;
  const row = codexModelRows(
    loaded(
      [codexModelCall("first", 44, 2), codexModelCall("second", 29, 3)],
      [
        codexWeeklySnapshot("start", 45, 10),
        codexWeeklySnapshot("positive-jitter", 30, 12, { resetsAt: reset + 2 }),
        codexWeeklySnapshot("negative-jitter", 15, 15, { resetsAt: reset - 2 }),
      ],
    ),
  )[0];
  assert.equal(row?.sampleCost, 5);
  assert.equal(row?.observedConsumedPercent, 5);
  assert.equal(row?.intervals, 2);
  assert.equal(row?.estimated100PercentCost, 100);
});

test("model quota reset jitter cannot accumulate across an epoch", () => {
  const reset = NOW / 1000 + 604_800;
  const row = codexModelRows(
    loaded(
      [
        codexModelCall("first", 59, 2),
        codexModelCall("drift-crossing", 44, 99),
        codexModelCall("second", 29, 3),
      ],
      [
        codexWeeklySnapshot("start", 60, 10),
        codexWeeklySnapshot("first-jitter", 45, 12, { resetsAt: reset + 1.5 }),
        codexWeeklySnapshot("new-epoch", 30, 14, { resetsAt: reset + 3 }),
        codexWeeklySnapshot("new-jitter", 15, 17, { resetsAt: reset + 4.5 }),
      ],
    ),
  )[0];
  assert.equal(row?.recordedCost, 104);
  assert.equal(row?.sampleCost, 5);
  assert.equal(row?.observedConsumedPercent, 5);
  assert.equal(row?.estimated100PercentCost, 100);
});

test("model quota epochs distinguish missing resets and restart after a drop below half peak", () => {
  const reset = NOW / 1000 + 604_800;
  for (const [oldReset, newReset, percentages] of [
    [reset, undefined, [10, 12, 14, 17]],
    [undefined, reset, [10, 12, 14, 17]],
    [reset, reset, [20, 24, 11, 14]],
  ] as const) {
    const row = codexModelRows(
      loaded(
        [
          codexModelCall("first", 59, 2),
          codexModelCall("epoch-crossing", 44, 99),
          codexModelCall("second", 29, 3),
        ],
        [
          codexWeeklySnapshot("old-start", 60, percentages[0], { resetsAt: oldReset }),
          codexWeeklySnapshot("old-end", 45, percentages[1], { resetsAt: oldReset }),
          codexWeeklySnapshot("new-start", 30, percentages[2], { resetsAt: newReset }),
          codexWeeklySnapshot("new-end", 15, percentages[3], { resetsAt: newReset }),
        ],
      ),
    )[0];
    assert.equal(row?.recordedCost, 104);
    assert.equal(row?.sampleCost, 5);
    assert.equal(row?.observedConsumedPercent, oldReset === newReset ? 7 : 5);
    assert.equal(row?.intervals, 2);
    assert.equal(row?.estimated100PercentCost, 500 / (oldReset === newReset ? 7 : 5));
  }
});

test("model quota averages use only the selected history range", () => {
  const history = loaded(
    [codexModelCall("old", 2 * 1440 - 1, 100), codexModelCall("recent", 44, 5)],
    [
      codexWeeklySnapshot("old-start", 2 * 1440, 10),
      codexWeeklySnapshot("old-end", 2 * 1440 - 15, 20),
      codexWeeklySnapshot("recent-start", 45, 20),
      codexWeeklySnapshot("recent-end", 30, 22),
    ],
  );
  const recent = codexModelRows(history, 24 * 60 * 60_000)[0];
  const week = codexModelRows(history, 7 * 24 * 60 * 60_000)[0];
  assert.equal(recent?.recordedCost, 5);
  assert.equal(recent?.estimated100PercentCost, 250);
  assert.equal(week?.recordedCost, 105);
  assert.equal(week?.estimated100PercentCost, 875);
});

test("model quota averages ignore idle movement without ignoring ongoing requests", () => {
  const call = { ...codexModelCall("ongoing", 44, 2), completedAt: NOW - 31 * 60_000 };
  const history = loaded(
    [call],
    [
      codexWeeklySnapshot("idle-start", 60, 0),
      codexWeeklySnapshot("idle-increase", 55, 1),
      codexWeeklySnapshot("start", 45, 1),
      codexWeeklySnapshot("active-flat", 40, 1),
      codexWeeklySnapshot("active-increase", 35, 2),
      codexWeeklySnapshot("end", 30, 2),
    ],
  );
  const row = codexModelRows(history)[0];
  assert.equal(row?.sampleCost, 2);
  assert.equal(row?.observedConsumedPercent, 1);
  assert.equal(row?.estimated100PercentCost, 200);
});

test("model quota averages never pair whole request costs with partial eligible consumption", () => {
  const long = { ...codexModelCall("long", 44, 9), completedAt: NOW - 60_000 };
  const cases = [
    {
      calls: [{ ...codexModelCall("gap-request", 59, 4), completedAt: NOW - 60_000 }],
      snapshots: [
        codexWeeklySnapshot("start", 60, 0),
        codexWeeklySnapshot("first", 45, 1),
        codexWeeklySnapshot("gap", 15, 3),
        codexWeeklySnapshot("end", 0, 4),
      ],
    },
    {
      calls: [long, codexModelCall("helper", 43, 3, "luna"), codexModelCall("short", 14, 2)],
      snapshots: [
        codexWeeklySnapshot("start", 45, 0),
        codexWeeklySnapshot("mixed", 30, 1),
        codexWeeklySnapshot("second", 15, 2),
        codexWeeklySnapshot("end", 0, 3),
      ],
    },
  ];
  for (const scenario of cases) {
    const row = codexModelRows(loaded(scenario.calls, scenario.snapshots)).find(
      (item) => item.model === "sol",
    );
    assert.ok(row);
    assert.equal(row.sampleCost, 0);
    assert.equal(row.observedConsumedPercent, 0);
    assert.equal(row.estimated100PercentCost, undefined);
  }
});

test("model quota averages do not attribute reset-crossing movement or costs", () => {
  const reset = NOW / 1000 + 2 * 604_800;
  const history = loaded(
    [
      codexModelCall("first", 59, 2),
      codexModelCall("crossing", 44, 9),
      codexModelCall("second", 29, 3),
    ],
    [
      codexWeeklySnapshot("old-start", 60, 10),
      codexWeeklySnapshot("old-end", 45, 12),
      codexWeeklySnapshot("new-start", 30, 3, { resetsAt: reset }),
      codexWeeklySnapshot("new-end", 15, 6, { resetsAt: reset }),
    ],
  );
  const row = codexModelRows(history)[0];
  assert.equal(row?.recordedCost, 14);
  assert.equal(row?.sampleCost, 5);
  assert.equal(row?.observedConsumedPercent, 5);
  assert.equal(row?.estimated100PercentCost, 100);
});

test("model quota averages leave unsupported samples insufficient rather than inventing capacity", () => {
  const baseline = loaded(
    [codexModelCall("sol", 14, 9)],
    [codexWeeklySnapshot("start", 15, 10), codexWeeklySnapshot("end", 0, 12)],
  );
  const firstSnapshot = baseline.snapshots[0];
  assert.ok(firstSnapshot);
  const cases = [
    { ...baseline, calls: [...baseline.calls, codexModelCall("helper", 13, 3, "luna")] },
    { ...baseline, calls: [...baseline.calls, codexModelCall("unpriced", 13, 0, "luna")] },
    { ...baseline, calls: baseline.calls.map((call) => ({ ...call, preciseTimestamp: false })) },
    {
      ...baseline,
      snapshots: loaded(
        [],
        [codexWeeklySnapshot("start", 30, 10), codexWeeklySnapshot("end", 0, 12)],
      ).snapshots,
    },
    {
      ...baseline,
      snapshots: loaded(
        [],
        [codexWeeklySnapshot("start", 15, 10), codexWeeklySnapshot("end", 0, 10)],
      ).snapshots,
    },
    {
      ...baseline,
      snapshots: [
        ...baseline.snapshots,
        {
          ...firstSnapshot,
          snapshot: {
            ...firstSnapshot.snapshot,
            observationId: "other-account",
            identity: { kind: "account" as const, id: "account-b" },
          },
        },
      ],
    },
  ];
  for (const history of cases) {
    const row = codexModelRows(history).find((item) => item.model === "sol");
    assert.equal(row?.recordedCost, 9);
    assert.equal(row?.estimated100PercentCost, undefined);
  }
});

test("historical loading preserves request completion bounds for model quota activity", async (t) => {
  const root = await workspace(t);
  const request = assistant("bounded", null, "openai-codex", "sol", NOW - 20 * 60_000);
  request.timestamp = new Date(NOW - 60_000).toISOString();
  const history = await loadHistory(context(manager({ dir: root, entries: [request] })), {
    now: NOW,
    listAll: async () => [],
    outputRoot: join(root, "no-outputs"),
  });
  assert.equal(history.calls[0]?.timestamp, NOW - 20 * 60_000);
  assert.equal(history.calls[0]?.completedAt, NOW - 60_000);
});

test("a request at a measurement boundary cannot explain quota consumed before it started", () => {
  const call = { ...codexModelCall("boundary", 15, 1), completedAt: NOW - 60_000 };
  const row = codexModelRows(
    loaded(
      [call],
      [
        codexWeeklySnapshot("idle", 30, 0),
        codexWeeklySnapshot("boundary", 15, 10),
        codexWeeklySnapshot("end", 0, 11),
      ],
    ),
  )[0];
  assert.equal(row?.sampleCost, 1);
  assert.equal(row?.observedConsumedPercent, 1);
  assert.equal(row?.estimated100PercentCost, 100);
});

test("model account correlation follows request completion without changing aggregate correlation", () => {
  const other = codexWeeklySnapshot("account-b", 5, 50);
  other.identity = { kind: "account", id: "account-b" };
  const call = { ...codexModelCall("bounded", 44, 9), completedAt: NOW - 31 * 60_000 };
  const history = loaded(
    [call],
    [
      codexWeeklySnapshot("account-a-start", 45, 0),
      codexWeeklySnapshot("account-a-end", 30, 1),
      other,
    ],
  );
  const bucket = deriveHistoryRange(history, 60 * 60_000).quotas.providers[0]?.identities.find(
    (identity) => identity.identity.id === "account-a",
  )?.buckets[0];
  assert.equal(bucket?.modelEstimates?.[0]?.estimated100PercentCost, undefined);
  assert.equal(bucket?.capacity?.estimated100PercentCost, 900);
});

test("adjacent dominant samples align whole long-request costs with their full quota movement", () => {
  const call = { ...codexModelCall("long", 44, 9), completedAt: NOW - 60_000 };
  const row = codexModelRows(
    loaded(
      [
        call,
        codexModelCall("helper-a", 43, 0.1, "luna"),
        codexModelCall("helper-b", 28, 0.1, "luna"),
      ],
      [
        codexWeeklySnapshot("start", 45, 0),
        codexWeeklySnapshot("first", 30, 1),
        codexWeeklySnapshot("second", 15, 2),
        codexWeeklySnapshot("end", 0, 3),
      ],
    ),
  ).find((item) => item.model === "sol");
  assert.equal(row?.sampleCost, 9);
  assert.equal(row?.observedConsumedPercent, 3);
  assert.equal(row?.intervals, 3);
  assert.equal(row?.estimated100PercentCost, 300);
});

test("model calibration recovers safe inner observations without charging partial requests or rebounds", () => {
  const row = codexModelRows(
    loaded(
      [
        { ...codexModelCall("left-edge", 64, 3), completedAt: NOW - 50 * 60_000 },
        { ...codexModelCall("contained", 44, 5), completedAt: NOW - 31 * 60_000 },
        { ...codexModelCall("right-edge", 29, 7), completedAt: NOW - 10 * 60_000 },
      ],
      [
        codexWeeklySnapshot("start", 60, 10),
        codexWeeklySnapshot("peak", 55, 13),
        codexWeeklySnapshot("safe-start", 45, 12),
        codexWeeklySnapshot("dip", 40, 11),
        codexWeeklySnapshot("safe-end", 30, 14),
        codexWeeklySnapshot("later", 25, 15),
        codexWeeklySnapshot("end", 15, 16),
      ],
    ),
    90 * 60_000,
  )[0];
  assert.equal(row?.recordedCost, 15);
  assert.equal(row?.sampleCost, 5);
  assert.equal(row?.observedConsumedPercent, 1);
  assert.equal(row?.intervals, 1);
  assert.equal(row?.estimated100PercentCost, 500);
});

test("model calibration extends to safe outer observations and revalidates all overlapping activity", () => {
  const calls = [
    { ...codexModelCall("long", 49, 8), completedAt: NOW - 11 * 60_000 },
    codexModelCall("contained-a", 44, 10),
    codexModelCall("contained-b", 29, 10),
    codexModelCall("left-helper", 59, 3, "luna"),
    codexModelCall("right-helper", 14, 3, "luna"),
  ];
  const snapshots = [
    codexWeeklySnapshot("outer-start", 60, 10),
    codexWeeklySnapshot("start", 45, 11),
    codexWeeklySnapshot("middle", 30, 12),
    codexWeeklySnapshot("end", 15, 13),
    codexWeeklySnapshot("outer-end", 0, 16),
  ];
  const scenarios = [
    { calls, snapshots, accepted: true },
    {
      calls: [...calls, codexModelCall("unpriced-outer", 58, 0, "luna")],
      snapshots,
      accepted: false,
    },
    {
      calls: [
        ...calls,
        { ...codexModelCall("imprecise-outer", 58, 1, "luna"), preciseTimestamp: false },
      ],
      snapshots,
      accepted: false,
    },
    {
      calls: [...calls, codexModelCall("extra-helper", 58, 2, "luna")],
      snapshots,
      accepted: false,
    },
    {
      calls,
      snapshots: [
        ...snapshots.slice(0, -1),
        codexWeeklySnapshot("reset-outer", 0, 16, { resetsAt: NOW / 1000 + 2 * 604_800 }),
      ],
      accepted: false,
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const row = codexModelRows(loaded(scenario.calls, scenario.snapshots)).find(
      (item) => item.model === "sol",
    );
    assert.ok(row);
    assert.equal(row.recordedCost, 28, `scenario ${index}`);
    assert.equal(row.sampleCost, scenario.accepted ? 28 : 0, `scenario ${index}`);
    assert.equal(row.observedConsumedPercent, scenario.accepted ? 6 : 0, `scenario ${index}`);
    assert.equal(row.intervals, scenario.accepted ? 4 : 0, `scenario ${index}`);
    assert.equal(
      row.estimated100PercentCost,
      scenario.accepted ? (28 * 100) / 6 : undefined,
      `scenario ${index}`,
    );
  }
});

test("overlapping extended calibration candidates never count the same quota movement twice", () => {
  const rows = codexModelRows(
    loaded(
      [
        codexModelCall("sol-contained", 59, 200),
        { ...codexModelCall("sol-crossing", 59, 16), completedAt: NOW - 41 * 60_000 },
        { ...codexModelCall("luna-crossing", 44, 30, "luna"), completedAt: NOW - 26 * 60_000 },
        { ...codexModelCall("luna-long", 29, 16, "luna"), completedAt: NOW - 11 * 60_000 },
        codexModelCall("luna-contained", 29, 200, "luna"),
      ],
      [
        codexWeeklySnapshot("start", 60, 10),
        codexWeeklySnapshot("first", 45, 11),
        codexWeeklySnapshot("second", 30, 12),
        codexWeeklySnapshot("third", 15, 13),
        codexWeeklySnapshot("end", 0, 14),
      ],
    ),
  );
  const sol = rows.find((row) => row.model === "sol");
  const luna = rows.find((row) => row.model === "luna");
  assert.equal(sol?.recordedCost, 216);
  assert.equal(sol?.sampleCost, 216);
  assert.equal(sol?.observedConsumedPercent, 2);
  assert.equal(sol?.intervals, 2);
  assert.equal(sol?.estimated100PercentCost, 10_800);
  assert.equal(luna?.recordedCost, 246);
  assert.equal(luna?.sampleCost, 0);
  assert.equal(luna?.observedConsumedPercent, 0);
  assert.equal(luna?.intervals, 0);
  assert.equal(luna?.estimated100PercentCost, undefined);
});

test("merged calibration rechecks model dominance without counting overlapping costs repeatedly", () => {
  const call = { ...codexModelCall("long", 44, 9), completedAt: NOW - 60_000 };
  const row = codexModelRows(
    loaded(
      [
        call,
        codexModelCall("helper-a", 43, 2, "luna"),
        codexModelCall("helper-b", 28, 2, "luna"),
        codexModelCall("helper-c", 13, 2, "luna"),
      ],
      [
        codexWeeklySnapshot("start", 45, 0),
        codexWeeklySnapshot("first", 30, 1),
        codexWeeklySnapshot("second", 15, 2),
        codexWeeklySnapshot("end", 0, 3),
      ],
    ),
  ).find((item) => item.model === "sol");
  assert.equal(row?.recordedCost, 9);
  assert.equal(row?.sampleCost, 0);
  assert.equal(row?.estimated100PercentCost, undefined);
});

test("point calls at the selected range start are valid calibration activity", () => {
  const row = codexModelRows(
    loaded(
      [codexModelCall("at-since", 60, 1)],
      [codexWeeklySnapshot("start", 60, 0), codexWeeklySnapshot("end", 45, 1)],
    ),
  )[0];
  assert.equal(row?.recordedCost, 1);
  assert.equal(row?.sampleCost, 1);
  assert.equal(row?.observedConsumedPercent, 1);
  assert.equal(row?.estimated100PercentCost, 100);
});

test("model dollar calibration supports OpenAI aliases but only main weekly Codex quotas", () => {
  const cases = [
    { provider: "openai", extra: {}, supported: true },
    { provider: "openai-codex", extra: { windowMinutes: 300 }, supported: false },
    { provider: "openai-codex", extra: { groupId: "spark" }, supported: false },
    { provider: "provider-a", extra: {}, supported: false },
  ];
  for (const options of cases) {
    const call = { ...codexModelCall("call", 14, 1), provider: options.provider };
    const snapshots = [
      codexWeeklySnapshot("start", 15, 10, options.extra),
      codexWeeklySnapshot("end", 0, 12, options.extra),
    ];
    for (const snapshot of snapshots) snapshot.report.providerId = options.provider;
    const bucket = deriveHistoryRange(loaded([call], snapshots), 60 * 60_000).quotas.providers.find(
      (provider) => provider.providerId === options.provider,
    )?.identities[0]?.buckets[0];
    if (options.supported) {
      assert.equal(bucket?.modelEstimates?.[0]?.estimated100PercentCost, 50);
    } else {
      assert.equal(bucket?.modelEstimates, undefined);
    }
  }
});

test("retains request timing and branch-relative effort in active and disk history without changing dedup", async (t) => {
  const root = await workspace(t);
  const change = (id: string, parentId: string | null, thinkingLevel: string) => ({
    type: "thinking_level_change",
    id,
    parentId,
    thinkingLevel,
  });
  const timed = (id: string, parentId: string | null, effort?: string) => {
    const entry = assistant(id, parentId);
    entry.timestamp = new Date(NOW - 500).toISOString();
    if (effort) (entry.message as Record<string, unknown>).thinkingLevel = effort;
    return entry;
  };
  const entries = [
    change("low", null, "low"),
    change("high", "low", "high"),
    timed("branch-low", "low"),
    timed("branch-high", "high"),
    timed("explicit", "high", "max"),
    timed("missing", "absent"),
    { type: "custom", id: "cycle-a", parentId: "cycle-b" },
    { type: "custom", id: "cycle-b", parentId: "cycle-a" },
    timed("cyclic", "cycle-a"),
    standaloneUsage("warm", "branch-low"),
    {
      type: "compaction",
      id: "compact-speed",
      parentId: "branch-low",
      timestamp: NOW,
      usage: usage(),
      summary: "summary",
    },
    {
      type: "branch_summary",
      id: "summary-speed",
      parentId: "branch-high",
      timestamp: NOW,
      usage: usage(),
      summary: "summary",
    },
  ];
  const disk = join(root, "root.jsonl");
  const fork = join(root, "fork.jsonl");
  await writeJsonl(disk, [header("disk-root"), ...entries]);
  await writeJsonl(fork, [header("fork-root", disk), ...entries]);
  const outputRoot = join(root, "outputs");
  const explicit = entries.find((entry) => entry.id === "explicit") as ReturnType<typeof assistant>;
  await writeJsonl(join(outputRoot, "cwd", "disk-root", "tasks", "agent.output"), [
    { timestamp: NOW, message: explicit.message },
  ]);
  for (const active of [true, false]) {
    const result = await loadHistory(
      context(
        manager({
          dir: root,
          ...(active ? { file: disk, header: header("disk-root"), entries } : {}),
        }),
      ),
      {
        now: NOW,
        outputRoot,
        listAll: async () => [info(disk), info(fork)],
      },
    );
    assert.equal(result.calls.length, 8);
    const calls = new Map(result.calls.map((call) => [call.entryId, call]));
    assert.deepEqual(
      ["branch-low", "branch-high", "explicit", "missing", "cyclic"].map((id) => {
        const call = calls.get(id);
        return [call?.kind, call?.durationMs, call?.thinkingLevel, call?.thinkingLevelInferred];
      }),
      [
        ["assistant", 500, "low", true],
        ["assistant", 500, "high", true],
        ["assistant", 500, "max", false],
        ["assistant", 500, undefined, false],
        ["assistant", 500, undefined, false],
      ],
    );
    assert.deepEqual(
      ["warm", "compact-speed", "summary-speed"].map((id) => [
        calls.get(id)?.kind,
        calls.get(id)?.durationMs,
      ]),
      [
        ["usage", undefined],
        ["compaction", undefined],
        ["branch_summary", undefined],
      ],
    );
    const retained = calls.get("explicit");
    assert.ok(retained);
    assert.equal(
      fingerprintCall(retained),
      fingerprintCall({
        ...retained,
        durationMs: 999,
        thinkingLevel: "low",
        thinkingLevelInferred: true,
        kind: "usage",
      }),
    );
  }
});

test("missing or invalid request endpoints and output flush timestamps never become elapsed time", async (t) => {
  const root = await workspace(t);
  const entries = [
    assistant("equal", null),
    assistant("negative", null),
    assistant("missing-start", null),
    assistant("missing-end", null),
  ];
  entries[1].timestamp = new Date(NOW - 2_000).toISOString();
  delete (entries[2].message as Record<string, unknown>).timestamp;
  entries[3].timestamp = "invalid";
  const output = assistant("output", null);
  (output.message as Record<string, unknown>).thinkingLevel = "high";
  const outputRoot = join(root, "outputs");
  await writeJsonl(join(outputRoot, "cwd", "output-root", "tasks", "agent.output"), [
    { timestamp: NOW, message: output.message },
    { timestamp: NOW, message: { ...output.message, timestamp: undefined } },
  ]);
  const result = await loadHistory(context(manager({ dir: root, entries })), {
    now: NOW,
    outputRoot,
    listAll: async () => [],
  });
  assert.equal(result.calls.length, 6);
  assert.ok(
    result.calls.every((call) => call.kind === "assistant" && call.durationMs === undefined),
  );
  assert.deepEqual(
    result.calls
      .filter((call) => call.source.kind === "output")
      .map((call) => [call.timestampFidelity, call.thinkingLevel]),
    [
      ["embedded", "high"],
      ["flush", "high"],
    ],
  );
});
