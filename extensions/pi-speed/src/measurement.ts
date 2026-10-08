export const STREAM_ENTRY_TYPE = "pi-speed:stream";
export const MIN_OUTPUT_TOKENS = 250;
export const MIN_STREAM_DURATION_MS = 1_000;

export interface StreamMeasurement {
  version: 1;
  entryId: string;
  provider: string;
  model: string;
  api: string;
  messageTimestamp: number;
  /** Provider-accounted text and tool-call output, excluding reasoning. */
  outputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  chunks: number;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Persisted annotations are observations, never a fallback to request timestamps. */
export function parseStreamMeasurement(value: unknown): StreamMeasurement | undefined {
  const data = record(value);
  if (
    data?.version !== 1 ||
    ![data.entryId, data.provider, data.model, data.api].every(
      (item) => typeof item === "string" && item.length > 0,
    ) ||
    typeof data.messageTimestamp !== "number" ||
    !Number.isFinite(data.messageTimestamp) ||
    data.messageTimestamp < 0 ||
    !tokenCount(data.outputTokens) ||
    data.outputTokens < MIN_OUTPUT_TOKENS ||
    !tokenCount(data.totalOutputTokens) ||
    data.outputTokens > data.totalOutputTokens ||
    typeof data.durationMs !== "number" ||
    !Number.isFinite(data.durationMs) ||
    data.durationMs < MIN_STREAM_DURATION_MS ||
    !tokenCount(data.chunks) ||
    data.chunks < 2
  )
    return undefined;
  return {
    version: 1,
    entryId: data.entryId as string,
    provider: data.provider as string,
    model: data.model as string,
    api: data.api as string,
    messageTimestamp: data.messageTimestamp,
    outputTokens: data.outputTokens,
    totalOutputTokens: data.totalOutputTokens,
    durationMs: data.durationMs,
    chunks: data.chunks,
  };
}

/** An annotation can follow tool results or live below a later tree selection. */
export function readStreamMeasurements(
  entries: readonly unknown[],
): Map<string, StreamMeasurement> {
  const measurements = new Map<string, StreamMeasurement>();
  const conflicts = new Set<string>();
  for (const value of entries) {
    const entry = record(value);
    if (entry?.type !== "custom" || entry.customType !== STREAM_ENTRY_TYPE) continue;
    const measurement = parseStreamMeasurement(entry.data);
    if (!measurement || conflicts.has(measurement.entryId)) continue;
    const existing = measurements.get(measurement.entryId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(measurement)) {
      measurements.delete(measurement.entryId);
      conflicts.add(measurement.entryId);
    } else {
      measurements.set(measurement.entryId, measurement);
    }
  }
  return measurements;
}

/** Entry identity and usage must agree so copied or stale telemetry cannot retarget a response. */
export function measurementForMessage(
  measurements: ReadonlyMap<string, StreamMeasurement>,
  entryId: unknown,
  value: unknown,
): StreamMeasurement | undefined {
  const message = record(value);
  const measurement = typeof entryId === "string" ? measurements.get(entryId) : undefined;
  if (
    !measurement ||
    message?.role !== "assistant" ||
    message.provider !== measurement.provider ||
    message.model !== measurement.model ||
    message.api !== measurement.api ||
    message.timestamp !== measurement.messageTimestamp ||
    record(message.usage)?.output !== measurement.totalOutputTokens
  )
    return undefined;
  return measurement;
}
