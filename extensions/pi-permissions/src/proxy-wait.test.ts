import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import net from "node:net";
import test from "node:test";
import { withProxyReady } from "./proxy-wait.ts";

/** Run a wrapped script through bash, as the sandbox runtime does. */
function runScript(
  command: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", withProxyReady(command)],
      { env: { PATH: process.env.PATH ?? "", ...env } },
      (err, stdout) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
        resolve({ code, stdout: stdout.trim(), ms: Date.now() - started });
      },
    );
  });
}

/** A listener that counts the connections the wait snippet makes to it. */
async function countingServer(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.end();
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
  return {
    port,
    connections: () => connections,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A port nothing is listening on yet, plus a `listen` that opens it later. */
async function reservedPort(): Promise<{ port: number; listen: (afterMs: number) => void }> {
  const probe = net.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve((probe.address() as net.AddressInfo).port));
  });
  await new Promise((resolve) => probe.close(resolve));
  return {
    port,
    listen: (afterMs: number) => {
      const server = net.createServer((socket) => socket.end());
      const timer = setTimeout(() => server.listen(port, "127.0.0.1"), afterMs);
      timer.unref();
      server.unref();
    },
  };
}

/**
 * Whether this host refuses connections to a closed loopback port. WSL2's
 * localhost forwarding accepts them instead, which makes any test that
 * simulates "the listener isn't up yet" vacuous there.
 */
async function refusesClosedPorts(): Promise<boolean> {
  const { port } = await reservedPort();
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

test("runs the command without waiting when no proxy env is set", async () => {
  const { code, stdout, ms } = await runScript("echo hi");
  assert.equal(stdout, "hi");
  assert.equal(code, 0);
  assert.ok(ms < 1000, `expected no wait, took ${ms}ms`);
});

// A port the snippet fails to recognize — through quoting damage or a parsing
// slip — fails open: the wait silently becomes a no-op that no assertion about
// the command's own output would catch.
test("probes the port named by HTTP_PROXY", async () => {
  const server = await countingServer();
  try {
    const { stdout } = await runScript("echo hi", { HTTP_PROXY: `http://localhost:${server.port}` });
    assert.equal(stdout, "hi");
    assert.ok(server.connections() > 0, "expected the wait to connect to the HTTP_PROXY port");
  } finally {
    await server.close();
  }
});

test("probes the port named by ALL_PROXY", async () => {
  const server = await countingServer();
  try {
    await runScript("echo hi", { ALL_PROXY: `socks5h://localhost:${server.port}` });
    assert.ok(server.connections() > 0, "expected the wait to connect to the ALL_PROXY port");
  } finally {
    await server.close();
  }
});

test("ignores proxy values with no usable port", async () => {
  const server = await countingServer();
  try {
    const { stdout, ms } = await runScript("echo hi", { HTTP_PROXY: "not-a-url", ALL_PROXY: "" });
    assert.equal(stdout, "hi");
    assert.equal(server.connections(), 0);
    assert.ok(ms < 1000, `expected no wait, took ${ms}ms`);
  } finally {
    await server.close();
  }
});

test("waits for a proxy port that only binds after the command is launched", async (t) => {
  if (!(await refusesClosedPorts())) {
    t.skip("host accepts connections to closed ports (WSL2 localhost forwarding)");
    return;
  }
  const { port, listen } = await reservedPort();
  listen(60);
  const probe = `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo READY || echo REFUSED`;
  const { stdout } = await runScript(probe, { HTTP_PROXY: `http://localhost:${port}` });
  assert.equal(stdout, "READY");
});

test("gives up and runs the command anyway when the port never opens", async (t) => {
  if (!(await refusesClosedPorts())) {
    t.skip("host accepts connections to closed ports (WSL2 localhost forwarding)");
    return;
  }
  const { port } = await reservedPort();
  const { stdout, ms } = await runScript("echo ran", { HTTP_PROXY: `http://localhost:${port}` });
  assert.equal(stdout, "ran");
  assert.ok(ms < 10_000, `expected a bounded wait, took ${ms}ms`);
});

test("preserves the command's exit status and leaves no variables behind", async () => {
  const server = await countingServer();
  try {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    const { code, stdout } = await runScript('echo "[${__pm_port:-unset}]"; exit 7', {
      HTTP_PROXY: `http://localhost:${server.port}`,
    });
    assert.equal(stdout, "[unset]");
    assert.equal(code, 7);
  } finally {
    await server.close();
  }
});
