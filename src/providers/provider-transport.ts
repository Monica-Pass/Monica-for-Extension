import { ProviderBodyReadNetworkError } from "./bounded-body";

export type ProviderTransportCode = "cancelled" | "timeout" | "network" | "rate-limited" | "server" | "authentication" | "permission" | "not-found" | "conflict" | "client";

export interface ProviderTransportErrorDetails {
  retryable: boolean;
  operation: string;
  attempts: number;
  status?: number;
  retryAfterMs?: number;
}

export class ProviderTransportError extends Error {
  readonly code: ProviderTransportCode;
  readonly retryable: boolean;
  readonly operation: string;
  readonly attempts: number;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: ProviderTransportCode, message: string, details: ProviderTransportErrorDetails) {
    super(message);
    this.name = "ProviderTransportError";
    this.code = code;
    this.retryable = details.retryable;
    this.operation = details.operation;
    this.attempts = details.attempts;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export interface ProviderTransportEvent {
  operation: string;
  attempt: number;
  outcome: "retry" | "success" | "failure" | "cancelled";
  status?: number;
  code?: ProviderTransportCode;
  retryDelayMs?: number;
  durationMs: number;
}

export interface ResilientFetchOptions {
  operation: string;
  fetcher?: typeof fetch;
  idempotent?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  jitterRatio?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: ProviderTransportEvent) => void;
}

export type ProviderTransportPolicy = Omit<ResilientFetchOptions, "operation" | "fetcher" | "idempotent">;
export type ProviderResponseConsumer<T> = (response: Response, signal: AbortSignal) => Promise<T> | T;

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND", "MKCOL", "PUT", "DELETE"]);
const NEVER_ABORTED = new AbortController().signal;
const RESPONSE_METADATA = new WeakMap<Response, { attempts: number; retryAfterMs?: number }>();

/**
 * Fetch and consume a provider response while this transport owns the attempt
 * controller.  Consumers must finish reading the body before returning, so a
 * timeout or caller cancellation also reaches a stalled response stream.
 */
export async function resilientFetch<T>(
  url: RequestInfo | URL,
  init: RequestInit,
  options: ResilientFetchOptions,
  consume: ProviderResponseConsumer<T>
): Promise<T> {
  const fetcher = options.fetcher || globalThis.fetch.bind(globalThis);
  const method = (init.method || "GET").toUpperCase();
  const idempotent = options.idempotent ?? IDEMPOTENT_METHODS.has(method);
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
  const now = options.now || Date.now;
  const sleep = options.sleep || abortableSleep;
  const externalSignal = init.signal || undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (externalSignal?.aborted) throw cancelledError(options.operation, attempt, externalSignal.reason);
    const startedAt = now();
    const attemptControl = createAttemptControl(externalSignal, timeoutMs);
    let responseReceived = false;
    let body: ManagedResponseBody | undefined;
    try {
      const fetchedResponse = await fetcher(url, { ...init, signal: attemptControl.signal });
      responseReceived = true;
      const managed = manageResponseBody(fetchedResponse);
      const response = managed.response;
      body = managed.body;
      const durationMs = Math.max(0, now() - startedAt);
      if (TRANSIENT_STATUSES.has(response.status) && idempotent && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now(), options.maxRetryAfterMs ?? 30_000);
        const retryDelayMs = retryAfterMs ?? backoffDelay(attempt, options);
        options.onEvent?.({ operation: options.operation, attempt, outcome: "retry", status: response.status, code: response.status === 429 ? "rate-limited" : "server", retryDelayMs, durationMs });
        cancelBody(body);
        await sleepOrCancel(retryDelayMs, externalSignal, sleep, options.operation, attempt);
        continue;
      }
      RESPONSE_METADATA.set(response, {
        attempts: attempt,
        retryAfterMs: response.status === 429 ? parseRetryAfter(response.headers.get("retry-after"), now(), options.maxRetryAfterMs ?? 30_000) : undefined
      });
      const result = await consume(response, attemptControl.signal);
      // A consumer that only needs headers must not leave a response stream
      // detached from the attempt lifecycle.
      cancelBody(body);
      options.onEvent?.({ operation: options.operation, attempt, outcome: response.ok ? "success" : "failure", status: response.status, durationMs: Math.max(0, now() - startedAt) });
      return result;
    } catch (cause) {
      const durationMs = Math.max(0, now() - startedAt);
      if (externalSignal?.aborted) {
        options.onEvent?.({ operation: options.operation, attempt, outcome: "cancelled", code: "cancelled", durationMs });
        throw cancelledError(options.operation, attempt, externalSignal.reason);
      }
      if (cause instanceof ProviderTransportError) throw cause;
      // A response consumer may reject for a semantic reason (for example a
      // bounded-body limit). Only tagged body stream interruptions and
      // transport aborts are retried/classified.
      if (responseReceived && !attemptControl.timedOut() && !(cause instanceof ProviderBodyReadNetworkError)) throw cause;
      const code: ProviderTransportCode = attemptControl.timedOut() ? "timeout" : "network";
      const retryable = idempotent;
      if (retryable && attempt < maxAttempts) {
        const retryDelayMs = backoffDelay(attempt, options);
        options.onEvent?.({ operation: options.operation, attempt, outcome: "retry", code, retryDelayMs, durationMs });
        await sleepOrCancel(retryDelayMs, externalSignal, sleep, options.operation, attempt);
        continue;
      }
      options.onEvent?.({ operation: options.operation, attempt, outcome: "failure", code, durationMs });
      throw new ProviderTransportError(code, code === "timeout" ? `${options.operation} 请求超时。` : `${options.operation} 网络请求失败。`, {
        retryable,
        operation: options.operation,
        attempts: attempt
      });
    } finally {
      cancelBody(body);
      attemptControl.dispose();
    }
  }
  throw new ProviderTransportError("network", `${options.operation} 网络请求失败。`, { retryable: idempotent, operation: options.operation, attempts: maxAttempts });
}

