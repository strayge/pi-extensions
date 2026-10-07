import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type ExtensionContext,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const HISTORY_BOUNDARY_TOLERANCE_MS = 30 * 60 * 1000;

export type HistorySourceKind = "active" | "session";
export type TimestampFidelity = "embedded" | "entry" | "missing";

export interface HistorySource {
  kind: HistorySourceKind;
  id: string;
  path?: string;
  sessionId?: string;
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
  entryId?: string;
  provider: string;
  model: string;
  timestamp?: number;
  timestampFidelity: TimestampFidelity;
  usage: NormalizedUsage;
  stopReason?: string;
  kind: "assistant";
  durationMs?: number;
  thinkingLevel?: string;
  thinkingLevelInferred: boolean;
  source: HistorySource;
}

export type HistoryWarningCode =
  | "unreadable-source"
  | "malformed-jsonl"
  | "malformed-snapshot"
  | "broken-lineage"
  | "cyclic-lineage"
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
  timestamps?: number[];
}

export interface LoadedHistory {
  now: number;
  calls: NormalizedCall[];
  warnings: HistoryWarning[];
}

type ListedSession = Pick<SessionInfo, "path" | "modified">;
type ListAll = (sessionDir?: string) => Promise<ListedSession[]>;

export interface LoadHistoryOptions {
  signal?: AbortSignal;
  now?: number;
  /** Test seam for Pi's public, read-only session listing API. */
  listAll?: ListAll;
  /** Test seam invoked after initial source metadata is captured. */
  sourceReadStarted?: (path: string) => void | Promise<void>;
}

interface RawSession {
  path?: string;
  canonicalPath: string;
  source: HistorySource;
  header: Record<string, unknown>;
  entries: Record<string, unknown>[];
  endTimestamp: number;
  parentCanonicalPath?: string;
  lineageId?: string;
  lineageValid: boolean;
}

type CandidateKind = "assistant" | "usage" | "compaction" | "branch_summary";

interface NormalizedCandidate {
  key: string;
  entryId?: string;
  provider: string;
  model: string;
  timestamp?: number;
  timestampFidelity: TimestampFidelity;
  usage: NormalizedUsage;
  stopReason?: string;
  kind: CandidateKind;
  durationMs?: number;
  thinkingLevel?: string;
  thinkingLevelInferred: boolean;
  source: HistorySource;
  lineageId?: string;
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

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function thinkingLevel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeUsage(value: unknown): NormalizedUsage | undefined {
  const raw = object(value);
  const cost = object(raw?.cost);
  if (!raw || !cost) return undefined;
  const tokenFields = [raw.input, raw.output, raw.cacheRead, raw.cacheWrite, raw.totalTokens];
  const costFields = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total];
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
      input: cost.input as number,
      output: cost.output as number,
      cacheRead: cost.cacheRead as number,
      cacheWrite: cost.cacheWrite as number,
      total: cost.total as number,
    },
  };
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
    return { type: value.type, id: value.id, parentSession: value.parentSession };
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
  if (value.type === "thinking_level_change") {
    return { ...base, thinkingLevel: thinkingLevel(value.thinkingLevel) };
  }
  if (value.type === "usage") {
    return {
      ...base,
      provider: value.provider,
      model: value.model,
      usage: projectUsage(value.usage),
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
        thinkingLevel: thinkingLevel(message.thinkingLevel),
      },
    };
  }
  if (value.type === "compaction" || value.type === "branch_summary") {
    return {
      ...base,
      usage: value.usage === undefined ? undefined : projectUsage(value.usage),
    };
  }
  return base;
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

