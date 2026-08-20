import {
  type AgentToolResult,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type FindToolDetails,
  type FindToolInput,
  type FindToolOptions,
  type GrepToolDetails,
  type GrepToolInput,
  type GrepToolOptions,
  type LsToolDetails,
  type LsToolInput,
  type LsToolOptions,
  type ReadToolDetails,
  type ReadToolInput,
  type ReadToolOptions,
} from "@earendil-works/pi-coding-agent";
import {
  FIND_MAX_RESULTS,
  finalizeOutput,
  formatOutputLimit,
  GREP_MAX_LINE_LENGTH,
  GREP_MAX_MATCHES,
  LS_MAX_ENTRIES,
  MAX_OUTPUT_BYTES,
  READ_MAX_LINES,
  withEffectiveLimits,
} from "./limits.ts";

export function clampLimit(limit: number | undefined, hardCap: number): number {
  return limit === undefined || limit > hardCap ? hardCap : limit;
}

function replaceTextResult<T>(
  result: AgentToolResult<T>,
  text: string,
  details: T,
): AgentToolResult<T> {
  return {
    ...result,
    content: result.content.map((part) => (part.type === "text" ? { ...part, text } : part)),
    details,
  };
}

interface ReadSuffix {
  body: string;
  kind: "showing" | "more" | "first-line" | undefined;
  startLine?: number;
  endLine?: number;
  totalFileLines?: number;
  nextOffset?: number;
  remainingLines?: number;
  firstLine?: number;
}

/**
 * Recognizes only notices emitted by the built-in read implementation. Keeping
 * this parser narrow prevents user file content from being silently discarded.
 */
export function splitNativeReadSuffix(text: string): ReadSuffix {
  const firstLine = text.match(
    /^\[Line (\d+) is [^\]]+, exceeds [^\]]+ limit\. Use bash: ([\s\S]*)\]$/,
  );
  if (firstLine) {
    return {
      body: "",
      kind: "first-line",
      firstLine: Number(firstLine[1]),
    };
  }

  const showing = text.match(
    /\n\n\[Showing lines (\d+)-(\d+) of (\d+)(?: \([^\]]+ limit\))?\. Use offset=(\d+) to continue\.\]$/,
  );
  if (showing) {
    return {
      body: text.slice(0, showing.index),
      kind: "showing",
      startLine: Number(showing[1]),
      endLine: Number(showing[2]),
      totalFileLines: Number(showing[3]),
      nextOffset: Number(showing[4]),
    };
  }

  const more = text.match(/\n\n\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/);
  if (more) {
    return {
      body: text.slice(0, more.index),
      kind: "more",
      remainingLines: Number(more[1]),
      nextOffset: Number(more[2]),
    };
  }

  return { body: text, kind: undefined };
}

function firstTextPart(result: { content: AgentToolResult<unknown>["content"] }) {
  const part = result.content.find((candidate) => candidate.type === "text");
  return part?.type === "text" ? part : undefined;
}

function formatReadNotice(startLine: number, truncation: ReadToolDetails["truncation"]): string {
  if (truncation?.firstLineExceedsLimit) {
    return `[Line ${startLine} exceeds ${formatOutputLimit()} limit. Use bash to inspect this line, for example: sed -n '${startLine}p' <path> | head -c ${MAX_OUTPUT_BYTES}]`;
  }
  const endLine = startLine + (truncation?.outputLines ?? 0) - 1;
  const nextOffset = Math.max(startLine, endLine + 1);
  const totalLines = truncation?.totalLines ?? endLine;
  const limitSuffix = truncation?.truncatedBy === "bytes" ? ` (${formatOutputLimit()} limit)` : "";
  return `[Showing lines ${startLine}-${Math.max(startLine - 1, endLine)} of ${totalLines}${limitSuffix}. Use offset=${nextOffset} to continue.]`;
}

export type ReadToolDefinition = ReturnType<typeof createReadToolDefinition>;

