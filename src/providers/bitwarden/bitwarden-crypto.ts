import { argon2id } from "hash-wasm";
import { base64ToBytes, bytesToBase64, randomBytes } from "../../security/encoding";

export type BitwardenKdfConfig =
  | { type: 0; iterations: number }
  | { type: 1; iterations: number; memoryMb: number; parallelism: number };

export interface BitwardenSymmetricKey {
  encKey: Uint8Array;
  macKey: Uint8Array;
}

export interface ParsedBitwardenCipherString {
  type: 0 | 2;
  iv: Uint8Array;
  data: Uint8Array;
  mac?: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const KEY_BYTES = 32;
const IV_BYTES = 16;
const MAX_CIPHER_STRING_LENGTH = 1024 * 1024;
const MAX_RSA_PRIVATE_KEY_BYTES = 64 * 1024;

export async function deriveBitwardenMasterKey(password: string, email: string, kdf: BitwardenKdfConfig): Promise<Uint8Array> {
  const normalizedEmail = normalizeBitwardenEmail(email);
  if (!password) throw new Error("Bitwarden 主密码不能为空。");
  if (kdf.type === 0) {
    assertIntegerRange(kdf.iterations, 1, 10_000_000, "PBKDF2 迭代次数");
    return pbkdf2(encoder.encode(password), encoder.encode(normalizedEmail), kdf.iterations, KEY_BYTES);
  }
  assertIntegerRange(kdf.iterations, 1, 20, "Argon2 迭代次数");
  assertIntegerRange(kdf.memoryMb, 1, 1024, "Argon2 内存");
  assertIntegerRange(kdf.parallelism, 1, 64, "Argon2 并行度");
  const saltHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(normalizedEmail)));
  return argon2id({
    password: encoder.encode(password),
    salt: saltHash,
    iterations: kdf.iterations,
    memorySize: kdf.memoryMb * 1024,
    parallelism: kdf.parallelism,
    hashLength: KEY_BYTES,
    outputType: "binary"
  });
}

export async function deriveBitwardenMasterPasswordHash(masterKey: Uint8Array, password: string): Promise<string> {
  return bytesToBase64(await pbkdf2(masterKey, encoder.encode(password), 1, KEY_BYTES));
}

export async function stretchBitwardenMasterKey(masterKey: Uint8Array): Promise<BitwardenSymmetricKey> {
  return {
    encKey: await hkdfExpand(masterKey, encoder.encode("enc"), KEY_BYTES),
    macKey: await hkdfExpand(masterKey, encoder.encode("mac"), KEY_BYTES)
  };
}

export function parseBitwardenCipherString(value: string): ParsedBitwardenCipherString {
  if (!value || value.length > MAX_CIPHER_STRING_LENGTH) throw new Error("Bitwarden CipherString 为空或过大。");
  const dot = value.indexOf(".");
  const typeValue = dot < 0 ? 0 : Number(value.slice(0, dot));
  if (typeValue !== 0 && typeValue !== 2) throw new Error(`不支持的 Bitwarden CipherString 类型：${typeValue}`);
  const parts = (dot < 0 ? value : value.slice(dot + 1)).split("|");
  if (parts.length < (typeValue === 2 ? 3 : 2)) throw new Error("Bitwarden CipherString 结构不完整。");
  const iv = decodeCipherPart(parts[0]);
  const data = decodeCipherPart(parts[1]);
  const mac = typeValue === 2 ? decodeCipherPart(parts[2]) : undefined;
  if (iv.length !== IV_BYTES || !data.length || data.length % IV_BYTES !== 0 || (mac && mac.length !== 32)) throw new Error("Bitwarden CipherString 长度无效。");
  return { type: typeValue, iv, data, mac };
}

export async function decryptBitwardenBytes(value: string, key: BitwardenSymmetricKey): Promise<Uint8Array> {
  validateSymmetricKey(key);
  const parsed = parseBitwardenCipherString(value);
  if (parsed.type === 2) {
    const expected = await hmacSha256(key.macKey, concatBytes(parsed.iv, parsed.data));
    if (!parsed.mac || !constantTimeEqual(expected, parsed.mac)) throw new Error("Bitwarden CipherString MAC 校验失败。");
  }
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key.encKey as BufferSource, { name: "AES-CBC" }, false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: parsed.iv as BufferSource }, cryptoKey, parsed.data as BufferSource));
  } catch {
    throw new Error("Bitwarden CipherString 解密失败。");
  }
}

