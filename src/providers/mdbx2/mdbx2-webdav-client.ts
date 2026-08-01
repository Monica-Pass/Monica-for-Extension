import { createSHA256 } from "hash-wasm";
import { bytesToBase64 } from "../../security/encoding";
import { ProviderBodyReadNetworkError, readBoundedResponseText } from "../bounded-body";
import {
  ProviderTransportError,
  providerHttpError,
  resilientFetch,
  type ProviderResponseConsumer,
  type ProviderTransportPolicy
} from "../provider-transport";
import { normalizeServerUrl, type WebDavCredentials } from "../webdav/webdav-client";
import { MDBX2_MAX_BINARY_CHUNK_BYTES, MDBX2_MAX_INBOUND_FILE_BYTES } from "./native-contract";
import { mdbx2ParentPath, normalizeMdbx2RemotePath } from "./mdbx2-sync-paths";

export interface Mdbx2WebDavObject {
  path: string;
  isDirectory: boolean;
  sizeBytes?: number;
  etag?: string;
  lastModified?: string;
}

export interface Mdbx2WebDavDownloadResult {
  path: string;
  sizeBytes: number;
  sha256: string;
  etag?: string;
  lastModified?: string;
}

export interface Mdbx2WebDavWriteOptions {
  mode: "create-only" | "replace" | "if-match";
  expectedEtag?: string;
}

export interface Mdbx2WebDavLimits {
  maxMultiStatusBytes: number;
  maxObjectBytes: number;
  downloadChunkBytes: number;
}

export const DEFAULT_MDBX2_WEBDAV_LIMITS: Readonly<Mdbx2WebDavLimits> = Object.freeze({
  maxMultiStatusBytes: 2 * 1024 * 1024,
  maxObjectBytes: MDBX2_MAX_INBOUND_FILE_BYTES,
  downloadChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES
});

export class Mdbx2WebDavClient {
  constructor(
    private readonly credentials: WebDavCredentials,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly transportPolicy: ProviderTransportPolicy = {},
    private readonly limitOverrides: Partial<Mdbx2WebDavLimits> = {}
  ) {}

  async testConnection(signal?: AbortSignal): Promise<void> {
    const url = normalizeServerUrl(this.credentials.baseUrl);
    await this.request(url, {
      method: "PROPFIND",
      headers: { Depth: "0" },
      signal
    }, "MDBX2 WebDAV 连接", async (response) => {
      if (!response.ok) throw providerHttpError("MDBX2 WebDAV 连接失败", response);
    });
  }

  async stat(path: string, signal?: AbortSignal): Promise<Mdbx2WebDavObject | undefined> {
    const normalized = normalizeMdbx2RemotePath(path);
    const result = await this.propfind(normalized, "0", signal);
    if (result.status === 404) return undefined;
    if (result.status !== 200 && result.status !== 207) throw result.error;
    return parseMdbx2MultiStatus(result.body, this.credentials.baseUrl)
      .find((object) => object.path === normalized);
  }

