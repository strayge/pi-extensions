import assert from "node:assert/strict";
import test from "node:test";
import {
  awaitWithDeadline,
  fingerprintResolvedAuth,
  redactUsageError,
  sanitizeDisplayText,
  UsageCache,
} from "../src/core.ts";
import {
  adapterForProvider,
  queryProviderUsage,
  redeemCodexResetCredit,
  resolveUsageAuth,
  SUPPORTED_ADAPTERS,
} from "../src/query.ts";
import type { UsageReport } from "../src/types.ts";
import { createMockContext } from "./support.ts";

const report: UsageReport = {
  providerId: "openrouter",
  providerName: "OpenRouter",
  capturedAt: 1,
  source: "openrouter-key",
  semantics: { kind: "api-key", label: "API-key spend limits" },
  buckets: [],
  metrics: [{ id: "usage-total", label: "All-time usage", value: 1, unit: "usd" }],
};

function codexJwt(accountId: unknown): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

test("credential fingerprints are process-salted, deterministic, and do not expose secrets", () => {
  const auth = {
    apiKey: "sk-secret",
    headers: { Authorization: "Bearer header-secret", "X-Test": "value" },
  };
  const first = fingerprintResolvedAuth(auth, Buffer.alloc(32, 1));
  const same = fingerprintResolvedAuth(auth, Buffer.alloc(32, 1));
  const anotherProcess = fingerprintResolvedAuth(auth, Buffer.alloc(32, 2));
  const anotherAccount = fingerprintResolvedAuth({ apiKey: "different" }, Buffer.alloc(32, 1));

  assert.equal(first, same);
  assert.notEqual(first, anotherProcess);
  assert.notEqual(first, anotherAccount);
  assert.doesNotMatch(first, /secret/);
});

test("usage cache isolates identities, expires entries, and remains bounded", () => {
  const cache = new UsageCache(300_000, 4);
  cache.set("openrouter", "account-a", report, 1_000);

  assert.equal(cache.get("openrouter", "account-a", 1_001), report);
  assert.equal(cache.get("openrouter", "account-b", 1_001), undefined);
  assert.equal(cache.get("openai-codex", "account-a", 1_001), undefined);
  assert.equal(cache.get("openrouter", "account-a", 301_001), undefined);
  assert.equal(cache.size, 0);

  for (let index = 0; index < 10; index += 1) {
    cache.set("openrouter", `account-${index}`, report, 400_000 + index);
  }
  assert.equal(cache.size, 4);
  assert.equal(cache.get("openrouter", "account-0", 400_020), undefined);
  assert.equal(cache.get("openrouter", "account-9", 400_020), report);
  cache.clearProvider("openrouter");
  assert.equal(cache.size, 0);
});

