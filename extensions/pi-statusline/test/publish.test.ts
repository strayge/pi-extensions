import assert from "node:assert/strict";
import { test } from "node:test";
import { publishStatuslineItem, registerStatuslineSlot } from "../src/publish.ts";
import { busFor, createRegistry, fakeEnv } from "./helpers.ts";

test("own-session replay recovers text and registration dropped before session start", () => {
  const registry = createRegistry();
  registry.setOwner(undefined);
  const pi = { events: busFor(registry) } as never;
  const ctx = fakeEnv().ctx;
  const publish = publishStatuslineItem(pi, { id: "speed" });
  const slot = registerStatuslineSlot(pi, { id: "usage", version: 1, fields: [] });
  publish(ctx, "54.8 tok/s");
  slot.refresh(ctx);
  assert.deepEqual(registry.known(), []);

  registry.setOwner("test-session");
  registry.request();
  assert.equal(registry.get("speed")?.text, "54.8 tok/s");
  assert.ok(registry.registration("usage"));
});

test("the template stamps writes, deduplicates per owner and replays only matching requests", () => {
  const bus = busFor(createRegistry());
  const ctx = fakeEnv().ctx;
  const otherCtx = {
    sessionManager: { ...ctx.sessionManager, getSessionId: () => "other-session" },
  };
  const published: unknown[] = [];
  const cleared: unknown[] = [];
  bus.on("statusline:publish", (data) => published.push(data));
  bus.on("statusline:clear", (data) => cleared.push(data));
  const publish = publishStatuslineItem({ events: bus } as never, { id: "usage" });

  publish(ctx, "42%");
  publish(ctx, "42%");
  assert.deepEqual(published, [{ id: "usage", text: "42%", owner: "test-session" }]);
  publish(otherCtx, "42%");
  assert.deepEqual(published[1], { id: "usage", text: "42%", owner: "other-session" });
  bus.emit("statusline:request", { owner: "test-session" });
  bus.emit("statusline:request", {});
  assert.equal(published.length, 2);
  bus.emit("statusline:request", { owner: "other-session" });
  assert.deepEqual(published[2], published[1]);

  publish(otherCtx, undefined);
  publish(otherCtx, undefined);
  assert.deepEqual(cleared, [{ id: "usage", owner: "other-session" }]);
  bus.emit("statusline:request", { owner: "other-session" });
  assert.equal(published.length, 3);
  assert.equal(cleared.length, 1);
});

test("uninitialized template helpers neither announce nor answer requests and options", () => {
  const bus = busFor(createRegistry());
  const messages: unknown[] = [];
  for (const channel of [
    "statusline:publish",
    "statusline:clear",
    "statusline:register",
    "statusline:unregister",
  ]) {
    bus.on(channel, (data) => messages.push(data));
  }
  let optionCalls = 0;
  publishStatuslineItem({ events: bus } as never, { id: "usage" });
  const slot = registerStatuslineSlot({ events: bus } as never, {
    id: "usage",
    version: 1,
    fields: [],
    onOptions: () => {
      optionCalls++;
    },
  });
  bus.emit("statusline:request", {});
  bus.emit("statusline:request", { owner: "test-session" });
  bus.emit("statusline:options", { id: "usage", instances: [{ options: {} }] });
  slot.dispose();
  assert.equal(optionCalls, 0);
  assert.deepEqual(messages, []);
});

test("registration waits for refresh and follows its owner through replay and disposal", () => {
  const registry = createRegistry();
  const bus = busFor(registry);
  const ctx = fakeEnv().ctx;
  const registered: unknown[] = [];
  const unregistered: unknown[] = [];
  bus.on("statusline:register", (data) => registered.push(data));
  bus.on("statusline:unregister", (data) => unregistered.push(data));
  const definition = { id: "usage", version: 1, fields: [] };
  const slot = registerStatuslineSlot({ events: bus } as never, definition);
  assert.deepEqual(registered, []);

  slot.refresh(ctx);
  assert.deepEqual(registered, [{ ...definition, defaults: undefined, owner: "test-session" }]);
  bus.emit("statusline:request", { owner: "other-session" });
  bus.emit("statusline:request", {});
  assert.equal(registered.length, 1);
  registry.request();
  assert.deepEqual(registered[1], registered[0]);

  slot.refresh({ sessionManager: { ...ctx.sessionManager, getSessionId: () => "other-session" } });
  assert.deepEqual(registered[2], { ...definition, defaults: undefined, owner: "other-session" });
  slot.dispose();
  assert.deepEqual(unregistered, [{ id: "usage", owner: "other-session" }]);
  bus.emit("statusline:request", { owner: "other-session" });
  assert.equal(registered.length, 3);
});

test("read-only layout demand reaches only its owning producer without saving options", () => {
  const bus = busFor(createRegistry());
  const received: unknown[] = [];
  let saves = 0;
  const slot = registerStatuslineSlot({ events: bus } as never, {
    id: "usage",
    version: 1,
    fields: [],
    onInstances: (instances) => received.push(instances),
    onOptions: () => {
      saves++;
    },
  });
  const message = {
    id: "usage",
    owner: "test-session",
    instances: [{ options: { provider: "anthropic" } }],
  };
  bus.emit("statusline:instances", message);
  slot.refresh(fakeEnv().ctx);
  assert.deepEqual(received, [[]]);
  bus.emit("statusline:instances", { ...message, owner: "other-session" });
  bus.emit("statusline:instances", { ...message, id: "other-slot" });
  bus.emit("statusline:instances", message);
  bus.emit("statusline:instances", { ...message, instances: [] });
  assert.deepEqual(received, [[], [{ provider: "anthropic" }], []]);
  assert.equal(saves, 0);
  slot.dispose();
  bus.emit("statusline:instances", message);
  assert.equal(received.length, 3);
});

test("only own-session options reach the template producer and re-announce defaults", () => {
  const registry = createRegistry();
  const bus = busFor(registry);
  const registered: unknown[] = [];
  const received: unknown[] = [];
  let width = 8;
  bus.on("statusline:register", (data) => registered.push(data));
  const slot = registerStatuslineSlot({ events: bus } as never, {
    id: "usage",
    version: 1,
    fields: [{ key: "width", label: "width", kind: "number" }],
    defaults: () => ({ width }),
    onOptions: (options, instances) => {
      received.push({ options, instances });
      width = Number(options.width);
    },
  });
  slot.refresh(fakeEnv().ctx);
  const instances = [{ options: { width: 12 } }, { options: { width: 20 } }];
  bus.emit("statusline:options", { id: "usage", owner: "other-session", instances });
  bus.emit("statusline:options", { id: "usage", instances });
  assert.deepEqual(received, []);
  assert.equal(registered.length, 1);

  registry.pushOptions("usage", [{ width: 12 }, { width: 20 }]);
  assert.deepEqual(received, [
    { options: { width: 12 }, instances: [{ width: 12 }, { width: 20 }] },
  ]);
  assert.equal(registered.length, 2);
  assert.deepEqual(registry.registration("usage")?.defaults, { width: 12 });
  slot.dispose();
  registry.pushOptions("usage", [{ width: 24 }]);
  assert.equal(received.length, 1);
  assert.equal(registered.length, 2);
});
