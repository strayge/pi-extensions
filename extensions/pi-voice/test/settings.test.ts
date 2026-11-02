import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  type ExtensionAPI,
  type ExtensionContext,
  ExtensionInputComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CorrectionDictionary } from "../src/corrections.ts";
import { Deferred } from "../src/deferred.ts";
import { DEFAULT_FILLER_WORDS } from "../src/filler-cleanup.ts";
import {
  readSettings,
  settingsForModel,
  settingsWithPreferredLanguages,
  writeSettings,
} from "../src/settings.ts";
import { showSettingsMenu } from "../src/settings-menu.ts";
import { settingsPath } from "../src/settings-path.ts";
import { keybindings, testTheme, testTui } from "./ui-helpers.ts";

initTheme("dark");

function isolatedSettings(t: TestContext): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-voice-settings-test-"));
  const directory = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

function initialSettings(
  fillerWords?: readonly string[],
  corrections?: Readonly<CorrectionDictionary>,
) {
  return settingsForModel("parakeet-unified-en-0.6b", "/tmp/current-model", {
    shortcut: "ctrl+alt+z",
    preferredLanguages: ["en"],
    fillerWords,
    corrections,
  });
}

test("legacy and invalid filler fields default without discarding valid model settings", async (t) => {
  isolatedSettings(t);
  for (const fillerWords of [undefined, "uh, um", ["uh", 2], null]) {
    const current = initialSettings();
    writeFileSync(settingsPath(), JSON.stringify({ ...current, fillerWords }));
    const result = await readSettings();
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.settings, { ...current, fillerWords: [...DEFAULT_FILLER_WORDS] });
  }
});

test("factory, persisted reads, and writes normalize filler lists and preserve explicit disable", async (t) => {
  isolatedSettings(t);
  const words = [" UM ", "", "Ah", "um", "  ", "AH"];
  assert.deepEqual(initialSettings(words).fillerWords, ["um", "ah"]);
  for (const [input, expected] of [
    [words, ["um", "ah"]],
    [[], []],
  ] as const) {
    const current = { ...initialSettings(), fillerWords: [...input] };
    writeFileSync(settingsPath(), JSON.stringify(current));
    assert.deepEqual((await readSettings()).settings?.fillerWords, expected);
    await writeSettings(current);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf8")).fillerWords, expected);
    assert.deepEqual((await readSettings()).settings?.fillerWords, expected);
  }
  assert.deepEqual(words, [" UM ", "", "Ah", "um", "  ", "AH"]);
});

test("legacy and malformed correction fields default without discarding valid model settings", async (t) => {
  isolatedSettings(t);
  for (const corrections of [
    undefined,
    null,
    [],
    "word = Word",
    { word: 2 },
    { "": "Word" },
    { word: "" },
    { Word: "One", word: "Two" },
  ]) {
    const current = initialSettings();
    writeFileSync(settingsPath(), JSON.stringify({ ...current, corrections }));
    const result = await readSettings();
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.settings, { ...current, corrections: {} });
  }
});

test("factory, persisted reads, and writes normalize corrections without changing target case", async (t) => {
  isolatedSettings(t);
  const dictionary = { "  PIE Voice ": " Pi Voice ", " g p t ": " GPT " };
  const expected = { "pie voice": "Pi Voice", "g p t": "GPT" };
  assert.deepEqual(initialSettings(undefined, dictionary).corrections, expected);
  for (const corrections of [dictionary, {}]) {
    const normalized = Object.keys(corrections).length ? expected : {};
    const current = { ...initialSettings(), corrections };
    writeFileSync(settingsPath(), JSON.stringify(current));
    assert.deepEqual((await readSettings()).settings?.corrections, normalized);
    await writeSettings(current);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf8")).corrections, normalized);
    assert.deepEqual((await readSettings()).settings?.corrections, normalized);
  }
  assert.deepEqual(dictionary, { "  PIE Voice ": " Pi Voice ", " g p t ": " GPT " });
});

test("preferred language changes preserve custom and disabled cleanup and corrections", () => {
  for (const words of [["mm", "ah"], []]) {
    const corrections: CorrectionDictionary = words.length ? { "pie voice": "Pi Voice" } : {};
    const current = initialSettings(words, corrections);
    const updated = settingsWithPreferredLanguages(current, ["en", "zh"]);
    assert.deepEqual(updated.fillerWords, words);
    assert.deepEqual(updated.corrections, corrections);
  }
});

type Step = (pane: Component) => void;

function scriptedContext(
  steps: Step[],
  options: {
    editor?: (title: string, prefill?: string) => Promise<string | undefined>;
    allowErrors?: boolean;
  } = {},
) {
  let index = 0;
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const result = new Deferred<unknown>();
        const pane = await factory(
          testTui(24),
          testTheme(),
          keybindings() as Parameters<typeof factory>[2],
          (value) => result.resolve(value),
        );
        try {
          const step = steps[index++];
          assert.ok(step, `Unexpected pane: ${pane.constructor.name}`);
          step(pane);
          return await result.promise;
        } finally {
          pane.dispose?.();
        }
      },
      editor: options.editor,
      notify: (message: string, type: string) => {
        if (!options.allowErrors) assert.notEqual(type, "error", message);
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications, assertFinished: () => assert.equal(index, steps.length) };
}

