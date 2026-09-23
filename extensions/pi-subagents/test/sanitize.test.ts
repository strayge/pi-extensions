/**
 * sanitize.test.ts — transcript data must not reach the terminal as instructions.
 *
 * The viewer renders message text byte-for-byte through pi-tui's wrapping and
 * Markdown paths, which preserve ANSI. Anything a tool emitted — a hostile MCP
 * response, an accidental `cat` of a binary — would otherwise repaint the
 * user's terminal from inside a result block.
 */
import { describe, expect, it } from "vitest";
import { sanitizeTranscriptText } from "../src/ui/sanitize.js";

const unsafeTerminalControl = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

describe("sanitizeTranscriptText", () => {
  it("normalizes CRLF and bare CR to LF", () => {
    expect(sanitizeTranscriptText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("strips CSI sequences without hiding ordinary text", () => {
    expect(sanitizeTranscriptText("a\x1b[2Jb")).toBe("ab");
    expect(sanitizeTranscriptText("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips OSC/APC string sequences with their payloads", () => {
    expect(sanitizeTranscriptText("a\x1b]0;hidden-title\x07b")).toBe("ab");
    expect(sanitizeTranscriptText("a\x1b_hidden-command\x1b\\b")).toBe("ab");
  });

  it("neutralizes C1 controls and Fe escape sequences", () => {
    // pi-tui's strip consumes the C1 introducer together with its final byte;
    // what matters is nothing executable survives, not the exact remainder.
    expect(sanitizeTranscriptText("a\x9bb")).not.toContain("\x9b");
    expect(sanitizeTranscriptText("a\x1bXdata\x07b")).toBe("ab");
  });

  it("neutralizes remaining controls: bell, null, tabs", () => {
    expect(sanitizeTranscriptText("a\x07b")).toBe("a b");
    expect(sanitizeTranscriptText("a\x00b")).toBe("a b");
    expect(sanitizeTranscriptText("a\tb")).toBe("a   b");
  });

  it("leaves ordinary text — including unicode — untouched", () => {
    const text = "Review this change 代码审查员 — all good.";
    expect(sanitizeTranscriptText(text)).toBe(text);
  });

  it("leaves no unsafe control in a hostile mix", () => {
    const hostile = "x\x1b[2A\x1b]0;t\x07\x00\x1bXq\x07\x9b5$y\tz\r\nw\rdone";
    const out = sanitizeTranscriptText(hostile);
    expect(out).not.toMatch(unsafeTerminalControl);
    expect(out).toContain("done");
  });
});
