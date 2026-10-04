import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  type ExtensionContext,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { SNAPSHOT_ENTRY_TYPE } from "./snapshot.ts";
import type {
  UsageBucket,
  UsageReport,
  UsageSnapshot,
  UsageSnapshotIdentity,
  UsageUnit,
} from "./types.ts";

export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const HISTORY_BOUNDARY_TOLERANCE_MS = 30 * 60 * 1000;

export type HistorySourceKind = "active" | "session" | "output";
export type TimestampFidelity = "embedded" | "entry" | "flush" | "missing";

export interface HistorySource {
  kind: HistorySourceKind;
  id: string;
  path?: string;
  sessionId?: string;
  rootSessionId?: string;
  agentId?: string;
}

export interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface NormalizedCall {
  key: string;
  entryId?: string;
  provider: string;
  model: string;
  timestamp?: number;
  timestampFidelity: TimestampFidelity;
  preciseTimestamp: boolean;
  usage: NormalizedUsage;
  stopReason?: string;
  /** Canonical content digest retained only for persisted/transcript deduplication. */
  contentHash?: string;
  /** Test/input compatibility; disk loading always projects this to contentHash. */
  content?: unknown;
  source: HistorySource;
  conversationId: string;
  /** Nearest usage-bearing ancestor; null means the entry tree has no such ancestor. */
  predecessorKey?: string | null;
  lineageId?: string;
}

export interface NormalizedSnapshot {
  snapshot: UsageSnapshot;
  source: HistorySource;
  entryId?: string;
}

export type HistoryWarningCode =
  | "unreadable-source"
  | "malformed-jsonl"
  | "malformed-snapshot"
  | "broken-lineage"
  | "cyclic-lineage"
  | "ambiguous-output-match"
  | "unattributable-call"
  | "untimestamped-call"
  | "invalid-usage"
  | "imprecise-gap-timing";

export interface HistoryWarning {
  code: HistoryWarningCode;
  message: string;
  source?: string;
  line?: number;
  timestamp?: number;
  /** Every known call time affected by one association warning. */
  timestamps?: number[];
}

export interface LoadedHistory {
  now: number;
  calls: NormalizedCall[];
  snapshots: NormalizedSnapshot[];
  warnings: HistoryWarning[];
  subagents: Array<{ id: string; timestamps: number[] }>;
}

type ListedSession = Pick<SessionInfo, "path" | "modified">;
type ListAll = (sessionDir?: string) => Promise<ListedSession[]>;

export interface LoadHistoryOptions {
  signal?: AbortSignal;
  now?: number;
  /** Test seam for Pi's public, read-only session listing API. */
  listAll?: ListAll;
  /** Test seam; defaults to pi-subagents' platform-safe temporary root. */
  outputRoot?: string;
  /** Test seam invoked after initial source metadata is captured. */
  sourceReadStarted?: (path: string) => void | Promise<void>;
}

interface RawSession {
  path?: string;
  canonicalPath: string;
  source: HistorySource;
  header: Record<string, unknown>;
  /** Projected metadata only; arbitrary message and tool payloads are discarded while parsing. */
  entries: Record<string, unknown>[];
  endTimestamp: number;
  parentCanonicalPath?: string;
  lineageId?: string;
  lineageValid: boolean;
}

interface OutputTranscript {
  path: string;
  source: HistorySource;
  entries: Array<{ value: Record<string, unknown>; line: number }>;
}

function abortError(): Error {
  const error = new Error("History loading was aborted");
  error.name = "AbortError";
  return error;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function warning(
  warnings: HistoryWarning[],
  code: HistoryWarningCode,
  message: string,
  source?: string,
  line?: number,
  at?: number | readonly number[],
): void {
  const temporal =
    typeof at === "number"
      ? { timestamp: at }
      : at && at.length > 0
        ? { timestamps: [...new Set(at)] }
        : {};
  warnings.push({ code, message, source, line, ...temporal });
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function normalizeUsage(value: unknown): NormalizedUsage | undefined {
  const raw = object(value);
  const costRaw = object(raw?.cost);
  if (!raw || !costRaw) return undefined;
  const tokenFields = [raw.input, raw.output, raw.cacheRead, raw.cacheWrite, raw.totalTokens];
  const costFields = [
    costRaw.input,
    costRaw.output,
    costRaw.cacheRead,
    costRaw.cacheWrite,
    costRaw.total,
  ];
  if (
    tokenFields.some(
      (item) => typeof item !== "number" || !Number.isSafeInteger(item) || item < 0,
    ) ||
    costFields.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)
  ) {
    return undefined;
  }
  const [input, output, cacheRead, cacheWrite] = tokenFields as number[];
  const totalTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (output ?? 0);
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalTokens,
    cost: {
      input: costRaw.input as number,
      output: costRaw.output as number,
      cacheRead: costRaw.cacheRead as number,
      cacheWrite: costRaw.cacheWrite as number,
      total: costRaw.total as number,
    },
  };
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const record = object(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableValue(record[key])]),
  );
}

function contentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)) ?? "undefined")
    .digest("hex");
}

function projectedScalar(value: unknown): unknown {
  return typeof value === "number" ? value : undefined;
}

/** Keep only numeric candidates that normalization validates, never provider-specific payloads. */
function projectUsage(value: unknown): Record<string, unknown> {
  const raw = object(value);
  const cost = object(raw?.cost);
  return {
    ...(projectedScalar(raw?.input) === undefined ? {} : { input: raw?.input }),
    ...(projectedScalar(raw?.output) === undefined ? {} : { output: raw?.output }),
    ...(projectedScalar(raw?.cacheRead) === undefined ? {} : { cacheRead: raw?.cacheRead }),
    ...(projectedScalar(raw?.cacheWrite) === undefined ? {} : { cacheWrite: raw?.cacheWrite }),
    ...(projectedScalar(raw?.totalTokens) === undefined ? {} : { totalTokens: raw?.totalTokens }),
    cost: {
      ...(projectedScalar(cost?.input) === undefined ? {} : { input: cost?.input }),
      ...(projectedScalar(cost?.output) === undefined ? {} : { output: cost?.output }),
      ...(projectedScalar(cost?.cacheRead) === undefined ? {} : { cacheRead: cost?.cacheRead }),
      ...(projectedScalar(cost?.cacheWrite) === undefined ? {} : { cacheWrite: cost?.cacheWrite }),
      ...(projectedScalar(cost?.total) === undefined ? {} : { total: cost?.total }),
    },
  };
}

function projectSessionRow(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (value.type === "session") {
    return {
      type: value.type,
      id: value.id,
      parentSession: value.parentSession,
    };
  }
  const base = {
    type: value.type,
    id: value.id,
    parentId: value.parentId,
    timestamp: value.timestamp,
  };
  if (value.type === "model_change") {
    return { ...base, provider: value.provider, modelId: value.modelId };
  }
  if (value.type === "usage") {
    return {
      ...base,
      provider: value.provider,
      model: value.model,
      usage: projectUsage(value.usage),
      contentHash: contentHash({ type: value.type, kind: value.kind }),
    };
  }
  if (value.type === "message") {
    const message = object(value.message);
    if (message?.role !== "assistant") return base;
    return {
      ...base,
      message: {
        role: "assistant",
        provider: message.provider,
        model: message.model,
        timestamp: message.timestamp,
        usage: message.usage === undefined ? undefined : projectUsage(message.usage),
        stopReason: message.stopReason,
        ...(message.usage === undefined ? {} : { contentHash: contentHash(message.content) }),
      },
    };
  }
  if (value.type === "compaction" || value.type === "branch_summary") {
    return {
      ...base,
      usage: value.usage === undefined ? undefined : projectUsage(value.usage),
      ...(value.usage === undefined ? {} : { contentHash: contentHash(value.summary) }),
    };
  }
  if (value.type === "custom" && value.customType === SNAPSHOT_ENTRY_TYPE) {
    const validated = validateSnapshot(value.data);
    const capturedAt = object(object(value.data)?.report)?.capturedAt;
    return {
      ...base,
      customType: value.customType,
      data: validated ?? {
        report: {
          ...(typeof capturedAt === "number" && Number.isFinite(capturedAt) ? { capturedAt } : {}),
        },
      },
    };
  }
  if (value.type === "custom" && value.customType === "subagents:record") {
    return {
      ...base,
      customType: value.customType,
      data: { id: object(value.data)?.id },
    };
  }
  return base;
}

