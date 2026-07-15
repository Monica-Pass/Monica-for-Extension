import { describe, expect, it, vi } from "vitest";
import { ProviderTransportError, resilientFetch } from "./provider-transport";

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
    });

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
    });

    expect(delays).toEqual([2_000]);
  });

  it.each([401, 403, 409, 412])("does not retry non-transient HTTP %s", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("do not retry", { status }));
    const response = await resilientFetch("https://provider.example/item", { method: "GET" }, { operation: "read", fetcher, maxAttempts: 3 });
    expect(response.status).toBe(status);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unsafe write after a network failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("network failed with token=secret-token"));
    await expect(resilientFetch("https://provider.example/ciphers", { method: "POST" }, { operation: "create", fetcher, maxAttempts: 3, idempotent: false }))
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
    });

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
    })).rejects.toEqual(expect.objectContaining({ name: "ProviderTransportError", code: "timeout", retryable: true, message: "sync 请求超时。" }));
  });

  it("uses a stable typed error contract", () => {
    const error = new ProviderTransportError("network", "同步网络不可用。", { retryable: true, operation: "sync", attempts: 2 });
    expect(error).toMatchObject({ name: "ProviderTransportError", code: "network", retryable: true, operation: "sync", attempts: 2 });
  });
});
