import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addGrepGuidance,
  GREP_GUIDANCE,
  limitGrepText,
  MAX_GREP_OUTPUT_BYTES,
} from "../src/index.ts";

const NOTICE = "[Output truncated by pi-grep-output-limit: 10KB maximum.]";

describe("addGrepGuidance", () => {
  it("appends the guidance to an existing system prompt", () => {
    assert.equal(addGrepGuidance("Base prompt"), `Base prompt\n\n${GREP_GUIDANCE}`);
  });

  it("does not duplicate inherited guidance", () => {
    const prompt = `Base prompt\n\n${GREP_GUIDANCE}`;

    assert.equal(addGrepGuidance(prompt), prompt);
  });
});

describe("limitGrepText", () => {
  it("leaves results within the limit unchanged", () => {
    const text = "src/index.ts:1:match\nsrc/index.ts:2:another";

    assert.equal(limitGrepText(text), text);
  });

  it("keeps the complete leading lines and includes the notice within 10KB", () => {
    const line = `${"x".repeat(198)}\n`;
    const text = line.repeat(100);
    const result = limitGrepText(text);

    assert.ok(result.startsWith("x".repeat(198)));
    assert.ok(result.endsWith(NOTICE));
    assert.ok(Buffer.byteLength(result, "utf8") <= MAX_GREP_OUTPUT_BYTES);
    assert.equal(result.slice(0, -NOTICE.length).trimEnd().endsWith("x".repeat(198)), true);
  });

  it("measures multibyte output by bytes", () => {
    const text = `${"界".repeat(100)}\n`.repeat(100);
    const result = limitGrepText(text);

    assert.ok(Buffer.byteLength(result, "utf8") <= MAX_GREP_OUTPUT_BYTES);
    assert.ok(result.endsWith(NOTICE));
  });

  it("returns only the notice when the first line cannot fit", () => {
    const result = limitGrepText("x".repeat(MAX_GREP_OUTPUT_BYTES + 1));

    assert.equal(result, NOTICE);
  });
});
