import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { assertBinding, bindPath, identity, sameIdentity } from "./paths.ts";
import type { PathBinding, ResourceGrant } from "./schema.ts";

/** Gitfiles are data, never commands or a reason to read arbitrary unbounded files. */
function readLine(binding: PathBinding): string {
  assertBinding(binding);
  const fd = openSync(binding.canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameIdentity(identity(fd), binding.identity)) throw new Error("Git metadata file changed");
    const buffer = Buffer.alloc(8193);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length === buffer.length) throw new Error("Git metadata line is too long");
    const line = buffer.subarray(0, length).toString("utf8").replace(/\r?\n$/, "");
    if (!line || /[\0\r\n]/.test(line)) throw new Error("Invalid Git metadata line");
    assertBinding(binding);
    return line;
  } finally {
    closeSync(fd);
  }
}

/** Only the starting worktree's reciprocal, standard metadata layout supplies automatic authority. */
export function automaticWorktreeGrants(root: PathBinding): ResourceGrant[] {
  assertBinding(root);
  try {
    const bindings: PathBinding[] = [];
    const lines = new Map<PathBinding, string>();
    const bind = (file: string, type: "file" | "directory") => {
      if (lstatSync(file).isSymbolicLink()) throw new Error("Symlinked Git metadata is not automatic authority");
      const binding = bindPath(file);
      if (binding.missing.length || binding.identity.type !== type) throw new Error("Unexpected Git metadata type");
      bindings.push(binding);
      return binding;
    };
    const line = (file: string) => {
      const binding = bind(file, "file");
      const value = readLine(binding);
      lines.set(binding, value);
      return value;
    };
    let marker: string;
    for (let directory = root.canonical; ; directory = path.dirname(directory)) {
      marker = path.join(directory, ".git");
      try {
        lstatSync(marker);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (path.dirname(directory) === directory) return [];
    }
    const pointer = line(marker);
    if (!pointer.startsWith("gitdir: ") || pointer.length === 8) return [];
    const git = bind(path.resolve(path.dirname(marker), pointer.slice(8)), "directory");
    const worktrees = bind(path.dirname(git.lexical), "directory");
    if (path.basename(worktrees.canonical) !== "worktrees") return [];
    const common = bind(path.dirname(worktrees.lexical), "directory");
    // Automatic discovery must not poison unrelated shells with an unrepresentable boundary.
    if (/[*?[\]{}\n\r]/.test(common.canonical)) return [];
    if (bindPath(path.resolve(git.canonical, line(path.join(git.canonical, "commondir")))).canonical !== common.canonical) return [];
    const backlink = bind(path.resolve(git.canonical, line(path.join(git.canonical, "gitdir"))), "file");
    if (backlink.canonical !== bindPath(marker).canonical) return [];
    for (const head of [path.join(git.canonical, "HEAD"), path.join(common.canonical, "HEAD")])
      if (!/^(?:ref: refs\/[^\s]+|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(line(head))) return [];
    bind(path.join(common.canonical, "config"), "file");
    bind(path.join(common.canonical, "objects"), "directory");
    bind(path.join(common.canonical, "refs"), "directory");
    for (const binding of bindings) assertBinding(binding);
    for (const [binding, value] of lines) if (readLine(binding) !== value) return [];
    assertBinding(root);
    // The common tree already includes this worktree's metadata; no duplicate grant is needed.
    return [{ definition: `worktree:${common.canonical}`, binding: common, scope: "tree", access: "write", runtime: true }];
  } catch {
    // Invalid discovery must not trigger the unrestricted policy-initialization fallback.
    assertBinding(root);
    return [];
  }
}
