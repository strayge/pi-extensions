import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import { RuntimeCoordinator } from "./sandbox.ts";

const supported = process.platform === "darwin" || (process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/socat"));
function fixture() {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-concurrent-"))).canonical;
  const make = (name: string) => {
    const cwd = path.join(dir, name); mkdirSync(cwd);
    const config = defaultConfig(); config.pathRules = [];
    config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: ["system"] };
    config.modes.subproject = config.modes.project!;
    config.modes.readonly = { label: "Read only", color: "accent", filesystem: { kind: "scoped", readOnly: ["."], readWrite: [], resourceReads: ["system"] } };
    const root = { family: randomUUID(), binding: bindPath(cwd) };
    const owner = new PermissionOwner(resolveCatalog(config, root, { agentDir: dir, home: dir }), { ask: async () => undefined });
    const family = { id: owner.id, network: () => ({ revision: 0, restricted: false, allowedDomains: [], deniedDomains: [] }), decideHost: async () => false };
    return { cwd, owner, family };
  };
  return { make, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("concurrent same-family commands retain distinct immutable filesystem snapshots", { skip: !supported, timeout: 15000 }, async () => {
  const f = fixture(); const { cwd, owner, family } = f.make("project"); const runtime = new RuntimeCoordinator();
  const abort = new AbortController(); let old: Promise<unknown> | undefined;
  try {
    let ready!: () => void; const started = new Promise<void>((resolve) => { ready = resolve; });
    const snapshot = owner.snapshot();
    old = runtime.operations(snapshot, family, () => {}).exec("echo READY; while [ ! -e trigger ]; do sleep 0.01; done; echo OLD > result", cwd, {
      signal: abort.signal, timeout: 10, onData: (data) => { if (String(data).includes("READY")) ready(); },
    });
    await started;
    owner.select("readonly");
    let output = "";
    const later = await runtime.operations(owner.snapshot(), family, () => {}).exec("echo NEW > result", cwd, { timeout: 5, onData: (data) => { output += data; } });
    assert.notEqual(later.exitCode, 0, output); assert.ok(!existsSync(path.join(cwd, "result")));
    writeFileSync(path.join(cwd, "trigger"), "go"); await old;
    assert.equal(readFileSync(path.join(cwd, "result"), "utf8").trim(), "OLD");
    assert.equal(snapshot.profile.grants.find((grant) => grant.definition === "root:write:.")?.access, "write");
  } finally { abort.abort(); await old?.catch(() => {}); await runtime.shutdown(family.id); f.close(); }
});

test("unrelated families queue cancellably and cannot borrow another family's policy", { skip: !supported, timeout: 15000 }, async () => {
  const f = fixture(); const first = f.make("first"); const second = f.make("second"); const runtime = new RuntimeCoordinator();
  const abort = new AbortController(); let running: Promise<unknown> | undefined;
  try {
    writeFileSync(path.join(first.cwd, "secret"), "OTHER-FAMILY-SECRET");
    let ready!: () => void; const started = new Promise<void>((resolve) => { ready = resolve; });
    running = runtime.operations(first.owner.snapshot(), first.family, () => {}).exec("echo READY; while [ ! -e trigger ]; do sleep 0.01; done", first.cwd, {
      signal: abort.signal, timeout: 10, onData: (data) => { if (String(data).includes("READY")) ready(); },
    });
    await started;
    const queuedAbort = new AbortController(); let spawned = false;
    const queued = runtime.operations(second.owner.snapshot(), second.family, () => { spawned = true; }).exec("echo second", second.cwd, { signal: queuedAbort.signal, onData: () => {} });
    const rejected = assert.rejects(queued, /abort/i); queuedAbort.abort(); await rejected; assert.equal(spawned, false);
    writeFileSync(path.join(first.cwd, "trigger"), "go"); await running;
    let output = "";
    const result = await runtime.operations(second.owner.snapshot(), second.family, () => { spawned = true; }).exec(`cat '${path.join(first.cwd, "secret")}'; echo OWN > result`, second.cwd, { timeout: 5, onData: (data) => { output += data; } });
    assert.equal(result.exitCode, 0, output); assert.equal(spawned, true); assert.doesNotMatch(output, /OTHER-FAMILY-SECRET/);
    assert.equal(readFileSync(path.join(second.cwd, "result"), "utf8").trim(), "OWN");
  } finally { abort.abort(); await running?.catch(() => {}); await runtime.shutdown(first.family.id); await runtime.shutdown(second.family.id); f.close(); }
});
