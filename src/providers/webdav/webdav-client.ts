import { bytesToBase64 } from "../../security/encoding";

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

export class WebDavClient {
  constructor(
    private readonly credentials: WebDavCredentials,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  async testConnection(signal?: AbortSignal): Promise<void> {
    const response = await this.request(normalizeServerUrl(this.credentials.baseUrl), { method: "PROPFIND", headers: { Depth: "0" }, signal });
    if (!response.ok && response.status !== 207) throw await webDavError("连接 WebDAV 失败", response);
  }

  async listBackups(signal?: AbortSignal): Promise<WebDavBackupFile[]> {
    const folderUrl = backupFolderUrl(this.credentials.baseUrl);
    let response = await this.request(folderUrl, { method: "PROPFIND", headers: { Depth: "1" }, signal });
    if (response.status === 404) {
      await this.ensureBackupFolder(signal);
      response = await this.request(folderUrl, { method: "PROPFIND", headers: { Depth: "1" }, signal });
    }
    if (!response.ok && response.status !== 207) throw await webDavError("读取 Monica_Backups 失败", response);
    return parseMultiStatus(await response.text(), folderUrl)
      .filter((file) => /\.zip$/i.test(file.name))
      .sort((left, right) => compareBackups(right, left));
  }

  async download(file: WebDavBackupFile, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(file.url, { method: "GET", signal });
    if (!response.ok) throw await webDavError(`下载备份 ${file.name} 失败`, response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async upload(bytes: Uint8Array, encrypted: boolean, signal?: AbortSignal): Promise<WebDavBackupFile> {
    await this.ensureBackupFolder(signal);
    const now = new Date();
    const name = `monica_backup_${formatTimestamp(now)}_browser${encrypted ? ".enc.zip" : ".zip"}`;
    const url = joinUrl(backupFolderUrl(this.credentials.baseUrl), name);
    const response = await this.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" },
      body: bytes as BodyInit,
      signal
    });
    if (!response.ok) throw await webDavError(`上传备份 ${name} 失败`, response);
    return { name, url, etag: response.headers.get("etag") || undefined, size: bytes.length, lastModified: now.toISOString(), encrypted };
  }

  private async ensureBackupFolder(signal?: AbortSignal): Promise<void> {
    const folderUrl = backupFolderUrl(this.credentials.baseUrl);
    const check = await this.request(folderUrl, { method: "PROPFIND", headers: { Depth: "0" }, signal });
    if (check.ok || check.status === 207) return;
    if (check.status !== 404) throw await webDavError("检查 Monica_Backups 目录失败", check);
    const create = await this.request(folderUrl, { method: "MKCOL", signal });
    if (!create.ok && create.status !== 405) throw await webDavError("创建 Monica_Backups 目录失败", create);
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Basic ${bytesToBase64(new TextEncoder().encode(`${this.credentials.username}:${this.credentials.password}`))}`);
    headers.set("Accept", "*/*");
    return this.fetcher(url, { ...init, headers, cache: "no-store", credentials: "omit" });
  }
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("WebDAV 地址不能为空。");
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function backupFolderUrl(baseUrl: string): string {
  const normalized = normalizeServerUrl(baseUrl);
  return /\/Monica_Backups$/i.test(new URL(normalized).pathname) ? normalized : joinUrl(normalized, "Monica_Backups");
}

export function parseMultiStatus(xml: string, folderUrl: string): WebDavBackupFile[] {
  const responses = xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) || [];
  return responses.flatMap((block): WebDavBackupFile[] => {
    if (/<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(block)) return [];
    const href = xmlValue(block, "href");
    if (!href) return [];
    const decodedPath = safeDecode(new URL(href, folderUrl).pathname);
    const name = decodedPath.split("/").filter(Boolean).pop() || "";
    if (!name) return [];
    return [{
      name,
      url: new URL(href, folderUrl).toString(),
      etag: xmlValue(block, "getetag") || undefined,
      size: optionalNumber(xmlValue(block, "getcontentlength")),
      lastModified: xmlValue(block, "getlastmodified") || undefined,
      encrypted: /\.enc\.zip$/i.test(name)
    }];
  });
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

async function webDavError(prefix: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(`${prefix}（HTTP ${response.status}）${body ? `: ${body.slice(0, 240)}` : ""}`);
}
