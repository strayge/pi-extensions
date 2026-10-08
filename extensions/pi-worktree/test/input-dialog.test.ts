import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionCommandContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { manualMenuContext } from "../src/input-dialog.ts";

const inputDialog = Symbol.for("pi-extensions:input-dialog");

test("manual menu adapter preserves native binding, options, arguments, and custom identity", async () => {
  const signal = new AbortController().signal;
  const options = Object.assign({ signal, timeout: 123 }, { [inputDialog]: true });
  const choices = ["one", "two"];
  const selected = Promise.resolve("two");
  const failure = new Error("input failed");
  const calls: unknown[][] = [];
  const check = (receiver: unknown, args: unknown[], opts?: ExtensionUIDialogOptions) => {
    assert.equal(receiver, ui);
    assert.notEqual(opts, options);
    assert.equal(opts?.signal, signal);
    assert.equal(opts?.timeout, 123);
    assert.equal(Reflect.get({ ...opts }, inputDialog), false);
    calls.push(args);
  };
  const ui = {
    confirm(title: string, message: string, opts?: ExtensionUIDialogOptions) {
      check(this, [title, message], opts);
      return Promise.resolve(false);
    },
    select(title: string, items: string[], opts?: ExtensionUIDialogOptions) {
      check(this, [title, items], opts);
      assert.equal(items, choices);
      return selected;
    },
    input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) {
      check(this, [title, placeholder], opts);
      return Promise.reject(failure);
    },
    custom() {},
  };
  const ctx = { ui, cwd: "/repo" } as unknown as ExtensionCommandContext;
  const manual = manualMenuContext(ctx);
  assert.notEqual(manual, ctx);
  assert.notEqual(manual.ui, ui);
  assert.equal(manual.ui.custom, ui.custom);
  assert.equal(ctx.ui, ui);
  assert.equal(await manual.ui.confirm("confirm", "message", options), false);
  assert.equal(manual.ui.select("select", choices, options), selected);
  await assert.rejects(
    manual.ui.input("input", "placeholder", options),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    ["confirm", "message"],
    ["select", choices],
    ["input", "placeholder"],
  ]);
  assert.equal(Reflect.get(options, inputDialog), true, "shared options stay unchanged");
});
