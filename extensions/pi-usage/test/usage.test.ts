import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import usageExtension from "../src/usage.ts";
import { createMockContext, createMockPi } from "./support.ts";

// An isolated agent dir keeps these lifecycle tests off the developer's real
// usage.json, and pinning the legacy preset keeps them asserting lifecycle
// rather than whatever the current default display happens to render.
const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "usage.json"), JSON.stringify({ version: 1, preset: "legacy" }));

initTheme("dark", false);

const openRouterModel = {
  id: "openai/gpt-4o",
  name: "GPT-4o",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
};
const codexModel = {
  id: "gpt-5.3-codex",
  name: "GPT-5.3 Codex",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
};

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function usageFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.endsWith("/api/v1/key")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            label: "test-key",
            limit: 100,
            limit_remaining: 75,
            limit_reset: "monthly",
            usage: 25,
            usage_daily: 1,
            usage_weekly: 5,
            usage_monthly: 25,
          },
        }),
        { status: 200 },
      ),
    );
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
      }),
      { status: 200 },
    ),
  );
}

test("pi-usage registers one command and its lifecycle hooks", () => {
  const mock = createMockPi();
  usageExtension(mock.pi);

  assert.deepEqual([...mock.commands.keys()], ["usage"]);
  assert.equal(mock.commands.get("usage")?.getArgumentCompletions, undefined);
  assert.deepEqual([...mock.events.keys()].sort(), [
    "model_select",
    "session_shutdown",
    "session_start",
    "session_tree",
    "turn_start",
  ]);
});

test("/usage queries the current runtime account and offers its next actions", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = usageFetch;

  const selections: Array<{ title: string; options: string[] }> = [];
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: openRouterModel,
    select: async (title: string, options: string[]) => {
      selections.push({ title, options });
      return "Close";
    },
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel, codexModel],
      getProviderAuthStatus: (provider: string) => ({ configured: provider === "openrouter" }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  await command.handler("", ctx);

  assert.equal(selections.length, 1);
  assert.match(selections[0]?.title ?? "", /OpenRouter Usage · Current/);
  assert.match(selections[0]?.title ?? "", /test-key/);
  assert.deepEqual(selections[0]?.options, ["Refresh usage", "Display options…", "Close"]);
  assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("/usage caches enriched Codex reports and refreshes both requests together", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const refresh = urls.filter((candidate) => candidate.endsWith("/wham/usage")).length;
    const body = url.endsWith("/wham/usage")
      ? { rate_limit_reset_credits: { available_count: refresh === 1 ? 2 : 4 } }
      : {
          available_count: refresh === 1 ? 1 : 3,
          credits: [{ status: "available", expires_at: null }],
        };
    return new Response(JSON.stringify(body), { status: 200 });
  };

  const choices = ["Close", "Close", "Refresh usage", "Close"];
  const titles: string[] = [];
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: codexModel,
    select: async (title: string) => {
      titles.push(title);
      return choices.shift();
    },
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "codex-key" } }),
      getAvailable: () => [codexModel],
      getAll: () => [codexModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  await command.handler("", ctx);
  assert.equal(urls.length, 2);
  assert.match(titles[0] ?? "", /Usage limit resets:\s+1 available/);

  await command.handler("", ctx);
  assert.equal(urls.length, 2);
  assert.match(titles[1] ?? "", /Usage limit resets:\s+1 available/);

  await command.handler("", ctx);
  assert.deepEqual(urls, [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
  ]);
  assert.match(titles[3] ?? "", /Usage limit resets:\s+3 available/);
});

test("command arguments are rejected instead of becoming a hidden interface", async () => {
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  let selected = false;
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: openRouterModel,
    select: async () => {
      selected = true;
      return "Close";
    },
  });

  await command.handler("--all", ctx);

  assert.equal(selected, false);
  assert.match(notifications[0]?.message ?? "", /does not accept arguments/);
});

