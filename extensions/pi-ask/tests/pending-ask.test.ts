import assert from "node:assert/strict";
import test from "node:test";
import { findLatestPayloadInCurrentBranch } from "../src/ask-payload-store.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import {
	ASK_PENDING_DISMISSED_ENTRY_TYPE,
	findPendingAskToolCall,
} from "../src/pending-ask.ts";
import {
	createRemoteAskRuntime,
	PI_ASK_COMPLETED_EVENT,
	PI_ASK_STARTED_EVENT,
	PI_ASK_SUBMIT_EVENT,
	type RemoteAskCompletedEvent,
	type RemoteAskStartedEvent,
} from "../src/remote-ask.ts";
import { registerPendingAskResume } from "../src/resume-pending-ask.ts";
import type { AskParams } from "../src/types.ts";

const CANVAS_RE = /Canvas/;

const params: AskParams = {
	title: "Choose engine",
	questions: [
		{
			id: "engine",
			prompt: "Chart engine?",
			options: [
				{ value: "canvas", label: "Canvas" },
				{ value: "svg", label: "SVG" },
			],
		},
	],
};

class TestEventBus {
	readonly events: Array<{ channel: string; data: unknown }> = [];
	private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		this.events.push({ channel, data });
		for (const handler of this.handlers.get(channel) ?? []) {
			handler(data);
		}
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? [];
		handlers.push(handler);
		this.handlers.set(channel, handlers);
		return () => {
			this.handlers.set(
				channel,
				(this.handlers.get(channel) ?? []).filter(
					(candidate) => candidate !== handler
				)
			);
		};
	}
}

function askToolCall(id: string, argumentsValue: unknown = params) {
	return assistantMessage([
		{ type: "toolCall", id, name: "ask_user", arguments: argumentsValue },
	]);
}

function assistantMessage(content: unknown[], stopReason = "toolUse") {
	return {
		type: "message",
		message: { role: "assistant", content, stopReason },
	};
}

function toolResult(toolCallId: string) {
	return {
		type: "message",
		message: { role: "toolResult", toolCallId, toolName: "ask_user" },
	};
}

function storedPayload(
	sourceEntryId: string,
	storedParams: unknown = params,
	version = 1
) {
	return {
		type: "custom",
		customType: "ask:payload",
		data: {
			version,
			source: "tool",
			params: storedParams,
			sourceEntryId,
			timestamp: 1,
		},
	};
}

function dismissed(toolCallId: string) {
	return {
		type: "custom",
		customType: ASK_PENDING_DISMISSED_ENTRY_TYPE,
		data: { toolCallId },
	};
}

function scannerContext(branch: unknown[]) {
	return { sessionManager: { getBranch: () => branch } } as never;
}

test("pending ask scan selects the newest unresolved ask_user call", () => {
	const pending = findPendingAskToolCall(
		scannerContext([
			askToolCall("call-1"),
			storedPayload("call-1"),
			askToolCall("call-2"),
			storedPayload("call-2"),
			toolResult("call-2"),
		])
	);

	assert.deepEqual(pending, { params, toolCallId: "call-1" });
});

test("pending ask scan uses the latest unresolved call within one assistant message", () => {
	const pending = findPendingAskToolCall(
		scannerContext([
			assistantMessage([
				{ type: "toolCall", id: "call-1", name: "ask_user", arguments: params },
				{ type: "toolCall", id: "other", name: "read", arguments: {} },
				{ type: "toolCall", id: "call-2", name: "ask_user", arguments: params },
			]),
		])
	);

	assert.equal(pending?.toolCallId, "call-2");
});

test("pending ask scan ignores tool-shaped content from failed assistant responses", () => {
	assert.equal(
		findPendingAskToolCall(
			scannerContext([
				assistantMessage(
					[
						{
							type: "toolCall",
							id: "failed-call",
							name: "ask_user",
							arguments: params,
						},
					],
					"error"
				),
			])
		),
		undefined
	);
});

test("pending ask scan prefers its valid persisted payload", () => {
	const persistedParams = { ...params, title: "Persisted title" };
	const pending = findPendingAskToolCall(
		scannerContext([
			askToolCall("call-1", { ...params, title: "Recorded title" }),
			storedPayload("call-1", persistedParams),
		])
	);

	assert.equal(pending?.params, persistedParams);
});

