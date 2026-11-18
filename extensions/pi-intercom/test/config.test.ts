import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("obsolete receiver policies fail even at their former defaults", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const defaults = loadConfig();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.confirmSend, false);
  assert.equal("inboundTrigger" in defaults, false);
  assert.equal("busyDelivery" in defaults, false);
  mkdirSync(join(dir, "intercom"));
  const path = join(dir, "intercom", "config.json");
  for (const [key, values] of [
    ["inboundTrigger", ["always", "replies", "never", null]],
    ["busyDelivery", ["steer", "human-first", null]],
  ] as const) {
    for (const value of values) {
      writeFileSync(path, JSON.stringify({ [key]: value }));
      assert.throws(() => loadConfig(), new RegExp(`"${key}".*per-send quiet`));
    }
  }
  writeFileSync(path, JSON.stringify({ enabled: false, confirmSend: true, replyHint: false }));
  const custom = loadConfig();
  assert.equal(custom.enabled, false);
  assert.equal(custom.confirmSend, true);
  assert.equal(custom.replyHint, false);
});
