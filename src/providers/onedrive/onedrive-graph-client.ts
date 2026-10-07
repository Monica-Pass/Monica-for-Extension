import { readBoundedJsonObject, readBoundedResponseBytes } from "../bounded-body";
import {
  ProviderTransportError, providerHttpError, resilientFetch,
  type ProviderResponseConsumer, type ProviderTransportPolicy
} from "../provider-transport";
import {
  KEEPASS_REMOTE_MAX_DATABASE_BYTES,
  type KeePassWebDavFileStat, type KeePassWebDavSnapshot, type KeePassWebDavWriteResult
} from "../keepass/keepass-webdav-client";
import { OneDriveAuthorizationError } from "./onedrive-auth";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ITEM_FIELDS = "id,name,size,eTag,lastModifiedDateTime,parentReference,file,folder,remoteItem,deleted";
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_CHILDREN = 10000;
const MAX_PAGES = 100;

export interface OneDriveItemIdentity { driveId: string; itemId: string }
export interface OneDriveProfile { id: string; displayName: string; username: string }
export interface OneDriveDrive { id: string; name: string; driveType: string }
export interface OneDriveItem extends OneDriveItemIdentity {
  name: string;
  kind: "file" | "folder";
  size: number;
  etag?: string;
  lastModified?: string;
}
interface FileMetadata extends OneDriveItem { etag: string; downloadUrl?: string }
export type OneDriveAccessTokenProvider = (signal?: AbortSignal) => Promise<string>;

/** Graph and preauthenticated file URLs deliberately use separate request paths. */
export class OneDriveGraphClient {
  constructor(
    private readonly accessToken: OneDriveAccessTokenProvider,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly policy: ProviderTransportPolicy = {},
    private readonly maxDatabaseBytes = KEEPASS_REMOTE_MAX_DATABASE_BYTES,
    private readonly scope?: AbortSignal
  ) {
    if (!Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes <= 0 || maxDatabaseBytes > KEEPASS_REMOTE_MAX_DATABASE_BYTES) {
      throw invalidMetadata();
    }
  }

  async profile(signal?: AbortSignal): Promise<OneDriveProfile> {
    const value = await this.json(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, signal);
    return { id: identityPart(value.id), displayName: textField(value.displayName, 256, true),
      username: textField(value.mail || value.userPrincipalName, 320, true) };
  }

  async defaultDrive(signal?: AbortSignal): Promise<OneDriveDrive> {
    const value = await this.json(`${GRAPH}/me/drive?$select=id,name,driveType`, signal);
    return { id: identityPart(value.id), name: textField(value.name, 256), driveType: textField(value.driveType, 64) };
  }

  /** Return only selectable folders/KDBX files, never download capabilities or remote shortcuts. */
  async children(driveId: string, parentId?: string, signal?: AbortSignal): Promise<OneDriveItem[]> {
    const drive = identityPart(driveId);
    const base = `${GRAPH}/drives/${encodeURIComponent(drive)}/${parentId ? `items/${encodeURIComponent(identityPart(parentId))}` : "root"}/children`;
    let next: string | undefined = `${base}?$select=${ITEM_FIELDS}&$top=200`;
    const seenPages = new Set<string>(), seenItems = new Set<string>();
    const items: OneDriveItem[] = [];
    let count = 0;
    while (next) {
      if (seenPages.has(next) || seenPages.size >= MAX_PAGES) throw invalidMetadata();
      seenPages.add(next);
      const page = await this.json(next, signal);
      if (!Array.isArray(page.value) || (count += page.value.length) > MAX_CHILDREN) throw invalidMetadata();
      for (const raw of page.value) {
        if (!isObject(raw)) throw invalidMetadata();
        if (raw.deleted || raw.remoteItem) continue;
        const item = parseItem(raw, drive);
        if (seenItems.has(item.itemId)) throw changedFile();
        seenItems.add(item.itemId);
        if (item.kind === "folder" || item.name.toLowerCase().endsWith(".kdbx")) items.push(item);
      }
      next = page["@odata.nextLink"] === undefined ? undefined : safeNextLink(page["@odata.nextLink"], base);
    }
    signal?.throwIfAborted();
    return items;
  }

