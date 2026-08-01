import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../src/config.ts";
import { formatCwd, formatTokens, sanitize, shortenModel } from "../src/format.ts";
import { formatGitStatus, parseGitStatus } from "../src/git-status.ts";
import { renderStatusline } from "../src/render.ts";
import { fakeEnv, identityTheme } from "./helpers.ts";

test("formatTokens matches pi's own rounding", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(12_000), "12k");
  assert.equal(formatTokens(999_999), "1000k");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(12_000_000), "12M");
});

test("formatCwd abbreviates the home directory only when inside it", () => {
  assert.equal(formatCwd("/home/u/work", "/home/u"), "~/work");
  assert.equal(formatCwd("/home/u", "/home/u"), "~");
  assert.equal(formatCwd("/var/log", "/home/u"), "/var/log");
  assert.equal(formatCwd("/home/user2/x", "/home/u"), "/home/user2/x");
  assert.equal(formatCwd("/home/u/work", undefined), "/home/u/work");
});

test("shortenModel drops the vendor prefix and release date", () => {
  assert.equal(shortenModel("anthropic/claude-opus-5-20260101"), "claude-opus-5");
  assert.equal(shortenModel("openai-gpt-5"), "gpt-5");
  assert.equal(shortenModel("gpt-5"), "gpt-5");
});

test("sanitize flattens whitespace but keeps color codes", () => {
  assert.equal(sanitize("a\nb\tc  d "), "a b c d");
  assert.equal(sanitize("[32mok[0m"), "[32mok[0m");
});

test("parseGitStatus counts staged, unstaged, untracked, and tracking", () => {
  const status = parseGitStatus(
    [
      "## main...origin/main [ahead 2, behind 3]",
      "M  staged.ts",
      " M unstaged.ts",
      "MM both.ts",
      "?? new.ts",
      "",
    ].join("\n"),
  );

  assert.deepEqual(status, { staged: 2, unstaged: 2, untracked: 1, ahead: 2, behind: 3 });
  assert.equal(formatGitStatus(status), "↑2 ↓3 +2 ~2 ?1");
});

test("a clean tree formats to nothing", () => {
  const status = parseGitStatus("## main...origin/main\n");
  assert.deepEqual(status, { staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 });
  assert.equal(formatGitStatus(status), "");
});

test("git status renders only what is non-zero", () => {
  const config = validateConfig({ lines: [[{ type: "git_status" }]] }).config;
  const env = fakeEnv({
    runtime: { gitStatus: { staged: 0, unstaged: 1, untracked: 0, ahead: 0, behind: 0 } },
  });
  assert.equal(renderStatusline(80, config, identityTheme(), env)[0], "~1");
});

test("the tools item lists in-flight calls with their multiplicity", () => {
  const config = validateConfig({ lines: [[{ type: "tools" }]] }).config;
  const env = fakeEnv({
    runtime: {
      activeTools: new Map([
        ["read", 2],
        ["bash", 1],
      ]),
    },
  });
  assert.equal(renderStatusline(80, config, identityTheme(), env)[0], "read×2 bash");
});

test("the time item renders a clock and an elapsed duration", () => {
  const clock = validateConfig({ lines: [[{ type: "time" }]] }).config;
  const elapsed = validateConfig({ lines: [[{ type: "time", format: "elapsed" }]] }).config;
  const now = Date.UTC(2026, 0, 2, 3, 4, 5);
  const env = fakeEnv({ runtime: { sessionStartedAt: now - 95 * 60 * 1000 } });

  const local = new Date(now);
  const expected = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  assert.equal(renderStatusline(80, clock, identityTheme(), env)[0], expected);
  assert.equal(renderStatusline(80, elapsed, identityTheme(), env)[0], "1h35m");
});

test("the turn counter appears only after the first turn", () => {
  const config = validateConfig({ lines: [[{ type: "turn", prefix: "#" }]] }).config;
  assert.equal(renderStatusline(80, config, identityTheme(), fakeEnv()).length, 0);
  assert.equal(
    renderStatusline(80, config, identityTheme(), fakeEnv({ runtime: { turnCount: 3 } }))[0],
    "#3",
  );
});

test("the extensions item honours include, exclude, and icons", () => {
  const statuses = { usage: "42%", lsp: "ready", noisy: "spam" };
  const included = validateConfig({
    lines: [[{ type: "extensions", include: ["usage"], icons: { usage: "📊" } }]],
  }).config;
  const excluded = validateConfig({
    lines: [[{ type: "extensions", exclude: ["noisy"], separator: " | " }]],
  }).config;

  assert.equal(renderStatusline(80, included, identityTheme(), fakeEnv({ statuses }))[0], "📊 42%");
  assert.equal(
    renderStatusline(80, excluded, identityTheme(), fakeEnv({ statuses }))[0],
    "ready | 42%",
  );
});
