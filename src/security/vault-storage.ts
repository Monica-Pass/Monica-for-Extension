import type { VaultEnvelope } from "./vault-crypto";

export interface VaultEnvelopeStorage {
  read(): Promise<VaultEnvelope | null>;
  write(envelope: VaultEnvelope): Promise<void>;
  clear(): Promise<void>;
}

export class IndexedDbVaultStorage implements VaultEnvelopeStorage {
  private readonly databaseName = "monica-extension-secure-vault";
  private readonly storeName = "vault";
  private readonly recordKey = "primary";

  async read(): Promise<VaultEnvelope | null> {
    return this.withStore<VaultEnvelope | null>("readonly", (store, resolve, reject) => {
      const request = store.get(this.recordKey);
      request.onsuccess = () => resolve((request.result as VaultEnvelope | undefined) || null);
      request.onerror = () => reject(request.error);
    });
  }

  async write(envelope: VaultEnvelope): Promise<void> {
    await this.withStore<void>("readwrite", (store, resolve, reject) => {
      const request = store.put(envelope, this.recordKey);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    await this.withStore<void>("readwrite", (store, resolve, reject) => {
      const request = store.delete(this.recordKey);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void): Promise<T> {
    const database = await this.openDatabase();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(this.storeName, mode);
      let result: T;
      let failed = false;
      const capture = (value: T) => { result = value; };
      const fail = (reason?: unknown) => {
        if (failed) return;
        failed = true;
        database.close();
        reject(reason);
      };
      try {
        action(transaction.objectStore(this.storeName), capture, fail);
      } catch (error) {
        try { transaction.abort(); } catch { /* transaction may already be inactive */ }
        fail(error);
      }
      transaction.oncomplete = () => {
        database.close();
        if (!failed) resolve(result!);
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error || new Error("Vault transaction aborted"));
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

export class MemoryVaultStorage implements VaultEnvelopeStorage {
  envelope: VaultEnvelope | null = null;

  async read(): Promise<VaultEnvelope | null> {
    return this.envelope ? structuredClone(this.envelope) : null;
  }

  async write(envelope: VaultEnvelope): Promise<void> {
    this.envelope = structuredClone(envelope);
  }

  async clear(): Promise<void> {
    this.envelope = null;
  }
}
