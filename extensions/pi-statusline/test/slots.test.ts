import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotRegistry } from "../src/slots.ts";
import { busFor, createRegistry, publish, register } from "./helpers.ts";

test("a foreign publish and clear leave the parent's speed intact", () => {
  let changes = 0;
  const registry = createRegistry(() => changes++);
  publish(registry, { id: "speed", text: "54.8 tok/s" });
  const bus = busFor(registry);

  bus.emit("statusline:publish", { id: "speed", text: "159.6 tok/s", owner: "child-session" });
  assert.equal(registry.get("speed")?.text, "54.8 tok/s");
  bus.emit("statusline:clear", { id: "speed", owner: "child-session" });
  bus.emit("statusline:publish", { id: "child-only", text: "ignored", owner: "child-session" });
  assert.equal(registry.get("speed")?.text, "54.8 tok/s");
  assert.deepEqual(registry.known(), ["speed"]);
  assert.equal(changes, 1);
});

test("foreign registration and unregister preserve the parent's usage renderer", () => {
  let changes = 0;
  const registry = createRegistry(() => changes++);
  register(registry, { id: "usage", version: 1, fields: [], render: () => "parent usage" });
  const registration = registry.registration("usage");
  const bus = busFor(registry);

  bus.emit("statusline:register", {
    id: "usage",
    owner: "child-session",
    version: 1,
    fields: [],
    render: () => "child usage",
  });
  assert.equal(registry.registration("usage"), registration);
  bus.emit("statusline:unregister", { id: "usage", owner: "child-session" });
  bus.emit("statusline:register", { id: "child-only", fields: [], owner: "child-session" });
  assert.equal(registry.registration("usage"), registration);
  assert.deepEqual(registry.known(), ["usage"]);
  assert.deepEqual(registry.render("usage", {}, { preview: false }), {
    segments: [{ text: "parent usage" }],
  });
  assert.equal(changes, 1);
});

test("unstamped messages change neither slots, known ids, repaints nor render failures", () => {
  let changes = 0;
  const registry = createRegistry(() => changes++);
  publish(registry, { id: "speed", text: "54.8 tok/s" });
  register(registry, {
    id: "usage",
    version: 1,
    fields: [],
    render: () => {
      throw new Error("parent failure");
    },
  });
  registry.render("usage", {}, { preview: false });
  const registration = registry.registration("usage");
  const bus = busFor(registry);

  bus.emit("statusline:publish", { id: "unstamped-text", text: "ignored" });
  bus.emit("statusline:register", { id: "unstamped-schema", fields: [] });
  bus.emit("statusline:clear", { id: "speed" });
  bus.emit("statusline:register", { id: "usage", fields: [], render: () => "ignored" });
  bus.emit("statusline:unregister", { id: "usage" });
  bus.emit("statusline:register", { id: "usage", owner: "child-session", fields: [] });
  bus.emit("statusline:unregister", { id: "usage", owner: "child-session" });
  assert.equal(registry.get("speed")?.text, "54.8 tok/s");
  assert.equal(registry.registration("usage"), registration);
  assert.deepEqual(registry.known(), ["speed", "usage"]);
  assert.deepEqual(registry.takeRenderFailures(), [
    'slot "usage" failed to render: parent failure',
  ]);
  assert.equal(changes, 2);
});

test("traffic before an owner is set is dropped, not recovered just by setting it", () => {
  let changes = 0;
  const bus = busFor(createRegistry());
  const registry = new SlotRegistry({ events: bus } as never, () => changes++);
  registry.listen();
  bus.emit("statusline:publish", { id: "speed", text: "54.8 tok/s", owner: "test-session" });
  bus.emit("statusline:register", { id: "usage", fields: [], owner: "test-session" });
  registry.setOwner("test-session");
  assert.deepEqual(registry.all(), []);
  assert.deepEqual(registry.registered(), []);
  assert.deepEqual(registry.known(), []);
  assert.equal(changes, 0);

  bus.emit("statusline:publish", { id: "speed", text: "54.8 tok/s", owner: "test-session" });
  assert.equal(registry.get("speed")?.text, "54.8 tok/s");
  assert.equal(changes, 1);
});

test("requests and options carry the owner and stop when it is absent", () => {
  const registry = createRegistry();
  const bus = busFor(registry);
  const requested: unknown[] = [];
  const pushed: unknown[] = [];
  bus.on("statusline:request", (data) => requested.push(data));
  bus.on("statusline:options", (data) => pushed.push(data));

  registry.setOwner(undefined);
  registry.request();
  registry.pushOptions("usage", [{ width: 12 }]);
  assert.deepEqual(requested, []);
  assert.deepEqual(pushed, []);

  registry.setOwner("test-session");
  registry.request();
  registry.pushOptions("usage", [{ width: 12 }]);
  assert.deepEqual(requested, [{ owner: "test-session" }]);
  assert.deepEqual(pushed, [
    { id: "usage", owner: "test-session", version: 1, instances: [{ options: { width: 12 } }] },
  ]);

  registry.setOwner("");
  bus.emit("statusline:publish", { id: "empty-owner", owner: "", text: "ignored" });
  registry.request();
  registry.pushOptions("usage", []);
  assert.deepEqual(registry.known(), []);
  assert.equal(requested.length, 1);
  assert.equal(pushed.length, 1);
});