function projectOutputRow(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const message = object(value.message);
  if (message?.role !== "assistant") {
    return {
      timestamp: value.timestamp,
      ...(message?.timestamp === undefined ? {} : { message: { timestamp: message.timestamp } }),
    };
  }
  return {
    timestamp: value.timestamp,
    message: {
      role: "assistant",
      provider: message.provider,
      model: message.model,
      timestamp: message.timestamp,
      usage: message.usage === undefined ? undefined : projectUsage(message.usage),
      stopReason: message.stopReason,
      contentHash: contentHash(message.content),
    },
  };
}

function isIncompleteJsonPrefix(source: string): boolean {
  const incomplete = Symbol("incomplete");
  const invalid = Symbol("invalid");
  let position = 0;
  const fail = (reason: typeof incomplete | typeof invalid): never => {
    throw reason;
  };
  const skipWhitespace = (): void => {
    while (/\s/.test(source[position] ?? "")) position += 1;
  };
  const parseString = (): void => {
    if (source[position] !== '"') fail(invalid);
    position += 1;
    while (position < source.length) {
      const character = source[position++];
      if (character === '"') return;
      if (!character || character.charCodeAt(0) < 0x20) fail(invalid);
      if (character !== "\\") continue;
      if (position >= source.length) fail(incomplete);
      const escapeCode = source[position++];
      if (escapeCode === "u") {
        for (let count = 0; count < 4; count += 1) {
          if (position >= source.length) fail(incomplete);
          if (!/[0-9a-f]/i.test(source[position++] ?? "")) fail(invalid);
        }
      } else if (!escapeCode || !'"\\/bfnrt'.includes(escapeCode)) {
        fail(invalid);
      }
    }
    fail(incomplete);
  };
  const parseLiteral = (literal: string): void => {
    for (const expected of literal) {
      if (position >= source.length) fail(incomplete);
      if (source[position++] !== expected) fail(invalid);
    }
  };
  const parseNumber = (): void => {
    if (source[position] === "-") {
      position += 1;
      if (position >= source.length) fail(incomplete);
    }
    if (source[position] === "0") position += 1;
    else if (/[1-9]/.test(source[position] ?? "")) {
      while (/\d/.test(source[position] ?? "")) position += 1;
    } else fail(invalid);
    if (source[position] === ".") {
      position += 1;
      if (position >= source.length) fail(incomplete);
      if (!/\d/.test(source[position] ?? "")) fail(invalid);
      while (/\d/.test(source[position] ?? "")) position += 1;
    }
    if (source[position] === "e" || source[position] === "E") {
      position += 1;
      if (position >= source.length) fail(incomplete);
      if (source[position] === "+" || source[position] === "-") {
        position += 1;
        if (position >= source.length) fail(incomplete);
      }
      if (!/\d/.test(source[position] ?? "")) fail(invalid);
      while (/\d/.test(source[position] ?? "")) position += 1;
    }
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (position >= source.length) fail(incomplete);
    const character = source[position];
    if (character === '"') parseString();
    else if (character === "{") parseObject();
    else if (character === "[") parseArray();
    else if (character === "t") parseLiteral("true");
    else if (character === "f") parseLiteral("false");
    else if (character === "n") parseLiteral("null");
    else if (character === "-" || /\d/.test(character ?? "")) parseNumber();
    else fail(invalid);
  };
  const parseArray = (): void => {
    position += 1;
    skipWhitespace();
    if (position >= source.length) fail(incomplete);
    if (source[position] === "]") {
      position += 1;
      return;
    }
    while (true) {
      parseValue();
      skipWhitespace();
      if (position >= source.length) fail(incomplete);
      if (source[position] === "]") {
        position += 1;
        return;
      }
      if (source[position] !== ",") fail(invalid);
      position += 1;
    }
  };
  const parseObject = (): void => {
    position += 1;
    skipWhitespace();
    if (position >= source.length) fail(incomplete);
    if (source[position] === "}") {
      position += 1;
      return;
    }
    while (true) {
      skipWhitespace();
      if (position >= source.length) fail(incomplete);
      parseString();
      skipWhitespace();
      if (position >= source.length) fail(incomplete);
      if (source[position] !== ":") fail(invalid);
      position += 1;
      parseValue();
      skipWhitespace();
      if (position >= source.length) fail(incomplete);
      if (source[position] === "}") {
        position += 1;
        return;
      }
      if (source[position] !== ",") fail(invalid);
      position += 1;
    }
  };

  try {
    parseValue();
    skipWhitespace();
    return false;
  } catch (error) {
    return error === incomplete;
  }
}

/** Fingerprints only fields that identify one normalized assistant invocation. */
export function fingerprintCall(call: NormalizedCall): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableValue({
          provider: call.provider,
          model: call.model,
          timestamp: call.timestampFidelity === "embedded" ? call.timestamp : undefined,
          usage: call.usage,
          stopReason: call.stopReason,
          contentHash: call.contentHash ?? contentHash(call.content),
        }),
      ),
    )
    .digest("hex");
}

