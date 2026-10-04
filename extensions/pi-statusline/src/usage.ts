/**
 * Session token/cost totals.
 *
 * Totals cover every entry in the session, not just the current context window,
 * so they keep climbing across compactions — same accounting as pi's footer.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Cache hit rate of the most recent assistant message, in percent. */
  latestCacheHitRate?: number;
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface CachedUsage {
  sessionId: string;
  leafId: string | null;
  entryCount: number;
  totals: UsageTotals;
}

const usageCache = new WeakMap<ExtensionContext["sessionManager"], CachedUsage>();

export function collectUsage(ctx: ExtensionContext): UsageTotals {
  const manager = ctx.sessionManager;
  const sessionId = manager.getSessionId();
  const leafId = manager.getLeafId();
  // The readonly extension API omits the fast count available on newer host managers.
  const countedManager = manager as typeof manager & { getEntryCount?: () => number };
  let entries: ReturnType<typeof manager.getEntries> | undefined;
  let entryCount: number;
  if (typeof countedManager.getEntryCount === "function") {
    entryCount = countedManager.getEntryCount();
  } else {
    entries = manager.getEntries();
    entryCount = entries.length;
  }
  const cached = usageCache.get(manager);
  if (
    cached?.sessionId === sessionId &&
    cached.leafId === leafId &&
    cached.entryCount === entryCount
  ) {
    return cached.totals;
  }

  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries ?? manager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = entry.message.usage as UsageLike | undefined;
      add(totals, usage);
      const prompt = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
      totals.latestCacheHitRate = prompt > 0 ? ((usage?.cacheRead ?? 0) / prompt) * 100 : undefined;
      continue;
    }
    if (entry.type === "message" && entry.message.role === "toolResult") {
      add(totals, (entry.message as { usage?: UsageLike }).usage);
      continue;
    }
    if (entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") {
      add(totals, (entry as { usage?: UsageLike }).usage);
    }
  }

  usageCache.set(manager, { sessionId, leafId, entryCount, totals });
  return totals;
}

function add(totals: UsageTotals, usage: UsageLike | undefined): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}
