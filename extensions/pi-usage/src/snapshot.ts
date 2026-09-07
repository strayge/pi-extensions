import { randomUUID } from "node:crypto";
import { fingerprintResolvedAuth } from "./core.ts";
import type { ResolvedUsageAuth, UsageReport, UsageSnapshot } from "./types.ts";

export const SNAPSHOT_ENTRY_TYPE = "pi-usage:snapshot";

/**
 * Keep credential material out of session exports while allowing observations
 * to be grouped across processes. The fallback uses a public, provider-scoped
 * namespace rather than the cache's process-random salt; it identifies a
 * credential, not an account that survives credential rotation.
 */
export function createUsageSnapshot(report: UsageReport, auth: ResolvedUsageAuth): UsageSnapshot {
  const identity = auth.accountKey
    ? { kind: "account" as const, id: auth.accountKey.slice(0, 24) }
    : {
        kind: "credential" as const,
        id: fingerprintResolvedAuth(
          { headers: auth.headers },
          Buffer.from(`pi-usage:snapshot:v1:${report.providerId}`),
        ).slice(0, 24),
      };
  return {
    version: 1,
    observationId: randomUUID(),
    identity,
    modelId: auth.model.id,
    report,
  };
}
