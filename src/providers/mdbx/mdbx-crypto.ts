import { base64ToBytes, bytesToBase64, randomBytes } from "../../security/encoding";

/**
 * Port of Android `MdbxVaultCrypto.kt` (SHA 9930d8d8). That file is the only authority: the MDBX
 * security spec and the `MdbxTigaMode` KDoc both describe Argon2id + XChaCha20, which the shipped
 * code does not use. Deriving from the docs instead of the code would produce vaults Android cannot
 * open.
 */
const FIELD_PREFIX = "mdbx:v1:";
const VERIFIER_LABEL = "Monica Database eXtended credential verifier v1";
const KEY_FILE_MAGIC = "MONICA-MDBX-KEY-FILE-V1";
const DEFAULT_ITERATIONS = 210_000;
const MIN_ITERATIONS = 50_000;
const MAX_ITERATIONS = 1_000_000;

export type MdbxUnlockMethod = "password" | "key_file" | "password+key_file" | "device_key";
export type MdbxTigaMode = "POWER" | "MULTI" | "SKY";

export interface MdbxCredential {
  unlockMethod: MdbxUnlockMethod;
  password?: string;
  keyFile?: Uint8Array;
}

const TIGA_ITERATIONS: Record<MdbxTigaMode, number> = { POWER: 360_000, MULTI: 210_000, SKY: 90_000 };

export function mdbxUnlockMethodFrom(value: unknown): MdbxUnlockMethod {
  if (typeof value !== "string") return "password";
  const normalized = value.toLowerCase();
  if (normalized === "key_file" || normalized === "keyfile") return "key_file";
  if (normalized === "password+key_file" || normalized === "master_password_and_key_file") return "password+key_file";
  if (normalized === "device_key") return "device_key";
  return "password";
}

export function mdbxKdfProfileFor(tigaMode: MdbxTigaMode): string {
  return `pbkdf2-sha256:${TIGA_ITERATIONS[tigaMode]}`;
}

/**
 * Android clamps only the lower bound. The upper bound is ours: `kdf_profile_id` comes from an
 * untrusted file, and PBKDF2 runs on the main thread of an extension page.
 */
export function mdbxIterationsFrom(profile: unknown): number {
  if (typeof profile !== "string") return DEFAULT_ITERATIONS;
  const parsed = Number.parseInt(profile.split("pbkdf2-sha256:")[1] ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_ITERATIONS;
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, parsed));
}

export function isMdbxKeyFile(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, KEY_FILE_MAGIC.length)) === KEY_FILE_MAGIC;
}

export function generateMdbxKeyFile(): Uint8Array {
  const magic = new TextEncoder().encode(`${KEY_FILE_MAGIC}\n`);
  const bytes = new Uint8Array(magic.length + 64);
  bytes.set(magic);
  bytes.set(randomBytes(64), magic.length);
  return bytes;
}

export function assertMdbxCredentialShape(credential: MdbxCredential): void {
  const needsPassword = credential.unlockMethod === "password" || credential.unlockMethod === "password+key_file";
  const needsKeyFile = credential.unlockMethod === "key_file" || credential.unlockMethod === "password+key_file";
  if (needsPassword && !credential.password) throw new Error("此 MDBX 数据库需要主密码。");
  if (needsKeyFile && !credential.keyFile) throw new Error("此 MDBX 数据库需要密钥文件。");
}

/**
 * Three details here are load-bearing and none are guessable from the field names:
 * the separator is a single 0x00 byte, `unlockMethod` itself is hashed (so changing the unlock
 * method changes the key), and PBKDF2's password input is the *Base64 text* of the material hash
 * rather than its bytes.
 */