async function readJsonLines(
  path: string,
  signal: AbortSignal | undefined,
  warnings: HistoryWarning[],
  project: (value: Record<string, unknown>) => Record<string, unknown> | undefined = (value) =>
    value,
  sourceReadStarted?: (path: string) => void | Promise<void>,
): Promise<Array<{ value: Record<string, unknown>; line: number }>> {
  const rows: Array<{ value: Record<string, unknown>; line: number }> = [];
  let initialMetadata: { size: number; mtimeMs: number } | undefined;
  try {
    const value = await stat(path);
    initialMetadata = { size: value.size, mtimeMs: value.mtimeMs };
  } catch {
    // The stream open below produces the source warning with the useful error.
  }
  await sourceReadStarted?.(path);
  checkAbort(signal);
  let pending = "";
  let line = 0;
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    for await (const chunk of stream) {
      checkAbort(signal);
      pending += chunk;
      while (true) {
        checkAbort(signal);
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const raw = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        line += 1;
        if (!raw.trim()) continue;
        try {
          const parsed = JSON.parse(raw);
          const record = object(parsed);
          const projected = record ? project(record) : undefined;
          if (projected) rows.push({ value: projected, line });
          else if (!record)
            warning(warnings, "malformed-jsonl", "JSONL line is not an object", path, line);
        } catch {
          warning(warnings, "malformed-jsonl", "Malformed JSONL line", path, line);
        }
      }
    }
    checkAbort(signal);
    if (pending.trim()) {
      line += 1;
      try {
        const parsed = JSON.parse(pending.replace(/\r$/, ""));
        const record = object(parsed);
        const projected = record ? project(record) : undefined;
        if (projected) rows.push({ value: projected, line });
        // A non-object complete value is malformed even without a final newline.
        else if (!record)
          warning(warnings, "malformed-jsonl", "JSONL line is not an object", path, line);
      } catch {
        let activelyChanging = false;
        if (isIncompleteJsonPrefix(pending) && initialMetadata) {
          try {
            const finalMetadata = await stat(path);
            activelyChanging =
              finalMetadata.size !== initialMetadata.size ||
              finalMetadata.mtimeMs !== initialMetadata.mtimeMs;
          } catch {
            // A source that cannot be compared is not proven to have a live tail.
          }
        }
        if (!activelyChanging)
          warning(warnings, "malformed-jsonl", "Malformed JSONL line", path, line);
      }
    }
    return rows;
  } catch (error) {
    checkAbort(signal);
    warning(
      warnings,
      "unreadable-source",
      `Unable to read historical source: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
    return rows;
  }
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

const SNAPSHOT_IDENTITY_PATTERN = /^[0-9a-f]{24}$/i;

function validateSnapshot(value: unknown): UsageSnapshot | undefined {
  const snapshot = object(value);
  const identity = object(snapshot?.identity);
  const report = object(snapshot?.report);
  const semantics = object(report?.semantics);
  if (
    snapshot?.version !== 1 ||
    typeof snapshot.observationId !== "string" ||
    !snapshot.observationId ||
    (identity?.kind !== "account" && identity?.kind !== "credential") ||
    typeof identity.id !== "string" ||
    !SNAPSHOT_IDENTITY_PATTERN.test(identity.id) ||
    typeof snapshot.modelId !== "string" ||
    typeof report?.providerId !== "string" ||
    typeof report.providerName !== "string" ||
    typeof report.capturedAt !== "number" ||
    !Number.isFinite(report.capturedAt) ||
    typeof report.source !== "string" ||
    (semantics?.kind !== "consumer-subscription" &&
      semantics?.kind !== "api-key" &&
      semantics?.kind !== "project") ||
    typeof semantics.label !== "string" ||
    (report.accountLabel !== undefined && typeof report.accountLabel !== "string") ||
    (report.notes !== undefined &&
      (!Array.isArray(report.notes) || report.notes.some((note) => typeof note !== "string"))) ||
    !Array.isArray(report.buckets) ||
    !Array.isArray(report.metrics)
  ) {
    return undefined;
  }
  for (const value of report.buckets) {
    const bucket = object(value);
    if (
      typeof bucket?.id !== "string" ||
      typeof bucket.label !== "string" ||
      (bucket.unit !== "percent" && bucket.unit !== "usd" && bucket.unit !== "count") ||
      (bucket.groupId !== undefined && typeof bucket.groupId !== "string") ||
      (bucket.groupLabel !== undefined && typeof bucket.groupLabel !== "string") ||
      (bucket.modelKeys !== undefined &&
        (!Array.isArray(bucket.modelKeys) ||
          bucket.modelKeys.some((key) => typeof key !== "string"))) ||
      (bucket.period !== undefined && typeof bucket.period !== "string") ||
      !optionalFiniteNumber(bucket.used) ||
      !optionalFiniteNumber(bucket.remaining) ||
      !optionalFiniteNumber(bucket.limit) ||
      !optionalFiniteNumber(bucket.windowMinutes) ||
      !optionalFiniteNumber(bucket.resetsAt)
    ) {
      return undefined;
    }
  }
  for (const value of report.metrics) {
    const metric = object(value);
    if (
      typeof metric?.id !== "string" ||
      typeof metric.label !== "string" ||
      (typeof metric.value !== "string" &&
        (typeof metric.value !== "number" || !Number.isFinite(metric.value))) ||
      (metric.unit !== undefined &&
        metric.unit !== "percent" &&
        metric.unit !== "usd" &&
        metric.unit !== "count") ||
      (metric.resetExpirations !== undefined &&
        (!Array.isArray(metric.resetExpirations) ||
          metric.resetExpirations.some((expiration) => {
            const record = object(expiration);
            return (
              !record ||
              (record.kind !== "never" &&
                record.kind !== "unknown" &&
                (record.kind !== "dated" ||
                  typeof record.expiresAt !== "number" ||
                  !Number.isFinite(record.expiresAt)))
            );
          })))
    ) {
      return undefined;
    }
  }
  return {
    version: 1,
    observationId: snapshot.observationId as string,
    identity: {
      kind: identity.kind as UsageSnapshot["identity"]["kind"],
      id: identity.id as string,
    },
    modelId: snapshot.modelId as string,
    report: {
      providerId: report.providerId as string,
      providerName: report.providerName as string,
      capturedAt: report.capturedAt as number,
      source: report.source as string,
      semantics: {
        kind: semantics.kind as UsageSnapshot["report"]["semantics"]["kind"],
        label: semantics.label as string,
      },
      ...(report.accountLabel === undefined ? {} : { accountLabel: report.accountLabel as string }),
      buckets: report.buckets.map((value) => {
        const bucket = object(value) as Record<string, unknown>;
        return {
          id: bucket.id as string,
          label: bucket.label as string,
          ...(bucket.groupId === undefined ? {} : { groupId: bucket.groupId as string }),
          ...(bucket.groupLabel === undefined ? {} : { groupLabel: bucket.groupLabel as string }),
          unit: bucket.unit as UsageSnapshot["report"]["buckets"][number]["unit"],
          ...(bucket.used === undefined ? {} : { used: bucket.used as number }),
          ...(bucket.remaining === undefined ? {} : { remaining: bucket.remaining as number }),
          ...(bucket.limit === undefined ? {} : { limit: bucket.limit as number }),
          ...(bucket.windowMinutes === undefined
            ? {}
            : { windowMinutes: bucket.windowMinutes as number }),
          ...(bucket.resetsAt === undefined ? {} : { resetsAt: bucket.resetsAt as number }),
        };
      }),
      metrics: [],
    },
  };
}

function sessionEndTimestamp(entries: Record<string, unknown>[], signal?: AbortSignal): number {
  let end = Number.POSITIVE_INFINITY;
  let found = false;
  for (const entry of entries) {
    checkAbort(signal);
    let hasUsage = false;
    let at: number | undefined;
    if (entry.type === "message") {
      const message = object(entry.message);
      hasUsage = message?.role === "assistant" && normalizeUsage(message.usage) !== undefined;
      at = timestamp(message?.timestamp) ?? timestamp(entry.timestamp);
    } else if (
      entry.type === "usage" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary"
    ) {
      hasUsage = normalizeUsage(entry.usage) !== undefined;
      at = timestamp(entry.timestamp);
    }
    if (!hasUsage || at === undefined) continue;
    if (!found) end = at;
    else end = Math.max(end, at);
    found = true;
  }
  return end;
}

function normalizeSessions(
  sessions: RawSession[],
  warnings: HistoryWarning[],
  signal?: AbortSignal,
): void {
  const byPath = new Map(sessions.map((session) => [session.canonicalPath, session]));
  const states = new Map<RawSession, "visiting" | "done">();

  const visit = (session: RawSession, chain: RawSession[]): string => {
    checkAbort(signal);
    if (states.get(session) === "done") return session.lineageId ?? session.canonicalPath;
    if (states.get(session) === "visiting") {
      for (const member of chain) {
        member.lineageValid = false;
        member.lineageId = member.canonicalPath;
        states.set(member, "done");
      }
      warning(
        warnings,
        "cyclic-lineage",
        "Cyclic parentSession lineage was not deduplicated",
        session.path,
      );
      return session.canonicalPath;
    }
    states.set(session, "visiting");
    const parentValue = session.header.parentSession;
    if (typeof parentValue !== "string" || !parentValue) {
      session.lineageId = session.canonicalPath;
    } else {
      const parent = session.parentCanonicalPath
        ? byPath.get(session.parentCanonicalPath)
        : undefined;
      if (!parent) {
        // The first surviving session is a safe root for descendants whose links are present.
        session.lineageId = session.canonicalPath;
        warning(
          warnings,
          "broken-lineage",
          "parentSession source was not discovered",
          session.path,
        );
      } else {
        const root = visit(parent, [...chain, session]);
        session.lineageValid = session.lineageValid && parent.lineageValid;
        session.lineageId = session.lineageValid ? root : session.canonicalPath;
      }
    }
    states.set(session, "done");
    return session.lineageId;
  };

  for (const session of sessions) {
    checkAbort(signal);
    visit(session, []);
  }
}

function inheritedRoutes(
  entries: Record<string, unknown>[],
  signal?: AbortSignal,
): Map<string, string[]> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    checkAbort(signal);
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const cache = new Map<string, string[]>();
  const routeFor = (entry: Record<string, unknown>, visiting = new Set<string>()): string[] => {
    const id = typeof entry.id === "string" ? entry.id : "";
    const cached = cache.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return [];
    visiting.add(id);
    const parent = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined;
    let route = parent ? routeFor(parent, visiting) : [];
    if (
      entry.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string"
    ) {
      route = [entry.provider, entry.modelId];
    } else if (entry.type === "message") {
      const message = object(entry.message);
      if (
        message?.role === "assistant" &&
        typeof message.provider === "string" &&
        typeof message.model === "string"
      ) {
        route = [message.provider, message.model];
      }
    }
    if (id) cache.set(id, route);
    return route;
  };
  for (const entry of entries) {
    checkAbort(signal);
    if (typeof entry.id === "string") routeFor(entry);
  }
  return cache;
}

function normalizePersistedSession(
  session: RawSession,
  subagents: Map<string, Set<number>>,
  warnings: HistoryWarning[],
  signal?: AbortSignal,
): { calls: NormalizedCall[]; snapshots: NormalizedSnapshot[] } {
  const calls: NormalizedCall[] = [];
  const snapshots: NormalizedSnapshot[] = [];
  const routes = inheritedRoutes(session.entries, signal);
  const entriesById = new Map<string, Record<string, unknown>>();
  for (const entry of session.entries) {
    if (typeof entry.id === "string") entriesById.set(entry.id, entry);
  }
  const callsByEntryId = new Map<string, NormalizedCall>();
  for (let index = 0; index < session.entries.length; index += 1) {
    checkAbort(signal);
    const entry = session.entries[index];
    if (!entry) continue;
    const entryId = typeof entry.id === "string" ? entry.id : undefined;
    if (entry.type === "custom" && entry.customType === "subagents:record") {
      const id = object(entry.data)?.id;
      if (typeof id === "string" && id) {
        const at = timestamp(entry.timestamp);
        const timestamps = subagents.get(id) ?? new Set<number>();
        if (at !== undefined) timestamps.add(at);
        subagents.set(id, timestamps);
      }
      continue;
    }
    if (entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE) {
      const snapshot = validateSnapshot(entry.data);
      if (snapshot) {
        snapshots.push({ snapshot, source: session.source, entryId });
      } else {
        const capturedAt = object(object(entry.data)?.report)?.capturedAt;
        warnings.push({
          code: "malformed-snapshot",
          message: "Usage snapshot has an invalid version-1 shape",
          source: session.path ?? session.source.id,
          ...(typeof capturedAt === "number" && Number.isFinite(capturedAt)
            ? { timestamp: capturedAt }
            : {}),
        });
      }
      continue;
    }

    let usage: NormalizedUsage | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let content: unknown;
    let stopReason: string | undefined;
    let callTimestamp: number | undefined;
    let fidelity: TimestampFidelity = "entry";
    if (entry.type === "message") {
      const message = object(entry.message);
      if (message?.role !== "assistant") continue;
      usage = normalizeUsage(message.usage);
      if (message.usage !== undefined && !usage) {
        warning(
          warnings,
          "invalid-usage",
          "Usage-bearing call has invalid usage",
          session.path,
          undefined,
          timestamp(message.timestamp) ?? timestamp(entry.timestamp),
        );
        continue;
      }
      provider = typeof message.provider === "string" ? message.provider : undefined;
      model = typeof message.model === "string" ? message.model : undefined;
      content = message.contentHash;
      stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
      const embedded = timestamp(message.timestamp);
      callTimestamp = embedded ?? timestamp(entry.timestamp);
      fidelity =
        embedded === undefined ? (callTimestamp === undefined ? "missing" : "entry") : "embedded";
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      usage = normalizeUsage(entry.usage);
      if (entry.usage !== undefined && !usage) {
        warning(
          warnings,
          "invalid-usage",
          "Usage-bearing call has invalid usage",
          session.path,
          undefined,
          timestamp(entry.timestamp),
        );
        continue;
      }
      const route = entryId ? routes.get(entryId) : undefined;
      provider = route?.[0];
      model = route?.[1];
      content = entry.contentHash;
      callTimestamp = timestamp(entry.timestamp);
      fidelity = callTimestamp === undefined ? "missing" : "entry";
    } else if (entry.type === "usage") {
      usage = normalizeUsage(entry.usage);
      if (entry.usage !== undefined && !usage) {
        warning(
          warnings,
          "invalid-usage",
          "Usage-bearing call has invalid usage",
          session.path,
          undefined,
          timestamp(entry.timestamp),
        );
        continue;
      }
      provider = typeof entry.provider === "string" ? entry.provider : undefined;
      model = typeof entry.model === "string" ? entry.model : undefined;
      content = entry.contentHash;
      callTimestamp = timestamp(entry.timestamp);
      fidelity = callTimestamp === undefined ? "missing" : "entry";
    } else {
      continue;
    }
    if (!usage) continue;
    if (!provider || !model) {
      warning(
        warnings,
        "unattributable-call",
        "Usage-bearing call has no resolvable provider/model route",
        session.path,
        undefined,
        callTimestamp,
      );
      continue;
    }
    const call: NormalizedCall = {
      key: `${session.source.id}:${entryId ?? index}`,
      entryId,
      provider,
      model,
      timestamp: callTimestamp,
      timestampFidelity: fidelity,
      preciseTimestamp: fidelity !== "missing",
      usage,
      stopReason,
      contentHash: typeof content === "string" ? content : undefined,
      source: session.source,
      conversationId: session.source.id,
      predecessorKey: null,
      lineageId: session.lineageId,
    };
    calls.push(call);
    if (entryId) callsByEntryId.set(entryId, call);
  }

  for (const call of calls) {
    if (!call.entryId) continue;
    let parentId = entriesById.get(call.entryId)?.parentId;
    const visited = new Set<string>();
    while (typeof parentId === "string" && !visited.has(parentId)) {
      visited.add(parentId);
      const predecessor = callsByEntryId.get(parentId);
      if (predecessor) {
        call.predecessorKey = predecessor.key;
        break;
      }
      parentId = entriesById.get(parentId)?.parentId;
    }
  }
  return { calls, snapshots };
}

function normalizeOutput(
  transcript: OutputTranscript,
  warnings: HistoryWarning[],
  signal?: AbortSignal,
): NormalizedCall[] {
  const calls: NormalizedCall[] = [];
  for (const row of transcript.entries) {
    checkAbort(signal);
    const message = object(row.value.message);
    if (message?.role !== "assistant") continue;
    const usage = normalizeUsage(message.usage);
    if (message.usage !== undefined && !usage) {
      warning(
        warnings,
        "invalid-usage",
        "Usage-bearing call has invalid usage",
        transcript.path,
        row.line,
        timestamp(message.timestamp) ?? timestamp(row.value.timestamp),
      );
      continue;
    }
    if (!usage) continue;
    const embedded = timestamp(message.timestamp);
    const outer = timestamp(row.value.timestamp);
    if (
      typeof message.provider !== "string" ||
      !message.provider ||
      typeof message.model !== "string" ||
      !message.model
    ) {
      warning(
        warnings,
        "unattributable-call",
        "Usage-bearing call has no resolvable provider/model route",
        transcript.path,
        row.line,
        embedded ?? outer,
      );
      continue;
    }
    const fidelity: TimestampFidelity =
      embedded !== undefined ? "embedded" : outer !== undefined ? "flush" : "missing";
    calls.push({
      key: `${transcript.source.id}:${row.line}`,
      provider: message.provider,
      model: message.model,
      timestamp: embedded ?? outer,
      timestampFidelity: fidelity,
      preciseTimestamp: fidelity === "embedded",
      usage,
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      contentHash: typeof message.contentHash === "string" ? message.contentHash : undefined,
      source: transcript.source,
      conversationId: transcript.source.id,
    });
  }
  return calls;
}

async function discoverOutputs(
  root: string,
  cutoff: number,
  signal: AbortSignal | undefined,
  warnings: HistoryWarning[],
  sourceReadStarted?: (path: string) => void | Promise<void>,
): Promise<OutputTranscript[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    checkAbort(signal);
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(directory);
    } catch (error) {
      const absentRoot = directory === root && object(error)?.code === "ENOENT";
      if (!absentRoot) {
        warning(
          warnings,
          "unreadable-source",
          `Unable to enumerate output directory: ${String(error)}`,
          directory,
        );
      }
      return;
    }
    try {
      for await (const entry of handle) {
        checkAbort(signal);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".output")) files.push(path);
      }
    } catch (error) {
      checkAbort(signal);
      warning(
        warnings,
        "unreadable-source",
        `Unable to enumerate output directory: ${String(error)}`,
        directory,
      );
    }
  };
  await walk(root);

  const transcripts: OutputTranscript[] = [];
  for (const path of files.sort()) {
    checkAbort(signal);
    try {
      if ((await stat(path)).mtimeMs < cutoff) continue;
    } catch (error) {
      warning(
        warnings,
        "unreadable-source",
        `Unable to inspect output source: ${String(error)}`,
        path,
      );
      continue;
    }
    const parts = relative(root, path).split(/[\\/]/);
    const tasks = parts.lastIndexOf("tasks");
    if (tasks < 1 || tasks !== parts.length - 2) continue;
    const rootSessionId = parts[tasks - 1];
    const agentId = parts[tasks + 1]?.slice(0, -".output".length);
    if (!rootSessionId || !agentId) continue;
    const canonical = await canonicalPath(path);
    checkAbort(signal);
    const source: HistorySource = {
      kind: "output",
      id: `output:${canonical}`,
      path: canonical,
      rootSessionId,
      agentId,
    };
    transcripts.push({
      path: canonical,
      source,
      entries: await readJsonLines(
        canonical,
        signal,
        warnings,
        projectOutputRow,
        sourceReadStarted,
      ),
    });
  }
  return transcripts;
}

function deduplicatePersistedCalls(
  sessions: RawSession[],
  calls: NormalizedCall[],
  signal?: AbortSignal,
): NormalizedCall[] {
  const sessionOrder = new Map<string, number>();
  const grouped = new Map<string, RawSession[]>();
  for (const session of sessions) {
    checkAbort(signal);
    const id = session.lineageId ?? session.canonicalPath;
    const values = grouped.get(id);
    if (values) values.push(session);
    else grouped.set(id, [session]);
  }
  for (const values of grouped.values()) {
    checkAbort(signal);
    values.sort(
      (a, b) => a.endTimestamp - b.endTimestamp || a.canonicalPath.localeCompare(b.canonicalPath),
    );
    values.forEach((session, index) => {
      sessionOrder.set(session.source.id, index);
    });
  }
  const ordered = [...calls].sort((a, b) => {
    const lineage = (a.lineageId ?? "").localeCompare(b.lineageId ?? "");
    if (lineage) return lineage;
    return (sessionOrder.get(a.source.id) ?? 0) - (sessionOrder.get(b.source.id) ?? 0);
  });
  const canonicalByEntry = new Map<string, NormalizedCall>();
  const canonicalKeyByCallKey = new Map<string, string>();
  const retained: NormalizedCall[] = [];
  for (const call of ordered) {
    checkAbort(signal);
    if (!call.entryId || !call.lineageId) {
      canonicalKeyByCallKey.set(call.key, call.key);
      retained.push(call);
      continue;
    }
    const entryKey = `${call.lineageId}\0${call.entryId}`;
    const canonical = canonicalByEntry.get(entryKey);
    if (canonical) {
      canonicalKeyByCallKey.set(call.key, canonical.key);
      continue;
    }
    canonicalByEntry.set(entryKey, call);
    canonicalKeyByCallKey.set(call.key, call.key);
    retained.push(call);
  }
  for (const call of retained) {
    if (typeof call.predecessorKey !== "string") continue;
    call.predecessorKey = canonicalKeyByCallKey.get(call.predecessorKey) ?? call.predecessorKey;
  }
  return retained;
}

function deduplicateOutputs(
  persisted: NormalizedCall[],
  outputs: NormalizedCall[],
  sessions: RawSession[],
  warnings: HistoryWarning[],
  signal?: AbortSignal,
): NormalizedCall[] {
  const rootsBySessionId = new Map<string, Set<string>>();
  for (const session of sessions) {
    checkAbort(signal);
    if (typeof session.header.id !== "string" || !session.lineageId) continue;
    const roots = rootsBySessionId.get(session.header.id) ?? new Set<string>();
    roots.add(session.lineageId);
    rootsBySessionId.set(session.header.id, roots);
  }
  const byLineageFingerprint = new Map<string, NormalizedCall[]>();
  for (const call of persisted) {
    checkAbort(signal);
    if (call.source.kind === "active" || call.source.kind === "session") {
      const key = `${call.lineageId ?? ""}\0${fingerprintCall(call)}`;
      const values = byLineageFingerprint.get(key);
      if (values) values.push(call);
      else byLineageFingerprint.set(key, [call]);
    }
  }
  const retained: NormalizedCall[] = [];
  const candidates = new Map<string, NormalizedCall[]>();
  for (const call of outputs) {
    checkAbort(signal);
    const rootSessionId = call.source.rootSessionId;
    const roots = rootSessionId ? rootsBySessionId.get(rootSessionId) : undefined;
    if (roots?.size !== 1) {
      if (roots && roots.size > 1) {
        warning(
          warnings,
          "ambiguous-output-match",
          "Output transcript maps to multiple persisted lineages",
          call.source.path,
          undefined,
          call.timestamp,
        );
      }
      retained.push(call);
      continue;
    }
    const lineage = [...roots][0];
    if (!lineage) {
      retained.push(call);
      continue;
    }
    const key = `${lineage}\0${fingerprintCall(call)}`;
    const values = candidates.get(key);
    if (values) values.push(call);
    else candidates.set(key, [call]);
  }
  for (const [key, matchingOutputs] of candidates) {
    checkAbort(signal);
    const matchingPersisted = byLineageFingerprint.get(key) ?? [];
    if (matchingPersisted.length === 1 && matchingOutputs.length === 1) continue;
    if (matchingPersisted.length > 0) {
      warning(
        warnings,
        "ambiguous-output-match",
        "Persisted and output calls do not have an unambiguous one-to-one match",
        matchingOutputs[0]?.source.path,
        undefined,
        [...matchingPersisted, ...matchingOutputs]
          .map((call) => call.timestamp)
          .filter((at): at is number => at !== undefined),
      );
    }
    retained.push(...matchingOutputs);
  }
  return retained;
}

/** Load and deduplicate all range-independent historical records without writing sources. */
export async function loadHistory(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
  options: LoadHistoryOptions = {},
): Promise<LoadedHistory> {
  const signal = options.signal;
  const now = options.now ?? Date.now();
  const cutoff = now - HISTORY_MAX_AGE_MS - HISTORY_BOUNDARY_TOLERANCE_MS;
  const warnings: HistoryWarning[] = [];
  checkAbort(signal);

  const activeManager = ctx.sessionManager;
  const activeHeader = activeManager.getHeader() as unknown as Record<string, unknown>;
  const activeEntries = (activeManager.getEntries() as unknown as Record<string, unknown>[])
    .map(projectSessionRow)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const activeFile = activeManager.getSessionFile();
  const activeCanonical = activeFile
    ? await canonicalPath(activeFile)
    : `memory:${activeManager.getSessionId()}`;
  checkAbort(signal);
  const activeSource: HistorySource = {
    kind: "active",
    id: `active:${activeCanonical}`,
    path: activeFile ? activeCanonical : undefined,
    sessionId: typeof activeHeader.id === "string" ? activeHeader.id : activeManager.getSessionId(),
  };

  const listAll: ListAll =
    options.listAll ??
    (async (sessionDir?: string) =>
      sessionDir ? SessionManager.listAll(sessionDir) : SessionManager.listAll());
  const listed = await listAll();
  checkAbort(signal);
  const candidates = [...listed];
  const listedCanonical = new Set<string>();
  for (const info of listed) {
    checkAbort(signal);
    listedCanonical.add(await canonicalPath(info.path));
    checkAbort(signal);
  }
  if (activeFile && !listedCanonical.has(activeCanonical)) {
    const customListed = await listAll(activeManager.getSessionDir());
    checkAbort(signal);
    candidates.push(...customListed);
  }

  const paths = new Map<string, ListedSession>();
  for (const info of candidates) {
    checkAbort(signal);
    const canonical = await canonicalPath(info.path);
    checkAbort(signal);
    if (canonical === activeCanonical) continue;
    if (!paths.has(canonical)) paths.set(canonical, info);
  }

  const activeParent =
    typeof activeHeader.parentSession === "string" && activeHeader.parentSession
      ? await canonicalPath(resolve(dirname(activeCanonical), activeHeader.parentSession))
      : undefined;
  checkAbort(signal);
  const sessions: RawSession[] = [
    {
      path: activeFile,
      canonicalPath: activeCanonical,
      source: activeSource,
      header: activeHeader,
      entries: [...activeEntries],
      endTimestamp: sessionEndTimestamp(activeEntries, signal),
      parentCanonicalPath: activeParent,
      lineageValid: true,
    },
  ];
  for (const path of paths.keys()) {
    checkAbort(signal);
    try {
      if ((await stat(path)).mtimeMs < cutoff) continue;
    } catch (error) {
      checkAbort(signal);
      warning(
        warnings,
        "unreadable-source",
        `Unable to inspect session source: ${String(error)}`,
        path,
      );
      continue;
    }
    checkAbort(signal);
    const rows = await readJsonLines(
      path,
      signal,
      warnings,
      projectSessionRow,
      options.sourceReadStarted,
    );
    checkAbort(signal);
    const header = rows[0]?.value.type === "session" ? rows[0].value : undefined;
    if (!header) {
      warning(warnings, "malformed-jsonl", "Session header is missing", path);
      continue;
    }
    const entries: Record<string, unknown>[] = [];
    for (let index = 1; index < rows.length; index += 1) {
      checkAbort(signal);
      const entry = rows[index]?.value;
      if (entry) entries.push(entry);
    }
    const parentCanonicalPath =
      typeof header.parentSession === "string" && header.parentSession
        ? await canonicalPath(resolve(dirname(path), header.parentSession))
        : undefined;
    checkAbort(signal);
    sessions.push({
      path,
      canonicalPath: path,
      source: {
        kind: "session",
        id: `session:${path}`,
        path,
        sessionId: typeof header.id === "string" ? header.id : undefined,
      },
      header,
      entries,
      endTimestamp: sessionEndTimestamp(entries, signal),
      parentCanonicalPath,
      lineageValid: true,
    });
  }

  normalizeSessions(sessions, warnings, signal);
  const subagents = new Map<string, Set<number>>();
  const persistedCalls: NormalizedCall[] = [];
  const snapshots: NormalizedSnapshot[] = [];
  for (const session of sessions) {
    checkAbort(signal);
    const normalized = normalizePersistedSession(session, subagents, warnings, signal);
    persistedCalls.push(...normalized.calls);
    snapshots.push(...normalized.snapshots);
  }
  const deduplicatedPersisted = deduplicatePersistedCalls(sessions, persistedCalls, signal);

  const outputRoot =
    options.outputRoot ?? join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
  const transcripts = await discoverOutputs(
    outputRoot,
    cutoff,
    signal,
    warnings,
    options.sourceReadStarted,
  );
  const outputCalls: NormalizedCall[] = [];
  for (const transcript of transcripts) {
    checkAbort(signal);
    if (transcript.source.agentId) {
      const timestamps = subagents.get(transcript.source.agentId) ?? new Set<number>();
      for (const row of transcript.entries) {
        const at =
          timestamp(object(row.value.message)?.timestamp) ?? timestamp(row.value.timestamp);
        if (at !== undefined) timestamps.add(at);
      }
      subagents.set(transcript.source.agentId, timestamps);
    }
    outputCalls.push(...normalizeOutput(transcript, warnings, signal));
  }
  const retainedOutputs = deduplicateOutputs(
    deduplicatedPersisted,
    outputCalls,
    sessions,
    warnings,
    signal,
  );
  const lineagesBySessionId = new Map<string, Set<string>>();
  for (const session of sessions) {
    if (typeof session.header.id !== "string" || !session.lineageId) continue;
    const values = lineagesBySessionId.get(session.header.id) ?? new Set<string>();
    values.add(session.lineageId);
    lineagesBySessionId.set(session.header.id, values);
  }
  for (const call of retainedOutputs) {
    const roots = call.source.rootSessionId
      ? lineagesBySessionId.get(call.source.rootSessionId)
      : undefined;
    if (roots?.size === 1) call.lineageId = [...roots][0];
  }

  const observations = new Set<string>();
  const deduplicatedSnapshots = snapshots.filter(({ snapshot }) => {
    checkAbort(signal);
    if (observations.has(snapshot.observationId)) return false;
    observations.add(snapshot.observationId);
    return true;
  });
  const calls = [...deduplicatedPersisted, ...retainedOutputs];
  for (const call of calls) {
    checkAbort(signal);
    if (call.timestamp === undefined) {
      warning(
        warnings,
        "untimestamped-call",
        "Usage call has no usable timestamp",
        call.source.path,
      );
    }
  }

  return {
    now,
    calls,
    snapshots: deduplicatedSnapshots,
    warnings,
    subagents: [...subagents]
      .map(([id, timestamps]) => ({ id, timestamps: [...timestamps].sort((a, b) => a - b) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Select a closed rolling interval from one fixed history load. */
export function callsInRange(history: LoadedHistory, durationMs: number): NormalizedCall[] {
  const since = history.now - durationMs;
  return history.calls.filter(
    (call) =>
      call.timestamp !== undefined && call.timestamp >= since && call.timestamp <= history.now,
  );
}

export const CACHE_GAP_BUCKETS = ["<1m", "1–5m", "5–10m", "10–30m", "30–60m", "1h+"] as const;
export type CacheGapBucket = (typeof CACHE_GAP_BUCKETS)[number];

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  calls: number;
}

export interface OverviewHistory {
  rootSessions: number;
  subagents: number;
  totals: TokenTotals;
  cachedInputShare?: number;
  callsReadingCache?: number;
}

export interface ModelHistoryRow extends TokenTotals {
  provider: string;
  model: string;
  route: string;
}

export interface CacheGapCell {
  hits: number;
  samples: number;
  percentage?: number;
}

export interface CacheHistoryRow {
  provider: string;
  model: string;
  route: string;
  gaps: Record<CacheGapBucket, CacheGapCell>;
}

export interface QuotaObservation {
  capturedAt: number;
  percentage?: number;
  raw: UsageBucket;
}

export interface QuotaMovement {
  latestPercentage?: number;
  observedPeak?: number;
  observedConsumption: number;
  observedResets: number;
}

export interface CapacityEstimate {
  observedConsumedPercent: number;
  estimated100PercentTokens: number;
  estimated100PercentCost?: number;
  lowerBound: boolean;
  warnings: string[];
}

export interface QuotaBucketHistory extends QuotaMovement {
  id: string;
  label: string;
  unit: UsageUnit;
  latest: UsageBucket;
  observations: QuotaObservation[];
  historicalBoundary?: QuotaObservation;
  current?: QuotaObservation;
  capacity?: CapacityEstimate;
  capacityWarnings: string[];
}

export interface QuotaIdentityHistory {
  identity: UsageSnapshotIdentity;
  label?: string;
  buckets: QuotaBucketHistory[];
}

export interface QuotaProviderHistory {
  providerId: string;
  providerName: string;
  identities: QuotaIdentityHistory[];
  current: boolean;
  noHistoryInRange: boolean;
  liveReport?: UsageReport;
}

export interface QuotaHistory {
  providers: QuotaProviderHistory[];
}

export interface LiveQuotaContext {
  providerId: string;
  providerName: string;
  identity?: UsageSnapshotIdentity;
  report: UsageReport;
}

export interface HistoryRangeView {
  since: number;
  now: number;
  overview: OverviewHistory;
  models: ModelHistoryRow[];
  cache: {
    cachedInputShare?: number;
    callsReadingCache?: number;
    rows: CacheHistoryRow[];
  };
  quotas: QuotaHistory;
  warnings: HistoryWarning[];
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, calls: 0 };
}

function addCall(totals: TokenTotals, call: NormalizedCall): void {
  totals.input += call.usage.input;
  totals.output += call.usage.output;
  totals.cacheRead += call.usage.cacheRead;
  totals.cacheWrite += call.usage.cacheWrite;
  totals.total += call.usage.totalTokens;
  totals.cost += call.usage.cost.total;
  totals.calls += 1;
}

function gapBucket(gap: number): CacheGapBucket {
  if (gap < 60_000) return "<1m";
  if (gap < 5 * 60_000) return "1–5m";
  if (gap < 10 * 60_000) return "5–10m";
  if (gap < 30 * 60_000) return "10–30m";
  if (gap < 60 * 60_000) return "30–60m";
  return "1h+";
}

function blankGaps(): Record<CacheGapBucket, CacheGapCell> {
  return Object.fromEntries(
    CACHE_GAP_BUCKETS.map((bucket) => [bucket, { hits: 0, samples: 0 }]),
  ) as Record<CacheGapBucket, CacheGapCell>;
}

function derivePercentage(bucket: UsageBucket): number | undefined {
  let value: number | undefined;
  if (bucket.unit === "percent") {
    value = bucket.used ?? (bucket.remaining === undefined ? undefined : 100 - bucket.remaining);
  } else if (bucket.limit !== undefined && bucket.limit > 0) {
    const used =
      bucket.used ?? (bucket.remaining === undefined ? undefined : bucket.limit - bucket.remaining);
    if (used !== undefined) value = (used * 100) / bucket.limit;
  }
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/** Reduce noisy quota readings without treating shallow provider corrections as refunds. */
export function reduceQuotaMovement(percentages: number[]): QuotaMovement {
  if (percentages.length === 0) {
    return { observedConsumption: 0, observedResets: 0 };
  }
  let runningPeak = percentages[0] ?? 0;
  let observedPeak = runningPeak;
  let consumption = 0;
  let resets = 0;
  for (let index = 1; index < percentages.length; index += 1) {
    const value = percentages[index] ?? 0;
    observedPeak = Math.max(observedPeak, value);
    if (value < runningPeak * 0.5) {
      resets += 1;
      consumption += value;
      runningPeak = value;
    } else if (value > runningPeak) {
      consumption += value - runningPeak;
      runningPeak = value;
    }
  }
  return {
    latestPercentage: percentages.at(-1),
    observedPeak,
    observedConsumption: consumption,
    observedResets: resets,
  };
}

interface IdentitySeries {
  providerId: string;
  providerName: string;
  identity: UsageSnapshotIdentity;
  identityLabel?: string;
  metadataCapturedAt: number;
  capturedAt: number[];
}

interface BucketSeries {
  providerId: string;
  providerName: string;
  identity: UsageSnapshotIdentity;
  identityLabel?: string;
  id: string;
  observations: QuotaObservation[];
}

function collectQuotaSeries(history: LoadedHistory): {
  buckets: BucketSeries[];
  identities: IdentitySeries[];
} {
  const groups = new Map<string, BucketSeries>();
  const identities = new Map<string, IdentitySeries>();
  for (const { snapshot } of history.snapshots) {
    const identityGroupKey = `${snapshot.report.providerId}\0${snapshot.identity.kind}\0${snapshot.identity.id}`;
    let identityGroup = identities.get(identityGroupKey);
    if (!identityGroup) {
      identityGroup = {
        providerId: snapshot.report.providerId,
        providerName: snapshot.report.providerName,
        identity: snapshot.identity,
        identityLabel: snapshot.report.accountLabel,
        metadataCapturedAt: snapshot.report.capturedAt,
        capturedAt: [],
      };
      identities.set(identityGroupKey, identityGroup);
    }
    if (snapshot.report.capturedAt >= identityGroup.metadataCapturedAt) {
      identityGroup.providerName = snapshot.report.providerName;
      identityGroup.identityLabel = snapshot.report.accountLabel;
      identityGroup.metadataCapturedAt = snapshot.report.capturedAt;
    }
    identityGroup.capturedAt.push(snapshot.report.capturedAt);
    for (const bucket of snapshot.report.buckets) {
      const key = `${snapshot.report.providerId}\0${snapshot.identity.kind}\0${snapshot.identity.id}\0${bucket.id}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          providerId: snapshot.report.providerId,
          providerName: snapshot.report.providerName,
          identity: snapshot.identity,
          identityLabel: snapshot.report.accountLabel,
          id: bucket.id,
          observations: [],
        };
        groups.set(key, group);
      }
      group.observations.push({
        capturedAt: snapshot.report.capturedAt,
        percentage: derivePercentage(bucket),
        raw: bucket,
      });
    }
  }
  for (const group of groups.values()) {
    group.observations.sort((a, b) => a.capturedAt - b.capturedAt);
    const identity = identities.get(
      `${group.providerId}\0${group.identity.kind}\0${group.identity.id}`,
    );
    if (identity) {
      group.providerName = identity.providerName;
      group.identityLabel = identity.identityLabel;
    }
  }
  for (const identity of identities.values()) identity.capturedAt.sort((a, b) => a - b);
  return { buckets: [...groups.values()], identities: [...identities.values()] };
}