test("unsupported providers remain visible without publishing an error status", async () => {
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const unsupportedModel = {
    id: "claude",
    name: "Claude",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
  };
  let title = "";
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: unsupportedModel,
    select: async (value: string) => {
      title = value;
      return "Close";
    },
    modelRegistry: {
      getProviderDisplayName: () => "Anthropic",
      getAvailable: () => [],
      getAll: () => [],
    },
  });

  await command.handler("", ctx);

  assert.match(title, /Unsupported/);
  assert.equal(statuses.get("usage"), undefined);
});

test("automatic lifecycle refresh starts asynchronously", () => {
  const mock = createMockPi();
  usageExtension(mock.pi);
  const never = new Promise<never>(() => undefined);
  const { ctx } = createMockContext({
    model: openRouterModel,
    modelRegistry: {
      getProviderAuth: () => never,
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
    },
  });

  const result = mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.equal(result, undefined);
  mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("TUI usage queries can be cancelled with Escape", async () => {
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  let selected = false;
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "tui",
    model: openRouterModel,
    select: async () => {
      selected = true;
      return "Close";
    },
    custom: async (factory: unknown) =>
      new Promise<unknown>((resolve) => {
        if (typeof factory !== "function") return resolve(undefined);
        let component: { dispose?(): void; handleInput(data: string): void };
        const done = (value: unknown) => {
          component.dispose?.();
          resolve(value);
        };
        component = (
          factory as (
            tui: { requestRender(): void },
            theme: { fg(_color: string, text: string): string },
            keybindings: object,
            done: (value: unknown) => void,
          ) => { dispose?(): void; handleInput(data: string): void }
        )({ requestRender() {} }, { fg: (_color, text) => text }, {}, done);
        setImmediate(() => component.handleInput("\u001b"));
      }),
    modelRegistry: {
      getProviderAuth: () => new Promise<never>(() => undefined),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
    },
  });

  await command.handler("", ctx);
  assert.equal(selected, false);
});

test("session shutdown aborts an open usage action", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = usageFetch;

  const dialogSignals: AbortSignal[] = [];
  let menuOpened: () => void = () => undefined;
  const menuReady = new Promise<void>((resolve) => {
    menuOpened = resolve;
  });
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: openRouterModel,
    // The menu sits open until something cancels it, as it does in a real
    // session while the user reads the report.
    select: async (
      _title: string,
      _options: string[],
      opts?: { signal?: AbortSignal },
    ): Promise<string | undefined> => {
      assert.ok(opts?.signal);
      dialogSignals.push(opts.signal);
      menuOpened();
      return new Promise((resolve) => {
        if (opts.signal?.aborted) resolve(undefined);
        else opts.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    },
    modelRegistry: {
      getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  const pending = command.handler("", ctx);
  await menuReady;
  mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  await pending;

  assert.equal(dialogSignals.length, 1);
  assert.equal(dialogSignals[0]?.aborted, true);
});

test("automatic provider failures back off instead of retrying every turn", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response("unavailable", { status: 503, statusText: "Unavailable" });
  };
  const mock = createMockPi();
  usageExtension(mock.pi);
  const { ctx } = createMockContext({
    model: openRouterModel,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
    },
  });

  mock.events.get("session_start")?.[0]?.({}, ctx);
  await settle();
  mock.events.get("turn_start")?.[0]?.({}, ctx);
  await settle();
  mock.events.get("turn_start")?.[0]?.({}, ctx);
  await settle();
  assert.equal(fetches, 1);
});

test("a current command supersedes an older automatic query for the same provider", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let activeKey = "account-a";
  let fetches = 0;
  let resolveOldFetch: (response: Response) => void = () => undefined;
  const oldFetch = new Promise<Response>((resolve) => {
    resolveOldFetch = resolve;
  });
  const response = (label: string, remaining: number) =>
    new Response(
      JSON.stringify({
        data: {
          label,
          limit: 100,
          limit_remaining: remaining,
          usage: 100 - remaining,
        },
      }),
      { status: 200 },
    );
  globalThis.fetch = async () => {
    fetches += 1;
    return fetches === 1 ? oldFetch : response("account-b", 40);
  };
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: openRouterModel,
    select: async () => "Close",
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: activeKey } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  mock.events.get("session_start")?.[0]?.({}, ctx);
  while (fetches < 1) await settle();
  activeKey = "account-b";
  await command.handler("", ctx);
  assert.equal(statuses.get("usage"), "openrouter $40.00 left");

  resolveOldFetch(response("account-a", 75));
  await settle();
  assert.equal(statuses.get("usage"), "openrouter $40.00 left");
});

