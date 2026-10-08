import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import {
	applyRemoteAskResponse,
	createRemoteAskRuntime,
	PI_ASK_COMPLETED_EVENT,
	PI_ASK_STARTED_EVENT,
	PI_ASK_SUBMIT_EVENT,
	PI_ASK_SUBMIT_RESULT_EVENT,
	type RemoteAskCompletedEvent,
	type RemoteAskStartedEvent,
	type RemoteAskSubmitResultEvent,
} from "../src/remote-ask.ts";
import { createInitialState } from "../src/state/create.ts";
import { runAskFlow } from "../src/ui/controller.ts";

const UNKNOWN_APPROVE_VALUE_RE = /Unknown option value "approve"/;

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

test("remote answer response validates and serializes explicit option values", () => {
	const state = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
			},
		],
	});

	const result = applyRemoteAskResponse(state, {
		kind: "answer",
		answers: {
			decision: { values: ["yes"], note: "ship it" },
		},
	});

	assert.equal(result.ok, true);
	assert.equal(result.state.completed, true);
	assert.deepEqual(result.state.answers.decision, {
		selected: [{ value: "yes", label: "Yes", index: 1 }],
		note: "ship it",
		customSelected: undefined,
		customText: undefined,
		optionNotes: undefined,
	});
});

test("remote answer response replaces stale UI answers", () => {
	const state = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [{ value: "yes", label: "Yes" }],
			},
			{
				id: "stale",
				prompt: "Old answer?",
				options: [{ value: "old", label: "Old" }],
			},
		],
	});
	state.answers.stale = {
		selected: [{ value: "old", label: "Old", index: 1 }],
	};

	const result = applyRemoteAskResponse(state, {
		kind: "answer",
		answers: { decision: { values: ["yes"] } },
	});

	assert.equal(result.ok, true);
	assert.deepEqual(Object.keys(result.state.answers), ["decision"]);
});

test("remote answer response rejects guessed or unknown option values", () => {
	const state = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [{ value: "yes", label: "Yes" }],
			},
		],
	});

	const result = applyRemoteAskResponse(state, {
		kind: "answer",
		answers: { decision: { values: ["approve"] } },
	});

	assert.equal(result.ok, false);
	assert.equal(result.error, "invalid_answer");
	assert.match(result.message, UNKNOWN_APPROVE_VALUE_RE);
	assert.equal(result.state.completed, false);
});

test("remote cancel completes the flow as cancelled", () => {
	const state = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [{ value: "yes", label: "Yes" }],
			},
		],
	});

	const result = applyRemoteAskResponse(state, { kind: "cancel" });

	assert.equal(result.ok, true);
	assert.equal(result.state.completed, true);
	assert.equal(result.state.cancelled, true);
});

test("started event questions are cloned", async () => {
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	const questions = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [{ value: "yes", label: "Yes", recommended: true }],
			},
		],
	}).questions;

	remoteAsk.startFlow({
		source: "tool",
		questions,
		onSubmit: () => ({ ok: true }),
	});
	await new Promise((resolve) => setImmediate(resolve));

	const started = bus.events.find(
		(event) => event.channel === PI_ASK_STARTED_EVENT
	)?.data as RemoteAskStartedEvent;
	assert.equal(started.questions[0].options[0].recommended, true);
	started.questions[0].options[0].label = "Mutated";
	started.questions[0].options[0].recommended = false;

	assert.equal(questions[0].options[0].label, "Yes");
	assert.equal(questions[0].options[0].recommended, true);
});

test("remote runtime disposes active flows and submit listener", () => {
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	let submitCalls = 0;
	const flow = remoteAsk.startFlow({
		source: "tool",
		questions: createInitialState({
			questions: [
				{
					id: "decision",
					prompt: "Proceed?",
					options: [{ value: "yes", label: "Yes" }],
				},
			],
		}).questions,
		onSubmit: () => {
			submitCalls += 1;
			return { ok: true };
		},
	});
	remoteAsk.disposeAll();

	bus.emit(PI_ASK_SUBMIT_EVENT, {
		version: 1,
		requestId: "request-1",
		flowId: flow.flowId,
		response: {
			kind: "answer",
			answers: { decision: { values: ["yes"] } },
		},
	});

	assert.equal(submitCalls, 0);
	assert.equal(
		bus.events.some((event) => event.channel === PI_ASK_SUBMIT_RESULT_EVENT),
		false
	);
});

