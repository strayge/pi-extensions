import assert from "node:assert/strict";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WindowsResponseError, WindowsRpcClient, WindowsTransportError, type WindowsNetworkDecision, type WindowsProcessEvent, type WindowsStartParams } from "./windows-rpc.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function client(mode = "hold", options: Partial<ConstructorParameters<typeof WindowsRpcClient>[0]> = {}) {
  return new WindowsRpcClient({ executable: process.execPath, prefixArgs: [fileURLToPath(new URL("./fixtures/windows-exec-server.mjs", import.meta.url))],
    cwd: process.cwd(), env: { ...process.env, PI_FAKE_EXECUTOR_MODE: mode }, requestTimeoutMs: 2000, shutdownTimeoutMs: 300, networkRevision: () => 0, ...options });
}
function start(processId = "process"): WindowsStartParams {
  return { processId, argv: ["test"], cwd: "file:///C:/fixture", env: {}, sandbox: { windowsSandboxLevel: "mxc" }, pipeStdin: true, networkProxy: { policyDecisionTimeoutMs: 1000 } };
}

test("stdio startup configures concurrent dispatch and correlates fragmented out-of-order replies", { timeout: 5000 }, async () => {
  const rpc = client("fragment");
  try {
    await rpc.initialize();
    const slow = rpc.request<{ params: { name: string }; initialized: boolean; argv: string[] }>("echo", { name: "медленно", delay: 30 });
    const fast = rpc.request<{ params: { name: string } }>("echo", { name: "быстро" });
    assert.equal((await fast).params.name, "быстро");
    const response = await slow;
    assert.equal(response.params.name, "медленно"); assert.equal(response.initialized, true);
    assert.deepEqual(response.argv, ["--listen", "stdio", "--concurrent-requests", "4"]);
    assert.equal(rpc.healthy, true);
  } finally { await rpc.close(); }
});

test("workload output stays data and a normal nonzero exit is not a transport failure", async () => {
  const rpc = client("complete"); const events: WindowsProcessEvent[] = [];
  try {
    await rpc.initialize(); await rpc.startProcess(start(), (event) => events.push(event)); await rpc.waitClosed("process");
    assert.equal(events[0]?.chunk?.toString(), '{"id":999,"result":"only workload output"}\n');
    assert.equal(events[1]?.exitCode, 7); assert.equal(events[2]?.method, "process/closed"); assert.equal(rpc.healthy, true);
    await assert.rejects(rpc.request("error", {}), (error) => error instanceof WindowsResponseError && error.code === -32602);
    assert.equal(rpc.healthy, true);
  } finally { await rpc.close(); }
});

test("stdin is bounded byte delivery with write IDs and an empty chunk does not close it", async () => {
  const rpc = client();
  try {
    await rpc.initialize(); await rpc.startProcess(start(), () => {});
    await rpc.writeProcess("process", Buffer.alloc(65537, 65)); await rpc.writeProcess("process", Buffer.alloc(0));
    const read = await rpc.readProcess<{ chunks: { chunk: string; writeId: string }[]; closed: boolean }>("process");
    assert.deepEqual(read.chunks.map((item) => Buffer.from(item.chunk, "base64").length), [32768, 32768, 1, 0]);
    assert.equal(new Set(read.chunks.map((item) => item.writeId)).size, 4); assert.equal(read.closed, false);
  } finally { await rpc.close(); }
});

test("fake pinned callback activation requires a nonzero server policy timeout", async () => {
  let calls = 0;
  const rpc = client("reverse-start", { decideNetwork: async () => { calls++; return { allow: true, revision: 0 }; } });
  try {
    await rpc.initialize(); const params = start(); delete params.networkProxy;
    await rpc.startProcess(params, () => {}); assert.equal(calls, 0);
    await assert.rejects(rpc.startProcess({ ...start("zero"), networkProxy: { policyDecisionTimeoutMs: 0 } }, () => {}), WindowsResponseError);
    assert.equal(rpc.healthy, true);
  } finally { await rpc.close(); }
});

test("reverse review progresses while process/start is pending", async () => {
  const proposed = deferred<WindowsNetworkDecision>(); const seen = deferred<void>();
  const rpc = client("reverse-start", { decideNetwork: async (request) => { assert.equal(request.request.host, "test.example"); seen.resolve(); return proposed.promise; } });
  try {
    await rpc.initialize(); const starting = rpc.startProcess(start(), () => {});
    await seen.promise; proposed.resolve({ allow: true, revision: 0 }); await starting;
    const response = await rpc.request<{ trace: { policy?: string }[] }>("echo", {});
    assert.deepEqual(response.trace, [{ policy: "allow" }]);
  } finally { await rpc.close(); }
});

