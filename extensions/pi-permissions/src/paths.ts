import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileBinding, FileIdentity, PathBinding, PermissionBinding, RootIdentity } from "./schema.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function identity(file: string | number): FileIdentity {
  const s = typeof file === "number" ? fstatSync(file, { bigint: true }) : lstatSync(file, { bigint: true });
  return {
    dev: String(s.dev),
    ino: String(s.ino),
    birthtimeNs: String(s.birthtimeNs),
    type: s.isDirectory() ? "directory" : s.isFile() ? "file" : s.isSymbolicLink() ? "symlink" : "other",
  };
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.type === b.type;
}

/** Resolve components explicitly so ENOENT through a symlink never becomes a creatable tail. */
export function bindPath(input: string): PathBinding {
  if (!path.isAbsolute(input) || input.includes("\0")) throw new Error("A native absolute path is required");
  const lexical = path.normalize(input);
  let hops = 0;
  function resolve(absolute: string, throughLink: boolean): { canonical: string; prefix: string; missing: string[] } {
    const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
    let current = path.parse(absolute).root;
    for (let i = 0; i < parts.length; i++) {
      const next = path.join(current, parts[i]!);
      let st: Stats;
      try {
        st = lstatSync(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (throughLink) throw new Error(`Dangling symlink destination: ${next}`);
        const prefix = realpathSync.native(current);
        return { canonical: path.join(prefix, ...parts.slice(i)), prefix, missing: parts.slice(i) };
      }
      if (st.isSymbolicLink()) {
        if (++hops > 40) throw new Error(`Symlink cycle or excessive links: ${next}`);
        const link = readlinkSync(next);
        const target = resolve(path.isAbsolute(link) ? link : `${current}${path.sep}${link}`, true);
        current = target.canonical;
      } else {
        current = next;
      }
      if (i < parts.length - 1 && !lstatSync(current).isDirectory()) throw new Error(`Not a directory: ${current}`);
    }
    const canonical = realpathSync.native(current);
    return { canonical, prefix: canonical, missing: [] };
  }
  const resolved = resolve(input, false);
  return { lexical, ...resolved, identity: identity(resolved.prefix) };
}

/** A future rule can become present, but its frozen existing prefix must never be replaced. */
export function revalidate(binding: PathBinding, allowCreated = false): boolean {
  try {
    if (!sameIdentity(identity(binding.prefix), binding.identity)) return false;
    const current = bindPath(binding.lexical);
    return (
      current.canonical === binding.canonical &&
      (allowCreated || (current.prefix === binding.prefix && sameIdentity(current.identity, binding.identity)))
    );
  } catch {
    return false;
  }
}

export function assertBinding(binding: PathBinding, allowCreated = false): void {
  if (!revalidate(binding, allowCreated))
    throw new Error(`Filesystem identity changed or is unavailable: ${binding.lexical}`);
}

/** Concurrent parent creation may advance a new write's binding, but never adopt a new leaf or symlink. */
export function refreshWriteBinding(binding: PathBinding): PathBinding {
  if (!binding.missing.length) {
    assertBinding(binding);
    return binding;
  }
  assertBinding(binding, true);
  const current = bindPath(binding.lexical);
  if (current.canonical !== binding.canonical || !current.missing.length)
    throw new Error(`Write target changed: ${binding.lexical}`);
  let parent = binding.prefix;
  for (const component of binding.missing.slice(0, binding.missing.length - current.missing.length)) {
    parent = path.join(parent, component);
    if (!lstatSync(parent).isDirectory()) throw new Error(`Write parent is not a real directory: ${parent}`);
  }
  assertBinding(binding, true);
  // Other mkdir workers may still add parents; once only the leaf is missing, validation stays strict.
  assertBinding(current, current.missing.length > 1);
  return current;
}

/** Atomic replacement changes the leaf object, not the authority granted to its name. */
export function bindFile(binding: PathBinding): FileBinding {
  assertBinding(binding);
  if (!binding.missing.length && binding.identity.type !== "file")
    throw new Error(`Exact-file permission requires a regular file: ${binding.lexical}`);
  const result: FileBinding = {
    lexical: binding.lexical,
    canonical: binding.canonical,
    parent: bindPath(path.dirname(binding.canonical)),
  };
  resolvePermissionBinding(result);
  assertBinding(binding);
  return result;
}

/** Materialize a short-lived execution identity without changing the saved permission boundary. */
export function resolvePermissionBinding(binding: PermissionBinding, allowCreated = false): PathBinding {
  if (!("parent" in binding)) {
    assertBinding(binding, allowCreated);
    if (!allowCreated) return binding;
    const current = bindPath(binding.lexical);
    assertBinding(binding, true);
    return current;
  }
  assertBinding(binding.parent, true);
  const current = bindPath(binding.lexical);
  if (current.canonical !== binding.canonical || (!current.missing.length && current.identity.type !== "file"))
    throw new Error(`File permission target changed: ${binding.lexical}`);
  assertBinding(binding.parent, true);
  return current;
}

export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Canonical identities preserve native aliases without equating distinct Unicode filenames. */
export function contains(root: Pick<PathBinding, "canonical">, target: Pick<PathBinding, "canonical">, scope: "file" | "tree" = "tree"): boolean {
  if (scope === "file") return root.canonical === target.canonical;
  return within(root.canonical, target.canonical);
}

/** Apple's protected top-level aliases are not user-controlled config redirections. */
export function configLocation(input: string): string {
  const absolute = path.resolve(input);
  if (process.platform !== "darwin") return absolute;
  const alias = absolute.match(/^\/(tmp|var|etc)(?=\/|$)/)?.[0];
  if (!alias) return absolute;
  const stat = lstatSync(alias);
  const destination = `/private${alias}`;
  if (!stat.isSymbolicLink() || stat.uid !== 0 || path.resolve("/", readlinkSync(alias)) !== destination)
    throw new Error(`Unsafe macOS system alias: ${alias}`);
  return destination + absolute.slice(alias.length);
}

export function expandPathHome(value: string, home = homedir()): string {
  return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/** Apply Pi's input transformations at the model boundary only, never to discovered filenames. */
export function modelPath(raw: unknown, cwd: string): string {
  let value = String(raw ?? ".").replace(UNICODE_SPACES, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (process.platform === "win32" && !value.includes("\\")) {
    const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) value = `${match[1]!.toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
  }
  value = expandPathHome(value);
  if (value.startsWith("file://")) value = fileURLToPath(value);
  return path.resolve(cwd, value || ".");
}

export function readPath(selected: string): string {
  const nfd = selected.normalize("NFD");
  const candidates = [
    selected,
    selected.replace(/ (AM|PM)\./gi, "\u202F$1."),
    nfd,
    selected.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ];
  for (const candidate of new Set(candidates)) {
    const binding = bindPath(candidate);
    if (binding.missing.length) continue;
    accessSync(candidate, constants.F_OK);
    return candidate;
  }
  return selected;
}

/** Check the frozen root on both sides of resolution; Linux additionally resolves through its descriptor. */
export function configPath(value: string, root: RootIdentity, agentDir: string, home = homedir()): PathBinding {
  assertBinding(root.binding);
  const expanded = expandPathHome(
    value.replace(/^\$AGENT_DIR(?=\/|$)/, agentDir).replace(/^\$HOME(?=\/|$)/, home),
    home,
  );
  if (path.isAbsolute(expanded)) return bindPath(expanded);
  const fd = openSync(root.binding.canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    assertBinding(root.binding);
    if (!sameIdentity(identity(fd), root.binding.identity)) throw new Error("Frozen root descriptor changed");
    // Darwin's /dev/fd entries are devices, not traversable directory aliases.
    const anchor = process.platform === "linux" ? `/proc/self/fd/${fd}` : root.binding.canonical;
    const resolved = bindPath(`${anchor}${path.sep}${expanded}`);
    assertBinding(root.binding);
    const binding = { ...resolved, lexical: path.resolve(root.binding.canonical, expanded) };
    assertBinding(binding);
    return binding;
  } finally {
    closeSync(fd);
  }
}
