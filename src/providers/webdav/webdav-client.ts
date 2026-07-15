import { bytesToBase64 } from "../../security/encoding";
import { providerHttpError, resilientFetch, type ProviderTransportPolicy } from "../provider-transport";
import { DEFAULT_ZIP_SAFETY_LIMITS } from "./zip-safety";

export interface WebDavCredentials {
  baseUrl: string;
  username: string;
  password: string;
}

export interface WebDavBackupFile {
  name: string;
  url: string;
  etag?: string;
  size?: number;
  lastModified?: string;
  encrypted: boolean;
}

export interface WebDavClientLimits {
  maxMultiStatusBytes: number;
  maxDownloadBytes: number;
  maxUploadBytes: number;
}

export const DEFAULT_WEBDAV_CLIENT_LIMITS: Readonly<WebDavClientLimits> = Object.freeze({
  maxMultiStatusBytes: 2 * 1024 * 1024,
  maxDownloadBytes: DEFAULT_ZIP_SAFETY_LIMITS.maxArchiveBytes + 64,
  maxUploadBytes: DEFAULT_ZIP_SAFETY_LIMITS.maxArchiveBytes + 64
});

const BACKUP_FILE_PATTERN = /^monica_backup_[^/]+(?:\.enc)?\.zip$/i;

export class WebDavClient {
  constructor(
    private readonly credentials: WebDavCredentials,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly transportPolicy: ProviderTransportPolicy = {},
    private readonly limitOverrides: Partial<WebDavClientLimits> = {}
  ) {}

  async testConnection(signal?: AbortSignal): Promise<void> {
    const response = await this.request(normalizeServerUrl(this.credentials.baseUrl), { method: "PROPFIND", headers: { Depth: "0" }, signal }, "WebDAV 连接");
    if (!response.ok && response.status !== 207) throw webDavError("连接 WebDAV 失败", response);
  }

  async listBackups(signal?: AbortSignal): Promise<WebDavBackupFile[]> {
    const folderUrl = backupFolderUrl(this.credentials.baseUrl);
    let response = await this.request(folderUrl, { method: "PROPFIND", headers: { Depth: "1" }, signal }, "WebDAV 列出备份");
    if (response.status === 404) {
      await this.ensureBackupFolder(signal);
      response = await this.request(folderUrl, { method: "PROPFIND", headers: { Depth: "1" }, signal }, "WebDAV 列出备份");
    }
    if (!response.ok && response.status !== 207) throw webDavError("读取 Monica_Backups 失败", response);
    const limits = this.limits();
    return parseMultiStatus(await readBoundedText(response, limits.maxMultiStatusBytes, "WebDAV 目录响应"), folderUrl)
      .filter((file) => BACKUP_FILE_PATTERN.test(file.name))
      .sort((left, right) => compareBackups(right, left));
  }

