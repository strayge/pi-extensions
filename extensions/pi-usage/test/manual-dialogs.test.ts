import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { defaultDisplayConfig } from "../src/config.ts";
import { showDisplayMenu } from "../src/display-menu.ts";
import { showUsageHistory } from "../src/history-menu.ts";

const marker = Symbol.for("pi-extensions:input-dialog");

test("display and history navigation opt out while forwarding their owning signal", async () => {
  const controller = new AbortController();
  const config = defaultDisplayConfig();
  const displayChoices = ["Show: used", "Back"];
  let saved = 0;
  const context = {
    mode: "rpc",
    ui: {
      async select(_title: string, labels: string[], options?: ExtensionUIDialogOptions) {
        assert.equal(options?.signal, controller.signal);
        assert.equal(Reflect.get({ ...options }, marker), false);
        const choice = displayChoices.shift();
        assert.ok(labels.includes(choice ?? ""));
        return choice;
      },
    },
  };
  await showDisplayMenu(context as never, {
    config,
    signal: controller.signal,
    configPath: "usage.json",
    save(next) {
      saved += 1;
      assert.equal(next.value, "remaining");
      return next;
    },
  });
  assert.equal(saved, 1);
  const choices = ["Tab: Cache", "Range: 2d", "Back"];
  let calls = 0;
  context.ui.select = async (_title, labels, options) => {
    calls += 1;
    assert.equal(options?.signal, controller.signal);
    assert.equal(Reflect.get({ ...options }, marker), false);
    const choice = choices.shift();
    assert.ok(labels.includes(choice ?? ""));
    return choice;
  };
  await showUsageHistory(context as never, {
    history: { now: Date.now(), calls: [], snapshots: [], warnings: [], subagents: [] },
    signal: controller.signal,
  });
  assert.equal(calls, 3);
  controller.abort();
  await showUsageHistory(context as never, {
    history: { now: Date.now(), calls: [], snapshots: [], warnings: [], subagents: [] },
    signal: controller.signal,
  });
  assert.equal(calls, 3);
});

test("rich usage settings and history factories remain unmarked", async () => {
  let calls = 0;
  const context = {
    mode: "tui",
    ui: {
      async custom(factory: object) {
        calls += 1;
        assert.equal(Reflect.get(factory, marker), undefined);
      },
    },
  } as never;
  const signal = new AbortController().signal;
  await showDisplayMenu(context, {
    config: defaultDisplayConfig(),
    signal,
    configPath: "usage.json",
    save: (next) => next,
  });
  await showUsageHistory(context, {
    history: { now: Date.now(), calls: [], snapshots: [], warnings: [], subagents: [] },
    signal,
  });
  assert.equal(calls, 2);
});
