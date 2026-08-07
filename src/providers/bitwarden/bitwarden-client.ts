import { base64ToBytes, bytesToBase64 } from "../../security/encoding";
import { providerHttpError, resilientFetch, type ProviderResponseConsumer, type ProviderTransportPolicy } from "../provider-transport";
import { readBoundedJsonObject } from "../bounded-body";
import {
  decryptBitwardenSymmetricKey,
  deriveBitwardenMasterKey,
  deriveBitwardenMasterPasswordHash,
  encryptBitwardenBytes,
  normalizeBitwardenEmail,
  stretchBitwardenMasterKey,
  type BitwardenKdfConfig,
  type BitwardenSymmetricKey
} from "./bitwarden-crypto";

export interface BitwardenServerUrls {
  vault: string;
  api: string;
  identity: string;
}

export interface BitwardenSessionConfig extends Record<string, unknown> {
  vaultUrl: string;
  apiUrl: string;
  identityUrl: string;
  email: string;
  deviceId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  kdf: BitwardenKdfConfig;
  vaultKeyEnc: string;
  vaultKeyMac: string;
}

export type BitwardenLoginResult =
  | { status: "authenticated"; session: BitwardenSessionConfig }
  | { status: "two-factor-required"; providers: number[]; providerData?: Record<string, unknown> };

export interface BitwardenClientLimits {
  maxAuthResponseBytes: number;
  maxVaultResponseBytes: number;
  maxAttachmentInfoResponseBytes: number;
}

export const DEFAULT_BITWARDEN_CLIENT_LIMITS: Readonly<BitwardenClientLimits> = Object.freeze({
  maxAuthResponseBytes: 2 * 1024 * 1024,
  maxVaultResponseBytes: 64 * 1024 * 1024,
  maxAttachmentInfoResponseBytes: 64 * 1024
});

export interface BitwardenAttachmentDownloadInfo {
  id?: string;
  url: string;
  fileName?: string;
  size?: string;
  key?: string;
}

export type BitwardenFileUploadType = 0 | 1;

export interface BitwardenAttachmentUploadRequest {
  key: string;
  fileName: string;
  fileSize: number;
  lastKnownRevisionDate: string;
}

export interface BitwardenAttachmentUploadInfo {
  attachmentId: string;
  fileUploadType: BitwardenFileUploadType;
  url?: string;
  cipherResponse?: Record<string, unknown>;
  cipherMiniResponse?: Record<string, unknown>;
}

export interface BitwardenLoginInput {
  vaultUrl: string;
  email: string;
  masterPassword: string;
  deviceId: string;
  twoFactorCode?: string;
  twoFactorProvider?: number;
  rememberTwoFactor?: boolean;
}

const CLIENT_VERSION = "2026.7.0";
const DEVICE_TYPE = "2";
const MAX_ATTACHMENT_CIPHERTEXT_BYTES = 100 * 1024 * 1024 + 64;
const MAX_ATTACHMENT_METADATA_TEXT = 1024 * 1024;
const MAX_PATH_ID_BYTES = 4096;
const MAX_ATTACHMENTS_IN_UPLOAD_RESPONSE = 512;

