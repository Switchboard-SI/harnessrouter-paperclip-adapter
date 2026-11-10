/**
 * UHP stream events → Paperclip progress.
 *
 * Kept as a pure function so the mapping is testable without a network, a
 * server, or an adapter context. `execute` only has to drain what this returns.
 */

import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";

export interface MappedLog {
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface MappedEvent {
  log: MappedLog | null;
  event: AdapterRuntimeEvent | null;
}

export interface UhpStreamEvent {
  type?: unknown;
  sequence_number?: unknown;
  delta?: unknown;
  item?: unknown;
  annotation?: unknown;
  response?: unknown;
  code?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A compact label for a tool call; never the raw arguments, which can hold secrets. */
function describeToolCall(item: Record<string, unknown>): string {
  const name = asString(item.name) ?? asString(item.tool_name) ?? "tool";
  return `tool call: ${name}`;
}

function buildEvent(
  type: string,
  sequenceNumber: unknown,
  extra: Pick<AdapterRuntimeEvent, "stream" | "level" | "message" | "payload"> = {},
): AdapterRuntimeEvent {
  const payload =
    typeof sequenceNumber === "number"
      ? { ...(extra.payload ?? {}), sequenceNumber }
      : extra.payload;
  return {
    eventType: type,
    ...(extra.stream ? { stream: extra.stream } : {}),
    ...(extra.level ? { level: extra.level } : {}),
    ...(extra.message ? { message: extra.message } : {}),
    ...(payload ? { payload } : {}),
  };
}

export function mapStreamEvent(raw: UhpStreamEvent): MappedEvent {
  const type = asString(raw.type);
  if (!type) return { log: null, event: null };
  const seq = raw.sequence_number;

  switch (type) {
    case "response.output_text.delta": {
      const delta = asString(raw.delta);
      return {
        log: delta ? { stream: "stdout", chunk: delta } : null,
        event: buildEvent(type, seq, { stream: "stdout", level: "info" }),
      };
    }

    case "response.reasoning_text.delta": {
      const delta = asString(raw.delta);
      return {
        // Reasoning is not part of the answer; keep it off stdout so a
        // transcript built from stdout stays exactly the assistant's output.
        log: delta ? { stream: "stderr", chunk: delta } : null,
        event: buildEvent(type, seq, { stream: "stderr", level: "info" }),
      };
    }

    case "response.output_item.done": {
      const item = asRecord(raw.item);
      if (!item) return { log: null, event: buildEvent(type, seq) };
      if (asString(item.type) === "function_call") {
        const label = describeToolCall(item);
        return {
          log: { stream: "stdout", chunk: `\n[${label}]\n` },
          event: buildEvent(type, seq, {
            level: "info",
            message: label,
            payload: { name: asString(item.name) ?? null, callId: asString(item.call_id) ?? null },
          }),
        };
      }
      return { log: null, event: buildEvent(type, seq) };
    }

    case "response.annotation.added": {
      const annotation = asRecord(raw.annotation);
      const fileId = annotation ? asString(annotation.file_id) : null;
      return {
        log: null,
        event: buildEvent(type, seq, {
          level: "info",
          message: fileId ? `artifact: ${fileId}` : "annotation",
          payload: { fileId },
        }),
      };
    }

    case "error": {
      const message = asString(raw.message) ?? "harness stream error";
      const code = asString(raw.code);
      return {
        log: { stream: "stderr", chunk: `[harnessrouter] ${message}\n` },
        event: buildEvent(type, seq, { level: "error", message, payload: { code } }),
      };
    }

    default:
      return { log: null, event: buildEvent(type, seq) };
  }
}

/** Whether this event means the task has reached a terminal state. */
export function isTerminalEvent(type: unknown): boolean {
  return (
    type === "response.completed" ||
    type === "response.failed" ||
    type === "response.incomplete" ||
    type === "response.cancelled"
  );
}