interface TrimmedSeries {
  observations?: QuotaObservation[];
  warnings: string[];
}

/** Select quota samples around both activity edges using the plan's outer/inner tolerances. */
function trimBucketSeries(
  observations: QuotaObservation[],
  firstCall: number,
  lastCall: number,
): TrimmedSeries {
  const tolerance = HISTORY_BOUNDARY_TOLERANCE_MS;
  const outerWarning = 10 * 60_000;
  const before = observations.filter((item) => item.capturedAt <= firstCall).at(-1);
  const firstInside = observations.find((item) => item.capturedAt >= firstCall);
  const after = observations.find((item) => item.capturedAt >= lastCall);
  const lastInside = [...observations].reverse().find((item) => item.capturedAt <= lastCall);
  const near = observations.some(
    (item) => item.capturedAt >= firstCall - tolerance && item.capturedAt <= lastCall + tolerance,
  );
  const warnings: string[] = [];

  let start: QuotaObservation | undefined;
  if (before && firstCall - before.capturedAt <= tolerance) {
    start = before;
    if (firstCall - before.capturedAt > outerWarning)
      warnings.push("start boundary is more than 10m before activity");
  } else if (firstInside && firstInside.capturedAt - firstCall <= tolerance) {
    start = firstInside;
    warnings.push("early usage is missing from the capacity interval");
  }

  let end: QuotaObservation | undefined;
  if (after && after.capturedAt - lastCall <= tolerance) {
    end = after;
    if (after.capturedAt - lastCall > outerWarning)
      warnings.push("end boundary is more than 10m after activity");
  } else if (lastInside && lastCall - lastInside.capturedAt <= tolerance) {
    end = lastInside;
    warnings.push("late usage is missing from the capacity interval");
  }

  if (!start || !end || start.capturedAt >= end.capturedAt) {
    return {
      warnings: near ? ["quota samples do not cover both activity boundaries"] : [],
    };
  }
  return {
    observations: observations.filter(
      (item) => item.capturedAt >= start.capturedAt && item.capturedAt <= end.capturedAt,
    ),
    warnings,
  };
}

