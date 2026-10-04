import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import { RuntimeCoordinator } from "./sandbox.ts";

const supported = process.platform === "darwin" || (process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/socat"));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("foreground exit retires background jobs and detached spawn descendants before owner draining", { skip: !supported, timeout: 15000 }, async () => {
  for (const kind of ["redirected", "inherited-pipes", "detached"]) {
    const project = bindPath(mkdtempSync(path.join(tmpdir(), "permission-lifetime-"))).canonical;
    const config = defaultConfig(); config.pathRules = []; config.processMode = "strict";
    config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["pi", "system"] };
    config.modes.subproject = config.modes.project!;
    const root = { family: randomUUID(), binding: bindPath(project) };
    const owner = new PermissionOwner(resolveCatalog(config, root, { agentDir: project, home: project, piPackage: getPackageDir() }), { ask: async () => undefined });
    const runtime = new RuntimeCoordinator(); let output = "";
    try {
      const descendant = "echo READY > ready; sleep 1; echo SURVIVED > marker";
      const wait = "while [ ! -e ready ]; do sleep 0.01; done";
      const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn('/bin/bash',['-c',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'}); child.on('error',e=>{console.error(e);process.exit(1)}); child.unref(); const wait=setInterval(()=>{if(fs.existsSync('ready'))clearInterval(wait)},10);`;
      const command = kind === "detached" ? `${quote(process.execPath)} -e ${quote(script)}`
        : `(${descendant}) ${kind === "redirected" ? ">/dev/null 2>&1" : ""} & ${wait}`;
      const result = await owner.run([project], "read", "contained lifetime", undefined, async (snapshot, _targets, signal) =>
        runtime.operations(snapshot, { id: owner.id, network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }), decideHost: async () => false }, () => owner.check(snapshot.revision))
          .exec(command, project, { signal, timeout: 5, onData: (data) => { output += data; } }));
      assert.equal(result.exitCode, 0, output);
      assert.ok(existsSync(path.join(project, "ready")), kind);
      owner.block("shutdown"); await owner.drain(); await runtime.shutdown(owner.id);
      await delay(1200);
      assert.ok(!existsSync(path.join(project, "marker")), `${kind} descendant survived foreground exit and shutdown: ${output}`);
    } finally { owner.block("cleanup"); await owner.drain(); await runtime.shutdown(owner.id); rmSync(project, { recursive: true, force: true }); }
  }
});

test("strict macOS mode rejects direct process-group changes and posix_spawn group flags", { skip: process.platform !== "darwin" }, async () => {
  const project = bindPath(mkdtempSync(path.join(tmpdir(), "permission-process-group-"))).canonical;
  const source = path.join(project, "probe.c"); const executable = path.join(project, "probe");
  writeFileSync(source, `#include <unistd.h>
#include <spawn.h>
#include <errno.h>
#include <stdio.h>
extern char **environ;
int main(void) {
  errno = 0; int session = setsid(); int session_errno = errno;
  errno = 0; int group = setpgid(0, 0); int group_errno = errno;
  posix_spawnattr_t attr; posix_spawnattr_init(&attr);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP); posix_spawnattr_setpgroup(&attr, 0);
  pid_t pid; char *argv[] = {"/usr/bin/true", NULL};
  int spawned = posix_spawn(&pid, argv[0], NULL, &attr, argv, environ);
  printf("setsid=%d:%d setpgid=%d:%d spawn=%d\\n", session, session_errno, group, group_errno, spawned);
  return !(session == -1 && session_errno == EPERM && group == -1 && group_errno == EPERM && spawned == ENOSYS);
}
`);
  const runtime = new RuntimeCoordinator(); const root = { family: randomUUID(), binding: bindPath(project) }; let output = "";
  try {
    const compiled = spawnSync("/usr/bin/clang", [source, "-o", executable], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    // Network-only confinement must retain the process boundary even with filesystem limits disabled.
    const snapshot = { revision: 0, root, mode: "yolo", processMode: "strict" as const, profile: { kind: "unrestricted" as const, grants: [] }, rules: [], grants: [], exceptions: [] };
    const result = await runtime.operations(snapshot, { id: root.family, network: () => ({ revision: 0, restricted: true, allowedDomains: [], deniedDomains: [] }), decideHost: async () => false }, () => {})
      .exec(quote(executable), project, { timeout: 5, onData: (data) => { output += data; } });
    assert.equal(result.exitCode, 0, output); assert.match(output, /setsid=-1:1 setpgid=-1:1 spawn=78/);
  } finally { await runtime.shutdown(root.family); rmSync(project, { recursive: true, force: true }); }
});
