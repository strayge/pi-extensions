import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { permissionAwareness } from "./awareness.ts";
import { defaultConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";
import { runtime } from "./sandbox.ts";
import type { PreparedWindowsExecutor } from "./windows-executor.ts";
import { WindowsRuntime } from "./windows-runtime.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "permission-awareness-")); const config = defaultConfig(); config.pathRules = [];
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] }; config.modes.subproject = config.modes.project!;
  const catalog = resolveCatalog(config, { family: randomUUID(), binding: bindPath(root) }, { agentDir: root, home: root });
  return { root, catalog, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("Windows inspection reports exact cached facilities without flooding per-turn awareness", { skip: process.platform !== "win32" }, (t) => {
  const f = fixture();
  try {
    const module = path.join(f.root, "facility.dll"); writeFileSync(module, "synthetic"); const directory = path.join(f.root, "helper-cwd"); mkdirSync(directory);
    const owner = new PermissionOwner(f.catalog, { ask: async () => undefined }); let invalid = false; const health = { healthy: true };
    const native = new WindowsRuntime({ client: health, environment: { executorVersion: "0.0.0" }, candidate: { source: "managed", executable: "canonical-executor.exe" }, assertIdentity() { if (invalid) throw new Error("executor changed"); } } as unknown as PreparedWindowsExecutor);
    native.bootstrapResources.set("shell", [{ binding: bindPath(module), scope: "file", access: "read", runtime: true }]);
    native.bootstrapResources.set("grep", [{ binding: bindPath(module), scope: "file", access: "read", runtime: true }, { binding: bindPath(directory), scope: "tree", access: "read", runtime: true }]);
    t.mock.method(runtime, "windowsRuntime", () => native);
    const concise = permissionAwareness(owner); assert.match(concise, /managed release 0\.166\.0; reported version 0\.0\.0; prepared/); assert.match(concise, /resources: 2/); assert.ok(!concise.includes(module));
    const inspection = permissionAwareness(owner, true); assert.ok(inspection.includes(`R/O ${module} (file; execution facility)`)); assert.ok(inspection.includes(`R/O ${directory} (tree; execution facility)`));
    assert.match(inspection, /case-equivalent pathnames/); assert.match(inspection, /nonrecursive/); assert.match(inspection, /not a security boundary/); assert.match(inspection, /host-loopback/); assert.match(inspection, /0xC0000142/); assert.doesNotMatch(inspection, /restricted descendant may prevent renaming/);
    invalid = true; assert.match(permissionAwareness(owner), /unhealthy: Error: executor changed; \/reload required/);
    invalid = false; health.healthy = false; assert.match(permissionAwareness(owner), /unhealthy; \/reload required/);
  } finally { f.close(); }
});

test("Windows process awareness describes native descendant retirement in both configured modes", { skip: process.platform !== "win32" }, () => {
  const f = fixture();
  try {
    for (const processMode of ["compatible", "strict"] as const) {
      const owner = new PermissionOwner({ ...f.catalog, config: { ...f.catalog.config, processMode } }, { ask: async () => undefined });
      assert.match(permissionAwareness(owner), /MXC retires descendants.*both modes/);
      owner.select("yolo"); assert.match(permissionAwareness(owner), /Fully open direct execution uses compatible/);
      owner.network.change({ restricted: true }); assert.match(permissionAwareness(owner), /MXC retires descendants.*both modes/);
    }
  } finally { f.close(); }
});

test("Windows root limitation warnings are interactive-only and deduplicated across inspection and reload", { skip: process.platform !== "win32" }, async () => {
  const f = fixture(); let interactive = false; const notices: string[] = [];
  try {
    const owner = new PermissionOwner(f.catalog, { ask: async () => undefined, warn: (message) => notices.push(message), interactive: () => interactive });
    owner.warnFilesystemLimitations(); assert.deepEqual(notices, []);
    assert.match(permissionAwareness(owner), /case-equivalent/); assert.deepEqual(notices, []);
    interactive = true; owner.warnFilesystemLimitations(); owner.warnFilesystemLimitations(); assert.equal(notices.length, 1);
    assert.match(notices[0]!, /case-equivalent/); assert.match(notices[0]!, /0xC0000142/);
    await owner.reload(f.catalog.config, undefined, { agentDir: f.root, home: f.root }); owner.warnFilesystemLimitations(); assert.equal(notices.length, 1);
    owner.select("yolo"); owner.network.change({ restricted: true }); owner.warnFilesystemLimitations(); assert.equal(notices.length, 2);
    assert.doesNotMatch(notices[1]!, /case-equivalent/); assert.match(notices[1]!, /0xC0000142/);
  } finally { f.close(); }
});