test("pending ask scan validates recorded arguments as payload fallback", () => {
	assert.deepEqual(
		findPendingAskToolCall(scannerContext([askToolCall("call-1")])),
		{ params, toolCallId: "call-1" }
	);
	assert.deepEqual(
		findPendingAskToolCall(
			scannerContext([
				askToolCall("call-2"),
				storedPayload("call-2", params, 99),
			])
		),
		{ params, toolCallId: "call-2" }
	);
	assert.deepEqual(
		findPendingAskToolCall(
			scannerContext([askToolCall("call-3"), storedPayload("call-3", {})])
		),
		{ params, toolCallId: "call-3" }
	);
	assert.equal(
		findPendingAskToolCall(
			scannerContext([askToolCall("call-4", { questions: [] })])
		),
		undefined
	);
	assert.equal(
		findPendingAskToolCall(scannerContext([askToolCall("call-5", {})])),
		undefined
	);
});

test("pending ask scan skips a newer invalid call for an older valid call", () => {
	const pending = findPendingAskToolCall(
		scannerContext([
			askToolCall("valid-call"),
			askToolCall("invalid-call", { questions: [] }),
		])
	);

	assert.deepEqual(pending, { params, toolCallId: "valid-call" });
});

test("pending ask scan ignores tool results and persisted dismissals", () => {
	assert.equal(
		findPendingAskToolCall(
			scannerContext([askToolCall("call-1"), toolResult("call-1")])
		),
		undefined
	);
	assert.equal(
		findPendingAskToolCall(
			scannerContext([askToolCall("call-2"), dismissed("call-2")])
		),
		undefined
	);
});

test("pending dismissal does not hide the payload from manual replay", () => {
	const lookup = findLatestPayloadInCurrentBranch(
		scannerContext([
			askToolCall("call-1"),
			storedPayload("call-1"),
			dismissed("call-1"),
		]),
		"tool"
	);

	assert.equal(lookup.data?.params, params);
});

test("pending ask resume scans only startup, resume, and fork TUI events", () => {
	let sessionStartHandler: ((event: any, ctx: any) => void) | undefined;
	const remoteAsk = createRemoteAskRuntime(new TestEventBus() as never);
	registerPendingAskResume(
		{
			on(event: string, handler: (event: any, ctx: any) => void) {
				if (event === "session_start") {
					sessionStartHandler = handler;
				}
			},
		} as never,
		remoteAsk
	);
	assert(sessionStartHandler);

	const branchReads: string[] = [];
	for (const reason of ["startup", "resume", "fork", "new", "reload"]) {
		sessionStartHandler(
			{ type: "session_start", reason },
			{
				mode: "tui",
				sessionManager: {
					getBranch() {
						branchReads.push(reason);
						return [];
					},
				},
			}
		);
	}

	sessionStartHandler(
		{ type: "session_start", reason: "startup" },
		{
			mode: "rpc",
			sessionManager: {
				getBranch() {
					branchReads.push("rpc");
					return [];
				},
			},
		}
	);

	assert.deepEqual(branchReads, ["startup", "resume", "fork"]);
	remoteAsk.disposeAll();
});

test("resumed submit persists dismissal, delivers an answer, and emits remote lifecycle events", {
	timeout: 2000,
}, async () => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const branch: unknown[] = [askToolCall("call-1"), storedPayload("call-1")];
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	const delivered: Array<{ text: string; options: unknown }> = [];
	let resolveDelivery: (() => void) | undefined;
	const delivery = new Promise<void>((resolve) => {
		resolveDelivery = resolve;
	});
	const harness = createResumeHarness(branch, remoteAsk, {
		idle: false,
		onSend(text, options) {
			delivered.push({ text, options });
			resolveDelivery?.();
		},
	});

	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		const started = data as RemoteAskStartedEvent;
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "submit-1",
			flowId: started.flowId,
			response: {
				kind: "answer",
				answers: { engine: { values: ["canvas"] } },
			},
		});
	});

	await harness.start("resume");
	await delivery;

	assert.deepEqual(harness.dismissedToolCallIds, ["call-1"]);
	assert.equal(delivered.length, 1);
	assert.match(delivered[0].text, CANVAS_RE);
	assert.deepEqual(delivered[0].options, { deliverAs: "followUp" });

	const started = findEvent<RemoteAskStartedEvent>(bus, PI_ASK_STARTED_EVENT);
	assert.equal(started.source, "ask:resume");
	assert.equal(started.toolCallId, "call-1");
	const completed = findEvent<RemoteAskCompletedEvent>(
		bus,
		PI_ASK_COMPLETED_EVENT
	);
	assert.equal(completed.source, "ask:resume");
	assert.equal(completed.result.cancelled, false);

	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

