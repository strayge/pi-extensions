import { spawnSync } from "node:child_process";
import { lstatSync, statfsSync } from "node:fs";
import path from "node:path";
import type { PathBinding } from "./schema.ts";

const verified = new Map<string, string>();
const apfsDevices = new Set<string>();

/** Unknown filesystems fail closed; Darwin aliases are resolved by the filesystem and Seatbelt. */
export function assertNativeSemantics(binding: PathBinding): void {
  const directory = binding.identity.type === "directory" ? binding.prefix : path.dirname(binding.prefix);
  let current = directory;
  for (;;) {
    verifyDirectory(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function verifyDirectory(directory: string): void {
  if (process.platform === "darwin") {
    const device = `${lstatSync(directory, { bigint: true }).dev}:${statfsSync(directory).type}`;
    if (apfsDevices.has(device)) return;
    // df's filesystem filter checks the native mount type, not a numeric type guessed across kernels.
    const result = spawnSync("/bin/df", ["-T", "apfs", directory], { encoding: "utf8", timeout: 3000 });
    if (result.status !== 0 || result.stdout.trim().split("\n").length < 2)
      throw new Error(`Native path enforcement requires APFS on macOS: ${directory}`);
    apfsDevices.add(device);
    return;
  }
  if (process.platform !== "linux")
    throw new Error(
      `Native path enforcement has not been verified on ${process.platform}; scoped access is unavailable`,
    );
  const type = statfsSync(directory).type;
  // Linux tmpfs has byte-sensitive names and no per-directory casefold flag.
  if (type === 0x01021994) return;
  if (type !== 0xef53)
    throw new Error(`Native path enforcement is unavailable for filesystem type ${type.toString(16)} at ${directory}`);
  const stat = lstatSync(directory, { bigint: true });
  const key = `${stat.dev}:${stat.ino}`;
  const stamp = String(stat.ctimeNs);
  if (verified.get(key) === stamp) return;
  const binary = "/usr/bin/lsattr";
  const executable = lstatSync(binary);
  if (!executable.isFile() || executable.uid !== 0 || executable.mode & 0o022)
    throw new Error("A protected system lsattr is required to verify ext4 casefold flags");
  const result = spawnSync(binary, ["-d", "--", directory], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0 || !/^[A-Za-z-]+\s/.test(result.stdout) || result.stdout.split(/\s/)[0]!.includes("F"))
    throw new Error(`Cannot verify case-sensitive native enforcement at ${directory}`);
  verified.set(key, stamp);
}
