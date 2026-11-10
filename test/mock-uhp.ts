/**
 * A tiny UHP server for tests.
 *
 * It implements just enough of the protocol for the real `harnessrouterjs`
 * client to talk to it, so the adapter is exercised over HTTP rather than
 * against a hand-rolled stub of the client.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface MockUhpOptions {
  apiKey?: string;
  harnesses?: Array<{ id: string; name?: string }>;
  /** Events emitted for a streamed response, in order. */
  events?: Array<Record<string, unknown>>;
  /** Force an error envelope on POST /v1/responses. */
  responsesError?: { status: number; type: string; code: string; message: string };
}

export interface MockUhp {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
  setEvents: (events: Array<Record<string, unknown>>) => void;
  setResponsesError: (error: MockUhpOptions["responsesError"]) => void;
}

const AUTH_ERROR = {
  error: {
    type: "authentication_error",
    code: "invalid_credential",
    message: "missing or invalid API key",
    param: null,
    detail: null,
  },
  detail: "missing or invalid API key",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockUhp(options: MockUhpOptions = {}): Promise<MockUhp> {
  const apiKey = options.apiKey ?? "test-key";
  const harnesses = options.harnesses ?? [{ id: "codex", name: "Codex" }];
  const requests: RecordedRequest[] = [];
  let events = options.events ?? [];
  let responsesError = options.responsesError;
  const stored = new Map<string, Record<string, unknown>>();
  let counter = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = await readBody(req);
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    requests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers, body });

    if (req.method === "GET" && url.pathname === "/v1/uhp") {
      return sendJson(res, 200, {
        object: "uhp.discovery",
        protocol: "uhp",
        versions: ["2026-10-04", "2026-08-11"],
        default_version: "2026-10-04",
        conformance_class: "full",
        capabilities: { streaming: true, sessions: true, cancellation: true, idempotency: true },
        implementation: { name: "Mock UHP", version: "0.0.0" },
      });
    }

    const authorized =
      typeof req.headers.authorization === "string" && req.headers.authorization === `Bearer ${apiKey}`;
    if (!authorized) return sendJson(res, 401, AUTH_ERROR);

    if (req.method === "GET" && url.pathname === "/v1/harnesses") {
      return sendJson(res, 200, { harnesses });
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      if (responsesError) {
        return sendJson(res, responsesError.status, {
          error: { type: responsesError.type, code: responsesError.code, message: responsesError.message, param: null, detail: null },
          detail: responsesError.message,
        });
      }

      counter += 1;
      const id = `resp_${counter}`;
      const request = body as Record<string, unknown>;
      const terminal = {
        id,
        object: "response",
        status: "completed",
        model: request.model ?? "mock-model",
        session_id: `sess_${counter}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: events.map((e) => e.delta ?? "").join("") || "done" }],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 34 },
      };
      stored.set(id, terminal);

      if (request.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const frames = [
          { type: "response.created", sequence_number: 1, response: { id, status: "in_progress" } },
          ...events.map((event, index) => ({
            sequence_number: index + 2,
            ...event,
          })),
          { type: "response.completed", sequence_number: events.length + 2, response: terminal },
        ];
        for (const frame of frames) {
          res.write(`event: ${String(frame.type)}\n`);
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        res.end();
        return;
      }

      return sendJson(res, 200, terminal);
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/responses/")) {
      const id = url.pathname.split("/")[3] ?? "";
      const response = stored.get(id);
      if (!response) {
        return sendJson(res, 404, { error: { type: "not_found", code: "response_not_found", message: "not found" } });
      }
      return sendJson(res, 200, response);
    }

    if (req.method === "POST" && url.pathname.endsWith("/cancel")) {
      return sendJson(res, 200, { id: url.pathname.split("/")[3], status: "cancelled" });
    }

    return sendJson(res, 404, { error: { type: "not_found", code: "route_not_found", message: url.pathname } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setEvents(next) {
      events = next;
    },
    setResponsesError(next) {
      responsesError = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
