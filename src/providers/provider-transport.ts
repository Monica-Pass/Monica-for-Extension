export type ProviderTransportCode = "cancelled" | "timeout" | "network" | "rate-limited" | "server";

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

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND", "MKCOL", "PUT", "DELETE"]);
const NEVER_ABORTED = new AbortController().signal;

export async function resilientFetch(url: RequestInfo | URL, init: RequestInit, options: ResilientFetchOptions): Promise<Response> {
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
    try {
      const response = await fetcher(url, { ...init, signal: attemptControl.signal });
      attemptControl.dispose();
      const durationMs = Math.max(0, now() - startedAt);
      if (TRANSIENT_STATUSES.has(response.status) && idempotent && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now(), options.maxRetryAfterMs ?? 30_000);
        const retryDelayMs = retryAfterMs ?? backoffDelay(attempt, options);
        options.onEvent?.({ operation: options.operation, attempt, outcome: "retry", status: response.status, code: response.status === 429 ? "rate-limited" : "server", retryDelayMs, durationMs });
        await response.body?.cancel().catch(() => undefined);
        await sleepOrCancel(retryDelayMs, externalSignal, sleep, options.operation, attempt);
        continue;
      }
      options.onEvent?.({ operation: options.operation, attempt, outcome: response.ok ? "success" : "failure", status: response.status, durationMs });
      return response;
    } catch (cause) {
      attemptControl.dispose();
      const durationMs = Math.max(0, now() - startedAt);
      if (externalSignal?.aborted) {
        options.onEvent?.({ operation: options.operation, attempt, outcome: "cancelled", code: "cancelled", durationMs });
        throw cancelledError(options.operation, attempt, externalSignal.reason);
      }
      if (cause instanceof ProviderTransportError) throw cause;
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
    }
  }
  throw new ProviderTransportError("network", `${options.operation} 网络请求失败。`, { retryable: idempotent, operation: options.operation, attempts: maxAttempts });
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
