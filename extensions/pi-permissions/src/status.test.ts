import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionOwner } from "./approvals.ts";
import { defaultConfig } from "./config-load.ts";
import { NetworkSession } from "./network.ts";
import { createStatus } from "./status.ts";

test("open networking stays hidden and clears restricted indicators in both footer surfaces", () => {
  const events = createEventBus();
  const slots = new Map<string, string>();
  events.on("statusline:publish", (raw) => {
    const item = raw as { id: string; text: string };
    slots.set(item.id, item.text);
  });
  events.on("statusline:clear", (raw) => slots.delete((raw as { id: string }).id));
  const statuses = new Map<string, string | undefined>();
  const ctx = { ui: {
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
  slots.clear(); events.emit("statusline:request", {});
  assert.equal(slots.get("perm-network"), "Network restricted");

  network.change({ restricted: false });
  update(ctx, owner);
  assert.equal(statuses.get("perm"), "Project");
  assert.equal(slots.has("perm-network"), false);
  events.emit("statusline:request", {});
  assert.equal(slots.has("perm-network"), false);
  assert.equal(slots.get("perm"), "Project");
});

test("failed initialization clears restricted networking instead of treating missing policy as restricted", () => {
  const events = createEventBus();
  const slots = new Map<string, string>();
  events.on("statusline:publish", (raw) => {
    const item = raw as { id: string; text: string };
    slots.set(item.id, item.text);
  });
  events.on("statusline:clear", (raw) => slots.delete((raw as { id: string }).id));
  let status: string | undefined;
  const ctx = { ui: {
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
  events.emit("statusline:request", {});
  assert.equal(slots.has("perm-network"), false);
});
