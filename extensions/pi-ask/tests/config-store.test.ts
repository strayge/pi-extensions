import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import type { AskConfig } from "../src/config/schema.ts";
import {
	AskConfigStore,
	getAskConfigPath,
	getAskConfigStore,
	resetAskConfigStore,
} from "../src/config/store.ts";

const DEFAULT_KEYMAPS_NOTICE_PATTERN =
	/Using default ask keymaps for this session/;
const SAVE_FAILURE_PATTERN =
	/Unable to save ask config .* managed outside pi-ask/;

function expectedConfigFile(
	overrides: { behaviour?: typeof DEFAULT_ASK_CONFIG.behaviour } = {}
) {
	return {
		schemaVersion: 5,
		answer: DEFAULT_ASK_CONFIG.answer,
		behaviour: overrides.behaviour ?? DEFAULT_ASK_CONFIG.behaviour,
		keymaps: DEFAULT_ASK_CONFIG.keymaps,
		notifications: DEFAULT_ASK_CONFIG.notifications,
	};
}

async function makeTempPath(name: string): Promise<string> {
	const root = await import("node:fs/promises").then(({ mkdtemp }) =>
		mkdtemp(join(tmpdir(), name))
	);
	return join(root, "pi-ask.json");
}

test("resetAskConfigStore reloads the global store from disk", async () => {
	const root = await import("node:fs/promises").then(({ mkdtemp }) =>
		mkdtemp(join(tmpdir(), "pi-ask-config-reset-"))
	);
	const path = join(root, "pi-ask.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		JSON.stringify({
			...expectedConfigFile(),
			behaviour: {
				...DEFAULT_ASK_CONFIG.behaviour,
				autoSubmitWhenAnsweredWithoutNotes: true,
			},
		})
	);
	process.env.PI_CODING_AGENT_DIR = root;
	resetAskConfigStore();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);

	resetAskConfigStore();
	const result = await getAskConfigStore().ensureLoaded();

	assert.equal(
		result.config.behaviour.autoSubmitWhenAnsweredWithoutNotes,
		true
	);
	delete process.env.PI_CODING_AGENT_DIR;
	resetAskConfigStore();
	await rm(root, { force: true, recursive: true });
});

test("config store writes defaults when file is missing", async () => {
	const path = await makeTempPath("pi-ask-config-missing-");
	const store = new AskConfigStore(path);

	const result = await store.ensureLoaded();

	assert.deepEqual(result.config, DEFAULT_ASK_CONFIG);
	assert.deepEqual(
		JSON.parse(await readFile(path, "utf-8")),
		expectedConfigFile()
	);
	await rm(dirname(path), { force: true, recursive: true });
});

test("config store uses defaults when initial config creation fails", async () => {
	class FailingInitialSaveStore extends AskConfigStore {
		override save(_config: AskConfig | Partial<AskConfig>): Promise<AskConfig> {
			return Promise.reject(
				new Error("Unable to save ask config; edit it manually.")
			);
		}
	}
	const path = await makeTempPath("pi-ask-config-initial-save-failure-");
	const store = new FailingInitialSaveStore(path);

	const result = await store.ensureLoaded();

	assert.deepEqual(result.config, DEFAULT_ASK_CONFIG);
	assert.equal(result.notice?.kind, "warning");
	assert.equal(
		result.notice?.text,
		"Unable to save ask config; edit it manually."
	);
	await rm(dirname(path), { force: true, recursive: true });
});

test("config store writes full normalized config on save", async () => {
	const path = await makeTempPath("pi-ask-config-save-");
	const store = new AskConfigStore(path);

	await store.save({
		behaviour: {
			...DEFAULT_ASK_CONFIG.behaviour,
			autoSubmitWhenAnsweredWithoutNotes: true,
			showFooterHints: false,
		},
		keymaps: DEFAULT_ASK_CONFIG.keymaps,
	});

	const content = await readFile(path, "utf-8");
	assert.deepEqual(
		JSON.parse(content),
		expectedConfigFile({
			behaviour: {
				...DEFAULT_ASK_CONFIG.behaviour,
				autoSubmitWhenAnsweredWithoutNotes: true,
				showFooterHints: false,
			},
		})
	);
	await rm(dirname(path), { force: true, recursive: true });
});

test("config store reports friendly save failures", async () => {
	const path = await makeTempPath("pi-ask-config-save-failure-");
	await mkdir(path, { recursive: true });
	const store = new AskConfigStore(path);

	await assert.rejects(store.save(DEFAULT_ASK_CONFIG), SAVE_FAILURE_PATTERN);
	await rm(path, { force: true, recursive: true });
});

