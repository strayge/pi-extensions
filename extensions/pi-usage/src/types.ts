import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PiModel = NonNullable<ExtensionContext["model"]>;
export type UsageModel = Pick<PiModel, "id" | "name" | "provider">;

export type UsageSemanticsKind = "consumer-subscription" | "api-key" | "project";
export type UsageUnit = "percent" | "usd" | "count";
export type UsageDisplayState = "current" | "configured";

export interface UsageSemantics {
  kind: UsageSemanticsKind;
  label: string;
}

export interface UsageBucket {
  id: string;
  label: string;
  groupId?: string;
  groupLabel?: string;
  modelKeys?: string[];
  used?: number;
  remaining?: number;
  limit?: number;
  unit: UsageUnit;
  period?: string;
  windowMinutes?: number;
  resetsAt?: number;
}

export type ResetCreditExpiration =
  | { kind: "dated"; expiresAt: number }
  | { kind: "never" }
  | { kind: "unknown" };

export interface UsageMetric {
  id: string;
  label: string;
  value: number | string;
  unit?: UsageUnit;
  resetExpirations?: ResetCreditExpiration[];
}

export interface UsageReport {
  providerId: string;
  providerName: string;
  capturedAt: number;
  source: string;
  semantics: UsageSemantics;
  accountLabel?: string;
  buckets: UsageBucket[];
  metrics: UsageMetric[];
  notes?: string[];
}

/** Observations remain distinct from the session's per-request token accounting. */
export interface UsageSnapshot {
  version: 1;
  observationId: string;
  identity: {
    kind: "account" | "credential";
    id: string;
  };
  modelId: string;
  report: UsageReport;
}

export interface ResolvedUsageAuth {
  apiKey?: string;
  headers: Record<string, string>;
  fingerprint: string;
  /** Stable across processes when Codex exposes an account-routing claim. */
  accountKey?: string;
  secrets: string[];
  model: PiModel;
}

export interface UsageProviderAdapter {
  id: string;
  displayName: string;
  semantics: UsageSemantics;
  query(auth: ResolvedUsageAuth, signal: AbortSignal, timeoutMs: number): Promise<UsageReport>;
}

export type ProviderUsageState =
  | {
      providerId: string;
      providerName: string;
      displayState: UsageDisplayState;
      status: "ready";
      report: UsageReport;
    }
  | {
      providerId: string;
      providerName: string;
      displayState: UsageDisplayState;
      status: "unsupported" | "auth-unavailable" | "query-failed";
      message: string;
    };

/** Which side of the quota a percentage names. */
export type UsageValueMode = "used" | "remaining";

export type UsageField = "window" | "bar" | "percent" | "reset" | "projection";

/**
 * Which windows of the selected group reach the statusline. `auto` shows the
 * primary window plus any other one projected to run out before it resets.
 */
export type UsageBucketMode = "auto" | "primary" | "all";

export type UsagePresetName = "legacy" | "minimal" | "compact" | "full" | "custom";

export interface UsageSurfaceOptions {
  fields: UsageField[];
  barWidth: number;
  paceMarker: boolean;
}

export interface UsageStatuslineOptions extends UsageSurfaceOptions {
  buckets: UsageBucketMode;
  separator: string;
}

export interface UsageDisplayConfig {
  version: 1;
  preset: UsagePresetName;
  value: UsageValueMode;
  /** `3h 12m` when true, `3h12m` when false. */
  spacedDuration: boolean;
  statusline: UsageStatuslineOptions;
  report: UsageSurfaceOptions;
}

export type OpenRouterKeyPayload = {
  data?: unknown;
};

export type CodexBackendPayload = {
  plan_type?: unknown;
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
  credits?: unknown;
  rate_limit_reset_credits?: unknown;
};

export type CodexResetCreditsPayload = {
  available_count?: unknown;
  credits?: unknown;
};

export type CodexResetCreditRedemptionCode =
  | "reset"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed";

export interface CodexResetCreditRedemption {
  code: CodexResetCreditRedemptionCode;
  windowsReset: number;
}