export class BitwardenClient {
  constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly transportPolicy: ProviderTransportPolicy = {},
    private readonly limitOverrides: Partial<BitwardenClientLimits> = {}
  ) {}

  async prelogin(vaultUrl: string, email: string, signal?: AbortSignal): Promise<{ urls: BitwardenServerUrls; email: string; kdf: BitwardenKdfConfig }> {
    const urls = inferBitwardenServerUrls(vaultUrl);
    const normalizedEmail = normalizeBitwardenEmail(email);
    const body = await this.request(`${urls.identity}/accounts/prelogin`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: normalizedEmail }),
      signal
    }, "Bitwarden 预登录", true, async (response, requestSignal) => {
      const body = await this.responseJson(response, this.limits().maxAuthResponseBytes, "Bitwarden 预登录响应", requestSignal);
      if (!response.ok) throw bitwardenHttpError("Bitwarden 预登录失败", response, body);
      return body;
    });
    return { urls, email: normalizedEmail, kdf: parseKdf(body) };
  }

  async login(input: BitwardenLoginInput, signal?: AbortSignal): Promise<BitwardenLoginResult> {
    const { urls, email, kdf } = await this.prelogin(input.vaultUrl, input.email, signal);
    const masterKey = await deriveBitwardenMasterKey(input.masterPassword, email, kdf);
    const passwordHash = await deriveBitwardenMasterPasswordHash(masterKey, input.masterPassword);
    const stretchedKey = await stretchBitwardenMasterKey(masterKey);
    const form = new URLSearchParams({
      grant_type: "password",
      username: email,
      password: passwordHash,
      scope: "api offline_access",
      client_id: "browser",
      deviceIdentifier: input.deviceId,
      deviceType: DEVICE_TYPE,
      deviceName: "Monica Browser Extension"
    });
    if (input.twoFactorCode && input.twoFactorProvider !== undefined) {
      form.set("twoFactorToken", input.twoFactorCode.trim());
      form.set("twoFactorProvider", String(input.twoFactorProvider));
      form.set("twoFactorRemember", input.rememberTwoFactor ? "1" : "0");
    }
    const body = await this.request(`${urls.identity}/connect/token`, {
      method: "POST",
      headers: tokenHeaders(email),
      body: form,
      signal
    }, "Bitwarden 登录", false, async (response, requestSignal) => {
      const body = await this.responseJson(response, this.limits().maxAuthResponseBytes, "Bitwarden 登录响应", requestSignal);
      if (!response.ok) {
        const providers = parseTwoFactorProviders(body);
        if (providers.length) return { status: "two-factor-required", providers, providerData: recordValue(body, "twoFactorProviders2", "TwoFactorProviders2") } as const;
        if (stringValue(body, "HCaptcha_SiteKey", "hCaptcha_SiteKey")) throw new Error("Bitwarden 要求完成 CAPTCHA；请先在官方客户端登录此设备后重试。");
        throw bitwardenHttpError("Bitwarden 登录失败", response, body);
      }
      return { status: "ok", body } as const;
    });
    if (body.status === "two-factor-required") return body;
    const tokenBody = body.body;
    const accessToken = stringValue(tokenBody, "access_token");
    const protectedKey = stringValue(tokenBody, "Key", "key");
    if (!accessToken || !protectedKey) throw new Error("Bitwarden 登录响应缺少访问令牌或受保护密钥。");
    const vaultKey = await decryptBitwardenSymmetricKey(protectedKey, stretchedKey);
    const expiresIn = numberValue(tokenBody, "expires_in") || 3600;
    return {
      status: "authenticated",
      session: {
        vaultUrl: urls.vault,
        apiUrl: urls.api,
        identityUrl: urls.identity,
        email,
        deviceId: input.deviceId,
        accessToken,
        refreshToken: stringValue(tokenBody, "refresh_token") || undefined,
        expiresAt: Date.now() + expiresIn * 1000,
        kdf,
        vaultKeyEnc: bytesToBase64(vaultKey.encKey),
        vaultKeyMac: bytesToBase64(vaultKey.macKey)
      }
    };
  }

  async refresh(session: BitwardenSessionConfig, signal?: AbortSignal): Promise<BitwardenSessionConfig> {
    if (!session.refreshToken) throw new Error("Bitwarden 会话没有刷新令牌，请重新登录。");
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: "browser" });
    const body = await this.request(`${session.identityUrl}/connect/token`, { method: "POST", headers: tokenHeaders(session.email, false), body: form, signal }, "Bitwarden 刷新会话", false, async (response, requestSignal) => {
      const body = await this.responseJson(response, this.limits().maxAuthResponseBytes, "Bitwarden 刷新响应", requestSignal);
      if (!response.ok) throw bitwardenHttpError("刷新 Bitwarden 会话失败", response, body);
      return body;
    });
    const accessToken = stringValue(body, "access_token");
    if (!accessToken) throw new Error("Bitwarden 刷新响应缺少访问令牌。");
    return {
      ...session,
      accessToken,
      refreshToken: stringValue(body, "refresh_token") || session.refreshToken,
      expiresAt: Date.now() + (numberValue(body, "expires_in") || 3600) * 1000
    };
  }

  async sendTwoFactorEmailCode(input: Pick<BitwardenLoginInput, "vaultUrl" | "email" | "masterPassword" | "deviceId">, signal?: AbortSignal): Promise<void> {
    const { urls, email, kdf } = await this.prelogin(input.vaultUrl, input.email, signal);
    const masterKey = await deriveBitwardenMasterKey(input.masterPassword, email, kdf);
    const masterPasswordHash = await deriveBitwardenMasterPasswordHash(masterKey, input.masterPassword);
    await this.request(`${urls.api}/two-factor/send-email-login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ deviceIdentifier: input.deviceId, email, masterPasswordHash }),
      signal
    }, "Bitwarden 发送邮箱验证码", false, async (response, requestSignal) => {
      if (!response.ok) throw bitwardenHttpError("发送 Bitwarden 邮箱验证码失败", response, await this.responseJson(response, this.limits().maxAuthResponseBytes, "Bitwarden 验证码响应", requestSignal));
    });
  }

  async sync(session: BitwardenSessionConfig, signal?: AbortSignal): Promise<{ session: BitwardenSessionConfig; payload: Record<string, unknown> }> {
    return this.authorizedJson(session, "/sync?excludeDomains=true", { method: "GET", signal }, "同步 Bitwarden 密码库失败");
  }

  createCipher(session: BitwardenSessionConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ session: BitwardenSessionConfig; payload: Record<string, unknown> }> {
    return this.authorizedJson(session, "/ciphers", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(payload), signal }, "创建 Bitwarden 项目失败");
  }

  updateCipher(session: BitwardenSessionConfig, cipherId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ session: BitwardenSessionConfig; payload: Record<string, unknown> }> {
    return this.authorizedJson(session, `/ciphers/${encodeURIComponent(cipherId)}`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify(payload), signal }, "更新 Bitwarden 项目失败");
  }

  /**
   * Bitwarden's recycle bin. The bare `DELETE /ciphers/{id}` is an irreversible purge and is
   * deliberately not exposed: Monica's own delete is a tombstone the user can still recover from.
   */
  async softDeleteCipher(session: BitwardenSessionConfig, cipherId: string, signal?: AbortSignal): Promise<BitwardenSessionConfig> {
    const active = session.expiresAt <= Date.now() + 60_000 ? await this.refresh(session, signal) : session;
    await this.request(`${active.apiUrl}/ciphers/${encodeURIComponent(cipherId)}/delete`, {
      method: "PUT",
      headers: authorizedHeaders(active.accessToken),
      signal
    }, "Bitwarden 移入回收站", true, async (response, requestSignal) => {
      if (!response.ok) throw bitwardenHttpError("将 Bitwarden 项目移入回收站失败", response, await this.responseJson(response, this.limits().maxAuthResponseBytes, "Bitwarden 回收站响应", requestSignal));
    });
    return active;
  }

  restoreCipher(session: BitwardenSessionConfig, cipherId: string, signal?: AbortSignal): Promise<{ session: BitwardenSessionConfig; payload: Record<string, unknown> }> {
    return this.authorizedJson(session, `/ciphers/${encodeURIComponent(cipherId)}/restore`, { method: "PUT", headers: jsonHeaders(), signal }, "恢复 Bitwarden 项目失败");
  }

  async attachmentDownloadInfo(
    session: BitwardenSessionConfig,
    cipherId: string,
    attachmentId: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; info: BitwardenAttachmentDownloadInfo }> {
    const active = session.expiresAt <= Date.now() + 60_000 ? await this.refresh(session, signal) : session;
    const body = await this.request(`${active.apiUrl}/ciphers/${encodeURIComponent(cipherId)}/attachment/${encodeURIComponent(attachmentId)}`, {
      method: "GET",
      headers: authorizedHeaders(active.accessToken),
      signal
    }, "获取 Bitwarden 附件下载地址", true, async (response, requestSignal) => {
      const payload = await this.responseJson(response, this.limits().maxAttachmentInfoResponseBytes, "Bitwarden 附件下载信息", requestSignal);
      if (!response.ok) throw bitwardenHttpError("获取 Bitwarden 附件下载地址失败", response, payload);
      return payload;
    });
    const url = stringValue(body, "Url", "url");
    if (!url) throw new Error("Bitwarden 附件下载响应缺少签名地址。");
    return {
      session: active,
      info: {
        id: optionalStringValue(body, "Id", "id"),
        url,
        fileName: optionalStringValue(body, "FileName", "fileName"),
        size: optionalScalarText(body, "Size", "size"),
        key: optionalStringValue(body, "Key", "key")
      }
    };
  }

  async prepareAttachmentUpload(
    session: BitwardenSessionConfig,
    cipherId: string,
    input: BitwardenAttachmentUploadRequest,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; upload: BitwardenAttachmentUploadInfo }> {
    assertPathId(cipherId, "Cipher");
    validateAttachmentUploadRequest(input);
    const active = session.expiresAt <= Date.now() + 60_000 ? await this.refresh(session, signal) : session;
    const body = await this.request(`${active.apiUrl}/ciphers/${encodeURIComponent(cipherId)}/attachment/v2`, {
      method: "POST",
      headers: mergeHeaders(jsonHeaders(), authorizedHeaders(active.accessToken)),
      body: JSON.stringify(input),
      signal
    }, "创建 Bitwarden 附件上传", false, async (response, requestSignal) => {
      const payload = await this.responseJson(response, this.limits().maxAttachmentInfoResponseBytes, "Bitwarden 附件上传响应", requestSignal);
      if (!response.ok) throw bitwardenHttpError("创建 Bitwarden 附件上传失败", response, payload);
      return payload;
    });
    const cipherResponse = recordValue(body, "CipherResponse", "cipherResponse");
    const cipherMiniResponse = recordValue(body, "CipherMiniResponse", "cipherMiniResponse");
    const attachmentId = resolveAttachmentUploadId(body, input, cipherResponse, cipherMiniResponse);
    assertPathId(attachmentId, "附件");
    const rawUploadType = scalarInteger(body, "FileUploadType", "fileUploadType");
    if (rawUploadType !== 0 && rawUploadType !== 1) throw new Error("Bitwarden 返回了未知的附件上传模式。");
    const url = optionalStringValue(body, "Url", "url");
    if (rawUploadType === 1 && !url) throw new Error("Bitwarden Azure 附件上传响应缺少签名地址。");
    if (url) validateAttachmentSignedUrl(url);
    return {
      session: active,
      upload: {
        attachmentId,
        fileUploadType: rawUploadType,
        url,
        cipherResponse,
        cipherMiniResponse
      }
    };
  }

  async uploadAttachmentDirect(
    session: BitwardenSessionConfig,
    cipherId: string,
    attachmentId: string,
    encryptedFileName: string,
    encryptedBytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<BitwardenSessionConfig> {
    assertPathId(cipherId, "Cipher");
    assertPathId(attachmentId, "附件");
    assertEncryptedAttachmentText(encryptedFileName, "加密文件名");
    assertEncryptedAttachmentBytes(encryptedBytes);
    const active = session.expiresAt <= Date.now() + 60_000 ? await this.refresh(session, signal) : session;
    const form = new FormData();
    form.append("data", new Blob([encryptedBytes as BlobPart], { type: "application/octet-stream" }), encryptedFileName);
    await this.request(`${active.apiUrl}/ciphers/${encodeURIComponent(cipherId)}/attachment/${encodeURIComponent(attachmentId)}`, {
      method: "POST",
      headers: authorizedHeaders(active.accessToken),
      body: form,
      signal
    }, "上传 Bitwarden Direct 附件", false, async (response) => {
      if (!response.ok) throw bitwardenHttpError("上传 Bitwarden Direct 附件失败", response);
    });
    return active;
  }

  async uploadAttachmentAzure(signedUrl: string, encryptedBytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const url = validateAttachmentSignedUrl(signedUrl);
    assertEncryptedAttachmentBytes(encryptedBytes);
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "x-ms-blob-type": "BlockBlob",
      "x-ms-date": new Date().toUTCString()
    });
    const serviceVersion = new URL(url).searchParams.get("sv");
    if (serviceVersion) headers.set("x-ms-version", serviceVersion);
    await this.request(url, {
      method: "PUT",
      headers,
      body: new Blob([encryptedBytes as BlobPart], { type: "application/octet-stream" }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal
    }, "上传 Bitwarden Azure 附件", true, async (response) => {
      if (response.status !== 201) throw providerHttpError("上传 Bitwarden Azure 附件失败", response);
    });
  }

  async renewAttachmentUploadUrl(
    session: BitwardenSessionConfig,
    cipherId: string,
    attachmentId: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; url: string }> {
    assertPathId(cipherId, "Cipher");
    assertPathId(attachmentId, "附件");
    const active = session.expiresAt <= Date.now() + 60_000 ? await this.refresh(session, signal) : session;
    const body = await this.request(`${active.apiUrl}/ciphers/${encodeURIComponent(cipherId)}/attachment/${encodeURIComponent(attachmentId)}/renew`, {
      method: "GET",
      headers: authorizedHeaders(active.accessToken),
      signal
    }, "续签 Bitwarden 附件上传地址", true, async (response, requestSignal) => {
      const payload = await this.responseJson(response, this.limits().maxAttachmentInfoResponseBytes, "Bitwarden 附件续签响应", requestSignal);
      if (!response.ok) throw bitwardenHttpError("续签 Bitwarden 附件上传地址失败", response, payload);
      return payload;
    });
    const url = stringValue(body, "Url", "url");
    if (!url) throw new Error("Bitwarden 附件续签响应缺少签名地址。");
    return { session: active, url: validateAttachmentSignedUrl(url) };
  }

  async deleteAttachment(
    session: BitwardenSessionConfig,
    cipherId: string,
    attachmentId: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; deleted: true }> {
    assertPathId(cipherId, "Cipher");
    assertPathId(attachmentId, "附件");
    const active = session.expiresAt <= Date.now() + 60_000 ? await this.refresh(session, signal) : session;
    await this.request(`${active.apiUrl}/ciphers/${encodeURIComponent(cipherId)}/attachment/${encodeURIComponent(attachmentId)}`, {
      method: "DELETE",
      headers: authorizedHeaders(active.accessToken),
      signal
    }, "删除 Bitwarden 附件", true, async (response) => {
      if (response.status === 200 || response.status === 204 || response.status === 404) return;
      throw bitwardenHttpError("删除 Bitwarden 附件失败", response);
    });
    return { session: active, deleted: true };
  }

  private async authorizedJson(
    session: BitwardenSessionConfig,
    path: string,
    init: RequestInit,
    errorPrefix: string
  ): Promise<{ session: BitwardenSessionConfig; payload: Record<string, unknown> }> {
    const active = session.expiresAt <= Date.now() + 60_000 ? await this.refresh(session, init.signal || undefined) : session;
    const headers = new Headers(init.headers);
    for (const [name, value] of authorizedHeaders(active.accessToken)) headers.set(name, value);
    const payload = await this.request(`${active.apiUrl}${path}`, {
      ...init,
      headers
    }, errorPrefix, undefined, async (response, requestSignal) => {
      const payload = await this.responseJson(response, this.limits().maxVaultResponseBytes, "Bitwarden 密码库响应", requestSignal);
      if (!response.ok) throw bitwardenHttpError(errorPrefix, response, payload);
      return payload;
    });
    return { session: active, payload };
  }

  vaultKey(session: BitwardenSessionConfig): BitwardenSymmetricKey {
    return { encKey: base64ToBytes(session.vaultKeyEnc), macKey: base64ToBytes(session.vaultKeyMac) };
  }

  // Exposed for compatibility fixtures that need a protected user key.
  protectVaultKey(vaultKey: BitwardenSymmetricKey, stretchedKey: BitwardenSymmetricKey, iv: Uint8Array): Promise<string> {
    const raw = new Uint8Array(64);
    raw.set(vaultKey.encKey);
    raw.set(vaultKey.macKey, 32);
    return encryptBitwardenBytes(raw, stretchedKey, () => iv);
  }

  private request<T>(url: string, init: RequestInit, operation: string, idempotent: boolean | undefined, consume: ProviderResponseConsumer<T>): Promise<T> {
    return resilientFetch(url, { ...init, cache: "no-store", credentials: "omit", redirect: "error" }, {
      ...this.transportPolicy,
      operation,
      fetcher: this.fetcher,
      idempotent
    }, consume);
  }

  private limits(): BitwardenClientLimits {
    const limits = { ...DEFAULT_BITWARDEN_CLIENT_LIMITS, ...this.limitOverrides };
    for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Bitwarden 安全限制无效: ${name}`);
    return limits;
  }

  private responseJson(response: Response, maximum: number, label: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    return readBoundedJsonObject(response, maximum, label, signal);
  }
}