function identityKey(identity: UsageSnapshotIdentity): string {
  return `${identity.kind}\0${identity.id}`;
}

function aggregateQuotas(
  history: LoadedHistory,
  since: number,
  calls: NormalizedCall[],
  live?: LiveQuotaContext,
): QuotaHistory {
  const series = collectQuotaSeries(history);
  const relevant = series.buckets.filter((group) =>
    group.observations.some(
      (item) =>
        item.capturedAt >= since - HISTORY_BOUNDARY_TOLERANCE_MS &&
        item.capturedAt <= history.now + HISTORY_BOUNDARY_TOLERANCE_MS,
    ),
  );
  const providerCalls = new Map<string, NormalizedCall[]>();
  for (const call of calls) {
    const values = providerCalls.get(call.provider);
    if (values) values.push(call);
    else providerCalls.set(call.provider, [call]);
  }
  const relevantIdentities = series.identities.filter((group) =>
    group.capturedAt.some(
      (capturedAt) =>
        capturedAt >= since - HISTORY_BOUNDARY_TOLERANCE_MS &&
        capturedAt <= history.now + HISTORY_BOUNDARY_TOLERANCE_MS,
    ),
  );
  const providers = new Map<string, QuotaProviderHistory>();
  for (const group of relevantIdentities) {
    let provider = providers.get(group.providerId);
    if (!provider) {
      provider = {
        providerId: group.providerId,
        providerName: group.providerName,
        identities: [],
        current: live?.providerId === group.providerId,
        noHistoryInRange: false,
      };
      providers.set(group.providerId, provider);
    } else {
      const currentMetadata = relevantIdentities
        .filter((item) => item.providerId === group.providerId)
        .reduce((latest, item) => Math.max(latest, item.metadataCapturedAt), -Infinity);
      if (group.metadataCapturedAt === currentMetadata) provider.providerName = group.providerName;
    }
    provider.identities.push({
      identity: group.identity,
      label: group.identityLabel,
      buckets: [],
    });
  }
  for (const group of relevant) {
    const provider = providers.get(group.providerId);
    const identity = provider?.identities.find(
      (item) => identityKey(item.identity) === identityKey(group.identity),
    );
    if (!provider || !identity) continue;
    const inRange = group.observations.filter(
      (item) => item.capturedAt >= since && item.capturedAt <= history.now,
    );
    const percentages = inRange
      .map((item) => item.percentage)
      .filter((value): value is number => value !== undefined);
    const latestObservation = inRange.at(-1) ?? group.observations.at(-1);
    if (!latestObservation) continue;
    const movement = reduceQuotaMovement(percentages);
    movement.latestPercentage = inRange.at(-1)?.percentage;
    const bucket: QuotaBucketHistory = {
      id: group.id,
      label: latestObservation.raw.label,
      unit: latestObservation.raw.unit,
      latest: latestObservation.raw,
      observations: inRange,
      ...(inRange.length === 0 ? { historicalBoundary: latestObservation } : {}),
      ...movement,
      capacityWarnings: [],
    };
    identity.buckets.push(bucket);
  }

  for (const provider of providers.values()) {
    provider.noHistoryInRange = !relevantIdentities.some(
      (group) =>
        group.providerId === provider.providerId &&
        group.capturedAt.some((capturedAt) => capturedAt >= since && capturedAt <= history.now),
    );
    const matchingCalls = (providerCalls.get(provider.providerId) ?? []).filter(
      (call): call is NormalizedCall & { timestamp: number } => call.timestamp !== undefined,
    );
    if (matchingCalls.length === 0) continue;
    matchingCalls.sort((a, b) => a.timestamp - b.timestamp);
    const first = matchingCalls[0]?.timestamp;
    const last = matchingCalls.at(-1)?.timestamp;
    if (first === undefined || last === undefined) continue;
    const overlappingIdentities = new Set(
      relevantIdentities
        .filter(
          (group) =>
            group.providerId === provider.providerId &&
            group.capturedAt.some(
              (capturedAt) =>
                capturedAt >= first - HISTORY_BOUNDARY_TOLERANCE_MS &&
                capturedAt <= last + HISTORY_BOUNDARY_TOLERANCE_MS,
            ),
        )
        .map((group) => identityKey(group.identity)),
    );
    const ambiguous = overlappingIdentities.size !== 1;
    for (const identity of provider.identities) {
      for (const bucket of identity.buckets) {
        const group = relevant.find(
          (item) =>
            item.providerId === provider.providerId &&
            identityKey(item.identity) === identityKey(identity.identity) &&
            item.id === bucket.id,
        );
        if (!group) continue;
        const capacityObservations = group.observations.filter(
          (item): item is QuotaObservation & { percentage: number } =>
            item.percentage !== undefined,
        );
        const trimmed = trimBucketSeries(capacityObservations, first, last);
        bucket.capacityWarnings.push(...trimmed.warnings);
        if (ambiguous) {
          if (overlappingIdentities.has(identityKey(identity.identity))) {
            bucket.capacityWarnings.push(
              "overlapping quota identities prevent activity correlation",
            );
          }
          continue;
        }
        const samples = trimmed.observations;
        if (!samples) continue;
        const values = samples
          .map((item) => item.percentage)
          .filter((value): value is number => value !== undefined);
        if (values.length < 2 || derivePercentage(bucket.latest) === undefined) continue;
        const movement = reduceQuotaMovement(values);
        if (movement.observedConsumption <= 0) continue;
        const totals = emptyTotals();
        for (const call of matchingCalls) addCall(totals, call);
        const warnings = [...trimmed.warnings];
        let lowerBound = false;
        const windowMinutes = bucket.latest.windowMinutes;
        if (windowMinutes !== undefined && windowMinutes > 0) {
          for (let index = 1; index < samples.length; index += 1) {
            if (
              (samples[index]?.capturedAt ?? 0) - (samples[index - 1]?.capturedAt ?? 0) >
              windowMinutes * 60_000
            ) {
              lowerBound = true;
              warnings.push(
                "sampling gap spans a complete quota window; estimate is a lower bound",
              );
              break;
            }
          }
        }
        bucket.capacity = {
          observedConsumedPercent: movement.observedConsumption,
          estimated100PercentTokens: (totals.total * 100) / movement.observedConsumption,
          ...(totals.cost > 0
            ? { estimated100PercentCost: (totals.cost * 100) / movement.observedConsumption }
            : {}),
          lowerBound,
          warnings,
        };
      }
    }
  }

  if (live) {
    let provider = providers.get(live.providerId);
    if (!provider) {
      provider = {
        providerId: live.providerId,
        providerName: live.providerName,
        identities: [],
        current: true,
        noHistoryInRange: true,
        liveReport: live.report,
      };
      providers.set(live.providerId, provider);
    } else {
      provider.current = true;
      provider.providerName = live.providerName;
      provider.liveReport = live.report;
    }
    if (live.identity) {
      let identity = provider.identities.find(
        (item) =>
          identityKey(item.identity) === identityKey(live.identity as UsageSnapshotIdentity),
      );
      if (!identity) {
        identity = {
          identity: live.identity,
          label: live.report.accountLabel,
          buckets: [],
        };
        provider.identities.push(identity);
      }
      for (const raw of live.report.buckets) {
        const current = {
          capturedAt: live.report.capturedAt,
          percentage: derivePercentage(raw),
          raw,
        };
        const bucket = identity.buckets.find((item) => item.id === raw.id);
        if (bucket) {
          bucket.current = current;
        } else {
          identity.buckets.push({
            id: raw.id,
            label: raw.label,
            unit: raw.unit,
            latest: raw,
            observations: [],
            current,
            latestPercentage: current.percentage,
            observedConsumption: 0,
            observedResets: 0,
            capacityWarnings: [],
          });
        }
      }
    }
  }

  const result = [...providers.values()];
  for (const provider of result) {
    provider.identities.sort((a, b) => {
      const aCurrent =
        live?.providerId === provider.providerId &&
        live.identity &&
        identityKey(a.identity) === identityKey(live.identity);
      const bCurrent =
        live?.providerId === provider.providerId &&
        live.identity &&
        identityKey(b.identity) === identityKey(live.identity);
      return (
        Number(Boolean(bCurrent)) - Number(Boolean(aCurrent)) ||
        identityKey(a.identity).localeCompare(identityKey(b.identity))
      );
    });
    for (const identity of provider.identities)
      identity.buckets.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }
  result.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      a.providerName.localeCompare(b.providerName) ||
      a.providerId.localeCompare(b.providerId),
  );
  return { providers: result };
}