export async function decryptBitwardenString(value: string | null | undefined, key: BitwardenSymmetricKey): Promise<string> {
  if (!value) return "";
  return decoder.decode(await decryptBitwardenBytes(value, key));
}

export async function decryptBitwardenSymmetricKey(value: string, wrappingKey: BitwardenSymmetricKey): Promise<BitwardenSymmetricKey> {
  const bytes = await decryptBitwardenBytes(value, wrappingKey);
  if (bytes.length !== 64) throw new Error(`Bitwarden 对称密钥长度无效：${bytes.length}`);
  return { encKey: bytes.slice(0, 32), macKey: bytes.slice(32) };
}

export async function decryptBitwardenRsaBytes(value: string, privateKeyPkcs8: Uint8Array): Promise<Uint8Array> {
  if (!value || value.length > MAX_CIPHER_STRING_LENGTH) throw new Error("Bitwarden RSA CipherString 为空或过大。");
  if (privateKeyPkcs8.length < 64 || privateKeyPkcs8.length > MAX_RSA_PRIVATE_KEY_BYTES) throw new Error("Bitwarden RSA 私钥长度无效。");
  const dot = value.indexOf(".");
  const type = dot < 0 ? Number.NaN : Number(value.slice(0, dot));
  if (type !== 3 && type !== 4) throw new Error(`不支持的 Bitwarden RSA CipherString 类型：${Number.isFinite(type) ? type : "unknown"}`);
  const payload = value.slice(dot + 1);
  if (!payload || payload.includes("|")) throw new Error("Bitwarden RSA CipherString 结构不完整。");
  try {
    const encrypted = decodeCipherPart(payload);
    if (encrypted.length < 128 || encrypted.length > 1024) throw new Error("invalid RSA ciphertext length");
    const algorithm = { name: "RSA-OAEP", hash: type === 3 ? "SHA-256" : "SHA-1" } as const;
    const privateKey = await crypto.subtle.importKey("pkcs8", privateKeyPkcs8 as BufferSource, algorithm, false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, encrypted as BufferSource));
  } catch {
    throw new Error("Bitwarden RSA CipherString 解密失败。");
  }
}

export async function encryptBitwardenBytes(
  plaintext: Uint8Array,
  key: BitwardenSymmetricKey,
  randomness: (length: number) => Uint8Array = randomBytes
): Promise<string> {
  validateSymmetricKey(key);
  const iv = randomness(IV_BYTES);
  if (iv.length !== IV_BYTES) throw new Error("Bitwarden IV 长度无效。");
  const cryptoKey = await crypto.subtle.importKey("raw", key.encKey as BufferSource, { name: "AES-CBC" }, false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, cryptoKey, plaintext as BufferSource));
  const mac = await hmacSha256(key.macKey, concatBytes(iv, data));
  return `2.${bytesToBase64(iv)}|${bytesToBase64(data)}|${bytesToBase64(mac)}`;
}

export function encryptBitwardenString(plaintext: string, key: BitwardenSymmetricKey, randomness?: (length: number) => Uint8Array): Promise<string> {
  return encryptBitwardenBytes(encoder.encode(plaintext), key, randomness);
}

export function normalizeBitwardenEmail(email: string): string {
  const normalized = email.trim().toLocaleLowerCase("en-US");
  if (!normalized || !normalized.includes("@")) throw new Error("Bitwarden 邮箱地址无效。");
  return normalized;
}

async function pbkdf2(seed: Uint8Array, salt: Uint8Array, iterations: number, length: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", seed as BufferSource, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, length * 8));
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const output = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array();
  let offset = 0;
  for (let counter = 1; offset < length; counter += 1) {
    previous = await hmacSha256(prk, concatBytes(previous, info, Uint8Array.of(counter)));
    const take = Math.min(previous.length, length - offset);
    output.set(previous.subarray(0, take), offset);
    offset += take;
  }
  return output;
}

async function hmacSha256(key: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, value as BufferSource));
}

function decodeCipherPart(value: string): Uint8Array {
  if (!value || value.length > MAX_CIPHER_STRING_LENGTH) throw new Error("Bitwarden CipherString Base64 字段无效。");
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
}

function validateSymmetricKey(key: BitwardenSymmetricKey): void {
  if (key.encKey.length !== KEY_BYTES || key.macKey.length !== KEY_BYTES) throw new Error("Bitwarden 对称密钥长度无效。");
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function assertIntegerRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label}无效。`);
}