  async list(path: string, signal?: AbortSignal): Promise<Mdbx2WebDavObject[]> {
    const normalized = normalizeMdbx2RemotePath(path);
    const result = await this.propfind(normalized, "1", signal);
    if (result.status === 404) return [];
    if (result.status !== 200 && result.status !== 207) throw result.error;
    const prefix = `${normalized}/`;
    return parseMdbx2MultiStatus(result.body, this.credentials.baseUrl)
      .filter((object) => object.path.startsWith(prefix) && !object.path.slice(prefix.length).includes("/"))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async ensureDirectory(path: string, signal?: AbortSignal): Promise<void> {
    const normalized = normalizeMdbx2RemotePath(path);
    const components = normalized.split("/");
    let current = "";
    for (const component of components) {
      current = current ? `${current}/${component}` : component;
      const existing = await this.stat(current, signal);
      if (existing) {
        if (!existing.isDirectory) throw new Error(`MDBX2 WebDAV 位置已被文件占用: ${current}`);
        continue;
      }
      const url = this.objectUrl(current);
      const status = await this.request(url, { method: "MKCOL", signal }, "MDBX2 WebDAV 创建目录", async (response) => {
        if (response.ok || response.status === 405 || response.status === 409) return response.status;
        throw providerHttpError(`MDBX2 WebDAV 创建目录 ${current} 失败`, response);
      });
      if (status === 405 || status === 409) {
        const raced = await this.stat(current, signal);
        if (!raced?.isDirectory) throw new Error(`MDBX2 WebDAV 目录创建发生冲突: ${current}`);
      }
    }
  }

  async download(
    path: string,
    maximumBytes: number,
    onChunk: (chunk: Uint8Array, offset: number) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<Mdbx2WebDavDownloadResult> {
    const normalized = normalizeMdbx2RemotePath(path);
    const limits = this.limits();
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > limits.maxObjectBytes) {
      throw new Error("MDBX2 WebDAV 下载上限无效。");
    }
    return this.request(this.objectUrl(normalized), { method: "GET", signal }, `MDBX2 WebDAV 下载 ${normalized}`, async (response, requestSignal) => {
      if (!response.ok) throw providerHttpError(`MDBX2 WebDAV 下载 ${normalized} 失败`, response);
      const declared = contentLength(response.headers.get("content-length"), maximumBytes, "MDBX2 WebDAV 下载");
      const hasher = await createSHA256();
      hasher.init();
      let offset = 0;
      let received = 0;
      let pending = new Uint8Array(limits.downloadChunkBytes);
      let pendingLength = 0;
      const emitPending = async () => {
        if (!pendingLength) return;
        const chunk = pending.slice(0, pendingLength);
        hasher.update(chunk);
        await onChunk(chunk, offset);
        offset += chunk.length;
        pending = new Uint8Array(limits.downloadChunkBytes);
        pendingLength = 0;
      };
      const consume = async (source: Uint8Array) => {
        received += source.length;
        if (!Number.isSafeInteger(received) || received > maximumBytes) throw new Error("MDBX2 WebDAV 下载超过安全上限。");
        let start = 0;
        while (start < source.length) {
          requestSignal.throwIfAborted();
          const count = Math.min(source.length - start, limits.downloadChunkBytes - pendingLength);
          pending.set(source.subarray(start, start + count), pendingLength);
          pendingLength += count;
          start += count;
          if (pendingLength === limits.downloadChunkBytes) await emitPending();
        }
      };
      if (!response.body) {
        await consume(new Uint8Array(await response.arrayBuffer()));
      } else {
        const reader = response.body.getReader();
        const onAbort = () => { void reader.cancel(requestSignal.reason).catch(() => undefined); };
        requestSignal.addEventListener("abort", onAbort, { once: true });
        try {
          while (true) {
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
              result = await reader.read();
            } catch (cause) {
              if (requestSignal.aborted) throw cause;
              throw new ProviderBodyReadNetworkError(cause);
            }
            if (result.done) break;
            await consume(result.value);
          }
        } finally {
          requestSignal.removeEventListener("abort", onAbort);
          reader.releaseLock();
        }
      }
      await emitPending();
      requestSignal.throwIfAborted();
      if (offset === 0 || offset !== received || declared !== undefined && declared !== offset) throw new Error("MDBX2 WebDAV 下载大小与元数据不一致。");
      return {
        path: normalized,
        sizeBytes: offset,
        sha256: hasher.digest("hex"),
        etag: optionalHeader(response.headers.get("etag")),
        lastModified: optionalHeader(response.headers.get("last-modified"))
      };
    }, { maxAttempts: 1 });
  }

