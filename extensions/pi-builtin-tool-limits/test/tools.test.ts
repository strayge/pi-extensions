import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FIND_MAX_RESULTS, LS_MAX_ENTRIES, MAX_OUTPUT_BYTES } from "../src/limits.ts";
import {
  createFindOverride,
  createLsOverride,
  createReadOverride,
  splitNativeReadSuffix,
} from "../src/tools.ts";

const context = {} as never;

describe("read override", () => {
  it("keeps continuation offsets accurate after byte truncation", async () => {
    const lines = Array.from(
      { length: 1200 },
      (_, i) => `line-${i.toString().padStart(4, "0")}-${"x".repeat(20)}`,
    );
    const tool = createReadOverride("/project", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from(lines.join("\n")),
      },
    });
    const result = await tool.execute("read", { path: "large.txt" }, undefined, undefined, context);
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text && text.type === "text");
    assert.ok(Buffer.byteLength(text.text) <= MAX_OUTPUT_BYTES);
    assert.match(
      text.text,
      /Showing lines 1-\d+ of 1200(?: \(10 KiB limit\))?\. Use offset=\d+ to continue/,
    );
    assert.equal(result.details?.truncation?.maxBytes, MAX_OUTPUT_BYTES);
    assert.equal(result.details?.truncation?.maxLines, 1000);
  });

  it("reports the injected 1,000-line default as hard truncation", async () => {
    const lines = Array.from({ length: 1500 }, () => "x");
    const tool = createReadOverride("/project", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from(lines.join("\n")),
      },
    });

    const result = await tool.execute("read", { path: "tiny.txt" }, undefined, undefined, context);
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text && text.type === "text");
    assert.match(text.text, /Showing lines 1-1000 of 1500/);
    assert.equal(result.details?.truncation?.truncated, true);
    assert.equal(result.details?.truncation?.maxLines, 1000);
  });

  it("uses absolute file totals in hard-cap notices with an offset", async () => {
    const lines = Array.from({ length: 2000 }, () => "x");
    const tool = createReadOverride("/project", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from(lines.join("\n")),
      },
    });

    const result = await tool.execute(
      "read",
      { path: "tiny.txt", offset: 501 },
      undefined,
      undefined,
      context,
    );
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text && text.type === "text");
    assert.match(text.text, /Showing lines 501-1500 of 2000/);
  });

  it("preserves lower explicit limits and non-default offsets", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const tool = createReadOverride("/project", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from(lines.join("\n")),
      },
    });
    const result = await tool.execute(
      "read",
      { path: "file.txt", offset: 5, limit: 3 },
      undefined,
      undefined,
      context,
    );
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text && text.type === "text");
    assert.match(text.text, /^line-4\nline-5\nline-6\n\n\[13 more lines in file\. Use offset=8/);
  });

  it("replaces the native first-line fallback without leaking its 50 KiB cap", async () => {
    const tool = createReadOverride("/project", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("x".repeat(60 * 1024)),
      },
    });

    const result = await tool.execute(
      "read",
      { path: "one-line.txt" },
      undefined,
      undefined,
      context,
    );
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text && text.type === "text");
    assert.match(text.text, /10 KiB limit/);
    assert.match(text.text, /head -c 10240/);
    assert.doesNotMatch(text.text, /51200|50(?:\.0)?\s*(?:KB|KiB)/);
  });

  it("keeps the first-line notice complete when the path itself is enormous", async () => {
    const tool = createReadOverride("/project", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("x".repeat(60 * 1024)),
      },
    });

    const result = await tool.execute(
      "read",
      { path: "x".repeat(MAX_OUTPUT_BYTES) },
      undefined,
      undefined,
      context,
    );
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text && text.type === "text");
    assert.ok(Buffer.byteLength(text.text) <= MAX_OUTPUT_BYTES);
    assert.match(text.text, /<path> \| head -c 10240\]$/);
  });

  it("recognizes native suffixes without accepting arbitrary bracketed content", () => {
    const suffix = splitNativeReadSuffix(
      "a\nb\n\n[Showing lines 1-2 of 5 (legacy limit). Use offset=3 to continue.]",
    );
    assert.equal(suffix.body, "a\nb");
    assert.equal(suffix.totalFileLines, 5);
    assert.equal(splitNativeReadSuffix("a\n\n[user content]").body, "a\n\n[user content]");
  });
});

describe("find and ls overrides", () => {
  it("clamps find results and keeps a native-compatible detail", async () => {
    const root = await mkdtemp(join(tmpdir(), "tool-limits-find-"));
    try {
      let observedLimit = 0;
      const tool = createFindOverride(root, {
        operations: {
          exists: () => true,
          glob: (_pattern, _cwd, options) => {
            observedLimit = options.limit;
            return Array.from({ length: FIND_MAX_RESULTS + 1 }, (_, i) => `file-${i}.ts`);
          },
        },
      });
      const result = await tool.execute(
        "find",
        { pattern: "*.ts", limit: 9999 },
        undefined,
        undefined,
        context,
      );
      assert.equal(observedLimit, FIND_MAX_RESULTS);
      assert.equal(result.details?.resultLimitReached, FIND_MAX_RESULTS);
      const text = result.content.find((part) => part.type === "text");
      if (text?.type !== "text") throw new Error("expected text result");
      assert.doesNotMatch(text.text, /Use limit=/);
      assert.ok(Buffer.byteLength(text.text) <= MAX_OUTPUT_BYTES);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clamps ls entries and keeps the entry limit field", async () => {
    const root = await mkdtemp(join(tmpdir(), "tool-limits-ls-"));
    try {
      const entries = Array.from({ length: LS_MAX_ENTRIES + 1 }, (_, i) => `entry-${i}`);
      const tool = createLsOverride(root, {
        operations: {
          exists: () => true,
          readdir: () => entries,
          stat: (path) => ({ isDirectory: () => path === root }),
        },
      });
      const result = await tool.execute(
        "ls",
        { path: ".", limit: 9999 },
        undefined,
        undefined,
        context,
      );
      assert.equal(entries.length, LS_MAX_ENTRIES + 1);
      assert.equal(result.details?.entryLimitReached, LS_MAX_ENTRIES);
      const text = result.content.find((part) => part.type === "text");
      if (text?.type !== "text") throw new Error("expected text result");
      assert.doesNotMatch(text.text, /Use limit=/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
