/**
 * @switchboard-si/harnessrouter-paperclip-adapter
 *
 * A Paperclip `ServerAdapterModule` that runs agents on HarnessRouter over the
 * Unified Harness Protocol.
 */

export {
  ADAPTER_TYPE,
  adapter,
  createHarnessRouterAdapter,
  type AdapterDependencies,
  type UhpClient,
} from "./adapter.js";
export { ConfigError, DEFAULT_BASE_URL, normalizeConfig, type HarnessRouterConfig } from "./config.js";
export { describeError, isUhpFailure, mapExecutionError } from "./errors.js";
export { mapStreamEvent, isTerminalEvent, type MappedEvent, type UhpStreamEvent } from "./events.js";
export { buildPrompt, type PromptContext } from "./prompt.js";
export { buildExecutionResult, readUsage, type UhpResponse } from "./result.js";
export { resolveApiKey, type ApiKeyResolution } from "./secrets.js";
export { resumableResponseId, sessionCodec, type HarnessRouterSessionParams } from "./session.js";

import { adapter as defaultAdapter } from "./adapter.js";
export default defaultAdapter;

/**
 * Paperclip's external-adapter loader requires this named factory. Returning
 * the same module instance keeps one adapter per process, which is correct:
 * the module holds no run state.
 */
export function createServerAdapter() {
  return defaultAdapter;
}
