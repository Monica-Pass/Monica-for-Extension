import { base64ToBytes, bytesToBase64 } from "../../security/encoding";
import { providerHttpError, resilientFetch, type ProviderTransportPolicy } from "../provider-transport";
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

export class BitwardenClient {
  constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly transportPolicy: ProviderTransportPolicy = {}
  ) {}

  async prelogin(vaultUrl: string, email: string, signal?: AbortSignal): Promise<{ urls: BitwardenServerUrls; email: string; kdf: BitwardenKdfConfig }> {
    const urls = inferBitwardenServerUrls(vaultUrl);
    const normalizedEmail = normalizeBitwardenEmail(email);
    const response = await this.request(`${urls.identity}/accounts/prelogin`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: normalizedEmail }),
      signal
    }, "Bitwarden 预登录", true);
    const body = await responseJson(response);
    if (!response.ok) throw bitwardenHttpError("Bitwarden 预登录失败", response, body);
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
    const response = await this.request(`${urls.identity}/connect/token`, {
      method: "POST",
      headers: tokenHeaders(email),
      body: form,
      signal
    }, "Bitwarden 登录", false);
    const body = await responseJson(response);
    if (!response.ok) {
      const providers = parseTwoFactorProviders(body);
      if (providers.length) return { status: "two-factor-required", providers, providerData: recordValue(body, "twoFactorProviders2", "TwoFactorProviders2") };
      if (stringValue(body, "HCaptcha_SiteKey", "hCaptcha_SiteKey")) throw new Error("Bitwarden 要求完成 CAPTCHA；请先在官方客户端登录此设备后重试。");
      throw bitwardenHttpError("Bitwarden 登录失败", response, body);
    }
    const accessToken = stringValue(body, "access_token");
    const protectedKey = stringValue(body, "Key", "key");
    if (!accessToken || !protectedKey) throw new Error("Bitwarden 登录响应缺少访问令牌或受保护密钥。");
    const vaultKey = await decryptBitwardenSymmetricKey(protectedKey, stretchedKey);
    const expiresIn = numberValue(body, "expires_in") || 3600;
    return {
      status: "authenticated",
      session: {
        vaultUrl: urls.vault,
        apiUrl: urls.api,
        identityUrl: urls.identity,
        email,
        deviceId: input.deviceId,
        accessToken,
        refreshToken: stringValue(body, "refresh_token") || undefined,
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
    const response = await this.request(`${session.identityUrl}/connect/token`, { method: "POST", headers: tokenHeaders(session.email, false), body: form, signal }, "Bitwarden 刷新会话", false);
    const body = await responseJson(response);
    if (!response.ok) throw bitwardenHttpError("刷新 Bitwarden 会话失败", response, body);
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
    const response = await this.request(`${urls.api}/two-factor/send-email-login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ deviceIdentifier: input.deviceId, email, masterPasswordHash }),
      signal
    }, "Bitwarden 发送邮箱验证码", false);
    if (!response.ok) throw bitwardenHttpError("发送 Bitwarden 邮箱验证码失败", response, await responseJson(response));
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

  async deleteCipher(session: BitwardenSessionConfig, cipherId: string, signal?: AbortSignal): Promise<BitwardenSessionConfig> {
    const active = session.expiresAt <= Date.now() + 60_000 ? await this.refresh(session, signal) : session;
    const response = await this.request(`${active.apiUrl}/ciphers/${encodeURIComponent(cipherId)}`, {
      method: "DELETE",
      headers: authorizedHeaders(active.accessToken),
      signal
    }, "Bitwarden 删除项目", true);
    if (!response.ok) throw bitwardenHttpError("删除 Bitwarden 项目失败", response, await responseJson(response));
    return active;
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
    const response = await this.request(`${active.apiUrl}${path}`, {
      ...init,
      headers
    }, errorPrefix);
    const payload = await responseJson(response);
    if (!response.ok) throw bitwardenHttpError(errorPrefix, response, payload);
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

  private request(url: string, init: RequestInit, operation: string, idempotent?: boolean): Promise<Response> {
    return resilientFetch(url, { ...init, cache: "no-store", credentials: "omit", redirect: "error" }, {
      ...this.transportPolicy,
      operation,
      fetcher: this.fetcher,
      idempotent
    });
  }
}

export function inferBitwardenServerUrls(rawVaultUrl: string): BitwardenServerUrls {
  const raw = rawVaultUrl.trim() || "https://vault.bitwarden.com";
  const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") throw new Error("Bitwarden 地址必须使用 HTTPS。");
  parsed.hash = "";
  parsed.search = "";
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

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bitwardenHttpError(prefix: string, response: Response, _body?: Record<string, unknown>): Error {
  return providerHttpError(prefix, response);
}

function stringValue(body: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof body[key] === "string") return body[key] as string;
  return "";
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

function base64Url(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