async function readJsonLines(
  path: string,
  signal: AbortSignal | undefined,
  warnings: HistoryWarning[],
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
          const record = object(JSON.parse(raw));
          const projected = record ? projectSessionRow(record) : undefined;
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
        const record = object(JSON.parse(pending.replace(/\r$/, "")));
        const projected = record ? projectSessionRow(record) : undefined;
        if (projected) rows.push({ value: projected, line });
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
  warnings: HistoryWarning[],
  signal?: AbortSignal,
): NormalizedCandidate[] {
  const calls: NormalizedCandidate[] = [];
  const routes = inheritedRoutes(session.entries, signal);
  const entriesById = new Map<string, Record<string, unknown>>();
  for (const entry of session.entries) {
    if (typeof entry.id === "string") entriesById.set(entry.id, entry);
  }
  const thinkingByEntryId = new Map<string, string | undefined>();
  const inheritedThinking = (parentId: unknown): string | undefined => {
    const visited = new Set<string>();
    let level: string | undefined;
    while (typeof parentId === "string" && !visited.has(parentId)) {
      checkAbort(signal);
      if (thinkingByEntryId.has(parentId)) {
        level = thinkingByEntryId.get(parentId);
        break;
      }
      visited.add(parentId);
      const parent = entriesById.get(parentId);
      if (!parent) break;
      if (parent.type === "thinking_level_change") {
        level = thinkingLevel(parent.thinkingLevel);
        break;
      }
      parentId = parent.parentId;
    }
    for (const id of visited) thinkingByEntryId.set(id, level);
    return level;
  };

  for (let index = 0; index < session.entries.length; index += 1) {
    checkAbort(signal);
    const entry = session.entries[index];
    if (!entry) continue;
    const entryId = typeof entry.id === "string" ? entry.id : undefined;
    let usage: NormalizedUsage | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let stopReason: string | undefined;
    let callTimestamp: number | undefined;
    let fidelity: TimestampFidelity = "entry";
    let kind: CandidateKind;
    let durationMs: number | undefined;
    let effort: string | undefined;
    let effortInferred = false;

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
      stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
      kind = "assistant";
      const embedded = timestamp(message.timestamp);
      const end = timestamp(entry.timestamp);
      if (embedded !== undefined && embedded >= 0 && end !== undefined && end > embedded) {
        const elapsed = end - embedded;
        if (Number.isFinite(elapsed)) durationMs = elapsed;
      }
      effort = thinkingLevel(message.thinkingLevel);
      if (effort === undefined) {
        effort = inheritedThinking(entry.parentId);
        effortInferred = effort !== undefined;
      }
      callTimestamp = embedded ?? timestamp(entry.timestamp);
      fidelity =
        embedded === undefined ? (callTimestamp === undefined ? "missing" : "entry") : "embedded";
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      kind = entry.type;
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
      callTimestamp = timestamp(entry.timestamp);
      fidelity = callTimestamp === undefined ? "missing" : "entry";
    } else if (entry.type === "usage") {
      kind = "usage";
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
    calls.push({
      key: `${session.source.id}:${entryId ?? index}`,
      entryId,
      provider,
      model,
      timestamp: callTimestamp,
      timestampFidelity: fidelity,
      usage,
      stopReason,
      kind,
      durationMs,
      thinkingLevel: effort,
      thinkingLevelInferred: effortInferred,
      source: session.source,
      lineageId: session.lineageId,
    });
  }
  return calls;
}

function deduplicatePersistedCalls(
  sessions: RawSession[],
  calls: NormalizedCandidate[],
  signal?: AbortSignal,
): NormalizedCandidate[] {
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
  const claimed = new Set<string>();
  const retained: NormalizedCandidate[] = [];
  for (const call of ordered) {
    checkAbort(signal);
    if (!call.entryId || !call.lineageId) {
      retained.push(call);
      continue;
    }
    const entryKey = `${call.lineageId}\0${call.entryId}`;
    if (claimed.has(entryKey)) continue;
    claimed.add(entryKey);
    retained.push(call);
  }
  return retained;
}

/** Load speed-relevant persisted assistant measurements without writing or scanning outputs. */
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
    const rows = await readJsonLines(path, signal, warnings, options.sourceReadStarted);
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
  const persistedCalls: NormalizedCandidate[] = [];
  for (const session of sessions) {
    checkAbort(signal);
    persistedCalls.push(...normalizePersistedSession(session, warnings, signal));
  }
  const deduplicated = deduplicatePersistedCalls(sessions, persistedCalls, signal);
  for (const call of deduplicated) {
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
  const calls: NormalizedCall[] = deduplicated
    .filter((call) => call.kind === "assistant")
    .map((call) => ({
      entryId: call.entryId,
      provider: call.provider,
      model: call.model,
      timestamp: call.timestamp,
      timestampFidelity: call.timestampFidelity,
      usage: call.usage,
      stopReason: call.stopReason,
      kind: "assistant",
      durationMs: call.durationMs,
      thinkingLevel: call.thinkingLevel,
      thinkingLevelInferred: call.thinkingLevelInferred,
      source: call.source,
    }));
  return { now, calls, warnings };
}
