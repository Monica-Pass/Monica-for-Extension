import type { VaultState } from "../core/model";
import { base64ToBytes, bytesToBase64, randomBytes } from "./encoding";

const AAD = new TextEncoder().encode("monica-extension-vault-envelope-v1");
const DEFAULT_ITERATIONS = 600_000;
const MAX_ITERATIONS = 10_000_000;
const MAX_VAULT_CIPHERTEXT_BYTES = 64 * 1024 * 1024;

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
  if (kdf.name !== "PBKDF2-SHA256" || !Number.isInteger(kdf.iterations) || kdf.iterations < 100_000 || kdf.iterations > MAX_ITERATIONS) throw new Error("Unsupported or unsafe vault KDF parameters");
  let salt: Uint8Array;
  try {
    salt = base64ToBytes(kdf.salt);
  } catch {
    throw new Error("Vault KDF salt is invalid");
  }
  if (salt.length < 16 || salt.length > 64) throw new Error("Vault KDF salt is invalid");

  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(masterPassword), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: kdf.iterations },
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
  if ((state as Partial<VaultState>).providerConflicts === undefined) state.providerConflicts = [];
  if ((state as Partial<VaultState>).providerDiagnostics === undefined) state.providerDiagnostics = [];
  if (
    state.magic !== "MONICA_EXTENSION_VAULT" ||
    state.schemaVersion !== 1 ||
    !Array.isArray(state.items) ||
    !Array.isArray(state.providers) ||
    !Array.isArray(state.mutationQueue) ||
    !Array.isArray(state.providerConflicts) ||
    state.providerConflicts.length > 1_000 ||
    !state.providerConflicts.every(validProviderConflict) ||
    !Array.isArray(state.providerDiagnostics) ||
    state.providerDiagnostics.length > 100 ||
    !state.providerDiagnostics.every(validProviderDiagnostic) ||
    !state.settings ||
    typeof state.settings.defaultProviderId !== "string" ||
    !Number.isInteger(state.settings.autoLockMinutes) ||
    state.settings.autoLockMinutes < 1 ||
    state.settings.autoLockMinutes > 1440 ||
    !state.providers.some((provider) => provider.id === state.settings.defaultProviderId)
  ) {
    throw new Error("Vault payload is invalid or unsupported");
  }
  return state;
}

function validProviderDiagnostic(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
  return typeof diagnostic.at === "string" && typeof diagnostic.providerRef === "string" && typeof diagnostic.kind === "string"
    && typeof diagnostic.operation === "string" && typeof diagnostic.outcome === "string" && typeof diagnostic.code === "string"
    && typeof diagnostic.retryable === "boolean" && Number.isInteger(diagnostic.attempts) && typeof diagnostic.message === "string";
}

function validProviderConflict(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const conflict = value as Record<string, unknown>;
  return typeof conflict.id === "string" && typeof conflict.providerId === "string" && typeof conflict.itemId === "string"
    && typeof conflict.reason === "string" && typeof conflict.detectedAt === "string"
    && (conflict.local === undefined || Boolean(conflict.local) && typeof conflict.local === "object" && !Array.isArray(conflict.local))
    && (conflict.remote === undefined || Boolean(conflict.remote) && typeof conflict.remote === "object" && !Array.isArray(conflict.remote));
}

export async function exportVaultKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64(new Uint8Array(raw));
}

export async function importVaultKey(rawKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(rawKey) as BufferSource, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

function validateEnvelope(value: VaultEnvelope): void {
  if (!value || value.version !== 1 || value.cipher !== "AES-256-GCM" || value.kdf?.name !== "PBKDF2-SHA256" || typeof value.iv !== "string" || typeof value.ciphertext !== "string" || value.ciphertext.length > MAX_VAULT_CIPHERTEXT_BYTES * 2) {
    throw new Error("Vault envelope is invalid or unsupported");
  }
  try {
    const iv = base64ToBytes(value.iv);
    const ciphertext = base64ToBytes(value.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_VAULT_CIPHERTEXT_BYTES) throw new Error("invalid length");
  } catch {
    throw new Error("Vault envelope is invalid or unsupported");
  }
}
