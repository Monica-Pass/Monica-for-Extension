import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebsiteIconCache } from "./website-icon-cache";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const defaultPng = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
const response = (bytes = png) => new Response(bytes, { headers: { "content-type": "image/png" } });
const signal = () => new AbortController().signal;
let cache: WebsiteIconCache;

beforeEach(() => {
  cache = new WebsiteIconCache();
  vi.stubGlobal("chrome", undefined);
});
afterEach(() => {
  cache.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function nativeChrome() {
  vi.stubGlobal("chrome", { runtime: { id: "synthetic", getURL: (path: string) => `chrome-extension://synthetic${path}` } });
}

describe("website icon loading", () => {
  it("uses the browser cache without contacting the website or an icon service", async () => {
    nativeChrome();
    const fetcher = vi.fn(async (url: string) => response(new URL(url).searchParams.get("pageUrl") === "about:blank" ? defaultPng : png));
    vi.stubGlobal("fetch", fetcher);
    const icon = await cache.load("https://user:secret@example.com/login?token=secret", signal());
    expect(icon).toMatch(/^data:image\/png;base64,/);
    expect(await cache.load("https://example.com/another", signal())).toBe(icon);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url] of fetcher.mock.calls) {
      expect(url).toMatch(/^chrome-extension:\/\/synthetic\/_favicon\//);
      expect(new URL(url).searchParams.get("fallbackToHost")).toBe("1");
      expect(url).not.toContain("secret");
    }
  });

  it("recognizes the browser's generic fallback and fetches only favicon.ico without credentials or redirects", async () => {
    nativeChrome();
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => response(url.startsWith("chrome-extension:") ? defaultPng : png));
    vi.stubGlobal("fetch", fetcher);
    expect(await cache.load("https://example.com/login?token=private", signal())).toContain(btoa(String.fromCharCode(...png)));
    expect(fetcher).toHaveBeenCalledWith("https://example.com/favicon.ico", expect.objectContaining({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" }));
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("https:"))).toHaveLength(1);
  });

  it("uses only native icons for local network hosts, IPs and HTTP sites", async () => {
    nativeChrome();
    const fetcher = vi.fn(async (_url: string) => response(defaultPng));
    vi.stubGlobal("fetch", fetcher);
    expect(await cache.load("http://127.0.0.1:1234/login", signal())).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(call => String(call[0]).startsWith("chrome-extension:"))).toBe(true);
  });

  it("caches errors briefly and retries after the miss expires", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await cache.load("https://example.com", signal())).toBe("");
    expect(await cache.load("https://example.com", signal())).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_001);
    await cache.load("https://example.com", signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => new Response("<html>sign in</html>", { headers: { "content-type": "image/png" } }),
    () => new Response(png, { headers: { "content-length": "999999999", "content-type": "image/png" } }),
    () => new Response(new Uint8Array(256 * 1024 + 1), { headers: { "content-type": "image/png" } })
  ])("rejects non-images and oversized responses", async makeResponse => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse()));
    expect(await cache.load("https://example.com", signal())).toBe("");
  });

  it("shares in-flight work while allowing individual subscribers to leave", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      finish = resolve;
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const first = new AbortController();
    const firstResult = cache.load("https://example.com", first.signal);
    const secondResult = cache.load("https://example.com", signal());
    first.abort();
    expect(await firstResult).toBe("");
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(false);
    finish(response());
    expect(await secondResult).toMatch(/^data:image\/png/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("limits concurrency and never starts a queued request after its row disappears", async () => {
    const finish: Array<(response: Response) => void> = [];
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      finish.push(resolve);
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const requests = controllers.map((controller, index) => cache.load(`https://site${index}.example.com`, controller.signal));
    expect(fetcher).toHaveBeenCalledTimes(4);
    controllers[4].abort();
    finish[0](response());
    await requests[0];
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.some(([url]) => url.includes("site4."))).toBe(false);
    controllers.forEach(controller => controller.abort());
    await Promise.all(requests);
  });

  it("times out a stalled response and clears both cached and pending requests on lock", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const stalled = cache.load("https://example.com", signal());
    await vi.advanceTimersByTimeAsync(3000);
    expect(await stalled).toBe("");
    cache.clear();
    const pending = cache.load("https://example.com", signal());
    cache.clear();
    expect(await pending).toBe("");
    expect(fetcher.mock.calls[1][1].signal?.aborted).toBe(true);
    fetcher.mockImplementation(async () => response());
    expect(await cache.load("https://example.com", signal())).toMatch(/^data:image\/png/);
  });

  it("evicts old domains rather than retaining the entire vault in memory", async () => {
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetcher);
    for (let index = 0; index < 129; index++) await cache.load(`https://site${index}.example.com`, signal());
    await cache.load("https://site128.example.com", signal());
    expect(fetcher).toHaveBeenCalledTimes(129);
    await cache.load("https://site0.example.com", signal());
    expect(fetcher).toHaveBeenCalledTimes(130);
  });
});
