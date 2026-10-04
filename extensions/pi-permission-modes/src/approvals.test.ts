import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionOwner, type ApprovalAnswer } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { createDirectTools } from "./direct-tools.ts";
import { bindPath } from "./paths.ts";
import { decide, resolveCatalog } from "./policy.ts";

function fixture(restrictCreation = false) {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-approval-"))).canonical;
  const project = path.join(dir, "project"); const outside = path.join(dir, "outside");
  mkdirSync(project); mkdirSync(outside);
  const config = defaultConfig();
  config.pathRules = restrictCreation ? [{ path: path.join(outside, "new"), scope: "tree", write: "ask" }] : [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  const root = { family: randomUUID(), binding: bindPath(project) };
  const owner = new PermissionOwner(resolveCatalog(config, root, { agentDir: dir, home: dir }), { ask: async () => undefined });
  return { dir, project, outside, owner, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("edited approval can create the first missing ancestor without granting unrelated directories", async () => {
  const f = fixture();
  try {
    const ancestor = path.join(f.outside, "first"); const target = path.join(ancestor, "deeper", "file");
    let asked = 0;
    f.owner.ask = async (request) => {
      asked++; assert.equal(request.path, path.dirname(target)); assert.equal(request.create, true);
      return { lifetime: "session", directory: ancestor, binding: bindPath(ancestor) };
    };
    const [, , write] = createDirectTools(() => f.owner, f.project);
    const ctx = { ...({ cwd: f.project } as ExtensionContext), tools: [], executeTool: async () => { throw new Error("Nested tools are not part of this fixture"); } };
    await write.execute("create", { path: target, content: "allowed" }, undefined, undefined, ctx);
    assert.equal(asked, 1); assert.equal(readFileSync(target, "utf8"), "allowed");
    assert.equal(f.owner.snapshot().grants[0]?.binding.canonical, ancestor);
    f.owner.ask = async () => undefined;
    await assert.rejects(f.owner.authorize([path.join(f.outside, "sibling")], "write", "not included"), /denied/);
  } finally { f.close(); }
});

test("missing R/O approvals and replaced pre-confirmation identities never create directories", async () => {
  const f = fixture();
  try {
    f.owner.ask = async () => ({ lifetime: "session" });
    const missing = path.join(f.outside, "missing");
    await assert.rejects(f.owner.requestDirectory(missing, "read", "read-only"), /R\/W/);
    assert.ok(!existsSync(missing));
    let answer!: (value: ApprovalAnswer) => void;
    f.owner.ask = () => new Promise((resolve) => { answer = resolve; });
    const pending = f.owner.requestDirectory(missing, "write", "create");
    const selected = bindPath(missing);
    renameSync(f.outside, `${f.outside}-old`); mkdirSync(f.outside);
    answer({ lifetime: "session", directory: missing, binding: selected });
    await assert.rejects(pending, /identity changed/);
    assert.ok(!existsSync(missing)); assert.equal(f.owner.snapshot().grants.length, 0);
  } finally { f.close(); }
});

test("creating an ungranted protected directory requires a separate exception before mutation", async () => {
  for (const allowException of [false, true]) {
    const f = fixture(true);
    try {
      const target = path.join(f.outside, "new"); const requests: string[] = [];
      f.owner.ask = async (request) => {
        requests.push(request.kind); assert.equal(existsSync(target), false);
        return request.kind === "directory" || allowException ? { lifetime: "session" } : undefined;
      };
      const pending = f.owner.requestDirectory(target, "write", "create protected directory");
      if (allowException) {
        await pending;
        assert.equal(decide(f.owner.snapshot(), bindPath(target), "write").action, "allow");
      } else {
        await assert.rejects(pending, /Access denied/);
        assert.equal(f.owner.snapshot().grants.length, 0);
        assert.equal(f.owner.snapshot().exceptions.length, 0);
      }
      assert.equal(existsSync(target), allowException);
      assert.deepEqual(requests, ["directory", "exception"]);
    } finally { f.close(); }
  }
});

test("owner retirement aborts active execution and drains its lease without cancelling ordinary mode switches", async () => {
  const f = fixture();
  try {
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    let effective!: AbortSignal;
    const running = f.owner.run([f.project], "read", "operation", undefined, async (_snapshot, _targets, signal) => {
      effective = signal; started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const rejected = assert.rejects(running, /aborted/i);
    await ready; f.owner.select("yolo"); assert.equal(effective.aborted, false);
    f.owner.block("shutdown"); assert.equal(effective.aborted, true);
    await Promise.all([rejected, f.owner.drain()]);
  } finally { f.close(); }
});
