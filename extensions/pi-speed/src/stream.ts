import type { ExtensionAPI, ProviderStreamEvent } from "@earendil-works/pi-coding-agent";
import {
  measurementForMessage,
  parseStreamMeasurement,
  record,
  STREAM_ENTRY_TYPE,
  type StreamMeasurement,
  tokenCount,
} from "./measurement.ts";

type Route = Pick<ProviderStreamEvent, "provider" | "api" | "model">;
type Counts = { output: number; total: number };
type Observation = {
  output?: boolean;
  reasoning?: boolean;
  invalid?: boolean;
  hasUsage?: boolean;
  counts?: Counts;
  responseId?: unknown;
  start?: boolean;
};

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Missing reasoning accounting is not evidence of zero reasoning. */
function splitCounts(total: unknown, reasoning: unknown): Counts | undefined {
  if (!tokenCount(total) || !tokenCount(reasoning) || reasoning > total) return undefined;
  return { total, output: total - reasoning };
}

/** One raw event may contain several deltas; it still supplies only one arrival timestamp. */
function completions(data: Record<string, unknown>): Observation {
  const choice = record(array(data.choices)[0]);
  const delta = record(choice?.delta);
  const usage = record(data.usage ?? choice?.usage);
  const details = record(usage?.completion_tokens_details);
  const tools = array(delta?.tool_calls).map(record);
  // Rejected predictions and generated audio are not delivered text/tool output.
  const textOnlyAccounting = [details?.rejected_prediction_tokens, details?.audio_tokens].every(
    (value) => value === undefined || value === 0,
  );
  return {
    output:
      text(delta?.content) ||
      text(delta?.refusal) ||
      tools.some(
        (tool) => text(record(tool?.function)?.arguments) || text(record(tool?.custom)?.input),
      ),
    reasoning:
      [delta?.reasoning_content, delta?.reasoning, delta?.reasoning_text].some(text) ||
      array(delta?.reasoning_details).length > 0,
    invalid:
      array(data.choices).length > 1 ||
      Boolean(data.error) ||
      delta?.audio !== undefined ||
      delta?.function_call !== undefined ||
      (delta?.content != null && typeof delta.content !== "string"),
    responseId: data.id,
    hasUsage: data.usage != null || choice?.usage != null,
    counts: textOnlyAccounting
      ? splitCounts(usage?.completion_tokens, details?.reasoning_tokens)
      : undefined,
  };
}

function anthropic(data: Record<string, unknown>): Observation {
  const block = record(data.content_block);
  const delta = record(data.delta);
  const message = record(data.message);
  const usage = record(data.usage);
  if (data.type === "message_start") return { start: true, responseId: message?.id };
  if (data.type === "content_block_start") {
    return {
      output: block?.type === "text" && text(block.text),
      reasoning: block?.type === "thinking" || block?.type === "redacted_thinking",
      invalid:
        !["text", "thinking", "redacted_thinking", "tool_use"].includes(String(block?.type)) ||
        (block?.type === "tool_use" && Object.keys(record(block.input) ?? {}).length > 0),
    };
  }
  if (data.type === "content_block_delta") {
    return {
      output:
        (delta?.type === "text_delta" && text(delta.text)) ||
        (delta?.type === "input_json_delta" && text(delta.partial_json)),
      reasoning: delta?.type === "thinking_delta" && text(delta.thinking),
      invalid: !["text_delta", "input_json_delta", "thinking_delta", "signature_delta"].includes(
        String(delta?.type),
      ),
    };
  }
  return {
    invalid: data.type === "error",
    hasUsage: data.type === "message_delta" && data.usage != null,
    counts: splitCounts(
      usage?.output_tokens,
      record(usage?.output_tokens_details)?.thinking_tokens,
    ),
  };
}

function google(data: Record<string, unknown>): Observation {
  const candidates = array(data.candidates);
  const candidate = record(candidates[0]);
  const parts = array(record(candidate?.content)?.parts).map(record);
  const usage = record(data.usageMetadata);
  const output = usage?.candidatesTokenCount;
  const thinking = usage?.thoughtsTokenCount ?? 0;
  // Candidates are explicitly separate from thoughts, even when thoughtsTokenCount is absent.
  const total = tokenCount(output) && tokenCount(thinking) ? output + thinking : undefined;
  return {
    output: parts.some(
      (part) =>
        part?.thought !== true && (text(part?.text) || record(part?.functionCall) !== undefined),
    ),
    reasoning: parts.some(
      (part) => part?.thought === true && (text(part.text) || part.functionCall !== undefined),
    ),
    invalid:
      candidates.length > 1 ||
      Boolean(data.error) ||
      parts.some(
        (part) =>
          part?.inlineData !== undefined ||
          part?.fileData !== undefined ||
          part?.executableCode !== undefined ||
          part?.codeExecutionResult !== undefined,
      ),
    responseId: data.responseId,
    hasUsage: data.usageMetadata != null,
    counts: tokenCount(output) && tokenCount(total) ? { output, total } : undefined,
  };
}