  async file(identity: OneDriveItemIdentity, includeDownload = false, signal?: AbortSignal): Promise<FileMetadata | undefined> {
    const target = normalizeOneDriveIdentity(identity);
    return this.request(`${itemUrl(target)}?$select=${ITEM_FIELDS}${includeDownload ? ",@microsoft.graph.downloadUrl" : ""}`, { signal }, "OneDrive 文件状态", async (response, requestSignal) => {
      if (response.status === 404) return undefined;
      if (!response.ok) throw providerHttpError("读取 OneDrive 文件状态失败", response);
      const raw = await readBoundedJsonObject(response, MAX_METADATA_BYTES, "OneDrive 文件状态", requestSignal);
      const item = parseFile(raw, target);
      if (item.size > this.maxDatabaseBytes) throw fileSizeError("下载");
      return { ...item, ...(includeDownload ? { downloadUrl: safeDownloadUrl(raw["@microsoft.graph.downloadUrl"]) } : {}) };
    });
  }

  async download(capabilityUrl: string, signal?: AbortSignal): Promise<Uint8Array> {
    const url = safeDownloadUrl(capabilityUrl);
    // No bearer, cookies, referrer, or automatic redirect on this capability request.
    return this.withScope(signal, activeSignal => resilientFetch(url, { method: "GET", signal: activeSignal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" }, {
      ...this.policy, operation: "OneDrive 文件下载", fetcher: this.fetcher, idempotent: true
    }, async (response, requestSignal) => {
      if (response.status !== 200) throw providerHttpError("OneDrive 文件下载失败", response);
      return readBoundedResponseBytes(response, this.maxDatabaseBytes, "OneDrive 文件下载", requestSignal);
    }));
  }

  async replace(identity: OneDriveItemIdentity, bytes: Uint8Array, etag: string, signal?: AbortSignal): Promise<void> {
    const target = normalizeOneDriveIdentity(identity);
    const exact = requireOneDriveEtag(etag);
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > this.maxDatabaseBytes) throw fileSizeError("上传");
    await this.request(`${itemUrl(target)}/content`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "If-Match": exact }, body: bytes as BodyInit, signal },
      "OneDrive 条件写入", async (response, requestSignal) => {
        if (!response.ok) throw providerHttpError("OneDrive 条件写入失败", response);
        const raw = await readBoundedJsonObject(response, MAX_METADATA_BYTES, "OneDrive 写入结果", requestSignal);
        const written = parseFile(raw, target);
        if (written.size !== bytes.length) throw invalidMetadata();
      });
  }

  private json(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request(url, { signal }, "OneDrive 读取", async (response, requestSignal) => {
      if (!response.ok) throw providerHttpError("OneDrive 读取失败", response);
      return readBoundedJsonObject(response, MAX_METADATA_BYTES, "OneDrive 元数据", requestSignal);
    });
  }

  private async request<T>(url: string, init: RequestInit, operation: string, consume: ProviderResponseConsumer<T>): Promise<T> {
    return this.withScope(init.signal || undefined, signal => this.requestScoped(url, { ...init, signal }, operation, consume));
  }

  private async requestScoped<T>(url: string, init: RequestInit, operation: string, consume: ProviderResponseConsumer<T>): Promise<T> {
    assertGraphUrl(url);
    init.signal?.throwIfAborted();
    const token = await this.accessToken(init.signal || undefined);
    init.signal?.throwIfAborted();
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(token)) throw new OneDriveAuthorizationError();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    const isRead = !init.method || init.method === "GET";
    return resilientFetch(url, { ...init, headers, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" }, {
      ...this.policy, operation, fetcher: this.fetcher, idempotent: isRead,
      // Never replay a PUT after an ambiguous result; the file client reconciles actual bytes.
      ...(!isRead ? { maxAttempts: 1, timeoutMs: this.policy.timeoutMs ?? 120000 } : {})
    }, consume);
  }

  private withScope<T>(signal: AbortSignal | undefined, work: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.scope) return work(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.scope.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (this.scope.aborted || signal?.aborted) abort();
    return work(controller.signal).finally(() => {
      this.scope?.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    });
  }
}

