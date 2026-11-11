#!/usr/bin/env node
/**
 * Live smoke test against a running HarnessRouter.
 *
 *   HARNESSROUTER_BASE_URL=http://127.0.0.1:3200/api/harness \
 *   node scripts/smoke.mjs [harnessId]
 *
 * The key is resolved exactly as the adapter resolves it — HARNESSROUTER_API_KEY,
 * then HARNESSROUTER_API_KEY_FILE, then ~/.harnessrouter/api-key — so a passing
 * smoke run means the adapter itself would authenticate. Never prints the key.
 * Exits non-zero on the first failed check.
 */

import { createHarnessRouterAdapter, normalizeConfig, resolveApiKey } from "../dist/index.js";

const harnessId = process.argv[2] ?? process.env.HARNESSROUTER_HARNESS_ID ?? null;

// Reuse the adapter's own resolution so this script cannot disagree with it:
// same `~` expansion, same empty-value handling, same error reporting.
const config = normalizeConfig({ ...(harnessId ? { harnessId } : {}) }, { env: process.env });
const key = resolveApiKey(config);

if (!key.apiKey) {
  console.error(
    `No API key. Set HARNESSROUTER_API_KEY or write one to ${key.apiKeyFile}${
      key.fileError ? ` (${key.fileError})` : ""
    }. Create a key in the console under API Keys.`,
  );
  process.exit(2);
}

const adapter = createHarnessRouterAdapter();

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
