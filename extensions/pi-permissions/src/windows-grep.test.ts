import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindPath } from "./paths.ts";
import { prepareWindowsExecutor, type PreparedWindowsExecutor } from "./windows-executor.ts";
import { createWindowsGrep } from "./windows-grep.ts";
import { WindowsRuntime } from "./windows-runtime.ts";

const bridge = fileURLToPath(new URL("./windows-grep-bridge.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/windows-grep-rg.mjs", import.meta.url));
function frame(bytes: Buffer): Buffer { const result = Buffer.alloc(4 + bytes.length); result.writeUInt32BE(bytes.length); bytes.copy(result, 4); return result; }
const end = Buffer.alloc(4, 255);

for (const [name, content, expected] of [
  ["empty", "", []], ["no matches", "ordinary\n", []], ["fewer than max count", "needle\nother\n", [1]], ["unterminated line", "other\nneedle", [2]],
] as const) {
  test(`bridge closes rg stdin from the terminal marker with ${name}, without transport EOF`, { timeout: 5000 }, async () => {
    const child = spawn(process.execPath, [bridge, process.execPath, JSON.stringify([fake])], { stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let errors = ""; child.stdout.on("data", (bytes) => { output += bytes; }); child.stderr.on("data", (bytes) => { errors += bytes; });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    try {
      const bytes = Buffer.concat([frame(Buffer.from(content)), end]);
      for (let offset = 0; offset < bytes.length; offset++) await new Promise<void>((resolve, reject) => child.stdin.write(bytes.subarray(offset, offset + 1), (error) => error ? reject(error) : resolve()));
      assert.equal(await closed, expected.length ? 0 : 1, errors);
      const events = output.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events[0].type, "pi-grep-ready"); assert.deepEqual(events.filter((event) => event.type === "match").map((event) => event.data.line_number), expected);
    } finally { child.kill(); child.stdin.destroy(); }
  });
}

test("bridge rejects oversized or incomplete framing rather than hanging rg", { timeout: 5000 }, async () => {
  for (const bytes of [Buffer.from([0, 1, 0, 0]), Buffer.from([0, 0])]) {
    const child = spawn(process.execPath, [bridge, process.execPath, JSON.stringify([fake])], { stdio: ["pipe", "ignore", "pipe"] }); let diagnostic = "";
    child.stderr.on("data", (bytes) => { diagnostic += bytes; });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(bytes); assert.equal(await closed, 2); assert.match(diagnostic, /exceeds|terminal marker/);
  }
});

test("native contained grep handles EOF, chunk boundaries, early rg completion and cancellation", { skip: process.platform !== "win32" || process.env.PI_NATIVE_WINDOWS_MXC !== "1", timeout: 180000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "native-grep-")); const project = path.join(root, "project"); mkdirSync(project); let prepared: PreparedWindowsExecutor | undefined;
  try {
    prepared = await prepareWindowsExecutor({ project: bindPath(project), agentDir: root }); const runtime = new WindowsRuntime(prepared);
    const grep = createWindowsGrep(runtime, bindPath(project));
    for (const [content, expected] of [["", []], ["no match\n", []], ["needle\n", [1]], ["first\nneedle", [2]], ["x".repeat(32766) + "\nneedle\n", [2]]] as const) {
      t.diagnostic(`Native EOF case: ${content.length} bytes`);
      assert.deepEqual(await grep(Buffer.from(content), "needle", { limit: 100 }, undefined, () => {}), expected);
    }
    t.diagnostic("Native early-completion case");
    assert.deepEqual(await grep(Buffer.from("alpha\nигла\n"), "игла", {}, undefined, () => {}), [2]);
    assert.deepEqual(await grep(Buffer.from('a"b[c]\\d\n'), 'a"b[c]\\d', { literal: true }, undefined, () => {}), [1]);
    assert.deepEqual(await grep(Buffer.from("NEEDLE\n"), "needle", { ignoreCase: true }, undefined, () => {}), [1]);
    assert.deepEqual(await grep(Buffer.from("needle\n".repeat(20000)), "needle", { limit: 1 }, undefined, () => {}), [1]);
    const input = path.join(project, "spaced Кириллица.txt"); writeFileSync(input, "one\nneedle\nthree\n"); let checks = 0;
    assert.deepEqual(await grep(input, "needle", {}, undefined, () => { checks++; }), [2]); assert.ok(checks >= 2);
    await assert.rejects(grep(Buffer.alloc(0), "[", {}, undefined, () => {}), /regex|ripgrep/i);
    const cancellation = new AbortController(); const running = grep(Buffer.alloc(1024 * 1024, 120), "needle", {}, cancellation.signal, () => {}); const rejected = assert.rejects(running, /aborted/i);
    await delay(5); cancellation.abort(); await rejected;
    assert.equal(prepared.client.healthy, true);
    writeFileSync(input, "x".repeat(1024 * 1024)); const fileCancellation = new AbortController(); let fileChecks = 0;
    await assert.rejects(grep(input, "needle", {}, fileCancellation.signal, () => { if (++fileChecks === 4) fileCancellation.abort(); }), /aborted/i);
    assert.equal(prepared.client.healthy, true);
    assert.deepEqual(await grep(Buffer.from("needle"), "needle", {}, undefined, () => {}), [1]);
    assert.ok([...runtime.bootstrapResources.values()].flat().every((resource) => resource.access === "read" && (resource.scope === "file" || resource.definition === "windows-grep:cwd")));
  } finally { await prepared?.close(); rmSync(root, { recursive: true, force: true }); }
});
