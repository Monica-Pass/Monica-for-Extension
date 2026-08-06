import { bytesToBase64 } from "../../security/encoding";
import { readBoundedResponseBytes, readBoundedResponseText } from "../bounded-body";
import {
  ProviderTransportError,
  providerHttpError,
  resilientFetch,
  type ProviderResponseConsumer,
  type ProviderTransportPolicy
} from "../provider-transport";
import { normalizeServerUrl } from "../webdav/webdav-client";

export const KEEPASS_REMOTE_MAX_DATABASE_BYTES = 128 * 1024 * 1024;

export interface KeePassWebDavConfig {
  baseUrl: string;
  username: string;
  password: string;
  remotePath: string;
}

export interface KeePassWebDavFileStat {
  url: string;
  fileName: string;
  etag?: string;
  lastModified?: string;
  sizeBytes?: number;
}

export interface KeePassWebDavSnapshot extends KeePassWebDavFileStat {
  bytes: Uint8Array;
  sha256: string;
}

export interface KeePassWebDavWriteResult extends KeePassWebDavSnapshot {
  alreadyApplied: boolean;
}

export interface KeePassWebDavLimits {
  maxMetadataBytes: number;
  maxDownloadBytes: number;
  maxUploadBytes: number;
}

export const DEFAULT_KEEPASS_WEBDAV_LIMITS: Readonly<KeePassWebDavLimits> = Object.freeze({
  maxMetadataBytes: 512 * 1024,
  maxDownloadBytes: KEEPASS_REMOTE_MAX_DATABASE_BYTES,
  maxUploadBytes: KEEPASS_REMOTE_MAX_DATABASE_BYTES
});

export type KeePassWebDavErrorCode =
  | "remote-path-invalid"
  | "remote-file-missing"
  | "remote-metadata-invalid"
  | "remote-etag-required"
  | "remote-download-too-large"
  | "remote-upload-too-large"
  | "remote-write-verification-failed";

export class KeePassWebDavError extends Error {
  constructor(readonly code: KeePassWebDavErrorCode, message: string) {
    super(message);
    this.name = "KeePassWebDavError";
  }
}

export class KeePassWebDavClient {
  private readonly baseUrl: string;
  private readonly remotePath: string;
  private readonly remoteUrl: string;

  constructor(
    private readonly config: KeePassWebDavConfig,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly transportPolicy: ProviderTransportPolicy = {},
    private readonly limitOverrides: Partial<KeePassWebDavLimits> = {}
  ) {
    this.baseUrl = normalizeServerUrl(config.baseUrl);
    this.remotePath = normalizeKeePassRemotePath(config.remotePath);
    this.remoteUrl = keePassRemoteUrl(this.baseUrl, this.remotePath);
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.request(this.baseUrl, {
      method: "PROPFIND",
      headers: { Depth: "0" },
      signal
    }, "KeePass WebDAV 连接", async (response) => {
      if (!response.ok && response.status !== 207) throw providerHttpError("KeePass WebDAV 连接失败", response);
    });
  }

  async stat(signal?: AbortSignal): Promise<KeePassWebDavFileStat | undefined> {
    return this.request(this.remoteUrl, {
      method: "PROPFIND",
      headers: { Depth: "0" },
      signal
    }, "KeePass WebDAV 读取文件状态", async (response, requestSignal) => {
      if (response.status === 404) return undefined;
      if (!response.ok && response.status !== 207) throw providerHttpError("读取 KeePass WebDAV 文件状态失败", response);
      const xml = await readBoundedResponseText(
        response,
        this.limits().maxMetadataBytes,
        "KeePass WebDAV 文件状态",
        requestSignal
      );
      return parseKeePassWebDavStat(xml, this.remoteUrl, this.remotePath);
    });
  }

  async read(signal?: AbortSignal): Promise<KeePassWebDavSnapshot> {
    const stat = await this.stat(signal);
    if (!stat) throw new KeePassWebDavError("remote-file-missing", "远端 KeePass 文件不存在。");
    const maximum = this.limits().maxDownloadBytes;
    if (stat.sizeBytes !== undefined && (!Number.isSafeInteger(stat.sizeBytes) || stat.sizeBytes < 0 || stat.sizeBytes > maximum)) {
      throw new KeePassWebDavError("remote-download-too-large", "远端 KeePass 文件超过浏览器安全上限。");
    }
    return this.request(this.remoteUrl, { method: "GET", signal }, "KeePass WebDAV 下载", async (response, requestSignal) => {
      if (!response.ok) throw providerHttpError("下载远端 KeePass 文件失败", response);
      const bytes = await readBoundedResponseBytes(response, maximum, "KeePass WebDAV 下载", requestSignal);
      return {
        ...stat,
        etag: normalizedEtag(response.headers.get("etag")) || stat.etag,
        bytes,
        sha256: await sha256Hex(bytes)
      };
    });
  }

  /**
   * `expectedEtag === null` creates a new object with `If-None-Match: *`.
   * Replacing an existing object requires the exact ETag returned by WebDAV.
   */
  async write(bytes: Uint8Array, expectedEtag: string | null, signal?: AbortSignal): Promise<KeePassWebDavWriteResult> {
    if (!(bytes instanceof Uint8Array) || bytes.length > this.limits().maxUploadBytes) {
      throw new KeePassWebDavError("remote-upload-too-large", "KeePass 文件超过 WebDAV 上传安全上限。");
    }
    const headers = new Headers({ "Content-Type": "application/octet-stream" });
    if (expectedEtag === null) {
      headers.set("If-None-Match", "*");
    } else {
      const etag = requireExactEtag(expectedEtag);
      headers.set("If-Match", etag);
    }
    const intendedSha256 = await sha256Hex(bytes);
    try {
      await this.request(this.remoteUrl, {
        method: "PUT",
        headers,
        body: bytes as BodyInit,
        signal
      }, "KeePass WebDAV 条件写入", async (response) => {
        if (!response.ok) throw providerHttpError("写入远端 KeePass 文件失败", response);
      });
    } catch (cause) {
      if (recoverableWriteOutcome(cause)) {
        const reconciled = await this.reconcileWrite(intendedSha256, signal);
        if (reconciled) return { ...reconciled, alreadyApplied: true };
      }
      throw cause;
    }
    const verified = await this.read(signal);
    if (verified.sha256 !== intendedSha256) {
      throw new KeePassWebDavError("remote-write-verification-failed", "远端 KeePass 文件写入后内容校验失败。");
    }
    return { ...verified, alreadyApplied: false };
  }