  async download(file: WebDavBackupFile, signal?: AbortSignal): Promise<Uint8Array> {
    const limits = this.limits();
    assertBackupFileUrl(file.url, backupFolderUrl(this.credentials.baseUrl));
    if (!BACKUP_FILE_PATTERN.test(file.name)) throw new Error("WebDAV 备份文件名不符合 Monica 格式。");
    if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.maxDownloadBytes)) {
      throw new Error("WebDAV 备份下载超过安全上限。");
    }
    const response = await this.request(file.url, { method: "GET", signal }, "WebDAV 下载备份");
    if (!response.ok) throw webDavError(`下载备份 ${file.name} 失败`, response);
    return readBoundedBytes(response, limits.maxDownloadBytes, "WebDAV 备份下载");
  }

  async upload(bytes: Uint8Array, encrypted: boolean, signal?: AbortSignal): Promise<WebDavBackupFile> {
    if (bytes.length > this.limits().maxUploadBytes) throw new Error("WebDAV 备份上传超过安全上限。");
    await this.ensureBackupFolder(signal);
    const now = new Date();
    const name = `monica_backup_${formatTimestamp(now)}_browser${encrypted ? ".enc.zip" : ".zip"}`;
    const url = joinUrl(backupFolderUrl(this.credentials.baseUrl), name);
    const response = await this.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" },
      body: bytes as BodyInit,
      signal
    }, "WebDAV 上传备份");
    if (!response.ok) throw webDavError(`上传备份 ${name} 失败`, response);
    return { name, url, etag: response.headers.get("etag") || undefined, size: bytes.length, lastModified: now.toISOString(), encrypted };
  }

  private async ensureBackupFolder(signal?: AbortSignal): Promise<void> {
    const folderUrl = backupFolderUrl(this.credentials.baseUrl);
    const check = await this.request(folderUrl, { method: "PROPFIND", headers: { Depth: "0" }, signal }, "WebDAV 检查目录");
    if (check.ok || check.status === 207) return;
    if (check.status !== 404) throw webDavError("检查 Monica_Backups 目录失败", check);
    const create = await this.request(folderUrl, { method: "MKCOL", signal }, "WebDAV 创建目录");
    if (!create.ok && create.status !== 405) throw webDavError("创建 Monica_Backups 目录失败", create);
  }

  private request(url: string, init: RequestInit, operation: string): Promise<Response> {
    assertSameProviderOrigin(url, this.credentials.baseUrl);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Basic ${bytesToBase64(new TextEncoder().encode(`${this.credentials.username}:${this.credentials.password}`))}`);
    headers.set("Accept", "*/*");
    return resilientFetch(url, { ...init, headers, cache: "no-store", credentials: "omit", redirect: "error" }, { ...this.transportPolicy, operation, fetcher: this.fetcher });
  }

  private limits(): WebDavClientLimits {
    const limits = { ...DEFAULT_WEBDAV_CLIENT_LIMITS, ...this.limitOverrides };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`WebDAV 安全限制无效: ${name}`);
    }
    return limits;
  }
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("WebDAV 地址不能为空。");
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.username || url.password) throw new Error("WebDAV 地址不能包含用户名或密码。");
  if (url.search || url.hash) throw new Error("WebDAV 地址不能包含查询参数或片段。");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("WebDAV 必须使用 HTTPS；仅回环地址允许 HTTP。");
  }
  return url.toString().replace(/\/$/, "");
}

export function backupFolderUrl(baseUrl: string): string {
  const normalized = normalizeServerUrl(baseUrl);
  return /\/Monica_Backups$/i.test(new URL(normalized).pathname) ? normalized : joinUrl(normalized, "Monica_Backups");
}

export function parseMultiStatus(xml: string, folderUrl: string): WebDavBackupFile[] {
  const trustedFolderUrl = backupFolderUrl(folderUrl);
  const responses = xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) || [];
  return responses.flatMap((block): WebDavBackupFile[] => {
    if (/<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(block)) return [];
    const href = xmlValue(block, "href");
    if (!href) return [];
    const resolvedUrl = new URL(href, `${trustedFolderUrl.replace(/\/$/, "")}/`);
    assertBackupFileUrl(resolvedUrl.toString(), trustedFolderUrl);
    const decodedPath = safeDecode(resolvedUrl.pathname);
    const name = decodedPath.split("/").filter(Boolean).pop() || "";
    if (!name) return [];
    return [{
      name,
      url: resolvedUrl.toString(),
      etag: xmlValue(block, "getetag") || undefined,
      size: optionalNumber(xmlValue(block, "getcontentlength")),
      lastModified: xmlValue(block, "getlastmodified") || undefined,
      encrypted: /\.enc\.zip$/i.test(name)
    }];
  });
}

async function readBoundedText(response: Response, maximum: number, label: string): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, maximum, label));
}

async function readBoundedBytes(response: Response, maximum: number, label: string): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${label}超过安全上限。`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw new Error(`${label}超过安全上限。`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (!Number.isSafeInteger(total) || total > maximum) {
        await reader.cancel();
        throw new Error(`${label}超过安全上限。`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function assertSameProviderOrigin(target: string, configuredBaseUrl: string): void {
  const base = new URL(normalizeServerUrl(configuredBaseUrl));
  const url = new URL(target);
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash) {
    throw new Error("请求越过 WebDAV Provider 安全边界。");
  }
}

function assertBackupFileUrl(target: string, folderUrl: string): void {
  const folder = new URL(backupFolderUrl(folderUrl));
  const url = new URL(target);
  const prefix = `${folder.pathname.replace(/\/$/, "")}/`;
  const decodedRelativePath = safeDecode(url.pathname.slice(prefix.length));
  if (
    url.origin !== folder.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    !decodedRelativePath ||
    decodedRelativePath.includes("/") ||
    decodedRelativePath.includes("\\") ||
    decodedRelativePath === "." ||
    decodedRelativePath === ".."
  ) {
    throw new Error("目标越过 WebDAV 备份目录边界。");
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function joinUrl(base: string, child: string): string {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${child.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
  return url.toString();
}

function xmlValue(block: string, localName: string): string {
  const match = block.match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${localName}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function optionalNumber(value: string): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function compareBackups(left: WebDavBackupFile, right: WebDavBackupFile): number {
  const leftTime = left.lastModified ? Date.parse(left.lastModified) : 0;
  const rightTime = right.lastModified ? Date.parse(right.lastModified) : 0;
  return leftTime - rightTime || left.name.localeCompare(right.name);
}

function formatTimestamp(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}_${pad(date.getUTCMilliseconds(), 3)}`;
}

function webDavError(prefix: string, response: Response): Error {
  return providerHttpError(prefix, response);
}