test("end-to-end deadline bounds slow work and preserves caller cancellation", async () => {
  const never = new Promise<never>(() => undefined);
  const controller = new AbortController();
  await assert.rejects(
    () => awaitWithDeadline(never, controller.signal, 5, "resolving auth"),
    (error: unknown) => error instanceof Error && error.name === "TimeoutError",
  );

  const cancelled = new AbortController();
  const pending = awaitWithDeadline(never, cancelled.signal, 1_000, "resolving auth");
  cancelled.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("runtime auth rejects proxy origins and forwards only adapter-approved headers", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const proxyModel = {
    id: "proxy-model",
    name: "Proxy",
    provider: "openrouter",
    baseUrl: "https://proxy.example.test/v1",
  };
  const { ctx: proxyContext } = createMockContext({
    model: proxyModel,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "proxy-key" } }),
      getAvailable: () => [proxyModel],
      getAll: () => [proxyModel],
    },
  });
  await assert.rejects(
    () => resolveUsageAuth(proxyContext, adapter),
    /custom.*base URL|official/iu,
  );

  const officialModel = { ...proxyModel, baseUrl: "https://openrouter.ai/api/v1" };
  const { ctx: effectiveProxyContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "current-model-key" }),
      getProviderAuth: async () => ({
        auth: { apiKey: "proxy-key", baseUrl: "https://proxy.example.test/v1" },
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  await assert.rejects(
    () => resolveUsageAuth(effectiveProxyContext, adapter),
    /proxy-resolved.*official/iu,
  );

  const { ctx: officialContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: {
          apiKey: "official-key",
          headers: { "X-Proxy-Secret": "must-not-leak", "X-Title": "private-title" },
        },
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const auth = await resolveUsageAuth(officialContext, adapter);
  assert.deepEqual(auth?.headers, { Authorization: "Bearer official-key" });

  const { ctx: modelScopedContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "provider-default-key",
        headers: {
          Authorization: "Bearer current-model-key",
          "X-Model-Secret": "must-not-leak",
        },
      }),
      getProviderAuth: async () => ({ auth: { apiKey: "provider-default-key" } }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const modelScopedAuth = await resolveUsageAuth(modelScopedContext, adapter);
  assert.deepEqual(modelScopedAuth?.headers, { Authorization: "Bearer current-model-key" });
  assert.ok(modelScopedAuth?.secrets.includes("Bearer current-model-key"));
  assert.ok(!modelScopedAuth?.secrets.includes("must-not-leak"));

  const { ctx: modelKeyContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "current-model-key" }),
      getProviderAuth: async () => ({ auth: { apiKey: "provider-default-key" } }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const modelKeyAuth = await resolveUsageAuth(modelKeyContext, adapter);
  assert.deepEqual(modelKeyAuth?.headers, { Authorization: "Bearer current-model-key" });
});

test("Codex auth derives its account route from the active token and fingerprints it", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openai-codex");
  assert.ok(adapter);
  const model = {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  };
  const activeToken = codexJwt("workspace-active");
  const providerToken = codexJwt("workspace-default");
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        headers: {
          Authorization: `Bearer ${activeToken}`,
          "ChatGPT-Account-Id": "must-not-be-forwarded",
          "X-Model-Secret": "must-not-leak",
        },
      }),
      getProviderAuth: async () => ({ auth: { apiKey: providerToken } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const salt = Buffer.alloc(32, 7);
  const auth = await resolveUsageAuth(ctx, adapter, salt);
  const expectedHeaders = {
    Authorization: `Bearer ${activeToken}`,
    "ChatGPT-Account-Id": "workspace-active",
  };

  assert.deepEqual(auth?.headers, expectedHeaders);
  assert.equal(auth?.fingerprint, fingerprintResolvedAuth({ headers: expectedHeaders }, salt));
  assert.match(auth?.accountKey ?? "", /^[0-9a-f]{64}$/u);
  assert.notEqual(
    auth?.fingerprint,
    fingerprintResolvedAuth({ headers: { Authorization: `Bearer ${activeToken}` } }, salt),
  );
  assert.ok(auth?.secrets.includes("workspace-active"));
  assert.ok(!auth?.secrets.includes("must-not-be-forwarded"));
});

test("Codex auth omits account routing for opaque tokens and unsafe claims", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openai-codex");
  assert.ok(adapter);
  const model = {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  };
  for (const token of ["opaque-token", codexJwt("workspace\r\nX-Injected: yes")]) {
    const { ctx } = createMockContext({
      model,
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: token } }),
        getAvailable: () => [model],
        getAll: () => [model],
      },
    });

    const auth = await resolveUsageAuth(ctx, adapter, Buffer.alloc(32, 8));
    assert.deepEqual(auth?.headers, { Authorization: `Bearer ${token}` });
    assert.equal(auth?.accountKey, undefined);
  }
});

