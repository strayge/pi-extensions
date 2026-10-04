import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import askExtension from "../src/index.ts";

test("configuration guidance owns one section without replacing the rendered prompt", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const pi = {
		events: createEventBus(),
		on(name: string, handler: (event: never, ctx: never) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand: () => undefined,
		registerTool: () => undefined,
	} as unknown as ExtensionAPI;
	askExtension(pi);
	const handler = handlers.get("before_agent_start");
	assert.ok(handler);
	const sections: Record<string, string> = {
		otherExtension: "Keep this section",
	};
	const options = { sections, forceSystemPrompt: undefined };
	const event = {
		systemPromptOptions: options,
		get systemPrompt() {
			return assert.fail("Rendered prompt should not be read");
		},
	} as never;

	try {
		assert.equal(await handler(event, {} as never), undefined);
		const instruction = sections.pi_ask;
		assert.ok(instruction?.includes("@eko24ive/pi-ask"));
		assert.ok(
			instruction.includes(
				fileURLToPath(new URL("../docs/configuration.md", import.meta.url))
			)
		);
		assert.equal(await handler(event, {} as never), undefined);
		assert.deepEqual(Object.entries(sections), [
			["otherExtension", "Keep this section"],
			["pi_ask", instruction],
		]);
		assert.equal(options.forceSystemPrompt, undefined);
	} finally {
		await handlers.get("session_shutdown")?.({} as never, {} as never);
	}
});
