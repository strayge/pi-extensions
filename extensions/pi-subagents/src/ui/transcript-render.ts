/**
 * transcript-render.ts — Render an agent's message history the way pi renders
 * the main conversation.
 *
 * The viewer shows another session's `messages` array, and pi exposes no
 * "render these like the main chat" API — its transcript is built from
 * interactive-mode components pushed into pi's own chat container. So the
 * formatting is reproduced here, deliberately following pi's conventions
 * rather than inventing new ones: assistant prose goes through the real
 * markdown renderer, a tool call is a bold title plus its arguments, and its
 * output hangs underneath on a `⎿` continuation.
 */

import { Markdown, type MarkdownTheme, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { extractText } from "../context.js";
import type { Theme } from "./agent-widget.js";

/** Output lines shown per tool result before the rest is summarized away. */
const TOOL_OUTPUT_LINES = 7;
/** Cap on a single argument summary before it is ellipsized. */
const MAX_ARG_CHARS = 200;

/** Minimal shape of a `toolCall` content part (pi-ai `ToolCall`). */
interface ToolCallPart {
  type: "toolCall";
  id?: string;
  name?: string;
  /** pi-ai names this `arguments`; older/foreign payloads may use `args`. */
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

interface RenderedToolResult {
  text: string;
  isError: boolean;
}

/**
 * Map the viewer's `{ fg, bold }` theme onto a `MarkdownTheme`.
 *
 * Deliberately not `getMarkdownTheme()`: that reads the process-global theme
 * and throws when it has not been initialized, which would make this module
 * unusable outside a live session (tests, scratch renders). The `md*` color
 * keys are pi's own, so a real session still gets pi's palette.
 */
export function markdownThemeFrom(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", theme.bold(text)),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.fg("muted", text),
    strikethrough: (text) => theme.fg("dim", text),
    underline: (text) => theme.fg("accent", text),
  };
}

function collapse(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > MAX_ARG_CHARS ? `${text.slice(0, MAX_ARG_CHARS)}…` : text;
}

/**
 * One-line argument summary for a tool call.
 *
 * Leads with the argument that identifies what the call actually did — the
 * command for `bash`, the path for file tools — because that is the part a
 * reader scans for. Unknown tools fall back to compact `key=value` pairs so a
 * custom or extension tool still shows something useful.
 */
export function summarizeToolArgs(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const str = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };

  switch (name) {
    case "bash": {
      const command = str("command");
      if (command) return collapse(command);
      break;
    }
    case "read":
    case "write":
    case "ls": {
      const path = str("path");
      if (path) return collapse(path);
      break;
    }
    case "edit": {
      const path = str("path");
      if (path) return collapse(path);
      break;
    }
    case "grep": {
      const pattern = str("pattern");
      const where = str("path") ?? str("glob");
      if (pattern) return collapse(where ? `${pattern} · ${where}` : pattern);
      break;
    }
    case "find": {
      const pattern = str("pattern") ?? str("glob");
      if (pattern) return collapse(pattern);
      break;
    }
    default:
      break;
  }

  // Unknown tool, or the expected field was absent/non-string.
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    if (rendered === undefined) continue;
    parts.push(`${key}=${rendered}`);
    if (parts.length === 3) break;
  }
  return collapse(parts.join(" "));
}

function toolCallParts(content: unknown): ToolCallPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is ToolCallPart =>
    !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall");
}

/** Index tool results by call id so each one renders under the call that made it. */
function indexResults(messages: readonly any[]): Map<string, RenderedToolResult> {
  const byId = new Map<string, RenderedToolResult>();
  for (const message of messages) {
    if (message?.role !== "toolResult") continue;
    const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    if (!id) continue;
    byId.set(id, {
      text: extractText(Array.isArray(message.content) ? message.content : []),
      isError: message.isError === true,
    });
  }
  return byId;
}

