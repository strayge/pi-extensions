import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.ts";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.ts";

const marker = Symbol.for("pi-extensions:input-dialog");
let hermetic: Hermetic;
const original = "---\ndescription: existing\n---\nKeep this agent.\n";

beforeEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
  hermetic = hermeticDir({ agentFiles: { example: original } });
});
afterEach(() => {
  hermetic.restore();
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
});

it("the manual creation wizard excludes nested choices and preserves editor and overwrite safety", async () => {
  const booted = makePi();
  subagentsExtension(booted.pi);
  const answers = ["example", "new description", "read, write", "provider/model"];
  const titles: string[] = [];
  const context = ctx({ ui: {
    notify: vi.fn(),
    select: vi.fn(async (title: string, labels: string[], options: object) => {
      expect(Reflect.get({ ...options }, marker)).toBe(false);
      titles.push(title);
      if (title === "Agents") return "Create new agent";
      if (title === "Choose location") return labels[0];
      if (title === "Creation method") return "Manual configuration";
      if (title === "Thinking level") return "inherit";
      return "custom...";
    }),
    input: vi.fn(async (_title: string, _placeholder: string | undefined, options: object) => {
      expect(Reflect.get({ ...options }, marker)).toBe(false);
      return answers.shift();
    }),
    editor: vi.fn(async (...args: unknown[]) => {
      expect(args).toEqual(["System prompt", ""]);
      return "new prompt";
    }),
    confirm: vi.fn(async (title: string, message: string, options: object) => {
      expect(Reflect.get({ ...options }, marker)).toBe(false);
      expect(title).toBe("Overwrite");
      expect(message).toContain(join(hermetic.dir, ".pi", "agents", "example.md"));
      return false;
    }),
  } });
  await booted.commands.get("agents").handler("", context);
  expect(titles).toEqual(["Agents", "Choose location", "Creation method", "Tools", "Model", "Thinking level"]);
  expect(answers).toEqual([]);
  expect(context.ui.confirm).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(hermetic.dir, ".pi", "agents", "example.md"), "utf-8")).toBe(original);
});

it("agent detail deletion and recursive back navigation stay manual with unmarked rich lists", async () => {
  const booted = makePi();
  subagentsExtension(booted.pi);
  let menus = 0;
  let lists = 0;
  const context = ctx({ ui: {
    notify: vi.fn(),
    select: vi.fn(async (title: string, labels: string[], options: object) => {
      expect(Reflect.get({ ...options }, marker)).toBe(false);
      if (title === "Agents") return menus++ === 0 ? labels.find(label => label.startsWith("Agent types")) : undefined;
      expect(title).toBe("example");
      return "Delete";
    }),
    custom: vi.fn(async (factory: object) => {
      expect(Reflect.get(factory, marker)).toBeUndefined();
      return lists++ === 0 ? "example" : undefined;
    }),
    confirm: vi.fn(async (_title: string, _message: string, options: object) => {
      expect(Reflect.get({ ...options }, marker)).toBe(false);
      return false;
    }),
  } });
  await booted.commands.get("agents").handler("", context);
  expect(menus).toBe(2);
  expect(lists).toBe(2);
  expect(context.ui.confirm).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(hermetic.dir, ".pi", "agents", "example.md"), "utf-8")).toBe(original);
});
