import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { bindPath } from "./paths.ts";
import { RuntimeCoordinator, formatSandboxDiagnostics } from "./sandbox.ts";
import type { FilesystemSnapshot, NetworkSnapshot } from "./schema.ts";

const network: NetworkSnapshot = {
  revision: 0,
  restricted: true,
  allowedDomains: [],
  deniedDomains: [],
};

function snapshot(directory: string): FilesystemSnapshot {
  return {
    revision: 0,
    root: { family: randomUUID(), binding: bindPath(directory) },
    mode: "test",
    profile: { kind: "unrestricted", grants: [] },
    rules: [],
    grants: [],
    exceptions: [],
  };
}

function violation(host: string): string {
  return `<sandbox_violations>\ndeny network-outbound ${host}:443 (user denied)\n</sandbox_violations>`;
}

test("diagnostic formatting suggests only currently grantable normalized hosts", () => {
  const formatted = formatSandboxDiagnostics(
    [
      "<sandbox_violations>",
      "deny network-outbound grant.example:443 (user denied)",
      "deny network-outbound api.allowed.example:443 (user denied)",
      "deny network-outbound api.blocked.example:443 (user denied)",
      "deny network-outbound 0x7f000001:443 (user denied)",
      "deny network-outbound infrastructure.example:443 (invalid proxy credentials)",
      "deny file-read-data /dev/secret",
      "</sandbox_violations>",
    ].join("\n"),
    {
      ...network,
      allowedDomains: ["*.allowed.example"],
      deniedDomains: ["*.blocked.example", "127.0.0.1"],
    },
  );
  assert.match(formatted, /<sandbox_violations>/);
  assert.match(formatted, /grant\.example/);
  assert.match(formatted, /request_network_access/);
  assert.doesNotMatch(formatted, /Hint:[\s\S]*api\.allowed\.example/);
  assert.doesNotMatch(formatted, /Hint:[\s\S]*api\.blocked\.example/);
  assert.doesNotMatch(formatted, /Hint:[\s\S]*127\.0\.0\.1/);
  assert.doesNotMatch(formatted, /Hint:[\s\S]*infrastructure\.example/);
  assert.match(formatted, /deny file-read-data \/dev\/secret/);
  assert.equal(formatSandboxDiagnostics("no records", network), "");
  assert.equal(formatSandboxDiagnostics(violation("grant.example"), { ...network, restricted: false }), violation("grant.example"));
});