/** Ids of calls that will render a result inline, so their result message can be skipped. */
function indexCallIds(messages: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    for (const call of toolCallParts(message.content)) {
      if (typeof call.id === "string") ids.add(call.id);
    }
  }
  return ids;
}

/**
 * Render a tool result under its call: a `⎿` elbow on the first line, aligned
 * continuation after that, bounded to `TOOL_OUTPUT_LINES` with a count of what
 * was dropped. Errors take the error color so a failed call is visible without
 * reading the text.
 */
function toolOutputLines(result: RenderedToolResult, width: number, theme: Theme): string[] {
  const text = result.text.trim();
  if (!text) return [];
  const color = result.isError ? "error" : "toolOutput";
  const source = text.split("\n");
  const shown = source.slice(0, TOOL_OUTPUT_LINES);
  const lines: string[] = [];
  for (const [index, line] of shown.entries()) {
    const prefix = index === 0 ? "  ⎿ " : "    ";
    lines.push(truncateToWidth(theme.fg(color, prefix + line), width));
  }
  const hidden = source.length - shown.length;
  if (hidden > 0) {
    lines.push(truncateToWidth(theme.fg("dim", `    … ${hidden} more line${hidden === 1 ? "" : "s"}`), width));
  }
  return lines;
}

/**
 * Build the viewer's content lines for a session's messages.
 *
 * Every returned line is already truncated to `width`; an over-wide line is a
 * fatal render error in pi, so callers must not need a second pass.
 */
export function renderTranscriptLines(
  messages: readonly any[],
  width: number,
  theme: Theme,
  markdownTheme: MarkdownTheme,
): string[] {
  if (width <= 0) return [];

  const resultsById = indexResults(messages);
  const attachedCallIds = indexCallIds(messages);
  const lines: string[] = [];
  const pushBlank = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  };

  for (const message of messages) {
    // Tool results are rendered under their call, not as standalone blocks.
    // An orphan (no matching call) still renders so nothing is silently lost.
    if (message?.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      if (id && attachedCallIds.has(id)) continue;
      const orphan = {
        text: extractText(Array.isArray(message.content) ? message.content : []),
        isError: message.isError === true,
      };
      const rendered = toolOutputLines(orphan, width, theme);
      if (rendered.length) {
        pushBlank();
        lines.push(...rendered);
      }
      continue;
    }

    if (message?.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : extractText(Array.isArray(message.content) ? message.content : []);
      if (!text.trim()) continue;
      pushBlank();
      for (const line of wrapTextWithAnsi(text.trim(), Math.max(1, width - 2))) {
        lines.push(truncateToWidth(theme.fg("userMessageText", `> ${line}`), width));
      }
      continue;
    }

    if (message?.role === "assistant") {
      const text = extractText(Array.isArray(message.content) ? message.content : []).trim();
      if (text) {
        pushBlank();
        // Markdown owns its own wrapping; it renders to exactly `width`.
        for (const line of new Markdown(text, 0, 0, markdownTheme).render(width)) {
          lines.push(truncateToWidth(line, width));
        }
      }
      for (const call of toolCallParts(message.content)) {
        const name = call.name ?? "tool";
        const summary = summarizeToolArgs(name, call.arguments ?? call.args);
        pushBlank();
        const title = theme.fg("toolTitle", theme.bold(name));
        lines.push(truncateToWidth(summary ? `${title} ${theme.fg("dim", summary)}` : title, width));
        const result = call.id ? resultsById.get(call.id) : undefined;
        if (result) lines.push(...toolOutputLines(result, width, theme));
      }
      continue;
    }

    if (message?.role === "bashExecution") {
      pushBlank();
      lines.push(truncateToWidth(theme.fg("bashMode", `$ ${collapse(String(message.command ?? ""))}`), width));
      const output = typeof message.output === "string" ? message.output : "";
      if (output.trim()) {
        lines.push(...toolOutputLines({ text: output, isError: false }, width, theme));
      }
    }
  }

  return lines;
}
