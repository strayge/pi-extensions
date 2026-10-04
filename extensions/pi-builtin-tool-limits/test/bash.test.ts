import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { describe, it } from "node:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createBashOverride } from "../src/bash.ts";
import { BASH_MAX_LINES, MAX_OUTPUT_BYTES } from "../src/limits.ts";

const ctx = {
  sessionManager: {
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
  model: undefined,
  thinkingLevel: undefined,
} as never;

async function runWithChunks(
  chunks: Buffer[],
  exitCode = 0,
  error?: Error,
  onUpdate?: (details: unknown) => void,
) {
  const operations: BashOperations = {
    exec: async (_command, _cwd, options) => {
      for (const chunk of chunks) options.onData(chunk);
      if (error) throw error;
      return { exitCode };
    },
  };
  const tool = createBashOverride("/project", { operations, exposeSessionEnvironment: false });
  return tool.execute(
    "bash",
    { command: "test" },
    undefined,
    onUpdate ? (partial) => onUpdate(partial.details) : undefined,
    ctx,
  );
}

describe("bash capture", () => {
  it("does not create a file below both thresholds", async () => {
    const result = await runWithChunks([Buffer.from("ok")]);
    assert.equal(result.details, undefined);
    assert.equal(result.content[0]?.type, "text");
  });

  it("preserves native structured output beyond the model-facing cap", async () => {
    const output = "structured\n".repeat(1100);
    const result = await runWithChunks([Buffer.from(output)]);
    const structured = result.structuredContent as {
      output: string;
      truncated: boolean;
      exit_code: number;
      wall_time_seconds: number;
    };

    assert.equal(structured.output, output);
    assert.equal(structured.truncated, false);
    assert.equal(structured.exit_code, 0);
    assert.equal(typeof structured.wall_time_seconds, "number");
    assert.ok(
      Buffer.byteLength(result.content[0]?.type === "text" ? result.content[0].text : "") <=
        MAX_OUTPUT_BYTES,
    );
    assert.ok(result.details?.fullOutputPath);
    await rm(result.details.fullOutputPath, { force: true });
  });

  it("keeps the tail, persists exact raw bytes, and reports effective metadata", async () => {
    const chunks = [
      Buffer.from("first\n".repeat(2000)),
      Buffer.from(`${"later\n".repeat(1000)}শেষ\n`, "utf8"),
    ];
    const result = await runWithChunks(chunks, 0, undefined, (details) => {
      if (details)
        assert.notEqual(
          (details as { truncation?: { maxBytes?: number } }).truncation?.maxBytes,
          50 * 1024,
        );
    });
    const text = result.content[0];
    assert.ok(text?.type === "text");
    assert.ok(text.text.includes("শেষ"));
    assert.ok(Buffer.byteLength(text.text) <= MAX_OUTPUT_BYTES);
    assert.equal(result.details?.truncation?.maxBytes, MAX_OUTPUT_BYTES);
    assert.equal(result.details?.truncation?.maxLines, BASH_MAX_LINES);
    assert.ok(result.details?.fullOutputPath);
    assert.deepEqual(await readFile(result.details.fullOutputPath), Buffer.concat(chunks));
    await rm(result.details.fullOutputPath, { force: true });
  });

  it("reports byte truncation when bytes constrain output before the line cap", async () => {
    const chunks = [Buffer.from(`${"x".repeat(20)}\n`.repeat(BASH_MAX_LINES + 1))];
    const result = await runWithChunks(chunks);

    assert.equal(result.details?.truncation?.truncatedBy, "bytes");
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /10 KiB limit/);
    if (result.details?.fullOutputPath) await rm(result.details.fullOutputPath, { force: true });
  });

  it("flushes a split UTF-8 character without replacement characters", async () => {
    const encoded = Buffer.from("prefix-界-suffix", "utf8");
    const split = encoded.indexOf(Buffer.from("界", "utf8")) + 1;
    const result = await runWithChunks([encoded.subarray(0, split), encoded.subarray(split)]);
    const text = result.content[0];
    assert.ok(text?.type === "text");
    assert.equal(text.text, "prefix-界-suffix");
  });

  it("returns native failure metadata and cleans up the temp stream", async () => {
    const chunks = [Buffer.from("output\n".repeat(3000))];
    const result = await runWithChunks(chunks, 7);
    const structured = result.structuredContent as { exit_code: number };
    const path = result.details?.fullOutputPath;

    assert.equal(result.isError, true);
    assert.equal(structured.exit_code, 7);
    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      /Command exited with code 7/,
    );
    assert.ok(path);
    await rm(path, { force: true });
  });

  it("closes and reports the temp stream for timeout and abort errors", async () => {
    for (const message of ["timeout:2", "aborted"]) {
      await assert.rejects(
        () => runWithChunks([Buffer.from("x".repeat(MAX_OUTPUT_BYTES + 1))], 0, new Error(message)),
        (error: Error) => {
          assert.match(
            error.message,
            message === "aborted" ? /Command aborted/ : /Command timed out/,
          );
          assert.match(error.message, /Full output:/);
          return true;
        },
      );
    }
  });
});
