import type { TotpItem } from "../../core/model";

export interface SteamConfirmation {
  id: string;
  nonce: string;
  type: string;
  headline: string;
  summary: string;
  imageUrl: string;
  creationTime: number;
}

export interface SteamPendingLogin {
  clientId: number;
  version: number;
  ip: string;
  city: string;
  country: string;
  deviceName: string;
}

export interface SteamAuthorizedDeviceUsage {
  timeSeconds: number;
  country: string;
  state: string;
  city: string;
  location: string;
}

export interface SteamAuthorizedDevice {
  tokenId: string;
  description: string;
  platformType: number;
  loggedIn: boolean;
  firstSeen?: SteamAuthorizedDeviceUsage;
  lastSeen?: SteamAuthorizedDeviceUsage;
  isCurrent: boolean;
}

export class SteamNetworkError extends Error {
  constructor(message: string, readonly retryable = true, readonly eResult?: number) {
    super(message);
    this.name = "SteamNetworkError";
  }
}

export async function listSteamConfirmations(item: TotpItem, nowSeconds = Math.floor(Date.now() / 1000)): Promise<SteamConfirmation[]> {
  const account = await prepareAccount(item);
  const query = await baseConfirmationQuery(account.item, nowSeconds, "list");
  const payload = await communityJson("/mobileconf/getlist", query, account.item);
  if (!truthy(payload.success)) return [];
  const entries = Array.isArray(payload.conf) ? payload.conf : [];
  return entries.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const raw = value as Record<string, unknown>;
    const id = firstString(raw, "id", "confid");
    const nonce = firstString(raw, "nonce", "key");
    if (!id || !nonce) return [];
    return [{
      id,
      nonce,
      type: firstString(raw, "type", "conf_type"),
      headline: firstString(raw, "headline", "creator"),
      summary: Array.isArray(raw.summary) ? raw.summary.map(String).join("\n") : String(raw.summary || ""),
      imageUrl: firstString(raw, "icon", "icon_url", "image", "image_url", "imageUrl", "creator_avatar"),
      creationTime: numberValue(raw.creation_time ?? raw.time)
    } satisfies SteamConfirmation];
  });
}

export async function respondToSteamConfirmation(item: TotpItem, confirmation: SteamConfirmation, accept: boolean, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const account = await prepareAccount(item);
  const op = accept ? "allow" : "cancel";
  const form = {
    ...(await baseConfirmationQuery(account.item, nowSeconds, op)),
    tag: op,
    op,
    cid: confirmation.id,
    ck: confirmation.nonce
  };
  const payload = await communityJson("/mobileconf/ajaxop", form, account.item, "POST");
  return truthy(payload.success);
}

export async function listSteamPendingLogins(item: TotpItem): Promise<SteamPendingLogin[]> {
  const account = await prepareAccount(item);
  const ids = await protobufCall("IAuthenticationService", "GetAuthSessionsForAccount", new Uint8Array(), account.accessToken, true);
  const fields = new SteamProtoReader(ids).parseAll();
  const clientIds = fields.flatMap((field): number[] => field.number !== 1 ? [] : field.varint !== undefined ? [Number(field.varint)] : field.bytes ? decodePackedVarints(field.bytes) : []);
  const sessions = await Promise.all(clientIds.map(async (clientId) => {
    try {
      return await getSteamSessionInfo(account.item, account.accessToken, clientId);
    } catch {
      return null;
    }
  }));
  return sessions.flatMap((value) => value ? [value] : []);
}

export async function respondToSteamLogin(item: TotpItem, login: Pick<SteamPendingLogin, "clientId" | "version">, approve: boolean): Promise<boolean> {
  const account = await prepareAccount(item);
  const steamId = requireSteamId(account.item);
  const signature = await hmacSha256(
    decodeBase64(account.item.steamSharedSecretBase64 || account.item.secret),
    concat(littleEndian16(login.version), littleEndian64(BigInt(login.clientId)), littleEndian64(steamId))
  );
  const request = new SteamProtoWriter();
  request.writeVarint(1, login.version);
  request.writeVarint(2, login.clientId);
  request.writeFixed64(3, steamId);
  request.writeBytes(4, signature);
  request.writeBool(5, approve);
  request.writeVarint(6, 1);
  const response = await protobufCall("IAuthenticationService", "UpdateAuthSessionWithMobileConfirmation", request.toBytes(), account.accessToken);
  const fields = new SteamProtoReader(response).parse();
  return fields.size === 0 || fieldBool(fields.get(1)) !== false;
}