/** Keep only bounded per-block counts, never response text or provider payloads. */
export class StreamObserver {
  private route: Route | undefined;
  private responseId: string | undefined;
  private started = false;
  private invalid = false;
  private first: number | undefined;
  private last: number | undefined;
  private previous: number | undefined;
  private chunks = 0;
  private reasoningAfterOutput = false;
  private counts: Counts | undefined;
  private countedChunks = 0;
  private readonly responseLengths = new Map<number, number>();

  private responses(data: Record<string, unknown>): Observation {
    const type = String(data.type);
    const item = record(data.item);
    const response = record(data.response);
    if (type === "response.created") return { start: true, responseId: response?.id };
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      if (item?.type === "reasoning") return { reasoning: true };
      if (!item || !["message", "function_call", "custom_tool_call"].includes(String(item.type)))
        return { invalid: true };
      const parts = array(item.content).map(record);
      const unsupported =
        item.type === "message" &&
        parts.some((part) => !["output_text", "refusal"].includes(String(part?.type)));
      const length =
        item.type === "message"
          ? parts.reduce(
              (sum, part) =>
                sum +
                (typeof part?.text === "string" ? part.text.length : 0) +
                (typeof part?.refusal === "string" ? part.refusal.length : 0),
              0,
            )
          : typeof (item.arguments ?? item.input) === "string"
            ? String(item.arguments ?? item.input).length
            : 0;
      if (!tokenCount(data.output_index)) return { invalid: true };
      const seen = this.responseLengths.get(data.output_index) ?? 0;
      if (type === "response.output_item.done") {
        // Completion-only backfills/corrections cannot be counted against an earlier stream window.
        return { invalid: unsupported || length !== seen };
      }
      if (seen > 0) return { invalid: true };
      this.responseLengths.set(data.output_index, length);
      return { output: length > 0, invalid: unsupported };
    }
    if (
      [
        "response.output_text.delta",
        "response.refusal.delta",
        "response.function_call_arguments.delta",
        "response.custom_tool_call_input.delta",
      ].includes(type)
    ) {
      if (!text(data.delta)) return {};
      if (!tokenCount(data.output_index)) return { invalid: true };
      this.responseLengths.set(
        data.output_index,
        (this.responseLengths.get(data.output_index) ?? 0) + data.delta.length,
      );
      return { output: true };
    }
    if (
      ["response.function_call_arguments.done", "response.custom_tool_call_input.done"].includes(
        type,
      )
    ) {
      const value = data.arguments ?? data.input;
      return {
        invalid:
          typeof value === "string" &&
          value.length !== (this.responseLengths.get(data.output_index as number) ?? 0),
      };
    }
    if (type.startsWith("response.reasoning")) return { reasoning: true };
    if (["response.completed", "response.done", "response.incomplete"].includes(type)) {
      const usage = record(response?.usage);
      // Some adapters fill omitted item/delta events from the final response. Those aren't streamed samples.
      let invalid = type === "response.incomplete";
      for (const [index, value] of array(response?.output).entries()) {
        const final = record(value);
        if (final?.type === "reasoning") continue;
        const checked = this.responses({
          type: "response.output_item.done",
          output_index: index,
          item: final,
        });
        invalid ||= checked.invalid === true;
      }
      return {
        invalid,
        responseId: response?.id,
        hasUsage: true,
        counts: splitCounts(
          usage?.output_tokens,
          record(usage?.output_tokens_details)?.reasoning_tokens,
        ),
      };
    }
    return {
      invalid: type === "error" || type === "response.failed" || type.startsWith("response.audio"),
    };
  }

  observe(event: Route & { data: unknown }, now: number): void {
    if (this.invalid) return;
    if (!Number.isFinite(now) || (this.previous !== undefined && now < this.previous)) {
      this.invalid = true;
      return;
    }
    this.previous = now;
    if (
      this.route &&
      (event.provider !== this.route.provider ||
        event.model !== this.route.model ||
        event.api !== this.route.api)
    ) {
      this.invalid = true;
      return;
    }
    this.route ??= { provider: event.provider, model: event.model, api: event.api };
    const data = record(event.data);
    if (!data) {
      this.invalid = true;
      return;
    }
    let observation: Observation;
    switch (event.api) {
      case "openai-responses":
      case "openai-codex-responses":
        observation = this.responses(data);
        break;
      case "openai-completions":
        observation = completions(data);
        break;
      case "anthropic-messages":
        observation = anthropic(data);
        break;
      case "google-generative-ai":
        observation = google(data);
        break;
      default:
        this.invalid = true;
        return;
    }
    if (observation.start) {
      if (this.started || this.first !== undefined) this.invalid = true;
      this.started = true;
    }
    if (text(observation.responseId)) {
      if (this.responseId !== undefined && this.responseId !== observation.responseId)
        this.invalid = true;
      this.responseId = observation.responseId;
    }
    this.invalid ||= observation.invalid === true;
    if (observation.reasoning && this.first !== undefined) this.reasoningAfterOutput = true;
    if (observation.output) {
      this.invalid ||= this.reasoningAfterOutput || observation.reasoning === true;
      this.first ??= now;
      this.last = now;
      this.chunks += 1;
    }
    if (observation.hasUsage) {
      this.counts = observation.counts;
      this.countedChunks = this.chunks;
    }
  }

  finish(value: unknown): StreamMeasurement | undefined {
    const message = record(value);
    if (
      this.invalid ||
      !this.route ||
      !this.counts ||
      this.countedChunks !== this.chunks ||
      this.first === undefined ||
      this.last === undefined ||
      message?.role !== "assistant" ||
      (message.stopReason !== "stop" && message.stopReason !== "toolUse") ||
      message.provider !== this.route.provider ||
      message.model !== this.route.model ||
      message.api !== this.route.api ||
      record(message.usage)?.output !== this.counts.total ||
      (text(message.responseId) &&
        this.responseId !== undefined &&
        message.responseId !== this.responseId)
    )
      return undefined;
    return parseStreamMeasurement({
      version: 1,
      entryId: "pending",
      ...this.route,
      messageTimestamp: message.timestamp,
      outputTokens: this.counts.output,
      totalOutputTokens: this.counts.total,
      durationMs: this.last - this.first,
      chunks: this.chunks,
    });
  }
}

