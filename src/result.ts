/**
 * Finished UHP response → `AdapterExecutionResult`.
 *
 * A task that ran and failed is HTTP 200 with `status: "failed"`. It is a
 * result, not a thrown error, and it must not be retried — the money is
 * already spent.
 */

import type { AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";

export interface UhpResponse {
  id?: unknown;
  status?: unknown;
  session_id?: unknown;
  error?: unknown;
  usage?: unknown;
  model?: unknown;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

/**
 * Read OpenAI-shaped usage off a response.
 *
 * Absent counts stay absent rather than becoming zero: "we do not know" and
 * "it was free" are different answers for a cost dashboard.
 */
export function readUsage(response: UhpResponse | null | undefined): UsageSummary | undefined {
  const usage = asRecord(response?.usage);
  if (!usage) return undefined;

  const inputTokens = asInt(usage.input_tokens);
  const outputTokens = asInt(usage.output_tokens);
  if (inputTokens === null && outputTokens === null) return undefined;

  const details = asRecord(usage.input_tokens_details);
  const cachedInputTokens = asInt(details?.cached_tokens) ?? asInt(usage.cached_input_tokens);

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

export interface BuildResultInput {
  response: UhpResponse | null;
  /** Text accumulated from the stream, used when the response body has none. */
  text?: string;
  model?: string | null;
  sessionParams: Record<string, unknown> | null;
  timedOut?: boolean;
}

export function buildExecutionResult(input: BuildResultInput): AdapterExecutionResult {
  const { response, sessionParams } = input;
  const status = asString(response?.status);
  const usage = readUsage(response);

  const base: AdapterExecutionResult = {
    exitCode: 0,
    signal: null,
    timedOut: input.timedOut === true,
    sessionParams,
    sessionDisplayId: asString(response?.id) ?? null,
    provider: "harnessrouter",
    model: asString(response?.model) ?? input.model ?? null,
    billingType: "unknown",
    ...(usage ? { usage, usageBasis: "per_run" as const } : {}),
  };

  if (base.timedOut) {
    return {
      ...base,
      exitCode: 1,
      errorMessage: "HarnessRouter task exceeded the adapter timeout",
      errorCode: "harnessrouter.timeout",
      errorFamily: "transient_upstream",
      errorMeta: { status },
    };
  }

  switch (status) {
    case "completed":
    case "succeeded":
      return base;

    case "cancelled":
      return {
        ...base,
        exitCode: 1,
        errorMessage: "HarnessRouter task was cancelled",
        errorCode: "harnessrouter.task_cancelled",
        errorFamily: null,
        errorMeta: { status },
      };

    case "incomplete": {
      const reason = asString(asRecord(response?.error)?.message) ?? "task stopped before completion";
      return {
        ...base,
        exitCode: 1,
        errorMessage: `HarnessRouter task incomplete: ${reason}`,
        errorCode: "harnessrouter.task_incomplete",
        // A task that ran is not retried: the work (and the bill) already happened.
        errorFamily: null,
        errorMeta: { status },
      };
    }

    case "failed": {
      const error = asRecord(response?.error);
      const code = asString(error?.code) ?? "task_failed";
      const message = asString(error?.message) ?? "HarnessRouter task failed";
      return {
        ...base,
        exitCode: 1,
        errorMessage: message,
        errorCode: `harnessrouter.${code}`,
        // The task already ran; retrying would run the agent a second time.
        errorFamily: null,
        errorMeta: { status, uhpCode: code, uhpType: asString(error?.type) ?? null },
      };
    }

    default:
      return {
        ...base,
        exitCode: 1,
        errorMessage: `HarnessRouter returned an unrecognised status: ${status ?? "missing"}`,
        errorCode: "harnessrouter.unexpected_status",
        errorFamily: null,
        errorMeta: { status: status ?? null },
      };
  }
}