export async function listSteamAuthorizedDevices(item: TotpItem): Promise<SteamAuthorizedDevice[]> {
  const account = await prepareSteamAccount(item);
  const request = new SteamProtoWriter();
  request.writeBool(1, false);
  const response = await steamProtobufCall("IAuthenticationService", "EnumerateTokens", request.toBytes(), account.accessToken);
  const fields = new SteamProtoReader(response).parseAll();
  const requestingToken = fieldFixed64Unsigned(fields.find((field) => field.number === 2));
  return fields.flatMap((field): SteamAuthorizedDevice[] => {
    if (field.number !== 1 || !field.bytes) return [];
    const parsed = parseAuthorizedDevice(field.bytes, requestingToken);
    return parsed ? [parsed] : [];
  });
}

export async function prepareSteamAccount(item: TotpItem): Promise<{ item: TotpItem; accessToken: string }> {
  const accessToken = item.steamAccessToken || parseSteamRaw(item.steamRawJson).accessToken;
  const refreshToken = item.steamRefreshToken || parseSteamRaw(item.steamRawJson).refreshToken;
  if (!accessToken && !refreshToken) throw new SteamNetworkError("Steam 项目缺少 access token 或 refresh token。", false);
  if (accessToken && !isJwtExpiring(accessToken)) return { item, accessToken };
  if (!refreshToken) throw new SteamNetworkError("Steam access token 已过期，且没有 refresh token。", false);
  const steamId = requireSteamId(item);
  const request = new SteamProtoWriter();
  request.writeString(1, refreshToken);
  request.writeFixed64(2, steamId);
  const bytes = await steamProtobufCall("IAuthenticationService", "GenerateAccessTokenForApp", request.toBytes());
  const fields = new SteamProtoReader(bytes).parse();
  const refreshed = fieldString(fields.get(1));
  if (!refreshed) throw new SteamNetworkError("Steam token 刷新失败。", false);
  item.steamAccessToken = refreshed;
  item.steamRefreshToken = fieldString(fields.get(2)) || item.steamRefreshToken;
  item.steamLoginSecure = `${steamId}||${refreshed}`;
  item.steamRawJson = patchSteamRawSession(item.steamRawJson, steamId.toString(), refreshed, item.steamRefreshToken, item.steamLoginSecure);
  return { item, accessToken: refreshed };
}

const prepareAccount = prepareSteamAccount;

async function getSteamSessionInfo(item: TotpItem, accessToken: string, clientId: number): Promise<SteamPendingLogin> {
  const request = new SteamProtoWriter();
  request.writeVarint(1, clientId);
  const bytes = await protobufCall("IAuthenticationService", "GetAuthSessionInfo", request.toBytes(), accessToken);
  const fields = new SteamProtoReader(bytes).parse();
  return {
    clientId,
    version: fieldNumber(fields.get(8)),
    ip: fieldString(fields.get(1)),
    city: fieldString(fields.get(3)),
    country: fieldString(fields.get(5)),
    deviceName: fieldString(fields.get(7))
  };
}

async function communityJson(path: string, values: Record<string, string>, item: TotpItem, method: "GET" | "POST" = "GET"): Promise<Record<string, unknown>> {
  return steamCommunityJson(path, values, item, { method });
}

export interface SteamCommunityRequestOptions {
  method?: "GET" | "POST";
  cookies?: Record<string, string>;
  referer?: string;
}

export async function steamCommunityJson(path: string, values: Record<string, string>, item: TotpItem, options: SteamCommunityRequestOptions = {}): Promise<Record<string, unknown>> {
  const text = await steamCommunityText(path, values, item, options);
  if (!text.trim().startsWith("{")) return {};
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new SteamNetworkError("Steam 返回了无法解析的响应。", false); }
}

