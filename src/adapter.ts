/**
 * Paperclip `ServerAdapterModule` for HarnessRouter.
 *
 * One Paperclip run becomes one UHP task: `POST /v1/responses` with
 * `stream: true`, followed to its terminal event. Conversation continuity is
 * `previous_response_id`, carried through Paperclip's session codec.
 */

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeEvent,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import HarnessRouter, { idempotencyKey } from "harnessrouterjs";

import { ConfigError, normalizeConfig, type HarnessRouterConfig } from "./config.js";
import { describeError, mapExecutionError } from "./errors.js";
import { isTerminalEvent, mapStreamEvent, type UhpStreamEvent } from "./events.js";
import { buildPrompt } from "./prompt.js";
import { buildExecutionResult, type UhpResponse } from "./result.js";
import { resumableResponseId, sessionCodec } from "./session.js";

export const ADAPTER_TYPE = "harnessrouter";
export const PROTOCOL_FALLBACK_VERSION = "unknown";

export type UhpClient = Pick<
  HarnessRouter,
  "discover" | "harnesses" | "stream" | "getResponse" | "cancel" | "harnessModels"
>;

export interface AdapterDependencies {
  /** Test seam: build a client from config without touching the network. */
  createClient?: (config: HarnessRouterConfig) => UhpClient;
  env?: Record<string, string | undefined>;
}

