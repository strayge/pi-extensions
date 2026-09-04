import { createHash, randomBytes } from "node:crypto";
import { validateHeaderValue } from "node:http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortError, errorMessage, fingerprintResolvedAuth, redactUsageError } from "./core.ts";
import {
  enrichCodexResetCreditExpirations,
  normalizeCodexBackendPayload,
} from "./providers/codex.ts";
import { normalizeOpenRouterKeyPayload } from "./providers/openrouter.ts";
import type {
  CodexBackendPayload,
  CodexResetCreditRedemption,
  CodexResetCreditRedemptionCode,
  CodexResetCreditsPayload,
  OpenRouterKeyPayload,
  PiModel,
  ResolvedUsageAuth,
  UsageProviderAdapter,
  UsageReport,
} from "./types.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_REDEEM_RESET_CREDIT_URL = `${CODEX_RESET_CREDITS_URL}/consume`;
const CODEX_REDEMPTION_CODES = new Set<CodexResetCreditRedemptionCode>([
  "reset",
  "nothing_to_reset",
  "no_credit",
  "already_redeemed",
]);
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const CODEX_ACCOUNT_HEADER = "ChatGPT-Account-Id";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

export const AUTH_FINGERPRINT_SALT = randomBytes(32);

export const SUPPORTED_ADAPTERS: readonly UsageProviderAdapter[] = [
  {
    id: "openai-codex",
    displayName: "OpenAI Codex",
    semantics: {
      kind: "consumer-subscription",
      label: "ChatGPT subscription limits",
    },
    async query(auth, signal, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const payload = await fetchProviderJson(
        CODEX_USAGE_URL,
        auth,
        signal,
        timeoutMs,
        "Codex usage endpoint",
      );
      const report = normalizeCodexBackendPayload(payload as CodexBackendPayload, Date.now());
      if (signal.aborted) throw abortError();
      const resetCredits = report.metrics.find((metric) => metric.id === "reset-credits");
      if (typeof resetCredits?.value !== "number" || resetCredits.value <= 0) return report;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return report;
      try {
        const details = await fetchProviderJson(
          CODEX_RESET_CREDITS_URL,
          auth,
          signal,
          remainingMs,
          "Codex reset-credit endpoint",
        );
        return enrichCodexResetCreditExpirations(report, details as CodexResetCreditsPayload);
      } catch (error) {
        if (signal.aborted) throw isAbortError(error) ? error : abortError();
        return report;
      }
    },
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    semantics: { kind: "api-key", label: "API-key spend limits" },
    async query(auth, signal, timeoutMs) {
      const payload = await fetchProviderJson(
        OPENROUTER_KEY_URL,
        auth,
        signal,
        timeoutMs,
        "OpenRouter key endpoint",
      );
      return normalizeOpenRouterKeyPayload(payload as OpenRouterKeyPayload, Date.now());
    },
  },
];

export function adapterForProvider(
  providerId: string | undefined,
): UsageProviderAdapter | undefined {
  return SUPPORTED_ADAPTERS.find((adapter) => adapter.id === providerId);
}

export function isStaleExtensionContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("This extension ctx is stale after session replacement or reload")
  );
}

export async function resolveUsageAuth(
  ctx: ExtensionContext,
  adapter: UsageProviderAdapter,
  salt: Uint8Array = AUTH_FINGERPRINT_SALT,
): Promise<ResolvedUsageAuth | undefined> {
  if (ctx.model?.provider === adapter.id && !hasOfficialOrigin(ctx.model, adapter.id)) {
    throw new Error(
      `${adapter.displayName} usage cannot send a custom provider base URL credential to the official usage endpoint.`,
    );
  }

  const model = candidateModels(ctx, adapter.id).find((candidate) =>
    hasOfficialOrigin(candidate, adapter.id),
  );
  if (!model) return undefined;
  const registry = ctx.modelRegistry as unknown as UsageAuthRegistry;
  let modelAuth: RequestAuth | undefined;
  if (ctx.model?.provider === adapter.id && typeof registry.getApiKeyAndHeaders === "function") {
    const result = await registry.getApiKeyAndHeaders(ctx.model);
    if (!result.ok) throw new Error(redactUsageError(result.error));
    if (authorizationFrom(result)) modelAuth = result;
  }
  if (typeof registry.getProviderAuth !== "function") {
    throw new Error("pi-usage requires Pi 0.81.0 or newer to validate resolved provider auth.");
  }
  const providerResult = await registry.getProviderAuth(adapter.id);
  if (
    providerResult?.auth.baseUrl &&
    !hasOfficialUrlOrigin(providerResult.auth.baseUrl, adapter.id)
  ) {
    throw new Error(
      `${adapter.displayName} usage cannot send a proxy-resolved credential to the official usage endpoint.`,
    );
  }
  const auth = modelAuth ?? providerResult?.auth;
  if (!auth) return undefined;
  const authorization = authorizationFrom(auth);
  if (!authorization) return undefined;
  const headers: Record<string, string> = { Authorization: authorization };
  const accountId =
    adapter.id === "openai-codex" ? codexAccountIdFromAuthorization(authorization) : undefined;
  if (accountId) headers[CODEX_ACCOUNT_HEADER] = accountId;
  const secrets = [
    auth.apiKey,
    headerValue(auth.headers, "Authorization"),
    authorization,
    accountId,
  ].filter((value): value is string => Boolean(value));
  const fingerprint = fingerprintResolvedAuth({ headers }, salt);
  return {
    apiKey: auth.apiKey,
    headers,
    fingerprint,
    accountKey: accountId
      ? createHash("sha256").update(`pi-usage-reset:${accountId}`).digest("hex")
      : undefined,
    secrets,
    model,
  };
}