export async function steamCommunityText(path: string, values: Record<string, string>, item: TotpItem, options: SteamCommunityRequestOptions = {}): Promise<string> {
  if (!/^\/[A-Za-z0-9_./-]*$/.test(path) || path.includes("..")) throw new SteamNetworkError("Steam community 请求路径无效。", false);
  const method = options.method || "GET";
  const query = new URLSearchParams();
  const headers: Record<string, string> = { Accept: "application/json, text/plain, */*", "X-Requested-With": "com.valvesoftware.android.steam.community" };
  if (method === "GET") Object.entries(values).forEach(([key, value]) => query.set(key, value));
  const url = `https://steamcommunity.com${path}${method === "GET" ? `?${query}` : ""}`;
  const body = method === "POST" ? new URLSearchParams(values) : undefined;
  const response = await withSteamCookies(item, async (cookieHeader) => {
    if (cookieHeader) headers.Cookie = cookieHeader;
    return steamFetch(url, { method, headers, body, credentials: "include", referrer: validatedCommunityReferer(options.referer) });
  }, options.cookies);
  assertSteamResponseOrigin(response, "steamcommunity.com");
  if (!response.ok) throw new SteamNetworkError(`Steam community 请求失败（HTTP ${response.status}）。`);
  return response.text();
}

export async function steamProtobufCall(iface: string, method: string, bytes: Uint8Array, accessToken = "", useGet = false): Promise<Uint8Array> {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(iface) || !/^[A-Za-z][A-Za-z0-9]*$/.test(method)) throw new SteamNetworkError("Steam API 方法无效。", false);
  const encoded = encodeBase64(bytes);
  const query = new URLSearchParams({ input_protobuf_encoded: encoded });
  if (accessToken) query.set("access_token", accessToken);
  const postQuery = accessToken ? `?${new URLSearchParams({ access_token: accessToken })}` : "";
  const url = `https://api.steampowered.com/${iface}/${method}/v1/${useGet ? `?${query}` : postQuery}`;
  const response = await steamFetch(url, {
    method: useGet ? "GET" : "POST",
    headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded" },
    body: useGet ? undefined : new URLSearchParams({ input_protobuf_encoded: encoded }),
    credentials: "omit"
  });
  assertSteamResponseOrigin(response, "api.steampowered.com");
  const eresult = Number(response.headers.get("x-eresult") || "1");
  if (!response.ok || eresult !== 1) throw new SteamNetworkError(`Steam API 请求失败（HTTP ${response.status}, eresult=${eresult}）。`, true, eresult);
  return new Uint8Array(await response.arrayBuffer());
}

export async function steamApiJson(iface: string, method: string, values: Record<string, string> = {}): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(iface) || !/^[A-Za-z][A-Za-z0-9]*$/.test(method)) throw new SteamNetworkError("Steam API 方法无效。", false);
  const query = new URLSearchParams(values);
  const url = `https://api.steampowered.com/${iface}/${method}/v1/${query.toString() ? `?${query}` : ""}`;
  const response = await steamFetch(url, { method: "GET", headers: { Accept: "application/json" }, credentials: "omit" });
  assertSteamResponseOrigin(response, "api.steampowered.com");
  if (!response.ok) throw new SteamNetworkError(`Steam API 请求失败（HTTP ${response.status}）。`);
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as unknown;
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  } catch { throw new SteamNetworkError("Steam API 返回了无法解析的响应。", false); }
}

const protobufCall = steamProtobufCall;

async function baseConfirmationQuery(item: TotpItem, nowSeconds: number, tag: string): Promise<Record<string, string>> {
  const identitySecret = item.steamIdentitySecret;
  const steamId = requireSteamId(item).toString();
  if (!identitySecret) throw new SteamNetworkError("Steam 项目缺少 identity secret。", false);
  const key = decodeBase64(identitySecret);
  const payload = concat(bigEndian64(BigInt(nowSeconds)), new TextEncoder().encode(tag.slice(0, 32)));
  const signature = await hmacSha1(key, payload);
  return { p: item.steamDeviceId || "", a: steamId, k: encodeBase64(signature), t: String(nowSeconds), m: "react", tag };
}

