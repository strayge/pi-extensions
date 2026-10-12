import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { presetConfig } from "../src/config.ts";
import { formatUsageReport, formatUsageSegments, formatUsageStatusline } from "../src/format.ts";
import { normalizeAnthropicUsagePayload } from "../src/providers/anthropic.ts";
import { adapterForProvider, queryProviderUsage, resolveUsageAuth } from "../src/query.ts";
import type { ResolvedUsageAuth, UsageSnapshot } from "../src/types.ts";
import usageExtension from "../src/usage.ts";
import { createMockContext, createMockPi } from "./support.ts";

const model = {
  id: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
};
const token = "sk-ant-oat01-test-access-token";
const payload = {
  five_hour: { utilization: 41, resets_at: "2099-08-12T04:00:00Z" },
  seven_day: { utilization: 39, resets_at: "2099-08-14T00:00:00Z" },
  limits: [
    {
      kind: "weekly_scoped",
      percent: 70,
      resets_at: "2099-08-14T00:00:00Z",
      scope: { model: { display_name: "Opus" } },
    },
  ],
};

function authContext(source = "OAuth", modelToken = token) {
  return createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: modelToken }),
      getProviderAuth: async () => ({ auth: { apiKey: token }, source }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  }).ctx;
}

function requestAuth(): ResolvedUsageAuth {
  return {
    apiKey: token,
    headers: { Authorization: `Bearer ${token}` },
    fingerprint: "test-credential",
    secrets: [token, `Bearer ${token}`],
    model: model as ResolvedUsageAuth["model"],
  };
}

test("Anthropic usage accepts pi OAuth but never forwards API keys or environment-only tokens", async () => {
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  const auth = await resolveUsageAuth(authContext(), adapter);
  assert.deepEqual(auth?.headers, { Authorization: `Bearer ${token}` });
  assert.equal(auth?.accountKey, undefined);
  for (const source of ["stored credential", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]) {
    assert.equal(await resolveUsageAuth(authContext(source), adapter), undefined);
  }
  await assert.rejects(
    () => resolveUsageAuth(authContext("OAuth", "different-model-account"), adapter),
    /overridden model authorization/,
  );
});

test("Anthropic OAuth rejects provider and model authentication header overrides", async () => {
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  for (const headers of [
    { authorization: "Bearer different-account" },
    { "X-Api-Key": "sk-ant-different-account" },
    { Authorization: null },
  ]) {
    for (const overrideAt of ["provider", "model"]) {
      const { ctx } = createMockContext({
        model,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: token,
            ...(overrideAt === "model" ? { headers } : {}),
          }),
          getProviderAuth: async () => ({
            auth: { apiKey: token, ...(overrideAt === "provider" ? { headers } : {}) },
            source: "OAuth",
          }),
          getAvailable: () => [model],
          getAll: () => [model],
        },
      });
      await assert.rejects(() => resolveUsageAuth(ctx, adapter), /overridden.*authorization/);
    }
  }
});

test("Anthropic usage refuses configured and resolved proxy credentials", async () => {
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  const proxy = "https://proxy.example.test/v1";
  for (const proxyAt of ["model", "model-auth", "provider-auth"]) {
    const { ctx } = createMockContext({
      model: { ...model, ...(proxyAt === "model" ? { baseUrl: proxy } : {}) },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: token,
          ...(proxyAt === "model-auth" ? { baseUrl: proxy } : {}),
        }),
        getProviderAuth: async () => ({
          auth: { apiKey: token, ...(proxyAt === "provider-auth" ? { baseUrl: proxy } : {}) },
          source: "OAuth",
        }),
        getAvailable: () => [model],
        getAll: () => [model],
      },
    });
    await assert.rejects(() => resolveUsageAuth(ctx, adapter), /official usage endpoint/);
  }
});

