import { websiteFaviconUrl, websiteOrigin } from "../core/website-icon";
import { bytesToBase64 } from "../security/encoding";

const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_CACHE_ENTRIES = 128;
const MAX_CONCURRENT = 4;
const REQUEST_TIMEOUT_MS = 3000;

interface IconTask {
  origin: string;
  controller: AbortController;
  promise: Promise<string>;
  resolve: (icon: string) => void;
  users: number;
  settled: boolean;
}

/** Per-page, bounded memory cache. No domains or icons are written to vault/storage. */
export class WebsiteIconCache {
  private readonly cache = new Map<string, { icon: string; expires: number }>();
  private readonly pending = new Map<string, IconTask>();
  private readonly queue: IconTask[] = [];
  private active = 0;
  private defaultIcon?: Promise<string>;

  load(rawOrigin: string, signal: AbortSignal): Promise<string> {
    const origin = websiteOrigin(rawOrigin);
    if (!origin || signal.aborted) return Promise.resolve("");
    const cached = this.cache.get(origin);
    if (cached && cached.expires > Date.now()) {
      this.cache.delete(origin);
      this.cache.set(origin, cached);
      return Promise.resolve(cached.icon);
    }
    this.cache.delete(origin);
    let task = this.pending.get(origin);
    if (!task) {
      let resolve!: (icon: string) => void;
      const promise = new Promise<string>(done => { resolve = done; });
      task = { origin, controller: new AbortController(), promise, resolve, users: 0, settled: false };
      this.pending.set(origin, task);
      this.queue.push(task);
    }
    const current = task;
    current.users++;
    const result = new Promise<string>(resolve => {
      let finished = false;
      const finish = (icon: string) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        current.users--;
        if (!current.users && !current.settled) {
          current.controller.abort();
          if (this.pending.get(origin) === current) this.pending.delete(origin);
        }
        resolve(icon);
      };
      const abort = () => finish("");
      signal.addEventListener("abort", abort, { once: true });
      void current.promise.then(finish);
    });
    this.pump();
    return result;
  }

  clear(): void {
    this.cache.clear();
    this.defaultIcon = undefined;
    for (const task of this.pending.values()) {
      task.controller.abort();
      task.resolve("");
    }
    this.pending.clear();
    this.queue.length = 0;
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const task = this.queue.shift()!;
      if (task.controller.signal.aborted) {
        task.resolve("");
        continue;
      }
      this.active++;
      void this.resolveIcon(task).catch(() => "").then(icon => {
        task.settled = true;
        if (!task.controller.signal.aborted) {
          // Briefly cache misses too, so unavailable sites are not retried on every render.
          this.cache.set(task.origin, { icon, expires: Date.now() + (icon ? 30 * 60_000 : 2 * 60_000) });
          while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
        }
        if (this.pending.get(task.origin) === task) this.pending.delete(task.origin);
        task.resolve(task.controller.signal.aborted ? "" : icon);
        this.active--;
        this.pump();
      });
    }
  }

  private async resolveIcon(task: IconTask): Promise<string> {
    const signal = task.controller.signal;
    const nativeUrl = browserFaviconUrl(task.origin);
    if (nativeUrl) {
      // Chromium returns a successful generic image for cache misses. Compare it
      // with the local default rather than mistaking it for a website's own icon.
      this.defaultIcon ??= readImage(browserFaviconUrl("about:blank"), new AbortController().signal);
      const [icon, fallback] = await Promise.all([readImage(nativeUrl, signal), this.defaultIcon]);
      if (signal.aborted) return "";
      if (icon && icon !== fallback) return icon;
    }
    const directUrl = websiteFaviconUrl(task.origin);
    return !signal.aborted && directUrl ? readImage(directUrl, signal) : "";
  }
}

function browserFaviconUrl(pageUrl: string): string {
  try {
    if (!globalThis.chrome?.runtime?.id) return "";
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", "32");
    url.searchParams.set("fallbackToHost", "1");
    return url.href;
  } catch {
    return "";
  }
}

async function readImage(url: string, parentSignal: AbortSignal): Promise<string> {
  if (!url || parentSignal.aborted) return "";
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
      cache: "default", signal: controller.signal
    });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
      await response.body?.cancel();
      return "";
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel();
          return "";
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (controller.signal.aborted) return "";
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const type = imageType(bytes, response.headers.get("content-type") || "");
    return type ? `data:${type};base64,${bytesToBase64(bytes)}` : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}

function imageType(bytes: Uint8Array, contentType: string): string {
  if (bytes.length < 6) return "";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const start = new TextDecoder().decode(bytes.subarray(0, 512));
  if (/^GIF8[79]a/.test(start)) return "image/gif";
  if (/^RIFF[\s\S]{4}WEBP/.test(start)) return "image/webp";
  // SVG is rendered only as an inert <img>, never inserted into the document.
  if (contentType.split(";", 1)[0].trim().toLowerCase() === "image/svg+xml" && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg\b/i.test(start)) return "image/svg+xml";
  return "";
}

export const websiteIconCache = new WebsiteIconCache();