async function withSteamCookies<T>(item: TotpItem, action: (cookieHeader: string) => Promise<T>, additional: Record<string, string> = {}): Promise<T> {
  const steamId = requireSteamId(item).toString();
  const token = item.steamAccessToken || parseSteamRaw(item.steamRawJson).accessToken || "";
  const values: Record<string, string> = {
    steamLoginSecure: item.steamLoginSecure || `${steamId}||${token}`,
    mobileClient: "android",
    mobileClientVersion: "777777 3.6.4",
    ...additional
  };
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || /[;\r\n]/.test(value)) throw new SteamNetworkError("Steam Cookie 参数无效。", false);
  }
  const cookieHeader = Object.entries(values).map(([name, value]) => `${name}=${value}`).join("; ");
  const cookies = globalThis.chrome?.cookies;
  if (!cookies?.get || !cookies?.set || !cookies?.remove) return action(cookieHeader);
  const url = "https://steamcommunity.com/";
  const names = Object.keys(values);
  const previous = await Promise.all(names.map((name) => getCookie(cookies, url, name)));
  try {
    await Promise.all(Object.entries(values).map(([name, value]) => setCookie(cookies, url, name, value)));
    return await action("");
  } finally {
    await Promise.all(names.map(async (name, index) => {
      await removeCookie(cookies, url, name);
      const old = previous[index];
      if (old?.value) await restoreCookie(cookies, old);
    }));
  }
}

export function createSteamSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function setCookie(cookies: typeof chrome.cookies, url: string, name: string, value: string, path = "/"): Promise<void> {
  return callbackWithTimeout((done) => cookies.set({ url, name, value, path, secure: url.startsWith("https://") }, () => done(chrome.runtime.lastError ? new Error(chrome.runtime.lastError.message) : undefined)), "Steam Cookie 写入超时。");
}

