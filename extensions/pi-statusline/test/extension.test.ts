import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import statusline from "../src/index.ts";
import { fakeEnv, identityTheme } from "./helpers.ts";

interface StubPi {
  api: ExtensionAPI;
  events: string[];
  commands: string[];
  emit: (channel: string, data: unknown) => void;
  busChannels: () => string[];
  dispatch: (event: string, ctx?: ExtensionContext) => void;
  runCommand: (args: string, ctx?: ExtensionContext) => Promise<void>;
}

function stubPi(): StubPi {
  const events: string[] = [];
  const commands: string[] = [];
  const commandHandlers = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const lifecycle = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();

  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
      events.push(event);
      lifecycle.set(event, handler);
    },
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      commands.push(name);
      commandHandlers.set(name, command);
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
    dispatch: (event, ctx = fakeEnv().ctx) => lifecycle.get(event)?.({ type: event }, ctx),
    runCommand: async (args, ctx = fakeEnv().ctx) => {
      await commandHandlers.get("statusline")?.handler(args, ctx as never);
    },
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

  // Subscription lasts across sessions; early traffic is dropped until an
  // owner is set, then recovered by that session's request replay.
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

test("session start owns replay traffic, and shutdown rejects subsequent publications", (t) => {
  const pi = stubPi();
  statusline(pi.api);
  const env = fakeEnv();
  let repaints = 0;
  let footer: { dispose?: () => void } | undefined;
  const ctx = {
    ...env.ctx,
    hasUI: true,
    mode: "tui",
    ui: {
      setFooter: (factory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>) => {
        footer = factory(
          { requestRender: () => repaints++ } as never,
          identityTheme(),
          env.footerData,
        );
      },
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  t.after(() => {
    pi.dispatch("session_shutdown");
    footer?.dispose?.();
  });

  const requests: unknown[] = [];
  pi.api.events.on("statusline:request", (data) => {
    requests.push(data);
    const before = repaints;
    pi.emit("statusline:publish", { id: "speed", text: "54.8 tok/s", owner: "test-session" });
    assert.equal(repaints, before + 1);
  });
  pi.dispatch("session_start", ctx);
  assert.deepEqual(requests, [{ owner: "test-session" }]);

  pi.dispatch("session_shutdown");
  const afterShutdown = repaints;
  pi.emit("statusline:publish", { id: "speed", text: "159.6 tok/s", owner: "test-session" });
  assert.equal(repaints, afterShutdown);
});

for (const producerFirst of [true, false]) {
  test(`saved instances reach producers starting ${producerFirst ? "before" : "after"} statusline`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "statusline-instances-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const pi = stubPi();
    t.after(() => {
      pi.dispatch("session_shutdown");
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(directory, { recursive: true, force: true });
    });
    const hiddenItem = {
      type: "slot",
      id: "usage",
      hidden: true,
      options: { provider: "hidden" },
    };
    const config = {
      version: 1,
      groupGap: 2,
      lines: [
        [
          { type: "slot", id: "usage", options: { provider: "openai", hideWhenUnavailable: true } },
          hiddenItem,
        ],
        [{ type: "slot", id: "usage", options: { provider: "anthropic" } }],
      ],
    };
    const save = () => writeFileSync(join(directory, "statusline.json"), JSON.stringify(config));
    save();
    statusline(pi.api);
    const registration = {
      id: "usage",
      owner: "test-session",
      fields: [
        { key: "provider", kind: "string" },
        { key: "hideWhenUnavailable", kind: "boolean" },
      ],
    };
    const instances: unknown[] = [];
    const options: unknown[] = [];
    pi.api.events.on("statusline:instances", (data) => instances.push(data));
    pi.api.events.on("statusline:options", (data) => options.push(data));
    const announce = () => pi.emit("statusline:register", registration);
    if (producerFirst) {
      pi.api.events.on("statusline:request", announce);
      announce();
    }
    assert.deepEqual(instances, []);
    const ctx = {
      ...fakeEnv().ctx,
      hasUI: true,
      mode: "tui",
      ui: { setFooter: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;
    pi.dispatch("session_start", ctx);
    if (!producerFirst) {
      pi.api.events.on("statusline:request", announce);
      announce();
    }
    const expected = {
      id: "usage",
      owner: "test-session",
      instances: [
        { options: { provider: "openai", hideWhenUnavailable: true } },
        { options: { provider: "anthropic" } },
      ],
    };
    assert.equal(instances.length, 1);
    assert.deepEqual(instances.at(-1), expected);
    assert.deepEqual(options, []);

    instances.length = 0;
    await pi.runCommand("reload", ctx);
    assert.deepEqual(instances, [expected]);
    assert.deepEqual(options, []);

    hiddenItem.options.provider = "hidden-updated";
    save();
    await pi.runCommand("reload", ctx);
    assert.deepEqual(instances.at(-1), expected);
    assert.deepEqual(options, [
      {
        id: "usage",
        owner: "test-session",
        version: 1,
        instances: [
          { options: { provider: "openai", hideWhenUnavailable: true } },
          { options: { provider: "hidden-updated" } },
          { options: { provider: "anthropic" } },
        ],
      },
    ]);

    options.length = 0;
    config.lines = [[]];
    save();
    await pi.runCommand("reload", ctx);
    assert.deepEqual(instances.at(-1), { id: "usage", owner: "test-session", instances: [] });
    assert.deepEqual(options, []);
  });
}

test("session start sets ownership even without a TUI", (t) => {
  const pi = stubPi();
  statusline(pi.api);
  const messages: unknown[] = [];
  pi.api.events.on("statusline:request", (data) => messages.push(data));
  const ctx = { ...fakeEnv().ctx, hasUI: false, mode: "print" } as ExtensionContext;
  let ownerReads = 0;
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getSessionId: () => {
      ownerReads++;
      return "test-session";
    },
  };
  t.after(() => pi.dispatch("session_shutdown"));

  pi.dispatch("session_start", ctx);
  assert.equal(ownerReads, 1);
  assert.deepEqual(messages, []);
});
