/**
 * API-key resolution.
 *
 * The key can come from three places, in order: the agent's `adapterConfig`,
 * `HARNESSROUTER_API_KEY`, or a file the operator wrote by hand. Reading a file
 * last keeps the key out of Paperclip's database and out of shell history.
 *
 * Nothing here ever logs or returns the key except to the client constructor.
 */

import { readFileSync } from "node:fs";

import type { HarnessRouterConfig } from "./config.js";

export type ReadFile = (path: string, encoding: "utf8") => string;

export interface ApiKeyResolution {
  apiKey: string;
  /** Where the key came from. Safe to log; the key itself is not. */
  source: "config" | "file" | "none";
  /** The file that was (or would have been) consulted. Safe to log. */
  apiKeyFile: string;
  /** Why the file could not be used, when it could not. Safe to log. */
  fileError: string | null;
}

export function resolveApiKey(
  config: Pick<HarnessRouterConfig, "apiKey" | "apiKeyFile">,
  options: { readFile?: ReadFile } = {},
): ApiKeyResolution {
  if (config.apiKey) {
    return { apiKey: config.apiKey, source: "config", apiKeyFile: config.apiKeyFile, fileError: null };
  }

  const readFile: ReadFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding));

  try {
    // A trailing newline is the normal case for a file written with `echo`.
    const apiKey = readFile(config.apiKeyFile, "utf8").trim();
    return apiKey
      ? { apiKey, source: "file", apiKeyFile: config.apiKeyFile, fileError: null }
      : { apiKey: "", source: "none", apiKeyFile: config.apiKeyFile, fileError: "the file is empty" };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      apiKey: "",
      source: "none",
      apiKeyFile: config.apiKeyFile,
      fileError: code === "ENOENT" ? "the file does not exist" : error instanceof Error ? error.message : String(error),
    };
  }
}
