import assert from "node:assert/strict";
import test from "node:test";
import attentionExtension from "../src/index.ts";

test("only the root TUI session controls terminal attention handling", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  };
  attentionExtension(pi as never);

  let terminalInputSubscriptions = 0;
  let terminalInputUnsubscriptions = 0;
  const rootContext = {
    mode: "tui",
    ui: {
      onTerminalInput() {
        terminalInputSubscriptions++;
        return () => {
          terminalInputUnsubscriptions++;
        };
      },
    },
    isIdle: () => true,
  };
  const childContext = {
    mode: "tui",
    ui: {
      [Symbol.for("pi-subagents:child-extension-ui")]: true,
      onTerminalInput() {
        terminalInputSubscriptions++;
        return () => {
          terminalInputUnsubscriptions++;
        };
      },
    },
    isIdle: () => true,
  };

  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    await handlers.get("session_start")?.({}, rootContext);
    assert.equal(terminalInputSubscriptions, 1);
    assert.deepEqual(writes, ["\x1b[?1004h"]);

    writes.length = 0;
    await handlers.get("session_start")?.({}, childContext);
    await handlers.get("agent_settled")?.({}, childContext);
    await handlers.get("session_shutdown")?.({}, childContext);

    assert.equal(terminalInputSubscriptions, 1);
    assert.equal(terminalInputUnsubscriptions, 0);
    assert.deepEqual(writes, []);

    await handlers.get("session_shutdown")?.({}, rootContext);
    assert.equal(terminalInputUnsubscriptions, 1);
    assert.deepEqual(writes, ["\x1b[?1004l"]);
  } finally {
    process.stdout.write = originalWrite;
  }
});
