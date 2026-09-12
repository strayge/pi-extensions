import { randomUUID } from "node:crypto";
import { fingerprintResolvedAuth } from "./core.ts";
import type {
  ResolvedUsageAuth,
  UsageReport,
  UsageSnapshot,
  UsageSnapshotIdentity,
} from "./types.ts";

export const SNAPSHOT_ENTRY_TYPE = "pi-usage:snapshot";

/**
 * Keep credential material out of session exports while allowing observations
 * to be grouped across processes. The fallback uses a public, provider-scoped
 * namespace rather than the cache's process-random salt; it identifies a
 * credential, not an account that survives credential rotation.
 */
export function deriveUsageSnapshotIdentity(
  providerId: string,
  auth: ResolvedUsageAuth,
): UsageSnapshotIdentity {
  return auth.accountKey
    ? { kind: "account", id: auth.accountKey.slice(0, 24) }
    : {
        kind: "credential",
        id: fingerprintResolvedAuth(
          { headers: auth.headers },
          Buffer.from(`pi-usage:snapshot:v1:${providerId}`),
        ).slice(0, 24),
      };
}

export function createUsageSnapshot(report: UsageReport, auth: ResolvedUsageAuth): UsageSnapshot {
  const identity = deriveUsageSnapshotIdentity(report.providerId, auth);
  return {
    version: 1,
    observationId: randomUUID(),
    identity,
    modelId: auth.model.id,
    report,
  };
}
