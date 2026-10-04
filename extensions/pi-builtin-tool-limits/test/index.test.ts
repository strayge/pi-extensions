import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildSystemPrompt,
  normalizeBuildSystemPromptOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import extension, {
  FIND_MAX_RESULTS,
  GREP_GUIDELINES,
  GREP_MAX_MATCHES,
  LS_MAX_ENTRIES,
  MAX_OUTPUT_BYTES,
  READ_MAX_LINES,
} from "../src/index.ts";

describe("guidance", () => {
  it("merges active grep guidelines without replacing or reparsing the system prompt", () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    const pi = {
      registerTool() {},
      on(name: string, handler: (event: never, ctx: never) => unknown) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI;
    extension(pi);
    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    const options = normalizeBuildSystemPromptOptions({
      cwd: "/work/project",
      selectedTools: ["grep"],
      toolGuidelines: { grep: ["Native grep rule"], read: ["Native read rule"] },
      sections: { other_extension: "Keep this section" },
    });
    const event = {
      systemPromptOptions: options,
      get systemPrompt() {
        return assert.fail("Rendered prompt should not be read");
      },
    } as never;

    assert.equal(handler(event, {} as never), undefined);
    assert.equal(handler(event, {} as never), undefined);
    assert.deepEqual(options.toolGuidelines.grep, ["Native grep rule", ...GREP_GUIDELINES]);
    assert.deepEqual(options.sections, { other_extension: "Keep this section" });
    assert.equal(options.forceSystemPrompt, undefined);
    const active = buildSystemPrompt(options);
    for (const guideline of GREP_GUIDELINES) assert.ok(active.includes(guideline));
    assert.ok(active.includes("Native grep rule"));

    options.selectedTools = ["read"];
    const inactive = buildSystemPrompt(options);
    for (const guideline of GREP_GUIDELINES) assert.ok(!inactive.includes(guideline));
    assert.ok(inactive.includes("Native read rule"));
  });
});

describe("registration and argument caps", () => {
  it("registers only the five built-in overrides", () => {
    const registrations: Array<{ name: string; description: string }> = [];
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    const pi = {
      registerTool(tool: { name: string; description: string }) {
        registrations.push(tool);
      },
      on(name: string, handler: (event: never, ctx: never) => unknown) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI;

    extension(pi);
    const start = handlers.get("session_start");
    assert.ok(start);
    start({} as never, { cwd: "." } as never);

    assert.deepEqual(
      registrations.map((tool) => tool.name),
      ["read", "bash", "grep", "find", "ls"],
    );
    assert.ok(
      registrations.every((tool) => !/50\s*(?:KB|KiB)|2,?000\s+lines/i.test(tool.description)),
    );
    assert.ok(registrations.find((tool) => tool.name === "read")?.description.includes("1,000"));
    assert.ok(registrations.find((tool) => tool.name === "bash")?.description.includes("1,000"));
    assert.ok(
      registrations
        .find((tool) => tool.name === "grep")
        ?.description.includes(String(GREP_MAX_MATCHES)),
    );
    assert.ok(
      registrations
        .find((tool) => tool.name === "find")
        ?.description.includes(String(FIND_MAX_RESULTS)),
    );
    assert.ok(
      registrations
        .find((tool) => tool.name === "ls")
        ?.description.includes(String(LS_MAX_ENTRIES)),
    );
  });

  it("rewrites only omitted and excessive limit arguments", () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    const pi = {
      registerTool() {},
      on(name: string, handler: (event: never, ctx: never) => unknown) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI;
    extension(pi);
    const handler = handlers.get("tool_call");
    assert.ok(handler);

    const cases = [
      ["read", undefined, READ_MAX_LINES],
      ["read", READ_MAX_LINES + 1, READ_MAX_LINES],
      ["read", 3, 3],
      ["grep", undefined, GREP_MAX_MATCHES],
      ["find", FIND_MAX_RESULTS + 1, FIND_MAX_RESULTS],
      ["ls", LS_MAX_ENTRIES + 1, LS_MAX_ENTRIES],
    ] as const;
    for (const [toolName, limit, expected] of cases) {
      const event = { toolName, input: limit === undefined ? {} : { limit } } as never;
      handler(event, {} as never);
      assert.equal((event as { input: { limit?: number } }).input.limit, expected);
    }

    assert.equal(MAX_OUTPUT_BYTES, 10 * 1024);
  });
});
