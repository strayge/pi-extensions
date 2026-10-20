import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import modelsExtension from "../src/index.ts";
import type { ModelSelector, SelectorResult } from "../src/selector.ts";

const model = { provider: "p", id: "target" };

test("default selection persists only after a successful model switch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-default-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const settingsPath = join(dir, "settings.json");
  const original = {
    defaultProvider: "old",
    defaultModel: "old",
    defaultThinkingLevel: "high",
    theme: "dark",
    customSetting: { keep: true },
  };
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let selectionSucceeds = true;
  const selected: unknown[] = [];
  modelsExtension({
    on() {},
    registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    },
    async setModel(value: unknown) {
      selected.push(value);
      return selectionSucceeds;
    },
  } as never);

  for (const scenario of ["enter", "shortcut", "native", "auth failure", "write failure"]) {
    await t.test(scenario, async () => {
      await writeFile(settingsPath, JSON.stringify(original));
      selectionSucceeds = scenario !== "auth failure";
      const messages: { message: string; type: string }[] = [];
      if (scenario === "write failure") {
        await rm(settingsPath);
        await mkdir(settingsPath);
      }
      const context = {
        cwd: dir,
        mode: scenario === "native" ? "rpc" : "tui",
        modelRegistry: { getAvailable: () => [model] },
        ui: {
          async custom(
            factory: (
              tui: object,
              theme: object,
              keys: object,
              done: (value: SelectorResult) => void,
            ) => ModelSelector,
          ) {
            let result: SelectorResult | undefined;
            const selector = factory(
              { requestRender() {} },
              { fg: (_color: string, text: string) => text },
              { getKeys: () => ["ctrl+x"] },
              (value) => {
                result = value;
              },
            );
            assert.ok(selector.render(100).some((line) => line.includes("ctrl+x set default")));
            selector.handleInput(scenario === "enter" ? "\r" : "\x18");
            selector.dispose();
            assert.ok(result);
            return result;
          },
          async select(title: string, labels: string[]) {
            const choice = title === "Model action" ? "Set as default" : "[p] target";
            assert.ok(labels.includes(choice));
            return choice;
          },
          notify(message: string, type: string) {
            messages.push({ message, type });
          },
        },
      } as unknown as ExtensionCommandContext;
      const count = selected.length;
      await handler("", context);
      assert.deepEqual(selected.slice(count), [model]);
      if (scenario === "write failure") {
        assert.match(messages[0]?.message ?? "", /Could not save default model/);
        assert.equal(messages[0]?.type, "error");
        await rm(settingsPath, { recursive: true });
        return;
      }
      const saved = JSON.parse(await readFile(settingsPath, "utf8"));
      if (scenario === "enter" || scenario === "auth failure") {
        assert.deepEqual(saved, original);
        if (scenario === "enter") assert.deepEqual(messages, []);
        else
          assert.deepEqual(messages, [{ message: "Unable to select that model", type: "error" }]);
      } else {
        assert.deepEqual(saved, { ...original, defaultProvider: "p", defaultModel: "target" });
        assert.deepEqual(messages, [{ message: "Default model: p/target", type: "info" }]);
      }
    });
  }
});
