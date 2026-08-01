/**
 * Test doubles for the pieces pi injects: context, footer data, theme, slots.
 *
 * The default theme is an identity theme so assertions read as plain text;
 * `markupTheme()` makes color decisions visible when that is what is under test.
 */

import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { RenderEnv } from "../src/items.ts";
import { createRuntime, type RuntimeState } from "../src/runtime.ts";
import { SlotRegistry } from "../src/slots.ts";
import type { SlotItem } from "../src/types.ts";
import type { UsageTotals } from "../src/usage.ts";

export function identityTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

export function markupTheme(): Theme {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<b>${text}</b>`,
  } as unknown as Theme;
}

export interface FakeOptions {
  cwd?: string;
  branch?: string | null;
  sessionName?: string;
  modelId?: string;
  provider?: string;
  reasoning?: boolean;
  thinkingLevel?: string;
  providerCount?: number;
  contextPercent?: number | null;
  contextTokens?: number | null;
  contextWindow?: number;
  usage?: Partial<UsageTotals>;
  statuses?: Record<string, string>;
  slots?: SlotItem[];
  runtime?: Partial<RuntimeState>;
}

export function fakeEnv(options: FakeOptions = {}): Omit<RenderEnv, "placedStatusKeys"> {
  const ctx = {
    cwd: options.cwd ?? "/work/proj",
    model: {
      id: options.modelId ?? "gpt-5",
      provider: options.provider ?? "openai",
      reasoning: options.reasoning ?? true,
      contextWindow: options.contextWindow ?? 200_000,
    },
    thinkingLevel: options.thinkingLevel ?? "high",
    sessionManager: {
      getSessionName: () => options.sessionName,
      getEntries: () => [],
    },
    getContextUsage: () => {
      const percent = options.contextPercent === undefined ? 72.3 : options.contextPercent;
      const contextWindow = options.contextWindow ?? 200_000;
      // pi reports both or neither: the percent is derived from the count.
      const tokens =
        options.contextTokens !== undefined
          ? options.contextTokens
          : percent === null
            ? null
            : Math.round((percent / 100) * contextWindow);
      return { percent, tokens, contextWindow };
    },
  } as unknown as ExtensionContext;

  const statuses = new Map(Object.entries(options.statuses ?? {}));
  const footerData = {
    getGitBranch: () => (options.branch === undefined ? "main" : options.branch),
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => options.providerCount ?? 1,
    onBranchChange: () => () => {},
  } as unknown as ReadonlyFooterDataProvider;

  const slots = createRegistry();
  for (const slot of options.slots ?? []) publish(slots, slot);

  return {
    ctx,
    footerData,
    runtime: { ...createRuntime(), ...options.runtime },
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      ...options.usage,
    },
    slots,
    now: Date.UTC(2026, 0, 2, 3, 4, 5),
  };
}

/** Drive a registry through its real event handling rather than reaching inside. */
export function publish(registry: SlotRegistry, slot: SlotItem): void {
  const bus = busFor(registry);
  bus.emit("statusline:publish", slot);
}

export function clearSlot(registry: SlotRegistry, id: string): void {
  busFor(registry).emit("statusline:clear", { id });
}

interface FakeBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
  handlers: Map<string, Array<(data: unknown) => void>>;
}

const buses = new WeakMap<SlotRegistry, FakeBus>();

export function createRegistry(onChange: () => void = () => {}): SlotRegistry {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const bus: FakeBus = {
    handlers,
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {
        handlers.set(
          channel,
          (handlers.get(channel) ?? []).filter((entry) => entry !== handler),
        );
      };
    },
  };

  const registry = new SlotRegistry({ events: bus } as never, onChange);
  registry.listen();
  buses.set(registry, bus);
  return registry;
}

export function busFor(registry: SlotRegistry): FakeBus {
  const bus = buses.get(registry);
  if (!bus) throw new Error("registry was not created by createRegistry()");
  return bus;
}
