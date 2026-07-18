import type { TotpItem } from "../../core/model";
import { generateSteamCode, steamSecondsRemaining } from "../../core/steam-totp";
import { requireSteamId, steamApiJson, SteamNetworkError, steamProtobufCall, SteamProtoReader, SteamProtoWriter, type SteamProtoField } from "./steam-network";

const UINT64_MAX = (1n << 64n) - 1n;

export interface SteamDeviceRevocationInput {
  accountName: string;
  password: string;
  tokenId: string;
}

export interface SteamDeviceRevocationResult {
  success: true;
  tokenId: string;
}

export async function revokeSteamAuthorizedDevice(
  item: TotpItem,
  input: SteamDeviceRevocationInput,
  internal: { now?: () => number; pollAttempts?: number; pollIntervalMs?: number } = {}
): Promise<SteamDeviceRevocationResult> {
  const accountName = validateAccountName(input.accountName);
  let password = validatePassword(input.password);
  input.password = "";
  const tokenId = validateUint64(input.tokenId, "Steam 授权设备 token");
  const expectedSteamId = requireSteamId(item);
  const sharedSecret = item.steamSharedSecretBase64 || item.secret;
  if (!sharedSecret) throw new SteamNetworkError("Steam 项目缺少 shared secret。", false);
  let temporaryAccessToken = "";
  let temporaryRefreshToken = "";

  try {
    const rsaPayload = responseObject(await steamApiJson("IAuthenticationService", "GetPasswordRSAPublicKey", { account_name: accountName }));
    const modulus = stringField(rsaPayload, "publickey_mod");
    const exponent = stringField(rsaPayload, "publickey_exp");
    const timestamp = stringField(rsaPayload, "timestamp");
    if (!modulus || !exponent || !/^\d+$/.test(timestamp)) throw new SteamNetworkError("Steam 密码加密公钥响应不完整。", false);
    const encryptedPassword = encryptSteamPasswordPkcs1(password, modulus, exponent);
    password = "";

    const beginRequest = new SteamProtoWriter();
    beginRequest.writeString(1, "Monica Browser Extension");
    beginRequest.writeString(2, accountName);
    beginRequest.writeString(3, encryptedPassword);
    beginRequest.writeVarint(4, BigInt(timestamp));
    beginRequest.writeBool(5, false);
    beginRequest.writeVarint(6, 3);
    beginRequest.writeVarint(7, 1);
    beginRequest.writeString(8, "Mobile");
    beginRequest.writeBytes(9, buildDeviceDetails().toBytes());
    beginRequest.writeString(10, "");
    beginRequest.writeVarint(11, 0);
    beginRequest.writeVarint(12, 2);
    const beginFields = new SteamProtoReader(await steamProtobufCall("IAuthenticationService", "BeginAuthSessionViaCredentials", beginRequest.toBytes())).parseAll();
    let clientId = fieldUnsignedBigInt(beginFields.find((field) => field.number === 1));
    const requestId = beginFields.find((field) => field.number === 2)?.bytes;
    const authenticatedSteamId = fieldUnsignedBigInt(beginFields.find((field) => field.number === 5));
    if (!clientId || !requestId?.length || !authenticatedSteamId) throw new SteamNetworkError("Steam 设备撤销认证响应缺少会话字段。", false);
    if (authenticatedSteamId !== expectedSteamId) throw new SteamNetworkError("Steam 登录账号与当前验证器不匹配。", false);

    const now = internal.now || Date.now;
    const remaining = steamSecondsRemaining(now());
    if (remaining <= 2) await delay((remaining + 1) * 1_000);
    const code = await generateSteamCode(sharedSecret, now());
    const guardRequest = new SteamProtoWriter();
    guardRequest.writeVarint(1, clientId);
    guardRequest.writeFixed64(2, expectedSteamId);
    guardRequest.writeString(3, code);
    guardRequest.writeVarint(4, 3);
    try {
      await steamProtobufCall("IAuthenticationService", "UpdateAuthSessionWithSteamGuardCode", guardRequest.toBytes());
    } catch (error) {
      if (!(error instanceof SteamNetworkError) || error.eResult !== 29) throw error;
    }

    const attempts = Math.min(20, Math.max(1, Math.trunc(internal.pollAttempts ?? 10)));
    const intervalMs = Math.min(5_000, Math.max(0, Math.trunc(internal.pollIntervalMs ?? 900)));
    for (let attempt = 0; attempt < attempts; attempt++) {
      const pollRequest = new SteamProtoWriter();
      pollRequest.writeVarint(1, clientId);
      pollRequest.writeBytes(2, requestId);
      pollRequest.writeFixed64(3, tokenId);
      const fields = new SteamProtoReader(await steamProtobufCall("IAuthenticationService", "PollAuthSessionStatus", pollRequest.toBytes())).parse();
      const nextClientId = fieldUnsignedBigInt(fields.get(1));
      if (nextClientId) clientId = nextClientId;
      temporaryRefreshToken = fieldString(fields.get(3));
      temporaryAccessToken = fieldString(fields.get(4));
      if (temporaryAccessToken && temporaryRefreshToken) break;
      if (attempt < attempts - 1) await delay(intervalMs);
    }
    if (!temporaryAccessToken || !temporaryRefreshToken) throw new SteamNetworkError("Steam 设备撤销认证超时，请稍后重试。");

    const cleanupRequest = new SteamProtoWriter();
    cleanupRequest.writeString(1, temporaryRefreshToken);
    cleanupRequest.writeVarint(2, 1);
    await steamProtobufCall("IAuthenticationService", "RevokeToken", cleanupRequest.toBytes(), temporaryAccessToken);
    return { success: true, tokenId: tokenId.toString() };
  } finally {
    password = "";
    temporaryAccessToken = "";
    temporaryRefreshToken = "";
  }
}

