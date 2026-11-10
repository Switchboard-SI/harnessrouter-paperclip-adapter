import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterRuntimeEvent } from "@paperclipai/adapter-utils";

import { createHarnessRouterAdapter } from "../src/adapter.js";
import { startMockUhp, type MockUhp } from "./mock-uhp.js";

let mock: MockUhp | null = null;

afterEach(async () => {
  await mock?.close();
  mock = null;
});

interface Captured {
  logs: string[];
  events: AdapterRuntimeEvent[];
  metas: unknown[];
}

function makeContext(
  overrides: Partial<AdapterExecutionContext> & { config?: Record<string, unknown> } = {},
): { ctx: AdapterExecutionContext; captured: Captured } {
  const captured: Captured = { logs: [], events: [], metas: [] };
  const ctx = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Sr SWE Backend",
      adapterType: "harnessrouter",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: { prompt: "Do the thing" },
    onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
      captured.logs.push(chunk);
    },
    onEvent: async (event: AdapterRuntimeEvent) => {
      captured.events.push(event);
    },
    onMeta: async (meta: unknown) => {
      captured.metas.push(meta);
    },
    ...overrides,
  } as unknown as AdapterExecutionContext;
  return { ctx, captured };
}

describe("execute", () => {
  it("runs a task end to end and returns usage and a resumable session", async () => {
    mock = await startMockUhp({
      apiKey: "test-key",
      events: [
        { type: "response.output_text.delta", delta: "hello " },
        { type: "response.output_text.delta", delta: "world" },
      ],
    });

    const adapter = createHarnessRouterAdapter({ env: {} });
    const { ctx, captured } = makeContext({
      config: { baseUrl: mock.baseUrl, apiKey: "test-key", harnessId: "codex" },
    });

    const result = await adapter.execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeUndefined();
    expect(captured.logs.join("")).toContain("hello world");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    expect(result.sessionParams).toMatchObject({
      harnessrouterResponseId: "resp_1",
      baseUrl: mock.baseUrl,
      harnessId: "codex",
    });

    const post = mock.requests.find((request) => request.method === "POST" && request.path === "/v1/responses");
    expect(post).toBeDefined();
    expect(post?.headers["idempotency-key"]).toBe("paperclip-run-1");
    const body = post?.body as Record<string, unknown>;
    expect((body.metadata as Record<string, unknown>).harness_id).toBe("codex");
    expect(body.stream).toBe(true);
    expect(String(body.input)).toContain("Sr SWE Backend");
    expect(String(body.input)).toContain("Do the thing");
  });

  it("reuses a response id from the same server and harness", async () => {
    mock = await startMockUhp({ apiKey: "test-key" });
    const adapter = createHarnessRouterAdapter({ env: {} });
    const { ctx } = makeContext({
      config: { baseUrl: mock.baseUrl, apiKey: "test-key", harnessId: "codex" },
      runtime: {
        sessionId: null,
        sessionDisplayId: "resp_prev",
        taskKey: null,
        sessionParams: {
          harnessrouterResponseId: "resp_prev",
          baseUrl: mock.baseUrl,
          harnessId: "codex",
        },
      },
    });

    await adapter.execute(ctx);

    const post = mock.requests.find((request) => request.method === "POST" && request.path === "/v1/responses");
    expect((post?.body as Record<string, unknown>).previous_response_id).toBe("resp_prev");
  });

  it("starts a fresh conversation when the stored id came from another server", async () => {
    mock = await startMockUhp({ apiKey: "test-key" });
    const adapter = createHarnessRouterAdapter({ env: {} });
    const { ctx } = makeContext({
      config: { baseUrl: mock.baseUrl, apiKey: "test-key", harnessId: "codex" },
      runtime: {
        sessionId: null,
        sessionDisplayId: "resp_prev",
        taskKey: null,
        sessionParams: { harnessrouterResponseId: "resp_prev", baseUrl: "http://elsewhere/uhp", harnessId: "codex" },
      },
    });

    await adapter.execute(ctx);

    const post = mock.requests.find((request) => request.method === "POST" && request.path === "/v1/responses");
    expect((post?.body as Record<string, unknown>).previous_response_id).toBeUndefined();
  });

  it("fails clearly on a rejected key and does not retry it", async () => {
    mock = await startMockUhp({ apiKey: "test-key" });
    const adapter = createHarnessRouterAdapter({ env: {} });
    const { ctx } = makeContext({ config: { baseUrl: mock.baseUrl, apiKey: "wrong-key" } });

    const result = await adapter.execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorFamily).toBe("configuration");
    expect(result.errorCode).toBe("harnessrouter.authentication_error.invalid_credential");
    expect(mock.requests.filter((request) => request.path === "/v1/responses")).toHaveLength(1);
  });

  it("refuses to run without a key, and makes no request at all", async () => {
    mock = await startMockUhp();
    const adapter = createHarnessRouterAdapter({ env: {} });
    const { ctx } = makeContext({ config: { baseUrl: mock.baseUrl } });

    const result = await adapter.execute(ctx);

    expect(result.errorCode).toBe("harnessrouter.missing_api_key");
    expect(result.errorFamily).toBe("configuration");
    expect(mock.requests).toHaveLength(0);
  });

  it("reports a malformed base URL as configuration instead of throwing", async () => {
    const adapter = createHarnessRouterAdapter({ env: {} });
    const { ctx } = makeContext({ config: { baseUrl: "nonsense", apiKey: "k" } });

    const result = await adapter.execute(ctx);

    expect(result.errorCode).toBe("harnessrouter.config_error");
    expect(result.errorFamily).toBe("configuration");
  });
});

describe("testEnvironment", () => {
  it("passes when the server answers and the key is accepted", async () => {
    mock = await startMockUhp({ apiKey: "test-key", harnesses: [{ id: "codex" }, { id: "claude" }] });
    const adapter = createHarnessRouterAdapter({ env: {} });

    const result = await adapter.testEnvironment({
      companyId: "company-1",
      adapterType: "harnessrouter",
      config: { baseUrl: mock.baseUrl, apiKey: "test-key", harnessId: "codex" },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.map((check) => check.code)).toContain("uhp.discovery");
    expect(result.checks.find((check) => check.code === "uhp.auth")?.message).toContain("2 harnesses");
  });

  it("fails when the key is rejected", async () => {
    mock = await startMockUhp({ apiKey: "test-key" });
    const adapter = createHarnessRouterAdapter({ env: {} });

    const result = await adapter.testEnvironment({
      companyId: "company-1",
      adapterType: "harnessrouter",
      config: { baseUrl: mock.baseUrl, apiKey: "bad" },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.code === "uhp.auth")?.level).toBe("error");
  });

  it("fails when the configured harness does not exist", async () => {
    mock = await startMockUhp({ apiKey: "test-key", harnesses: [{ id: "codex" }] });
    const adapter = createHarnessRouterAdapter({ env: {} });

    const result = await adapter.testEnvironment({
      companyId: "company-1",
      adapterType: "harnessrouter",
      config: { baseUrl: mock.baseUrl, apiKey: "test-key", harnessId: "ghost" },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.code === "config.harness_id")?.level).toBe("error");
  });

  it("fails when the server cannot be reached", async () => {
    const adapter = createHarnessRouterAdapter({ env: {} });
    const result = await adapter.testEnvironment({
      companyId: "company-1",
      adapterType: "harnessrouter",
      config: { baseUrl: "http://127.0.0.1:1/api/harness", apiKey: "k", maxRetries: 1, timeoutSeconds: 1 },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.code === "uhp.discovery")?.level).toBe("error");
  });
});
