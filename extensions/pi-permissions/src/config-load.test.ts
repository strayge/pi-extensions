import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, loadConfig, mergeConfig, parseConfig, readConfig } from "./config-load.ts";
import { bindPath } from "./paths.ts";

test("strict v3 overrides reject duplicate rules and invalid shapes and normalize domains idempotently", () => {
  const base = defaultConfig();
  assert.throws(() => mergeConfig(base, { version: 3, $schema: 1 }), /schema/);
  assert.throws(() => mergeConfig(base, { version: 3, network: null }), /object/);
  assert.throws(() => mergeConfig(base, { version: 3, pathRules: [base.pathRules[0], base.pathRules[0]] }), /Duplicate/);
  assert.throws(() => mergeConfig(base, { version: 3, modes: { project: { filesystem: { kind: "scoped", readOnly: ["a\0b"], readWrite: [], resourceReads: [] } } } }), /nonempty/);
  const normalized = mergeConfig(base, { version: 3, network: { allowedDomains: ["EXAMPLE.COM", "example.com"], deniedDomains: ["Blocked.EXAMPLE"] } });
  assert.deepEqual(normalized.network.allowedDomains, ["example.com"]);
  assert.deepEqual(normalized.network.deniedDomains, ["blocked.example"]);
  assert.deepEqual(parseConfig(normalized), normalized);
  const schema = JSON.parse(readFileSync(new URL("../schemas/permissions.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.pathRules.uniqueItems, true);
  assert.equal(schema.properties.$schema.type, "string");
  assert.ok(!new RegExp(schema.$defs.paths.items.pattern).test("a\0b"));
});

test("macOS defaults include writable var/folders without overriding explicit filesystem scopes", () => {
  const config = defaultConfig();
  for (const name of ["project", "subproject"]) {
    const filesystem = config.modes[name]!.filesystem;
    assert.equal(filesystem.kind, "scoped");
    if (filesystem.kind !== "scoped") assert.fail("Expected a scoped default profile");
    assert.ok(filesystem.readWrite.includes("/tmp"));
    assert.equal(filesystem.readWrite.includes("/var/folders"), process.platform === "darwin");
  }
  assert.deepEqual(config.modes.yolo!.filesystem, { kind: "unrestricted" });
  const scoped = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  const explicit = mergeConfig(config, { version: 3, modes: { project: { filesystem: scoped } } });
  assert.deepEqual(explicit.modes.project!.filesystem, scoped);
});

test("process mode defaults to compatible, accepts strict, and preserves legacy configuration shapes", () => {
  const config = defaultConfig();
  assert.equal(config.processMode, "compatible");
  assert.equal(mergeConfig(config, { version: 3, processMode: "strict" }).processMode, "strict");
  for (const processMode of [null, "relaxed", false])
    assert.throws(() => mergeConfig(config, { version: 3, processMode }), /processMode/);
  const legacy = { ...config }; delete legacy.processMode;
  assert.deepEqual(parseConfig(legacy), legacy);
  const schema = JSON.parse(readFileSync(new URL("../schemas/permissions.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.processMode.enum, ["compatible", "strict"]);
  assert.equal(schema.properties.processMode.default, "compatible");
});

test("networking defaults to open without overriding explicit restrictions", () => {
  const config = defaultConfig();
  assert.equal(config.network.default, "open");
  assert.equal(mergeConfig(config, { version: 3, network: { default: "restricted" } }).network.default, "restricted");
});

test("v3 allow/ask/deny syntax agrees with the schema and repository policy is never read", () => {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-user-only-"))).canonical;
  try {
    const agentDir = path.join(dir, "agent");
    mkdirSync(agentDir); mkdirSync(path.join(agentDir, "permissions")); mkdirSync(path.join(dir, ".pi"));
    writeFileSync(path.join(dir, ".pi", "permission-mode.json"), "malformed and expansive repository input");
    const raw = { version: 3, pathRules: [{ path: "~/notes", scope: "file", read: "allow", write: "ask" }] };
    writeFileSync(path.join(agentDir, "permissions", "config.json"), JSON.stringify(raw));
    assert.deepEqual(loadConfig(agentDir, dir).global.pathRules, raw.pathRules);
    assert.equal(loadConfig(agentDir, dir).global.version, 3);
    assert.throws(() => mergeConfig(defaultConfig(), { ...raw, version: 2 }), /only version 3/);
    for (const action of ["allow", "ask", "deny"]) {
      for (const operation of ["read", "write"])
        assert.throws(() => mergeConfig(defaultConfig(), { version: 3, pathRules: [{ path: "~/notes", scope: "file", [operation]: [action] }] }), /must be allow, ask, or deny/);
    }
    const schema = JSON.parse(readFileSync(new URL("../schemas/permissions.schema.json", import.meta.url), "utf8"));
    assert.equal(schema.properties.version.const, 3);
    assert.deepEqual(schema.properties.pathRules.items.properties.read.enum, ["allow", "ask", "deny"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only genuinely absent configuration is absent; symlinks and special files fail closed", () => {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-config-"))).canonical;
  try {
    assert.equal(readConfig(path.join(dir, "missing.json")), undefined);
    const file = path.join(dir, "config.json"); writeFileSync(file, "{}");
    assert.deepEqual(readConfig(file), {});
    symlinkSync("config.json", path.join(dir, "alias"));
    symlinkSync("missing.json", path.join(dir, "dangling"));
    mkdirSync(path.join(dir, "directory"));
    assert.throws(() => readConfig(path.join(dir, "alias")), /symlink/);
    assert.throws(() => readConfig(path.join(dir, "dangling")), /Dangling/);
    assert.throws(() => readConfig(path.join(dir, "directory")), /regular file/);
    writeFileSync(file, "invalid json"); assert.throws(() => readConfig(file), SyntaxError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