test("resumed cancel persists dismissal and does not reopen on a second resume", {
	timeout: 2000,
}, async () => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const branch: unknown[] = [askToolCall("call-1"), storedPayload("call-1")];
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	let resolveCancellation: (() => void) | undefined;
	const cancellation = new Promise<void>((resolve) => {
		resolveCancellation = resolve;
	});
	const harness = createResumeHarness(branch, remoteAsk, {
		onDismissNotice: () => resolveCancellation?.(),
	});

	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		const started = data as RemoteAskStartedEvent;
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "cancel-1",
			flowId: started.flowId,
			response: { kind: "cancel" },
		});
	});

	await harness.start("startup");
	await cancellation;
	await new Promise<void>((resolve) => setImmediate(resolve));
	await harness.start("resume");
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.deepEqual(harness.dismissedToolCallIds, ["call-1"]);
	assert.equal(harness.sentMessages.length, 0);
	assert.equal(
		bus.events.filter((event) => event.channel === PI_ASK_STARTED_EVENT).length,
		1
	);
	const completed = findEvent<RemoteAskCompletedEvent>(
		bus,
		PI_ASK_COMPLETED_EVENT
	);
	assert.equal(completed.source, "ask:resume");
	assert.equal(completed.result.cancelled, true);

	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

for (const reason of ["startup", "resume", "fork"]) {
	test(`pending ${reason} recovery opens once at discovery without blocking lifecycle dispatch`, {
		timeout: 2000,
	}, async (t) => {
		getAskConfigStore().setConfig(disabledNotificationConfig());
		const bus = new TestEventBus();
		const remoteAsk = createRemoteAskRuntime(bus as never);
		t.after(() => {
			remoteAsk.disposeAll();
			getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
		});
		const harness = createResumeHarness([askToolCall("call-1")], remoteAsk);

		await harness.startOnly(reason);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(harness.customMarkers, []);
		await harness.discover();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(harness.customMarkers, [true]);
		assert.deepEqual(harness.dismissedToolCallIds, []);
		await harness.discover();
		await harness.start(reason);
		assert.deepEqual(harness.customMarkers, [true]);

		cancelRecoveredAsk(bus);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(harness.dismissedToolCallIds, ["call-1"]);
	});
}

test("warm-config recovery waits for delayed later startup handlers", {
	timeout: 2000,
}, async (t) => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	await getAskConfigStore().ensureLoaded();
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	t.after(() => {
		remoteAsk.disposeAll();
		getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
	});
	const harness = createResumeHarness([askToolCall("call-1")], remoteAsk);
	let releaseStartup: (() => void) | undefined;
	const startupGate = new Promise<void>((resolve) => {
		releaseStartup = resolve;
	});
	let laterHookInstalled = false;
	harness.onStart(() => startupGate);
	harness.onStart(() => {
		laterHookInstalled = true;
		assert.deepEqual(harness.customMarkers, []);
	});

	const starting = harness.start("startup");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(laterHookInstalled, false);
	assert.deepEqual(harness.customMarkers, []);
	releaseStartup?.();
	await starting;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(laterHookInstalled, true);
	assert.deepEqual(harness.customMarkers, [true]);
	assert.deepEqual(harness.dismissedToolCallIds, []);
	cancelRecoveredAsk(bus);
	await new Promise<void>((resolve) => setImmediate(resolve));
});