export function createReadOverride(cwd: string, options?: ReadToolOptions): ReadToolDefinition {
  const native = createReadToolDefinition(cwd, options);
  return {
    ...native,
    description:
      "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 1,000 lines or 10 KiB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const effectiveParams = { ...params, limit: clampLimit(params.limit, READ_MAX_LINES) };
      const result = await native.execute(toolCallId, effectiveParams, signal, onUpdate, ctx);
      const imagePart = result.content.some((part) => part.type === "image");
      if (imagePart) return result;

      const textPart = firstTextPart(result);
      if (!textPart) return result;
      const suffix = splitNativeReadSuffix(textPart.text);
      const startLine = params.offset && params.offset > 0 ? params.offset : 1;
      const nativeTruncation = withEffectiveLimits(result.details?.truncation, READ_MAX_LINES);

      if (suffix.kind === "first-line") {
        const lineNumber = suffix.firstLine ?? startLine;
        const replacementFor = (path: string) =>
          `[Line ${lineNumber} exceeds ${formatOutputLimit()} limit. Use bash: sed -n '${lineNumber}p' ${path} | head -c ${MAX_OUTPUT_BYTES}]`;
        const withPath = replacementFor(params.path);
        const replacement =
          Buffer.byteLength(withPath, "utf8") <= MAX_OUTPUT_BYTES
            ? withPath
            : replacementFor("<path>");
        const bounded = finalizeOutput("", {
          direction: "head",
          maxLines: READ_MAX_LINES,
          forceTruncated: true,
          alwaysIncludeNotice: true,
          notice: () => replacement,
        });
        return replaceTextResult(
          result,
          bounded.text,
          nativeTruncation ? { truncation: nativeTruncation } : undefined,
        );
      }

      const body = suffix.body;
      const userNotice =
        suffix.kind === "more"
          ? `[${suffix.remainingLines} more lines in file. Use offset=${suffix.nextOffset} to continue.]`
          : "";
      const source = nativeTruncation
        ? {
            totalLines: nativeTruncation.totalLines,
            totalBytes: nativeTruncation.totalBytes,
            truncatedBy: nativeTruncation.truncatedBy,
            firstLineExceedsLimit: nativeTruncation.firstLineExceedsLimit,
          }
        : undefined;
      const hardLineCapReached = suffix.kind === "more" && effectiveParams.limit === READ_MAX_LINES;
      const hardTruncation =
        Boolean(nativeTruncation?.truncated) || suffix.kind === "showing" || hardLineCapReached;
      const statusTooLarge =
        userNotice.length > 0 &&
        Buffer.byteLength(`${body}\n\n${userNotice}`, "utf8") > MAX_OUTPUT_BYTES;
      const needsFinalization =
        hardTruncation ||
        statusTooLarge ||
        Buffer.byteLength(body, "utf8") > MAX_OUTPUT_BYTES ||
        body.split("\n").length > READ_MAX_LINES;

      if (!needsFinalization) {
        return replaceTextResult(
          result,
          `${body}${userNotice ? `\n\n${userNotice}` : ""}`,
          undefined,
        );
      }

      const finalized = finalizeOutput(body, {
        direction: "head",
        maxLines: READ_MAX_LINES,
        forceTruncated: true,
        source,
        notice: (truncation) => {
          const displayTotalLines =
            suffix.totalFileLines ??
            startLine - 1 + truncation.totalLines + (suffix.remainingLines ?? 0);
          const displayTruncation = truncation.firstLineExceedsLimit
            ? truncation
            : { ...truncation, totalLines: displayTotalLines };
          return formatReadNotice(startLine, displayTruncation);
        },
      });
      return replaceTextResult(
        result,
        finalized.text,
        finalized.truncation ? { truncation: finalized.truncation } : undefined,
      );
    },
  };
}

function stripNativeListNotice(
  text: string,
  toolName: "grep" | "find" | "ls",
): {
  body: string;
  notice: string | undefined;
} {
  const match = text.match(
    /\n\n\[([^\]]*(?:matches limit reached|results limit reached|entries limit reached|limit reached|Some lines truncated to 500 chars)[^\]]*)\]$/,
  );
  if (!match || match.index === undefined) return { body: text, notice: undefined };
  const notice = match[1] ?? "";
  const expected =
    toolName === "grep"
      ? /matches limit reached|Some lines truncated to 500 chars|\d+(?:\.\d+)?KB limit reached/
      : toolName === "find"
        ? /results limit reached|\d+(?:\.\d+)?KB limit reached/
        : /entries limit reached|\d+(?:\.\d+)?KB limit reached/;
  return expected.test(notice)
    ? { body: text.slice(0, match.index), notice }
    : { body: text, notice: undefined };
}