test("OpenAI subscription auth routes the current OAuth account without forwarding API keys", async () => {
  const adapter = adapterForProvider("openai");
  assert.ok(adapter);
  const model = {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  };
  const token = codexJwt("subscription-account");
  const contextFor = (source: string, modelToken = token) =>
    createMockContext({
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: modelToken }),
        getProviderAuth: async () => ({ auth: { apiKey: token }, source }),
        getAvailable: () => [model],
        getAll: () => [model],
      },
    }).ctx;

  const auth = await resolveUsageAuth(contextFor("OAuth"), adapter);
  assert.deepEqual(auth?.headers, {
    Authorization: `Bearer ${token}`,
    "ChatGPT-Account-Id": "subscription-account",
  });
  assert.match(auth?.accountKey ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(await resolveUsageAuth(contextFor("OPENAI_API_KEY"), adapter), undefined);
  await assert.rejects(
    () => resolveUsageAuth(contextFor("OAuth", "sk-model-override"), adapter),
    /overridden model authorization/,
  );
});

test("OpenAI OAuth labels cannot legitimize provider-wide authorization overrides", async () => {
  const adapter = adapterForProvider("openai");
  assert.ok(adapter);
  const model = {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  };
  for (const header of ["Authorization", "authorization"]) {
    const resolved = {
      apiKey: codexJwt("subscription-account"),
      headers: { [header]: "Bearer sk-provider-override" },
    };
    const { ctx } = createMockContext({
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, ...resolved }),
        getProviderAuth: async () => ({ auth: resolved, source: "OAuth" }),
        getAvailable: () => [model],
        getAll: () => [model],
      },
    });
    await assert.rejects(() => resolveUsageAuth(ctx, adapter), /overridden provider authorization/);
  }
});

test("OpenAI subscription auth rejects configured and resolved proxy origins", async () => {
  const adapter = adapterForProvider("openai");
  assert.ok(adapter);
  const model = {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  };
  for (const proxyAt of ["model", "model-auth", "provider-auth"]) {
    const { ctx } = createMockContext({
      model: {
        ...model,
        baseUrl: proxyAt === "model" ? "https://proxy.example.test/v1" : model.baseUrl,
      },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "token",
          ...(proxyAt === "model-auth" ? { baseUrl: "https://proxy.example.test/v1" } : {}),
        }),
        getProviderAuth: async () => ({
          auth: {
            apiKey: "token",
            ...(proxyAt === "provider-auth" ? { baseUrl: "https://proxy.example.test/v1" } : {}),
          },
          source: "OAuth",
        }),
        getAvailable: () => [model],
        getAll: () => [model],
      },
    });
    await assert.rejects(() => resolveUsageAuth(ctx, adapter), /official usage endpoint/);
  }
});

test("OpenAI subscription queries and saved resets preserve the selected provider identity", async (t) => {
  const adapter = adapterForProvider("openai");
  assert.ok(adapter);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    const payload = url.endsWith("/consume")
      ? { code: "reset", windows_reset: 1 }
      : url.endsWith("/rate-limit-reset-credits")
        ? { available_count: 1, credits: [{ status: "available", expires_at: null }] }
        : {
            rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
            rate_limit_reset_credits: { available_count: 1 },
          };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const model = {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  };
  const token = codexJwt("subscription-account");
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: token }, source: "OAuth" }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const auth = await resolveUsageAuth(ctx, adapter);
  assert.ok(auth);
  const result = await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000);
  assert.equal(result.providerId, "openai");
  assert.equal(result.providerName, "OpenAI");
  assert.deepEqual(result.metrics[0]?.resetExpirations, [{ kind: "never" }]);
  assert.deepEqual(
    await redeemCodexResetCredit(auth, "openai-reset", new AbortController().signal, 1_000),
    { code: "reset", windowsReset: 1 },
  );
  assert.deepEqual(requests, [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
  ]);
});

