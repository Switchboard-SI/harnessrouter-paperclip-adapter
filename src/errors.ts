/**
 * UHP failure → Paperclip failure.
 *
 * Two different things are called "error" in UHP and conflating them produces
 * confusing retries:
 *
 *   - a failed *request* is a non-2xx HTTP response carrying an error envelope
 *     (`{type, code, message, param, detail}`);
 *   - a failed *task* is HTTP 200 with a response object whose `status` is
 *     `failed`. That is a normal result and must not be retried.
 *
 * Only the first is handled here.
 */

import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

/** The package does not re-export this union; take it from the field that uses it. */
export type AdapterExecutionErrorFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;

export interface UhpFailureLike {
  name?: string;
  status?: number;
  type?: string | null;
  code?: string | null;
  message?: string;
  param?: string | null;
  detail?: unknown;
  requestId?: string | null;
}

export interface MappedExecutionError {
  errorMessage: string;
  errorCode: string;
  errorFamily: AdapterExecutionErrorFamily | null;
  errorMeta: Record<string, unknown>;
}

/** Human-readable message, preferring the server's own wording. */
export function describeError(error: unknown): string {
  if (isUhpFailure(error)) {
    const parts = [error.type, error.code].filter((part): part is string => Boolean(part));
    const label = parts.length > 0 ? `${parts.join("/")}: ` : "";
    return `${label}${error.message ?? `HTTP ${error.status ?? "unknown"}`}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isUhpFailure(error: unknown): error is UhpFailureLike {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "UhpError"
  );
}

function statusOf(error: UhpFailureLike): number | null {
  return typeof error.status === "number" ? error.status : null;
}

const QUOTA_CODES = new Set(["insufficient_quota", "quota_exceeded", "rate_limit_exceeded", "billing_hard_limit_reached"]);
const AUTH_CODES = new Set([
  "invalid_credential",
  "missing_credential",
  "invalid_api_key",
  "authentication_error",
  "permission_denied",
  "forbidden",
]);

/**
 * Classify a failure into one of Paperclip's error families.
 *
 * The rule of thumb: retry only what time can fix. A bad key or a malformed
 * request will fail identically on every attempt, so it is `configuration` and
 * the server must not spend money retrying it.
 */
export function classifyFamily(error: unknown): AdapterExecutionErrorFamily | null {
  if (!isUhpFailure(error)) {
    // fetch() rejects with a TypeError for DNS/connection failures.
    if (error instanceof TypeError) return "transient_upstream";
    return null;
  }
  const status = statusOf(error);
  const code = (error.code ?? "").toLowerCase();
  const type = (error.type ?? "").toLowerCase();

  if (status === 429) return "provider_quota";
  if (QUOTA_CODES.has(code)) return "provider_quota";
  if (AUTH_CODES.has(code) || AUTH_CODES.has(type)) return "configuration";
  if (status === 401 || status === 403) return "configuration";
  if (status !== null && status >= 500) return "transient_upstream";
  if (status === 408) return "transient_upstream";
  if (status !== null && status >= 400) return "configuration";
  return null;
}

/**
 * Map any thrown value to the fields `AdapterExecutionResult` carries.
 *
 * `errorMeta` keeps the raw UHP envelope. It is what makes a support question
 * ("which credential, which parameter, which request id?") answerable without
 * reproducing the run.
 */
export function mapExecutionError(error: unknown): MappedExecutionError {
  const family = classifyFamily(error);
  const message = describeError(error);

  if (!isUhpFailure(error)) {
    return {
      errorMessage: message,
      errorCode: error instanceof TypeError ? "harnessrouter.network_error" : "harnessrouter.unknown_error",
      errorFamily: family,
      errorMeta: {},
    };
  }

  const kind = [error.type, error.code].filter((part): part is string => Boolean(part)).join(".");
  return {
    errorMessage: message,
    errorCode: `harnessrouter.${kind || "request_failed"}`,
    errorFamily: family,
    errorMeta: {
      httpStatus: statusOf(error),
      uhpType: error.type ?? null,
      uhpCode: error.code ?? null,
      uhpParam: error.param ?? null,
      uhpDetail: error.detail ?? null,
      requestId: error.requestId ?? null,
    },
  };
}
