import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { LoadedHistory } from "../src/history.ts";
import speedExtension from "../src/index.ts";
import { createMockContext, createMockPi } from "./support.ts";

initTheme("dark", false);

const emptyHistory: LoadedHistory = {
  now: Date.now(),
  calls: [],
  warnings: [],
};

const model = {
  id: "gpt-5.3-codex",
  name: "GPT-5.3 Codex",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
};

test("pi-speed owns only the speed command and speed lifecycle hooks", () => {
  const mock = createMockPi();
  speedExtension(mock.pi);

  assert.deepEqual([...mock.commands.keys()], ["speed"]);
  assert.equal(mock.commands.get("speed")?.getArgumentCompletions, undefined);
  assert.deepEqual([...mock.events.keys()].sort(), [
    "message_end",
    "model_select",
    "provider_stream_event",
    "session_shutdown",
    "session_start",
    "session_tree",
    "tool_execution_start",
    "turn_end",
    "turn_start",
  ]);
});

test("/speed opens results directly and changes range without reloading or live side effects", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => assert.fail("speed must not fetch live data");
  for (const args of ["", "7d"]) {
    const mock = createMockPi();
    let loads = 0;
    let loadSignal: AbortSignal | undefined;
    speedExtension(mock.pi, async (_ctx, options) => {
      loads += 1;
      loadSignal = options.signal;
      return emptyHistory;
    });
    const selections: string[] = [];
    const { ctx, statuses, notifications } = createMockContext({
      hasUI: true,
      mode: "rpc",
      model,
      modelRegistry: new Proxy({}, { get: () => assert.fail("speed must not resolve auth") }),
      select: async (title: string, options: string[]) => {
        selections.push(title);
        assert.deepEqual(options, ["1d", "2d", "3d", "5d", "7d", "14d", "Close"]);
        assert.match(
          title,
          selections.length === 1
            ? args
              ? /7d vs previous 7d/
              : /1d vs previous 1d/
            : /14d vs previous 14d/,
        );
        assert.match(title, /Provider\/model/);
        return selections.length === 1 ? "14d" : "Close";
      },
    });
    await mock.commands.get("speed")?.handler(args, ctx);
    assert.equal(loads, 1);
    assert.equal(selections.length, 2);
    assert.equal(loadSignal?.aborted, true);
    assert.equal(statuses.size, 0);
    assert.deepEqual(notifications, []);
    assert.deepEqual(mock.entries, []);
    assert.deepEqual(mock.sentMessages, []);
    assert.deepEqual(mock.sentUserMessages, []);
  }
});

test("/speed rejects invalid arguments and no-UI contexts before loading", async () => {
  const mock = createMockPi();
  speedExtension(mock.pi, async () => assert.fail("must not load"));
  for (const args of ["30d", "1d 2d", "invalid"]) {
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "rpc",
      select: async () => assert.fail("invalid args must not select"),
    });
    await mock.commands.get("speed")?.handler(args, ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]?.message ?? "", /\/speed accepts/);
  }
  const noUI = createMockContext();
  await mock.commands.get("speed")?.handler("1d", noUI.ctx);
  assert.match(noUI.notifications[0]?.message ?? "", /requires an interactive/);
});

test("/speed aborts a superseded load and a shutdown load without showing stale results", async () => {
  for (const action of ["supersede", "shutdown"]) {
    const mock = createMockPi();
    let loads = 0;
    let firstSignal: AbortSignal | undefined;
    speedExtension(mock.pi, async (_ctx, options) => {
      loads += 1;
      if (loads > 1) return emptyHistory;
      firstSignal = options.signal;
      return new Promise<LoadedHistory>((_resolve, reject) => {
        firstSignal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
          { once: true },
        );
      });
    });
    let reports = 0;
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "rpc",
      select: async () => {
        reports += 1;
        return "Close";
      },
    });
    const pending = mock.commands.get("speed")?.handler("1d", ctx);
    assert.equal(firstSignal?.aborted, false);
    if (action === "supersede") await mock.commands.get("speed")?.handler("2d", ctx);
    else mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    await pending;
    assert.equal(firstSignal?.aborted, true);
    assert.equal(reports, action === "supersede" ? 1 : 0);
    assert.deepEqual(notifications, []);
  }
});

test("/speed TUI Escape aborts the history loader without opening a report", async () => {
  const mock = createMockPi();
  let aborted = false;
  speedExtension(
    mock.pi,
    async (_ctx, options) =>
      new Promise<LoadedHistory>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
          },
          { once: true },
        );
      }),
  );
  let customCalls = 0;
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    mode: "tui",
    custom: async (factory: unknown) =>
      new Promise<unknown>((resolve) => {
        customCalls += 1;
        const component = (
          factory as (
            tui: object,
            theme: object,
            keys: object,
            done: (value: unknown) => void,
          ) => { handleInput(data: string): void; dispose(): void }
        )({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value) => {
          component.dispose();
          resolve(value);
        });
        setImmediate(() => component.handleInput("\u001b"));
      }),
  });
  await mock.commands.get("speed")?.handler("1d", ctx);
  assert.equal(aborted, true);
  assert.equal(customCalls, 1);
  assert.deepEqual(notifications, []);
});

test("/speed sanitizes read failures and suppresses stale contexts", async () => {
  const generic = createMockPi();
  speedExtension(generic.pi, async () => {
    throw new Error("/private/source: bearer-secret");
  });
  const failed = createMockContext({ hasUI: true, mode: "rpc" });
  await generic.commands.get("speed")?.handler("1d", failed.ctx);
  assert.deepEqual(failed.notifications, [
    { message: "Could not load model speed history.", level: "warning" },
  ]);

  const stale = createMockPi();
  speedExtension(stale.pi, async () => {
    throw new Error("This extension ctx is stale after session replacement or reload");
  });
  const replaced = createMockContext({ hasUI: true, mode: "rpc" });
  await stale.commands.get("speed")?.handler("1d", replaced.ctx);
  assert.deepEqual(replaced.notifications, []);
});