test("provider cancellation preserves AbortError identity", async () => {
  const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
  const adapter = {
    id: "test",
    displayName: "Test",
    semantics: { kind: "api-key" as const, label: "Test" },
    query: async () => {
      throw abort;
    },
  };
  const controller = new AbortController();
  await assert.rejects(
    () =>
      queryProviderUsage(
        adapter,
        {
          headers: { Authorization: "Bearer secret" },
          fingerprint: "fingerprint",
          secrets: ["secret"],
          model: {} as never,
        },
        controller.signal,
        10,
      ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("display sanitization strips terminal escapes, controls, and excessive text", () => {
  const sanitized = sanitizeDisplayText(
    "safe\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\nnext",
    20,
  );
  assert.equal(sanitized, "safelink next");
  assert.equal(sanitizeDisplayText("x".repeat(100), 10), "xxxxxxxxx…");
});

test("provider response reads are byte-bounded", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const auth = {
    headers: { Authorization: "Bearer secret" },
    fingerprint: "fingerprint",
    secrets: ["secret"],
    model: { ...report, baseUrl: "https://openrouter.ai/api/v1" } as never,
  };
  globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 200 });
  await assert.rejects(
    () => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000),
    /exceeded.*bytes|too large/iu,
  );

  globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 500 });
  await assert.rejects(
    () => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000),
    (error: unknown) =>
      error instanceof Error && error.message.length < 1_000 && /returned 500/.test(error.message),
  );
});

test("Codex queries reset-credit details only for a positive summary count", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openai-codex");
  assert.ok(adapter);
  const urls: string[] = [];
  const payloads = [
    { credits: { has_credits: false } },
    { rate_limit_reset_credits: { available_count: 0 } },
  ];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify(payloads.shift()), { status: 200 });
  };
  const auth = {
    headers: { Authorization: "Bearer codex-secret" },
    fingerprint: "fingerprint",
    secrets: ["codex-secret"],
    model: { baseUrl: "https://chatgpt.com/backend-api" } as never,
  };

  await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000);
  await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000);

  assert.deepEqual(urls, [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/wham/usage",
  ]);
});

test("Codex fetches reset-credit details with routed auth and rejects redirects", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openai-codex");
  assert.ok(adapter);
  const requests: Array<{
    url: string;
    authorization: string | undefined;
    accountId: string | undefined;
    redirect: RequestRedirect | undefined;
  }> = [];
  globalThis.fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    requests.push({
      url: String(input),
      authorization: headers?.Authorization,
      accountId: headers?.["ChatGPT-Account-Id"],
      redirect: init?.redirect,
    });
    const body =
      requests.length === 1
        ? { rate_limit_reset_credits: { available_count: 2 } }
        : {
            available_count: 1,
            credits: [{ status: "available", expires_at: "2027-07-17T00:00:00Z" }],
          };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const report = await queryProviderUsage(
    adapter,
    {
      headers: {
        Authorization: "Bearer codex-secret",
        "ChatGPT-Account-Id": "workspace-active",
      },
      fingerprint: "fingerprint",
      secrets: ["codex-secret", "workspace-active"],
      model: { baseUrl: "https://chatgpt.com/backend-api" } as never,
    },
    new AbortController().signal,
    1_000,
  );

  assert.deepEqual(requests, [
    {
      url: "https://chatgpt.com/backend-api/wham/usage",
      authorization: "Bearer codex-secret",
      accountId: "workspace-active",
      redirect: "error",
    },
    {
      url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      authorization: "Bearer codex-secret",
      accountId: "workspace-active",
      redirect: "error",
    },
  ]);
  assert.equal(report.metrics[0]?.value, 1);
  assert.deepEqual(report.metrics[0]?.resetExpirations, [
    { kind: "dated", expiresAt: Date.parse("2027-07-17T00:00:00Z") / 1_000 },
  ]);
});