  async put(path: string, body: Blob, options: Mdbx2WebDavWriteOptions, signal?: AbortSignal): Promise<Mdbx2WebDavObject> {
    const normalized = normalizeMdbx2RemotePath(path);
    const limits = this.limits();
    if (!(body instanceof Blob) || body.size < 1 || body.size > limits.maxObjectBytes) throw new Error("MDBX2 WebDAV 上传大小超过安全上限。");
    if (options.mode === "if-match" && !options.expectedEtag?.trim()) throw new Error("MDBX2 WebDAV 条件更新缺少 ETag。");
    const parent = mdbx2ParentPath(normalized);
    if (parent) await this.ensureDirectory(parent, signal);
    const headers = new Headers({ "Content-Type": "application/octet-stream" });
    if (options.mode === "create-only") headers.set("If-None-Match", "*");
    if (options.mode === "if-match") headers.set("If-Match", options.expectedEtag!.trim());
    const responseMetadata = await this.request(this.objectUrl(normalized), {
      method: "PUT",
      headers,
      body,
      signal
    }, `MDBX2 WebDAV 上传 ${normalized}`, async (response) => {
      if (!response.ok) throw providerHttpError(`MDBX2 WebDAV 上传 ${normalized} 失败`, response);
      return {
        etag: optionalHeader(response.headers.get("etag")),
        lastModified: optionalHeader(response.headers.get("last-modified"))
      };
    });
    return await this.stat(normalized, signal) || {
      path: normalized,
      isDirectory: false,
      sizeBytes: body.size,
      ...responseMetadata
    };
  }

  async putImmutable(path: string, body: Blob, expectedSha256: string, signal?: AbortSignal): Promise<Mdbx2WebDavObject> {
    const normalized = normalizeMdbx2RemotePath(path);
    const digest = normalizeDigest(expectedSha256);
    const existing = await this.stat(normalized, signal);
    if (existing) return this.requireIdentical(normalized, existing, body.size, digest, signal);
    try {
      return await this.put(normalized, body, { mode: "create-only" }, signal);
    } catch (error) {
      if (!(error instanceof ProviderTransportError) || error.code !== "conflict") throw error;
      const raced = await this.stat(normalized, signal);
      if (!raced) throw error;
      return this.requireIdentical(normalized, raced, body.size, digest, signal);
    }
  }

  private async requireIdentical(
    path: string,
    existing: Mdbx2WebDavObject,
    expectedSize: number,
    expectedSha256: string,
    signal?: AbortSignal
  ): Promise<Mdbx2WebDavObject> {
    if (existing.isDirectory || existing.sizeBytes !== undefined && existing.sizeBytes !== expectedSize) {
      throw new Error(`MDBX2 WebDAV 不可变对象发生内容碰撞: ${path}`);
    }
    const downloaded = await this.download(path, expectedSize, () => undefined, signal);
    if (downloaded.sizeBytes !== expectedSize || downloaded.sha256 !== expectedSha256) {
      throw new Error(`MDBX2 WebDAV 不可变对象发生内容碰撞: ${path}`);
    }
    return { ...existing, sizeBytes: expectedSize, etag: existing.etag || downloaded.etag, lastModified: existing.lastModified || downloaded.lastModified };
  }

  private async propfind(path: string, depth: "0" | "1", signal?: AbortSignal): Promise<{ status: number; body: string; error: Error }> {
    return this.request(this.objectUrl(path), {
      method: "PROPFIND",
      headers: { Depth: depth },
      signal
    }, `MDBX2 WebDAV 读取 ${path}`, async (response, requestSignal) => {
      if (response.status === 404) return { status: 404, body: "", error: providerHttpError(`MDBX2 WebDAV 位置 ${path} 不存在`, response) };
      if (!response.ok) return { status: response.status, body: "", error: providerHttpError(`MDBX2 WebDAV 读取 ${path} 失败`, response) };
      return {
        status: response.status,
        body: await readBoundedResponseText(response, this.limits().maxMultiStatusBytes, "MDBX2 WebDAV Multi-Status", requestSignal),
        error: new Error()
      };
    });
  }

  private objectUrl(path: string): string {
    const base = normalizeServerUrl(this.credentials.baseUrl);
    const encoded = normalizeMdbx2RemotePath(path).split("/").map(encodeURIComponent).join("/");
    const target = `${base.replace(/\/$/, "")}/${encoded}`;
    assertProviderBoundary(target, base);
    return target;
  }

