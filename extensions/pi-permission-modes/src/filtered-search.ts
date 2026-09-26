import { spawn } from "node:child_process";
import { createReadStream, lstatSync, type Stats } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import type { PermissionOwner } from "./approvals.ts";
import { compileGlob } from "./glob.ts";
import { assertBinding, bindPath, modelPath, within } from "./paths.ts";
import { decide } from "./policy.ts";
import type { FilesystemSnapshot, PathBinding } from "./schema.ts";

interface Matcher {
  add(text: string): Matcher;
  test(relative: string): { ignored: boolean; unignored: boolean };
}
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const ignore = requirePi("ignore") as () => Matcher;
interface Layer {
  base: string;
  matcher: Matcher;
  priority: number;
  git: boolean;
}
class UnknownContext extends Error {}
interface Entry {
  native: string;
  relative: string;
  binding: PathBinding;
  directory: boolean;
  link?: boolean;
}
interface Omissions {
  permission: number;
  context: number;
  symlink: number;
}

/** Only a fixed system binary with protected ancestry is executable on the host. */
function trustedRg(): string {
  const file = "/usr/bin/rg";
  let current = file;
  for (;;) {
    const stat = lstatSync(current);
    if (stat.uid !== 0 || stat.mode & 0o022 || stat.isSymbolicLink() || (current === file && !stat.isFile()))
      throw new Error("grep requires a root-owned /usr/bin/rg with non-writable ancestors");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return file;
}

/** Ripgrep sees only authorized bytes on stdin, never a recursive host search root. */
async function grepBytes(
  input: Buffer | string,
  pattern: string,
  options: { ignoreCase?: boolean; literal?: boolean; limit?: number },
  signal?: AbortSignal,
): Promise<number[]> {
  signal?.throwIfAborted();
  const executable = trustedRg();
  const args = [
    "--no-config",
    "--json",
    "--line-number",
    "--color=never",
    "--max-count",
    String(Math.max(1, options.limit ?? 100)),
    ...(options.ignoreCase ? ["--ignore-case"] : []),
    ...(options.literal ? ["--fixed-strings"] : []),
    "--",
    pattern,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
    });
    const matches: number[] = [];
    let pending = "";
    let error = "";
    const stream = typeof input === "string" ? createReadStream(input) : undefined;
    const abort = () => {
      stream?.destroy();
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "match") matches.push(event.data.line_number);
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => {
      if (error.length < 8192) error += chunk;
    });
    child.stdin.on("error", () => {});
    if (stream) {
      stream.once("error", (cause) => {
        abort();
        reject(cause);
      });
      stream.pipe(child.stdin);
    } else child.stdin.end(input);
    child.once("error", (cause) => {
      signal?.removeEventListener("abort", abort);
      reject(cause);
    });
    child.once("close", (code) => {
      stream?.destroy();
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Operation aborted"));
      else if (code !== 0 && code !== 1) reject(new Error(error || `ripgrep failed (${code})`));
      else resolve(matches);
    });
  });
}

