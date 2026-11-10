/**
 * Session continuity for HarnessRouter.
 *
 * UHP continues a conversation by pointing at the previous *response*, not by
 * carrying a mutable transcript: `previous_response_id` on the next
 * `POST /v1/responses` resumes that run's working directory and history.
 *
 * So the session state is small — the last response id plus the identifiers
 * needed to decide whether it is still valid.
 */

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export interface HarnessRouterSessionParams extends Record<string, unknown> {
  /** Last completed response id; becomes `previous_response_id` on the next turn. */
  harnessrouterResponseId: string;
  /** Session the response belongs to, when the server reports one. */
  harnessrouterSessionId?: string;
  /** Harness that produced the response. Reusing an id across harnesses is invalid. */
  harnessId?: string;
  /** Server the id came from. A response id is meaningless on another server. */
  baseUrl?: string;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const responseId = readString(record.harnessrouterResponseId) ?? readString(record.responseId);
    if (!responseId) return null;
    const sessionId = readString(record.harnessrouterSessionId) ?? readString(record.sessionId);
    const harnessId = readString(record.harnessId);
    const baseUrl = readString(record.baseUrl);
    return {
      harnessrouterResponseId: responseId,
      ...(sessionId ? { harnessrouterSessionId: sessionId } : {}),
      ...(harnessId ? { harnessId } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  },

  serialize(params) {
    if (!params) return null;
    const responseId = readString(params.harnessrouterResponseId) ?? readString(params.responseId);
    if (!responseId) return null;
    const sessionId = readString(params.harnessrouterSessionId) ?? readString(params.sessionId);
    const harnessId = readString(params.harnessId);
    const baseUrl = readString(params.baseUrl);
    return {
      harnessrouterResponseId: responseId,
      ...(sessionId ? { harnessrouterSessionId: sessionId } : {}),
      ...(harnessId ? { harnessId } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  },

  getDisplayId(params) {
    if (!params) return null;
    return readString(params.harnessrouterResponseId) ?? readString(params.harnessrouterSessionId);
  },
};

/**
 * Decide whether a stored response id may be resumed.
 *
 * The id is only meaningful on the server and harness that produced it. A
 * mismatched id is not an error worth failing the run over — it just means
 * this turn starts a fresh conversation.
 */
export function resumableResponseId(
  params: Record<string, unknown> | null | undefined,
  current: { baseUrl: string; harnessId: string | null },
): string | null {
  const decoded = sessionCodec.deserialize(params ?? null) as HarnessRouterSessionParams | null;
  if (!decoded) return null;
  if (decoded.baseUrl && decoded.baseUrl !== current.baseUrl) return null;
  if (decoded.harnessId && current.harnessId && decoded.harnessId !== current.harnessId) return null;
  return decoded.harnessrouterResponseId;
}