test("session shutdown clears status through the shutdown context", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = usageFetch;
  const statuses = new Map<string, string | undefined>();
  const ui = {
    notify() {},
    setStatus(key: string, value: string | undefined) {
      statuses.set(key, value);
    },
  };
  const registry = {
    getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
    getAvailable: () => [openRouterModel],
    getAll: () => [openRouterModel],
  };
  const mock = createMockPi();
  usageExtension(mock.pi);
  const { ctx: startContext } = createMockContext({
    model: openRouterModel,
    ui,
    modelRegistry: registry,
  });
  const { ctx: shutdownContext } = createMockContext({
    model: openRouterModel,
    ui,
    modelRegistry: registry,
  });

  mock.events.get("session_start")?.[0]?.({}, startContext);
  await settle();
  assert.equal(statuses.get("usage"), "openrouter $75.00 left");
  mock.events.get("session_shutdown")?.[0]?.({}, shutdownContext);
  assert.equal(statuses.get("usage"), undefined);
});

test("a slow command cannot overwrite status after the selected model changes", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let openRouterFetches = 0;
  let resolveSlowFetch: (response: Response) => void = () => undefined;
  const slowFetch = new Promise<Response>((resolve) => {
    resolveSlowFetch = resolve;
  });
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/api/v1/key")) {
      openRouterFetches += 1;
      if (openRouterFetches === 1) return usageFetch(input);
      return slowFetch;
    }
    return usageFetch(input);
  };

  const choices = ["Refresh usage", "Close"];
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: openRouterModel,
    select: async () => choices.shift(),
    modelRegistry: {
      getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
      getAvailable: () => [openRouterModel, codexModel],
      getAll: () => [openRouterModel, codexModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  mock.events.get("session_start")?.[0]?.({}, ctx);
  await settle();
  const commandPromise = command.handler("", ctx);
  while (openRouterFetches < 2) await settle();
  Object.assign(ctx, { model: codexModel });
  mock.events.get("model_select")?.[0]?.({ model: codexModel }, ctx);
  await settle();
  assert.equal(statuses.get("usage"), "codex 80% 5h");

  resolveSlowFetch(await usageFetch("https://openrouter.ai/api/v1/key"));
  await commandPromise;
  assert.equal(statuses.get("usage"), "codex 80% 5h");
});

