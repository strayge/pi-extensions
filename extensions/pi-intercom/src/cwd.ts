import { resolve } from "node:path";
import { realpathSync } from "node:fs";

const normalizeCache = new Map<string, string>();

/** Keep directory-derived pools stable across lexical variants and symlinks. */
export function normalizeCwd(cwd: string): string {
  const cached = normalizeCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolve(cwd);
  let normalized: string;
  try {
    normalized = realpathSync(resolved);
  } catch {
    normalized = resolved;
  }
  normalizeCache.set(cwd, normalized);
  return normalized;
}
