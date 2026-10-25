import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { SlotRegistry } from "../src/slots.ts";
import type { SlotOptions } from "../src/types.ts";

function fixture(getInstances?: (id: string) => SlotOptions[]) {
  const bus = new EventEmitter();
  const instances: unknown[] = [];
  const options: unknown[] = [];
  bus.on("statusline:instances", (data) => instances.push(data));
  bus.on("statusline:options", (data) => options.push(data));
  const registry = new SlotRegistry({ events: bus } as never, () => {}, getInstances);
  registry.listen();
  return { bus, registry, instances, options };
}

const registration = {
  id: "usage",
  owner: "test-session",
  version: 2,
  render: () => "usage",
  fields: [
    { key: "provider", kind: "enum", options: ["auto", "openai", "anthropic"] },
    { key: "hideWhenUnavailable", kind: "boolean" },
  ],
};

test("instance notifications reject early, foreign, unstamped and invalid registrations", () => {
  let reads = 0;
  const { bus, registry, instances, options } = fixture(() => {
    reads++;
    return [{ provider: "openai" }];
  });
  bus.emit("statusline:register", registration);
  registry.syncInstances();
  registry.setOwner("test-session");
  bus.emit("statusline:register", { ...registration, owner: "child-session" });
  bus.emit("statusline:register", { id: "usage", fields: registration.fields });
  bus.emit("statusline:register", { ...registration, id: "" });
  registry.syncInstances();
  assert.deepEqual(instances, []);
  assert.equal(reads, 0);

  bus.emit("statusline:register", registration);
  assert.equal(instances.length, 1);
  assert.equal(reads, 1);
  for (const owner of [undefined, ""]) {
    registry.setOwner(owner);
    registry.syncInstances();
    bus.emit("statusline:register", { ...registration, owner });
  }
  assert.equal(instances.length, 1);
  assert.equal(reads, 1);
  assert.deepEqual(options, []);
});

test("registration and replay report saved instances using the current schema without persistence", () => {
  const saved = [
    { provider: "openai", hideWhenUnavailable: true, undeclared: 1 },
    { provider: "anthropic", hideWhenUnavailable: false },
  ];
  const { bus, registry, instances, options } = fixture((id) => {
    assert.equal(id, "usage");
    assert.ok(registry.registration(id));
    return saved;
  });
  registry.setOwner("test-session");
  bus.on("statusline:request", () => bus.emit("statusline:register", registration));
  registry.request();
  registry.request();
  const expected = {
    id: "usage",
    owner: "test-session",
    instances: [
      { options: { provider: "openai", hideWhenUnavailable: true } },
      { options: { provider: "anthropic", hideWhenUnavailable: false } },
    ],
  };
  assert.deepEqual(instances, [expected, expected]);

  bus.emit("statusline:register", {
    ...registration,
    fields: [{ key: "provider", kind: "enum", options: ["openai"] }],
  });
  assert.deepEqual(instances.at(-1), {
    ...expected,
    instances: [{ options: { provider: "openai" } }, { options: {} }],
  });
  assert.equal(saved[0]?.undeclared, 1);
  registry.render("usage", saved[0] ?? {}, { preview: false });
  assert.equal(instances.length, 3);
  assert.deepEqual(options, []);
});

test("sync reports every registered id, including empty demand after removal", () => {
  const saved = new Map<string, SlotOptions[]>([["usage", [{ provider: "openai" }]]]);
  const { bus, registry, instances, options } = fixture((id) => saved.get(id) ?? []);
  registry.setOwner("test-session");
  bus.emit("statusline:register", registration);
  bus.emit("statusline:register", { id: "other", owner: "test-session", fields: [] });
  instances.length = 0;
  saved.clear();
  registry.syncInstances();
  assert.deepEqual(instances, [
    { id: "usage", owner: "test-session", instances: [] },
    { id: "other", owner: "test-session", instances: [] },
  ]);
  assert.deepEqual(options, []);
});

test("the optional callback defaults to empty demand", () => {
  const { bus, registry, instances } = fixture();
  registry.setOwner("test-session");
  bus.emit("statusline:register", registration);
  assert.deepEqual(instances, [{ id: "usage", owner: "test-session", instances: [] }]);
});
