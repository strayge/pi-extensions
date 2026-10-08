import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionOwner } from "./approvals.ts";
import { defaultConfig, parseConfig } from "./config-load.ts";
import { NetworkSession, type NetAskResult } from "./network.ts";
import { bindPath } from "./paths.ts";
import { resolveCatalog } from "./policy.ts";

function fixture() {
  const dir = bindPath(mkdtempSync(path.join(tmpdir(), "permission-net-state-"))).canonical;
  const config = defaultConfig(); config.pathRules = [];
  config.network.default = "restricted";
  config.modes.project!.filesystem = { kind: "scoped", readOnly: [], readWrite: ["."], resourceReads: [] };
  config.modes.subproject = config.modes.project!;
  const context = { agentDir: dir, home: dir };
  const root = { family: randomUUID(), binding: bindPath(dir) };
  const owner = new PermissionOwner(resolveCatalog(config, root, context), { ask: async () => undefined });
  return { owner, config, context, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("equivalent IPv4 spellings share configured, live, restored, and prompted network authority", async () => {
  const aliases = ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "127.0.0.1."];
  const config = defaultConfig(); config.network.allowedDomains = aliases.slice(0, -1);
  config.network.default = "restricted";
  config.network.deniedDomains = ["0x7f000001"];
  const parsed = parseConfig(config).network;
  assert.deepEqual(parsed.allowedDomains, ["127.0.0.1"]);
  assert.deepEqual(parsed.deniedDomains, ["127.0.0.1"]);
  const network = new NetworkSession(parsed, () => {});
  for (const alias of aliases) assert.equal(await network.decide(alias), false, alias);
  assert.throws(() => network.grant(["127.1"]), /denied/);
  const restored = new NetworkSession(parsed, () => {}, network.snapshot());
  assert.equal(await restored.decide("2130706433"), false);
  const open = new NetworkSession({ default: "restricted", allowedDomains: [], deniedDomains: [] }, () => {});
  let asked = 0;
  for (const alias of aliases) assert.equal(await open.decide(alias, undefined, async (host) => {
    asked++; assert.equal(host, "127.0.0.1"); return "allow-session";
  }), true);
  assert.equal(asked, 1);
  open.change({ deniedDomains: ["0177.0.0.1"] });
  for (const alias of aliases) assert.equal(await open.decide(alias), false);
});

test("late non-UI network answers cannot install authority after shutdown or failed reload", async () => {
  for (const retiring of ["shutdown", "reload"] as const) {
    const f = fixture();
    try {
      let answer!: (value: NetAskResult) => void;
      const pending = f.owner.network.decide("pending.example", undefined, () => new Promise((resolve) => { answer = resolve; }));
      if (retiring === "shutdown") f.owner.block("shutdown");
      else await assert.rejects(f.owner.reload({ ...f.config, modes: {} }, undefined, f.context), /removed/);
      answer("allow-session");
      assert.equal(await pending, false);
      assert.ok(!f.owner.network.snapshot().allowedDomains.includes("pending.example"));
      assert.throws(() => f.owner.network.grant(["later.example"]), /unavailable/);
      assert.equal(await f.owner.network.decide("github.com"), false);
    } finally { f.close(); }
  }
});

test("ordinary filesystem switches preserve pending network decisions; successful reload invalidates old answers", async () => {
  const f = fixture();
  try {
    let answer!: (value: NetAskResult) => void;
    const first = f.owner.network.decide("first.example", undefined, () => new Promise((resolve) => { answer = resolve; }));
    f.owner.select("yolo"); answer("allow-session"); assert.equal(await first, true);
    const second = f.owner.network.decide("second.example", undefined, () => new Promise((resolve) => { answer = resolve; }));
    await f.owner.reload(f.config, undefined, f.context);
    answer("allow-forever"); assert.equal(await second, false);
    assert.equal(await f.owner.network.decide("first.example"), true);
    assert.equal(await f.owner.network.decide("second.example"), false);
  } finally { f.close(); }
});

test("live deny, toggle, config changes and failed persistence never resurrect stale network grants", async () => {
  let fail = false;
  const policy = { default: "restricted" as const, allowedDomains: ["configured.example"], deniedDomains: [] as string[] };
  const network = new NetworkSession(policy, () => { if (fail) throw new Error("save failed"); });
  let answer!: (value: NetAskResult) => void;
  const pending = network.decide("pending.example", undefined, () => new Promise((resolve) => { answer = resolve; }));
  network.change({ deniedDomains: ["pending.example"] }); answer("allow-session");
  assert.equal(await pending, false);
  assert.throws(() => network.grant(["pending.example"]), /denied/);
  network.grant(["session.example"]);
  network.change({ restricted: false }); assert.equal(await network.decide("any.example"), true);
  network.change({ restricted: true }); assert.equal(await network.decide("any.example"), false);
  network.reconfigure({ default: "restricted", allowedDomains: ["new.example"], deniedDomains: ["blocked.example"] }, policy);
  assert.equal(await network.decide("configured.example"), false);
  assert.equal(await network.decide("new.example"), true);
  assert.equal(await network.decide("session.example"), true);
  fail = true; const before = network.snapshot();
  assert.throws(() => network.grant(["failed.example"]), /save failed/);
  assert.deepEqual(network.snapshot(), before);
});
