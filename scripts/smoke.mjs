#!/usr/bin/env node
/**
 * Live smoke test against a running HarnessRouter.
 *
 *   HARNESSROUTER_BASE_URL=http://127.0.0.1:3200/api/harness \
 *   node scripts/smoke.mjs [harnessId]
 *
 * The key comes from HARNESSROUTER_API_KEY, HARNESSROUTER_API_KEY_FILE, or
 * ~/.harnessrouter/api-key. Never prints it. Exits non-zero on the first failed check.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createHarnessRouterAdapter } from "../dist/index.js";

const baseUrl = process.env.HARNESSROUTER_BASE_URL ?? "http://localhost:3000/api/harness";
const apiKeyFile = process.env.HARNESSROUTER_API_KEY_FILE ?? join(homedir(), ".harnessrouter", "api-key");
const apiKey = process.env.HARNESSROUTER_API_KEY ?? readKeyFile(apiKeyFile);
const harnessId = process.argv[2] ?? process.env.HARNESSROUTER_HARNESS_ID ?? null;

function readKeyFile(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

if (!apiKey) {
  console.error(
    `No API key. Set HARNESSROUTER_API_KEY or write one to ${apiKeyFile}. Create a key in the console under API Keys.`,
  );
  process.exit(2);
}

const adapter = createHarnessRouterAdapter();
const config = { baseUrl, apiKey, ...(harnessId ? { harnessId } : {}) };

const environment = await adapter.testEnvironment({
  companyId: "smoke",
  adapterType: "harnessrouter",
  config,
});

console.log(`testEnvironment: ${environment.status}`);
for (const check of environment.checks) {
  console.log(`  [${check.level}] ${check.code}: ${check.message}${check.detail ? ` (${check.detail})` : ""}`);
}
if (environment.status === "fail") process.exit(1);

const logs = [];
const result = await adapter.execute({
  runId: `smoke-${Date.now()}`,
  agent: { id: "smoke-agent", companyId: "smoke", name: "Smoke Test", adapterType: "harnessrouter", adapterConfig: config },
  runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
  config,
  context: { prompt: "Reply with exactly: it works." },
  onLog: async (_stream, chunk) => logs.push(chunk),
  onEvent: async () => {},
});

console.log(`\nexecute: exitCode=${result.exitCode} model=${result.model ?? "?"} timedOut=${result.timedOut}`);
if (result.usage) console.log(`usage: ${JSON.stringify(result.usage)}`);
if (result.sessionDisplayId) console.log(`response: ${result.sessionDisplayId}`);
console.log(`stdout: ${logs.join("").trim().slice(0, 500)}`);
if (result.errorMessage) console.error(`error: ${result.errorCode} — ${result.errorMessage}`);

process.exit(result.exitCode === 0 ? 0 : 1);