test("stalled stdin does not block reverse replies or process termination", async () => {
  const seen = deferred<void>(); const rpc = client("blocked-write", { decideNetwork: async () => { seen.resolve(); return { allow: true, revision: 0 }; } });
  try {
    await rpc.initialize(); await rpc.startProcess(start(), () => {});
    const write = rpc.writeProcess("process", Buffer.from("blocked")); const rejected = assert.rejects(write, /stdinClosed/);
    await seen.promise;
    const trace = await rpc.request<{ trace: { policy?: string }[] }>("echo", {});
    assert.equal(trace.trace[0]?.policy, "allow");
    await rpc.terminateProcess("process"); await rpc.waitClosed("process"); await rejected;
    assert.equal(rpc.healthy, true);
  } finally { await rpc.close(); }
});

test("expired reverse decisions abort review and cannot publish a late allow", async () => {
  const answer = deferred<WindowsNetworkDecision>(); let signal: AbortSignal | undefined;
  const rpc = client("reverse-start", { policyTimeoutMs: 30, decideNetwork: async (_request, abort) => { signal = abort; return answer.promise; } });
  try {
    await rpc.initialize(); await rpc.startProcess(start(), () => {});
    assert.equal(signal?.aborted, true); answer.resolve({ allow: true, revision: 0 }); await immediate();
    const trace = await rpc.request<{ trace: { policy?: string }[] }>("echo", {});
    assert.deepEqual(trace.trace, [{ policy: "deny" }]);
  } finally { await rpc.close(); }
});

test("revocation before a backpressured reverse response reaches the wire changes allow to deny", async () => {
  const seen = deferred<void>(); const answer = deferred<WindowsNetworkDecision>(); let revision = 0;
  const rpc = client("paused-policy", { networkRevision: () => revision, decideNetwork: async () => { seen.resolve(); return answer.promise; } });
  try {
    await rpc.initialize(); await rpc.startProcess(start(), () => {}); await seen.promise;
    const flooding = rpc.request("echo", { blob: "x".repeat(1024 * 1024) });
    answer.resolve({ allow: true, revision: 0 }); await immediate(); revision++;
    await flooding;
    const trace = await rpc.request<{ trace: { policy?: string }[] }>("echo", {});
    assert.deepEqual(trace.trace, [{ policy: "deny" }]);
  } finally { await rpc.close(); }
});

test("missing review UI denies and retiring a starting process cannot install late approval", async () => {
  const rpc = client("reverse-start");
  try {
    await rpc.initialize(); await rpc.startProcess(start(), () => {});
    const trace = await rpc.request<{ trace: { policy?: string }[] }>("echo", {});
    assert.deepEqual(trace.trace, [{ policy: "deny" }]);
  } finally { await rpc.close(); }
  const answer = deferred<WindowsNetworkDecision>(); const seen = deferred<void>();
  const retired = client("reverse-start", { decideNetwork: async () => { seen.resolve(); return answer.promise; } });
  try {
    await retired.initialize(); const starting = retired.startProcess(start(), () => {});
    await seen.promise; await retired.terminateProcess("process"); await retired.waitClosed("process");
    answer.resolve({ allow: true, revision: 0 }); await starting;
    const trace = await retired.request<{ trace: { policy?: string }[] }>("echo", {});
    assert.equal(trace.trace.some((entry) => entry.policy === "allow"), false);
  } finally { await retired.close(); }
});

test("canceled request IDs ignore late replies without affecting other requests", async () => {
  const rpc = client();
  try {
    await rpc.initialize(); const abort = new AbortController();
    const canceled = rpc.request("echo", { delay: 30 }, abort.signal); abort.abort(new Error("canceled"));
    await assert.rejects(canceled, /canceled/); await delay(50);
    assert.equal((await rpc.request<{ initialized: boolean }>("echo", {})).initialized, true); assert.equal(rpc.healthy, true);
  } finally { await rpc.close(); }
});

test("invalid frames, orphaning errors and server crashes reject in-flight work without replay", async () => {
  for (const method of ["malformed", "bad-error", "oversized", "crash"]) {
    const rpc = client();
    try {
      await rpc.initialize(); const pending = rpc.request("echo", { delay: 1000 });
      const failed = assert.rejects(pending, WindowsTransportError);
      await assert.rejects(rpc.request(method, {}), WindowsTransportError); await failed; assert.equal(rpc.healthy, false);
    } finally { await rpc.close(); }
  }
});

