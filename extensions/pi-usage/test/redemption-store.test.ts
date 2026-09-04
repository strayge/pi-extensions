import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PendingRedemptionStore } from "../src/redemption-store.ts";

const accountKey = "a".repeat(64);
const requestId = "123e4567-e89b-42d3-a456-426614174000";

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-usage-redemption-")), "state.json");
}

test("pending reset redemptions survive reloads until a definitive response", () => {
  const path = statePath();
  const first = new PendingRedemptionStore(path);
  first.getOrCreate(accountKey, requestId);

  const reloaded = new PendingRedemptionStore(path);
  assert.equal(reloaded.get(accountKey), requestId);
  reloaded.delete(accountKey, requestId);

  assert.equal(new PendingRedemptionStore(path).get(accountKey), undefined);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, pending: [] });
});

test("stale store instances converge on one idempotency key without overwriting peers", () => {
  const path = statePath();
  const first = new PendingRedemptionStore(path);
  const second = new PendingRedemptionStore(path);
  const secondAccount = "b".repeat(64);
  const secondRequest = "223e4567-e89b-42d3-a456-426614174000";

  assert.equal(first.getOrCreate(accountKey, requestId), requestId);
  assert.equal(second.getOrCreate(accountKey, secondRequest), requestId);
  assert.equal(second.getOrCreate(secondAccount, secondRequest), secondRequest);
  first.delete(accountKey, requestId);

  const reloaded = new PendingRedemptionStore(path);
  assert.equal(reloaded.get(accountKey), undefined);
  assert.equal(reloaded.get(secondAccount), secondRequest);
});

test("a stale completion cannot delete a newer redemption for the same account", () => {
  const path = statePath();
  const delayed = new PendingRedemptionStore(path);
  const current = new PendingRedemptionStore(path);
  const newerRequest = "223e4567-e89b-42d3-a456-426614174000";

  delayed.getOrCreate(accountKey, requestId);
  current.delete(accountKey, requestId);
  current.getOrCreate(accountKey, newerRequest);
  delayed.delete(accountKey, requestId);

  assert.equal(new PendingRedemptionStore(path).get(accountKey), newerRequest);
});

test("invalid redemption state fails closed instead of losing an idempotency key", () => {
  const path = statePath();
  writeFileSync(path, JSON.stringify({ version: 1, pending: [{ accountKey, requestId: "bad" }] }));

  const store = new PendingRedemptionStore(path);
  assert.equal(store.available, false);
  assert.match(store.loadError ?? "", /invalid pending request/);
  assert.equal(store.get(accountKey), undefined);
  assert.throws(() => store.getOrCreate(accountKey, requestId), /cannot be used/);
});