test("statusline follows runtime auth changes and clears for unsupported selected providers", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let activeKey = "account-a";
  let accountAQueries = 0;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    if (activeKey === "account-a") accountAQueries += 1;
    const remaining =
      activeKey === "account-a"
        ? accountAQueries === 1
          ? 75
          : accountAQueries === 2
            ? 20
            : accountAQueries === 3
              ? 10
              : 5
        : 40;
    return new Response(
      JSON.stringify({
        data: {
          label: activeKey,
          limit: 100,
          limit_remaining: remaining,
          limit_reset: "monthly",
          usage: 100 - remaining,
          usage_daily: 1,
          usage_weekly: 5,
          usage_monthly: 25,
        },
      }),
      { status: 200 },
    );
  };

  const mock = createMockPi();
  usageExtension(mock.pi);
  const { ctx, statuses } = createMockContext({
    model: openRouterModel,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: activeKey } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  mock.events.get("session_start")?.[0]?.({}, ctx);
  await settle();
  assert.equal(statuses.get("usage"), "openrouter $75.00 left");

  activeKey = "account-b";
  mock.events.get("turn_start")?.[0]?.({}, ctx);
  await settle();
  assert.equal(statuses.get("usage"), "openrouter $40.00 left");

  // Back on account-a inside the cache window: its own recent reading is
  // served rather than re-fetched. Reports are keyed by credential, so this
  // can never be another account's number.
  activeKey = "account-a";
  mock.events.get("turn_start")?.[0]?.({}, ctx);
  await settle();
  assert.equal(statuses.get("usage"), "openrouter $75.00 left");
  assert.equal(fetches, 2);

  mock.events.get("model_select")?.[0]?.(
    {
      model: {
        id: "x",
        name: "X",
        provider: "unsupported",
        baseUrl: "https://example.test",
      },
    },
    ctx,
  );
  assert.equal(statuses.get("usage"), undefined);

  mock.events.get("model_select")?.[0]?.({ model: openRouterModel }, ctx);
  await settle();
  assert.equal(statuses.get("usage"), "openrouter $75.00 left");
  assert.equal(fetches, 2);

  const proxyModel = { ...openRouterModel, baseUrl: "https://proxy.example.test/v1" };
  Object.assign(ctx, { model: proxyModel });
  mock.events.get("model_select")?.[0]?.({ model: proxyModel }, ctx);
  await settle();
  assert.equal(statuses.get("usage"), "auth unavailable");

  Object.assign(ctx, { model: openRouterModel });
  mock.events.get("model_select")?.[0]?.({ model: openRouterModel }, ctx);
  await settle();
  assert.equal(statuses.get("usage"), "openrouter $75.00 left");
  assert.equal(fetches, 2);
});

test("a refresh leaves the current reading on screen instead of blinking", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = usageFetch;

  const writes: Array<string | undefined> = [];
  const mock = createMockPi();
  usageExtension(mock.pi);
  const { ctx } = createMockContext({
    model: openRouterModel,
    ui: {
      notify() {},
      setStatus(_key: string, value: string | undefined) {
        writes.push(value);
      },
    },
    modelRegistry: {
      getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
      getAvailable: () => [openRouterModel, codexModel],
      getAll: () => [openRouterModel, codexModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  mock.events.get("session_start")?.[0]?.({}, ctx);
  await settle();
  assert.deepEqual(writes, ["checking", "openrouter $75.00 left"]);

  // Every turn refreshes. Within the cache window the answer is the text that
  // is already up, so a "checking" in between is a flicker and nothing else.
  writes.length = 0;
  mock.events.get("turn_start")?.[0]?.({}, ctx);
  await settle();
  assert.deepEqual([...new Set(writes)], ["openrouter $75.00 left"]);

  // Another model is a different question: its predecessor's numbers are not
  // an answer to it, so the placeholder is what belongs there.
  writes.length = 0;
  Object.assign(ctx, { model: codexModel });
  mock.events.get("model_select")?.[0]?.({ model: codexModel }, ctx);
  await settle();
  assert.deepEqual(writes, ["checking", "codex 80% 5h"]);
});

test("a report is never served across accounts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let activeKey = "account-a";
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    const remaining = activeKey === "account-a" ? 75 : 40;
    return new Response(
      JSON.stringify({
        data: { label: activeKey, limit: 100, limit_remaining: remaining, usage: 100 - remaining },
      }),
      { status: 200 },
    );
  };

  const mock = createMockPi();
  usageExtension(mock.pi);
  const { ctx, statuses } = createMockContext({
    model: openRouterModel,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: activeKey } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  mock.events.get("session_start")?.[0]?.({}, ctx);
  await settle();
  assert.equal(statuses.get("usage"), "openrouter $75.00 left");
  assert.equal(fetches, 1);

  // The credential changed, so the cached report belongs to another account
  // and must not be reused: a fresh query is the only correct answer.
  activeKey = "account-b";
  mock.events.get("turn_start")?.[0]?.({}, ctx);
  await settle();
  assert.equal(statuses.get("usage"), "openrouter $40.00 left");
  assert.equal(fetches, 2);
});
