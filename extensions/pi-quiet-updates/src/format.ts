export interface PendingUpdates {
  pi?: string;
  packages?: string[];
}

export interface VersionChange {
  installed?: string;
  latest?: string;
}

/** `name@range` -> `name`, keeping a scope's leading `@`. */
export function npmSpecName(spec: string): string {
  return spec.replace(/(?!^)@.*$/, "");
}

/** Shows as much of the change as is known: `a -> b`, then `b`, then just the name. */
export function versionLabel(name: string, change: VersionChange | undefined): string {
  const { installed, latest } = change ?? {};
  if (installed && latest) return `${name} ${installed} -> ${latest}`;
  return latest ? `${name} ${latest}` : name;
}

/**
 * Both startup checks resolve independently, so the line is rebuilt from
 * everything seen so far rather than from the latest result alone.
 */
export function formatUpdateLine(updates: PendingUpdates): string {
  const parts = [...(updates.pi ? [updates.pi] : []), ...(updates.packages ?? [])];
  return `Updates available: ${parts.join(" · ")}`;
}
