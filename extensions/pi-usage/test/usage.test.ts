import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { LoadedHistory } from "../src/history.ts";
import type { UsageSnapshot } from "../src/types.ts";
import usageExtension from "../src/usage.ts";
import { createMockContext, createMockPi } from "./support.ts";

// An isolated agent dir keeps these lifecycle tests off the developer's real
// usage.json, and pinning the legacy preset keeps them asserting lifecycle
// rather than whatever the current default display happens to render.
const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "usage.json"), JSON.stringify({ version: 1, preset: "legacy" }));

initTheme("dark", false);

const emptyHistory: LoadedHistory = {
  now: Date.now(),
  calls: [],
  snapshots: [],
  warnings: [],
  subagents: [],
};

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
const opencodeGoModel = {
  id: "kimi-k2.5",
  name: "Kimi K2.5",
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
};

function codexJwt(accountId: string, signature: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.${signature}`;
}

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

test("pi-usage registers only usage with its existing lifecycle hooks", () => {
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
  assert.deepEqual(selections[0]?.options, [
    "Statistics",
    "Refresh usage",
    "Display options…",
    "Close",
  ]);
  assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("OpenAI ChatGPT login publishes subscription usage and saved-reset actions", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).endsWith("/rate-limit-reset-credits")
          ? { available_count: 1, credits: [{ status: "available", expires_at: null }] }
          : {
              rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
              rate_limit_reset_credits: { available_count: 1 },
            },
      ),
      { status: 200 },
    );
  const mock = createMockPi();
  usageExtension(mock.pi);
  const model = { ...codexModel, provider: "openai", baseUrl: "https://api.openai.com/v1" };
  const token = codexJwt("new-openai-account", "signature");
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model,
    select: async (title: string, options: string[]) => {
      assert.match(title, /OpenAI Usage · Current/);
      assert.ok(options.includes("Use one reset…"));
      return "Close";
    },
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: token }, source: "OAuth" }),
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderDisplayName: () => "OpenAI",
    },
  });
  const command = mock.commands.get("usage");
  assert.ok(command);
  await command.handler("", ctx);
  assert.equal(statuses.get("usage"), "codex 80% 5h");
  const entry = mock.entries[0];
  assert.ok(entry);
  assert.equal((entry.data as UsageSnapshot).report.providerId, "openai");
  assert.doesNotMatch(JSON.stringify(mock.entries), /new-openai-account|signature/);
});

test("OpenAI API keys and provider overrides never reach the ChatGPT usage endpoint", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    assert.fail("API keys must not be sent to ChatGPT");
  };
  const model = { ...codexModel, provider: "openai", baseUrl: "https://api.openai.com/v1" };
  for (const source of ["OPENAI_API_KEY", "OAuth"]) {
    const mock = createMockPi();
    usageExtension(mock.pi);
    const auth =
      source === "OAuth"
        ? { apiKey: "oauth-token", headers: { Authorization: "Bearer sk-api-key" } }
        : { apiKey: "sk-api-key" };
    const { ctx, statuses } = createMockContext({
      hasUI: true,
      mode: "rpc",
      model,
      select: async () => "Close",
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, ...auth }),
        getProviderAuth: async () => ({ auth, source }),
        getAvailable: () => [model],
        getAll: () => [model],
        getProviderDisplayName: () => "OpenAI",
      },
    });
    const command = mock.commands.get("usage");
    assert.ok(command);
    await command.handler("", ctx);
    assert.equal(statuses.get("usage"), "auth unavailable");
    assert.deepEqual(mock.entries, []);
  }
  assert.equal(fetches, 0);
});

test("opening and closing usage history reuses the fetched live outcome", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetches = 0;
  globalThis.fetch = (input) => {
    fetches += 1;
    return usageFetch(input);
  };

  const choices = ["Statistics", "Close"];
  const mock = createMockPi();
  let shown = 0;
  usageExtension(mock.pi, {
    load: async (_ctx, options) => {
      assert.equal(options.signal?.aborted, false);
      return emptyHistory;
    },
    show: async (_ctx, options) => {
      shown += 1;
      assert.equal(options.history, emptyHistory);
      assert.equal(options.live?.providerId, "openrouter");
      assert.equal(options.live?.providerName, "OpenRouter");
      assert.equal(options.live?.identity?.kind, "credential");
      assert.equal(options.live?.report.buckets[0]?.id, "credits");
      assert.equal(options.signal.aborted, false);
    },
  });
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: openRouterModel,
    select: async () => choices.shift(),
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  await command.handler("", ctx);

  assert.equal(fetches, 1);
  assert.equal(shown, 1);
  assert.equal(mock.entries.length, 1);
  assert.deepEqual(choices, []);
});

test("usage history loading is cancellable and returns silently to the action menu", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = usageFetch;

  const choices = ["Statistics", "Close"];
  let loadingAborted = false;
  let customCalls = 0;
  const mock = createMockPi();
  usageExtension(mock.pi, {
    load: async (_ctx, options) =>
      new Promise<LoadedHistory>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            loadingAborted = true;
            reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
          },
          { once: true },
        );
      }),
    show: async () => {
      assert.fail("cancelled history must not be shown");
    },
  });
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    mode: "tui",
    model: openRouterModel,
    select: async () => choices.shift(),
    custom: async (factory: unknown) =>
      new Promise<unknown>((resolve) => {
        customCalls += 1;
        assert.equal(
          Reflect.get(factory as object, Symbol.for("pi-extensions:input-dialog")),
          undefined,
        );
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
        if (customCalls === 2) setImmediate(() => component.handleInput("\u001b"));
      }),
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  await command.handler("", ctx);

  assert.equal(customCalls, 2);
  assert.equal(loadingAborted, true);
  assert.deepEqual(notifications, []);
  assert.deepEqual(choices, []);
});

test("a history read failure preserves live usage and reports no source details", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = usageFetch;

  const choices = ["Statistics", "Close"];
  const mock = createMockPi();
  usageExtension(mock.pi, {
    load: async () => {
      throw new Error("/home/private/sessions.jsonl: bearer-secret");
    },
    show: async () => {
      assert.fail("failed history must not be shown");
    },
  });
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx, notifications, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: openRouterModel,
    select: async () => choices.shift(),
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  await command.handler("", ctx);

  assert.equal(statuses.get("usage"), "openrouter $75.00 left");
  assert.deepEqual(notifications, [{ message: "Could not load usage history.", level: "warning" }]);
  assert.doesNotMatch(notifications[0]?.message ?? "", /private|bearer-secret/);
  assert.deepEqual(choices, []);
});

test("/usage fetches OpenCode Go usage with Pi's resolved bearer token", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request: { url: string; authorization: string | undefined } | undefined;
  globalThis.fetch = async (input, init) => {
    request = {
      url: String(input),
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
    };
    return new Response(
      JSON.stringify({
        usage: {
          rolling: { status: "ok", percent: 41, resetsAt: "2099-08-12T04:00:00Z" },
          weekly: { status: "ok", percent: 39, resetsAt: "2099-08-14T00:00:00Z" },
          monthly: { status: "ok", percent: 12, resetsAt: "2099-09-01T00:00:00Z" },
        },
      }),
      { status: 200 },
    );
  };

  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: opencodeGoModel,
    select: async () => "Close",
    modelRegistry: {
      getProviderAuth: async (provider: string) => {
        assert.equal(provider, "opencode-go");
        return { auth: { apiKey: "same-token-used-by-pi" } };
      },
      getAvailable: () => [opencodeGoModel],
      getAll: () => [opencodeGoModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  await command.handler("", ctx);

  assert.deepEqual(request, {
    url: "https://opencode.ai/zen/go/v1/usage",
    authorization: "Bearer same-token-used-by-pi",
  });
  assert.match(statuses.get("usage") ?? "", /^opencode-go /);
  assert.equal(mock.entries.length, 1);
  const snapshot = mock.entries[0]?.data as UsageSnapshot;
  assert.equal(snapshot.report.providerId, "opencode-go");
  assert.deepEqual(
    snapshot.report.buckets.map((bucket) => bucket.id),
    ["rolling", "weekly", "monthly"],
  );
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
  const menuOptions: string[][] = [];
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: codexModel,
    select: async (title: string, options: string[]) => {
      titles.push(title);
      menuOptions.push(options);
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
  assert.ok(!menuOptions[0]?.includes("Use one reset…"));

  await command.handler("", ctx);
  assert.equal(urls.length, 2);
  assert.match(titles[1] ?? "", /Usage limit resets:\s+1 available/);
  assert.equal(mock.entries.length, 1);

  await command.handler("", ctx);
  assert.deepEqual(urls, [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
  ]);
  assert.match(titles[3] ?? "", /Usage limit resets:\s+3 available/);
  assert.equal(mock.entries.length, 2);
  const snapshot = mock.entries[1]?.data as UsageSnapshot;
  assert.equal(snapshot.report.metrics[0]?.value, 3);
  assert.equal(snapshot.report.metrics[0]?.resetExpirations?.[0]?.kind, "never");
});

test("/usage confirms and redeems one backend-selected reset before refreshing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  let redeemed = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/consume")) {
      redeemed = true;
      return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
    }
    if (url.endsWith("/wham/usage")) {
      return new Response(
        JSON.stringify({ rate_limit_reset_credits: { available_count: redeemed ? 0 : 1 } }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        available_count: 1,
        credits: [{ status: "available", expires_at: null }],
      }),
      { status: 200 },
    );
  };

  const choices = ["Use one reset…", "Close"];
  const selections: string[][] = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: codexModel,
    select: async (_title: string, options: string[]) => {
      selections.push(options);
      return choices.shift();
    },
    confirm: async (title: string, message: string) => {
      confirmations.push({ title, message });
      return true;
    },
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: { apiKey: codexJwt("workspace-active", "test-signature") },
      }),
      getAvailable: () => [codexModel],
      getAll: () => [codexModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  await command.handler("", ctx);

  assert.deepEqual(selections[0], [
    "Statistics",
    "Refresh usage",
    "Use one reset…",
    "Display options…",
    "Close",
  ]);
  assert.deepEqual(selections[1], ["Statistics", "Refresh usage", "Display options…", "Close"]);
  assert.match(confirmations[0]?.title ?? "", /Use one saved reset/);
  assert.match(confirmations[0]?.message ?? "", /cannot be undone/);
  const consumeRequest = requests.find((request) => request.url.endsWith("/consume"));
  assert.equal(consumeRequest?.init?.method, "POST");
  const body = JSON.parse(String(consumeRequest?.init?.body)) as Record<string, unknown>;
  assert.match(String(body.redeem_request_id), /^[0-9a-f-]{36}$/u);
  assert.equal("credit_id" in body, false);
  assert.match(notifications.at(-1)?.message ?? "", /2 usage windows were reset/);
  assert.equal(mock.entries.length, 2);
  const snapshots = mock.entries.map((entry) => entry.data as UsageSnapshot);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.report.metrics[0]?.value),
    [1, 0],
  );
  assert.equal(snapshots[0]?.identity.kind, "account");
});

test("a second /usage flow cancels the first before it can redeem", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let postRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/consume")) {
      postRequests += 1;
      return new Response(JSON.stringify({ code: "reset" }), { status: 200 });
    }
    const body = url.endsWith("/wham/usage")
      ? { rate_limit_reset_credits: { available_count: 1 } }
      : {
          available_count: 1,
          credits: [{ status: "available", expires_at: null }],
        };
    return new Response(JSON.stringify(body), { status: 200 });
  };

  const choices = ["Use one reset…", "Close"];
  let confirmStarted = () => undefined;
  const confirmationStarted = new Promise<void>((resolve) => {
    confirmStarted = resolve;
  });
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: codexModel,
    select: async () => choices.shift(),
    confirm: async (_title: string, _message: string, options: { signal?: AbortSignal }) => {
      confirmStarted();
      return new Promise<boolean>((resolve) => {
        if (options.signal?.aborted) resolve(false);
        else options.signal?.addEventListener("abort", () => resolve(false), { once: true });
      });
    },
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: { apiKey: codexJwt("workspace-active", "test-signature") },
      }),
      getAvailable: () => [codexModel],
      getAll: () => [codexModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  const first = command.handler("", ctx);
  await confirmationStarted;
  const second = command.handler("", ctx);
  await Promise.all([first, second]);

  assert.equal(postRequests, 0);
});

test("/usage reuses an idempotency key when a reset outcome is unknown", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const redemptionBodies: string[] = [];
  const redemptionAuthorizations: string[] = [];
  let redemptionAttempts = 0;
  let usageRequests = 0;
  let activeToken = codexJwt("workspace-active", "first-signature");
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/consume")) {
      redemptionAttempts += 1;
      redemptionBodies.push(String(init?.body));
      redemptionAuthorizations.push(
        String((init?.headers as Record<string, string> | undefined)?.Authorization),
      );
      if (redemptionAttempts === 1) {
        activeToken = codexJwt("workspace-active", "refreshed-signature");
        throw new Error("connection lost");
      }
      return new Response(JSON.stringify({ code: "already_redeemed" }), { status: 200 });
    }
    if (url.endsWith("/wham/usage")) {
      usageRequests += 1;
      if (usageRequests === 2) return new Response("refresh failed", { status: 503 });
      return new Response(
        JSON.stringify({
          rate_limit_reset_credits: { available_count: redemptionAttempts >= 2 ? 0 : 1 },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        available_count: 1,
        credits: [{ status: "available", expires_at: null }],
      }),
      { status: 200 },
    );
  };

  const choices = ["Use one reset…", "Refresh usage", "Retry using reset…", "Close"];
  const selections: string[][] = [];
  const dialogSignals: AbortSignal[] = [];
  let confirmations = 0;
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: codexModel,
    select: async (_title: string, options: string[], opts: { signal: AbortSignal }) => {
      assert.equal(Reflect.get({ ...opts }, Symbol.for("pi-extensions:input-dialog")), false);
      dialogSignals.push(opts.signal);
      selections.push(options);
      return choices.shift();
    },
    confirm: async (_title: string, _message: string, opts: { signal: AbortSignal }) => {
      assert.equal(Reflect.get({ ...opts }, Symbol.for("pi-extensions:input-dialog")), false);
      assert.equal(opts.signal, dialogSignals[0]);
      confirmations += 1;
      return true;
    },
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: activeToken } }),
      getAvailable: () => [codexModel],
      getAll: () => [codexModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  await command.handler("", ctx);

  assert.equal(confirmations, 2);
  assert.equal(dialogSignals.length, 4);
  assert.ok(dialogSignals.every((signal) => signal === dialogSignals[0] && signal.aborted));
  assert.ok(selections[1]?.includes("Retry using reset…"));
  assert.ok(selections[2]?.includes("Retry using reset…"));
  assert.equal(redemptionBodies.length, 2);
  assert.equal(redemptionBodies[0], redemptionBodies[1]);
  assert.notEqual(redemptionAuthorizations[0], redemptionAuthorizations[1]);
  assert.match(notifications[0]?.message ?? "", /outcome is unknown/);
  assert.match(notifications[1]?.message ?? "", /already completed/);
});

test("/usage discards stale cached credits before a failed post-redemption refresh", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let usageRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/consume")) {
      return new Response(JSON.stringify({ code: "reset", windows_reset: 1 }), { status: 200 });
    }
    if (url.endsWith("/wham/usage")) {
      usageRequests += 1;
      if (usageRequests > 1) return new Response("refresh failed", { status: 503 });
      return new Response(JSON.stringify({ rate_limit_reset_credits: { available_count: 1 } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        available_count: 1,
        credits: [{ status: "available", expires_at: null }],
      }),
      { status: 200 },
    );
  };

  const choices = ["Use one reset…", "Close", "Close"];
  const selections: string[][] = [];
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: codexModel,
    select: async (_title: string, options: string[]) => {
      selections.push(options);
      return choices.shift();
    },
    confirm: async () => true,
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: { apiKey: codexJwt("workspace-active", "test-signature") },
      }),
      getAvailable: () => [codexModel],
      getAll: () => [codexModel],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: (provider: string) => provider,
    },
  });

  await command.handler("", ctx);
  await command.handler("", ctx);

  assert.equal(usageRequests, 2);
  assert.ok(!selections[1]?.includes("Use one reset…"));
  assert.ok(!selections[2]?.includes("Use one reset…"));
  assert.equal(statuses.get("usage"), "usage error");
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
      assert.equal(Reflect.get({ ...opts }, Symbol.for("pi-extensions:input-dialog")), false);
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
  assert.equal(mock.entries.length, 0);
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
  assert.equal(mock.entries.length, 1);
  const snapshot = mock.entries[0]?.data as UsageSnapshot;
  assert.equal(snapshot.report.accountLabel, "account-b");
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
  assert.deepEqual(
    mock.entries.map((entry) => (entry.data as UsageSnapshot).report.providerId),
    ["openrouter", "openai-codex"],
  );
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
