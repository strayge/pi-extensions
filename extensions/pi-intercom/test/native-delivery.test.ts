import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IntercomClient } from "../src/broker/client.ts";
import {
  INTERCOM_SESSION_IDENTITY_EVENT,
  type IntercomSessionIdentityRequestV1,
} from "../src/extension-api.ts";
import type { Message, MessageReceipt, SessionInfo } from "../src/types.ts";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("native loader delivery wakes, steers headless work, and defers quiet context", {
  timeout: 30_000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-native-"));
  const previousEnv = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_INTERCOM_SCOPE_ID = "native-fixture";
  process.env.PI_INTERCOM_RECEIPT_TIMEOUT_MS = "1000";
  Object.assign(process.env, {
    PI_SUBAGENT_ORCHESTRATOR_TARGET: "legacy-supervisor",
    PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: "legacy-supervisor-id",
    PI_SUBAGENT_RUN_ID: "legacy-run",
    PI_SUBAGENT_CHILD_AGENT: "legacy-worker",
    PI_SUBAGENT_CHILD_INDEX: "0",
    PI_SUBAGENT_INTERCOM_SESSION_NAME: "legacy-child",
  });
  for (const key of [
    "PI_INTERCOM_TRANSPORT",
    "PI_INTERCOM_TCP",
    "PI_INTERCOM_STABLE_ID",
    "PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR",
    "WMUX_SURFACE_ID",
    "CMUX_SURFACE_ID",
    "TMUX_PANE",
  ]) {
    delete process.env[key];
  }
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Network forbidden in the native delivery fixture");
  });
  const broker = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../src/broker/broker.ts", import.meta.url)),
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const closed = once(broker, "exit");
  const sender = new IntercomClient();
  let session: AgentSession | undefined;
  let requestGate: ReturnType<typeof deferred> | undefined;
  let compactionGate: ReturnType<typeof deferred> | undefined;
  let compactionFailureGate: ReturnType<typeof deferred> | undefined;
  let compactionFailureStarted: ReturnType<typeof deferred> | undefined;
  t.after(async () => {
    requestGate?.resolve();
    compactionGate?.resolve();
    compactionFailureGate?.resolve();
    try {
      await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session?.dispose();
      await sender.disconnect();
      if (broker.exitCode === null && broker.signalCode === null) broker.kill();
      await closed;
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key];
      }
      Object.assign(process.env, previousEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Broker startup: ${stderr}`)), 10_000);
    let stdout = "";
    broker.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("Intercom broker started")) {
        clearTimeout(timer);
        resolve();
      }
    });
    broker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    broker.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Broker exited: ${stderr}`));
    });
  });

  // Select the host package without bypassing its extension loader or import mappings.
  const sdkRoot =
    process.env.PI_INTERCOM_TEST_SDK_ROOT ??
    fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const require = createRequire(join(sdkRoot, "package.json"));
  const sdk = (await import(
    pathToFileURL(join(sdkRoot, "dist/index.js")).href
  )) as typeof import("@earendil-works/pi-coding-agent");
  const aiRoot = (require.resolve.paths("@earendil-works/pi-ai") ?? [])
    .map((path) => join(path, "@earendil-works/pi-ai"))
    .find((path) => existsSync(join(path, "package.json")));
  assert.ok(aiRoot, "Selected SDK must have an associated pi-ai package");
  const { getModel } = (await import(
    pathToFileURL(join(aiRoot, "dist/compat.js")).href
  )) as typeof import("@earendil-works/pi-ai/compat");
  const { createAssistantMessageEventStream } = (await import(
    pathToFileURL(join(aiRoot, "dist/index.js")).href
  )) as typeof import("@earendil-works/pi-ai");
  t.diagnostic(`Pi ${sdk.VERSION}; file-based DefaultResourceLoader`);
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey("openai", "fixture-only");
  const model = getModel("openai", "gpt-4o");
  assert.ok(model);
  const fixtureResponse = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  });
  const eventBus = sdk.createEventBus();
  eventBus.on(INTERCOM_SESSION_IDENTITY_EVENT, (payload) => {
    (payload as IntercomSessionIdentityRequestV1).claim("native-receiver");
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  let context!: ExtensionContext;
  let compactionStarted: ReturnType<typeof deferred> | undefined;
  const intercomPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    eventBus,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [intercomPath],
    extensionFactories: [
      {
        name: "delayed-compaction-failure",
        factory: (pi) => {
          pi.on("session_compact_failed", async () => {
            const gate = compactionFailureGate;
            if (!gate) return;
            compactionFailureStarted?.resolve();
            await gate.promise;
          });
        },
      },
      {
        name: "native-session-fixture",
        factory: (pi) => {
          pi.on("session_start", (_event, ctx) => {
            context = ctx;
          });
          pi.on("session_before_compact", async () => {
            compactionStarted?.resolve();
            await compactionGate?.promise;
            return { cancel: true };
          });
        },
      },
    ],
    extensionsOverride: (base) => {
      const first = base.extensions.find(
        (entry) => entry.path === "<inline:delayed-compaction-failure>",
      );
      assert.ok(first);
      return {
        ...base,
        extensions: [first, ...base.extensions.filter((entry) => entry !== first)],
      };
    },
    systemPrompt: "Deterministic delivery fixture.",
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const loadedIntercom = resourceLoader
    .getExtensions()
    .extensions.find((entry) => entry.path === intercomPath);
  assert.ok(loadedIntercom);
  // Inspect registrations, not the session's filtered active tool set.
  assert.deepEqual([...loadedIntercom.tools.keys()], ["intercom"]);
  assert.equal(loadedIntercom.tools.has("contact_supervisor"), false);
  assert.deepEqual(
    resourceLoader.getExtensions().extensions.map((entry) => entry.path),
    ["<inline:delayed-compaction-failure>", intercomPath, "<inline:native-session-fixture>"],
  );
  const created = await sdk.createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
    modelRuntime: runtime,
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(dir),
    tools: ["intercom"],
  });
  session = created.session;
  const errors: string[] = [];
  const requests: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let requestStarted: ReturnType<typeof deferred> | undefined;
  session.agent.streamFunction = (_model, modelContext, options) => {
    const stream = createAssistantMessageEventStream();
    requests.push(JSON.stringify(modelContext.messages));
    signals.push(options?.signal);
    const gate = requestGate?.promise ?? Promise.resolve();
    requestStarted?.resolve();
    void gate.then(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: fixtureResponse("fixture done"),
      });
    });
    // Installed hosts can have separate pi-ai class identities with the same stream protocol.
    return stream as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
  };
  await session.bindExtensions({
    onError: (error) => {
      errors.push(error.error);
    },
  });
  assert.ok(context);
  assert.equal(context.hasUI, false);
  await sender.connect(
    {
      name: "native-sender",
      cwd: dir,
      model: "test",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    },
    "native-sender",
  );
  const receipts: MessageReceipt[] = [];
  sender.on("message_receipt", (_from, receipt: MessageReceipt) => {
    receipts.push(receipt);
  });
  const replies: Message[] = [];
  sender.on("message", (_from: SessionInfo, message: Message) => {
    replies.push(message);
    sender.sendMessageReceipt({
      messageId: message.id,
      status: "accepted",
      timestamp: Date.now(),
      detail: "retained by fixture",
    });
  });
  const send = async (text: string, quiet = false) => {
    const result = await sender.send("native-receiver", { text, quiet });
    await sender.listSessions();
    return result;
  };

  const quietIdle = await send("quiet-idle-token", true);
  assert.equal(quietIdle.delivered, true);
  assert.equal(
    receipts.some((r) => r.messageId === quietIdle.id && r.status === "accepted"),
    true,
  );
  assert.equal(requests.length, 0);
  assert.equal(session.agent.hasQueuedMessages(), false);
  await session.prompt("normal user run");
  assert.ok(requests.at(-1)?.includes("quiet-idle-token"));
  await send("quiet-active-start-token", true);
  const beforeActive = requests.length;
  assert.equal(session.agent.hasQueuedMessages(), false);
  requestStarted = deferred();
  assert.equal((await send("active-idle-token")).delivered, true);
  await requestStarted.promise;
  await session.waitForIdle();
  assert.equal(requests.length, beforeActive + 1);
  assert.ok(requests.at(-1)?.includes("quiet-active-start-token"));
  assert.ok(requests.at(-1)?.includes("active-idle-token"));

  requestGate = deferred();
  requestStarted = deferred();
  const busy = session.prompt("busy headless task");
  await requestStarted.promise;
  const beforeQuiet = requests.length;
  await send("quiet-busy-token", true);
  assert.equal(requests.length, beforeQuiet);
  assert.equal(session.agent.hasQueuedMessages(), false);
  assert.equal((await send("active-busy-token")).delivered, true);
  assert.equal(session.agent.hasQueuedMessages(), true);
  const release = requestGate;
  requestGate = undefined;
  release.resolve();
  await busy;
  assert.equal(requests.length, beforeQuiet + 1);
  assert.ok(requests.at(-1)?.includes("active-busy-token"));
  assert.equal(requests.at(-1)?.includes("quiet-busy-token"), false);
  assert.equal(
    signals.some((signal) => signal?.aborted),
    false,
  );
  await session.prompt("next user turn");
  assert.ok(requests.at(-1)?.includes("quiet-busy-token"));
  assert.equal(replies.length, 0);

  requestGate = deferred();
  requestStarted = deferred();
  const quietOnlyRun = session.prompt("another busy task");
  await requestStarted.promise;
  const beforeQuietOnly = requests.length;
  await send("quiet-busy-active-start-token", true);
  assert.equal(session.agent.hasQueuedMessages(), false);
  const quietRelease = requestGate;
  requestGate = undefined;
  quietRelease.resolve();
  await quietOnlyRun;
  assert.equal(requests.length, beforeQuietOnly);
  requestStarted = deferred();
  await send("active-after-quiet-busy-token");
  await requestStarted.promise;
  await session.waitForIdle();
  assert.ok(requests.at(-1)?.includes("quiet-busy-active-start-token"));

  requestStarted = deferred();
  eventBus.emit("subagent:result-intercom", {
    to: "native-receiver",
    message: "local-relay-token",
    requestId: "local-relay",
  });
  await requestStarted.promise;
  await session.waitForIdle();
  assert.ok(requests.at(-1)?.includes("local-relay-token"));

  const tool = session.agent.state.tools.find((candidate) => candidate.name === "intercom");
  assert.ok(tool);
  const invalid = await tool.execute("invalid", {
    action: "send",
    cwd: join(dir, "missing"),
    openProjectPaneIfMissing: true,
    message: "must not create a pane",
    wait: true,
    quiet: true,
  });
  assert.match(JSON.stringify(invalid.content), /wait: true cannot be combined/);
  const ssh = await tool.execute("quiet-ssh", {
    action: "send",
    to: "worker@remote",
    message: "unsupported",
    quiet: true,
  });
  assert.match(JSON.stringify(ssh.content), /do not support.*quiet/);
  const sentQuiet = await tool.execute("quiet-send", {
    action: "send",
    to: "native-sender",
    message: "tool quiet transport",
    quiet: true,
    attachments: [{ type: "snippet", name: "fixture", content: "preserved" }],
  });
  assert.equal(sentQuiet.details.delivered, true);
  assert.equal(replies[0]?.quiet, true);
  assert.equal(replies[0]?.content.attachments?.[0]?.content, "preserved");

  const beforeWait = requests.length;
  const question = once(sender, "message", { signal: AbortSignal.timeout(3000) });
  let waitSettled = false;
  const waiting = tool
    .execute("quiet-response-wait", {
      action: "send",
      to: "native-sender",
      message: "answer without starting a model run",
      wait: true,
    })
    .then((result) => {
      waitSettled = true;
      return result;
    });
  const [, request] = (await question) as [SessionInfo, Message];
  await sender.send("native-receiver", {
    text: "unmatched-quiet-response-token",
    replyTo: "unrelated-thread",
    quiet: true,
  });
  assert.equal(waitSettled, false);
  const answer = await sender.send("native-receiver", {
    text: "wait-result-only-token",
    replyTo: request.id,
    quiet: true,
  });
  const waitResult = await waiting;
  assert.equal(answer.delivered, true);
  assert.equal(waitResult.details.replyMessageId, answer.id);
  assert.match(JSON.stringify(waitResult.content), /wait-result-only-token/);
  await sender.send("native-receiver", {
    text: "later-quiet-response-token",
    replyTo: request.id,
    quiet: true,
  });
  assert.equal(requests.length, beforeWait);
  assert.equal(session.agent.hasQueuedMessages(), false);
  await session.prompt("normal run after the quiet reply waiter");
  assert.equal(requests.length, beforeWait + 1);
  assert.equal(requests.at(-1)?.includes("wait-result-only-token"), false);
  assert.ok(requests.at(-1)?.includes("unmatched-quiet-response-token"));
  assert.ok(requests.at(-1)?.includes("later-quiet-response-token"));

  assert.equal(
    typeof context.modelRegistry.streamSimple,
    "function",
    "Selected SDK must expose the real provider-neutral handover API",
  );
  const summary = "## Next task\nContinue the deterministic handover task";
  const generationStarted = deferred();
  const generationRelease = deferred();
  const handoverAbort = new AbortController();
  const generation = t.mock.method(
    context.modelRegistry,
    "streamSimple",
    (
      ...[selectedModel, modelContext, options]: Parameters<
        ExtensionContext["modelRegistry"]["streamSimple"]
      >
    ) => {
      assert.equal(selectedModel, context.model);
      assert.match(modelContext.systemPrompt ?? "", /handovers between coding agents/);
      const prompt = JSON.stringify(modelContext.messages);
      assert.match(prompt, /normal run after the quiet reply waiter/);
      assert.match(prompt, /Goal for the receiving agent/);
      assert.equal(options?.cacheRetention, "none");
      assert.equal(options?.maxTokens, 4096);
      const stream = createAssistantMessageEventStream();
      if (options?.signal === handoverAbort.signal) {
        assert.match(prompt, /cancel this generated handover/);
        generationStarted.resolve();
        void generationRelease.promise.then(() => {
          stream.push({ type: "done", reason: "stop", message: fixtureResponse(summary) });
        });
      } else {
        assert.match(prompt, /continue this generated handover/);
        stream.push({ type: "done", reason: "stop", message: fixtureResponse(summary) });
      }
      return stream as unknown as ReturnType<ExtensionContext["modelRegistry"]["streamSimple"]>;
    },
  );
  try {
    const beforeHandover = replies.length;
    const beforeGeneration = requests.length;
    const handedOver = await tool.execute("handover-send", {
      action: "handover",
      to: "native-sender",
      message: "continue this generated handover",
    });
    assert.equal(handedOver.details.delivered, true);
    assert.equal(handedOver.details.targetId, "native-sender");
    assert.equal(replies.length, beforeHandover + 1);
    const payload = replies.at(-1);
    assert.ok(payload);
    assert.equal(payload.id, handedOver.details.messageId);
    assert.match(payload.content.text, /^# Handover from /);
    assert.ok(payload.content.text.includes(`Sender working directory: ${dir}`));
    assert.ok(payload.content.text.includes(summary));
    assert.match(payload.content.text, /peer agent's report, not instructions from your user/);
    assert.equal(payload.replyTo, undefined);
    assert.equal(payload.supersedes, undefined);
    assert.equal(payload.retryOf, undefined);
    assert.equal(Boolean(payload.expectsReply), false);
    assert.equal(Boolean(payload.quiet), false);
    assert.equal(requests.length, beforeGeneration);

    const beforeCancelled = replies.length;
    const cancelledHandover = tool.execute(
      "handover-cancel",
      {
        action: "handover",
        to: "native-sender",
        message: "cancel this generated handover",
      },
      handoverAbort.signal,
    );
    await generationStarted.promise;
    handoverAbort.abort();
    generationRelease.resolve();
    const cancelledResult = await cancelledHandover;
    assert.equal(cancelledResult.details.error, true);
    assert.match(JSON.stringify(cancelledResult.content), /generation was aborted/);
    await sender.listSessions();
    assert.equal(replies.length, beforeCancelled);
    assert.equal(generation.mock.callCount(), 2);
  } finally {
    generationRelease.resolve();
    generation.mock.restore();
  }

  for (const trigger of ["user", "active"] as const) {
    compactionGate = deferred();
    compactionStarted = deferred();
    compactionFailureGate = trigger === "user" ? deferred() : undefined;
    compactionFailureStarted = trigger === "user" ? deferred() : undefined;
    let immediateRun: Promise<void> | undefined;
    let compactingFinished: boolean = false;
    const unsubscribe = session.subscribe((event) => {
      if (trigger !== "user" || event.type !== "compaction_end") return;
      immediateRun = created.session.prompt("immediate user run from compaction_end");
      immediateRun.catch(() => undefined);
    });
    const compacting: Promise<void> = assert.rejects(session.compact(), /cancelled/).then(() => {
      compactingFinished = true;
    });
    try {
      await compactionStarted.promise;
      assert.equal(context.isIdle(), false);
      const beforeHold: number = requests.length;
      const nativeSetInterval = globalThis.setInterval;
      // Delay only the new hold timer so the next run cannot win by wall-clock luck.
      const holdInterval = t.mock.method(
        globalThis,
        "setInterval",
        (...args: Parameters<typeof setInterval>) => {
          assert.equal(args[1], 100);
          args[1] = 60_000;
          return nativeSetInterval(...args);
        },
        { times: 1 },
      );
      const heldQuiet = await send(`held-quiet-${trigger}-token`, true);
      holdInterval.mock.restore();
      assert.equal(holdInterval.mock.callCount(), 1);
      const cancelled = await send(`cancelled-held-${trigger}-token`);
      assert.equal(
        receipts.some((r) => r.messageId === heldQuiet.id && r.status === "queued"),
        true,
      );
      assert.equal(
        receipts.some((r) => r.messageId === heldQuiet.id && r.status === "accepted"),
        false,
      );
      const cancellation = once(sender, "message_receipt", {
        signal: AbortSignal.timeout(3000),
      });
      assert.equal((await sender.cancelMessage(cancelled.id)).delivered, true);
      await cancellation;
      assert.equal(
        receipts.some((r) => r.messageId === cancelled.id && r.status === "cancelled"),
        true,
      );
      compactionGate.resolve();
      if (trigger === "user") {
        assert.ok(compactionFailureStarted);
        await compactionFailureStarted.promise;
        assert.ok(immediateRun);
        await immediateRun;
        assert.equal(compactingFinished, false);
      } else {
        await compacting;
        assert.equal(requests.length, beforeHold);
        requestStarted = deferred();
        eventBus.emit("subagent:result-intercom", {
          to: "native-receiver",
          message: "active run immediately after safety hold",
          requestId: "active-after-hold",
        });
        await requestStarted.promise;
        await session.waitForIdle();
      }
      assert.equal(requests.length, beforeHold + 1);
      assert.ok(requests.at(-1)?.includes(`held-quiet-${trigger}-token`));
      assert.equal(requests.at(-1)?.includes(`cancelled-held-${trigger}-token`), false);
    } finally {
      unsubscribe();
      compactionGate.resolve();
      compactionFailureGate?.resolve();
      await compacting;
      compactionFailureGate = undefined;
      compactionFailureStarted = undefined;
    }
  }

  compactionGate = deferred();
  compactionStarted = deferred();
  const nextCompaction = assert.rejects(session.compact(), /cancelled/);
  await compactionStarted.promise;
  assert.equal((await send("held-active-token")).delivered, true);
  requestStarted = deferred();
  compactionGate.resolve();
  await nextCompaction;
  await requestStarted.promise;
  await session.waitForIdle();
  assert.ok(requests.at(-1)?.includes("held-active-token"));

  compactionGate = deferred();
  compactionStarted = deferred();
  const endingCompaction = assert.rejects(session.compact(), /cancelled/);
  await compactionStarted.promise;
  const expiring = await send("expired-held-token", true);
  await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  await sender.listSessions();
  assert.equal(
    receipts.some((r) => r.messageId === expiring.id && r.status === "expired"),
    true,
  );
  compactionGate.resolve();
  await endingCompaction;
  assert.equal(JSON.stringify(session.messages).includes("expired-held-token"), false);
  assert.equal(
    receipts.some((r) => r.messageId === expiring.id && r.status === "accepted"),
    false,
  );
  assert.deepEqual(errors, []);
  t.diagnostic(`Observed ${requests.length} deterministic requests; no network/model calls`);
});
