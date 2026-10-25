import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { SlotOptions, SlotSchemaDefinition } from "../src/statusline-slot.ts";
import type { UsageSnapshot } from "../src/types.ts";
import usageExtension from "../src/usage.ts";
import { createMockContext, createMockPi } from "./support.ts";

initTheme("dark", false);

const models = {
  openai: {
    id: "gpt-5.3-codex",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  },
  "openai-codex": {
    id: "gpt-5.3-codex",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  },
  anthropic: {
    id: "claude-opus-4-6",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
  },
  openrouter: {
    id: "openai/gpt-4o",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  "opencode-go": {
    id: "kimi-k2.5",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
  },
};
type ModelProvider = keyof typeof models;
type RequestRecord = { provider: string; authorization: string; signal?: AbortSignal | null };
type RegisteredSlot = {
  render: NonNullable<SlotSchemaDefinition["render"]>;
  defaults: SlotOptions;
};

const minimal: SlotOptions = {
  preset: "minimal",
  value: "remaining",
  "reset-time": false,
};

function response(provider: string, value?: number): Response {
  const payload =
    provider === "openrouter"
      ? {
          data: {
            limit: 100,
            limit_remaining: value ?? 75,
            usage: 100 - (value ?? 75),
            limit_reset: "monthly",
          },
        }
      : provider === "anthropic"
        ? { five_hour: { utilization: value ?? 41, resets_at: "2099-08-12T04:00:00Z" } }
        : provider === "opencode-go"
          ? {
              usage: Object.fromEntries(
                ["rolling", "weekly", "monthly"].map((window) => [
                  window,
                  { status: "ok", percent: value ?? 62, resetsAt: "2099-08-12T04:00:00Z" },
                ]),
              ),
            }
          : {
              rate_limit: {
                primary_window: { used_percent: value ?? 20, limit_window_seconds: 18_000 },
              },
            };
  return new Response(JSON.stringify(payload));
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup(
  t: TestContext,
  current: ModelProvider = "openai",
  fetchResponse: (request: RequestRecord) => Response | Promise<Response> = (request) =>
    response(request.provider),
) {
  const originalFetch = globalThis.fetch;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-multi-provider-"));
  const configFile = join(agentDir, "usage.json");
  writeFileSync(configFile, JSON.stringify({ version: 1, preset: "legacy" }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const requests: RequestRecord[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const provider =
      url.hostname === "chatgpt.com"
        ? "codex"
        : url.hostname === "api.anthropic.com"
          ? "anthropic"
          : url.hostname === "openrouter.ai"
            ? "openrouter"
            : "opencode-go";
    const request = {
      provider,
      authorization: new Headers(init?.headers).get("Authorization") ?? "",
      signal: init?.signal,
    };
    requests.push(request);
    return fetchResponse(request);
  };
  const credentials = new Map<string, string>(
    Object.keys(models).map((provider) => [provider, `${provider}-account-a`]),
  );
  const mock = createMockPi();
  const registrations: RegisteredSlot[] = [];
  mock.eventBus.on("statusline:register", (data) => {
    const slot = data as RegisteredSlot & { id: string; owner: string };
    if (slot.id === "usage" && slot.owner === "test-session") registrations.push(slot);
  });
  usageExtension(mock.pi);
  const { ctx, statuses } = createMockContext({
    model: models[current],
    modelRegistry: {
      getProviderAuth: async (provider: string) => {
        const apiKey = credentials.get(provider);
        return apiKey ? { auth: { apiKey }, source: "OAuth" } : undefined;
      },
      getAvailable: () => Object.values(models),
      getAll: () => Object.values(models),
      getProviderDisplayName: (provider: string) => provider,
    },
  });
  const event = (name: string, data: unknown = {}) => {
    for (const handler of mock.events.get(name) ?? []) handler(data, ctx);
  };
  const shutdown = () => event("session_shutdown");
  t.after(() => {
    shutdown();
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const instances = (options: SlotOptions[]) => {
    mock.eventBus.emit("statusline:instances", {
      id: "usage",
      owner: "test-session",
      instances: options.map((entry) => ({ options: entry })),
    });
  };
  const text = (options: SlotOptions = {}, preview = false): string | undefined => {
    const slot = registrations.at(-1);
    assert.ok(slot, "usage must announce its renderer for the session");
    const rendered = slot.render(options, { preview });
    if (typeof rendered === "string" || rendered === undefined) return rendered;
    const segments = Array.isArray(rendered) ? rendered : rendered.segments;
    return segments.map((segment) => segment.text).join("");
  };
  const snapshotProviders = () =>
    mock.entries.map((entry) => (entry.data as UsageSnapshot).report.providerId);
  event("session_start");
  return {
    mock,
    credentials,
    requests,
    registrations,
    statuses,
    configFile,
    instances,
    event,
    text,
    shutdown,
    snapshotProviders,
    select(provider: ModelProvider) {
      Object.assign(ctx, { model: models[provider] });
      event("model_select", { model: models[provider] });
    },
  };
}

test("only current usage is queried by default; duplicate pins share refresh and never record snapshots", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const runtime = setup(t, "opencode-go");
  await settle();
  assert.deepEqual(
    runtime.requests.map((request) => request.provider),
    ["opencode-go"],
  );
  assert.deepEqual(runtime.snapshotProviders(), ["opencode-go"]);

  runtime.instances([{ provider: "current" }]);
  await settle();
  assert.equal(runtime.requests.length, 1);
  const before = readFileSync(runtime.configFile, "utf8");
  runtime.instances([{ provider: "codex" }, { provider: "codex", preset: "full" }]);
  await settle();
  const pins = () => runtime.requests.filter((request) => request.provider === "codex");
  assert.equal(pins().length, 1);
  assert.equal(pins()[0]?.authorization, "Bearer openai-account-a");
  assert.equal(readFileSync(runtime.configFile, "utf8"), before);
  assert.deepEqual(runtime.snapshotProviders(), ["opencode-go"]);

  t.mock.timers.tick(5 * 60 * 1_000);
  await settle();
  assert.equal(pins().length, 2);
  runtime.credentials.delete("openai");
  runtime.event("turn_start");
  await settle();
  assert.equal(pins().at(-1)?.authorization, "Bearer openai-codex-account-a");
  assert.equal(pins().length, 3);
  assert.deepEqual(runtime.snapshotProviders(), ["opencode-go"]);
});

test("current and fixed placements follow model switches, hiding only the matching logical provider", async (t) => {
  const runtime = setup(t);
  await settle();
  const providers = ["codex", "anthropic", "opencode-go"];
  runtime.instances([
    { provider: "current" },
    ...providers.map((provider) => ({ provider, "hide-when-current": true })),
  ]);
  await settle();
  for (const current of ["openai", "openai-codex", "anthropic", "opencode-go"] as const) {
    runtime.select(current);
    await settle();
    const logical = current.startsWith("openai") ? "codex" : current;
    assert.match(runtime.text(minimal) ?? "", new RegExp(`^${logical} `));
    const visible = providers.filter(
      (provider) => runtime.text({ ...minimal, provider, "hide-when-current": true }) !== undefined,
    );
    assert.deepEqual(
      visible,
      providers.filter((provider) => provider !== logical),
    );
    for (const provider of visible) {
      assert.match(
        runtime.text({ ...minimal, provider, "hide-when-current": true }) ?? "",
        new RegExp(`^${provider} `),
      );
    }
    assert.equal(
      runtime.text({ ...minimal, provider: logical, "hide-when-current": false }),
      runtime.text(minimal),
    );
  }
});

test("fixed placement styles neither change current rendering nor persist as current defaults", async (t) => {
  const runtime = setup(t);
  await settle();
  runtime.instances([{ provider: "anthropic" }]);
  await settle();
  const current = runtime.text();
  const config = readFileSync(runtime.configFile, "utf8");
  const fixed = { ...minimal, provider: "anthropic", value: "used" };
  assert.equal(runtime.text(fixed), "anthropic 41%");
  assert.equal(runtime.text(), current);
  runtime.mock.eventBus.emit("statusline:options", {
    id: "usage",
    owner: "test-session",
    instances: [{ options: fixed }],
  });
  assert.equal(runtime.text(), current);
  assert.equal(readFileSync(runtime.configFile, "utf8"), config);

  runtime.mock.eventBus.emit("statusline:options", {
    id: "usage",
    owner: "test-session",
    instances: [
      { options: fixed },
      { options: { ...minimal, provider: "current", value: "remaining" } },
    ],
  });
  assert.equal(runtime.text(), "codex 80%");
  assert.equal(runtime.text(fixed), "anthropic 41%");
});

test("a slow pin and a failed pin do not block another provider or the current snapshot", async (t) => {
  const slow = deferredResponse();
  const runtime = setup(t, "opencode-go", (request) => {
    if (request.provider === "codex") return slow.promise;
    if (request.provider === "anthropic") return new Response("Unavailable", { status: 503 });
    return response(request.provider);
  });
  runtime.instances([{ provider: "codex" }, { provider: "anthropic" }, { provider: "openrouter" }]);
  await settle();
  assert.equal(runtime.text({ ...minimal, provider: "openrouter" }), "openrouter $75.00 left");
  assert.match(runtime.text({ provider: "anthropic" }) ?? "", /anthropic .*error/);
  assert.doesNotMatch(runtime.text({ provider: "codex" }) ?? "", /80%/);
  assert.match(runtime.text(minimal) ?? "", /^opencode-go /);
  assert.deepEqual(runtime.snapshotProviders(), ["opencode-go"]);
  slow.resolve(response("codex"));
  await settle();
  assert.equal(runtime.text({ ...minimal, provider: "codex" }), "codex 80%");
  assert.deepEqual(runtime.snapshotProviders(), ["opencode-go"]);
});

test("removed pins and shutdown discard late responses without publishing or populating the cache", async (t) => {
  const removed = deferredResponse();
  const stopped = deferredResponse();
  let codexQueries = 0;
  const runtime = setup(t, "opencode-go", (request) => {
    if (request.provider === "codex" && ++codexQueries === 1) return removed.promise;
    if (request.provider === "anthropic") return stopped.promise;
    return response(request.provider);
  });
  await settle();
  runtime.instances([{ provider: "codex" }]);
  await settle();
  runtime.instances([]);
  const registrations = runtime.registrations.length;
  assert.equal(
    runtime.requests.find((request) => request.provider === "codex")?.signal?.aborted,
    true,
  );
  removed.resolve(response("codex", 99));
  await settle();
  assert.equal(runtime.registrations.length, registrations);
  runtime.instances([{ provider: "codex" }]);
  await settle();
  assert.equal(codexQueries, 2);
  assert.equal(runtime.text({ ...minimal, provider: "codex" }), "codex 80%");

  runtime.instances([{ provider: "anthropic" }]);
  await settle();
  runtime.shutdown();
  const afterShutdown = runtime.registrations.length;
  stopped.resolve(response("anthropic", 99));
  await settle();
  assert.equal(
    runtime.requests.find((request) => request.provider === "anthropic")?.signal?.aborted,
    true,
  );
  assert.equal(runtime.registrations.length, afterShutdown);
  assert.equal(runtime.statuses.get("usage"), undefined);
  assert.doesNotMatch(runtime.text({ ...minimal, provider: "anthropic" }) ?? "", /1%/);
  assert.deepEqual(runtime.snapshotProviders(), ["opencode-go"]);
});

test("turn refreshes isolate pin credentials, including account changes during an outstanding request", async (t) => {
  const oldAccount = deferredResponse();
  const runtime = setup(t, "opencode-go", (request) => {
    if (request.provider !== "openrouter") return response(request.provider);
    if (request.authorization === "Bearer account-b") return oldAccount.promise;
    return response("openrouter", request.authorization === "Bearer account-c" ? 40 : 75);
  });
  runtime.instances([{ provider: "openrouter" }]);
  await settle();
  const options = { ...minimal, provider: "openrouter" };
  assert.equal(runtime.text(options), "openrouter $75.00 left");
  runtime.credentials.set("openrouter", "account-b");
  runtime.event("turn_start");
  await settle();
  runtime.credentials.set("openrouter", "account-c");
  runtime.event("turn_start");
  await settle();
  oldAccount.resolve(response("openrouter", 10));
  await settle();
  assert.equal(runtime.text(options), "openrouter $40.00 left");
  assert.deepEqual(
    runtime.requests
      .filter((request) => request.provider === "openrouter")
      .map((request) => request.authorization),
    ["Bearer openrouter-account-a", "Bearer account-b", "Bearer account-c"],
  );
  runtime.credentials.delete("openrouter");
  runtime.event("turn_start");
  await settle();
  assert.match(runtime.text(options) ?? "", /auth unavailable/);
  runtime.credentials.set("openrouter", "openrouter-account-a");
  runtime.event("turn_start");
  await settle();
  assert.equal(runtime.text(options), "openrouter $75.00 left");
  assert.equal(runtime.requests.filter((request) => request.provider === "openrouter").length, 3);
});

test("periodic current refreshes do not restart an outstanding periodic pin request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const initialCurrent = deferredResponse();
  const periodicPin = deferredResponse();
  let currentQueries = 0;
  let pinQueries = 0;
  const runtime = setup(t, "openai", (request) => {
    if (request.provider === "codex" && ++currentQueries === 1) return initialCurrent.promise;
    if (request.provider === "anthropic" && ++pinQueries > 1) return periodicPin.promise;
    return response(request.provider);
  });
  runtime.instances([{ provider: "anthropic" }]);
  await settle();
  t.mock.timers.tick(1_000);
  initialCurrent.resolve(response("codex"));
  await settle();
  t.mock.timers.tick(299_000);
  await settle();
  assert.equal(pinQueries, 2);
  const periodicRequest = runtime.requests
    .filter((request) => request.provider === "anthropic")
    .at(-1);
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(currentQueries, 2);
  assert.equal(pinQueries, 2);
  assert.equal(periodicRequest?.signal?.aborted, false);
  periodicPin.resolve(response("anthropic", 55));
  await settle();
  assert.equal(runtime.text({ ...minimal, provider: "anthropic" }), "anthropic 45%");
});

test("a pin-only cached reading cannot suppress history when its provider becomes current", async (t) => {
  const runtime = setup(t);
  await settle();
  runtime.instances([{ provider: "anthropic" }]);
  await settle();
  assert.deepEqual(runtime.snapshotProviders(), ["openai"]);
  assert.equal(runtime.requests.filter((request) => request.provider === "anthropic").length, 1);
  runtime.select("anthropic");
  await settle();
  assert.equal(runtime.requests.filter((request) => request.provider === "anthropic").length, 2);
  assert.deepEqual(runtime.snapshotProviders(), ["openai", "anthropic"]);
  runtime.event("turn_start");
  await settle();
  assert.equal(runtime.requests.filter((request) => request.provider === "anthropic").length, 2);
  assert.deepEqual(runtime.snapshotProviders(), ["openai", "anthropic"]);
});

test("render previews are query-free and show the requested provider's sample", async (t) => {
  const runtime = setup(t, "opencode-go");
  await settle();
  const before = runtime.requests.length;
  for (const provider of ["codex", "anthropic", "openrouter", "opencode-go"]) {
    const options = { ...minimal, provider };
    const text = runtime.text(options, true);
    assert.match(text ?? "", new RegExp(`^${provider} `));
    assert.match(text ?? "", provider === "openrouter" ? /\$/ : /%/);
    runtime.text({ ...options, value: "used", "bar-width": 7 }, true);
  }
  await settle();
  assert.equal(runtime.requests.length, before);
  assert.deepEqual(runtime.snapshotProviders(), ["opencode-go"]);
});