test("Anthropic queries its OAuth usage endpoint with the required beta header", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.anthropic.com/api/oauth/usage");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method ?? "GET", "GET");
    assert.deepEqual(init?.headers, {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
      "User-Agent": "pi-usage",
    });
    return new Response(JSON.stringify(payload));
  };
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  const report = await queryProviderUsage(
    adapter,
    requestAuth(),
    new AbortController().signal,
    15_000,
  );
  assert.equal(report.providerId, "anthropic");
  assert.deepEqual(
    report.buckets.map((bucket) => bucket.used),
    [41, 39, 70],
  );
});

test("Anthropic requests cap their deadline at five seconds", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
  };
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  const pending = queryProviderUsage(adapter, requestAuth(), new AbortController().signal, 15_000);
  const rejection = assert.rejects(pending, /Timed out after 5s/);
  t.mock.timers.tick(4_999);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejection;
});

test("Anthropic endpoint errors redact tokens and caller cancellation stays an abort", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  globalThis.fetch = async () => new Response(`Rejected Bearer ${token}`, { status: 429 });
  await assert.rejects(
    () => queryProviderUsage(adapter, requestAuth(), new AbortController().signal, 5_000),
    (error: unknown) =>
      error instanceof Error && /429/.test(error.message) && !error.message.includes(token),
  );
  globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  const controller = new AbortController();
  const pending = queryProviderUsage(adapter, requestAuth(), controller.signal, 5_000);
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("Anthropic reports and statusline use the existing window display options", () => {
  const now = Date.parse("2099-08-12T00:00:00Z");
  const report = normalizeAnthropicUsagePayload(payload, now);
  const full = presetConfig("full");
  const text = formatUsageReport(report, "current", full, now);
  assert.match(text, /Anthropic Usage · Current/);
  assert.match(text, /Claude subscription limits/);
  assert.match(text, /5h limit:.*41% used.*in 4h/);
  assert.match(text, /Weekly \(Opus\) limit:.*70% used/);
  assert.match(
    formatUsageStatusline(report, undefined, full, now) ?? "",
    /^anthropic 5h .*41% 4h · weekly /,
  );
  assert.equal(
    formatUsageSegments(report, undefined, full, now)?.find((segment) => segment.text === "70%")
      ?.color,
    "warning",
  );
  const remaining = { ...presetConfig("minimal"), value: "remaining" as const };
  assert.equal(formatUsageStatusline(report, undefined, remaining, now), "anthropic 59% 4h");
  const hidden = presetConfig("compact");
  hidden.statusline.fields = [];
  assert.equal(formatUsageStatusline(report, undefined, hidden, now), undefined);
});

test("/usage caches Anthropic snapshots per pi credential and refreshes after account changes", async (t) => {
  initTheme("dark", false);
  const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-anthropic-test-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(join(agentDir, "usage.json"), JSON.stringify({ version: 1, preset: "minimal" }));
  let activeToken = token;
  const requests: string[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    return new Response(JSON.stringify(payload));
  };
  const mock = createMockPi();
  usageExtension(mock.pi);
  const command = mock.commands.get("usage");
  assert.ok(command);
  const titles: string[] = [];
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model,
    select: async (title: string) => {
      titles.push(title);
      return "Close";
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: activeToken }),
      getProviderAuth: async () => ({ auth: { apiKey: activeToken }, source: "OAuth" }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  await command.handler("", ctx);
  await command.handler("", ctx);
  assert.equal(requests.length, 1);
  assert.equal(mock.entries.length, 1);
  assert.match(statuses.get("usage") ?? "", /^anthropic 41%/);
  assert.match(titles[0] ?? "", /Anthropic Usage · Current/);
  const first = mock.entries[0]?.data as UsageSnapshot;
  assert.equal(first.report.providerId, "anthropic");
  assert.doesNotMatch(JSON.stringify(first), /sk-ant-oat01/);
  activeToken = "sk-ant-oat01-second-account";
  await command.handler("", ctx);
  assert.deepEqual(requests, [`Bearer ${token}`, `Bearer ${activeToken}`]);
  const second = mock.entries[1]?.data as UsageSnapshot;
  assert.notEqual(second.identity.id, first.identity.id);
});
