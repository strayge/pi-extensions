import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type DialogOptions = Parameters<ExtensionUIContext["select"]>[2];

class DialogQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> {
    const result = this.tail.then(
      () => (signal?.aborted ? fallback : task()),
      () => (signal?.aborted ? fallback : task()),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const dialogQueues = new WeakMap<ExtensionUIContext, DialogQueue>();

function queueFor(ui: ExtensionUIContext): DialogQueue {
  let queue = dialogQueues.get(ui);
  if (!queue) {
    queue = new DialogQueue();
    dialogQueues.set(ui, queue);
  }
  return queue;
}

function combinedSignal(dialogSignal?: AbortSignal, agentSignal?: AbortSignal): AbortSignal | undefined {
  if (!dialogSignal) return agentSignal;
  if (!agentSignal) return dialogSignal;
  return AbortSignal.any([dialogSignal, agentSignal]);
}

function dialogOptions(opts: DialogOptions, agentSignal?: AbortSignal): DialogOptions {
  const signal = combinedSignal(opts?.signal, agentSignal);
  return signal === opts?.signal ? opts : { ...opts, signal };
}

/**
 * Child sessions have no UI of their own, but a policy gate must be able to ask
 * the person supervising the parent session instead of failing closed merely
 * because the worker is headless. Only modal dialogs and prefixed notifications
 * cross the boundary; status bars, widgets, editor state, and terminal handlers
 * remain owned by the parent session.
 *
 * Dialogs share a queue per parent UI because pi's TUI supports one extension
 * modal at a time. Without serialization, concurrent background agents can
 * replace one another's selector and leave the displaced tool call waiting
 * forever.
 */
export function createChildExtensionUI(
  parent: ExtensionUIContext,
  label: string,
  agentSignal?: AbortSignal,
): ExtensionUIContext {
  const queue = queueFor(parent);
  const title = (value: string) => `Subagent ${label}: ${value}`;

  return {
    select: (value, options, opts) => {
      const merged = dialogOptions(opts, agentSignal);
      return queue.run(() => parent.select(title(value), options, merged), undefined, merged?.signal);
    },
    confirm: (value, message, opts) => {
      const merged = dialogOptions(opts, agentSignal);
      return queue.run(() => parent.confirm(title(value), message, merged), false, merged?.signal);
    },
    input: (value, placeholder, opts) => {
      const merged = dialogOptions(opts, agentSignal);
      return queue.run(() => parent.input(title(value), placeholder, merged), undefined, merged?.signal);
    },
    notify: (message, type) => parent.notify(`[Subagent ${label}] ${message}`, type),
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return parent.theme;
    },
    getAllThemes: () => parent.getAllThemes(),
    getTheme: (name) => parent.getTheme(name),
    setTheme: () => ({ success: false, error: "Child sessions cannot change the parent theme" }),
    getToolsExpanded: () => parent.getToolsExpanded(),
    setToolsExpanded: () => {},
  };
}
