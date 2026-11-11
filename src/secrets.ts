/**
 * API-key resolution.
 *
 * The key can come from three places, in order: the agent's `adapterConfig`,
 * `HARNESSROUTER_API_KEY`, or a file the operator wrote by hand. Reading a file
 * last keeps the key out of Paperclip's database and out of shell history.
 *
 * The file is operator-chosen, so the reader is deliberately narrow: regular
 * files only (a FIFO or device would hang or stream forever) and a hard size
 * cap. The path itself is still trusted input — if `adapterConfig` were ever
 * editable by a user outside the host's trust domain, a path allowlist would
 * belong here too.
 *
 * Nothing here ever logs or returns the key except to the client constructor.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

import type { HarnessRouterConfig } from "./config.js";

export type ReadFile = (path: string, encoding: "utf8") => string;

/** A key is tens of bytes; anything larger is a misconfiguration or an attack. */
export const MAX_API_KEY_FILE_BYTES = 64 * 1024;

export interface ApiKeyResolution {
  apiKey: string;
  /** Where the key came from. Safe to log; the key itself is not. */
  source: "config" | "file" | "none";
  /** The file that was (or would have been) consulted. Safe to log. */
  apiKeyFile: string;
  /** Why the file could not be used, when it could not. Safe to log. */
  fileError: string | null;
}

/**
 * Read a key file without trusting what it points at. `statSync` runs before
 * `openSync` because opening a FIFO blocks until a writer appears; the
 * `fstatSync` after opening confirms the descriptor is still a regular file.
 */
function readApiKeyFile(path: string): string {
  const before = statSync(path);
  if (!before.isFile()) throw new Error("the path is not a regular file");
  if (before.size > MAX_API_KEY_FILE_BYTES) {
    throw new Error(`the file is larger than ${MAX_API_KEY_FILE_BYTES} bytes`);
  }

  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error("the path is not a regular file");
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function resolveApiKey(
  config: Pick<HarnessRouterConfig, "apiKey" | "apiKeyFile">,
  options: { readFile?: ReadFile } = {},
): ApiKeyResolution {
  if (config.apiKey) {
    return { apiKey: config.apiKey, source: "config", apiKeyFile: config.apiKeyFile, fileError: null };
  }

  const readFile: ReadFile = options.readFile ?? readApiKeyFile;

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
