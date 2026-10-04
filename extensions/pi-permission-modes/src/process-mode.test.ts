import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import { runProcess, RuntimeCoordinator } from "./sandbox.ts";
import { PermissionOwner } from "./approvals.ts";

const supported = process.platform === "darwin" || (process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/socat"));
const compiler = process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

for (const completion of ["exit", "abort", "timeout", "unconfined-strict"] as const) {
  test(`${completion} process uses bounded cleanup for pipes inherited by a detached child`, { skip: process.platform !== "darwin" && process.platform !== "linux", timeout: 5000 }, async (t) => {
    const directory = bindPath(mkdtempSync(path.join(tmpdir(), "permission-output-"))).canonical;
    let detached: number | undefined;
    const runtime = new RuntimeCoordinator();
    const root = { family: randomUUID(), binding: bindPath(directory) };
    t.after(async () => {
      if (detached) try { process.kill(-detached, "SIGKILL"); } catch {}
      await runtime.shutdown(root.family);
      rmSync(directory, { recursive: true, force: true });
    });
    const controller = new AbortController();
    const script = `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'inherit'});
      child.on('error', error => { console.error(error); process.exitCode = 1; });
      child.unref();
      console.log('DETACHED', child.pid);
      ${completion === "abort" || completion === "timeout" ? "setInterval(() => {}, 1000);" : ""}
    `;
    let output = "";
    const options = {
      signal: controller.signal,
      timeout: completion === "timeout" ? 1 : undefined,
      onData: (data: Buffer) => {
        output += data;
        const match = output.match(/DETACHED (\d+)/);
        if (match) {
          detached = Number(match[1]);
          if (completion === "abort") controller.abort();
        }
      },
    };
    const running = completion === "unconfined-strict"
      ? runtime.operations({
        revision: 0, root, mode: "yolo", processMode: "strict",
        profile: { kind: "unrestricted", grants: [] }, rules: [], grants: [], exceptions: [],
      }, {
        id: root.family,
        network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }),
        decideHost: async () => false,
      }, () => {}).exec(`${quote(process.execPath)} -e ${quote(script)}`, directory, options)
      : runProcess(process.execPath, ["-e", script], directory, options);
    if (completion === "exit" || completion === "unconfined-strict") assert.equal((await running).exitCode, 0);
    else await assert.rejects(running, completion === "abort" ? /Operation aborted/ : /timeout:1/);
    assert.ok(detached, output);
  });
}

test("compatible native sandbox permits sessions, groups, and posix_spawn without lifting inherited file restrictions", {
  skip: !supported || !existsSync(compiler), timeout: 10000,
}, async () => {
  const directory = bindPath(mkdtempSync(path.join(tmpdir(), "permission-compatible-"))).canonical;
  const project = path.join(directory, "project"); mkdirSync(project);
  const outside = path.join(directory, "outside"); writeFileSync(outside, "HOST-SECRET");
  const source = path.join(project, "probe.c"); const executable = path.join(project, "probe");
  writeFileSync(source, `#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <stdio.h>
extern char **environ;
static int succeeded(pid_t pid) {
  int status;
  return pid > 0 && waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
int main(int argc, char **argv) {
  if (argc != 2) return 1;
  pid_t session = fork();
  if (session == 0) {
    if (setsid() == -1) _exit(1);
    int fd = open(argv[1], O_RDONLY);
    if (fd >= 0) { close(fd); _exit(1); }
    _exit(0);
  }
  if (!succeeded(session)) return 1;
  pid_t group = fork();
  if (group == 0) _exit(setpgid(0, 0) == 0 ? 0 : 1);
  if (!succeeded(group)) return 1;
  posix_spawnattr_t attr; posix_spawnattr_init(&attr);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP); posix_spawnattr_setpgroup(&attr, 0);
  pid_t pid; char *args[] = {"/usr/bin/true", NULL};
  int spawned = posix_spawn(&pid, args[0], NULL, &attr, args, environ);
  posix_spawnattr_destroy(&attr);
  if (spawned != 0 || !succeeded(pid)) return 1;
  puts("COMPATIBLE-AND-CONFINED");
  return 0;
}
`);
  const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
  config.modes.subproject = config.modes.project!;
  const root = { family: randomUUID(), binding: bindPath(project) };
  const owner = new PermissionOwner(resolveCatalog(config, root, { agentDir: directory, home: directory }), { ask: async () => undefined });
  const runtime = new RuntimeCoordinator(); let output = "";
  try {
    const compiled = spawnSync(compiler, [source, "-o", executable], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.equal(owner.snapshot().processMode, "compatible");
    const result = await runtime.operations(owner.snapshot(), {
      id: root.family,
      network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }),
      decideHost: async () => false,
    }, () => {}).exec(`${quote(executable)} ${quote(outside)}`, project, { timeout: 5, onData: (data) => { output += data; } });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /COMPATIBLE-AND-CONFINED/);
  } finally { await runtime.shutdown(root.family); rmSync(directory, { recursive: true, force: true }); }
});