interface ManagedResponseBody {
  cancel(): Promise<void>;
}

function manageResponseBody(response: Response): { response: Response; body?: ManagedResponseBody } {
  if (!response.body) return { response };
  const source = response.body.getReader();
  let ended = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await source.read();
        if (result.done) {
          ended = true;
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (cause) {
        ended = true;
        controller.error(cause);
      }
    },
    async cancel(reason) {
      if (ended || cancelled) return;
      cancelled = true;
      try {
        await source.cancel(reason);
      } finally {
        ended = true;
        source.releaseLock();
      }
    }
  });
  return {
    response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }),
    body: {
      async cancel() {
        if (ended || cancelled) return;
        cancelled = true;
        try {
          await source.cancel();
        } finally {
          ended = true;
          source.releaseLock();
        }
      }
    }
  };
}

function cancelBody(body: ManagedResponseBody | undefined): void {
  // Cancellation is cleanup only: it must neither replace the consumer error
  // nor create an unhandled rejection when a provider stream rejects cancel.
  void body?.cancel().catch(() => undefined);
}

export function providerHttpError(prefix: string, response: Response): ProviderTransportError {
  const metadata = RESPONSE_METADATA.get(response) || { attempts: 1 };
  const classification = classifyHttpStatus(response.status);
  void response.body?.cancel().catch(() => undefined);
  return new ProviderTransportError(classification.code, `${prefix}（HTTP ${response.status}）。`, {
    retryable: classification.retryable,
    operation: prefix,
    attempts: metadata.attempts,
    status: response.status,
    retryAfterMs: metadata.retryAfterMs
  });
}

function classifyHttpStatus(status: number): { code: ProviderTransportCode; retryable: boolean } {
  if (status === 401) return { code: "authentication", retryable: false };
  if (status === 403) return { code: "permission", retryable: false };
  if (status === 404) return { code: "not-found", retryable: false };
  if (status === 409 || status === 412) return { code: "conflict", retryable: false };
  if (status === 429) return { code: "rate-limited", retryable: true };
  if (TRANSIENT_STATUSES.has(status)) return { code: "server", retryable: true };
  return { code: "client", retryable: false };
}

function createAttemptControl(externalSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
  const controller = new AbortController();
  let timeoutReached = false;
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) externalSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  };
}

function backoffDelay(attempt: number, options: ResilientFetchOptions): number {
  const base = Math.max(0, options.baseDelayMs ?? 300);
  const capped = Math.min(options.maxDelayMs ?? 4_000, base * (2 ** Math.max(0, attempt - 1)));
  const jitterRatio = Math.max(0, Math.min(1, options.jitterRatio ?? 0.2));
  const random = options.random || Math.random;
  return Math.max(0, Math.round(capped * (1 - jitterRatio + random() * jitterRatio * 2)));
}

function parseRetryAfter(value: string | null, now: number, maximum: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return Math.min(maximum, Math.round(delay));
}

async function sleepOrCancel(
  delayMs: number,
  signal: AbortSignal | undefined,
  sleep: (delayMs: number, signal: AbortSignal) => Promise<void>,
  operation: string,
  attempt: number
): Promise<void> {
  try {
    await sleep(delayMs, signal || NEVER_ABORTED);
  } catch (cause) {
    if (signal?.aborted) throw cancelledError(operation, attempt, cause);
    throw cause;
  }
  if (signal?.aborted) throw cancelledError(operation, attempt, signal.reason);
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelledError(operation: string, attempt: number, _cause?: unknown): ProviderTransportError {
  return new ProviderTransportError("cancelled", `${operation} 已取消。`, { retryable: false, operation, attempts: attempt });
}
