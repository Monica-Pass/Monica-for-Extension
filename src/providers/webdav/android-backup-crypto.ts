import { base64ToBytes, bytesToBase64, randomBytes } from "../../security/encoding";
import { DEFAULT_ZIP_SAFETY_LIMITS } from "./zip-safety";

export const ANDROID_BACKUP_MAGIC = "MONICA_ENC_V1";
const MAGIC_BYTES = new TextEncoder().encode(ANDROID_BACKUP_MAGIC);
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const ITERATIONS = 100_000;
export const MAX_ANDROID_BACKUP_PLAINTEXT_BYTES = DEFAULT_ZIP_SAFETY_LIMITS.maxArchiveBytes;

export function isAndroidEncryptedBackup(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC_BYTES.length) return false;
  return MAGIC_BYTES.every((value, index) => bytes[index] === value);
}

export async function encryptAndroidBackup(
  plaintext: Uint8Array,
  password: string,
  randomness: (length: number) => Uint8Array = randomBytes,
  maximumPlaintextBytes = MAX_ANDROID_BACKUP_PLAINTEXT_BYTES
): Promise<Uint8Array> {
  if (!password) throw new Error("备份加密密码不能为空。");
  assertMaximumSize(plaintext.length, maximumPlaintextBytes, "Monica Android 备份明文");
  const salt = randomness(SALT_LENGTH);
  const iv = randomness(IV_LENGTH);
  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH) throw new Error("Invalid Android backup random source");
  const key = await deriveAndroidBackupKey(password, salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 }, key, plaintext as BufferSource));
  return concatBytes(MAGIC_BYTES, salt, iv, encrypted);
}

export async function decryptAndroidBackup(bytes: Uint8Array, password: string, maximumPlaintextBytes = MAX_ANDROID_BACKUP_PLAINTEXT_BYTES): Promise<Uint8Array> {
  assertMaximumSize(bytes.length, maximumPlaintextBytes + MAGIC_BYTES.length + SALT_LENGTH + IV_LENGTH + 16, "Monica Android 加密备份");
  if (!isAndroidEncryptedBackup(bytes)) {
    assertMaximumSize(bytes.length, maximumPlaintextBytes, "Monica Android 备份");
    return bytes;
  }
  const minimumSize = MAGIC_BYTES.length + SALT_LENGTH + IV_LENGTH + 16;
  if (bytes.length < minimumSize) throw new Error("Monica Android 加密备份不完整。");
  if (!password) throw new Error("此 Monica Android 备份需要解密密码。");
  let offset = MAGIC_BYTES.length;
  const salt = bytes.slice(offset, (offset += SALT_LENGTH));
  const iv = bytes.slice(offset, (offset += IV_LENGTH));
  const ciphertext = bytes.slice(offset);
  try {
    const key = await deriveAndroidBackupKey(password, salt);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 }, key, ciphertext));
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

async function deriveAndroidBackupKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
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