function chooseFillerWords(pane: Component): void {
  assert.match(pane.render(100).join("\n"), /Filler words\s+uh, um, erm/);
  for (let index = 0; index < 3; index++) pane.handleInput?.("\x1b[B");
  pane.handleInput?.("\r");
}

for (const action of ["edit", "disable", "cancel"] as const) {
  test(`settings filler input supports ${action} with prefill and empty submission`, async (t) => {
    isolatedSettings(t);
    const configured = initialSettings();
    await writeSettings(configured);
    const before = readFileSync(settingsPath(), "utf8");
    const expected =
      action === "edit" ? ["mm", "ah"] : action === "disable" ? [] : [...DEFAULT_FILLER_WORDS];
    const script = scriptedContext([
      chooseFillerWords,
      (pane) => {
        assert.ok(pane instanceof ExtensionInputComponent);
        pane.handleInput("\x05");
        assert.match(pane.render(100).join("\n"), /uh, um, erm/);
        pane.handleInput("\x15");
        if (action !== "disable") pane.handleInput(" MM, ah, mm, , AH ");
        pane.handleInput(action === "cancel" ? "\x1b" : "\r");
      },
      (pane) => {
        const summary = expected.length ? expected.join(", ") : "Disabled";
        assert.ok(
          pane.render(100).some((line) => line.includes("Filler words") && line.includes(summary)),
        );
        pane.handleInput?.("\x1b");
      },
    ]);
    assert.equal(
      await showSettingsMenu({} as ExtensionAPI, script.ctx, configured, configured.shortcut),
      false,
    );
    script.assertFinished();
    assert.deepEqual(configured.fillerWords, expected);
    assert.deepEqual((await readSettings()).settings?.fillerWords, expected);
    if (action === "cancel") {
      assert.equal(readFileSync(settingsPath(), "utf8"), before);
      assert.deepEqual(script.notifications, []);
    } else {
      assert.deepEqual(script.notifications, ["Filler words saved"]);
    }
  });
}

for (const action of ["edit", "disable", "cancel", "invalid-cancel", "invalid-recover"] as const) {
  test(`settings correction editor supports ${action} without losing saved settings or drafts`, async (t) => {
    isolatedSettings(t);
    const original = { "pie voice": "Pi Voice", "g p t": "GPT" };
    const configured = initialSettings(undefined, original);
    await writeSettings(configured);
    const before = readFileSync(settingsPath(), "utf8");
    const cancelled = action === "cancel" || action === "invalid-cancel";
    const expected = cancelled ? original : action === "disable" ? {} : { "open eye": "OpenAI" };
    let editorCalls = 0;
    const script = scriptedContext(
      [
        (pane) => {
          assert.match(pane.render(100).join("\n"), /Correction dictionary\s+2 entries/);
          for (let index = 0; index < 4; index++) pane.handleInput?.("\x1b[B");
          pane.handleInput?.("\r");
        },
        (pane) => {
          const summary = Object.keys(expected).length
            ? `${Object.keys(expected).length} entries`
            : "Disabled";
          assert.ok(
            pane
              .render(100)
              .some((line) => line.includes("Correction dictionary") && line.includes(summary)),
          );
          pane.handleInput?.("\x1b");
        },
      ],
      {
        allowErrors: action.startsWith("invalid"),
        editor: async (title, prefill) => {
          assert.match(title, /source = replacement/);
          if (editorCalls++ === 0) {
            assert.equal(prefill, "pie voice = Pi Voice\ng p t = GPT");
            if (action === "cancel") return undefined;
            if (action === "disable") return "";
            if (action.startsWith("invalid")) return "malformed draft";
            return " Open Eye = OpenAI ";
          }
          assert.equal(prefill, "malformed draft");
          assert.deepEqual(configured.corrections, original);
          assert.equal(readFileSync(settingsPath(), "utf8"), before);
          return action === "invalid-cancel" ? undefined : " Open Eye = OpenAI ";
        },
      },
    );
    assert.equal(
      await showSettingsMenu({} as ExtensionAPI, script.ctx, configured, configured.shortcut),
      false,
    );
    script.assertFinished();
    assert.equal(editorCalls, action.startsWith("invalid") ? 2 : 1);
    assert.deepEqual(configured.corrections, expected);
    assert.deepEqual((await readSettings()).settings?.corrections, expected);
    if (cancelled) assert.equal(readFileSync(settingsPath(), "utf8"), before);
    if (action.startsWith("invalid")) assert.ok(script.notifications.length >= 1);
    if (!cancelled) assert.equal(script.notifications.at(-1), "Corrections saved");
    if (action === "cancel") assert.deepEqual(script.notifications, []);
  });
}