/** Raw events may precede message_start; turn boundaries scope exactly one primary request. */
export function registerStreamCollector(
  pi: ExtensionAPI,
  clock: () => number = () => performance.now(),
): void {
  let active:
    | {
        sessionId: string;
        turnIndex: number;
        observer?: StreamObserver;
        pending?: StreamMeasurement;
      }
    | undefined;
  let open = false;
  pi.on("session_start", () => {
    active = undefined;
    open = true;
  });
  pi.on("session_shutdown", () => {
    active = undefined;
    open = false;
  });
  pi.on("turn_start", (event, ctx) => {
    active = open
      ? {
          sessionId: ctx.sessionManager.getSessionId(),
          turnIndex: event.turnIndex,
          observer: new StreamObserver(),
        }
      : undefined;
  });
  pi.on("provider_stream_event", (event, ctx) => {
    if (active?.sessionId === ctx.sessionManager.getSessionId())
      active.observer?.observe(event, clock());
  });
  pi.on("message_end", (event, ctx) => {
    if (
      event.message.role !== "assistant" ||
      !active ||
      active.sessionId !== ctx.sessionManager.getSessionId()
    )
      return;
    active.pending = active.observer?.finish(event.message);
    active.observer = undefined;
  });
  pi.on("turn_end", (event, ctx) => {
    const completed = active;
    active = undefined;
    if (
      !completed?.pending ||
      completed.sessionId !== ctx.sessionManager.getSessionId() ||
      completed.turnIndex !== event.turnIndex
    )
      return;
    const entry = ctx.sessionManager.getEntry(event.messageEntryId);
    if (entry?.type !== "message") return;
    const measurement = { ...completed.pending, entryId: event.messageEntryId };
    if (
      !measurementForMessage(
        new Map([[measurement.entryId, measurement]]),
        measurement.entryId,
        entry.message,
      )
    )
      return;
    if (
      entry.message.role !== "assistant" ||
      (entry.message.stopReason !== "stop" && entry.message.stopReason !== "toolUse")
    )
      return;
    pi.appendEntry(STREAM_ENTRY_TYPE, measurement);
  });
}