for (const kind of ["answer", "cancel"] as const) {
	test(`remote ${kind} resolves a marked ask flow and preserves lifecycle events`, async () => {
		getAskConfigStore().setConfig({
			...DEFAULT_ASK_CONFIG,
			notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
		});
		const bus = new TestEventBus();
		const remoteAsk = createRemoteAskRuntime(bus as never);
		let component:
			| { handleInput(data: string): void; dispose(): void }
			| undefined;

		bus.on(PI_ASK_STARTED_EVENT, (data) => {
			const event = data as RemoteAskStartedEvent;
			bus.emit(PI_ASK_SUBMIT_EVENT, {
				version: 1,
				requestId: "request-1",
				flowId: event.flowId,
				response:
					kind === "answer"
						? { kind, answers: { decision: { values: ["yes"] } } }
						: { kind },
			});
		});

		const result = await runAskFlow(
			{
				cwd: process.cwd(),
				mode: "tui",
				ui: {
					custom(callback: (...args: unknown[]) => unknown, options: unknown) {
						assert.equal(
							Reflect.get(callback, Symbol.for("pi-extensions:input-dialog")),
							true
						);
						assert.equal(options, undefined);
						return new Promise((resolve) => {
							component = callback(
								{
									requestRender() {
										// Rendering is not needed for this controller input test.
									},
								},
								plainTheme(),
								{},
								resolve
							) as typeof component;
						}).finally(() => component?.dispose());
					},
				},
			} as never,
			{
				questions: [
					{
						id: "decision",
						prompt: "Proceed?",
						options: [
							{ value: "yes", label: "Yes" },
							{ value: "no", label: "No" },
						],
					},
				],
			},
			{ remote: { runtime: remoteAsk, source: "tool", toolCallId: "call-1" } }
		);

		assert(component);
		assert.equal(
			Reflect.get(component, Symbol.for("pi-extensions:input-dialog")),
			undefined
		);
		assert.equal(result.cancelled, kind === "cancel");
		if (kind === "answer") {
			assert.deepEqual(result.answers.decision, {
				values: ["yes"],
				labels: ["Yes"],
				indices: [1],
				customText: undefined,
				note: undefined,
				optionNotes: undefined,
			});
		}

		const started = bus.events.find(
			(event) => event.channel === PI_ASK_STARTED_EVENT
		)?.data as RemoteAskStartedEvent;
		assert.equal(started.flowId, "tool:call-1");
		assert.equal(started.source, "tool");
		assert.equal(started.questions[0]?.id, "decision");

		const submitResult = bus.events.find(
			(event) => event.channel === PI_ASK_SUBMIT_RESULT_EVENT
		)?.data as RemoteAskSubmitResultEvent;
		assert.equal(submitResult.ok, true);
		assert.equal(submitResult.requestId, "request-1");
		assert.equal(submitResult.flowId, "tool:call-1");

		const completed = bus.events.find(
			(event) => event.channel === PI_ASK_COMPLETED_EVENT
		)?.data as RemoteAskCompletedEvent;
		assert.equal(completed.flowId, "tool:call-1");
		assert.deepEqual(completed.result, result);
		assert.deepEqual(
			bus.events.map((event) => event.channel),
			[
				PI_ASK_STARTED_EVENT,
				PI_ASK_SUBMIT_EVENT,
				PI_ASK_COMPLETED_EVENT,
				PI_ASK_SUBMIT_RESULT_EVENT,
			]
		);

		remoteAsk.disposeAll();
		getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
	});
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
