type MockHandler = (...args: unknown[]) => unknown;

type MockCommand = {
  description?: string;
  handler: (args: string, ctx: never) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => unknown;
};

export function createMockPi() {
  const commands = new Map<string, MockCommand>();
  const events = new Map<string, MockHandler[]>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const sentUserMessages: Array<{ text: string; options?: unknown }> = [];
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  const subscriptions = new Map<string, Array<(data: unknown) => void>>();
  const eventBus = {
    emit(channel: string, data: unknown) {
      for (const handler of subscriptions.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const handlers = subscriptions.get(channel) ?? [];
      handlers.push(handler);
      subscriptions.set(channel, handlers);
      return () => {
        const current = subscriptions.get(channel);
        if (!current) return;
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
  };
  const pi = {
    registerCommand(name: string, command: unknown) {
      commands.set(name, command as MockCommand);
    },
    on(name: string, handler: MockHandler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    events: eventBus,
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendUserMessage(text: string, options?: unknown) {
      sentUserMessages.push({ text, options });
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
    },
  };
  return { pi: pi as never, commands, events, entries, sentUserMessages, sentMessages };
}

export function createMockContext(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const ctx = {
    cwd: "/test-project",
    hasUI: false,
    mode: "rpc",
    model: undefined,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
      },
      select: overrides.select ?? (async () => undefined),
      custom: overrides.custom ?? (async () => undefined),
    },
    sessionManager: overrides.sessionManager ?? {
      getSessionId: () => "test-session",
      getSessionDir: () => "/test-sessions",
      getSessionFile: () => undefined,
      getHeader: () => ({ type: "session", id: "test-session" }),
      getBranch: () => [],
      getEntries: () => [],
    },
    modelRegistry: overrides.modelRegistry ?? {},
    ...overrides,
  };
  return { ctx: ctx as never, notifications, statuses };
}
