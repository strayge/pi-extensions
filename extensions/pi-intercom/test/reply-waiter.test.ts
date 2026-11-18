import assert from "node:assert/strict";
import test from "node:test";
import { ReplyWaiter } from "../src/reply-tracker.ts";
import type { Message } from "../src/types.ts";

const answer = (replyTo = "question"): Message => ({
  id: "answer",
  timestamp: 1,
  replyTo,
  content: { text: "clarification?" },
});

test("only the first exact-identity correlation settles a waiter", async () => {
  const waiter = new ReplyWaiter(1000);
  let cleaned = 0;
  const reply = waiter.wait("peer-id", "question", {
    onFinish: () => {
      cleaned++;
    },
  });
  await assert.rejects(
    waiter.wait("other", "second", {
      onFinish: () => {
        cleaned++;
      },
    }),
    /Already waiting/,
  );
  assert.equal(waiter.receive("peer", answer()), false);
  assert.equal(waiter.receive("PEER-ID", answer()), false);
  assert.equal(waiter.receive("same-display-name", answer()), false);
  assert.equal(waiter.receive("peer-id", answer("unrelated")), false);
  assert.equal(waiter.receive("peer-id", answer()), true);
  assert.equal((await reply).content.text, "clarification?");
  assert.equal(waiter.receive("peer-id", answer()), false);
  waiter.reject(new Error("late interruption"));
  assert.equal(cleaned, 1);
  const next = waiter.wait("peer-id", "next-question", {
    onFinish: () => {
      cleaned++;
    },
  });
  waiter.reject(new Error("late send failure"), "question");
  assert.equal(waiter.active, true);
  assert.equal(waiter.receive("peer-id", answer("next-question")), true);
  await next;
  assert.equal(cleaned, 2);
});

test("abort, timeout, and interruption clean bookkeeping, not recipient work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waiter = new ReplyWaiter(100);
  const controller = new AbortController();
  let cleaned = 0;
  const aborted = waiter.wait("peer", "abort", {
    signal: controller.signal,
    onFinish: () => {
      cleaned++;
    },
  });
  const rejection = assert.rejects(aborted, /recipient message was not cancelled/);
  controller.abort();
  await rejection;
  assert.equal(waiter.active, false);
  const timedOut = waiter.wait("peer", "timeout", {
    onFinish: () => {
      cleaned++;
    },
    deliveryState: () => "queued",
  });
  const timeoutRejection = assert.rejects(timedOut, /Last known delivery state: queued/);
  t.mock.timers.tick(100);
  await timeoutRejection;
  const interrupted = waiter.wait("peer", "interrupted", {
    onFinish: () => {
      cleaned++;
    },
  });
  const interruptionRejection = assert.rejects(interrupted, /disconnected/);
  waiter.reject(new Error("disconnected; waiting interrupted"));
  await interruptionRejection;
  assert.equal(cleaned, 3);
  assert.equal(waiter.receive("peer", answer("timeout")), false);
  await assert.rejects(
    waiter.wait("peer", "never-sent", {
      signal: controller.signal,
      onFinish: () => {
        cleaned++;
      },
    }),
    /before dispatch/,
  );
  assert.equal(cleaned, 3);
});
