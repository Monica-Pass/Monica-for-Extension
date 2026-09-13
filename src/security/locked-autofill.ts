import type { LoginItem, VaultItem, VaultState } from "../core/model";
import { base64ToBytes, bytesToBase64, randomBytes } from "./encoding";
import type { VaultEnvelope } from "./vault-crypto";

/** This is a device-local grant, never a provider field or a portable credential. */
export interface LockedAutofillSnapshot {
  logins: LoginItem[];
  blockedHosts: string[];
  blockedFieldSignatures: string[];
}

export interface LockedAutofillRecord {
  version: 1;
  envelopeDigest: string;
  key: CryptoKey;
  iv: string;
  ciphertext: string;
}

export interface LockedAutofillStorage {
  read(): Promise<LockedAutofillRecord | null>;
  write(record: LockedAutofillRecord | null): Promise<void>;
}

export function supportsLockedAutofill(item: VaultItem): item is LoginItem {
  return item.kind === "login" && (!item.loginType || item.loginType === "PASSWORD")
    && !item.deletedAt && !item.archivedAt && Boolean(item.password)
    && (item.uriRules?.length ? item.uriRules.some((rule) => rule.uri.trim() && rule.matchType !== "never") : item.uris.some((uri) => uri.trim()));
}

export function lockedAutofillSnapshot(state: VaultState): LockedAutofillSnapshot {
  const allowed = new Set(state.settings.lockedAutofillItemIds || []);
  const providers = new Map(state.providers.map((provider) => [provider.id, provider]));
  return {
    logins: state.items.filter(supportsLockedAutofill)
      .filter((item) => allowed.has(item.id) && item.providerRefs.every((ref) => providers.get(ref.providerId)?.enabled))
      .map((item) => ({
        // Deliberately project only the explicitly granted username/password.
        // OTPs, custom fields, notes, provider credentials and private keys stay in the vault.
        id: item.id, kind: "login", title: item.title, username: item.username, password: item.password,
        uris: [...item.uris], uriRules: item.uriRules?.map((rule) => ({ ...rule })), favorite: item.favorite,
        createdAt: item.createdAt, updatedAt: item.updatedAt, notes: "", customFields: [], providerRefs: []
      })),
    blockedHosts: [...state.settings.autofillBlockedHosts],
    blockedFieldSignatures: state.settings.autofillBlockedFieldSignatures.map((record) => record.signature)
  };
}

/**
 * A separate non-exportable device key encrypts only opted-in logins. Binding each
 * copy to the complete current vault envelope makes stale copies fail closed after
 * deletion, sync, backup replacement or an interrupted write. It cannot unlock the vault.
 */
export class LockedAutofillCache {
  constructor(private readonly storage: LockedAutofillStorage = new MemoryLockedAutofillStorage()) {}

  async read(envelope: VaultEnvelope): Promise<LockedAutofillSnapshot | null> {
    try {
      const record = await this.storage.read();
      if (!record || record.version !== 1 || record.envelopeDigest !== await envelopeDigest(envelope)) return null;
      const bytes = await crypto.subtle.decrypt({
        name: "AES-GCM", iv: base64ToBytes(record.iv) as BufferSource,
        additionalData: associatedData(record.envelopeDigest)
      }, record.key, base64ToBytes(record.ciphertext) as BufferSource);
      const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as LockedAutofillSnapshot;
      return snapshot;
    } catch {
      // A missing device key or damaged cache never opens the main vault.
      return null;
    }
  }

  async prepare(state: VaultState, envelope: VaultEnvelope): Promise<void> {
    const snapshot = lockedAutofillSnapshot(state);
    if (!snapshot.logins.length) return this.storage.write(null);
    const digest = await envelopeDigest(envelope);
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = randomBytes(12);
    const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
    try {
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: associatedData(digest) }, key, plaintext);
      await this.storage.write({ version: 1, envelopeDigest: digest, key, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) });
    } finally {
      plaintext.fill(0);
    }
  }
}

async function envelopeDigest(envelope: VaultEnvelope): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(envelope)))));
}

function associatedData(digest: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`monica-locked-autofill-v1:${digest}`);
}

export class MemoryLockedAutofillStorage implements LockedAutofillStorage {
  record: LockedAutofillRecord | null = null;
  async read() { return this.record ? structuredClone(this.record) : null; }
  async write(record: LockedAutofillRecord | null) { this.record = record ? structuredClone(record) : null; }
}

export class IndexedDbLockedAutofillStorage implements LockedAutofillStorage {
  async read(): Promise<LockedAutofillRecord | null> {
    return this.transaction("readonly", (store) => store.get("selected-logins"));
  }

  async write(record: LockedAutofillRecord | null): Promise<void> {
    await this.transaction("readwrite", (store) => record ? store.put(record, "selected-logins") : store.delete("selected-logins"));
  }

  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("monica-extension-locked-autofill", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("cache");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("cache", mode);
      let result: T;
      const request = action(tx.objectStore("cache"));
      request.onsuccess = () => { result = (request.result ?? null) as T; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("Locked autofill storage failed")); };
    });
  }
}