export function inferBitwardenServerUrls(rawVaultUrl: string): BitwardenServerUrls {
  const raw = rawVaultUrl.trim() || "https://vault.bitwarden.com";
  const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (parsed.username || parsed.password) throw new Error("Bitwarden 地址不能包含用户名或密码。");
  if (parsed.search || parsed.hash) throw new Error("Bitwarden 地址不能包含查询参数或片段。");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) throw new Error("Bitwarden 地址必须使用 HTTPS。");
  parsed.pathname = parsed.pathname.replace(/\/(api|identity)\/?$/i, "").replace(/\/$/, "");
  const vault = parsed.toString().replace(/\/$/, "");
  if (parsed.hostname === "vault.bitwarden.com") return { vault: "https://vault.bitwarden.com", api: "https://api.bitwarden.com", identity: "https://identity.bitwarden.com" };
  if (parsed.hostname === "vault.bitwarden.eu") return { vault: "https://vault.bitwarden.eu", api: "https://api.bitwarden.eu", identity: "https://identity.bitwarden.eu" };
  return { vault, api: `${vault}/api`, identity: `${vault}/identity` };
}

function parseKdf(body: Record<string, unknown>): BitwardenKdfConfig {
  const type = numberValue(body, "Kdf", "kdf");
  const iterations = numberValue(body, "KdfIterations", "kdfIterations");
  if (type === 0) return { type: 0, iterations: iterations || 600_000 };
  if (type === 1) {
    return {
      type: 1,
      iterations: iterations || 3,
      memoryMb: numberValue(body, "KdfMemory", "kdfMemory") || 64,
      parallelism: numberValue(body, "KdfParallelism", "kdfParallelism") || 4
    };
  }
  throw new Error(`不支持的 Bitwarden KDF 类型：${type}`);
}

