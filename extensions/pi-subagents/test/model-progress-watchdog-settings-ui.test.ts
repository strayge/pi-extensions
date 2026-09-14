import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModelProgressTimeoutMinutes, setModelProgressTimeoutMinutes } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

interface SettingsRun {
  inputs: ReturnType<typeof vi.fn>;
  notifications: ReturnType<typeof vi.fn>;
  rendered: string[];
}

describe("/agents → Settings model progress timeout", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    setModelProgressTimeoutMinutes(10);
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
    initTheme(undefined, false);
  });

  afterEach(() => {
    hermetic?.restore();
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
    setModelProgressTimeoutMinutes(10);
  });

  async function runSettings(initial: number | undefined, answers: string[]): Promise<SettingsRun> {
    hermetic = hermeticDir({
      settings: initial === undefined ? undefined : { modelProgressTimeoutMinutes: initial },
    });
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");

    let menuTaken = false;
    let settingsOpenCount = 0;
    const rendered: string[] = [];
    const inputs = vi.fn(async () => answers.shift());
    const notifications = vi.fn();
    const context = ctx({
      cwd: hermetic.dir,
      hasUI: true,
      ui: {
        notify: notifications,
        select: vi.fn(async (title: string, options: string[]) => {
          if (title !== "Agents" || menuTaken) return undefined;
          menuTaken = true;
          return options.find(option => option === "Settings");
        }),
        input: inputs,
        custom: vi.fn(async (factory: any) => new Promise(resolve => {
          const component = factory(
            { requestRender: () => {} },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            {},
            resolve,
          );
          rendered.push(component.render(200).join("\n"));
          settingsOpenCount += 1;
          if (settingsOpenCount === 1) {
            component.handleInput("\x1b[B");
            component.handleInput("\x1b[B");
            component.handleInput("\x1b[B");
            component.handleInput("\r");
          } else {
            resolve(undefined);
          }
        })),
      },
    });

    await command.handler("", context);
    return { inputs, notifications, rendered };
  }

  it("shows a loaded value and persists a valid edit with its runtime toast", async () => {
    const run = await runSettings(37, ["12"]);

    expect(run.rendered[0]).toContain("Model progress timeout");
    expect(run.rendered[0]).toMatch(/37/);
    expect(getModelProgressTimeoutMinutes()).toBe(12);
    expect(JSON.parse(readFileSync(join(hermetic.dir, ".pi", "subagents.json"), "utf-8")))
      .toHaveProperty("modelProgressTimeoutMinutes", 12);
    expect(run.notifications).toHaveBeenCalledWith(
      "Model progress timeout set to 12 minutes. Applies to later invocations.",
      "info",
    );
  });

  it("re-prompts out-of-range integers, then persists explicit zero as disabled", async () => {
    const run = await runSettings(undefined, ["10081", "-1", "0"]);

    expect(run.rendered[0]).toMatch(/Model progress timeout[\s\S]*10/);
    expect(run.inputs).toHaveBeenCalledTimes(3);
    expect(run.inputs.mock.calls.map(call => call[1])).toEqual(["10", "10081", "-1"]);
    expect(getModelProgressTimeoutMinutes()).toBe(0);
    expect(JSON.parse(readFileSync(join(hermetic.dir, ".pi", "subagents.json"), "utf-8")))
      .toHaveProperty("modelProgressTimeoutMinutes", 0);
    expect(run.notifications).toHaveBeenCalledTimes(1);
    expect(run.notifications).toHaveBeenCalledWith(
      "Model progress watchdog disabled. Applies to later invocations.",
      "info",
    );
  });
});