class Walker {
  readonly omissions: Omissions = { permission: 0, context: 0, symlink: 0 };
  private readonly owner: PermissionOwner;
  private readonly snapshot: FilesystemSnapshot;
  private readonly root: PathBinding;
  private readonly kind: "fd" | "rg";
  private readonly signal?: AbortSignal;
  constructor(
    owner: PermissionOwner,
    snapshot: FilesystemSnapshot,
    root: PathBinding,
    kind: "fd" | "rg",
    signal?: AbortSignal,
  ) {
    this.owner = owner;
    this.snapshot = snapshot;
    this.root = root;
    this.kind = kind;
    this.signal = signal;
  }
  private check(): void {
    this.signal?.throwIfAborted();
    this.owner.check(this.snapshot.revision);
    assertBinding(this.root);
  }
  allowed(native: string, canonical = native): boolean {
    this.check();
    return decide(this.snapshot, { ...this.root, lexical: native, canonical }, "read").action === "allow";
  }
  private async metadata(file: string): Promise<string | undefined> {
    this.check();
    const ancestors: string[] = [];
    for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent))
      ancestors.unshift(parent);
    for (const parent of ancestors) {
      if (within(parent, this.root.lexical)) continue;
      try {
        if ((await lstat(parent)).isSymbolicLink())
          throw new UnknownContext(`Discovered ignore ancestor symlink is not followed: ${parent}`);
      } catch (error) {
        this.check();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        if (error instanceof UnknownContext) throw error;
        throw new UnknownContext(`Cannot classify ignore ancestry: ${parent}`);
      }
      this.check();
    }
    let stat: Stats;
    try {
      stat = await lstat(file);
    } catch (error) {
      this.check();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new UnknownContext(`Cannot classify ignore metadata: ${file}`);
    }
    this.check();
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new UnknownContext(`Ignore metadata is not an ordinary file: ${file}`);
    const binding = bindPath(file);
    if (decide(this.snapshot, binding, "read").action !== "allow")
      throw new UnknownContext(`Required ignore metadata is not authorized: ${file}`);
    assertBinding(binding);
    try {
      const text = await readFile(file, "utf8");
      this.check();
      assertBinding(binding);
      return text;
    } catch (error) {
      this.check();
      throw new UnknownContext(`Cannot read required ignore metadata: ${file}: ${String(error)}`);
    }
  }
  private async repository(directory: string): Promise<string | undefined> {
    const marker = path.join(directory, ".git");
    let stat: Stats;
    try {
      stat = await lstat(marker);
    } catch (error) {
      this.check();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new UnknownContext(`Cannot classify repository boundary: ${marker}`);
    }
    this.check();
    if (stat.isSymbolicLink()) throw new UnknownContext(`Discovered Git symlink is not followed: ${marker}`);
    if (stat.isDirectory()) return marker;
    if (!stat.isFile()) throw new UnknownContext(`Invalid Git boundary: ${marker}`);
    const content = await this.metadata(marker);
    const match = content?.trim().match(/^gitdir:\s*(.+)$/);
    if (!match) throw new UnknownContext(`Invalid Gitfile: ${marker}`);
    const referenced = path.resolve(directory, match[1]!);
    if (!this.allowed(referenced) || !(await lstat(referenced)).isDirectory())
      throw new UnknownContext(`Gitfile target is not an authorized ordinary directory: ${referenced}`);
    this.check();
    const gitdir = bindPath(referenced);
    if (
      !this.allowed(gitdir.lexical, gitdir.canonical) ||
      gitdir.missing.length ||
      gitdir.identity.type !== "directory"
    )
      throw new UnknownContext(`Git metadata directory is unavailable: ${gitdir.lexical}`);
    return gitdir.canonical;
  }
  private async layers(
    directory: string,
    inherited: Layer[],
    inGit: boolean,
  ): Promise<{ layers: Layer[]; inGit: boolean }> {
    const gitdir = await this.repository(directory);
    let layers = [...inherited];
    if (gitdir) {
      inGit = true;
      layers = layers.filter((layer) => !layer.git || layer.priority === 0);
      const common = await this.metadata(path.join(gitdir, "commondir"));
      const metadata = common === undefined ? gitdir : path.resolve(gitdir, common.trim());
      const excludes = await this.metadata(path.join(metadata, "info", "exclude"));
      if (excludes !== undefined)
        layers.push({ base: directory, matcher: ignore().add(excludes), priority: 1, git: true });
    }
    for (const [name, priority, git] of [
      [".gitignore", 2, true],
      [".ignore", 3, false],
      [this.kind === "fd" ? ".fdignore" : ".rgignore", 4, false],
    ] as const) {
      if (git && !inGit && this.kind === "rg") continue;
      const content = await this.metadata(path.join(directory, name));
      if (content !== undefined) layers.push({ base: directory, matcher: ignore().add(content), priority, git });
    }
    return { layers, inGit };
  }
  private async ancestors(): Promise<{ layers: Layer[]; inGit: boolean }> {
    const chain: string[] = [];
    let dir = this.root.lexical;
    for (;;) {
      chain.unshift(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // Determine repository membership before applying parent's gitignore files.
    let inGit = false;
    for (const directory of chain) if (await this.repository(directory)) inGit = true;
    let layers: Layer[] = [];
    let globalIgnore = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "git", "ignore");
    for (const config of [
      path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "git", "config"),
      path.join(homedir(), ".gitconfig"),
    ]) {
      const text = await this.metadata(config);
      let section = "";
      for (const line of (text ?? "").split(/\r?\n/)) {
        const header = line.match(/^\s*\[([^\]]+)\]/);
        if (header) {
          section = header[1]!.toLowerCase();
          continue;
        }
        const value = section === "core" ? line.match(/^\s*excludesfile\s*=\s*(.*?)\s*$/i) : undefined;
        if (value) {
          const raw = value[1]!.replace(/^"(.*)"$/, "$1");
          globalIgnore = raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : path.resolve(raw);
        }
      }
    }
    const global = await this.metadata(globalIgnore);
    if (global !== undefined)
      layers.push({ base: path.parse(this.root.lexical).root, matcher: ignore().add(global), priority: 0, git: true });
    for (const directory of chain.slice(0, -1)) ({ layers, inGit } = await this.layers(directory, layers, inGit));
    return { layers, inGit };
  }
  private ignored(file: string, directory: boolean, layers: Layer[]): boolean {
    let ignored = false;
    for (const layer of [...layers].sort((a, b) => a.priority - b.priority)) {
      const relative = path.relative(layer.base, file).split(path.sep).join("/") + (directory ? "/" : "");
      if (!relative || relative.startsWith("../")) continue;
      const result = layer.matcher.test(relative);
      if (result.ignored || result.unignored) ignored = result.ignored;
    }
    return ignored;
  }
  async *walk(includeIgnored?: (file: string) => boolean): AsyncGenerator<Entry> {
    let ancestry: { layers: Layer[]; inGit: boolean };
    try {
      ancestry = await this.ancestors();
    } catch (error) {
      if (error instanceof UnknownContext) throw new Error(`Search unavailable: ${error.message}`);
      throw error;
    }
    const visit = async function* (
      this: Walker,
      directory: string,
      inherited: Layer[],
      inGit: boolean,
    ): AsyncGenerator<Entry> {
      this.check();
      let context: { layers: Layer[]; inGit: boolean };
      try {
        context = await this.layers(directory, inherited, inGit);
      } catch (error) {
        if (!(error instanceof UnknownContext)) throw error;
        if (directory === this.root.lexical) throw new Error(`Search unavailable: ${error.message}`);
        this.omissions.context++;
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      this.check();
      for (const entry of entries) {
        const native = path.join(directory, entry.name);
        const projected = path.join(this.root.canonical, path.relative(this.root.lexical, native));
        if (!this.allowed(native, projected)) {
          this.omissions.permission++;
          continue;
        }
        const stat = await lstat(native);
        this.check();
        if (stat.isSymbolicLink()) {
          this.omissions.symlink++;
          continue;
        }
        if (!stat.isFile() && !stat.isDirectory()) continue;
        const binding = bindPath(native);
        if (decide(this.snapshot, binding, "read").action !== "allow") {
          this.omissions.permission++;
          continue;
        }
        const isDirectory = stat.isDirectory();
        if (
          this.ignored(native, isDirectory, context.layers) &&
          !(includeIgnored && !isDirectory && includeIgnored(native))
        )
          continue;
        assertBinding(binding);
        yield {
          native,
          binding,
          relative: path.relative(this.root.lexical, native).split(path.sep).join("/"),
          directory: isDirectory,
        };
        if (isDirectory) yield* visit.call(this, native, context.layers, context.inGit);
      }
    };
    yield* visit.call(this, this.root.lexical, ancestry.layers, ancestry.inGit);
    this.check();
  }
}

