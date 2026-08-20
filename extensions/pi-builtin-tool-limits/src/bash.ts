import { randomUUID } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  type BashOperations,
  type BashToolDetails,
  type BashToolOptions,
  createBashToolDefinition,
  createLocalBashOperations,
  type TruncationResult,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
  BASH_MAX_LINES,
  countCompleteLines,
  finalizeOutput,
  formatOutputLimit,
  MAX_OUTPUT_BYTES,
} from "./limits.ts";

const BASH_DESCRIPTION = `Execute a bash command in the current working directory. Returns stdout and stderr. Output is limited to the last ${BASH_MAX_LINES.toLocaleString()} lines or ${formatOutputLimit()} (whichever is hit first). If truncated, complete output is saved to a temporary file. Optionally provide a timeout in seconds.`;

interface CaptureSnapshot {
  content: string;
  truncated: boolean;
  truncation?: TruncationResult;
  totalLines: number;
  totalBytes: number;
  lastLineBytes: number;
  fullOutputPath?: string;
}

class StreamingCapture {
  private readonly decoder = new StringDecoder("utf8");
  private readonly pendingRaw: Buffer[] = [];
  private tail = "";
  private totalBytes = 0;
  private newlineCount = 0;
  private currentLineBytes = 0;
  private hasDecodedData = false;
  private persistenceStarted = false;
  private persistenceError: Error | undefined;
  private fileHandle: FileHandle | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly outputPath = join(tmpdir(), `pi-bash-${randomUUID()}.log`);

  append(rawChunk: Buffer): void {
    if (this.closed) return;
    const raw = Buffer.from(rawChunk);
    if (this.persistenceStarted) {
      this.enqueueRawWrite(raw);
    } else {
      this.pendingRaw.push(raw);
    }

    this.appendDecoded(this.decoder.write(raw));
    if (!this.persistenceStarted && this.hasCrossedThreshold()) {
      this.startPersistence();
    }
  }

  private appendDecoded(decoded: string): void {
    if (decoded.length === 0) return;
    this.hasDecodedData = true;
    this.totalBytes += Buffer.byteLength(decoded, "utf8");
    const segments = decoded.split("\n");
    for (const [index, segment] of segments.entries()) {
      this.currentLineBytes += Buffer.byteLength(segment, "utf8");
      if (index < segments.length - 1) {
        this.newlineCount++;
        this.currentLineBytes = 0;
      }
    }
    this.tail = truncateTail(`${this.tail}${decoded}`, {
      maxBytes: MAX_OUTPUT_BYTES,
      maxLines: BASH_MAX_LINES,
    }).content;
  }

  private get totalLines(): number {
    if (!this.hasDecodedData) return 0;
    return this.newlineCount + (this.currentLineBytes > 0 ? 1 : 0);
  }

  private hasCrossedThreshold(): boolean {
    return this.totalBytes > MAX_OUTPUT_BYTES || this.totalLines > BASH_MAX_LINES;
  }

  private startPersistence(): void {
    if (this.persistenceStarted) return;
    this.persistenceStarted = true;
    this.writeChain = (async () => {
      try {
        this.fileHandle = await open(this.outputPath, "wx");
        const chunks = this.pendingRaw.splice(0, this.pendingRaw.length);
        for (const chunk of chunks) await this.fileHandle.write(chunk);
      } catch (error) {
        this.persistenceError = error instanceof Error ? error : new Error(String(error));
        throw this.persistenceError;
      }
    })();
  }

  private enqueueRawWrite(raw: Buffer): void {
    this.writeChain = this.writeChain.then(async () => {
      if (this.fileHandle) await this.fileHandle.write(raw);
    });
  }

  snapshot(): CaptureSnapshot {
    const truncated = this.hasCrossedThreshold();
    const tailResult = truncateTail(this.tail, {
      maxBytes: MAX_OUTPUT_BYTES,
      maxLines: BASH_MAX_LINES,
    });
    const retainedLines = countCompleteLines(this.tail);
    const truncation = truncated
      ? {
          ...tailResult,
          truncated: true,
          truncatedBy: (this.totalLines > BASH_MAX_LINES && retainedLines >= BASH_MAX_LINES
            ? "lines"
            : "bytes") as "lines" | "bytes",
          totalLines: this.totalLines,
          totalBytes: this.totalBytes,
          maxBytes: MAX_OUTPUT_BYTES,
          maxLines: BASH_MAX_LINES,
        }
      : undefined;
    return {
      content: this.tail,
      truncated,
      truncation,
      totalLines: this.totalLines,
      totalBytes: this.totalBytes,
      lastLineBytes: this.currentLineBytes,
      fullOutputPath: truncated && this.fileHandle ? this.outputPath : undefined,
    };
  }

  async finish(): Promise<CaptureSnapshot> {
    if (this.closed) {
      if (this.persistenceError) throw this.persistenceError;
      return this.snapshot();
    }

    this.appendDecoded(this.decoder.end());
    if (!this.persistenceStarted && this.hasCrossedThreshold()) this.startPersistence();

    try {
      await this.writeChain;
    } catch (error) {
      this.persistenceError ??= error instanceof Error ? error : new Error(String(error));
    } finally {
      try {
        await this.fileHandle?.close();
      } catch (error) {
        this.persistenceError ??= error instanceof Error ? error : new Error(String(error));
      }
      this.closed = true;
    }

    if (this.persistenceError) throw this.persistenceError;
    return this.snapshot();
  }
}

function statusFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "Command aborted" ||
    message === "aborted" ||
    /(?:^|\n\n)Command aborted$/.test(message)
  ) {
    return "Command aborted";
  }
  const timeout = message.match(/Command timed out after ([^\s]+) seconds|timeout:([^\s]+)/);
  if (timeout) return `Command timed out after ${timeout[1] ?? timeout[2]} seconds`;
  const exit = message.match(/Command exited with code (\d+)/);
  if (exit) return `Command exited with code ${exit[1]}`;
  return message;
}

function renderCapture(
  snapshot: CaptureSnapshot,
  status: string | undefined,
): {
  text: string;
  details?: BashToolDetails;
} {
  const content = snapshot.content || "";
  const needsStatusReservation = Boolean(status);
  const final =
    snapshot.truncated || needsStatusReservation
      ? finalizeOutput(content, {
          direction: "tail",
          maxLines: BASH_MAX_LINES,
          forceTruncated: snapshot.truncated,
          source: snapshot.truncated
            ? {
                totalLines: snapshot.totalLines,
                totalBytes: snapshot.totalBytes,
                truncatedBy: snapshot.truncation?.truncatedBy,
                lastLinePartial:
                  snapshot.truncation?.lastLinePartial || snapshot.lastLineBytes > MAX_OUTPUT_BYTES,
              }
            : undefined,
          alwaysIncludeNotice: needsStatusReservation,
          notice: (truncation) => {
            const notices: string[] = [];
            if (snapshot.truncated) {
              const endLine = snapshot.totalLines;
              const persistence = snapshot.fullOutputPath
                ? `Full output: ${snapshot.fullOutputPath}`
                : "Complete output is being saved";
              if (truncation.lastLinePartial) {
                notices.push(
                  `Showing last ${truncation.outputBytes} bytes of line ${endLine} (line is ${snapshot.lastLineBytes} bytes). ${persistence}`,
                );
              } else if (truncation.truncatedBy === "lines") {
                const startLine = Math.max(1, snapshot.totalLines - truncation.outputLines + 1);
                notices.push(
                  `Showing lines ${startLine}-${endLine} of ${snapshot.totalLines}. ${persistence}`,
                );
              } else {
                const startLine = Math.max(1, snapshot.totalLines - truncation.outputLines + 1);
                notices.push(
                  `Showing lines ${startLine}-${endLine} of ${snapshot.totalLines} (${formatOutputLimit()} limit). ${persistence}`,
                );
              }
            }
            if (status) notices.push(status);
            return `[${notices.join(". ")}]`;
          },
        })
      : undefined;

  if (!final) {
    return { text: content || "(no output)" };
  }
  const text = final.text || status || "(no output)";
  return {
    text,
    details: final.truncation
      ? { truncation: final.truncation, fullOutputPath: snapshot.fullOutputPath }
      : undefined,
  };
}

export type BashToolDefinition = ReturnType<typeof createBashToolDefinition>;

/**
 * Wraps Pi's shell backend rather than reproducing its process and signal handling.
 * The wrapper only owns raw-output capture and the lower context limit.
 */
export function createBashOverride(cwd: string, options?: BashToolOptions): BashToolDefinition {
  const baseOperations =
    options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
  const template = createBashToolDefinition(cwd, { ...options, operations: baseOperations });

  return {
    ...template,
    description: BASH_DESCRIPTION,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const capture = new StreamingCapture();
      const operations: BashOperations = {
        exec: (command, operationCwd, operationOptions) =>
          baseOperations.exec(command, operationCwd, {
            ...operationOptions,
            onData: (data) => {
              capture.append(data);
              operationOptions.onData(data);
            },
          }),
      };
      const native = createBashToolDefinition(cwd, { ...options, operations });
      const wrappedUpdate: typeof onUpdate = onUpdate
        ? (_update) => {
            const snapshot = capture.snapshot();
            const rendered = renderCapture(snapshot, undefined);
            onUpdate({
              content: rendered.text ? [{ type: "text", text: rendered.text }] : [],
              details: rendered.details,
            });
          }
        : undefined;

      let executionError: unknown;
      try {
        await native.execute(toolCallId, params, signal, wrappedUpdate, ctx);
      } catch (error) {
        executionError = error;
      }

      let snapshot: CaptureSnapshot;
      try {
        snapshot = await capture.finish();
      } catch (persistenceError) {
        if (executionError) throw executionError;
        throw persistenceError;
      }

      if (executionError) {
        const rendered = renderCapture(snapshot, statusFromError(executionError));
        throw new Error(rendered.text || statusFromError(executionError));
      }

      const rendered = renderCapture(snapshot, undefined);
      return {
        content: [{ type: "text", text: rendered.text }],
        details: rendered.details,
      };
    },
  };
}

export function getCapturedLineCount(text: string): number {
  return countCompleteLines(text);
}
