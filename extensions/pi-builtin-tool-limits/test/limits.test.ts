import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import {
  BASH_MAX_LINES,
  finalizeOutput,
  GREP_MAX_MATCHES,
  MAX_OUTPUT_BYTES,
  READ_MAX_LINES,
} from "../src/limits.ts";

const notice = (truncation: { truncatedBy: string | null }) =>
  `[truncated: ${truncation.truncatedBy ?? "none"}]`;

describe("finalizeOutput", () => {
  it("keeps exactly the byte limit when no notice is needed", () => {
    const text = "x".repeat(MAX_OUTPUT_BYTES);
    const result = finalizeOutput(text, { direction: "head", maxLines: READ_MAX_LINES });
    assert.equal(result.text, text);
    assert.equal(Buffer.byteLength(result.text), MAX_OUTPUT_BYTES);
  });

  it("still truncates when no notice is requested", () => {
    const result = finalizeOutput("xxxxxxxxxx\n".repeat(2000), {
      direction: "head",
      maxLines: READ_MAX_LINES,
    });

    assert.ok(Buffer.byteLength(result.text) <= MAX_OUTPUT_BYTES);
    assert.ok(result.text.length > 0);
    assert.equal(result.truncation?.truncated, true);
  });

  it("reserves the complete notice inside the byte limit", () => {
    const text = "x".repeat(MAX_OUTPUT_BYTES + 1);
    const result = finalizeOutput(text, {
      direction: "head",
      maxLines: READ_MAX_LINES,
      forceTruncated: true,
      notice,
    });
    assert.ok(result.truncation?.truncated);
    assert.ok(result.text.endsWith("]"));
    assert.ok(Buffer.byteLength(result.text) <= MAX_OUTPUT_BYTES);
  });

  it("keeps complete head lines and returns a notice for an oversized first line", () => {
    const result = finalizeOutput("x".repeat(MAX_OUTPUT_BYTES + 1), {
      direction: "head",
      maxLines: READ_MAX_LINES,
      forceTruncated: true,
      notice: (truncation) => (truncation.firstLineExceedsLimit ? "[first line]" : "[truncated]"),
    });
    assert.equal(result.content, "");
    assert.equal(result.text, "[first line]");
    assert.equal(result.truncation?.firstLineExceedsLimit, true);
  });

  it("retains the tail and handles multibyte UTF-8 boundaries", () => {
    const text = `${"界".repeat(100)}\n`.repeat(200);
    const result = finalizeOutput(text, {
      direction: "tail",
      maxLines: BASH_MAX_LINES,
      forceTruncated: true,
      notice,
    });
    assert.ok(result.text.includes("界"));
    assert.ok(Buffer.byteLength(result.text) <= MAX_OUTPUT_BYTES);
    assert.doesNotMatch(result.content, /�/);
  });

  it("applies the exact line boundary", () => {
    const exact = Array.from({ length: GREP_MAX_MATCHES }, (_, i) => `m${i}`).join("\n");
    const oneOver = `${exact}\nm${GREP_MAX_MATCHES}`;
    assert.equal(
      truncateHead(exact, { maxLines: GREP_MAX_MATCHES, maxBytes: MAX_OUTPUT_BYTES }).truncated,
      false,
    );
    assert.equal(
      truncateHead(oneOver, { maxLines: GREP_MAX_MATCHES, maxBytes: MAX_OUTPUT_BYTES }).outputLines,
      GREP_MAX_MATCHES,
    );
    assert.equal(
      truncateTail(oneOver, { maxLines: GREP_MAX_MATCHES, maxBytes: MAX_OUTPUT_BYTES }).outputLines,
      GREP_MAX_MATCHES,
    );
  });
});