/** Classify each link hop before following it; an unauthorized target keeps only its entry name. */
async function authorizedLinkDirectory(walker: Walker, initial: string, signal?: AbortSignal): Promise<boolean> {
  let target = initial;
  try {
    for (let hops = 0; hops < 40; hops++) {
      signal?.throwIfAborted();
      if (!walker.allowed(target)) return false;
      const parts = target.split(path.sep).filter(Boolean);
      let prefix = path.parse(target).root;
      let changed = false;
      for (let i = 0; i < parts.length; i++) {
        prefix = path.join(prefix, parts[i]!);
        const stat = await lstat(prefix);
        signal?.throwIfAborted();
        if (stat.isSymbolicLink()) {
          const link = await readlink(prefix);
          signal?.throwIfAborted();
          target = path.resolve(path.dirname(prefix), link, ...parts.slice(i + 1));
          changed = true;
          break;
        }
      }
      if (!changed) {
        if (!walker.allowed(initial, target)) return false;
        return (await lstat(target)).isDirectory();
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error)) throw error;
  }
  signal?.throwIfAborted();
  return false;
}

function output(lines: string[], empty: string, omissions: Omissions, limit?: number) {
  const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const notices: string[] = [];
  if (limit !== undefined && lines.length >= limit) notices.push(`${limit} results limit reached`);
  if (truncation.truncated) notices.push("Output byte limit reached");
  if (omissions.permission) notices.push(`${omissions.permission} paths omitted by filesystem permissions`);
  if (omissions.context) notices.push(`${omissions.context} subtrees omitted: unavailable ignore context`);
  if (omissions.symlink) notices.push(`${omissions.symlink} discovered symlinks not followed`);
  return {
    content: [
      {
        type: "text" as const,
        text: (truncation.content || empty) + (notices.length ? `\n\n[${notices.join("; ")}]` : ""),
      },
    ],
    details: { omissions, ...(truncation.truncated ? { truncation } : {}) },
  };
}