  private async reconcileWrite(intendedSha256: string, signal?: AbortSignal): Promise<KeePassWebDavSnapshot | undefined> {
    try {
      const current = await this.read(signal);
      return current.sha256 === intendedSha256 ? current : undefined;
    } catch {
      return undefined;
    }
  }

  private request<T>(url: string, init: RequestInit, operation: string, consume: ProviderResponseConsumer<T>): Promise<T> {
    assertKeePassWebDavRequest(url, this.baseUrl, url === this.remoteUrl ? this.remoteUrl : undefined);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Basic ${bytesToBase64(new TextEncoder().encode(`${this.config.username}:${this.config.password}`))}`);
    headers.set("Accept", "*/*");
    return resilientFetch(url, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    }, {
      ...this.transportPolicy,
      operation,
      fetcher: this.fetcher,
      idempotent: true
    }, consume);
  }

  private limits(): KeePassWebDavLimits {
    const limits = { ...DEFAULT_KEEPASS_WEBDAV_LIMITS, ...this.limitOverrides };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`KeePass WebDAV 安全限制无效: ${name}`);
    }
    return limits;
  }
}

export function normalizeKeePassRemotePath(raw: string): string {
  if (typeof raw !== "string") throw remotePathError();
  const normalized = raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) throw remotePathError();
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (!segment) throw remotePathError();
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw remotePathError();
    }
    if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) {
      throw remotePathError();
    }
  }
  return segments.join("/");
}

export function keePassRemoteUrl(baseUrl: string, remotePath: string): string {
  const base = new URL(`${normalizeServerUrl(baseUrl).replace(/\/$/, "")}/`);
  const path = normalizeKeePassRemotePath(remotePath).split("/").map(encodeURIComponent).join("/");
  base.pathname = `${base.pathname.replace(/\/$/, "")}/${path}`;
  return base.toString();
}

export function parseKeePassWebDavStat(xml: string, targetUrl: string, remotePath: string): KeePassWebDavFileStat {
  const target = new URL(targetUrl);
  const pathSegments = normalizeKeePassRemotePath(remotePath).split("/");
  const responses = xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) || [];
  const matching = responses.find((block) => {
    const href = xmlValue(block, "href");
    if (!href) return false;
    const resolved = new URL(href, target);
    return resolved.origin === target.origin && normalizedPathname(resolved.pathname) === normalizedPathname(target.pathname);
  });
  if (!matching) throw new KeePassWebDavError("remote-metadata-invalid", "WebDAV 文件状态缺少目标 KeePass 记录。");
  if (/<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(matching)) {
    throw new KeePassWebDavError("remote-metadata-invalid", "配置的 KeePass 远端位置是目录。");
  }
  const size = optionalNonNegativeInteger(xmlValue(matching, "getcontentlength"));
  return {
    url: target.toString(),
    fileName: pathSegments[pathSegments.length - 1],
    etag: normalizedEtag(xmlValue(matching, "getetag")) || undefined,
    lastModified: xmlValue(matching, "getlastmodified") || undefined,
    sizeBytes: size
  };
}

function assertKeePassWebDavRequest(target: string, configuredBaseUrl: string, exactTarget?: string): void {
  const base = new URL(normalizeServerUrl(configuredBaseUrl));
  const url = new URL(target);
  const basePrefix = `${base.pathname.replace(/\/$/, "")}/`;
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.pathname === base.pathname || url.pathname.startsWith(basePrefix)) ||
    (exactTarget && url.toString() !== exactTarget)
  ) {
    throw new KeePassWebDavError("remote-path-invalid", "请求越过 KeePass WebDAV 安全边界。");
  }
}

function requireExactEtag(value: string): string {
  if (typeof value !== "string") throw new KeePassWebDavError("remote-etag-required", "替换远端 KeePass 文件需要有效的 ETag。");
  const etag = value.trim();
  if (!etag || etag.length > 1024 || /[\r\n]/.test(etag)) {
    throw new KeePassWebDavError("remote-etag-required", "替换远端 KeePass 文件需要有效的 ETag。");
  }
  return etag;
}

function normalizedEtag(value: string | null): string {
  const etag = value?.trim() || "";
  return etag && etag.length <= 1024 && !/[\r\n]/.test(etag) ? etag : "";
}

function recoverableWriteOutcome(cause: unknown): boolean {
  return cause instanceof ProviderTransportError && ["conflict", "network", "timeout", "server"].includes(cause.code);
}

function remotePathError(): KeePassWebDavError {
  return new KeePassWebDavError("remote-path-invalid", "KeePass WebDAV 远端文件位置无效。");
}

function normalizedPathname(value: string): string {
  try {
    return decodeURIComponent(value).replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function xmlValue(block: string, localName: string): string {
  const match = block.match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${localName}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

function optionalNonNegativeInteger(value: string): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new KeePassWebDavError("remote-metadata-invalid", "WebDAV 返回了无效的 KeePass 文件大小。");
  }
  return number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}
