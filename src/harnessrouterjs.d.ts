/**
 * Minimal declarations for `harnessrouterjs@0.1.0`.
 *
 * The package ships JavaScript without types. These cover exactly the surface
 * the adapter uses; widen them (or upstream them) as more of the client is used.
 */
declare module "harnessrouterjs" {
  export interface HarnessRouterOptions {
    baseUrl: string;
    apiKey?: string;
    version?: string;
    timeoutMs?: number;
    maxRetries?: number;
    fetch?: typeof fetch;
  }

  export interface TaskOptions {
    harnessId?: string;
    key?: string;
    signal?: AbortSignal;
    previousResponseId?: string;
    metadata?: Record<string, unknown>;
    model?: string;
    instructions?: string;
    [key: string]: unknown;
  }

  export class UhpError extends Error {
    status?: number;
    type?: string | null;
    code?: string | null;
    param?: string | null;
    detail?: unknown;
    requestId?: string | null;
    readonly retryable: boolean;
  }

  export class HarnessRouter {
    constructor(options: HarnessRouterOptions);
    discover(): Promise<Record<string, unknown>>;
    harnesses(): Promise<Array<Record<string, unknown>>>;
    harness(harnessId: string): Promise<Record<string, unknown>>;
    models(): Promise<Record<string, unknown>>;
    harnessModels(harnessId: string): Promise<Record<string, unknown>>;
    run(input: unknown, options?: TaskOptions): Promise<Record<string, unknown>>;
    stream(input: unknown, options?: TaskOptions): AsyncGenerator<Record<string, unknown>, void, unknown>;
    collect(input: unknown, options?: TaskOptions & { onEvent?: (event: unknown) => void }): Promise<unknown>;
    continue(responseId: string, input: unknown, options?: TaskOptions): Promise<Record<string, unknown>>;
    getResponse(responseId: string): Promise<Record<string, unknown>>;
    inputItems(responseId: string): Promise<Record<string, unknown>>;
    cancel(responseId: string): Promise<unknown>;
    deleteResponse(responseId: string): Promise<unknown>;
    wait(responseId: string, options?: { intervalMs?: number; timeoutMs?: number }): Promise<Record<string, unknown>>;
    sessions(options?: { limit?: number; cursor?: string; harness?: string }): Promise<Record<string, unknown>>;
    session(sessionId: string): Promise<Record<string, unknown>>;
    turns(sessionId: string): Promise<Record<string, unknown>>;
    sessionFiles(sessionId: string): Promise<Array<Record<string, unknown>>>;
    cancelSession(sessionId: string): Promise<unknown>;
    deleteSession(sessionId: string): Promise<unknown>;
    uploadFile(file: Blob, filename: string): Promise<Record<string, unknown>>;
    downloadFile(containerId: string, fileId: string): Promise<Response>;
  }

  export const PROTOCOL_VERSION: string;
  export function idempotencyKey(prefix?: string): string;
  export function outputText(response: unknown): string;
  export function artifacts(response: unknown): unknown[];
  export function isTerminal(status: unknown): boolean;
  export default HarnessRouter;
}