/** Same contract as the WebDAV transport, including verified writes and uncertain-result recovery. */
export class OneDriveKeePassFileClient {
  private readonly identity: OneDriveItemIdentity;
  constructor(identity: OneDriveItemIdentity, private readonly graph: OneDriveGraphClient) {
    this.identity = normalizeOneDriveIdentity(identity);
  }

  async testConnection(signal?: AbortSignal): Promise<void> { await this.stat(signal); }
  async stat(signal?: AbortSignal): Promise<KeePassWebDavFileStat | undefined> {
    const file = await this.graph.file(this.identity, false, signal);
    return file ? fileStat(file) : undefined;
  }

  async read(signal?: AbortSignal): Promise<KeePassWebDavSnapshot> {
    const before = await this.graph.file(this.identity, true, signal);
    if (!before) throw missingFile();
    const bytes = await this.graph.download(before.downloadUrl!, signal);
    try {
      // The preauthenticated URL need not use Graph's ETag. Bind downloaded bytes to
      // stable metadata before and after the GET instead of inventing an If-Match token.
      const after = await this.graph.file(this.identity, false, signal);
      if (!after || before.etag !== after.etag || before.size !== after.size || bytes.length !== after.size) throw changedFile();
      const sha256 = await sha256Hex(bytes);
      signal?.throwIfAborted();
      return { ...fileStat(after), bytes, sha256 };
    } catch (error) { bytes.fill(0); throw error; }
  }

  async write(bytes: Uint8Array, expectedEtag: string | null, signal?: AbortSignal): Promise<KeePassWebDavWriteResult> {
    // This client binds an existing drive/item pair. Creation must not silently
    // recreate a removed or moved source under another identity.
    const etag = requireOneDriveEtag(expectedEtag);
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > KEEPASS_REMOTE_MAX_DATABASE_BYTES) throw fileSizeError("上传");
    const intendedSha256 = await sha256Hex(bytes);
    try {
      await this.graph.replace(this.identity, bytes, etag, signal);
    } catch (error) {
      if (error instanceof ProviderTransportError && ["conflict", "network", "timeout", "server"].includes(error.code) && !signal?.aborted) {
        let current: KeePassWebDavSnapshot | undefined;
        try { current = await this.read(signal); } catch { /* Retain the original write failure. */ }
        if (current?.sha256 === intendedSha256) return { ...current, alreadyApplied: true };
        current?.bytes.fill(0);
      }
      throw error;
    }
    const verified = await this.read(signal);
    if (verified.sha256 !== intendedSha256) {
      verified.bytes.fill(0);
      throw changedFile("OneDrive 写入后内容校验失败，本机修改已保留，请重新同步。");
    }
    return { ...verified, alreadyApplied: false };
  }
}

