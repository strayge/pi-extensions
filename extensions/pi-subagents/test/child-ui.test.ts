import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CHILD_EXTENSION_UI_MARKER, createChildExtensionUI } from "../src/child-ui.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function parentUI(select: ExtensionUIContext["select"]): ExtensionUIContext {
  return {
    select,
    confirm: vi.fn(async () => false),
    input: vi.fn(async () => undefined),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
    setWorkingVisible: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    setWidget: vi.fn(),
    setFooter: vi.fn(),
    setHeader: vi.fn(),
    setTitle: vi.fn(),
    custom: vi.fn(async () => undefined as never),
    pasteToEditor: vi.fn(),
    setEditorText: vi.fn(),
    getEditorText: vi.fn(() => "draft"),
    editor: vi.fn(async () => undefined),
    addAutocompleteProvider: vi.fn(),
    setEditorComponent: vi.fn(),
    getEditorComponent: vi.fn(() => undefined),
    theme: {} as ExtensionUIContext["theme"],
    getAllThemes: vi.fn(() => []),
    getTheme: vi.fn(() => undefined),
    setTheme: vi.fn(() => ({ success: true })),
    getToolsExpanded: vi.fn(() => false),
    setToolsExpanded: vi.fn(),
  };
}

describe("child extension UI", () => {
  it("preserves child identity when Pi spreads the UI context", () => {
    const child = createChildExtensionUI(parentUI(vi.fn(async () => undefined)), "Explore");
    const wrapped = { ...child };

    expect(Reflect.get(child, CHILD_EXTENSION_UI_MARKER)).toBe(true);
    expect(Reflect.get(wrapped, CHILD_EXTENSION_UI_MARKER)).toBe(true);
  });

  it("forwards permission dialogs with the subagent identity", async () => {
    const select = vi.fn(async () => "Allow once");
    const parent = parentUI(select);
    const child = createChildExtensionUI(parent, "Explore#12345678");

    await expect(child.select("Allow bash?", ["Allow once", "Deny"])).resolves.toBe("Allow once");
    expect(select).toHaveBeenCalledWith(
      "Subagent Explore#12345678: Allow bash?",
      ["Allow once", "Deny"],
      undefined,
    );
  });

  it("preserves native option metadata through UI spreads and combined cancellation", async () => {
    const marker = Symbol.for("pi-extensions:input-dialog");
    const extra = Symbol("native option");
    const agentAbort = new AbortController();
    const dialogAbort = new AbortController();
    const options = Object.assign({ signal: dialogAbort.signal, timeout: 1234 }, {
      [marker]: false,
      [extra]: "keep",
    });
    const seen: Array<{ method: string; options?: ExtensionUIDialogOptions }> = [];
    const parent = parentUI(async (_title, labels, opts) => {
      expect(labels).toBe(labelsIn);
      seen.push({ method: "select", options: opts });
      return "Allow";
    });
    parent.confirm = vi.fn(async (_title, message, opts) => {
      expect(message).toBe("message");
      seen.push({ method: "confirm", options: opts });
      return true;
    });
    parent.input = vi.fn(async (_title, placeholder, opts) => {
      expect(placeholder).toBe("placeholder");
      seen.push({ method: "input", options: opts });
      return "answer";
    });
    const labelsIn = ["Allow", "Deny"];
    const child = { ...createChildExtensionUI(parent, "Explore", agentAbort.signal) };
    expect(Reflect.get(child, CHILD_EXTENSION_UI_MARKER)).toBe(true);
    const results = await Promise.all([
      child.select("Select", labelsIn, { ...options }),
      child.confirm("Confirm", "message", { ...options }),
      child.input("Input", "placeholder", { ...options }),
    ]);
    expect(results).toEqual(["Allow", true, "answer"]);
    expect(seen.map(call => call.method)).toEqual(["select", "confirm", "input"]);
    for (const call of seen) {
      expect(Reflect.get({ ...call.options }, marker)).toBe(false);
      expect(Reflect.get(call.options!, extra)).toBe("keep");
      expect(call.options?.timeout).toBe(1234);
      expect(call.options?.signal).not.toBe(dialogAbort.signal);
      expect(call.options?.signal).not.toBe(agentAbort.signal);
      expect(call.options?.signal?.aborted).toBe(false);
    }
    dialogAbort.abort();
    expect(seen.every(call => call.options?.signal?.aborted)).toBe(true);
    expect(options.signal).toBe(dialogAbort.signal);
    expect(Reflect.get(options, marker)).toBe(false);
  });

  it("forwards unchanged options when no signal merge is needed and keeps child approvals tracked once", async () => {
    const marker = Symbol.for("pi-extensions:input-dialog");
    const options = { timeout: 200, signal: new AbortController().signal };
    const parent = parentUI(vi.fn(async () => "Allow"));
    parent.confirm = vi.fn(async () => true);
    parent.input = vi.fn(async () => "answer");
    const child = createChildExtensionUI(parent, "Plan");
    await child.select("Permission", ["Allow"], options);
    await child.confirm("Permission", "message", options);
    await child.input("Permission", "placeholder", options);
    for (const method of [parent.select, parent.confirm, parent.input]) {
      expect(method).toHaveBeenCalledTimes(1);
      const forwarded = vi.mocked(method).mock.calls[0][2];
      expect(forwarded).toBe(options);
      expect(Reflect.get(forwarded!, marker)).toBeUndefined();
    }
    await expect(child.custom(vi.fn())).resolves.toBeUndefined();
    expect(parent.custom).not.toHaveBeenCalled();
  });

  it("agent cancellation reaches forwarded native approvals without opting them out", async () => {
    const marker = Symbol.for("pi-extensions:input-dialog");
    const agentAbort = new AbortController();
    const dialogAbort = new AbortController();
    let forwarded: ExtensionUIDialogOptions | undefined;
    const parent = parentUI(async (_title, _labels, options) => {
      forwarded = options;
      return "Allow";
    });
    await createChildExtensionUI(parent, "Plan", agentAbort.signal).select(
      "Approval", ["Allow"], { signal: dialogAbort.signal },
    );
    expect(Reflect.get(forwarded!, marker)).toBeUndefined();
    agentAbort.abort();
    expect(forwarded?.signal?.aborted).toBe(true);
    expect(dialogAbort.signal.aborted).toBe(false);
  });

  it("serializes dialogs from concurrent subagents and drops an aborted waiter", async () => {
    const first = deferred<string | undefined>();
    const select = vi.fn(() => first.promise);
    const parent = parentUI(select);
    const firstChild = createChildExtensionUI(parent, "Explore");
    const secondAbort = new AbortController();
    const secondChild = createChildExtensionUI(parent, "Agent", secondAbort.signal);

    const firstResult = firstChild.select("First", ["Allow", "Deny"]);
    const secondResult = secondChild.select("Second", ["Allow", "Deny"]);
    await Promise.resolve();
    expect(select).toHaveBeenCalledTimes(1);

    secondAbort.abort();
    first.resolve("Allow");

    await expect(firstResult).resolves.toBe("Allow");
    await expect(secondResult).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not let child extensions mutate the parent session UI", () => {
    const parent = parentUI(vi.fn(async () => undefined));
    const child = createChildExtensionUI(parent, "Plan");

    child.setStatus("perm", "Plan Mode");
    child.setEditorText("replacement");
    child.setTheme("light");

    expect(parent.setStatus).not.toHaveBeenCalled();
    expect(parent.setEditorText).not.toHaveBeenCalled();
    expect(parent.setTheme).not.toHaveBeenCalled();
  });
});
