import type { LoginItem } from "../../core/model";
import { decodeBase32 } from "../../core/totp";
import { bytesToBase64 } from "../../security/encoding";

export const STEAM_MAFILE_MARKER_FIELD = "Monica.Type";
export const STEAM_MAFILE_MARKER_VALUE = "steam_mafile_v1";
export const STEAM_MAFILE_MAX_BYTES = 1024 * 1024;

export function isSteamMaFileLogin(item: LoginItem): boolean {
  if (item.loginType?.trim().toLocaleUpperCase() === "STEAM_MAFILE") return true;
  return item.customFields.some((field) => {
    const name = field.name.trim().toLocaleLowerCase();
    const value = field.value.trim().toLocaleLowerCase();
    return (name === STEAM_MAFILE_MARKER_FIELD.toLocaleLowerCase() && value === STEAM_MAFILE_MARKER_VALUE)
      || ((name === "steam_type" || name === "steam_type_marker" || name === "monica_steam_type") && value.includes("steam_mafile"));
  });
}

export function isSteamMaFileName(fileName: string): boolean {
  return fileName.trim().toLocaleLowerCase().endsWith(".mafile");
}

export function parseSteamMaFile(rawJson: string, fileName = ""): Partial<LoginItem> {
  const root = parseObject(rawJson);
  const session = objectValue(root, "Session", "session") || {};
  const steamLoginSecure = stringValue(session, "SteamLoginSecure", "steamLoginSecure")
    || stringValue(root, "steamLoginSecure", "steam_login_secure");
  const steamId = firstSteamId(root, session)
    || steamLoginSecure.split("||", 1)[0]
    || steamIdFromFileName(fileName);
  const accountName = stringValue(root, "account_name", "accountName", "AccountName")
    || stringValue(session, "AccountName", "account_name")
    || steamId
    || fileName.replace(/\.mafile$/i, "")
    || "Steam";
  const sharedSecret = sharedSecretValue(root);
  if (!sharedSecret) throw new Error("Steam maFile 缺少 shared_secret。");
  const normalizedSharedSecret = normalizeSharedSecret(sharedSecret.value, sharedSecret.encoding);
  const accessToken = stringValue(root, "access_token", "accessToken", "oauth_token", "OAuthToken")
    || stringValue(session, "AccessToken", "access_token", "OAuthToken", "oauth_token")
    || steamLoginSecure.split("||").slice(1).join("||");

  return {
    steamAccountName: accountName,
    steamSharedSecretBase64: normalizedSharedSecret,
    steamId: steamId || undefined,
    steamDeviceId: stringValue(root, "device_id", "deviceId") || stringValue(session, "DeviceID", "device_id", "deviceId") || undefined,
    steamIdentitySecret: stringValue(root, "identity_secret", "identitySecret") || undefined,
    steamRevocationCode: stringValue(root, "revocation_code", "revocationCode") || undefined,
    steamTokenGid: stringValue(root, "token_gid", "tokenGid") || undefined,
    steamAccessToken: accessToken || undefined,
    steamRefreshToken: stringValue(root, "refresh_token", "refreshToken") || stringValue(session, "RefreshToken", "refresh_token") || undefined,
    steamLoginSecure: steamLoginSecure || undefined,
    steamRawJson: rawJson.trim()
  };
}

function sharedSecretValue(root: Record<string, unknown>): { value: string; encoding: "base64" | "base32" } | undefined {
  const uri = stringValue(root, "uri", "Uri", "otp_uri", "otpUri", "otpauth_uri", "otpauthUri", "steam_uri", "steamUri", "url", "URL");
  const candidate = uri || stringValue(root, "shared_secret", "sharedSecret");
  if (!candidate) return undefined;
  if (/^steam:\/\//i.test(candidate)) {
    const encoded = candidate.slice(candidate.indexOf("://") + 3).split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "");
    return { value: decodeUriComponent(encoded), encoding: "base64" };
  }
  if (/^otpauth:\/\//i.test(candidate)) {
    const secret = new URL(candidate).searchParams.get("secret");
    return secret ? { value: secret, encoding: "base32" } : undefined;
  }
  return { value: candidate, encoding: "base64" };
}

function normalizeSharedSecret(value: string, preferred: "base64" | "base32"): string {
  const compact = value.replace(/\s+/g, "");
  const base64 = decodeBase64(compact);
  const base32 = decodeBase32Safe(compact);
  const selected = preferred === "base32"
    ? base32 || base64
    : base64?.length === 20 ? base64 : base32?.length === 20 ? base32 : base64 || base32;
  if (!selected?.length) throw new Error("Steam maFile 的 shared_secret 不是有效的 Base64 或 Base32。");
  return bytesToBase64(selected);
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!value || !/^[A-Za-z0-9+/_=-]+$/.test(value)) return undefined;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try { return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); } catch { return undefined; }
}

function decodeBase32Safe(value: string): Uint8Array | undefined {
  try { return decodeBase32(value); } catch { return undefined; }
}

function parseObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw.trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Steam maFile 根节点必须是 JSON 对象。");
  return parsed as Record<string, unknown>;
}

function objectValue(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown> | undefined {
  for (const name of names) {
    const value = raw[name];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function stringValue(raw: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) if (typeof raw[name] === "string" && (raw[name] as string).trim()) return (raw[name] as string).trim();
  return "";
}

function firstSteamId(root: Record<string, unknown>, session: Record<string, unknown>): string {
  const names = ["steamid", "steam_id", "SteamID", "steam64", "steam_id64", "steamID64", "SteamID64", "sbeamid"];
  return stringValue(root, ...names) || stringValue(session, ...names);
}

function steamIdFromFileName(fileName: string): string {
  return fileName.match(/(?<!\d)(7656119\d{10})(?!\d)/)?.[0] || "";
}

function decodeUriComponent(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/g, "%2B")); } catch { return value; }
}