export function normalizeOneDriveIdentity(value: OneDriveItemIdentity): OneDriveItemIdentity {
  if (!isObject(value)) throw invalidMetadata();
  return { driveId: identityPart(value.driveId), itemId: identityPart(value.itemId) };
}
function identityPart(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9!_-]{1,256}$/.test(value)) throw invalidMetadata();
  return value;
}
function textField(value: unknown, maximum: number, allowEmpty = false): string {
  if (allowEmpty && (value === null || value === undefined)) return "";
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw invalidMetadata();
  return value;
}
function parseItem(value: Record<string, unknown>, driveId: string): OneDriveItem {
  if (value.deleted || value.remoteItem || !isObject(value.parentReference) || value.parentReference.driveId !== driveId ||
    !Number.isSafeInteger(value.size) || (value.size as number) < 0 ||
    isObject(value.file) === isObject(value.folder)) throw invalidMetadata();
  return { driveId, itemId: identityPart(value.id), name: textField(value.name, 256), kind: isObject(value.folder) ? "folder" : "file",
    size: value.size as number, ...(value.eTag === undefined ? {} : { etag: requireOneDriveEtag(value.eTag) }),
    ...(value.lastModifiedDateTime === undefined ? {} : { lastModified: textField(value.lastModifiedDateTime, 64) }) };
}
function parseFile(value: Record<string, unknown>, identity: OneDriveItemIdentity): FileMetadata {
  const item = parseItem(value, identity.driveId);
  if (item.itemId !== identity.itemId || item.kind !== "file" || !item.name.toLowerCase().endsWith(".kdbx")) throw invalidMetadata();
  return { ...item, etag: requireOneDriveEtag(item.etag) };
}
function requireOneDriveEtag(value: unknown): string {
  // Preserve the exact strong Graph validator. Never trim, strip W/, or accept a wildcard.
  if (typeof value !== "string" || !/^"[\x21\x23-\x7e]{1,1022}"$/.test(value)) {
    throw new ProviderTransportError("client", "OneDrive 文件缺少有效的强 ETag，请重新同步。", { operation: "OneDrive 文件版本", attempts: 1, retryable: false });
  }
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function itemUrl(identity: OneDriveItemIdentity): string { return `${GRAPH}/drives/${encodeURIComponent(identity.driveId)}/items/${encodeURIComponent(identity.itemId)}`; }
function assertGraphUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== "https://graph.microsoft.com" || !url.pathname.startsWith("/v1.0/") || url.username || url.password || url.hash || url.href.length > 16384) throw invalidMetadata();
  return url;
}
function safeNextLink(value: unknown, base: string): string {
  if (typeof value !== "string") throw invalidMetadata();
  const url = assertGraphUrl(value);
  if (url.pathname !== new URL(base).pathname) throw invalidMetadata();
  for (const key of url.searchParams.keys()) {
    if (!["$select", "$top", "$skiptoken", "$skip"].includes(key) || url.searchParams.getAll(key).length !== 1) throw invalidMetadata();
  }
  return url.href;
}
function safeDownloadUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16384) throw invalidMetadata();
  let url: URL;
  try { url = new URL(value); } catch { throw invalidMetadata(); }
  const suffixes = [".1drv.com", ".sharepoint.com", ".storage.live.com"];
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !suffixes.some(suffix => url.hostname.endsWith(suffix))) throw invalidMetadata();
  return url.href;
}
function fileStat(file: OneDriveItem): KeePassWebDavFileStat {
  return { url: itemUrl(file), fileName: file.name, etag: file.etag, sizeBytes: file.size, lastModified: file.lastModified };
}
function invalidMetadata(): ProviderTransportError {
  return new ProviderTransportError("client", "OneDrive 文件信息无效，请重新选择文件。", { operation: "OneDrive 文件信息", attempts: 1, retryable: false });
}
function changedFile(message = "OneDrive 文件在同步期间发生变化，本机修改已保留，请重新同步。"): ProviderTransportError {
  return new ProviderTransportError("conflict", message, { operation: "OneDrive 同步", attempts: 1, retryable: false });
}
function missingFile(): ProviderTransportError {
  return new ProviderTransportError("not-found", "OneDrive 文件已不存在，请重新选择文件。", { operation: "OneDrive 同步", attempts: 1, retryable: false });
}
function fileSizeError(action: string): ProviderTransportError {
  return new ProviderTransportError("client", `OneDrive KeePass 文件大小超出${action}安全上限。`, { operation: `OneDrive ${action}`, attempts: 1, retryable: false });
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), value => value.toString(16).padStart(2, "0")).join("");
}
