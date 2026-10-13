import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

const thinkingLevels = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface ModelRecord {
  favorite?: boolean;
  hidden?: boolean;
  lastUsedAt?: number;
  thinkingLevel?: ThinkingLevel;
}
export interface ModelHistory {
  version: 1;
  models: Record<string, ModelRecord>;
}
export const historyPath = (dir = getAgentDir()) => join(dir, "model-history.json");

export function emptyHistory(): ModelHistory {
  return { version: 1, models: {} };
}

export function parseHistory(value: unknown): ModelHistory {
  if (!value || typeof value !== "object") return emptyHistory();
  const input = value as { version?: unknown; models?: unknown };
  if (input.version !== 1 || !input.models || typeof input.models !== "object")
    return emptyHistory();
  const models: Record<string, ModelRecord> = {};
  for (const [key, raw] of Object.entries(input.models)) {
    if (!raw || typeof raw !== "object" || !key) continue;
    const record = raw as {
      favorite?: unknown;
      hidden?: unknown;
      lastUsedAt?: unknown;
      thinkingLevel?: unknown;
    };
    const clean: ModelRecord = {};
    if (typeof record.favorite === "boolean") clean.favorite = record.favorite;
    if (typeof record.hidden === "boolean") clean.hidden = record.hidden;
    if (
      typeof record.thinkingLevel === "string" &&
      thinkingLevels.has(record.thinkingLevel as ThinkingLevel)
    ) {
      clean.thinkingLevel = record.thinkingLevel as ThinkingLevel;
    }
    if (
      typeof record.lastUsedAt === "number" &&
      Number.isFinite(record.lastUsedAt) &&
      record.lastUsedAt >= 0
    ) {
      clean.lastUsedAt = record.lastUsedAt;
    }
    if (
      clean.favorite !== undefined ||
      clean.hidden !== undefined ||
      clean.lastUsedAt !== undefined ||
      clean.thinkingLevel !== undefined
    ) {
      models[key] = clean;
    }
  }
  return { version: 1, models };
}

export async function loadHistory(file = historyPath()): Promise<ModelHistory> {
  try {
    return parseHistory(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return emptyHistory();
  }
}

/** Missing freshness metadata is not evidence that a local catalogue is stale. */
export async function hasStaleLlamaCache(dir = getAgentDir(), now = Date.now()): Promise<boolean> {
  try {
    const cache = JSON.parse(await readFile(join(dir, "models-store.json"), "utf8"));
    const checkedAt: unknown = cache?.["llama.cpp"]?.checkedAt;
    return (
      typeof checkedAt === "number" &&
      Number.isFinite(checkedAt) &&
      now - checkedAt > 24 * 60 * 60 * 1000
    );
  } catch {
    return false;
  }
}

let mutationQueue: Promise<void> = Promise.resolve();

export function mutateHistory(
  mutation: (history: ModelHistory) => void,
  file = historyPath(),
): Promise<ModelHistory> {
  const operation = mutationQueue.then(async () => {
    const history = await loadHistory(file);
    mutation(history);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
    return history;
  });
  mutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
