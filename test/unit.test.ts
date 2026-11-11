import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, DEFAULT_API_KEY_FILE, DEFAULT_BASE_URL, normalizeConfig } from "../src/config.js";
import { classifyFamily, describeError, mapExecutionError } from "../src/errors.js";
import { isTerminalEvent, mapStreamEvent } from "../src/events.js";
import { buildPrompt } from "../src/prompt.js";
import { buildExecutionResult, readUsage } from "../src/result.js";
import { MAX_API_KEY_FILE_BYTES, resolveApiKey } from "../src/secrets.js";
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

  it("defaults the key file to the operator's home", () => {
    expect(normalizeConfig({}).apiKeyFile).toBe(join(homedir(), ".harnessrouter", "api-key"));
    expect(DEFAULT_API_KEY_FILE).toBe(normalizeConfig({}).apiKeyFile);
  });

  it("takes the key file from the environment, and expands a leading ~", () => {
    expect(normalizeConfig({}, { env: { HARNESSROUTER_API_KEY_FILE: "/etc/hr/key" } }).apiKeyFile).toBe("/etc/hr/key");
    expect(normalizeConfig({}, { env: { HARNESSROUTER_API_KEY_FILE: "~/secrets/hr" } }).apiKeyFile).toBe(
      join(homedir(), "secrets/hr"),
    );
  });

  it("prefers an explicit key file over the environment", () => {
    const config = normalizeConfig(
      { apiKeyFile: "~/explicit/key" },
      { env: { HARNESSROUTER_API_KEY_FILE: "/env/key" } },
    );
    expect(config.apiKeyFile).toBe(join(homedir(), "explicit/key"));
  });
});

describe("resolveApiKey", () => {
  const base = { apiKey: "", apiKeyFile: "/tmp/key" };

  it("uses an inline key and never touches the file", () => {
    const resolution = resolveApiKey(
      { apiKey: "inline", apiKeyFile: "/tmp/key" },
      {
        readFile: () => {
          throw new Error("should not read the file");
        },
      },
    );
    expect(resolution).toMatchObject({ apiKey: "inline", source: "config", fileError: null });
  });

  it("reads and trims the key file", () => {
    const resolution = resolveApiKey(base, { readFile: () => "  file-key\n" });
    expect(resolution).toMatchObject({ apiKey: "file-key", source: "file", apiKeyFile: "/tmp/key" });
  });

  it("reports a missing file instead of failing the run with a stack trace", () => {
    const resolution = resolveApiKey(base, {
      readFile: () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      },
    });
    expect(resolution).toMatchObject({ apiKey: "", source: "none", fileError: "the file does not exist" });
  });

  it("treats an empty file as no key", () => {
    const resolution = resolveApiKey(base, { readFile: () => "\n" });
    expect(resolution).toMatchObject({ apiKey: "", source: "none", fileError: "the file is empty" });
  });

  it("passes through other read errors so permissions problems are visible", () => {
    const resolution = resolveApiKey(base, {
      readFile: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect(resolution.fileError).toBe("EACCES: permission denied");
  });
});

describe("resolveApiKey file safety", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "harnessrouter-key-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a regular key file", () => {
    const file = join(dir, "api-key");
    writeFileSync(file, "  real-key\n", { mode: 0o600 });
    expect(resolveApiKey({ apiKey: "", apiKeyFile: file })).toMatchObject({
      apiKey: "real-key",
      source: "file",
    });
  });

  it("refuses a path that is not a regular file, so a FIFO or device cannot hang the run", () => {
    const resolution = resolveApiKey({ apiKey: "", apiKeyFile: dir });
    expect(resolution).toMatchObject({ apiKey: "", source: "none", fileError: "the path is not a regular file" });
  });

  it("refuses a file larger than the cap instead of reading it whole", () => {
    const file = join(dir, "oversized-key");
    writeFileSync(file, "x".repeat(MAX_API_KEY_FILE_BYTES + 1), { mode: 0o600 });
    const resolution = resolveApiKey({ apiKey: "", apiKeyFile: file });
    expect(resolution).toMatchObject({
      apiKey: "",
      source: "none",
      fileError: `the file is larger than ${MAX_API_KEY_FILE_BYTES} bytes`,
    });
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
