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

export interface SteamMaFileBundleEntry {
  name: string;
  content: string;
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

/** Parse a plain or Android encrypted maFile from a selected maFile/manifest pair. */
export async function parseSteamMaFileBundle(entries: readonly SteamMaFileBundleEntry[], password = ""): Promise<SteamMaFileData> {
  const maFile = entries.find((entry) => /\.mafile(?:\.json)?$/i.test(entry.name))
    || entries.find((entry) => entry.name.toLowerCase().endsWith(".json") && !/manifest\.json$/i.test(entry.name));
  if (!maFile) throw new Error("未选择 maFile 文件。");
  const trimmed = maFile.content.trim();
  if (trimmed.startsWith("{")) return parseSteamMaFile(trimmed, maFile.name);
  const manifestEntry = entries.find((entry) => /(?:^|[\\/])manifest\.json$/i.test(entry.name));
  if (!manifestEntry) throw new Error("加密 maFile 需要同时选择 manifest.json。");
  if (!password) throw new Error("加密 maFile 需要输入密码。");
  const manifest = parseManifest(manifestEntry.content);
  const fileName = maFile.name.replace(/^.*[\\/]/, "");
  const metadata = manifest.find((entry) => entry.filename === fileName) || (manifest.length === 1 ? manifest[0] : undefined);
  if (!metadata?.salt || !metadata.iv) throw new Error("manifest.json 中没有匹配 maFile 的加密参数。");
  const plaintext = await decryptSteamMaFileText(trimmed, password, metadata.salt, metadata.iv);
  return parseSteamMaFile(plaintext, fileName);
}

export async function decryptSteamMaFileText(encryptedBase64: string, password: string, saltBase64: string, ivBase64: string): Promise<string> {
  if (!password) throw new Error("加密 maFile 需要输入密码。");
  const salt = decodeBase64Bytes(saltBase64);
  const iv = decodeBase64Bytes(ivBase64);
  const ciphertext = decodeBase64Bytes(encryptedBase64.trim());
  if (salt.length === 0 || iv.length !== 16 || ciphertext.length === 0) throw new Error("加密 maFile 的 manifest 参数无效。");
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt as BufferSource, iterations: 50_000, hash: "SHA-1" }, baseKey, { name: "AES-CBC", length: 256 }, false, ["decrypt"]);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, key, ciphertext as BufferSource);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error("无法解密 maFile，请检查密码和 manifest.json。");
  }
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
function decodeBase64Bytes(value: string): Uint8Array {
  try { const binary = atob(padBase64(value.replace(/\s+/g, ""))); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
  catch { return new Uint8Array(); }
}
function parseManifest(content: string): Array<{ filename: string; salt?: string; iv?: string }> {
  let root: Record<string, unknown>;
  try { root = JSON.parse(content) as Record<string, unknown>; } catch { throw new Error("manifest.json 不是有效 JSON。"); }
  const values = Array.isArray(root.entries) ? root.entries : [];
  return values.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const object = entry as Record<string, unknown>;
    const filename = text(object.filename ?? object.Filename);
    const salt = text(object.encryption_salt ?? object.Salt ?? object.salt);
    const iv = text(object.encryption_iv ?? object.IV ?? object.iv);
    return filename ? [{ filename, salt: salt || undefined, iv: iv || undefined }] : [];
  });
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function first(value: Record<string, unknown>, ...keys: string[]): unknown { for (const key of keys) if (value[key] != null) return value[key]; return undefined; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim(); }
function optional(value: unknown): string | undefined { return text(value) || undefined; }
function steamIdValue(value: unknown): string | undefined { const result = text(value); return /^7656119\d{10}$/.test(result) ? result : undefined; }
