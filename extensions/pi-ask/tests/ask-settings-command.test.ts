import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerAskSettingsCommand } from "../src/ask-settings-command.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import { runAskFlow } from "../src/ui/controller.ts";

function plainTheme() {
	return {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
	};
}

test("registers /ask-settings and opens the shared settings overlay", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-ask-command-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const commands = new Map<
		string,
		{ handler: (args: string, ctx: any) => Promise<void> }
	>();
	registerAskSettingsCommand({
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: any) => Promise<void> }
		) {
			commands.set(name, command);
		},
	} as never);

	assert(commands.has("ask-settings"));

	const customCalls: Array<{ options: unknown; lines: string[] }> = [];
	await commands.get("ask-settings")?.handler("", {
		mode: "tui",
		ui: {
			custom(callback: any, options: unknown) {
				assert.equal(
					Reflect.get(callback, Symbol.for("pi-extensions:input-dialog")),
					undefined
				);
				const done = () => {
					// test callback intentionally unused
				};
				const tui = {
					requestRender() {
						// test render hook intentionally unused
					},
				};
				const component = callback(tui, plainTheme(), undefined, done);
				customCalls.push({ options, lines: component.render(72) });
				return Promise.resolve();
			},
		},
	});

	assert.equal(customCalls.length, 1);
	assert.deepEqual(customCalls[0]?.options, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			margin: 1,
			maxHeight: "90%",
			minWidth: 26,
			width: 72,
		},
	});
	const text = customCalls[0]?.lines.join("\n") ?? "";
	assert(text.includes("@eko24ive/pi-ask"));
	assert(text.includes("Edit this config file to customize"));
	assert(text.includes("keymaps"));
	assert(text.includes("notifications"));
	assert(text.includes("extraction settings"));

	delete process.env.PI_CODING_AGENT_DIR;
	await rm(agentDir, { force: true, recursive: true });
});

test("local question stays open while its unmarked settings overlay closes", {
	timeout: 2000,
}, async (t) => {
	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	});
	t.after(() => getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG));
	const markers: unknown[] = [];
	let question: { handleInput(data: string): void } | undefined;
	let settled = false;
	const resultPromise = runAskFlow(
		{
			cwd: process.cwd(),
			mode: "tui",
			ui: {
				custom(callback: (...args: any[]) => any) {
					const marker = Reflect.get(
						callback,
						Symbol.for("pi-extensions:input-dialog")
					);
					markers.push(marker);
					let component:
						| { handleInput(data: string): void; dispose?(): void }
						| undefined;
					return new Promise((resolve) => {
						component = callback(
							{ requestRender: () => undefined },
							plainTheme(),
							{},
							resolve
						);
						if (marker === true) {
							question = component;
						} else {
							resolve(undefined);
						}
					}).finally(() => component?.dispose?.());
				},
			},
		} as never,
		{
			questions: [
				{
					id: "decision",
					prompt: "Proceed?",
					options: [{ value: "yes", label: "Yes" }],
				},
			],
		}
	).then((result) => {
		settled = true;
		return result;
	});

	await new Promise<void>((resolve) => setImmediate(resolve));
	assert(question);
	question.handleInput("?");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(markers, [true, undefined]);
	assert.equal(settled, false);
	question.handleInput("\u001b");
	assert.equal((await resultPromise).cancelled, true);
});

test("/ask-settings notifies outside TUI instead of opening custom UI", async () => {
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: any) => Promise<void> }
	>();
	registerAskSettingsCommand({
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: any) => Promise<void> }
		) {
			commands.set(name, command);
		},
	} as never);

	const notifications: Array<{ message: string; type: string }> = [];
	let customOpened = false;
	await commands.get("ask-settings")?.handler("", {
		mode: "rpc",
		ui: {
			custom() {
				customOpened = true;
			},
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
		},
	});

	assert.equal(customOpened, false);
	assert.deepEqual(notifications, [
		{
			message: "/ask-settings requires interactive TUI mode.",
			type: "error",
		},
	]);
});