export function createSearchTools(getOwner: () => PermissionOwner, cwd: string) {
  const find = createFindToolDefinition(cwd);
  const grep = createGrepToolDefinition(cwd);
  const ls = createLsToolDefinition(cwd);
  return [
    {
      ...find,
      execute: async (...args: Parameters<typeof find.execute>) => {
        const [, params, signal, , ctx] = args;
        const root = modelPath(params.path, ctx.cwd || cwd);
        const full = params.pattern.includes("/");
        const pattern =
          full && !params.pattern.startsWith("/") && !params.pattern.startsWith("**/")
            ? `**/${params.pattern}`
            : params.pattern;
        const match = compileGlob(pattern, "fd", signal);
        const owner = getOwner();
        return owner.run([root], "read", "Find files", signal, async (snapshot, [binding]) => {
          const walker = new Walker(owner, snapshot, binding!, "fd", signal);
          const lines: string[] = [];
          for await (const entry of walker.walk()) {
            if (match(full ? entry.native : path.basename(entry.native)))
              lines.push(entry.relative + (entry.directory ? "/" : ""));
            if (lines.length >= (params.limit ?? 1000)) break;
          }
          return output(lines, "No files found matching pattern", walker.omissions, params.limit ?? 1000);
        });
      },
    },
    {
      ...grep,
      execute: async (...args: Parameters<typeof grep.execute>) => {
        const [, params, signal, , ctx] = args;
        const root = modelPath(params.path, ctx.cwd || cwd);
        const glob = params.glob || undefined;
        const exclude = glob?.startsWith("!");
        const body = exclude ? glob!.slice(1) : glob;
        const match =
          body === undefined ? undefined : compileGlob(body.startsWith("/") ? body.slice(1) : body, "rg", signal);
        const matches = (native: string) =>
          !match ||
          match(
            body!.includes("/")
              ? path.relative(process.cwd(), native).split(path.sep).join("/")
              : path.basename(native),
          ) !== !!exclude;
        await grepBytes(Buffer.alloc(0), params.pattern, params, signal);
        const owner = getOwner();
        return owner.run([root], "read", "Search file contents", signal, async (snapshot, [binding]) => {
          const walker = new Walker(owner, snapshot, binding!, "rg", signal);
          const lines: string[] = [];
          let count = 0;
          const limit = Math.max(1, params.limit ?? 100);
          const entries =
            binding!.identity.type === "directory"
              ? walker.walk(glob && !exclude ? matches : undefined)
              : (async function* () {
                  yield { native: root, relative: path.basename(root), binding: binding!, directory: false };
                })();
          for await (const entry of entries) {
            if (entry.directory || !matches(entry.native)) continue;
            owner.check(snapshot.revision);
            assertBinding(entry.binding);
            signal?.throwIfAborted();
            const hits = await grepBytes(entry.native, params.pattern, { ...params, limit: limit - count }, signal);
            if (!hits.length) continue;
            owner.check(snapshot.revision);
            assertBinding(entry.binding);
            signal?.throwIfAborted();
            const bytes = await readFile(entry.native, { signal });
            signal?.throwIfAborted();
            const content = bytes.toString("utf8").replace(/\r\n?/g, "\n").split("\n");
            for (const hit of hits) {
              const context = Math.max(0, params.context ?? 0);
              for (let line = Math.max(1, hit - context); line <= Math.min(content.length, hit + context); line++) {
                const text = truncateLine(content[line - 1]!).text;
                lines.push(line === hit ? `${entry.relative}:${line}: ${text}` : `${entry.relative}-${line}- ${text}`);
              }
              if (++count >= limit) break;
            }
            if (count >= limit) break;
          }
          return output(lines, "No matches found", walker.omissions, count >= limit ? lines.length : undefined);
        });
      },
    },
    {
      ...ls,
      execute: async (...args: Parameters<typeof ls.execute>) => {
        const [, params, signal, , ctx] = args;
        const root = modelPath(params.path, ctx.cwd || cwd);
        const owner = getOwner();
        return owner.run([root], "read", "List directory", signal, async (snapshot, [binding]) => {
          const walker = new Walker(owner, snapshot, binding!, "fd", signal);
          const lines: string[] = [];
          const entries = await readdir(root, { withFileTypes: true });
          signal?.throwIfAborted();
          for (const entry of entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))) {
            const native = path.join(root, entry.name);
            const canonical = path.join(binding!.canonical, entry.name);
            if (!walker.allowed(native, canonical)) {
              walker.omissions.permission++;
              continue;
            }
            const stat = await lstat(native);
            signal?.throwIfAborted();
            let directory = stat.isDirectory();
            if (stat.isSymbolicLink()) {
              directory = await authorizedLinkDirectory(walker, canonical, signal);
            } else if (decide(snapshot, bindPath(native), "read").action !== "allow") {
              walker.omissions.permission++;
              continue;
            }
            lines.push(entry.name + (directory ? "/" : ""));
            if (lines.length >= (params.limit ?? 500)) break;
          }
          return output(lines, "Directory is empty", walker.omissions, params.limit ?? 500);
        });
      },
    },
  ] as const;
}
