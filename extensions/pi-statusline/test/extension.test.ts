import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import statusline from "../src/index.ts";

interface StubPi {
  api: ExtensionAPI;
  events: string[];
  commands: string[];
  emit: (channel: string, data: unknown) => void;
  busChannels: () => string[];
}

function stubPi(): StubPi {
  const events: string[] = [];
  const commands: string[] = [];
  const handlers = new Map<string, Array<(data: unknown) => void>>();

  const api = {
    on: (event: string) => {
      events.push(event);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
    events: {
      emit: (channel: string, data: unknown) => {
        for (const handler of handlers.get(channel) ?? []) handler(data);
      },
      on: (channel: string, handler: (data: unknown) => void) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
        return () => {};
      },
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  } as unknown as ExtensionAPI;

  return {
    api,
    events,
    commands,
    emit: (channel, data) => {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    busChannels: () => [...handlers.keys()],
  };
}

test("the extension activates without a session and registers its command", () => {
  const pi = stubPi();
  statusline(pi.api);

  assert.equal(pi.commands.includes("statusline"), true);
  assert.equal(pi.events.includes("session_start"), true);
  assert.equal(pi.events.includes("session_shutdown"), true);
});

test("it subscribes to the slot bus at activation, before any session starts", () => {
  const pi = stubPi();
  statusline(pi.api);

  // Producers may publish or register before the first session_start; if the
  // registry only listened from then on, those would be lost until a republish.
  assert.deepEqual(pi.busChannels().sort(), [
    "statusline:clear",
    "statusline:publish",
    "statusline:register",
    "statusline:unregister",
  ]);
});

test("a publish before any session does not throw", () => {
  const pi = stubPi();
  statusline(pi.api);

  pi.emit("statusline:publish", { id: "usage", text: "42%" });
  pi.emit("statusline:clear", { id: "usage" });
});
