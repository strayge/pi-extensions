import assert from "node:assert/strict";
import test from "node:test";
import { getDangerousDirectories } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

test("patched sandbox runtime omits Claude-specific write protection", () => {
  const protectedDirectories = getDangerousDirectories();
  assert.equal(protectedDirectories.includes(".claude/commands"), false);
  assert.equal(protectedDirectories.includes(".claude/agents"), false);
  assert.ok(protectedDirectories.includes(".vscode"));
  assert.ok(protectedDirectories.includes(".idea"));
});