test("new activations and shutdown discard unlaunched recovery; standalone startup still recovers", {
	timeout: 2000,
}, async (t) => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	t.after(() => {
		remoteAsk.disposeAll();
		getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
	});
	const branch: unknown[] = [askToolCall("call-1")];
	const harness = createResumeHarness(branch, remoteAsk);

	await harness.startOnly("startup");
	await harness.startOnly("reload");
	await harness.discover("reload");
	await harness.startOnly("resume");
	await harness.start("new");
	await harness.startOnly("fork");
	await harness.shutdown();
	await harness.discover();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.customMarkers, []);

	await harness.startOnly("startup");
	branch.splice(0, branch.length, askToolCall("call-2"));
	await harness.start("resume");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.customMarkers, [true]);
	assert.equal(
		findEvent<RemoteAskStartedEvent>(bus, PI_ASK_STARTED_EVENT).toolCallId,
		"call-2"
	);
	cancelRecoveredAsk(bus);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.dismissedToolCallIds, ["call-2"]);
});

function cancelRecoveredAsk(bus: TestEventBus) {
	const started = findEvent<RemoteAskStartedEvent>(bus, PI_ASK_STARTED_EVENT);
	bus.emit(PI_ASK_SUBMIT_EVENT, {
		version: 1,
		requestId: "cancel-recovery",
		flowId: started.flowId,
		response: { kind: "cancel" },
	});
}

function createResumeHarness(
	branch: unknown[],
	remoteAsk: ReturnType<typeof createRemoteAskRuntime>,
	options: {
		idle?: boolean;
		onDismissNotice?: () => void;
		onSend?: (text: string, sendOptions: unknown) => void;
	} = {}
) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const dismissedToolCallIds: string[] = [];
	const customMarkers: unknown[] = [];
	const sentMessages: Array<{ text: string; options: unknown }> = [];

	registerPendingAskResume(
		{
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			appendEntry(customType: string, data: { toolCallId: string }) {
				branch.push({ type: "custom", customType, data });
				dismissedToolCallIds.push(data.toolCallId);
			},
			sendUserMessage(text: string, sendOptions: unknown) {
				sentMessages.push({ text, options: sendOptions });
				options.onSend?.(text, sendOptions);
			},
		} as never,
		remoteAsk
	);
	const ctx = {
		cwd: process.cwd(),
		isIdle: () => options.idle ?? true,
		mode: "tui",
		sessionManager: { getBranch: () => branch },
		ui: {
			custom(callback: (...args: any[]) => any) {
				customMarkers.push(
					Reflect.get(callback, Symbol.for("pi-extensions:input-dialog"))
				);
				let component: { dispose(): void } | undefined;
				return new Promise((resolve) => {
					component = callback(
						{
							requestRender() {
								// Rendering is not needed for this lifecycle test.
							},
						},
						plainTheme(),
						{},
						resolve
					);
				}).finally(() => component?.dispose());
			},
			notify(message: string) {
				if (message.startsWith("Unanswered ask_user form dismissed")) {
					options.onDismissNotice?.();
				}
			},
			setWorkingVisible() {
				// The harness only checks completion behavior.
			},
		},
	};

	async function dispatch(type: string, reason: string) {
		for (const handler of handlers.get(type) ?? []) {
			await handler({ type, reason, cwd: ctx.cwd }, ctx);
		}
	}

	return {
		customMarkers,
		dismissedToolCallIds,
		sentMessages,
		onStart(handler: () => unknown) {
			handlers.get("session_start")?.push(handler);
		},
		startOnly: (reason: string) => dispatch("session_start", reason),
		discover: (reason = "startup") => dispatch("resources_discover", reason),
		shutdown: () => dispatch("session_shutdown", "quit"),
		async start(reason: string) {
			await dispatch("session_start", reason);
			await dispatch("resources_discover", "startup");
		},
	};
}

function disabledNotificationConfig() {
	return {
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	};
}

function findEvent<T>(bus: TestEventBus, channel: string): T {
	const event = bus.events.find((candidate) => candidate.channel === channel);
	assert(event);
	return event.data as T;
}

function plainTheme() {
	return {
		bg(_color: string, text: string) {
			return text;
		},
		fg(_color: string, text: string) {
			return text;
		},
	};
}
