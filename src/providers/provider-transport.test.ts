import { describe, expect, it, vi } from "vitest";
import { ProviderTransportError, resilientFetch } from "./provider-transport";
import { readBoundedResponseBytes } from "./bounded-body";

describe("provider resilient transport", () => {
  it("retries bounded idempotent transient responses with exponential backoff", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 502 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const delays: number[] = [];

    const response = await resilientFetch("https://provider.example/sync", { method: "GET" }, {
      operation: "sync",
      fetcher,
      maxAttempts: 3,
      baseDelayMs: 100,
      jitterRatio: 0,
      sleep: async (delay) => { delays.push(delay); }
    }, async (response) => response);

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it("honors a bounded Retry-After response", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const delays: number[] = [];

    await resilientFetch("https://provider.example/sync", { method: "PROPFIND" }, {
      operation: "list",
      fetcher,
      maxAttempts: 2,
      maxRetryAfterMs: 5_000,
      sleep: async (delay) => { delays.push(delay); }
    }, async (response) => response);

    expect(delays).toEqual([2_000]);
  });

  it.each([401, 403, 409, 412])("does not retry non-transient HTTP %s", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("do not retry", { status }));
    const response = await resilientFetch("https://provider.example/item", { method: "GET" }, { operation: "read", fetcher, maxAttempts: 3 }, async (value) => value);
    expect(response.status).toBe(status);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("normalizes a browser-provided stream on a null-body response status", async () => {
    let cancelled = false;
    const malformed = new Response(null, { status: 204 });
    Object.defineProperty(malformed, "body", {
      configurable: true,
      value: new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } })
    });

    const response = await resilientFetch("https://provider.example/item", { method: "DELETE" }, {
      operation: "delete",
      fetcher: vi.fn().mockResolvedValue(malformed),
      maxAttempts: 1
    }, async (value) => value);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("does not retry an unsafe write after a network failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("network failed with token=secret-token"));
    await expect(resilientFetch("https://provider.example/ciphers", { method: "POST" }, { operation: "create", fetcher, maxAttempts: 3, idempotent: false }, async (response) => response))
      .rejects.toMatchObject({ name: "ProviderTransportError", code: "network", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts immediately while waiting to retry", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(new Response("temporary", { status: 503 }));
    const pending = resilientFetch("https://provider.example/sync", { method: "GET", signal: controller.signal }, {
      operation: "sync",
      fetcher,
      maxAttempts: 3,
      sleep: async (_delay, signal) => {
        controller.abort();
        if (signal.aborted) throw signal.reason;
      }
    }, async (response) => response);

    await expect(pending).rejects.toMatchObject({ name: "ProviderTransportError", code: "cancelled", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies a bounded request timeout without exposing the fetch error", async () => {
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    await expect(resilientFetch("https://provider.example/hang", { method: "GET" }, {
      operation: "sync",
      fetcher: fetcher as typeof fetch,
      maxAttempts: 1,
      timeoutMs: 5
    }, async (response) => response)).rejects.toEqual(expect.objectContaining({ name: "ProviderTransportError", code: "timeout", retryable: true, message: "sync 请求超时。" }));
  });

  it("uses a stable typed error contract", () => {
    const error = new ProviderTransportError("network", "同步网络不可用。", { retryable: true, operation: "sync", attempts: 2 });
    expect(error).toMatchObject({ name: "ProviderTransportError", code: "network", retryable: true, operation: "sync", attempts: 2 });
  });

  it("times out after response headers when the body never completes", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));

    await expect(resilientFetch("https://provider.example/stalled", { method: "GET" }, {
      operation: "download", fetcher, maxAttempts: 1, timeoutMs: 5
    }, async (response, signal) => readBoundedResponseBytes(response, 1024, "下载", signal)))
      .rejects.toMatchObject({ code: "timeout" });
    expect(cancelled).toBe(true);
  });

  it("cancels the body reader while it is being read", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const fetcher = vi.fn().mockResolvedValue(new Response(body));
    const pending = resilientFetch("https://provider.example/download", { method: "GET", signal: controller.signal }, {
      operation: "download", fetcher, maxAttempts: 1, timeoutMs: 1_000
    }, async (response, signal) => readBoundedResponseBytes(response, 1024, "下载", signal));
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelled).toBe(true);
  });

  it("retries an idempotent request when its first response body is interrupted", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new TypeError("connection reset")); }
      })))
      .mockResolvedValueOnce(new Response("recovered"));

    await expect(resilientFetch("https://provider.example/download", { method: "GET" }, {
      operation: "download", fetcher, maxAttempts: 2, baseDelayMs: 0, jitterRatio: 0
    }, (response, signal) => readBoundedResponseBytes(response, 1024, "下载", signal)))
      .resolves.toEqual(new TextEncoder().encode("recovered"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("classifies an interrupted non-idempotent response body as a non-retryable network error", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new TypeError("connection reset")); }
    })));

    await expect(resilientFetch("https://provider.example/ciphers", { method: "POST" }, {
      operation: "create", fetcher, maxAttempts: 3, idempotent: false
    }, (response, signal) => readBoundedResponseBytes(response, 1024, "响应", signal)))
      .rejects.toMatchObject({ name: "ProviderTransportError", code: "network", retryable: false, attempts: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels an unread body when the consumer throws before reading", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const failure = new Error("consumer failed");

    await expect(resilientFetch("https://provider.example/headers", { method: "GET" }, {
      operation: "headers", fetcher: vi.fn().mockResolvedValue(new Response(body))
    }, () => { throw failure; })).rejects.toBe(failure);
    expect(cancelled).toBe(true);
  });

  it("cancels a partially read body when the consumer throws", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel: () => { cancelled = true; }
    });
    const failure = new Error("consumer failed");

    await expect(resilientFetch("https://provider.example/partial", { method: "GET" }, {
      operation: "partial", fetcher: vi.fn().mockResolvedValue(new Response(body))
    }, async (response) => {
      await response.body?.getReader().read();
      throw failure;
    })).rejects.toBe(failure);
    expect(cancelled).toBe(true);
  });

  it("suppresses body cancellation rejection while preserving the consumer error", async () => {
    const failure = new Error("consumer failed");
    const body = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("cancel failed"))
    });

    await expect(resilientFetch("https://provider.example/cancel", { method: "GET" }, {
      operation: "cancel", fetcher: vi.fn().mockResolvedValue(new Response(body))
    }, () => { throw failure; })).rejects.toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