function makeClient(config: HarnessRouterConfig): UhpClient {
  return new HarnessRouter({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutSeconds * 1000,
    maxRetries: config.maxRetries,
    // Omitted unless configured: the client picks a version the server is
    // expected to speak, and an explicit bad value fails the run for no gain.
    ...(config.protocolVersion ? { version: config.protocolVersion } : {}),
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Pull the response id out of any event that carries one, so cancel has a target. */
function responseIdFromEvent(event: UhpStreamEvent): string | null {
  const fromField = typeof event.response_id === "string" ? event.response_id : null;
  if (fromField) return fromField;
  const response = asRecord(event.response);
  const id = response?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

function safeIdempotencyKey(runId: string): string {
  const suffix = runId.replace(/[^A-Za-z0-9_-]/g, "");
  return suffix ? `paperclip-${suffix}` : idempotencyKey("paperclip");
}

export function createHarnessRouterAdapter(deps: AdapterDependencies = {}): ServerAdapterModule {
  const createClient = deps.createClient ?? makeClient;
  const env = deps.env ?? (typeof process === "undefined" ? {} : process.env);

  async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const startedAt = Date.now();
    let config: HarnessRouterConfig;
    try {
      config = normalizeConfig(ctx.config, { env });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        errorCode: "harnessrouter.config_error",
        errorFamily: "configuration",
        errorMeta: {},
        sessionParams: null,
        sessionDisplayId: null,
        provider: "harnessrouter",
      };
    }

    if (!config.apiKey) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage:
          "No HarnessRouter API key. Set adapterConfig.apiKey or HARNESSROUTER_API_KEY; create a key in the console under API Keys.",
        errorCode: "harnessrouter.missing_api_key",
        errorFamily: "configuration",
        errorMeta: { baseUrl: config.baseUrl },
        sessionParams: null,
        sessionDisplayId: null,
        provider: "harnessrouter",
      };
    }

    const client = createClient(config);
    const previousResponseId = resumableResponseId(ctx.runtime?.sessionParams ?? null, {
      baseUrl: config.baseUrl,
      harnessId: config.harnessId,
    });

    const prompt = buildPrompt({ agent: ctx.agent, runId: ctx.runId, context: ctx.context ?? {} });
    await ctx.onMeta?.({
      adapterType: ADAPTER_TYPE,
      command: "harnessrouter /v1/responses",
      commandNotes: [
        `baseUrl=${config.baseUrl}`,
        `harnessId=${config.harnessId ?? "(server default)"}`,
        previousResponseId ? `resumed from response ${previousResponseId}` : "new conversation",
      ],
      env: { HARNESSROUTER_BASE_URL: config.baseUrl },
    });

    ctx.onDispatch?.();

    let responseId: string | null = previousResponseId;
    let terminalResponse: UhpResponse | null = null;
    let accumulatedText = "";
    let streamError: unknown = null;

    const emit = async (event: AdapterRuntimeEvent | null) => {
      if (event && ctx.onEvent) await ctx.onEvent(event);
    };

    const options: Record<string, unknown> = {
      key: safeIdempotencyKey(ctx.runId),
    };
    if (config.harnessId) options.harnessId = config.harnessId;
    if (config.model) options.model = config.model;
    if (config.instructions) options.instructions = config.instructions;
    if (previousResponseId) options.previousResponseId = previousResponseId;
    if (ctx.signal) options.signal = ctx.signal;
    options.metadata = {
      paperclip_run_id: ctx.runId,
      paperclip_agent_id: ctx.agent.id,
      paperclip_company_id: ctx.agent.companyId,
    };

    // A streamed task is never retried by the client library: it cannot know
    // whether work started. We can — if no event arrived, nothing ran. Retrying
    // that case under the same idempotency key is safe and saves a whole run.
    let attempt = 0;
    let sawEvent = false;
    for (;;) {
      try {
        for await (const rawEvent of client.stream(prompt, options)) {
          sawEvent = true;
          const event = rawEvent as UhpStreamEvent;
          const discovered = responseIdFromEvent(event);
          if (discovered) responseId = discovered;

          const mapped = mapStreamEvent(event);
          if (mapped.log) await ctx.onLog(mapped.log.stream, mapped.log.chunk);
          await emit(mapped.event);

          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            accumulatedText += event.delta;
          }
          if (isTerminalEvent(event.type)) {
            terminalResponse = asRecord(event.response) as UhpResponse | null;
          }
        }
        break;
      } catch (error) {
        const retryable = (error as { retryable?: unknown })?.retryable === true;
        if (retryable && !sawEvent && attempt < config.maxRetries) {
          attempt += 1;
          await ctx.onLog(
            "stderr",
            `[harnessrouter] retrying (${attempt}/${config.maxRetries}) after ${describeError(error)}\n`,
          );
          continue;
        }
        streamError = error;
        break;
      }
    }

    // A dropped stream is not a failed task: the stored response is the source
    // of truth, so ask the server what actually happened.
    if (!terminalResponse && !streamError && responseId && !previousResponseId) {
      try {
        terminalResponse = (await client.getResponse(responseId)) as UhpResponse;
      } catch (error) {
        streamError = error;
      }
    }

    if (ctx.signal?.aborted && responseId) {
      try {
        await client.cancel(responseId);
      } catch (error) {
        await ctx.onLog("stderr", `[harnessrouter] cancel failed: ${describeError(error)}\n`);
      }
    }

    const sessionParams = responseId
      ? {
          harnessrouterResponseId: responseId,
          baseUrl: config.baseUrl,
          ...(config.harnessId ? { harnessId: config.harnessId } : {}),
        }
      : null;

    if (streamError) {
      const mapped = mapExecutionError(streamError);
      const timedOut = (streamError as { name?: string })?.name === "AbortError" || ctx.signal?.aborted === true;
      return {
        exitCode: 1,
        signal: ctx.signal?.aborted ? "SIGTERM" : null,
        timedOut,
        errorMessage: mapped.errorMessage,
        errorCode: mapped.errorCode,
        errorFamily: timedOut ? "transient_upstream" : mapped.errorFamily,
        errorMeta: { ...mapped.errorMeta, elapsedMs: Date.now() - startedAt },
        sessionParams,
        sessionDisplayId: responseId,
        provider: "harnessrouter",
        model: config.model,
      };
    }

    if (!terminalResponse) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "HarnessRouter stream ended without a terminal event and no response could be read back",
        errorCode: "harnessrouter.stream_incomplete",
        errorFamily: "transient_upstream",
        errorMeta: { responseId, elapsedMs: Date.now() - startedAt },
        sessionParams,
        sessionDisplayId: responseId,
        provider: "harnessrouter",
        model: config.model,
      };
    }

    const result = buildExecutionResult({
      response: terminalResponse,
      text: accumulatedText,
      model: config.model,
      sessionParams,
    });

    return {
      ...result,
      errorMeta: { ...(result.errorMeta ?? {}), elapsedMs: Date.now() - startedAt },
    };
  }

  async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
    const checks: AdapterEnvironmentCheck[] = [];
    const testedAt = new Date().toISOString();
    let config: HarnessRouterConfig | null = null;

    try {
      config = normalizeConfig(ctx.config, { env });
      checks.push({
        code: "config.base_url",
        level: "info",
        message: `Base URL: ${config.baseUrl}`,
      });
    } catch (error) {
      checks.push({
        code: "config.invalid",
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        hint: "Use an http(s) URL, e.g. http://localhost:3000/api/harness",
      });
    }

    if (config && !config.apiKey) {
      checks.push({
        code: "config.api_key",
        level: "error",
        message: "No HarnessRouter API key configured",
        hint: "Create a key in the console under API Keys, then set adapterConfig.apiKey or HARNESSROUTER_API_KEY.",
      });
    }

    if (config) {
      const client = createClient(config);

      try {
        const discovery = asRecord(await client.discover());
        const implementation = asRecord(discovery?.implementation);
        const versions = Array.isArray(discovery?.versions)
          ? discovery.versions.filter((value): value is string => typeof value === "string")
          : [];
        const defaultVersion =
          typeof discovery?.default_version === "string" ? discovery.default_version : null;
        const label =
          discovery === null
            ? "Reachable"
            : `Reachable${defaultVersion ? `; protocol ${defaultVersion}` : ""}${
                typeof implementation?.version === "string" ? ` (HarnessRouter ${implementation.version})` : ""
              }`;
        checks.push({ code: "uhp.discovery", level: "info", message: label });

        if (config.protocolVersion && versions.length > 0 && !versions.includes(config.protocolVersion)) {
          checks.push({
            code: "config.protocol_version",
            level: "error",
            message: `Server does not support UHP ${config.protocolVersion}`,
            detail: `Supported: ${versions.join(", ")}`,
          });
        }
      } catch (error) {
        checks.push({
          code: "uhp.discovery",
          level: "error",
          message: `Cannot reach HarnessRouter: ${describeError(error)}`,
          hint: "Check the container is running and baseUrl points at the console, not the internal gateway port.",
        });
      }

      if (config.apiKey) {
        try {
          const harnesses = await client.harnesses();
          const ids = harnesses
            .map((harness) => (typeof harness === "object" && harness ? (harness as { id?: unknown }).id : null))
            .filter((id): id is string => typeof id === "string");

          checks.push({
            code: "uhp.auth",
            level: "info",
            message: `API key accepted; ${ids.length} harness${ids.length === 1 ? "" : "es"} available`,
            detail: ids.length > 0 ? ids.join(", ") : null,
            hint: ids.length === 0 ? "Create a harness in the console before running tasks." : null,
          });

          if (config.harnessId && ids.length > 0 && !ids.includes(config.harnessId)) {
            checks.push({
              code: "config.harness_id",
              level: "error",
              message: `Harness "${config.harnessId}" not found`,
              detail: `Available: ${ids.join(", ")}`,
            });
          }
        } catch (error) {
          checks.push({
            code: "uhp.auth",
            level: "error",
            message: `HarnessRouter rejected the request: ${describeError(error)}`,
            hint: "The key may be revoked, or the harness scope may exclude it.",
          });
        }
      }
    }

    const status = checks.some((check) => check.level === "error")
      ? "fail"
      : checks.some((check) => check.level === "warn")
        ? "warn"
        : "pass";

    return { adapterType: ctx.adapterType || ADAPTER_TYPE, status, checks, testedAt };
  }

  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    sessionCodec,
    supportsInstructionsBundle: false,
  };
}

export const adapter = createHarnessRouterAdapter();
