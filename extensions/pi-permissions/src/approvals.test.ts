import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionOwner, type ApprovalAnswer, type ApprovalRequest } from "./approvals.ts";
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
      assert.equal(request.agentWait, true);
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
        assert.equal(request.agentWait, false);
        return request.kind === "directory" || allowException ? { lifetime: "session" } : undefined;
      };
      const pending = f.owner.requestDirectory(target, "write", "create protected directory", undefined, false);
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

test("blocking a future ask during directory creation does not create it or publish a grant/receipt", async () => {
  const f = fixture(true);
  try {
    const target = path.join(f.outside, "new");
    f.owner.ask = async (request) => {
      if (request.kind === "directory") return { lifetime: "session" };
      assert.equal(request.kind, "exception"); assert.equal(request.scope, "tree");
      return { action: "block" };
    };
    await assert.rejects(f.owner.requestDirectory(target, "write", "create protected directory"), /blocked/);
    assert.equal(existsSync(target), false);
    assert.equal(f.owner.sessionBlocks[0]!.scope, "tree");
    assert.equal(f.owner.snapshot().grants.length, 0);
    assert.equal(f.owner.snapshot().exceptions.length, 0);
  } finally { f.close(); }
});

test("manual authorize and run propagate input intent to exception and directory requests without saving it", async () => {
  const f = fixture(true);
  try {
    const target = path.join(f.outside, "new"); mkdirSync(target);
    const requests: ApprovalRequest[] = [];
    f.owner.ask = async (request) => { requests.push(request); return { lifetime: "project" }; };
    await f.owner.authorize([target], "write", "manual exception", undefined, false);
    assert.equal(await f.owner.run([f.outside], "read", "manual cwd", undefined, async () => "executed", false), "executed");
    assert.deepEqual(requests.map((request) => [request.kind, request.agentWait]), [["exception", false], ["directory", false]]);
    assert.ok(requests.every(Object.isFrozen));
    const snapshot = f.owner.snapshot();
    assert.equal(snapshot.exceptions.length, 1);
    assert.equal(snapshot.grants.length, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /agentWait|input-dialog/);
  } finally { f.close(); }
});

test("mixed-origin filesystem joins reuse immutable first-opening metadata without promoting manual waits", async () => {
  for (const firstManual of [true, false]) {
    const f = fixture();
    try {
      let answer!: (value: ApprovalAnswer) => void;
      const requests: ApprovalRequest[] = [];
      f.owner.ask = (request) => {
        requests.push(request);
        return new Promise((resolve) => { answer = resolve; });
      };
      const first = f.owner.requestDirectory(f.outside, "read", "first opening", undefined, !firstManual);
      const joining = f.owner.requestGrant(f.outside, "read", "late join", undefined, firstManual);
      assert.equal(requests.length, 1);
      assert.ok(Object.isFrozen(requests[0]));
      assert.equal(requests[0]!.agentWait, !firstManual);
      assert.equal(requests[0]!.reason, "first opening");
      answer({ lifetime: "session" });
      await Promise.all([first, joining]);
      assert.equal(requests.length, 1);
      assert.equal(f.owner.snapshot().grants.length, 1);
      assert.doesNotMatch(JSON.stringify(f.owner.snapshot()), /agentWait|input-dialog/);
    } finally { f.close(); }
  }
});

test("cancelling a queued approval skips its dialog without releasing the active one", async () => {
  const f = fixture();
  try {
    const cancelled = path.join(f.dir, "cancelled"); const next = path.join(f.dir, "next");
    mkdirSync(cancelled); mkdirSync(next);
    let answer!: (value: ApprovalAnswer) => void;
    const requests: string[] = [];
    f.owner.ask = (request) => {
      requests.push(request.path);
      return request.path === f.outside ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({ lifetime: "session" });
    };
    const first = f.owner.requestDirectory(f.outside, "read", "active");
    const controller = new AbortController();
    const second = f.owner.requestDirectory(cancelled, "read", "cancelled", controller.signal);
    const rejected = assert.rejects(second, /abort/i);
    const third = f.owner.requestDirectory(next, "read", "next");
    assert.deepEqual(requests, [f.outside]);
    controller.abort();
    await rejected;
    assert.deepEqual(requests, [f.outside]);
    answer({ lifetime: "session" });
    await Promise.all([first, third]);
    assert.deepEqual(requests, [f.outside, next]);
    assert.equal(f.owner.snapshot().grants.length, 2);
  } finally { f.close(); }
});

test("queued approvals keep their original path identity before opening a dialog", async () => {
  const f = fixture();
  try {
    const queued = path.join(f.dir, "queued"); mkdirSync(queued);
    let answer!: (value: ApprovalAnswer) => void; let asked = 0;
    f.owner.ask = () => { asked++; return new Promise((resolve) => { answer = resolve; }); };
    const first = f.owner.requestDirectory(f.outside, "read", "active");
    const second = assert.rejects(f.owner.requestDirectory(queued, "read", "queued"), /identity changed/);
    renameSync(queued, `${queued}-old`); mkdirSync(queued);
    answer({ lifetime: "session" });
    await Promise.all([first, second]);
    assert.equal(asked, 1);
  } finally { f.close(); }
});

test("nested creation exceptions can reuse a sibling's queued approval without deadlocking", async () => {
  const f = fixture(true);
  try {
    const target = path.join(f.outside, "new");
    let answer!: (value: ApprovalAnswer) => void;
    const requests: ApprovalRequest[] = [];
    f.owner.ask = (request) => {
      requests.push(request);
      return request.kind === "directory" && request.path === target ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({ lifetime: "session" });
    };
    const first = f.owner.requestDirectory(target, "write", "create");
    const sibling = assert.rejects(f.owner.authorize([target], "write", "sibling exception"), /Target changed/);
    assert.equal(requests.length, 1);
    answer({ lifetime: "session" });
    await Promise.all([first, sibling]);
    assert.deepEqual(requests.filter((request) => request.kind === "exception").map((request) => request.reason), ["sibling exception"]);
    assert.equal(existsSync(target), true);
    assert.equal(f.owner.snapshot().exceptions.length, 1);
    assert.ok(f.owner.snapshot().grants.some((grant) => grant.binding.canonical === target));
  } finally { f.close(); }
});

test("owner retirement cancels both active and queued approvals without opening another dialog", async () => {
  const f = fixture();
  try {
    let asked = 0;
    f.owner.ask = (_request, signal) => {
      asked++;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    };
    const first = f.owner.requestDirectory(f.outside, "read", "active");
    const second = f.owner.requestDirectory(f.project, "read", "queued");
    const rejected = [assert.rejects(first, /abort/i), assert.rejects(second, /abort/i)];
    assert.equal(asked, 1);
    f.owner.block("shutdown");
    await Promise.all([...rejected, f.owner.drain()]);
    assert.equal(asked, 1);
  } finally { f.close(); }
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
