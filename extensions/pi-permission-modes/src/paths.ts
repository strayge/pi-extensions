/**
 * Path containment & protected-path predicates.
 *
 * Pure functions (no `pi`/`ctx`) so they can be unit-tested in isolation —
 * these are the security-critical guards that decide whether a tool touches
 * something outside the project or a protected file.
 *
 * `isOutside` resolves symlinks (via realpath) before the containment test so a
 * symlink *inside* the project that points outside is correctly treated as an
 * escape — file tools (read/edit/write) are not OS-sandboxed, so this is their
 * only containment guard.
 */

import { lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Device pseudo-files that are "outside" the project but harmless to allow. */
export const SAFE_OUTSIDE_RE = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|urandom|random)$/;

/** Directory names that are protected anywhere in a path. */
const PROTECTED_DIRS = [".git", "node_modules", ".vscode", ".idea"];
/** Basenames that are protected (shell rc, VCS/npm config). Mirrors the sandbox-runtime mandatory-deny set. */
const PROTECTED_FILES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".npmrc",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
]);

/**
 * Canonicalize a path by resolving symlinks on its longest existing prefix and
 * appending the remaining (not-yet-created) tail verbatim. Never throws for
 * missing paths — falls back to the lexical resolution.
 */
export function canonicalizePath(p: string, cwd: string = process.cwd()): string {
  let current = path.resolve(cwd, p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return tail.length ? path.join(current, ...tail) : current;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `p`, resolved against `root` (with symlinks followed), escapes the
 * project directory. Empty/undefined paths are treated as in-project (tools
 * default to cwd).
 */
export function isOutside(root: string, p?: string): boolean {
  if (!p) return false;
  const target = canonicalizePath(path.resolve(root, p));
  const realRoot = canonicalizePath(root);
  const rel = path.relative(realRoot, target);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/** True when the path is a Markdown file (planning files allowed in Read mode). */
export function isMarkdown(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

/** Normalize a model-supplied path: trim and strip a leading `@` (some models add it). */
export function resolvePlanPath(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^@/, "");
}

const GLOB_CHARS = /[*?[\]]/;

/** Expand a leading `~` the way the sandbox runtime does. */
function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

/**
 * True when resolving `original` to `resolved` broadens what a mount would cover:
 * the link escapes upward (`~/.aws` → `/home/user`) or lands on the root / a
 * single top-level directory. Mounting there would hide or expose far more than
 * the configured path, so such an entry is dropped instead.
 */
function widensScope(original: string, resolved: string): boolean {
  if (resolved === original) return false;
  if (resolved === "/") return true;
  if (resolved.split("/").filter(Boolean).length <= 1) return true;
  return original.startsWith(`${resolved}/`);
}

/**
 * Rewrite one configured sandbox path into a form bubblewrap can mount, or null
 * when it must be dropped.
 *
 * bwrap resolves every mount destination inside its own pivoted root, where an
 * absolute symlink target does not exist — so a mount point that *is* a symlink
 * aborts the whole sandbox (`Can't mount tmpfs on /newroot/…: No such file or
 * directory`) and with it every command of the session. sandbox-runtime
 * canonicalizes mount points itself, but only while the link stays inside its own
 * tree; a home dotfile pointing at another filesystem (`~/.aws` →
 * `/mnt/c/Users/me/.aws`, common under WSL) still reaches bwrap as a symlink.
 *
 * Denying/allowing the canonical target covers access through the symlink too, so
 * this is a rewrite, not a weakening. Glob patterns keep their pattern tail and
 * only have their static directory prefix canonicalized.
 */
export function sandboxMountPath(pattern: string, cwd: string = process.cwd(), home: string = homedir()): string | null {
  const abs = path.resolve(cwd, expandHome(pattern, home));
  const globAt = abs.search(GLOB_CHARS);
  if (globAt === -1) {
    const real = canonicalizePath(abs);
    return widensScope(abs, real) ? null : real;
  }
  const cut = abs.lastIndexOf("/", globAt);
  if (cut <= 0) return abs; // pattern starts at the root: nothing to canonicalize
  const dir = abs.slice(0, cut);
  const real = canonicalizePath(dir);
  return widensScope(dir, real) ? null : real + abs.slice(cut);
}

/**
 * The OS sandbox write-protects a fixed set of dotfiles/dirs at the project root
 * (its mandatory-deny list — `@anthropic-ai/sandbox-runtime`'s `DANGEROUS_FILES`
 * + `DANGEROUS_DIRECTORIES`). When such a path is ABSENT, the runtime denies it
 * by mounting `/dev/null` over the first
 * missing component, and because the project is writable in Default/Build,
 * bubblewrap materializes that mountpoint as a **0-byte, read-only file** that
 * survives teardown — littering the project (and, for `.git`, breaking the next
 * run). These are the paths to clean up around every sandboxed run.
 */
export const SANDBOX_PLACEHOLDER_PATHS = [
  ".git",
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".vscode",
  ".idea",
];

/**
 * Delete any 0-byte placeholder files the sandbox left at the project root.
 * Only removes a path that is a **0-byte regular file** — a legitimate version
 * of any of these is a directory (`.git`, `.vscode`, `.idea`) or a non-empty
 * file (`.gitmodules`, `.mcp.json`, shell rc files), so real files and
 * dirs are never touched. Called before & after each sandboxed run; best-effort.
 * Returns the number of placeholders removed.
 */
export function removeSandboxPlaceholders(root: string): number {
  let removed = 0;
  for (const rel of SANDBOX_PLACEHOLDER_PATHS) {
    const p = path.join(root, rel);
    try {
      const st = lstatSync(p);
      if (st.isFile() && st.size === 0 && st.nlink === 1) {
        rmSync(p, { force: true });
        removed++;
      }
    } catch {
      // absent / unreadable → nothing to clean
    }
  }
  return removed;
}

export type GitLayout =
  | { kind: "none" | "directory" | "placeholder" }
  | { kind: "gitfile"; gitFile: string; gitDir: string; commonDir: string; writePaths: string[] }
  | { kind: "invalid"; reason: string };

const MAX_GIT_PATH_FILE_BYTES = 16 * 1024;

function readGitPathFile(file: string, prefix?: string): string {
  const st = lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile() || st.size === 0 || st.size > MAX_GIT_PATH_FILE_BYTES) {
    throw new Error("must be a non-empty regular file of reasonable size");
  }
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (withoutFinalNewline.includes("\n") || withoutFinalNewline.includes("\0")) {
    throw new Error("must contain exactly one path line");
  }
  const value = prefix ? (withoutFinalNewline.startsWith(prefix) ? withoutFinalNewline.slice(prefix.length) : "") : withoutFinalNewline;
  const trimmed = value.trim();
  if (!trimmed) throw new Error(prefix ? `must start with ${JSON.stringify(prefix)}` : "must contain a path");
  return trimmed;
}

function resolveGitDirectory(raw: string, relativeTo: string, label: string): string {
  const lexical = path.resolve(relativeTo, raw);
  if (lstatSync(lexical).isSymbolicLink()) throw new Error(`${label} target is a symbolic link`);
  const resolved = realpathSync(lexical);
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} target is not a directory`);
  const components = resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean);
  if (components.length <= 1) throw new Error(`${label} resolves to dangerously broad path ${resolved}`);
  return resolved;
}

function containsPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isMissingPathError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function gitConfigCoreValue(file: string, key: string): string | undefined {
  const st = lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile() || st.size === 0 || st.size > MAX_GIT_PATH_FILE_BYTES) return undefined;
  let inCore = false;
  for (const line of readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n")) {
    const section = /^\s*\[([^\]]+)]\s*$/.exec(line);
    if (section) {
      inCore = section[1].trim().toLowerCase() === "core";
      continue;
    }
    if (!inCore) continue;
    const entry = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "i").exec(line);
    if (!entry) continue;
    const raw = entry[1];
    if (raw.startsWith('"')) {
      if (!raw.endsWith('"')) return undefined;
      return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    return raw || undefined;
  }
  return undefined;
}

function requireLinkedCommonDir(commonDir: string, gitDir: string): void {
  const config = path.join(commonDir, "config");
  if (!statSync(path.join(commonDir, "HEAD")).isFile() || !statSync(config).isFile()) {
    throw new Error("commondir is missing repository metadata");
  }
  const conventional = path.basename(commonDir) === ".git";
  const bare = gitConfigCoreValue(config, "bare")?.toLowerCase() === "true";
  if ((!conventional && !bare) || path.dirname(gitDir) !== path.join(commonDir, "worktrees")) {
    throw new Error("commondir is not the parent Git metadata for this worktree");
  }
  if (!statSync(path.join(commonDir, "objects")).isDirectory()) {
    throw new Error("commondir is missing its object database");
  }
}

function requireGitfileOwner(root: string, gitFile: string, gitDir: string, hasCommonDir: boolean): void {
  const expectedRoot = realpathSync(root);
  if (hasCommonDir) {
    const backlinkRaw = readGitPathFile(path.join(gitDir, "gitdir"));
    const backlink = realpathSync(path.resolve(gitDir, backlinkRaw));
    if (backlink !== realpathSync(gitFile) || realpathSync(path.dirname(backlink)) !== expectedRoot) {
      throw new Error("gitdir backlink does not point to this worktree");
    }
    return;
  }

  const segments = gitDir.split(path.sep).filter(Boolean);
  const dotGit = segments.lastIndexOf(".git");
  const directModule = dotGit >= 0 && segments[dotGit + 1] === "modules";
  const linkedWorktreeModule =
    dotGit >= 0 && segments[dotGit + 1] === "worktrees" && Boolean(segments[dotGit + 2]) && segments[dotGit + 3] === "modules";
  if (!directModule && !linkedWorktreeModule) throw new Error("gitdir is not submodule metadata");
  const worktree = gitConfigCoreValue(path.join(gitDir, "config"), "worktree");
  if (!worktree || realpathSync(path.resolve(gitDir, worktree)) !== expectedRoot) {
    throw new Error("gitdir has no worktree ownership backlink");
  }
}

/**
 * Describe the project's Git metadata without invoking Git before containment is
 * active. Git files are used by linked worktrees and submodules; their optional
 * `commondir` redirects shared objects/refs/config to another directory.
 */
export function resolveGitLayout(root: string): GitLayout {
  const gitFile = path.join(root, ".git");
  let gitFileStat: ReturnType<typeof lstatSync>;
  try {
    gitFileStat = lstatSync(gitFile);
  } catch (err) {
    return isMissingPathError(err)
      ? { kind: "none" }
      : { kind: "invalid", reason: `cannot inspect .git (${err instanceof Error ? err.message : String(err)})` };
  }
  if (gitFileStat.isSymbolicLink()) return { kind: "invalid", reason: ".git is a symbolic link" };
  if (gitFileStat.isDirectory()) return { kind: "directory" };
  if (gitFileStat.isFile() && gitFileStat.size === 0) return { kind: "placeholder" };
  if (!gitFileStat.isFile()) return { kind: "invalid", reason: ".git is not a regular file or directory" };
  if (gitFileStat.nlink !== 1) return { kind: "invalid", reason: ".git has multiple hard links" };

  try {
    const gitDirRaw = readGitPathFile(gitFile, "gitdir: ");
    const gitDir = resolveGitDirectory(gitDirRaw, path.dirname(gitFile), "gitdir");
    const head = path.join(gitDir, "HEAD");
    if (!statSync(head).isFile()) throw new Error("gitdir does not contain a regular HEAD file");

    const commonFile = path.join(gitDir, "commondir");
    let commonFileStat: ReturnType<typeof lstatSync> | undefined;
    try {
      commonFileStat = lstatSync(commonFile);
    } catch (err) {
      if (!isMissingPathError(err)) throw err;
    }
    if (commonFileStat?.isSymbolicLink()) throw new Error("commondir is a symbolic link");
    const commonDir = commonFileStat
      ? resolveGitDirectory(readGitPathFile(commonFile), gitDir, "commondir")
      : gitDir;
    requireGitfileOwner(root, gitFile, gitDir, commonFileStat !== undefined);
    if (commonFileStat) requireLinkedCommonDir(commonDir, gitDir);

    const writePaths = containsPath(commonDir, gitDir) ? [commonDir] : [commonDir, gitDir];
    return { kind: "gitfile", gitFile, gitDir, commonDir, writePaths };
  } catch (err) {
    return { kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * True when `p` is a Markdown file inside the project's `plans/` directory — the
 * files Plan Mode writes and `show_plan` renders. Lexical (no realpath); this is
 * a UI-routing predicate, not a security boundary.
 */
export function isPlanFile(root: string, p?: string): boolean {
  if (!p || !isMarkdown(p)) return false;
  const rel = path.relative(path.resolve(root, "plans"), path.resolve(root, p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * True when a write target is a protected path. Segment-aware (not a loose
 * substring): matches protected directory names anywhere in the path, `.env`
 * and `.env.*` files, and known dotfiles. Purely lexical — see
 * `isProtectedWrite` for the symlink-resolving backstop.
 */
export function isProtectedPath(p: string): boolean {
  const segments = p.split(/[/\\]+/).filter(Boolean);
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1];

  if (segments.some((s) => PROTECTED_DIRS.includes(s))) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (PROTECTED_FILES.has(base)) return true;
  return false;
}

/**
 * The protected-path backstop for `edit`/`write` targets: the raw path is
 * matched lexically (so a textual `.git/…` is blocked even before it exists),
 * AND its canonical form — resolved against `root` with symlinks followed — is
 * matched too, so an in-project symlink pointing at `.git`/a dotfile can't
 * smuggle a write past the backstop (file tools aren't OS-sandboxed; this
 * check is their only guard).
 *
 * The canonical form is judged *project-relative* when it lands inside the
 * project: a project that itself lives under a directory named e.g.
 * `node_modules` (debugging a dependency in place) must not have every write
 * blocked just because the project's own absolute path contains a protected
 * segment. Targets resolving outside the project are judged by their full
 * canonical path.
 */
export function isProtectedWrite(root: string, p: string): boolean {
  if (isProtectedPath(p)) return true;
  const target = canonicalizePath(path.resolve(root, p));
  const realRoot = canonicalizePath(root);
  const rel = path.relative(realRoot, target);
  const inProject = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return isProtectedPath(inProject ? rel : target);
}
