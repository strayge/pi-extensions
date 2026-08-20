import { type TruncationResult, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

export const MAX_OUTPUT_BYTES = 10 * 1024;
export const READ_MAX_LINES = 1000;
export const BASH_MAX_LINES = 1000;
export const GREP_MAX_MATCHES = 100;
export const GREP_MAX_LINE_LENGTH = 500;
export const FIND_MAX_RESULTS = 200;
export const LS_MAX_ENTRIES = 500;

export const OUTPUT_LIMIT_TEXT = "10 KiB";
export const OUTPUT_SEPARATOR = "\n\n";

export type TruncationDirection = "head" | "tail";

export interface TruncationSource {
  totalLines: number;
  totalBytes: number;
  truncatedBy?: "lines" | "bytes" | null;
  lastLinePartial?: boolean;
  firstLineExceedsLimit?: boolean;
}

export interface FinalizeOptions {
  maxLines: number;
  direction: TruncationDirection;
  notice?: (truncation: TruncationResult) => string;
  alwaysIncludeNotice?: boolean;
  forceTruncated?: boolean;
  source?: TruncationSource;
}

export interface FinalizeResult {
  content: string;
  text: string;
  truncation?: TruncationResult;
  notice?: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= 0; end--) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // Try the preceding byte until the cut is on a complete code point.
    }
  }
  return "";
}

function effectiveTruncation(
  candidate: TruncationResult,
  source: TruncationSource | undefined,
  forceTruncated: boolean,
): TruncationResult {
  const totalLines = source?.totalLines ?? candidate.totalLines;
  const totalBytes = source?.totalBytes ?? candidate.totalBytes;
  const outputLines = candidate.outputLines;
  const outputBytes = byteLength(candidate.content);
  const truncated =
    forceTruncated || candidate.truncated || outputLines < totalLines || outputBytes < totalBytes;
  const truncatedBy =
    candidate.truncatedBy ??
    source?.truncatedBy ??
    (outputLines < totalLines ? "lines" : outputBytes < totalBytes ? "bytes" : null);

  return {
    ...candidate,
    content: candidate.content,
    truncated,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines,
    outputBytes,
    lastLinePartial: candidate.lastLinePartial || source?.lastLinePartial || false,
    firstLineExceedsLimit:
      candidate.firstLineExceedsLimit || source?.firstLineExceedsLimit || false,
    maxLines: candidate.maxLines,
    maxBytes: MAX_OUTPUT_BYTES,
  };
}

function truncate(
  content: string,
  direction: TruncationDirection,
  maxLines: number,
  maxBytes: number,
): TruncationResult {
  return direction === "head"
    ? truncateHead(content, { maxLines, maxBytes })
    : truncateTail(content, { maxLines, maxBytes });
}

/**
 * Keeps native-compatible metadata while reserving space for the complete notice.
 * The native helpers are deliberately used for byte-safe UTF-8 and line boundaries.
 */
export function finalizeOutput(content: string, options: FinalizeOptions): FinalizeResult {
  const initial = effectiveTruncation(
    truncate(content, options.direction, options.maxLines, MAX_OUTPUT_BYTES),
    options.source,
    options.forceTruncated ?? false,
  );
  const mustAddNotice =
    Boolean(options.notice) &&
    (options.alwaysIncludeNotice || options.forceTruncated || initial.truncated);

  if (!mustAddNotice) {
    return initial.truncated
      ? { content: initial.content, text: initial.content, truncation: initial }
      : { content, text: content };
  }

  let candidate = initial;
  let notice = options.notice?.(candidate) ?? "";

  for (let attempt = 0; attempt < 8; attempt++) {
    const noticeBytes = byteLength(OUTPUT_SEPARATOR + notice);
    const contentBudget = Math.max(0, MAX_OUTPUT_BYTES - noticeBytes);
    const rawCandidate = truncate(content, options.direction, options.maxLines, contentBudget);
    candidate = effectiveTruncation(rawCandidate, options.source, true);
    const nextNotice = options.notice?.(candidate) ?? notice;

    if (
      nextNotice === notice &&
      byteLength(rawCandidate.content + OUTPUT_SEPARATOR + nextNotice) <= MAX_OUTPUT_BYTES
    ) {
      notice = nextNotice;
      break;
    }
    notice = nextNotice;
  }

  const separator = candidate.content.length > 0 ? OUTPUT_SEPARATOR : "";
  const text = `${candidate.content}${separator}${notice}`;
  if (byteLength(text) <= MAX_OUTPUT_BYTES) {
    return { content: candidate.content, text, truncation: candidate, notice };
  }

  // Notices in this extension are short and structured. This last guard keeps the
  // context invariant even if a future notice adds an unexpectedly long path.
  const noticeBudget = Math.max(0, MAX_OUTPUT_BYTES - byteLength(separator + candidate.content));
  const safeNotice = truncateUtf8(notice, noticeBudget);
  return {
    content: candidate.content,
    text: `${candidate.content}${separator}${safeNotice}`,
    truncation: candidate,
    notice: safeNotice,
  };
}

export function formatOutputLimit(): string {
  return OUTPUT_LIMIT_TEXT;
}

export function withEffectiveLimits(
  truncation: TruncationResult | undefined,
  maxLines: number,
): TruncationResult | undefined {
  if (!truncation) return undefined;
  return { ...truncation, maxBytes: MAX_OUTPUT_BYTES, maxLines };
}

export function countCompleteLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}