  private request<T>(
    url: string,
    init: RequestInit,
    operation: string,
    consume: ProviderResponseConsumer<T>,
    policyOverrides: ProviderTransportPolicy = {}
  ): Promise<T> {
    const base = normalizeServerUrl(this.credentials.baseUrl);
    assertProviderBoundary(url, base);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Basic ${bytesToBase64(new TextEncoder().encode(`${this.credentials.username}:${this.credentials.password}`))}`);
    headers.set("Accept", "*/*");
    return resilientFetch(url, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    }, {
      ...this.transportPolicy,
      ...policyOverrides,
      operation,
      fetcher: this.fetcher
    }, consume);
  }

  private limits(): Mdbx2WebDavLimits {
    const limits = { ...DEFAULT_MDBX2_WEBDAV_LIMITS, ...this.limitOverrides };
    if (!Number.isSafeInteger(limits.maxMultiStatusBytes) || limits.maxMultiStatusBytes < 1 || limits.maxMultiStatusBytes > 16 * 1024 * 1024) throw new Error("MDBX2 WebDAV Multi-Status 上限无效。");
    if (!Number.isSafeInteger(limits.maxObjectBytes) || limits.maxObjectBytes < 1 || limits.maxObjectBytes > MDBX2_MAX_INBOUND_FILE_BYTES) throw new Error("MDBX2 WebDAV 对象上限无效。");
    if (!Number.isSafeInteger(limits.downloadChunkBytes) || limits.downloadChunkBytes < 1 || limits.downloadChunkBytes > MDBX2_MAX_BINARY_CHUNK_BYTES) throw new Error("MDBX2 WebDAV 下载分块上限无效。");
    return limits;
  }
}

export function parseMdbx2MultiStatus(xml: string, configuredBaseUrl: string): Mdbx2WebDavObject[] {
  const responses = xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) || [];
  return responses.flatMap((block): Mdbx2WebDavObject[] => {
    const href = xmlValue(block, "href");
    if (!href) return [];
    const path = remotePathFromHref(href, configuredBaseUrl);
    if (!path) return [];
    const isDirectory = /<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(block);
    const sizeBytes = isDirectory ? undefined : optionalSize(xmlValue(block, "getcontentlength"));
    return [{
      path,
      isDirectory,
      sizeBytes,
      etag: optionalText(xmlValue(block, "getetag")),
      lastModified: optionalText(xmlValue(block, "getlastmodified"))
    }];
  });
}

function remotePathFromHref(href: string, configuredBaseUrl: string): string | undefined {
  const base = new URL(normalizeServerUrl(configuredBaseUrl));
  const resolved = new URL(href, `${base.toString().replace(/\/$/, "")}/`);
  if (resolved.origin !== base.origin || resolved.username || resolved.password || resolved.search || resolved.hash) {
    throw new Error("MDBX2 WebDAV Multi-Status 越过 Provider 安全边界。");
  }
  const basePath = base.pathname.replace(/\/$/, "");
  if (resolved.pathname === basePath || resolved.pathname === `${basePath}/`) return undefined;
  const prefix = `${basePath}/`;
  if (!resolved.pathname.startsWith(prefix)) throw new Error("MDBX2 WebDAV Multi-Status 越过 Provider 目录边界。");
  const components = resolved.pathname.slice(prefix.length).replace(/\/$/, "").split("/");
  if (!components.length) return undefined;
  const decoded = components.map((component) => {
    let value: string;
    try { value = decodeURIComponent(component); } catch { throw new Error("MDBX2 WebDAV 返回了无效转义位置。"); }
    if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) throw new Error("MDBX2 WebDAV 返回了不安全位置。");
    return value;
  });
  return normalizeMdbx2RemotePath(decoded.join("/"));
}

function assertProviderBoundary(target: string, configuredBaseUrl: string): void {
  const base = new URL(normalizeServerUrl(configuredBaseUrl));
  const url = new URL(target);
  const basePath = base.pathname.replace(/\/$/, "");
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))
  ) {
    throw new Error("MDBX2 WebDAV 请求越过 Provider 安全边界。");
  }
}

function xmlValue(block: string, localName: string): string {
  const match = block.match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${localName}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

function optionalText(value: string): string | undefined {
  return value.trim() || undefined;
}

function optionalHeader(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function optionalSize(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MDBX2_MAX_INBOUND_FILE_BYTES) throw new Error("MDBX2 WebDAV 返回了无效对象大小。");
  return parsed;
}

function contentLength(value: string | null, maximum: number, label: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${label}超过安全上限。`);
  return parsed;
}

function normalizeDigest(value: string): string {
  const digest = value.toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("MDBX2 WebDAV 对象摘要无效。");
  return digest;
}