function restoreCookie(cookies: typeof chrome.cookies, cookie: chrome.cookies.Cookie): Promise<void> {
  const host = cookie.domain.replace(/^\./, "");
  const url = `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
  return callbackWithTimeout((done) => cookies.set({
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.session ? undefined : cookie.expirationDate,
    storeId: cookie.storeId
  }, () => done(chrome.runtime.lastError ? new Error(chrome.runtime.lastError.message) : undefined)), "Steam Cookie 恢复超时。");
}

function getCookie(cookies: typeof chrome.cookies, url: string, name: string): Promise<chrome.cookies.Cookie | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SteamNetworkError("Steam Cookie 读取超时。")), 3_000);
    cookies.get({ url, name }, (cookie) => { clearTimeout(timer); resolve(cookie); });
  });
}

function removeCookie(cookies: typeof chrome.cookies, url: string, name: string): Promise<void> {
  return callbackWithTimeout((done) => cookies.remove({ url, name }, () => done()), "Steam Cookie 清理超时。");
}

function callbackWithTimeout(register: (done: (error?: Error) => void) => void, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SteamNetworkError(message)), 3_000);
    register((error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
  });
}

async function steamFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new SteamNetworkError("Steam 请求超时，请稍后重试。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function requireSteamId(item: TotpItem): bigint {
  const value = item.steamId || parseSteamRaw(item.steamRawJson).steamId || "";
  if (!/^7656119\d{10}$/.test(value)) throw new SteamNetworkError("Steam 项目缺少有效 SteamID64。", false);
  return BigInt(value);
}

function parseAuthorizedDevice(bytes: Uint8Array, requestingToken: string): SteamAuthorizedDevice | undefined {
  const fields = new SteamProtoReader(bytes).parse();
  const tokenId = fieldFixed64Unsigned(fields.get(1));
  const description = fieldString(fields.get(2));
  if (!tokenId && !description) return undefined;
  return {
    tokenId,
    description,
    platformType: fieldNumber(fields.get(4)),
    loggedIn: fieldBool(fields.get(5)) || false,
    firstSeen: parseAuthorizedDeviceUsage(fields.get(9)?.bytes),
    lastSeen: parseAuthorizedDeviceUsage(fields.get(10)?.bytes),
    isCurrent: Boolean(requestingToken && tokenId === requestingToken)
  };
}

function parseAuthorizedDeviceUsage(bytes?: Uint8Array): SteamAuthorizedDeviceUsage | undefined {
  if (!bytes) return undefined;
  const fields = new SteamProtoReader(bytes).parse();
  const city = fieldString(fields.get(6));
  const state = fieldString(fields.get(5));
  const country = fieldString(fields.get(4));
  return {
    timeSeconds: fieldNumber(fields.get(1)),
    country,
    state,
    city,
    location: [city, state, country].filter(Boolean).join(", ")
  };
}

function validatedCommunityReferer(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && isHostOrSubdomain(url.hostname, "steamcommunity.com") ? url.toString() : undefined;
  } catch { return undefined; }
}

function assertSteamResponseOrigin(response: Response, expectedHost: string): void {
  if (!response.url) return;
  const url = new URL(response.url);
  if (url.protocol !== "https:" || !isHostOrSubdomain(url.hostname, expectedHost)) throw new SteamNetworkError("Steam 请求被重定向到非官方地址。", false);
}

function isHostOrSubdomain(host: string, root: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === root || normalized.endsWith(`.${root}`);
}

function parseSteamRaw(rawJson?: string): { steamId?: string; accessToken?: string; refreshToken?: string } {
  if (!rawJson) return {};
  try {
    const root = JSON.parse(rawJson) as Record<string, unknown>;
    const session = (root.Session || root.session) as Record<string, unknown> | undefined;
    const loginSecure = firstString(root, "steamLoginSecure", "steam_login_secure") || firstString(session || {}, "SteamLoginSecure", "steamLoginSecure");
    return {
      steamId: firstString(root, "steamid", "steam_id", "SteamID", "steam64", "steam_id64") || firstString(session || {}, "SteamID", "steamid", "steam_id") || loginSecure.split("||")[0],
      accessToken: firstString(root, "access_token", "accessToken", "oauth_token", "OAuthToken") || firstString(session || {}, "AccessToken", "access_token", "OAuthToken", "oauth_token") || loginSecure.split("||").slice(1).join("||"),
      refreshToken: firstString(root, "refresh_token", "refreshToken") || firstString(session || {}, "RefreshToken", "refresh_token")
    };
  } catch { return {}; }
}

function patchSteamRawSession(rawJson: string | undefined, steamId: string, accessToken: string, refreshToken: string | undefined, loginSecure: string): string {
  let root: Record<string, unknown> = {};
  try { root = rawJson ? JSON.parse(rawJson) as Record<string, unknown> : {}; } catch { root = {}; }
  root.steamid = steamId;
  root.access_token = accessToken;
  if (refreshToken) root.refresh_token = refreshToken;
  root.steamLoginSecure = loginSecure;
  return JSON.stringify(root);
}

function firstString(object: Record<string, unknown>, ...keys: string[]): string { for (const key of keys) if (typeof object[key] === "string" && object[key]) return object[key] as string; return ""; }
function numberValue(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function truthy(value: unknown): boolean { return value === true || value === 1 || value === "1" || value === "true"; }
function isJwtExpiring(token: string, now = Math.floor(Date.now() / 1000)): boolean { try { const part = token.split(".")[1]; const json = JSON.parse(new TextDecoder().decode(decodeBase64Url(part))); return Number(json.exp || 0) <= now + 300; } catch { return true; } }
function decodeBase64(value: string): Uint8Array { return decodeBase64Url(value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")); }
function decodeBase64Url(value: string): Uint8Array { const padded = value + "=".repeat((4 - value.length % 4) % 4); const binary = atob(padded); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function encodeBase64(value: Uint8Array): string { let binary = ""; value.forEach((byte) => { binary += String.fromCharCode(byte); }); return btoa(binary); }
function concat(...parts: Uint8Array[]): Uint8Array { const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; }
function littleEndian16(value: number): Uint8Array { return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff); }
function littleEndian64(value: bigint): Uint8Array { const output = new Uint8Array(8); let current = value; for (let index = 0; index < 8; index++) { output[index] = Number(current & 0xffn); current >>= 8n; } return output; }
function bigEndian64(value: bigint): Uint8Array { const output = new Uint8Array(8); let current = value; for (let index = 7; index >= 0; index--) { output[index] = Number(current & 0xffn); current >>= 8n; } return output; }
async function hmacSha1(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> { const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data as BufferSource)); }
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> { const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data as BufferSource)); }

export class SteamProtoWriter {
  private readonly bytes: number[] = [];
  toBytes(): Uint8Array { return Uint8Array.from(this.bytes); }
  writeVarint(field: number, value: number | bigint) { this.writeTag(field, 0); const parsed = BigInt(value); this.writeRaw(parsed < 0n ? BigInt.asUintN(64, parsed) : parsed); }
  writeBool(field: number, value: boolean) { this.writeVarint(field, value ? 1 : 0); }
  writeString(field: number, value: string) { this.writeBytes(field, new TextEncoder().encode(value)); }
  writeBytes(field: number, value: Uint8Array) { this.writeTag(field, 2); this.writeRaw(BigInt(value.length)); this.bytes.push(...value); }
  writeFixed64(field: number, value: number | bigint) { this.writeTag(field, 1); let current = BigInt(value); for (let index = 0; index < 8; index++) { this.bytes.push(Number(current & 0xffn)); current >>= 8n; } }
  private writeTag(field: number, wire: number) { this.writeRaw(BigInt((field << 3) | wire)); }
  private writeRaw(value: bigint) { let current = value; while (current > 0x7fn) { this.bytes.push(Number((current & 0x7fn) | 0x80n)); current >>= 7n; } this.bytes.push(Number(current)); }
}

export class SteamProtoReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  parse(): Map<number, SteamProtoField> { return new Map(this.parseAll().map((field) => [field.number, field])); }
  parseAll(): SteamProtoField[] { const fields: SteamProtoField[] = []; while (this.offset < this.bytes.length) { const key = this.readRaw(); const number = Number(key >> 3n); const wire = Number(key & 7n); if (wire === 0) fields.push({ number, wire, varint: this.readRaw() }); else if (wire === 1) fields.push({ number, wire, bytes: this.readBytes(8) }); else if (wire === 2) fields.push({ number, wire, bytes: this.readBytes(Number(this.readRaw())) }); else if (wire === 5) fields.push({ number, wire, bytes: this.readBytes(4) }); else throw new SteamNetworkError("Steam protobuf 响应包含不支持的字段。", false); } return fields; }
  private readRaw(): bigint { let result = 0n; let shift = 0n; while (this.offset < this.bytes.length) { const value = this.bytes[this.offset++]; result |= BigInt(value & 0x7f) << shift; if (!(value & 0x80)) return result; shift += 7n; } throw new SteamNetworkError("Steam protobuf 响应不完整。", false); }
  private readBytes(length: number): Uint8Array { const result = this.bytes.slice(this.offset, this.offset + length); this.offset += length; return result; }
}

export interface SteamProtoField { number: number; wire: number; varint?: bigint; bytes?: Uint8Array }
function fieldString(field?: SteamProtoField): string { return field?.bytes ? new TextDecoder().decode(field.bytes) : ""; }
function fieldNumber(field?: SteamProtoField): number { return field?.varint === undefined ? 0 : Number(field.varint); }
function fieldBool(field?: SteamProtoField): boolean | undefined { return field?.varint === undefined ? undefined : field.varint !== 0n; }
function fieldFixed64Unsigned(field?: SteamProtoField): string { if (!field?.bytes || field.bytes.length !== 8) return ""; let value = 0n; for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(field.bytes[index]); return value.toString(); }
function decodePackedVarints(bytes: Uint8Array): number[] { const values: number[] = []; let offset = 0; while (offset < bytes.length) { let value = 0n; let shift = 0n; while (offset < bytes.length) { const byte = bytes[offset++]; value |= BigInt(byte & 0x7f) << shift; if (!(byte & 0x80)) break; shift += 7n; } values.push(Number(value)); } return values; }