test("Codex reset redemption posts one idempotent request with routed auth", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request:
    | {
        url: string;
        init: RequestInit | undefined;
      }
    | undefined;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
  };
  const outcome = await redeemCodexResetCredit(
    {
      headers: {
        Authorization: "Bearer codex-secret",
        "ChatGPT-Account-Id": "workspace-active",
      },
      fingerprint: "fingerprint",
      secrets: ["codex-secret", "workspace-active"],
      model: {
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
      } as never,
    },
    "redeem-request-123",
    new AbortController().signal,
    1_000,
  );

  assert.deepEqual(outcome, { code: "reset", windowsReset: 2 });
  assert.equal(
    request?.url,
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
  );
  assert.equal(request?.init?.method, "POST");
  assert.equal(request?.init?.redirect, "error");
  assert.deepEqual(request?.init?.headers, {
    Authorization: "Bearer codex-secret",
    "ChatGPT-Account-Id": "workspace-active",
    "User-Agent": "pi-usage",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    redeem_request_id: "redeem-request-123",
  });
});

test("Codex preserves the primary report when reset-credit details fail or time out", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openai-codex");
  assert.ok(adapter);
  const auth = {
    headers: { Authorization: "Bearer codex-secret" },
    fingerprint: "fingerprint",
    secrets: ["codex-secret"],
    model: { baseUrl: "https://chatgpt.com/backend-api" } as never,
  };

  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    if (requests % 2 === 1) {
      return new Response(JSON.stringify({ rate_limit_reset_credits: { available_count: 2 } }), {
        status: 200,
      });
    }
    if (requests === 2) return new Response("unavailable", { status: 503 });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  };

  const failed = await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000);
  assert.equal(failed.metrics[0]?.value, 2);
  assert.equal(failed.metrics[0]?.resetExpirations, undefined);

  const timedOut = await queryProviderUsage(adapter, auth, new AbortController().signal, 25);
  assert.equal(timedOut.metrics[0]?.value, 2);
  assert.equal(timedOut.metrics[0]?.resetExpirations, undefined);
});

test("Codex reset-credit details use only the primary request deadline remainder", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openai-codex");
  assert.ok(adapter);

  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const timeoutDelays: number[] = [];
  let timeoutCount = 0;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay?: number) => {
    timeoutCount += 1;
    timeoutDelays.push(delay ?? 0);
    if (timeoutCount === 2) queueMicrotask(callback);
    return timeoutCount as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);

  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    if (requests === 1) {
      now += 600;
      return new Response(JSON.stringify({ rate_limit_reset_credits: { available_count: 2 } }), {
        status: 200,
      });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  };

  const report = await queryProviderUsage(
    adapter,
    {
      headers: { Authorization: "Bearer codex-secret" },
      fingerprint: "fingerprint",
      secrets: ["codex-secret"],
      model: { baseUrl: "https://chatgpt.com/backend-api" } as never,
    },
    new AbortController().signal,
    1_000,
  );

  assert.deepEqual(timeoutDelays, [1_000, 400]);
  assert.equal(report.metrics[0]?.value, 2);
  assert.equal(report.metrics[0]?.resetExpirations, undefined);
});

test("caller cancellation during Codex reset-credit detail retrieval aborts the query", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openai-codex");
  assert.ok(adapter);
  let detailStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify({ rate_limit_reset_credits: { available_count: 1 } }), {
        status: 200,
      });
    }
    detailStarted();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  };
  const controller = new AbortController();
  const pending = queryProviderUsage(
    adapter,
    {
      headers: { Authorization: "Bearer codex-secret" },
      fingerprint: "fingerprint",
      secrets: ["codex-secret"],
      model: { baseUrl: "https://chatgpt.com/backend-api" } as never,
    },
    controller.signal,
    1_000,
  );
  await started;
  controller.abort();

  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("usage error redaction removes exact runtime auth and common token fields", () => {
  const redacted = redactUsageError(
    'Bearer common-token {"access_token":"json-token"} sk-secret header-secret',
    ["sk-secret", "header-secret"],
  );
  assert.doesNotMatch(redacted, /common-token|json-token|sk-secret|header-secret/);
  assert.match(redacted, /<redacted>/);
});