export function encryptSteamPasswordPkcs1(password: string, modulusHex: string, exponentHex: string): string {
  const message = new TextEncoder().encode(password);
  const normalizedModulus = normalizeHex(modulusHex, "Steam RSA modulus");
  const normalizedExponent = normalizeHex(exponentHex, "Steam RSA exponent");
  const modulus = BigInt(`0x${normalizedModulus}`);
  const exponent = BigInt(`0x${normalizedExponent}`);
  const modulusLength = Math.ceil(normalizedModulus.length / 2);
  if (modulusLength < 64 || exponent <= 0n || modulus <= 0n) throw new SteamNetworkError("Steam RSA 公钥无效。", false);
  if (message.length > modulusLength - 11) throw new SteamNetworkError("Steam 密码过长，无法使用服务器公钥加密。", false);
  const encoded = new Uint8Array(modulusLength);
  encoded[0] = 0;
  encoded[1] = 2;
  const paddingLength = modulusLength - message.length - 3;
  fillNonZeroRandom(encoded.subarray(2, 2 + paddingLength));
  encoded[2 + paddingLength] = 0;
  encoded.set(message, 3 + paddingLength);
  const encrypted = modPow(bytesToBigInt(encoded), exponent, modulus);
  return encodeBase64(bigIntToBytes(encrypted, modulusLength));
}

function buildDeviceDetails(): SteamProtoWriter {
  const details = new SteamProtoWriter();
  details.writeString(1, "Monica Browser Extension");
  details.writeVarint(2, 3);
  details.writeVarint(3, -500);
  details.writeVarint(4, 528);
  return details;
}

function responseObject(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.response;
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : payload;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function fieldString(field?: SteamProtoField): string {
  return field?.bytes ? new TextDecoder().decode(field.bytes) : "";
}

function fieldUnsignedBigInt(field?: SteamProtoField): bigint | undefined {
  if (field?.varint !== undefined) return field.varint;
  if (!field?.bytes || field.bytes.length !== 8) return undefined;
  let value = 0n;
  for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(field.bytes[index]);
  return value;
}

function validateAccountName(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new SteamNetworkError("请输入有效的 Steam 账号名。", false);
  return normalized;
}

function validatePassword(value: string): string {
  const normalized = String(value || "");
  if (!normalized || normalized.length > 1_024) throw new SteamNetworkError("请输入有效的 Steam 密码。", false);
  return normalized;
}

function validateUint64(value: string, label: string): bigint {
  const normalized = String(value || "").trim();
  if (!/^\d+$/.test(normalized)) throw new SteamNetworkError(`${label} 无效。`, false);
  const parsed = BigInt(normalized);
  if (parsed < 0n || parsed > UINT64_MAX) throw new SteamNetworkError(`${label} 无效。`, false);
  return parsed;
}

function normalizeHex(value: string, label: string): string {
  const normalized = String(value || "").trim().replace(/^0x/i, "").replace(/^0+/, "") || "0";
  if (!/^[0-9a-f]+$/i.test(normalized)) throw new SteamNetworkError(`${label} 无效。`, false);
  return normalized;
}

function fillNonZeroRandom(target: Uint8Array): void {
  for (let index = 0; index < target.length; index++) {
    let value = 0;
    while (!value) value = crypto.getRandomValues(new Uint8Array(1))[0];
    target[index] = value;
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index--) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining) throw new SteamNetworkError("Steam RSA 密文超出模数长度。", false);
  return bytes;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let factor = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = result * factor % modulus;
    factor = factor * factor % modulus;
    power >>= 1n;
  }
  return result;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}
