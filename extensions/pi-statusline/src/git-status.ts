/**
 * Working-tree summary for the optional `git_status` item.
 *
 * Refreshes are debounced and single-flighted: a busy agent fires tool events
 * far faster than `git status` can answer, and a queue of stale porcelain runs
 * helps nobody.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}

const REFRESH_TIMEOUT_MS = 5000;

export function gitStatusEqual(a: GitStatus | undefined, b: GitStatus | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.staged === b.staged &&
    a.unstaged === b.unstaged &&
    a.untracked === b.untracked &&
    a.ahead === b.ahead &&
    a.behind === b.behind
  );
}

export function formatGitStatus(status: GitStatus | undefined): string {
  if (!status) return "";
  const parts: string[] = [];
  if (status.ahead) parts.push(`↑${status.ahead}`);
  if (status.behind) parts.push(`↓${status.behind}`);
  if (status.staged) parts.push(`+${status.staged}`);
  if (status.unstaged) parts.push(`~${status.unstaged}`);
  if (status.untracked) parts.push(`?${status.untracked}`);
  return parts.join(" ");
}

export async function readGitStatus(pi: ExtensionAPI, cwd: string): Promise<GitStatus | undefined> {
  const result = await pi.exec("git", ["status", "--porcelain=v1", "--branch"], {
    cwd,
    timeout: REFRESH_TIMEOUT_MS,
  });
  if (result.code !== 0) return undefined;
  return parseGitStatus(result.stdout);
}

export function parseGitStatus(stdout: string): GitStatus {
  const status: GitStatus = { staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 };

  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;

    if (line.startsWith("## ")) {
      status.ahead = readTracking(line, "ahead");
      status.behind = readTracking(line, "behind");
      continue;
    }

    if (line.startsWith("??")) {
      status.untracked += 1;
      continue;
    }

    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    if (index !== " ") status.staged += 1;
    if (worktree !== " ") status.unstaged += 1;
  }

  return status;
}

function readTracking(line: string, key: "ahead" | "behind"): number {
  const match = line.match(new RegExp(`\\[(?:[^\\]]*\\s)?${key} (\\d+)`));
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}