export async function queryProviderUsage(
  adapter: UsageProviderAdapter,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<UsageReport> {
  try {
    return await adapter.query(auth, signal, timeoutMs);
  } catch (error) {
    if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
    throw new Error(redactUsageError(errorMessage(error), auth.secrets));
  }
}

export async function redeemCodexResetCredit(
  auth: ResolvedUsageAuth,
  redeemRequestId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CodexResetCreditRedemption> {
  if (auth.model.provider !== "openai-codex" || !hasOfficialOrigin(auth.model, "openai-codex")) {
    throw new Error("A reset can only be used with official OpenAI Codex authorization.");
  }
  if (!redeemRequestId) throw new Error("A reset redemption requires an idempotency key.");

  try {
    const payload = await fetchProviderJson(
      CODEX_REDEEM_RESET_CREDIT_URL,
      auth,
      signal,
      timeoutMs,
      "Codex reset redemption endpoint",
      { redeem_request_id: redeemRequestId },
    );
    const code = payload.code;
    const windowsReset = payload.windows_reset ?? 0;
    if (
      typeof code !== "string" ||
      !CODEX_REDEMPTION_CODES.has(code as CodexResetCreditRedemptionCode)
    ) {
      throw new Error("Codex reset redemption returned an unknown outcome.");
    }
    if (!Number.isSafeInteger(windowsReset) || (windowsReset as number) < 0) {
      throw new Error("Codex reset redemption returned an invalid window count.");
    }
    return {
      code: code as CodexResetCreditRedemptionCode,
      windowsReset: windowsReset as number,
    };
  } catch (error) {
    if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
    throw new Error(redactUsageError(errorMessage(error), auth.secrets));
  }
}

function candidateModels(ctx: ExtensionContext, providerId: string): PiModel[] {
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: PiModel | undefined) => {
    if (!model || model.provider !== providerId) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };
  add(ctx.model);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);
  for (const model of ctx.modelRegistry.getAll()) add(model);
  return candidates;
}

async function fetchProviderJson(
  url: string,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  description: string,
  jsonBody?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const headers = { ...auth.headers };
    if (!hasHeader(headers, "User-Agent")) headers["User-Agent"] = "pi-usage";
    if (jsonBody) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      ...(jsonBody ? { body: JSON.stringify(jsonBody), method: "POST" } : {}),
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (controller.signal.aborted)
      throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
    const text = await readBoundedResponse(
      response,
      response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES,
      !response.ok,
      description,
    );
    if (controller.signal.aborted)
      throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
    if (!response.ok) {
      throw new Error(
        `${description} returned ${response.status} ${response.statusText}: ${redactUsageError(text, auth.secrets)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`${description} returned invalid JSON: ${errorMessage(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${description} response was not an object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (timedOut) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching usage.`);
    }
    if (signal.aborted)
      throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  truncateOverflow: boolean,
  description: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (truncated && !truncateOverflow) {
    throw new Error(`${description} response exceeded ${maxBytes} bytes.`);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  return truncated ? `${text}…` : text;
}

type RequestAuth = {
  apiKey?: string;
  headers?: Record<string, string | null>;
};

type UsageAuthRegistry = {
  getApiKeyAndHeaders?(
    model: PiModel,
  ): Promise<({ ok: true } & RequestAuth) | { ok: false; error: string }>;
  getProviderAuth?(providerId: string): Promise<
    | {
        auth: RequestAuth & { baseUrl?: string };
      }
    | undefined
  >;
};

function authorizationFrom(auth: RequestAuth): string | undefined {
  return (
    headerValue(auth.headers, "Authorization") ??
    (auth.apiKey ? `Bearer ${auth.apiKey}` : undefined)
  );
}

function codexAccountIdFromAuthorization(authorization: string): string | undefined {
  const token = /^Bearer +(\S+)$/iu.exec(authorization)?.[1];
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      [CODEX_ACCOUNT_CLAIM]?: { chatgpt_account_id?: unknown };
    };
    return validHeaderValue(payload?.[CODEX_ACCOUNT_CLAIM]?.chatgpt_account_id);
  } catch {
    return undefined;
  }
}

function validHeaderValue(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    return undefined;
  }
  try {
    validateHeaderValue(CODEX_ACCOUNT_HEADER, value);
    return value;
  } catch {
    return undefined;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function hasOfficialOrigin(model: PiModel, providerId: string): boolean {
  return hasOfficialUrlOrigin(model.baseUrl, providerId);
}

function hasOfficialUrlOrigin(value: string, providerId: string): boolean {
  const expected = providerId === "openai-codex" ? "https://chatgpt.com" : "https://openrouter.ai";
  try {
    return new URL(value).origin === expected;
  } catch {
    return false;
  }
}

function headerValue(
  headers: Record<string, string | null> | undefined,
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1] ?? undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
