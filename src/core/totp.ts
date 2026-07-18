import { md5 } from "hash-wasm";
import { generateSteamCode } from "./steam-totp";

export type OtpType = "TOTP" | "HOTP" | "STEAM" | "YANDEX" | "MOTP";
export type OtpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpParameters {
  secret: string;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  otpType?: OtpType;
  counter?: number;
  pin?: string;
  issuer?: string;
  accountName?: string;
  label?: string;
  secretEncoding?: "base32" | "base64";
}

export interface OtpParseResult {
  parameters: TotpParameters;
  label: string;
  accountName: string;
}

export async function generateTotp(input: string, now = Date.now()): Promise<string> {
  return generateOtpWithParameters(parseTotpParameters(input), now);
}

export async function generateOtpWithParameters(parameters: TotpParameters, now = Date.now()): Promise<string> {
  const normalized = normalizeParameters(parameters);
  switch (normalized.otpType) {
    case "HOTP":
      return generateHotp(normalized, normalized.counter);
    case "STEAM":
      return generateSteamCode(
        normalized.secretEncoding === "base32" ? bytesToBase64(decodeBase32(normalized.secret)) : normalized.secret,
        now
      );
    case "MOTP":
      return generateMobileOtp(normalized.secret, normalized.pin || "", now);
    case "YANDEX":
    case "TOTP":
      return generateTimeOtp(normalized, now);
  }
}

export async function generateTotpWithParameters(parameters: TotpParameters, now = Date.now()): Promise<string> {
  return generateTimeOtp(normalizeParameters({ ...parameters, otpType: "TOTP" }), now);
}

export async function generateHotp(parameters: TotpParameters, counter = parameters.counter || 0): Promise<string> {
  const normalized = normalizeParameters({ ...parameters, otpType: "HOTP", counter });
  return generateHmacCode(normalized.secret, normalized.counter || 0, normalized.algorithm, normalized.digits);
}

export async function generateMobileOtp(secret: string, pin: string, now = Date.now()): Promise<string> {
  if (!secret) throw new Error("mOTP 密钥为空。");
  const epoch = Math.floor(now / 1000 / 10);
  const digest = await md5(`${epoch}${secret}${pin}`);
  return digest.replace(/\D/g, "").slice(0, 6).padEnd(6, "0");
}

export function otpSecondsRemaining(parameters: TotpParameters, now = Date.now()): number {
  const normalized = normalizeParameters(parameters);
  if (normalized.otpType === "HOTP") return 0;
  const period = normalized.otpType === "MOTP" ? 10 : normalized.otpType === "STEAM" ? 30 : normalized.period;
  return period - Math.floor(now / 1000) % period;
}

export function parseTotpParameters(input: string): TotpParameters {
  const parsed = parseOtpUris(input);
  if (parsed.length !== 1) throw new Error("OTP 内容必须只包含一个验证器。");
  return parsed[0].parameters;
}

