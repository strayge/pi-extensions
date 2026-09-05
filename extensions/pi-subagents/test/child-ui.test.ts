import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createChildExtensionUI } from "../src/child-ui.js";

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
