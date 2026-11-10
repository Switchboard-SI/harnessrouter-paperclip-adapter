import { describe, expect, it } from "vitest";

import { ConfigError, DEFAULT_BASE_URL, normalizeConfig } from "../src/config.js";
import { classifyFamily, describeError, mapExecutionError } from "../src/errors.js";
import { isTerminalEvent, mapStreamEvent } from "../src/events.js";
import { buildPrompt } from "../src/prompt.js";
import { buildExecutionResult, readUsage } from "../src/result.js";
import { resumableResponseId, sessionCodec } from "../src/session.js";

function uhpError(overrides: Record<string, unknown>) {
  return Object.assign(new Error("boom"), { name: "UhpError", ...overrides });
}

describe("normalizeConfig", () => {
  it("defaults the base URL to the console API root", () => {
    expect(normalizeConfig({}).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("strips trailing slashes so paths concatenate cleanly", () => {
    expect(normalizeConfig({ baseUrl: "http://localhost:3200/api/harness///" }).baseUrl).toBe(
      "http://localhost:3200/api/harness",
    );
  });

  it("falls back to environment values", () => {
    const config = normalizeConfig(
      {},
      { env: { HARNESSROUTER_BASE_URL: "http://127.0.0.1:9000/api/harness", HARNESSROUTER_API_KEY: "env-key" } },
    );
    expect(config.baseUrl).toBe("http://127.0.0.1:9000/api/harness");
    expect(config.apiKey).toBe("env-key");
  });

  it("prefers explicit config over the environment", () => {
    const config = normalizeConfig(
      { apiKey: "config-key" },
      { env: { HARNESSROUTER_API_KEY: "env-key" } },
    );
    expect(config.apiKey).toBe("config-key");
  });

  it("rejects a non-http scheme instead of failing later inside fetch", () => {
    expect(() => normalizeConfig({ baseUrl: "ftp://example.com" })).toThrow(ConfigError);
  });

  it("rejects a string that is not a URL", () => {
    expect(() => normalizeConfig({ baseUrl: "not a url" })).toThrow(ConfigError);
  });
});

describe("sessionCodec", () => {
  it("round-trips a response id with its origin", () => {
    const params = {
      harnessrouterResponseId: "resp_1",
      harnessrouterSessionId: "sess_1",
      harnessId: "codex",
      baseUrl: "http://localhost:3000/api/harness",
    };
    expect(sessionCodec.deserialize(sessionCodec.serialize(params))).toEqual(params);
  });

  it("returns null for junk rather than inventing a session", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("nope")).toBeNull();
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
  });

  it("reports the response id as the display id", () => {
    expect(sessionCodec.getDisplayId({ harnessrouterResponseId: "resp_1" })).toBe("resp_1");
  });

  it("refuses to resume an id minted on another server", () => {
    const params = { harnessrouterResponseId: "resp_1", baseUrl: "http://other/api/harness", harnessId: "codex" };
    expect(resumableResponseId(params, { baseUrl: "http://localhost:3000/api/harness", harnessId: "codex" })).toBeNull();
  });

  it("refuses to resume an id from another harness", () => {
    const params = { harnessrouterResponseId: "resp_1", baseUrl: "http://x/api/harness", harnessId: "codex" };
    expect(resumableResponseId(params, { baseUrl: "http://x/api/harness", harnessId: "claude" })).toBeNull();
  });

  it("resumes when origin and harness agree", () => {
    const params = { harnessrouterResponseId: "resp_1", baseUrl: "http://x/api/harness", harnessId: "codex" };
    expect(resumableResponseId(params, { baseUrl: "http://x/api/harness", harnessId: "codex" })).toBe("resp_1");
  });
});

describe("error classification", () => {
  it("treats a rejected key as a configuration problem, not a transient one", () => {
    expect(classifyFamily(uhpError({ status: 401, type: "authentication_error", code: "invalid_credential" }))).toBe(
      "configuration",
    );
  });

  it("treats a 429 as quota", () => {
    expect(classifyFamily(uhpError({ status: 429, code: "rate_limited" }))).toBe("provider_quota");
  });

  it("treats 5xx as transient", () => {
    expect(classifyFamily(uhpError({ status: 503, type: "server_error", code: "unavailable" }))).toBe(
      "transient_upstream",
    );
  });

  it("treats a connection failure as transient", () => {
    expect(classifyFamily(new TypeError("fetch failed"))).toBe("transient_upstream");
  });

  it("keeps the raw UHP envelope so a support question can be answered", () => {
    const mapped = mapExecutionError(
      uhpError({
        status: 401,
        type: "authentication_error",
        code: "invalid_credential",
        message: "missing or invalid API key",
        requestId: "req_1",
      }),
    );
    expect(mapped.errorCode).toBe("harnessrouter.authentication_error.invalid_credential");
    expect(mapped.errorFamily).toBe("configuration");
    expect(mapped.errorMeta).toMatchObject({ httpStatus: 401, uhpCode: "invalid_credential", requestId: "req_1" });
  });

  it("describes non-UHP failures without eating them", () => {
    expect(describeError(new Error("kaboom"))).toBe("kaboom");
  });
});

describe("stream event mapping", () => {
  it("streams assistant text to stdout", () => {
    const mapped = mapStreamEvent({ type: "response.output_text.delta", delta: "hi", sequence_number: 3 });
    expect(mapped.log).toEqual({ stream: "stdout", chunk: "hi" });
    expect(mapped.event?.eventType).toBe("response.output_text.delta");
    expect(mapped.event?.payload?.sequenceNumber).toBe(3);
  });

  it("keeps reasoning off stdout so the transcript stays the answer", () => {
    expect(mapStreamEvent({ type: "response.reasoning_text.delta", delta: "thinking" }).log).toEqual({
      stream: "stderr",
      chunk: "thinking",
    });
  });

  it("labels a tool call without leaking its arguments", () => {
    const mapped = mapStreamEvent({
      type: "response.output_item.done",
      item: { type: "function_call", name: "read_file", arguments: '{"path":"/etc/passwd"}' },
    });
    expect(mapped.event?.message).toBe("tool call: read_file");
    expect(JSON.stringify(mapped.event)).not.toContain("/etc/passwd");
  });

  it("turns a stream error into an error-level event", () => {
    const mapped = mapStreamEvent({ type: "error", code: "boom", message: "upstream exploded" });
    expect(mapped.event?.level).toBe("error");
    expect(mapped.log?.stream).toBe("stderr");
  });

  it("recognises terminal events only", () => {
    expect(isTerminalEvent("response.completed")).toBe(true);
    expect(isTerminalEvent("response.failed")).toBe(true);
    expect(isTerminalEvent("response.output_text.delta")).toBe(false);
  });
});

describe("result mapping", () => {
  it("reads usage without turning unknown counts into zero", () => {
    expect(readUsage({ usage: { input_tokens: 5, output_tokens: 7, input_tokens_details: { cached_tokens: 2 } } })).toEqual(
      { inputTokens: 5, outputTokens: 7, cachedInputTokens: 2 },
    );
    expect(readUsage({ usage: {} })).toBeUndefined();
    expect(readUsage(null)).toBeUndefined();
  });

  it("returns success for a completed task", () => {
    const result = buildExecutionResult({
      response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 2 } },
      sessionParams: { harnessrouterResponseId: "resp_1" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.sessionDisplayId).toBe("resp_1");
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it("does not mark a failed task retryable — it already ran and it already cost money", () => {
    const result = buildExecutionResult({
      response: { id: "resp_2", status: "failed", error: { code: "harness_crashed", message: "the harness died" } },
      sessionParams: null,
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorFamily).toBeNull();
    expect(result.errorCode).toBe("harnessrouter.harness_crashed");
    expect(result.errorMessage).toBe("the harness died");
  });

  it("surfaces an unrecognised status instead of pretending it succeeded", () => {
    const result = buildExecutionResult({ response: { status: "mystery" }, sessionParams: null });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("harnessrouter.unexpected_status");
  });
});

describe("buildPrompt", () => {
  const base = { agent: { id: "a1", companyId: "c1", name: "Sr SWE Backend" }, runId: "r1" };

  it("carries identity and the wake prompt", () => {
    const prompt = buildPrompt({ ...base, context: { wakePrompt: "Fix the bug", issueKey: "SWI-323" } });
    expect(prompt).toContain("Sr SWE Backend");
    expect(prompt).toContain("Run ID: r1");
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("issueKey: SWI-323");
  });

  it("falls back to the context rather than sending an empty string", () => {
    const prompt = buildPrompt({ ...base, context: { something: "useful" } });
    expect(prompt).toContain("Execution context JSON");
    expect(prompt).toContain('"something": "useful"');
  });
});
