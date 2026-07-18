import type { TotpItem } from "./model";

export interface SteamMaFileData {
  accountName: string;
  steamId?: string;
  deviceId?: string;
  sharedSecretBase64: string;
  identitySecret?: string;
  revocationCode?: string;
  tokenGid?: string;
  accessToken?: string;
  refreshToken?: string;
  steamLoginSecure?: string;
  rawJson: string;
}

export function parseSteamMaFile(content: string, fileName = ""): SteamMaFileData {
  let root: Record<string, unknown>;
  try { root = JSON.parse(content.trim()) as Record<string, unknown>; }
  catch { throw new Error("maFile 不是明文 JSON；加密 maFile 需要先在 Android/桌面客户端解密。"); }
  if (!root || Array.isArray(root)) throw new Error("maFile 根结构无效。");
  const session = record(first(root, "Session", "session"));
  const accountName = text(first(root, "account_name", "accountName", "AccountName")) || text(first(session, "AccountName", "account_name")) || fileName.replace(/\.maFile(?:\.json)?$/i, "") || "Steam";
  const steamLoginSecure = text(first(session, "SteamLoginSecure", "steamLoginSecure")) || text(first(root, "steamLoginSecure", "steam_login_secure"));
  const steamId = steamIdValue(first(root, "steamid", "steam_id", "SteamID", "steam64", "steam_id64", "steamID64", "SteamID64")) || steamIdValue(first(session, "SteamID", "steamid")) || steamLoginSecure?.split("||", 1)[0];
  const sharedSecretBase64 = normalizeSharedSecret(text(first(root, "shared_secret", "sharedSecret", "uri", "otp_uri", "otpauth_uri", "steam_uri")));
  if (!sharedSecretBase64) throw new Error("maFile 缺少有效 shared_secret。");
  return {
    accountName,
    steamId,
    deviceId: optional(first(root, "device_id", "deviceId")) || optional(first(session, "DeviceID", "device_id", "deviceId")),
    sharedSecretBase64,
    identitySecret: optional(first(root, "identity_secret", "identitySecret")),
    revocationCode: optional(first(root, "revocation_code", "revocationCode")),
    tokenGid: optional(first(root, "token_gid", "tokenGid")),
    accessToken: optional(first(root, "access_token", "accessToken", "oauth_token", "OAuthToken")) || optional(first(session, "AccessToken", "access_token", "OAuthToken", "oauth_token")) || steamLoginSecure?.split("||")[1],
    refreshToken: optional(first(root, "refresh_token", "refreshToken")) || optional(first(session, "RefreshToken", "refresh_token")),
    steamLoginSecure,
    rawJson: JSON.stringify(root)
  };
}

export function exportSteamMaFile(item: TotpItem): string {
  let root: Record<string, unknown> = {};
  try { root = item.steamRawJson ? JSON.parse(item.steamRawJson) as Record<string, unknown> : {}; } catch { root = {}; }
  const set = (key: string, value: unknown) => { if (typeof value === "string" && value.trim()) root[key] = value.trim(); };
  set("account_name", item.accountName || item.title);
  set("steamid", item.steamId);
  set("device_id", item.steamDeviceId);
  set("shared_secret", item.steamSharedSecretBase64 || item.secret);
  set("identity_secret", item.steamIdentitySecret);
  set("revocation_code", item.steamRevocationCode);
  set("token_gid", item.steamTokenGid);
  set("access_token", item.steamAccessToken);
  set("refresh_token", item.steamRefreshToken);
  set("steamLoginSecure", item.steamLoginSecure);
  return JSON.stringify(root, null, 2);
}

function normalizeSharedSecret(input: string): string {
  let value = input.trim();
  if (/^steam:\/\//i.test(value)) value = decodeURIComponent(value.replace(/^steam:\/\//i, "").split(/[?#]/, 1)[0]);
  else if (/^otpauth:\/\//i.test(value)) value = new URL(value).searchParams.get("secret") || "";
  const compact = value.replace(/\s+/g, "");
  if (/^[A-Z2-7]+=*$/i.test(compact) && !/[+/]/.test(compact) && compact.length >= 32) return bytesToBase64(decodeBase32(compact));
  try { const bytes = Uint8Array.from(atob(padBase64(compact)), (character) => character.charCodeAt(0)); return bytes.length ? bytesToBase64(bytes) : ""; } catch { return ""; }
}

function decodeBase32(value: string): Uint8Array { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; const bytes: number[] = []; let buffer = 0; let bits = 0; for (const character of value.toUpperCase().replace(/[\s=-]/g, "")) { const index = alphabet.indexOf(character); if (index < 0) return new Uint8Array(); buffer = (buffer << 5) | index; bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); } } return Uint8Array.from(bytes); }
function bytesToBase64(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function padBase64(value: string): string { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); return normalized + "=".repeat((4 - normalized.length % 4) % 4); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function first(value: Record<string, unknown>, ...keys: string[]): unknown { for (const key of keys) if (value[key] != null) return value[key]; return undefined; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim(); }
function optional(value: unknown): string | undefined { return text(value) || undefined; }
function steamIdValue(value: unknown): string | undefined { const result = text(value); return /^7656119\d{10}$/.test(result) ? result : undefined; }