export function parseOtpUris(input: string): OtpParseResult[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("OTP 密钥为空。");
  if (/^otpauth-migration:\/\//i.test(trimmed)) return parseMigrationUri(trimmed);
  if (/^motp:\/\//i.test(trimmed)) return [parseMotpUri(trimmed)];
  if (/^otpauth:\/\//i.test(trimmed)) return [parseOtpAuthUri(trimmed)];
  return [{
    parameters: normalizeParameters({ secret: trimmed, algorithm: "SHA1", digits: 6, period: 30, otpType: "TOTP", secretEncoding: "base32" }),
    label: "",
    accountName: ""
  }];
}

export function generateOtpUri(parameters: TotpParameters, label?: string): string {
  const value = normalizeParameters(parameters);
  const resolvedLabel = label || value.label || [value.issuer, value.accountName].filter(Boolean).join(":") || "OTP";
  if (value.otpType === "MOTP") {
    const issuer = value.issuer || resolvedLabel.split(":", 1)[0] || "mOTP";
    const accountName = value.accountName || (resolvedLabel.includes(":") ? resolvedLabel.slice(resolvedLabel.indexOf(":") + 1) : "");
    return `motp://${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${encodeURIComponent(value.secret)}`;
  }
  const authority = value.otpType === "HOTP" ? "hotp" : value.otpType === "YANDEX" ? "yaotp" : "totp";
  const query = new URLSearchParams();
  const secret = value.otpType === "STEAM" && value.secretEncoding !== "base32"
    ? encodeBase32(base64ToBytes(value.secret))
    : value.secret.replace(/[\s=-]/g, "").toUpperCase();
  query.set("secret", secret);
  if (value.issuer) query.set("issuer", value.issuer);
  if (value.otpType === "HOTP") query.set("counter", String(value.counter || 0));
  if (value.otpType !== "HOTP" && value.period !== 30) query.set("period", String(value.period));
  if (value.digits !== 6) query.set("digits", String(value.digits));
  if (value.algorithm !== "SHA1") query.set("algorithm", value.algorithm);
  if (value.otpType === "STEAM") query.set("encoder", "steam");
  return `otpauth://${authority}/${encodeURIComponent(resolvedLabel)}?${query.toString()}`;
}

async function generateTimeOtp(parameters: RequiredOtpParameters, now: number): Promise<string> {
  const counter = Math.floor(now / 1000 / parameters.period);
  return generateHmacCode(parameters.secret, counter, parameters.algorithm, parameters.digits);
}

async function generateHmacCode(secret: string, counter: number, algorithm: OtpAlgorithm, digits: number): Promise<string> {
  const message = new Uint8Array(8);
  let remaining = Math.max(0, Math.floor(counter));
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const key = await crypto.subtle.importKey("raw", decodeBase32(secret) as BufferSource, { name: "HMAC", hash: `SHA-${algorithm.slice(3)}` }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24) | ((signature[offset + 1] & 0xff) << 16) | ((signature[offset + 2] & 0xff) << 8) | (signature[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

type RequiredOtpParameters = TotpParameters & { otpType: OtpType; algorithm: OtpAlgorithm; digits: number; period: number; counter: number; pin: string };

function normalizeParameters(parameters: TotpParameters): RequiredOtpParameters {
  const otpType = parameters.otpType || "TOTP";
  const secret = parameters.secret.trim();
  if (!secret) throw new Error("OTP 密钥为空。");
  const algorithm = normalizeAlgorithm(parameters.algorithm);
  const digits = otpType === "STEAM" ? 5 : integerInRange(parameters.digits, 6, 1, 10, "OTP 位数无效。");
  const period = otpType === "MOTP" ? 10 : otpType === "STEAM" ? 30 : integerInRange(parameters.period, 30, 5, 300, "OTP 周期无效。");
  const counter = integerInRange(parameters.counter, 0, 0, Number.MAX_SAFE_INTEGER, "HOTP 计数器无效。");
  return { ...parameters, secret, otpType, algorithm, digits, period, counter, pin: parameters.pin || "" };
}

function parseOtpAuthUri(input: string): OtpParseResult {
  const url = new URL(input);
  const authority = url.hostname.toLowerCase();
  if (authority !== "totp" && authority !== "hotp" && authority !== "yaotp") throw new Error("不支持的 OTP URI 类型。");
  const secret = url.searchParams.get("secret")?.trim() || "";
  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const accountName = label.includes(":") ? label.slice(label.indexOf(":") + 1) : label;
  const issuer = url.searchParams.get("issuer")?.trim() || (label.includes(":") ? label.slice(0, label.indexOf(":")).trim() : "");
  const encoder = url.searchParams.get("encoder")?.toLowerCase();
  const otpType: OtpType = authority === "hotp" ? "HOTP" : authority === "yaotp" || issuer.toLowerCase().includes("yandex") ? "YANDEX" : encoder === "steam" || issuer.toLowerCase().includes("steam") ? "STEAM" : "TOTP";
  const parameters = normalizeParameters({
    secret,
    algorithm: normalizeAlgorithm(url.searchParams.get("algorithm")),
    digits: numberParameter(url.searchParams.get("digits"), otpType === "STEAM" ? 5 : 6),
    period: numberParameter(url.searchParams.get("period"), 30),
    counter: numberParameter(url.searchParams.get("counter"), 0),
    otpType,
    issuer,
    accountName,
    label,
    secretEncoding: "base32"
  });
  return { parameters, label, accountName };
}

function parseMotpUri(input: string): OtpParseResult {
  const match = decodeURIComponent(input).match(/^motp:\/\/(.*?):(.*?)\?(.*)$/i);
  if (!match) throw new Error("mOTP URI 无效。");
  const query = new URLSearchParams(match[3]);
  const issuer = decodeURIComponent(match[1]).trim();
  const accountName = decodeURIComponent(match[2]).trim();
  const label = accountName ? `${issuer || accountName}:${accountName}` : issuer || "mOTP";
  const parameters = normalizeParameters({ secret: query.get("secret") || "", algorithm: "SHA1", digits: 6, period: 10, otpType: "MOTP", issuer: issuer || accountName || "mOTP", accountName, label, pin: query.get("pin") || "" });
  return { parameters, label, accountName };
}

function parseMigrationUri(input: string): OtpParseResult[] {
  const encoded = new URL(input).searchParams.get("data");
  if (!encoded) throw new Error("Google Authenticator migration 数据为空。");
  const reader = new ProtoReader(base64ToBytes(encoded.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/")));
  const results: OtpParseResult[] = [];
  while (!reader.done) {
    const tag = reader.varint();
    if (tag == null) break;
    if ((tag >>> 3) === 1 && (tag & 7) === 2) {
      const bytes = reader.bytes();
      if (bytes) {
        const parsed = parseMigrationItem(bytes);
        if (parsed) results.push(parsed);
      }
    } else if (!reader.skip(tag & 7)) break;
  }
  if (!results.length) throw new Error("Google Authenticator migration 数据无有效项目。");
  return results;
}

function parseMigrationItem(bytes: Uint8Array): OtpParseResult | null {
  const reader = new ProtoReader(bytes);
  let secret: Uint8Array<ArrayBufferLike> = new Uint8Array(); let accountName = ""; let issuer = ""; let algorithm = 1; let digits = 1; let type = 2; let counter = 0;
  while (!reader.done) {
    const tag = reader.varint(); if (tag == null) break;
    const field = tag >>> 3; const wire = tag & 7;
    if (field === 1 && wire === 2) secret = reader.bytes() || new Uint8Array();
    else if ((field === 2 || field === 3) && wire === 2) { const value = reader.bytes(); const text = value ? new TextDecoder().decode(value) : ""; if (field === 2) accountName = text; else issuer = text; }
    else if ((field >= 4 && field <= 7) && wire === 0) { const value = reader.varint() || 0; if (field === 4) algorithm = value; else if (field === 5) digits = value; else if (field === 6) type = value; else counter = value; }
    else if (!reader.skip(wire)) return null;
  }
  if (!secret.length || (type !== 1 && type !== 2) || ![1, 2, 3].includes(algorithm)) return null;
  if (!issuer.trim()) { issuer = accountName.trim(); accountName = ""; }
  if (!issuer) return null;
  if (accountName.startsWith(`${issuer}: `)) accountName = accountName.slice(issuer.length + 2).trim();
  const label = accountName ? `${issuer}:${accountName}` : issuer;
  const parameters = normalizeParameters({ secret: encodeBase32(secret), algorithm: algorithm === 2 ? "SHA256" : algorithm === 3 ? "SHA512" : "SHA1", digits: digits === 2 ? 8 : 6, period: 30, otpType: type === 1 ? "HOTP" : "TOTP", counter, issuer, accountName, label, secretEncoding: "base32" });
  return { parameters, label, accountName };
}

class ProtoReader {
  private position = 0;
  constructor(private readonly data: Uint8Array) {}
  get done() { return this.position >= this.data.length; }
  varint(): number | null { let result = 0; let shift = 0; while (shift < 53 && this.position < this.data.length) { const byte = this.data[this.position++]; result += (byte & 0x7f) * 2 ** shift; if ((byte & 0x80) === 0) return result; shift += 7; } return null; }
  bytes(): Uint8Array | null { const length = this.varint(); if (length == null || length < 0 || this.position + length > this.data.length) return null; const result = this.data.slice(this.position, this.position + length); this.position += length; return result; }
  skip(wire: number): boolean { if (wire === 0) return this.varint() != null; if (wire === 1) return this.advance(8); if (wire === 2) { const length = this.varint(); return length != null && this.advance(length); } if (wire === 5) return this.advance(4); return false; }
  private advance(length: number): boolean { if (length < 0 || this.position + length > this.data.length) return false; this.position += length; return true; }
}

function normalizeAlgorithm(value: unknown): OtpAlgorithm {
  const normalized = String(value || "SHA1").replace(/-/g, "").toUpperCase();
  return normalized === "SHA256" || normalized === "SHA512" ? normalized : "SHA1";
}

function integerInRange(value: unknown, fallback: number, min: number, max: number, error: string): number {
  const parsed = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(error);
  return parsed;
}

function numberParameter(value: string | null, fallback: number): number { return value == null || value === "" ? fallback : Number(value); }

export function decodeBase32(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || [...normalized].some((character) => !alphabet.includes(character))) throw new Error("OTP Base32 密钥无效。");
  const bytes: number[] = [];
  let buffer = 0; let bits = 0;
  for (const character of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 0xff); }
  }
  return Uint8Array.from(bytes);
}

export function encodeBase32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let output = ""; let buffer = 0; let bits = 0;
  for (const byte of bytes) { buffer = (buffer << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; output += alphabet[(buffer >>> bits) & 31]; } }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try { return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); } catch { throw new Error("Base64 数据无效。"); }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary);
}
