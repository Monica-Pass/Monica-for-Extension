import type { VaultState } from "../core/model";
import { base64ToBytes, bytesToBase64, randomBytes } from "./encoding";

const AAD = new TextEncoder().encode("monica-extension-vault-envelope-v1");
const DEFAULT_ITERATIONS = 600_000;

export interface VaultKdfParameters {
  name: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
}

export interface VaultEnvelope {
  version: 1;
  kdf: VaultKdfParameters;
  cipher: "AES-256-GCM";
  iv: string;
  ciphertext: string;
  updatedAt: string;
}

export async function deriveVaultKey(masterPassword: string, parameters?: VaultKdfParameters): Promise<{ key: CryptoKey; kdf: VaultKdfParameters }> {
  if (!masterPassword) throw new Error("Master password is required");
  const kdf: VaultKdfParameters = parameters || {
    name: "PBKDF2-SHA256",
    iterations: DEFAULT_ITERATIONS,
    salt: bytesToBase64(randomBytes(32))
  };
  if (kdf.name !== "PBKDF2-SHA256" || kdf.iterations < 100_000) throw new Error("Unsupported or unsafe vault KDF parameters");

  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(masterPassword), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(kdf.salt) as BufferSource, iterations: kdf.iterations },
    material,
    256
  );
  const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  return { key, kdf };
}

export async function encryptVaultState(state: VaultState, key: CryptoKey, kdf: VaultKdfParameters): Promise<VaultEnvelope> {
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(state));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD as BufferSource, tagLength: 128 }, key, plaintext);
  return {
    version: 1,
    kdf,
    cipher: "AES-256-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    updatedAt: state.updatedAt
  };
}

export async function decryptVaultState(envelope: VaultEnvelope, key: CryptoKey): Promise<VaultState> {
  validateEnvelope(envelope);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) as BufferSource, additionalData: AAD as BufferSource, tagLength: 128 },
    key,
    base64ToBytes(envelope.ciphertext) as BufferSource
  );
  const state = JSON.parse(new TextDecoder().decode(decrypted)) as VaultState;
  if (state.magic !== "MONICA_EXTENSION_VAULT" || state.schemaVersion !== 1 || !Array.isArray(state.items)) {
    throw new Error("Vault payload is invalid or unsupported");
  }
  return state;
}

export async function exportVaultKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64(new Uint8Array(raw));
}

export async function importVaultKey(rawKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(rawKey) as BufferSource, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

function validateEnvelope(value: VaultEnvelope): void {
  if (value.version !== 1 || value.cipher !== "AES-256-GCM" || value.kdf?.name !== "PBKDF2-SHA256") {
    throw new Error("Vault envelope is invalid or unsupported");
  }
}
