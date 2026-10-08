import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { registerAnswerCommands } from "../src/answer-commands.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";

function registerCommands(branch: unknown[] = []) {
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: any) => Promise<void> }
	>();
	registerAnswerCommands({
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: any) => Promise<void> }
		) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
	} as never);
	return commands;
}

test("answer and replay mark questions without remote setup, but not the extraction loader", {
	timeout: 2000,
}, async (t) => {
	initTheme("dark");
	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	});
	t.after(() => getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG));
	const params = {
		questions: [
			{
				id: "engine",
				prompt: "Chart engine?",
				options: [{ value: "canvas", label: "Canvas" }],
			},
		],
	};
	const branch: unknown[] = [
		{
			type: "custom",
			customType: "ask:payload",
			data: { version: 1, source: "tool", params, timestamp: 1 },
		},
		{
			type: "message",
			id: "assistant-1",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Chart engine: Canvas?" }],
			},
		},
	];
	const commands = registerCommands(branch);
	const markers: unknown[] = [];
	const model = { provider: "test", id: "extractor" };
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		model,
		scopedModels: [],
		sessionManager: { getBranch: () => branch },
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: () => ({ ok: true }),
			complete: () => ({
				stopReason: "stop",
				content: [{ type: "toolCall", name: "ask_user", arguments: params }],
			}),
		},
		ui: {
			custom(callback: (...args: any[]) => any) {
				const marker = Reflect.get(
					callback,
					Symbol.for("pi-extensions:input-dialog")
				);
				markers.push(marker);
				let component:
					| { handleInput(data: string): void; dispose(): void }
					| undefined;
				return new Promise((resolve) => {
					component = callback(
						{ requestRender: () => undefined },
						{
							fg: (_color: string, text: string) => text,
							bg: (_color: string, text: string) => text,
						},
						{},
						resolve
					);
					if (marker === true) {
						component?.handleInput("\u001b");
					}
				}).finally(() => component?.dispose());
			},
			notify: () => undefined,
			setWorkingVisible: () => undefined,
		},
	};

	await commands.get("answer")?.handler("", ctx);
	await commands.get("answer:again")?.handler("", ctx);
	await commands.get("ask:replay")?.handler("", ctx);
	assert.deepEqual(markers, [undefined, true, true, true]);
});

test("answer commands do not open custom UI outside TUI mode", async () => {
	const commands = registerCommands();
	const notifications: Array<{ message: string; type: string }> = [];
	let customOpened = false;
	const ctx = {
		mode: "rpc",
		ui: {
			custom() {
				customOpened = true;
			},
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
		},
	};

	await commands.get("answer")?.handler("", ctx);
	await commands.get("answer:again")?.handler("", ctx);
	await commands.get("ask:replay")?.handler("", ctx);

	assert.equal(customOpened, false);
	assert.deepEqual(notifications, [
		{ message: "/answer requires interactive TUI mode.", type: "error" },
		{ message: "Ask replay requires interactive TUI mode.", type: "error" },
		{ message: "Ask replay requires interactive TUI mode.", type: "error" },
	]);
});