test("revocation during pending approval rejects an old verdict but a newly approved revision can allow", async () => {
  const answer = deferred<WindowsNetworkDecision>(); const seen = deferred<void>(); let revision = 0;
  const rpc = client("reverse-start", { networkRevision: () => revision, decideNetwork: async () => { seen.resolve(); return answer.promise; } });
  try {
    await rpc.initialize(); const starting = rpc.startProcess(start(), () => {});
    await seen.promise; revision++; answer.resolve({ allow: true, revision: 0 }); await starting;
    assert.deepEqual((await rpc.request<{ trace: unknown[] }>("echo", {})).trace, [{ policy: "deny" }]);
  } finally { await rpc.close(); }
  const fresh = client("reverse-start", { networkRevision: () => revision, decideNetwork: async () => ({ allow: true, revision: ++revision }) });
  try {
    await fresh.initialize(); await fresh.startProcess(start(), () => {});
    assert.deepEqual((await fresh.request<{ trace: unknown[] }>("echo", {})).trace, [{ policy: "allow" }]);
  } finally { await fresh.close(); }
});

test("expired callbacks keep their capacity slots until their execution settles", async () => {
  let calls = 0; const unresolved = deferred<WindowsNetworkDecision>();
  const rpc = client("hold", { policyTimeoutMs: 5, decideNetwork: async () => { calls++; return unresolved.promise; } });
  try {
    await rpc.initialize(); await rpc.startProcess(start(), () => {});
    for (let i = 0; i < 40; i++) await rpc.request("review-again", { processId: "process" });
    assert.equal(calls, 32); assert.equal(rpc.healthy, true);
    const trace = await rpc.request<{ trace: { policy?: string }[] }>("echo", {});
    assert.equal(trace.trace.length, 40); assert.ok(trace.trace.every((entry) => entry.policy === "deny"));
    unresolved.resolve({ allow: true, revision: 0 }); await immediate();
    assert.equal((await rpc.request<{ trace: unknown[] }>("echo", {})).trace.length, 40);
  } finally { await rpc.close(); }
});

test("null confinement confirmation retires the backend instead of forgetting an unknown process", async () => {
  const rpc = client("null-sandbox");
  try {
    await rpc.initialize(); await assert.rejects(rpc.startProcess(start(), () => {}), /confinement/);
    assert.equal(rpc.healthy, false); await assert.rejects(rpc.waitClosed("process"), WindowsTransportError);
    await assert.rejects(rpc.request("echo", {}), WindowsTransportError);
  } finally { await rpc.close(); }
});

test("EOF, incorrect sandbox identity and request deadlines fail the backend", async () => {
  const eof = client("early-eof");
  try { await assert.rejects(eof.initialize(), WindowsTransportError); } finally { await eof.close(); }
  const wrong = client("bad-sandbox");
  try { await wrong.initialize(); await assert.rejects(wrong.startProcess(start(), () => {}), /confinement/); assert.equal(wrong.healthy, false); }
  finally { await wrong.close(); }
  const deadline = client("hold", { requestTimeoutMs: 1000 });
  try { await deadline.initialize(); await assert.rejects(deadline.request("never", {}), /deadline/); assert.equal(deadline.healthy, false); }
  finally { await deadline.close(); }
});

test("per-call preparation deadlines do not shorten the live client deadline", async () => {
  const rpc = client();
  try {
    await rpc.initialize(); await assert.rejects(rpc.request("echo", {}, undefined, 0), /Invalid executor request deadline/);
    assert.equal(rpc.healthy, true);
    await assert.rejects(rpc.request("echo", { delay: 80 }, undefined, 20), /deadline/); assert.equal(rpc.healthy, false);
  } finally { await rpc.close(); }
});

test("stderr and pending work are bounded and shutdown is idempotent", async () => {
  const rpc = client();
  try {
    await rpc.initialize(); await rpc.request("diagnostic", {});
    assert.ok(rpc.stderr.length > 0 && rpc.stderr.length <= 32768);
    const pending = Array.from({ length: 64 }, () => rpc.request("never", {}).catch((error: Error) => error));
    await assert.rejects(rpc.request("echo", {}), /capacity/);
    const closing = rpc.close(); assert.equal(rpc.close(), closing); await closing;
    assert.ok((await Promise.all(pending)).every((error) => error instanceof WindowsTransportError));
  } finally { await rpc.close(); }
});

test("shutdown that cannot drain is bounded and rejects rather than claiming completion", async () => {
  const rpc = client("refuse-terminate", { shutdownTimeoutMs: 50 });
  await rpc.initialize(); await rpc.startProcess(start(), () => {});
  await assert.rejects(rpc.close(), /did not drain/); assert.equal(rpc.healthy, false);
});
