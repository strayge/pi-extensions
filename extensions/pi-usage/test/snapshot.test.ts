import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { createUsageSnapshot, SNAPSHOT_ENTRY_TYPE } from "../src/snapshot.ts";
import type { PiModel, ResolvedUsageAuth, UsageReport, UsageSnapshot } from "../src/types.ts";
import usageExtension from "../src/usage.ts";
import { createMockContext, createMockPi } from "./support.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-snapshot-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));
initTheme("dark", false);

const codexModel = {
  id: "gpt-5.3-codex",
  name: "Codex",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
} as PiModel;
const openRouterModel = {
  id: "openai/gpt-4o",
  name: "GPT-4o",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
} as PiModel;
const report: UsageReport = {
  providerId: "openai-codex",
  providerName: "OpenAI Codex",
  capturedAt: 1_800_000_000_000,
  source: "codex-pi-auth",
  semantics: { kind: "consumer-subscription", label: "ChatGPT subscription limits" },
  buckets: [
    { id: "codex:primary", label: "Primary", used: 20, limit: 100, unit: "percent" },
    { id: "codex:secondary", label: "Weekly", used: 30, limit: 100, unit: "percent" },
  ],
  metrics: [{ id: "reset-credits", label: "Resets", value: 2 }],
  notes: ["Plan: pro"],
};
const auth: ResolvedUsageAuth = {
  apiKey: "private-token",
  headers: { Authorization: "Bearer private-token" },
  fingerprint: "process-local-fingerprint",
  secrets: ["private-token"],
  model: codexModel,
};

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("snapshots preserve normalized observations without serializing runtime credentials", () => {
  const snapshot = createUsageSnapshot(report, auth);
  assert.equal(snapshot.version, 1);
  assert.match(snapshot.observationId, /^[0-9a-f-]{36}$/);
  assert.equal(snapshot.modelId, codexModel.id);
  assert.deepEqual(snapshot.report, report);
  assert.equal(snapshot.identity.kind, "credential");
  assert.match(snapshot.identity.id, /^[0-9a-f]{24}$/);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private-token|process-local-fingerprint|Authorization/,
  );
  assert.notEqual(createUsageSnapshot(report, auth).observationId, snapshot.observationId);
});

test("credential identities survive cache salt changes but distinguish credentials and providers", () => {
  const identity = createUsageSnapshot(report, auth).identity;
  assert.deepEqual(
    createUsageSnapshot(report, { ...auth, fingerprint: "another-process-fingerprint" }).identity,
    identity,
  );
  assert.notDeepEqual(
    createUsageSnapshot(report, {
      ...auth,
      headers: { Authorization: "Bearer another-token" },
    }).identity,
    identity,
  );
  assert.notDeepEqual(
    createUsageSnapshot({ ...report, providerId: "opencode-go" }, auth).identity,
    identity,
  );
});

test("account identities use the short stable account key rather than a rotating credential", () => {
  const accountKey = "abcdef0123456789".repeat(4);
  const first = createUsageSnapshot(report, { ...auth, accountKey });
  const refreshed = createUsageSnapshot(report, {
    ...auth,
    accountKey,
    headers: { Authorization: "Bearer refreshed-token" },
  });
  assert.deepEqual(first.identity, { kind: "account", id: accountKey.slice(0, 24) });
  assert.deepEqual(refreshed.identity, first.identity);
});

test("parent and child providers persist in their own JSONL without entering model context", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const body = String(input).endsWith("/api/v1/key")
      ? { data: { usage: 12, limit: 100, limit_remaining: 88 } }
      : { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const sessionDir = join(agentDir, "sessions");
  const parent = SessionManager.create(agentDir, sessionDir);
  const child = SessionManager.create(agentDir, sessionDir, {
    parentSession: parent.getSessionFile(),
  });

  for (const [sessionManager, model] of [
    [parent, codexModel],
    [child, openRouterModel],
  ] as const) {
    const mock = createMockPi();
    mock.rawPi.appendEntry = (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
    };
    usageExtension(mock.pi);
    const { ctx } = createMockContext({
      mode: "print",
      model,
      sessionManager,
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: `${model.provider}-secret` } }),
        getAvailable: () => [model],
        getAll: () => [model],
      },
    });
    t.after(() => {
      mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    });
    mock.events.get("session_start")?.[0]?.({}, ctx);
    await settle();
    mock.events.get("turn_start")?.[0]?.({}, ctx);
    await settle();

    const snapshots = sessionManager.getEntries().filter((entry) => entry.type === "custom");
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.customType, SNAPSHOT_ENTRY_TYPE);
    const snapshot = snapshots[0]?.data as UsageSnapshot;
    assert.equal(snapshot.report.providerId, model.provider);
    assert.deepEqual(sessionManager.buildSessionContext().messages, []);

    // Pi defers a new file's first flush until an assistant message is present.
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-responses",
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const file = sessionManager.getSessionFile();
    assert.ok(file);
    const persisted = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const saved = persisted.filter((entry) => entry.customType === SNAPSHOT_ENTRY_TYPE);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].data.report.providerId, model.provider);
    assert.doesNotMatch(JSON.stringify(saved), /-secret/);
  }
  assert.equal(child.getHeader()?.parentSession, parent.getSessionFile());
});

test("snapshot write failures warn once without hiding usage or forcing network retries", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return new Response(JSON.stringify({ data: { usage: 12 } }), { status: 200 });
  });
  const mock = createMockPi();
  let writes = 0;
  mock.rawPi.appendEntry = () => {
    writes += 1;
    throw new Error("private filesystem details");
  };
  usageExtension(mock.pi);
  const choices = ["Close", "Refresh usage", "Close", "Close"];
  const { ctx, notifications, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: openRouterModel,
    select: async () => choices.shift(),
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "secret" } }),
      getAvailable: () => [openRouterModel],
      getAll: () => [openRouterModel],
    },
  });
  const command = mock.commands.get("usage");
  assert.ok(command);
  await command.handler("", ctx);
  await command.handler("", ctx);
  await command.handler("", ctx);
  assert.equal(fetches, 2);
  assert.equal(writes, 2);
  assert.match(statuses.get("usage") ?? "", /^openrouter /);
  assert.deepEqual(notifications, [
    { message: "Could not save usage snapshot to the session.", level: "warning" },
  ]);
});