function listNoticeParts(
  toolName: "grep" | "find" | "ls",
  details: {
    matchLimitReached?: number;
    resultLimitReached?: number;
    entryLimitReached?: number;
    linesTruncated?: boolean;
  },
  truncation: { truncated?: boolean },
): string[] {
  const notices: string[] = [];
  if (toolName === "grep") {
    if (details.matchLimitReached)
      notices.push(
        `${details.matchLimitReached} matches limit reached. Refine the pattern or path`,
      );
    if (truncation.truncated) notices.push(`${formatOutputLimit()} limit reached`);
    if (details.linesTruncated)
      notices.push(
        `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
      );
  } else if (toolName === "find") {
    if (details.resultLimitReached)
      notices.push(
        `${details.resultLimitReached} results limit reached. Refine the pattern or path`,
      );
    if (truncation.truncated) notices.push(`${formatOutputLimit()} limit reached`);
  } else {
    if (details.entryLimitReached)
      notices.push(`${details.entryLimitReached} entries limit reached. Refine the path`);
    if (truncation.truncated) notices.push(`${formatOutputLimit()} limit reached`);
  }
  return notices;
}

function finalizeListResult<
  T extends FindToolDetails | GrepToolDetails | LsToolDetails | undefined,
>(
  toolName: "grep" | "find" | "ls",
  result: AgentToolResult<T>,
  maxLines: number,
): AgentToolResult<T> {
  const textPart = firstTextPart(result);
  if (
    !textPart ||
    textPart.text === "No matches found" ||
    textPart.text === "No files found matching pattern" ||
    textPart.text === "(empty directory)"
  ) {
    return result;
  }

  const stripped = stripNativeListNotice(textPart.text, toolName);
  const nativeTruncation = result.details?.truncation;
  const details = { ...(result.details ?? {}) } as T & {
    matchLimitReached?: number;
    resultLimitReached?: number;
    entryLimitReached?: number;
    linesTruncated?: boolean;
  };
  const nativeNotice = stripped.notice ?? "";
  if (
    toolName === "grep" &&
    details.matchLimitReached === undefined &&
    /matches limit reached/.test(nativeNotice)
  ) {
    details.matchLimitReached = GREP_MAX_MATCHES;
  }
  if (
    toolName === "find" &&
    details.resultLimitReached === undefined &&
    /results limit reached/.test(nativeNotice)
  ) {
    details.resultLimitReached = FIND_MAX_RESULTS;
  }
  if (
    toolName === "ls" &&
    details.entryLimitReached === undefined &&
    /entries limit reached/.test(nativeNotice)
  ) {
    details.entryLimitReached = LS_MAX_ENTRIES;
  }
  if (toolName === "grep" && /Some lines truncated to 500 chars/.test(nativeNotice))
    details.linesTruncated = true;

  const hardTruncation =
    Boolean(nativeTruncation?.truncated) ||
    Buffer.byteLength(stripped.body, "utf8") > MAX_OUTPUT_BYTES;
  const hasNotice =
    hardTruncation ||
    Boolean(
      details.matchLimitReached ||
        details.resultLimitReached ||
        details.entryLimitReached ||
        details.linesTruncated,
    );
  if (!hasNotice) return result;

  const final = finalizeOutput(stripped.body, {
    direction: "head",
    maxLines,
    forceTruncated: hardTruncation,
    source: nativeTruncation
      ? {
          totalLines: nativeTruncation.totalLines,
          totalBytes: nativeTruncation.totalBytes,
          truncatedBy: nativeTruncation.truncatedBy,
          firstLineExceedsLimit: nativeTruncation.firstLineExceedsLimit,
        }
      : undefined,
    alwaysIncludeNotice: true,
    notice: (truncation) => `[${listNoticeParts(toolName, details, truncation).join(". ")}]`,
  });

  if (final.truncation) details.truncation = final.truncation;
  else delete details.truncation;
  const finalDetails = Object.keys(details).length > 0 ? (details as T) : (undefined as T);
  return replaceTextResult(result, final.text, finalDetails);
}

export type GrepToolDefinition = ReturnType<typeof createGrepToolDefinition>;
export type FindToolDefinition = ReturnType<typeof createFindToolDefinition>;
export type LsToolDefinition = ReturnType<typeof createLsToolDefinition>;

export function createGrepOverride(cwd: string, options?: GrepToolOptions): GrepToolDefinition {
  const native = createGrepToolDefinition(cwd, options);
  return {
    ...native,
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is limited to ${GREP_MAX_MATCHES} matches or ${formatOutputLimit()} (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} characters; use read to inspect full lines.`,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const effectiveParams = { ...params, limit: clampLimit(params.limit, GREP_MAX_MATCHES) };
      const result = await native.execute(toolCallId, effectiveParams, signal, onUpdate, ctx);
      return finalizeListResult("grep", result, Number.MAX_SAFE_INTEGER);
    },
  };
}

export function createFindOverride(cwd: string, options?: FindToolOptions): FindToolDefinition {
  const native = createFindToolDefinition(cwd, options);
  return {
    ...native,
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is limited to ${FIND_MAX_RESULTS} results or ${formatOutputLimit()} (whichever is hit first).`,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const effectiveParams = { ...params, limit: clampLimit(params.limit, FIND_MAX_RESULTS) };
      const result = await native.execute(toolCallId, effectiveParams, signal, onUpdate, ctx);
      return finalizeListResult("find", result, Number.MAX_SAFE_INTEGER);
    },
  };
}

export function createLsOverride(cwd: string, options?: LsToolOptions): LsToolDefinition {
  const native = createLsToolDefinition(cwd, options);
  return {
    ...native,
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is limited to ${LS_MAX_ENTRIES} entries or ${formatOutputLimit()} (whichever is hit first).`,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const effectiveParams = { ...params, limit: clampLimit(params.limit, LS_MAX_ENTRIES) };
      const result = await native.execute(toolCallId, effectiveParams, signal, onUpdate, ctx);
      return finalizeListResult("ls", result, Number.MAX_SAFE_INTEGER);
    },
  };
}

export type ToolLimitInput = ReadToolInput | GrepToolInput | FindToolInput | LsToolInput;