export async function deriveMdbxCredentialKey(credential: MdbxCredential, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  assertMdbxCredentialShape(credential);
  const encoder = new TextEncoder();
  const method = encoder.encode(credential.unlockMethod);
  const password = encoder.encode(credential.password || "");
  const keyFileHash = credential.keyFile
    ? new Uint8Array(await crypto.subtle.digest("SHA-256", credential.keyFile as BufferSource))
    : new Uint8Array(32);

  const material = new Uint8Array(method.length + 1 + password.length + 1 + keyFileHash.length);
  material.set(method);
  material.set(password, method.length + 1);
  material.set(keyFileHash, method.length + 1 + password.length + 1);

  const materialHash = new Uint8Array(await crypto.subtle.digest("SHA-256", material as BufferSource));
  const pbkdf2Password = encoder.encode(bytesToBase64(materialHash));
  const key = await crypto.subtle.importKey("raw", pbkdf2Password as BufferSource, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256));
}

export async function mdbxVerifier(credentialKey: Uint8Array, vaultId: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", credentialKey as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${VERIFIER_LABEL}:${vaultId}`) as BufferSource);
  return new Uint8Array(signature);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

/** The epoch-key envelope uses `nonce`/`ct`; field ciphertext uses `n`/`c`. Not a typo — verified. */
export async function unwrapMdbxEpochKey(credentialKey: Uint8Array, wrapped: Uint8Array): Promise<Uint8Array> {
  const envelope = JSON.parse(new TextDecoder().decode(wrapped)) as Record<string, unknown>;
  if (typeof envelope.nonce !== "string" || typeof envelope.ct !== "string") throw new Error("MDBX 密钥信封格式无效。");
  return new Uint8Array(await aesGcm("decrypt", credentialKey, base64ToBytes(envelope.nonce), base64ToBytes(envelope.ct)));
}

export async function wrapMdbxEpochKey(credentialKey: Uint8Array, epochKey: Uint8Array): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const ciphertext = await aesGcm("encrypt", credentialKey, nonce, epochKey);
  const envelope = { v: 1, alg: "AES-256-GCM", nonce: bytesToBase64(nonce), ct: bytesToBase64(new Uint8Array(ciphertext)) };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export function isMdbxEncryptedField(value: Uint8Array): boolean {
  return new TextDecoder().decode(value.subarray(0, FIELD_PREFIX.length)) === FIELD_PREFIX;
}

/**
 * A `_ct` column may hold plaintext: Android writes raw UTF-8 whenever no epoch key is loaded, so a
 * column can legitimately mix both forms. Sniff the prefix rather than assuming ciphertext.
 */
export async function decryptMdbxField(epochKey: Uint8Array | undefined, value: Uint8Array): Promise<string> {
  const raw = new TextDecoder().decode(value);
  if (!raw.startsWith(FIELD_PREFIX)) return raw;
  if (!epochKey) throw new Error("MDBX 加密字段需要已解锁的密钥。");
  const envelope = JSON.parse(raw.slice(FIELD_PREFIX.length)) as Record<string, unknown>;
  if (typeof envelope.n !== "string" || typeof envelope.c !== "string") throw new Error("MDBX 字段密文格式无效。");
  const plaintext = await aesGcm("decrypt", epochKey, base64ToBytes(envelope.n), base64ToBytes(envelope.c));
  return new TextDecoder().decode(plaintext);
}

export async function encryptMdbxField(epochKey: Uint8Array | undefined, value: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  if (!epochKey) return encoder.encode(value);
  const nonce = randomBytes(12);
  const ciphertext = await aesGcm("encrypt", epochKey, nonce, encoder.encode(value));
  const envelope = JSON.stringify({ n: bytesToBase64(nonce), c: bytesToBase64(new Uint8Array(ciphertext)) });
  return encoder.encode(`${FIELD_PREFIX}${envelope}`);
}

async function aesGcm(operation: "encrypt" | "decrypt", rawKey: Uint8Array, nonce: Uint8Array, data: Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", rawKey as BufferSource, { name: "AES-GCM", length: 256 }, false, [operation]);
  const parameters: AesGcmParams = { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 };
  return operation === "encrypt"
    ? crypto.subtle.encrypt(parameters, key, data as BufferSource)
    : crypto.subtle.decrypt(parameters, key, data as BufferSource);
}
