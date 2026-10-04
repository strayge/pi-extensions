import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/** Homebrew executables need exact dylibs, not read access to the entire Homebrew prefix. */
export function macExecutableFiles(executable: string): string[] {
  const files = new Set<string>();
  const executableDir = path.dirname(realpathSync.native(executable));
  function inspect(file: string, inheritedRpaths: string[]): void {
    const canonical = realpathSync.native(file);
    if (files.has(canonical)) return;
    files.add(canonical);
    const run = (flag: string) => {
      const result = spawnSync("/usr/bin/otool", [flag, canonical], {
        encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      });
      if (result.status !== 0) throw new Error(`Cannot inspect macOS executable dependencies: ${canonical}`);
      return result.stdout;
    };
    const expand = (name: string) => name
      .replace(/^@loader_path(?=\/|$)/, path.dirname(canonical))
      .replace(/^@executable_path(?=\/|$)/, executableDir);
    const rpaths = [...run("-l").matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+) \(offset \d+\)/g)]
      .map((match) => expand(match[1]!)).concat(inheritedRpaths);
    for (const line of run("-L").split("\n").slice(1)) {
      const name = line.trim().replace(/ \(compatibility version .+$/, "");
      if (!name) continue;
      const dependency = expand(name);
      // These paths live in the OS dyld cache and may have no ordinary directory entry.
      if (dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/")) continue;
      const candidates = dependency.startsWith("@rpath/")
        ? rpaths.map((root) => path.join(root, dependency.slice(7))) : [dependency];
      const resolved = candidates.find((candidate) => path.isAbsolute(candidate) && existsSync(candidate));
      if (!resolved) throw new Error(`Cannot resolve macOS executable dependency: ${name} (${canonical})`);
      inspect(resolved, rpaths);
    }
  }
  inspect(executable, []);
  return [...files];
}

/** No PATH lookup: a user-owned Homebrew rg is safe only inside this stdin-only sandbox. */
export function macRipgrep(): string {
  const file = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].find(existsSync);
  if (!file) throw new Error("grep requires Homebrew ripgrep on macOS (brew install ripgrep)");
  return realpathSync.native(file);
}

const grepProfiles = new Map<string, string>();

/** A compromised search binary must not gain ambient filesystem or network authority. */
export function macGrepSandbox(executable: string): string {
  const cached = grepProfiles.get(executable);
  if (cached) return cached;
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork sysctl-read)",
    "(allow file-read-metadata)",
    '(allow file-read-data (literal "/"))',
    '(allow file-read* (vnode-type SYMLINK))',
    '(allow file-read* (subpath "/System") (subpath "/usr/lib") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-read* file-write* (literal "/dev/null"))',
    ...macExecutableFiles(executable).map((file) => `(allow file-read* (literal ${JSON.stringify(file)}))`),
  ].join("\n");
  grepProfiles.set(executable, profile);
  return profile;
}
