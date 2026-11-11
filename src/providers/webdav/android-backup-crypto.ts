import { base64ToBytes, bytesToBase64, randomBytes } from "../../security/encoding";
import { DEFAULT_ZIP_SAFETY_LIMITS } from "./zip-safety";

export const ANDROID_BACKUP_MAGIC = "MONICA_ENC_V1";
export const ANDROID_BACKUP_V2_MAGIC = "MONICA_ENC_V2";
export type AndroidBackupEncryptionFormat = "v1" | "v2";
const MAGIC_BYTES = new TextEncoder().encode(ANDROID_BACKUP_MAGIC);
const V2_MAGIC_BYTES = new TextEncoder().encode(ANDROID_BACKUP_V2_MAGIC);
const FAMILY_BYTES = new TextEncoder().encode("MONICA_ENC_V");
// Fixed interoperable profile; never derive with an attacker-selected cost or length.
const V2_PROFILE = Uint8Array.of(1, 1, 0, 0, 9, 0x27, 0xc0, 0, 32, 0, 12);
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const ITERATIONS = 100_000;
const V2_ITERATIONS = 600_000;
const V1_HEADER_LENGTH = 57;
const V2_HEADER_LENGTH = 68;
const TAG_LENGTH = 16;
export const MAX_ANDROID_BACKUP_PLAINTEXT_BYTES = DEFAULT_ZIP_SAFETY_LIMITS.maxArchiveBytes;

export function isAndroidEncryptedBackup(bytes: Uint8Array): boolean {
  // Include unknown versions so callers cannot reinterpret them as plaintext ZIP/JSON.
  return startsWith(bytes, FAMILY_BYTES);
}

export function getAndroidBackupEncryptionFormat(bytes: Uint8Array): AndroidBackupEncryptionFormat | undefined {
  if (!isAndroidEncryptedBackup(bytes)) return undefined;
  if (startsWith(bytes, MAGIC_BYTES)) return "v1";
  if (startsWith(bytes, V2_MAGIC_BYTES)) return "v2";
  throw new Error("不支持此 Monica Android 备份加密版本。");
}

export async function encryptAndroidBackup(
  plaintext: Uint8Array,
  password: string,
  randomness: (length: number) => Uint8Array = randomBytes,
  maximumPlaintextBytes = MAX_ANDROID_BACKUP_PLAINTEXT_BYTES,
  format: AndroidBackupEncryptionFormat = "v1"
): Promise<Uint8Array> {
  if (format !== "v1" && format !== "v2") throw new Error("不支持此 Monica Android 备份加密版本。");
  if (!password) throw new Error("备份加密密码不能为空。");
  assertMaximumSize(plaintext.length, maximumPlaintextBytes, "Monica Android 备份明文");
  if (format === "v2") assertWellFormedPassword(password);
  const salt = randomness(SALT_LENGTH);
  const iv = randomness(IV_LENGTH);
  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH) throw new Error("Invalid Android backup random source");
  const header = format === "v2" ? concatBytes(V2_MAGIC_BYTES, V2_PROFILE, salt, iv) : concatBytes(MAGIC_BYTES, salt, iv);
  const key = await deriveAndroidBackupKey(password, salt, format);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, tagLength: 128,
    ...(format === "v2" ? { additionalData: header as BufferSource } : {}) }, key, plaintext as BufferSource));
  return concatBytes(header, encrypted);
}

export async function decryptAndroidBackup(bytes: Uint8Array, password: string, maximumPlaintextBytes = MAX_ANDROID_BACKUP_PLAINTEXT_BYTES): Promise<Uint8Array> {
  assertMaximumSize(0, maximumPlaintextBytes, "Monica Android 备份明文");
  const format = getAndroidBackupEncryptionFormat(bytes);
  if (!format) {
    assertMaximumSize(bytes.length, maximumPlaintextBytes, "Monica Android 备份");
    return bytes;
  }
  const headerLength = format === "v2" ? V2_HEADER_LENGTH : V1_HEADER_LENGTH;
  assertMaximumSize(bytes.length, maximumPlaintextBytes + headerLength + TAG_LENGTH, "Monica Android 加密备份");
  const minimumSize = headerLength + TAG_LENGTH;
  if (bytes.length < minimumSize) throw new Error("Monica Android 加密备份不完整。");
  if (format === "v2" && !V2_PROFILE.every((value, index) => bytes[MAGIC_BYTES.length + index] === value)) {
    throw new Error("不支持此 Monica Android 备份加密参数。");
  }
  if (!password) throw new Error("此 Monica Android 备份需要解密密码。");
  if (format === "v2") assertWellFormedPassword(password);
  let offset = MAGIC_BYTES.length + (format === "v2" ? V2_PROFILE.length : 0);
  const salt = bytes.slice(offset, (offset += SALT_LENGTH));
  const iv = bytes.slice(offset, (offset += IV_LENGTH));
  const ciphertext = bytes.slice(offset);
  const header = bytes.slice(0, headerLength);
  try {
    const key = await deriveAndroidBackupKey(password, salt, format);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, tagLength: 128,
      ...(format === "v2" ? { additionalData: header as BufferSource } : {}) }, key, ciphertext));
    assertMaximumSize(plaintext.length, maximumPlaintextBytes, "Monica Android 备份明文");
    return plaintext;
  } catch {
    throw new Error("Monica Android 备份密码错误或文件已损坏。");
  }
}

function assertMaximumSize(actual: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Android 备份安全上限无效。");
  if (actual > maximum) throw new Error(`${label}超过安全上限。`);
}

export function androidEncryptedBackupToBase64(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}

export function androidEncryptedBackupFromBase64(value: string): Uint8Array {
  return base64ToBytes(value);
}

async function deriveAndroidBackupKey(password: string, salt: Uint8Array, format: AndroidBackupEncryptionFormat): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: format === "v2" ? V2_ITERATIONS : ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function assertWellFormedPassword(password: string): void {
  for (let index = 0; index < password.length; index++) {
    const code = password.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = password.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Monica Android 备份密码包含无效 Unicode 编码。");
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("Monica Android 备份密码包含无效 Unicode 编码。");
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
