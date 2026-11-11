/**
 * Adapter configuration.
 *
 * Everything here comes from the agent's `adapterConfig` in Paperclip, with the
 * API key allowed to arrive from the environment instead so it never has to be
 * written into a database row.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "http://localhost:3000/api/harness";
export const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
/** Where a key saved by the operator is read from when nothing else supplies one. */
export const DEFAULT_API_KEY_FILE = join(homedir(), ".harnessrouter", "api-key");

export interface HarnessRouterConfig {
  baseUrl: string;
  apiKey: string;
  /**
   * File the API key is read from when `apiKey` is not set inline. Always a
   * path: the operator writes the key once with `chmod 600` and it never has to
   * be copied into Paperclip's database or a shell history.
   */
  apiKeyFile: string;
  harnessId: string | null;
  model: string | null;
  instructions: string;
  timeoutSeconds: number;
  maxRetries: number;
  /** UHP version to request. Null takes the client's default, which the server must support. */
  protocolVersion: string | null;
}

export interface NormalizeConfigOptions {
  /** Looked up only when `config.apiKey` is absent. */
  env?: Record<string, string | undefined>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** `fs` does not expand `~`; an operator writing a path by hand expects it to. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return fallback;
}

/**
 * Validate and normalize `adapterConfig`.
 *
 * `baseUrl` must be an http(s) origin, because a bad scheme fails much later
 * and much less clearly (fetch rejects with "unknown scheme"). Trailing slashes
 * are stripped here so every caller can concatenate paths safely.
 */
export function normalizeConfig(
  raw: Record<string, unknown> | null | undefined,
  options: NormalizeConfigOptions = {},
): HarnessRouterConfig {
  const config = raw ?? {};
  const env = options.env ?? {};

  const baseUrlRaw = readString(config.baseUrl) ?? readString(env.HARNESSROUTER_BASE_URL) ?? DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrlRaw);
  } catch {
    throw new ConfigError(`baseUrl is not a valid URL: ${baseUrlRaw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`baseUrl must be http or https, got ${parsed.protocol}`);
  }
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");

  const apiKey = readString(config.apiKey) ?? readString(env.HARNESSROUTER_API_KEY) ?? "";
  const apiKeyFileRaw = readString(config.apiKeyFile) ?? readString(env.HARNESSROUTER_API_KEY_FILE);

  return {
    baseUrl,
    apiKey,
    apiKeyFile: apiKeyFileRaw ? expandHome(apiKeyFileRaw) : DEFAULT_API_KEY_FILE,
    harnessId: readString(config.harnessId),
    model: readString(config.model),
    instructions:
      readString(config.instructions) ??
      "Follow the Paperclip wake instructions exactly. Do not expose secrets in logs, comments, or final output.",
    timeoutSeconds: readPositiveInt(config.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
    maxRetries: readPositiveInt(config.maxRetries, 2),
    protocolVersion: readString(config.protocolVersion),
  };
}
