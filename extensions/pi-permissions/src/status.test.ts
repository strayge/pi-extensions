import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { NetworkSession } from "./network.ts";
import { createStatus } from "./status.ts";
import { publishStatuslineItem } from "./statusline-slot.ts";

test("open networking stays hidden and clears restricted indicators in both footer surfaces", () => {
  const events = createEventBus();
  const slots = new Map<string, string>();
  events.on("statusline:publish", (raw) => {
    const item = raw as { id: string; text: string; owner: string };
    assert.equal(item.owner, "test-session");
    slots.set(item.id, item.text);
  });
  events.on("statusline:clear", (raw) => {
    const item = raw as { id: string; owner: string };
    assert.equal(item.owner, "test-session");
    slots.delete(item.id);
  });
  const statuses = new Map<string, string | undefined>();
  const ctx = { sessionManager: { getSessionId: () => "test-session" }, ui: {
    setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
    theme: { fg: (_color: string, text: string) => text },
  } } as unknown as ExtensionContext;
  const config = defaultConfig();
  const network = new NetworkSession(config.network, () => {});
  const owner = {
    config, network,
    snapshot: () => ({ mode: "project", profile: { kind: "scoped" } }),
  } as unknown as PermissionOwner;
  const update = createStatus({ events } as unknown as ExtensionAPI);

  update(ctx, owner);
  assert.equal(statuses.get("perm"), "Project");
  assert.equal(slots.get("perm"), "Project");
  assert.equal(slots.has("perm-network"), false);

  network.change({ restricted: true });
  update(ctx, owner);
  assert.equal(statuses.get("perm"), "Project · Network restricted");
  assert.equal(slots.get("perm-network"), "Network restricted");
  slots.clear(); events.emit("statusline:request", { owner: "test-session" });
  assert.equal(slots.get("perm-network"), "Network restricted");

  network.change({ restricted: false });
  update(ctx, owner);
  assert.equal(statuses.get("perm"), "Project");
  assert.equal(slots.has("perm-network"), false);
  events.emit("statusline:request", { owner: "test-session" });
  assert.equal(slots.has("perm-network"), false);
  assert.equal(slots.get("perm"), "Project");
});

test("failed initialization clears restricted networking instead of treating missing policy as restricted", () => {
  const events = createEventBus();
  const slots = new Map<string, string>();
  events.on("statusline:publish", (raw) => {
    const item = raw as { id: string; text: string; owner: string };
    assert.equal(item.owner, "test-session");
    slots.set(item.id, item.text);
  });
  events.on("statusline:clear", (raw) => {
    const item = raw as { id: string; owner: string };
    assert.equal(item.owner, "test-session");
    slots.delete(item.id);
  });
  let status: string | undefined;
  const ctx = { sessionManager: { getSessionId: () => "test-session" }, ui: {
    setStatus: (_key: string, text: string | undefined) => { status = text; },
    theme: { fg: (_color: string, text: string) => text },
  } } as unknown as ExtensionContext;
  const config = defaultConfig();
  const network = new NetworkSession({ ...config.network, default: "restricted" }, () => {});
  const owner = {
    config, network,
    snapshot: () => ({ mode: "project", profile: { kind: "scoped" } }),
  } as unknown as PermissionOwner;
  const update = createStatus({ events } as unknown as ExtensionAPI);

  update(ctx, owner);
  assert.equal(slots.get("perm-network"), "Network restricted");
  update(ctx, owner, "Initialization failed");
  assert.equal(status, "Unrestricted (policy failed)");
  assert.equal(slots.has("perm-network"), false);
  update(ctx);
  assert.equal(slots.has("perm-network"), false);
  events.emit("statusline:request", { owner: "test-session" });
  assert.equal(slots.has("perm-network"), false);
});

test("slot replay ignores foreign requests and unchanged chips follow their session", () => {
  const events = createEventBus();
  const messages: unknown[] = [];
  events.on("statusline:publish", (data) => messages.push(data));
  events.on("statusline:clear", (data) => messages.push(data));
  const publish = publishStatuslineItem({ events } as unknown as ExtensionAPI, { id: "perm", priority: 20 });
  const context = (sessionOwner: string) => ({ sessionManager: { getSessionId: () => sessionOwner } }) as unknown as Pick<ExtensionContext, "sessionManager">;
  const parent = context("parent-session");
  const child = context("child-session");

  events.emit("statusline:request", {});
  assert.deepEqual(messages, []);
  publish(parent, "Project", "accent");
  assert.deepEqual(messages, [{ id: "perm", priority: 20, text: "Project", color: "accent", owner: "parent-session" }]);
  messages.length = 0;
  publish(parent, "Project", "accent");
  events.emit("statusline:request", { owner: "child-session" });
  events.emit("statusline:request", {});
  assert.deepEqual(messages, []);
  events.emit("statusline:request", { owner: "parent-session" });
  assert.deepEqual(messages, [{ id: "perm", priority: 20, text: "Project", color: "accent", owner: "parent-session" }]);

  messages.length = 0;
  publish(child, "Project", "accent");
  publish(child, "Project", "error");
  publish(child, undefined, "error");
  events.emit("statusline:request", { owner: "child-session" });
  assert.deepEqual(messages, [
    { id: "perm", priority: 20, text: "Project", color: "accent", owner: "child-session" },
    { id: "perm", priority: 20, text: "Project", color: "error", owner: "child-session" },
    { id: "perm", owner: "child-session" },
  ]);
});