test("config store leaves broken json unchanged and loads defaults", async () => {
	const path = await makeTempPath("pi-ask-config-broken-");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "{bad json", "utf-8");
	const store = new AskConfigStore(path);

	const result = await store.ensureLoaded();
	const dirEntries = await readdir(dirname(path));

	assert.deepEqual(result.config, DEFAULT_ASK_CONFIG);
	assert.equal(
		result.notice?.text,
		"Config was invalid or unsupported. Loaded defaults for this session and left the config file unchanged. Edit the config file or run /reload after fixing it."
	);
	assert.equal(
		dirEntries.some((entry) => entry.includes(".bak.json")),
		false
	);
	assert.equal(await readFile(path, "utf-8"), "{bad json");
	await rm(dirname(path), { force: true, recursive: true });
});

test("config store loads migrated config without rewriting", async () => {
	const path = await makeTempPath("pi-ask-config-current-");
	await mkdir(dirname(path), { recursive: true });
	const content = JSON.stringify({
		schemaVersion: 1,
		behaviour: {
			autoSubmitWhenAnsweredWithoutNotes: true,
			confirmDismissWhenDirty: true,
			doublePressReviewShortcuts: true,
			showFooterHints: false,
		},
		keymaps: DEFAULT_ASK_CONFIG.keymaps,
	});
	await writeFile(path, content);
	const store = new AskConfigStore(path);

	const result = await store.ensureLoaded();

	assert.equal(
		result.config.behaviour.autoSubmitWhenAnsweredWithoutNotes,
		true
	);
	assert.equal(result.config.behaviour.confirmDismissWhenDirty, true);
	assert.equal(result.config.behaviour.doublePressReviewShortcuts, true);
	assert.equal(result.config.behaviour.showFooterHints, false);
	assert.deepEqual(result.config.keymaps, DEFAULT_ASK_CONFIG.keymaps);
	assert.equal(await readFile(path, "utf-8"), content);
	await rm(dirname(path), { force: true, recursive: true });
});

test("default config path uses pi-ask.json in the agent directory", async () => {
	const root = await import("node:fs/promises").then(({ mkdtemp }) =>
		mkdtemp(join(tmpdir(), "pi-ask-config-paths-"))
	);
	process.env.PI_CODING_AGENT_DIR = root;
	resetAskConfigStore();
	try {
		assert.equal(getAskConfigPath(), join(root, "pi-ask.json"));
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		resetAskConfigStore();
	}
	await rm(root, { force: true, recursive: true });
});

test("default config store ignores old config filenames", async () => {
	const root = await import("node:fs/promises").then(({ mkdtemp }) =>
		mkdtemp(join(tmpdir(), "pi-ask-config-old-names-"))
	);
	const oldPaths = [
		join(root, "eko24ive-pi-ask.json"),
		join(root, "extensions", "eko24ive-pi-ask.json"),
	];
	const oldContent = JSON.stringify({
		...expectedConfigFile(),
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	});
	for (const path of oldPaths) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, oldContent);
	}
	process.env.PI_CODING_AGENT_DIR = root;
	resetAskConfigStore();
	try {
		const result = await getAskConfigStore().ensureLoaded();

		assert.deepEqual(result.config, DEFAULT_ASK_CONFIG);
		assert.deepEqual(
			JSON.parse(await readFile(join(root, "pi-ask.json"), "utf-8")),
			expectedConfigFile()
		);
		for (const path of oldPaths) {
			assert.equal(await readFile(path, "utf-8"), oldContent);
		}
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		resetAskConfigStore();
		await rm(root, { force: true, recursive: true });
	}
});

test("config store falls back only keymaps when configured keymaps are invalid", async () => {
	const path = await makeTempPath("pi-ask-config-invalid-keymaps-");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 1,
			behaviour: {
				autoSubmitWhenAnsweredWithoutNotes: true,
				confirmDismissWhenDirty: true,
				doublePressReviewShortcuts: true,
				showFooterHints: false,
			},
			keymaps: {
				cancel: "?",
				dismiss: "ctrl+c",
				toggle: "space",
				confirm: "enter",
				optionNote: "n",
				questionNote: "shift+n",
			},
		})
	);
	const store = new AskConfigStore(path);

	const result = await store.ensureLoaded();

	assert.equal(
		result.config.behaviour.autoSubmitWhenAnsweredWithoutNotes,
		true
	);
	assert.equal(result.config.behaviour.confirmDismissWhenDirty, true);
	assert.equal(result.config.behaviour.doublePressReviewShortcuts, true);
	assert.equal(result.config.behaviour.showFooterHints, false);
	assert.deepEqual(result.config.keymaps, DEFAULT_ASK_CONFIG.keymaps);
	assert.match(result.notice?.text ?? "", DEFAULT_KEYMAPS_NOTICE_PATTERN);
	await rm(dirname(path), { force: true, recursive: true });
});
