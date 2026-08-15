import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { markdownThemeFrom, renderTranscriptLines, summarizeToolArgs } from "../src/ui/transcript-render.js";

/** Plain-text theme: keeps assertions readable while exercising every fg/bold call. */
function plainTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
}

/** Tagged theme: makes the chosen color name assertable. */
function taggedTheme() {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<b>${text}</b>`,
  } as any;
}

function render(messages: any[], width = 80, theme = plainTheme()) {
  return renderTranscriptLines(messages, width, theme, markdownThemeFrom(theme));
}

function assistant(content: any[]) {
  return { role: "assistant", content };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}

function toolResult(toolCallId: string, text: string, isError = false) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text }], isError };
}

const unsafeTerminalControl = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

describe("summarizeToolArgs", () => {
  it("leads with the command for bash", () => {
    expect(summarizeToolArgs("bash", { command: "git ls-files", timeout: 30 })).toBe("git ls-files");
  });

  it("leads with the path for file tools", () => {
    expect(summarizeToolArgs("read", { path: "/tmp/a.py" })).toBe("/tmp/a.py");
    expect(summarizeToolArgs("write", { path: "/tmp/a.py", content: "x".repeat(500) })).toBe("/tmp/a.py");
    expect(summarizeToolArgs("edit", { path: "src/index.ts" })).toBe("src/index.ts");
  });

  it("pairs a grep pattern with where it searched", () => {
    expect(summarizeToolArgs("grep", { pattern: "FastAPI", path: "/repo" })).toBe("FastAPI · /repo");
    expect(summarizeToolArgs("grep", { pattern: "FastAPI" })).toBe("FastAPI");
  });

  it("falls back to key=value pairs for unknown tools", () => {
    const summary = summarizeToolArgs("custom_tool", { alpha: "one", beta: 2 });
    expect(summary).toBe("alpha=one beta=2");
  });

  it("caps the pairs so one huge argument cannot dominate", () => {
    const summary = summarizeToolArgs("custom_tool", { a: "1", b: "2", c: "3", d: "4" });
    expect(summary).toBe("a=1 b=2 c=3");
  });

  it("collapses whitespace so a multi-line command stays on one line", () => {
    expect(summarizeToolArgs("bash", { command: "echo a\n  echo b" })).toBe("echo a echo b");
  });

  it("ellipsizes an over-long argument", () => {
    const summary = summarizeToolArgs("bash", { command: "x".repeat(400) });
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(201);
  });

  it("removes terminal controls from arguments", () => {
    const summary = summarizeToolArgs("bash", {
      command: "echo \x1b[2Avisible \x1b]0;hidden-title\x07done",
    });
    expect(summary).toBe("echo visible done");
    expect(summary).not.toMatch(unsafeTerminalControl);
  });

  it("survives a missing or wrongly-typed expected field", () => {
    expect(summarizeToolArgs("bash", undefined)).toBe("");
    expect(summarizeToolArgs("bash", {})).toBe("");
    expect(summarizeToolArgs("read", { path: 42 })).toBe("path=42");
  });
});

describe("renderTranscriptLines", () => {
  it("shows the tool name with its arguments, not a bare [Tool: name] label", () => {
    const lines = render([assistant([toolCall("c1", "bash", { command: "git ls-files" })])]);
    expect(lines.join("\n")).toContain("bash git ls-files");
    expect(lines.join("\n")).not.toContain("[Tool:");
  });

  it("never emits the [Assistant] label pi itself does not show", () => {
    const lines = render([assistant([{ type: "text", text: "hello" }])]);
    const joined = lines.join("\n");
    expect(joined).toContain("hello");
    expect(joined).not.toContain("[Assistant]");
    expect(joined).not.toContain("[Result]");
  });

  it("hangs a tool result under the call that produced it", () => {
    const lines = render([
      assistant([toolCall("c1", "write", { path: "/tmp/a.py" })]),
      toolResult("c1", "Successfully wrote 317 bytes to /tmp/a.py"),
    ]);
    const titleIndex = lines.findIndex(l => l.includes("write /tmp/a.py"));
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(lines[titleIndex + 1]).toContain("⎿ Successfully wrote 317 bytes");
  });

  it("colors a failed tool result as an error", () => {
    const lines = render(
      [assistant([toolCall("c1", "bash", { command: "python -" })]), toolResult("c1", "python: not found", true)],
      80,
      taggedTheme(),
    );
    expect(lines.some(l => l.includes("<error>") && l.includes("python: not found"))).toBe(true);
  });

  it("bounds long output and reports how much it hid", () => {
    const output = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const lines = render([assistant([toolCall("c1", "bash", { command: "ls" })]), toolResult("c1", output)]);
    expect(lines.some(l => l.includes("line 7"))).toBe(true);
    expect(lines.some(l => l.includes("line 8"))).toBe(false);
    expect(lines.some(l => l.includes("… 5 more lines"))).toBe(true);
  });

  it("uses the singular when exactly one line is hidden", () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
    const lines = render([assistant([toolCall("c1", "bash", { command: "ls" })]), toolResult("c1", output)]);
    expect(lines.some(l => l.includes("… 1 more line"))).toBe(true);
    expect(lines.some(l => l.includes("more lines"))).toBe(false);
  });

  it("renders assistant markdown instead of raw source", () => {
    const lines = render([assistant([{ type: "text", text: "# Heading\n\n- one\n- two" }])], 80, taggedTheme());
    const joined = lines.join("\n");
    expect(joined).toContain("<mdHeading>");
    expect(joined).toContain("<mdListBullet>");
    // The literal markdown syntax should be consumed by the renderer.
    expect(joined).not.toContain("# Heading");
  });

  it("marks user messages with a quote glyph rather than a [User] label", () => {
    const lines = render([{ role: "user", content: "do the thing" }]);
    expect(lines.some(l => l.startsWith("> do the thing"))).toBe(true);
    expect(lines.join("\n")).not.toContain("[User]");
  });

  it("accepts a user message whose content is an array of parts", () => {
    const lines = render([{ role: "user", content: [{ type: "text", text: "from parts" }] }]);
    expect(lines.some(l => l.includes("from parts"))).toBe(true);
  });

  it("still renders a tool result whose call is missing", () => {
    const lines = render([toolResult("orphan", "output with no call")]);
    expect(lines.some(l => l.includes("output with no call"))).toBe(true);
  });

  it("does not render a result twice when the call is present", () => {
    const lines = render([
      assistant([toolCall("c1", "read", { path: "a.txt" })]),
      toolResult("c1", "unique-marker"),
    ]);
    expect(lines.filter(l => l.includes("unique-marker"))).toHaveLength(1);
  });

  it("renders bashExecution messages", () => {
    const lines = render([{ role: "bashExecution", command: "ls -la", output: "total 0" }]);
    const joined = lines.join("\n");
    expect(joined).toContain("$ ls -la");
    expect(joined).toContain("total 0");
  });

  it("normalizes CRLF and bare CR across transcript text paths", () => {
    const lines = render([
      { role: "user", content: "user one\r\nuser two\ruser three" },
      assistant([
        { type: "text", text: "assistant one\r\nassistant two\rassistant three" },
        toolCall("c1", "bash", { command: "echo arg one\r\narg two\rarg three" }),
      ]),
      toolResult("c1", "tool one\r\ntool two\rtool three"),
      { role: "bashExecution", command: "printf bash\r\ncommand", output: "bash one\r\nbash two\rbash three" },
    ]);
    const joined = lines.join("\n");

    for (const text of [
      "user one", "user two", "user three",
      "assistant one", "assistant two", "assistant three",
      "echo arg one arg two arg three",
      "tool one", "tool two", "tool three",
      "$ printf bash command", "bash one", "bash two", "bash three",
    ]) {
      expect(joined).toContain(text);
    }
    expect(joined).not.toContain("\r");
  });

  it("strips external CSI, OSC, and APC sequences without hiding ordinary text", () => {
    const csi = "\x1b[2A";
    const osc = "\x1b]0;hidden-title\x07";
    const apc = "\x1b_hidden-command\x1b\\";
    const lines = render([
      { role: "user", content: `user ${csi}visible ${osc}after-user\bcontrol-visible` },
      assistant([
        { type: "text", text: `assistant ${apc}visible` },
        toolCall("c1", "bash", { command: `echo ${csi}argument-visible` }),
      ]),
      toolResult("c1", `tool ${csi}visible ${apc}result-visible`),
      { role: "bashExecution", command: `printf ${osc}command-visible`, output: `bash ${csi}output-visible` },
    ]);
    const joined = lines.join("\n");

    for (const text of [
      "user visible after-user control-visible",
      "assistant visible",
      "echo argument-visible",
      "tool visible result-visible",
      "$ printf command-visible",
      "bash output-visible",
    ]) {
      expect(joined).toContain(text);
    }
    expect(joined).not.toContain("hidden-title");
    expect(joined).not.toContain("hidden-command");
    for (const line of lines) expect(line).not.toMatch(unsafeTerminalControl);
  });

  it("preserves theme styling added after transcript sanitization", () => {
    const theme = {
      fg: (_color: string, text: string) => `\x1b[35m${text}\x1b[0m`,
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    } as any;
    const joined = render([{ role: "user", content: "safe\x1b[2A text" }], 80, theme).join("\n");

    expect(joined).toContain("safe text");
    expect(joined).toContain("\x1b[35m");
    expect(joined).not.toContain("\x1b[2A");
  });

  it("skips empty messages without leaving blank runs", () => {
    const lines = render([
      { role: "user", content: "   " },
      assistant([{ type: "text", text: "" }]),
      { role: "user", content: "real" },
    ]);
    expect(lines[0]).toContain("real");
  });

  it("ignores unknown roles", () => {
    expect(render([{ role: "somethingElse", content: "x" }])).toEqual([]);
  });

  it("keeps every line within the requested width", () => {
    const width = 40;
    const lines = render(
      [
        { role: "user", content: "a ".repeat(100) },
        assistant([
          { type: "text", text: "some **long** markdown ".repeat(20) },
          toolCall("c1", "bash", { command: "echo " + "z".repeat(300) }),
        ]),
        toolResult("c1", "w".repeat(500)),
      ],
      width,
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const [index, line] of lines.entries()) {
      expect(visibleWidth(line), `line ${index} too wide: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
    }
  });

  it("returns nothing for a non-positive width", () => {
    expect(render([{ role: "user", content: "x" }], 0)).toEqual([]);
  });
});