/** Derive every history tab from one fixed, already deduplicated load. */
export function deriveHistoryRange(
  history: LoadedHistory,
  durationMs: number,
  options: { live?: LiveQuotaContext } = {},
): HistoryRangeView {
  const since = history.now - durationMs;
  const calls = callsInRange(history, durationMs);
  const totals = emptyTotals();
  let cacheReaders = 0;
  const models = new Map<string, ModelHistoryRow>();
  for (const call of calls) {
    addCall(totals, call);
    if (call.usage.cacheRead > 0) cacheReaders += 1;
    const route = `${call.provider}/${call.model}`;
    let row = models.get(route);
    if (!row) {
      row = { provider: call.provider, model: call.model, route, ...emptyTotals() };
      models.set(route, row);
    }
    addCall(row, call);
  }
  const inputTotal = totals.input + totals.cacheRead + totals.cacheWrite;
  const cachedInputShare = inputTotal > 0 ? (totals.cacheRead * 100) / inputTotal : undefined;
  const callsReadingCache = totals.calls > 0 ? (cacheReaders * 100) / totals.calls : undefined;

  const cacheRows = new Map<string, CacheHistoryRow>();
  for (const row of models.values()) {
    cacheRows.set(row.route, {
      provider: row.provider,
      model: row.model,
      route: row.route,
      gaps: blankGaps(),
    });
  }
  const conversations = new Map<string, NormalizedCall[]>();
  for (const call of calls) {
    const conversationKey =
      call.predecessorKey !== undefined && call.lineageId
        ? `lineage:${call.lineageId}`
        : call.conversationId;
    const values = conversations.get(conversationKey);
    if (values) values.push(call);
    else conversations.set(conversationKey, [call]);
  }
  let impreciseGapTiming = false;
  for (const conversation of conversations.values()) {
    conversation.sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.key.localeCompare(b.key),
    );
    const callsByKey = new Map(conversation.map((call) => [call.key, call]));
    for (let index = 0; index < conversation.length; index += 1) {
      const current = conversation[index];
      if (!current) continue;
      const previous =
        current.predecessorKey !== undefined
          ? current.predecessorKey === null
            ? undefined
            : callsByKey.get(current.predecessorKey)
          : conversation[index - 1];
      if (!previous) continue;
      if (previous.provider !== current.provider || previous.model !== current.model) continue;
      const gap = (current.timestamp ?? Number.NaN) - (previous.timestamp ?? Number.NaN);
      if (!Number.isFinite(gap) || gap < 0 || previous.usage.totalTokens <= 0) continue;
      if (!previous.preciseTimestamp || !current.preciseTimestamp) {
        impreciseGapTiming = true;
        continue;
      }
      const cell = cacheRows.get(`${current.provider}/${current.model}`)?.gaps[gapBucket(gap)];
      if (!cell) continue;
      cell.samples += 1;
      if (current.usage.cacheRead >= previous.usage.totalTokens * 0.5) cell.hits += 1;
    }
  }
  for (const row of cacheRows.values()) {
    for (const cell of Object.values(row.gaps)) {
      cell.percentage = cell.samples > 0 ? (cell.hits * 100) / cell.samples : undefined;
    }
  }

  const rootKeys = new Set<string>();
  for (const call of calls) {
    rootKeys.add(
      call.lineageId ?? call.source.rootSessionId ?? call.source.sessionId ?? call.source.id,
    );
  }
  const subagentCount = history.subagents.filter((agent) =>
    agent.timestamps.some((at) => at >= since && at <= history.now),
  ).length;
  const warnings = history.warnings.filter((item) => {
    if (item.timestamps && item.timestamps.length > 0)
      return item.timestamps.some((at) => at >= since && at <= history.now);
    return (
      item.timestamp === undefined || (item.timestamp >= since && item.timestamp <= history.now)
    );
  });
  if (impreciseGapTiming) {
    warnings.push({
      code: "imprecise-gap-timing",
      message:
        "Some in-range calls lack precise timing and were excluded from cache-gap transitions",
    });
  }
  return {
    since,
    now: history.now,
    overview: {
      rootSessions: rootKeys.size,
      subagents: subagentCount,
      totals,
      cachedInputShare,
      callsReadingCache,
    },
    models: [...models.values()].sort(
      (a, b) => b.total - a.total || a.route.localeCompare(b.route),
    ),
    cache: {
      cachedInputShare,
      callsReadingCache,
      rows: [...cacheRows.values()].sort((a, b) => a.route.localeCompare(b.route)),
    },
    quotas: aggregateQuotas(history, since, calls, options.live),
    warnings,
  };
}
