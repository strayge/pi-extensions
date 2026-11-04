import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsPrivateDirectory } from "../src/windows-platform.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const files = args.some((argument) => argument.endsWith(".test.ts")) ? [] :
  readdirSync(path.join(root, "src")).filter((name) => name.endsWith(".test.ts")).map((name) => path.join(root, "src", name));
let temporary: string | undefined;
try {
  if (process.platform === "win32") {
    // Shared Windows temp ACLs can permit unrelated-user ancestor mutation, unlike private authority storage.
    temporary = path.join(homedir(), `.pi-permissions-tests-${randomUUID()}`);
    createWindowsPrivateDirectory(temporary);
  }
  const child = spawnSync(process.execPath, ["--test", "--experimental-strip-types", ...args, ...files], {
    cwd: root, stdio: "inherit", env: { ...process.env, ...(temporary ? { TEMP: temporary, TMP: temporary } : {}) },
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