function parseTwoFactorProviders(body: Record<string, unknown>): number[] {
  const modern = recordValue(body, "twoFactorProviders2", "TwoFactorProviders2");
  const legacy = arrayValue(body, "twoFactorProviders", "TwoFactorProviders");
  const values = modern ? Object.keys(modern) : legacy;
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0))];
}

function jsonHeaders(): Headers {
  const headers = commonHeaders();
  headers.set("Content-Type", "application/json");
  return headers;
}

function tokenHeaders(email: string, includeAuthEmail = true): Headers {
  const headers = commonHeaders();
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  headers.set("device-type", DEVICE_TYPE);
  if (includeAuthEmail) headers.set("Auth-Email", base64Url(email));
  return headers;
}

function authorizedHeaders(accessToken: string): Headers {
  const headers = commonHeaders();
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

function commonHeaders(): Headers {
  return new Headers({ Accept: "application/json", "Bitwarden-Client-Name": "browser", "Bitwarden-Client-Version": CLIENT_VERSION, "Cache-Control": "no-store" });
}

function bitwardenHttpError(prefix: string, response: Response, _body?: Record<string, unknown>): Error {
  return providerHttpError(prefix, response);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function stringValue(body: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof body[key] === "string") return body[key] as string;
  return "";
}

function mergeHeaders(...sources: Headers[]): Headers {
  const output = new Headers();
  for (const source of sources) for (const [name, value] of source) output.set(name, value);
  return output;
}

function optionalStringValue(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  return stringValue(body, ...keys) || undefined;
}

function optionalScalarText(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function numberValue(body: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number(body[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function recordValue(body: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = body[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function arrayValue(body: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(body[key])) return body[key] as unknown[];
  return [];
}

function scalarInteger(body: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return Number.NaN;
}

function validateAttachmentUploadRequest(input: BitwardenAttachmentUploadRequest): void {
  assertEncryptedAttachmentText(input.key, "附件密钥");
  assertEncryptedAttachmentText(input.fileName, "加密文件名");
  if (!Number.isSafeInteger(input.fileSize) || input.fileSize < 1 || input.fileSize > MAX_ATTACHMENT_CIPHERTEXT_BYTES) {
    throw new Error("Bitwarden 附件密文大小无效。");
  }
  if (
    typeof input.lastKnownRevisionDate !== "string"
    || !input.lastKnownRevisionDate
    || input.lastKnownRevisionDate.length > 256
    || /[\u0000-\u001f\u007f]/.test(input.lastKnownRevisionDate)
  ) throw new Error("Bitwarden Cipher 修订时间无效。");
}

function resolveAttachmentUploadId(
  body: Record<string, unknown>,
  request: BitwardenAttachmentUploadRequest,
  cipherResponse?: Record<string, unknown>,
  cipherMiniResponse?: Record<string, unknown>
): string {
  const direct = optionalStringValue(body, "AttachmentId", "attachmentId");
  if (direct) return direct;
  const matches: string[] = [];
  for (const cipher of [cipherResponse, cipherMiniResponse]) {
    if (!cipher) continue;
    const attachments = arrayValue(cipher, "Attachments", "attachments");
    if (attachments.length > MAX_ATTACHMENTS_IN_UPLOAD_RESPONSE) throw new Error("Bitwarden 附件上传响应包含过多附件元数据。");
    for (const value of attachments) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const attachment = value as Record<string, unknown>;
      const size = optionalScalarText(attachment, "Size", "size");
      if (
        optionalStringValue(attachment, "FileName", "fileName") === request.fileName
        && optionalStringValue(attachment, "Key", "key") === request.key
        && size !== undefined
        && Number(size) === request.fileSize
      ) {
        const id = optionalStringValue(attachment, "Id", "id");
        if (id) matches.push(id);
      }
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) throw new Error(unique.length ? "Bitwarden 附件上传响应的附件 ID 不唯一。" : "Bitwarden 附件上传响应缺少附件 ID。");
  return unique[0];
}

function assertEncryptedAttachmentText(value: string, label: string): void {
  if (typeof value !== "string" || !value || value.length > MAX_ATTACHMENT_METADATA_TEXT || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Bitwarden ${label}无效。`);
  }
}

function assertEncryptedAttachmentBytes(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length < 64 || value.length > MAX_ATTACHMENT_CIPHERTEXT_BYTES) {
    throw new Error("Bitwarden 附件密文字节无效。");
  }
}

function assertPathId(value: string, label: string): void {
  const byteLength = typeof value === "string" ? new TextEncoder().encode(value).byteLength : 0;
  if (!value || byteLength > MAX_PATH_ID_BYTES || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Bitwarden ${label} ID 无效。`);
}

function validateAttachmentSignedUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Bitwarden 附件签名地址无效。");
  }
  if (parsed.username || parsed.password || parsed.hash) throw new Error("Bitwarden 附件签名地址包含不允许的凭据或片段。");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error("Bitwarden 附件签名地址必须使用 HTTPS。");
  }
  return parsed.toString();
}

function base64Url(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