test("attributed diagnostics remain separate for repeated long commands", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "permission-sandbox-diagnostics-"));
  const ids: string[] = [];
  const commands: string[] = [];
  t.mock.method(SandboxManager, "reset", async () => {});
  t.mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  t.mock.method(SandboxManager, "initialize", async (
    _config: Parameters<typeof SandboxManager.initialize>[0],
    _ask: Parameters<typeof SandboxManager.initialize>[1],
    monitor: Parameters<typeof SandboxManager.initialize>[2],
  ) => {
    assert.equal(monitor, process.platform === "darwin");
  });
  t.mock.method(SandboxManager, "wrapWithSandbox", async (
    command: Parameters<typeof SandboxManager.wrapWithSandbox>[0],
    _shell: Parameters<typeof SandboxManager.wrapWithSandbox>[1],
    _config: Parameters<typeof SandboxManager.wrapWithSandbox>[2],
    _signal: Parameters<typeof SandboxManager.wrapWithSandbox>[3],
    options: Parameters<typeof SandboxManager.wrapWithSandbox>[4],
  ) => {
    ids.push(options?.commandId ?? "");
    commands.push(options?.commandText ?? "");
    return command;
  });
  t.mock.method(SandboxManager, "annotateStderrWithSandboxFailures", (id: string) => violation(`host-${ids.indexOf(id)}.example`));
  const runtime = new RuntimeCoordinator();
  const original = `printf 'done'; #${"x".repeat(160)}`;
  const root = snapshot(directory);
  const run = () => {
    let output = "";
    return runtime.operations(root, { id: root.root.family, network: () => network, decideHost: async () => false }, () => {}).exec(original, directory, {
      onData: (data) => { output += String(data); },
    }).then((result) => ({ result, output }));
  };
  try {
    const [first, second] = await Promise.all([run(), run()]);
    assert.equal(first.result.exitCode, 0);
    assert.equal(second.result.exitCode, 0);
    assert.equal(new Set(ids).size, 2);
    assert.deepEqual(commands, [original, original]);
    assert.match(first.output, /done\n<sandbox_violations>/);
    assert.match(first.output, /host-0\.example/);
    assert.doesNotMatch(first.output, /host-1\.example/);
    assert.match(second.output, /host-1\.example/);
    assert.doesNotMatch(second.output, /host-0\.example/);
  } finally {
    await runtime.shutdown(root.root.family);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("diagnostics are reported after success, failure, timeout, and cancellation", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "permission-sandbox-outcomes-"));
  t.mock.method(SandboxManager, "reset", async () => {});
  t.mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  t.mock.method(SandboxManager, "initialize", async () => {});
  t.mock.method(SandboxManager, "wrapWithSandbox", async (command: Parameters<typeof SandboxManager.wrapWithSandbox>[0]) => command);
  t.mock.method(SandboxManager, "annotateStderrWithSandboxFailures", (_id: string) => violation("outcome.example"));
  const runtime = new RuntimeCoordinator();
  const root = snapshot(directory);
  const family = { id: root.root.family, network: () => network, decideHost: async () => false };
  const exec = (command: string, options: Parameters<ReturnType<RuntimeCoordinator["operations"]>["exec"]>[2] = { onData: () => {} }) =>
    runtime.operations(root, family, () => {}).exec(command, directory, options);
  try {
    let success = "";
    const ok = await exec("printf success", { onData: (data) => { success += String(data); } });
    assert.equal(ok.exitCode, 0);
    assert.match(success, /outcome\.example/);

    let failed = "";
    const nonzero = await exec("printf failure; exit 7", { onData: (data) => { failed += String(data); } });
    assert.equal(nonzero.exitCode, 7);
    assert.match(failed, /outcome\.example/);

    let timedOut = "";
    await assert.rejects(exec("sleep 1", { timeout: 0.01, onData: (data) => { timedOut += String(data); } }), /timeout/i);
    assert.match(timedOut, /outcome\.example/);

    const controller = new AbortController();
    let cancelled = "";
    const cancellation = exec("sleep 1", { signal: controller.signal, onData: (data) => { cancelled += String(data); } });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(cancellation, /aborted/i);
    assert.match(cancelled, /outcome\.example/);
  } finally {
    await runtime.shutdown(root.root.family);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("annotation failures do not change command results or cleanup", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "permission-sandbox-best-effort-"));
  let cleaned = 0;
  let annotated = 0;
  t.mock.method(SandboxManager, "reset", async () => {});
  t.mock.method(SandboxManager, "cleanupAfterCommand", () => { cleaned++; });
  t.mock.method(SandboxManager, "initialize", async () => {});
  t.mock.method(SandboxManager, "wrapWithSandbox", async (command: Parameters<typeof SandboxManager.wrapWithSandbox>[0]) => command);
  t.mock.method(SandboxManager, "annotateStderrWithSandboxFailures", (_id: string) => { annotated++; throw new Error("diagnostic unavailable"); });
  const runtime = new RuntimeCoordinator();
  const root = snapshot(directory);
  try {
    const result = await runtime.operations(root, { id: root.root.family, network: () => network, decideHost: async () => false }, () => {}).exec("printf ok", directory, { onData: () => {} });
    assert.equal(result.exitCode, 0);
    assert.equal(cleaned, 1);
    assert.equal(annotated, 1);
    const family = { id: root.root.family, network: () => network, decideHost: async () => false };
    t.mock.method(SandboxManager, "wrapWithSandbox", async () => { throw new Error("wrap failed"); });
    await assert.rejects(runtime.operations(root, family, () => {}).exec("printf unused", directory, { onData: () => {} }), /wrap failed/);
    assert.equal(annotated, 1);
    let direct = "";
    await runtime.operations(root, { ...family, network: () => ({ ...network, restricted: false }) }, () => {}).exec("printf direct", directory, { onData: (data) => { direct += data; } });
    assert.equal(direct, "direct");
    assert.equal(annotated, 1);
  } finally {
    await runtime.shutdown(root.root.family);
    rmSync(directory, { recursive: true, force: true });
  }
});
