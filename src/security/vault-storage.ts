import type { VaultEnvelope } from "./vault-crypto";
import type { Blocks, RecordHead, RecordWrite, StoredHead } from './vault-records';
import { nextRecoveryCopies, vaultCiphertextBytes, VAULT_STORAGE_LIMIT, type VaultRecoveryCopy } from './vault-recovery';

export interface VaultEnvelopeStorage {
  read(): Promise<StoredHead | null>;
  write(envelope: VaultEnvelope, expected?: StoredHead | null): Promise<void>;
  records?: RecordBackend;
  clear(): Promise<void>;
  recoveryCopies?(): Promise<VaultRecoveryCopy[]>;
  clearRecoveryCopies?(): Promise<void>;
}

export interface RecordBackend {
  blocks(ids: string[]): Promise<Blocks>;
  stage(expected: VaultEnvelope, plan: RecordWrite): Promise<void>;
  activate(expected: VaultEnvelope, head: RecordHead): Promise<void>;
  checkpointDue(): Promise<boolean>;
  commit(expected: RecordHead, plan: RecordWrite, checkpoint?: VaultEnvelope): Promise<void>;
}
function assertExpected(current: unknown, expected: StoredHead | null) {
  if (JSON.stringify(current ?? null) !== JSON.stringify(expected)) throw new Error('Vault changed during storage operation');
}
const blockRange = () => IDBKeyRange.bound(['block'], ['block', []]);
const blockKey = (id: string) => ['block', id];

export class IndexedDbVaultStorage implements VaultEnvelopeStorage {
  private readonly databaseName = "monica-extension-secure-vault";
  private readonly storeName = "vault";
  private readonly recordKey = "primary";

  async read(): Promise<StoredHead | null> {
    return this.withStore<StoredHead | null>("readonly", (store, resolve, reject) => {
      const request = store.get(this.recordKey), active = store.get('records-active');
      active.onsuccess = () => {
        if (Boolean(active.result) !== (request.result?.version === 2)) return reject(new Error('Encrypted vault header is missing or invalid'));
        resolve(request.result || null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async write(envelope: VaultEnvelope, expected?: StoredHead | null): Promise<void> {
    const commit = (retain: boolean) => this.withStore<void>('readwrite', (store, resolve, reject) => {
      const previous = store.get(this.recordKey), history = store.get('recovery');
      let loaded = 0;
      const ready = () => {
        if (++loaded !== 2) return;
        try {
          if (expected !== undefined) assertExpected(previous.result, expected);
          if (previous.result?.version === 2 && expected === undefined) throw new Error('Replacing record storage requires the authenticated revision');
          const copies = retain && previous.result?.version === 1 ? nextRecoveryCopies(previous.result, envelope, history.result || []) : [];
          store.delete(blockRange()); store.delete('staging'); store.delete('records-active'); store.delete('checkpoint-at');
          if (previous.result && JSON.stringify(previous.result.kdf) !== JSON.stringify(envelope.kdf)) store.put(true, 'new-protection');
          else store.delete('new-protection');
          store.put(copies, 'recovery');
          const request = store.put(envelope, this.recordKey);
          request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
        } catch (error) {
          // Exceptions in request callbacks do not reach withStore's initial
          // try/catch. Abort both writes and preserve the precise retry reason.
          store.transaction.abort(); reject(error);
        }
      };
      previous.onsuccess = ready; history.onsuccess = ready;
      previous.onerror = () => reject(previous.error); history.onerror = () => reject(history.error);
    });
    try { await commit(true); }
    catch (error) {
      if ((error as DOMException)?.name !== 'QuotaExceededError') throw error;
      // Checkpoints must not make an otherwise valid primary write impossible.
      await commit(false);
    }
  }

  readonly records: RecordBackend = {
    blocks: ids => this.withStore<Blocks>('readonly', (store, done) => {
      const result: Blocks = new Map();
      for (const id of ids) { const req = store.get(blockKey(id)); req.onsuccess = () => { if (req.result) result.set(id, req.result); }; }
      done(result);
    }),
    stage: (expected, plan) => this.guarded(expected, store => {
      store.delete(blockRange());
      for (const [id, box] of plan.puts) store.add(box, blockKey(id));
      store.put(plan.head, 'staging');
    }),
    activate: (expected, head) => this.guarded(expected, (store, guard) => {
      const staged = store.get('staging'), newProtection = store.get('new-protection'), history = store.get('recovery');
      history.onsuccess = () => guard(() => {
        assertExpected(staged.result, head);
        const now = Date.now(), copies: VaultRecoveryCopy[] = history.result || [];
        // Always retain the exact pre-migration bytes, even when the last checkpoint is recent.
        const rows = newProtection.result || JSON.stringify(expected.kdf) !== JSON.stringify(head.kdf) ? [] : [{ id: crypto.randomUUID(), createdAt: new Date(now).toISOString(), envelope: expected },
          ...copies.filter(c => c.envelope.ciphertext !== expected.ciphertext && JSON.stringify(c.envelope.kdf) === JSON.stringify(expected.kdf))];
        let bytes = 0;
        store.put(rows.slice(0,3).filter(c => (bytes += vaultCiphertextBytes(c.envelope)) <= VAULT_STORAGE_LIMIT), 'recovery');
        store.put(rows.length ? now : 0, 'checkpoint-at'); store.delete('new-protection');
        store.put(true, 'records-active'); store.put(head, 'primary'); store.delete('staging');
      });
    }),
    checkpointDue: () => this.withStore<boolean>('readonly', (store, done) => {
      const req = store.get('checkpoint-at'); req.onsuccess = () => done(Date.now() - (req.result || 0) >= 15 * 60_000);
    }),
    commit: (expected, plan, checkpoint) => this.guarded(expected, (store, guard) => {
      for (const [id, box] of plan.puts) store.add(box, blockKey(id));
      for (const id of plan.removes) store.delete(blockKey(id));
      if (checkpoint) {
        const req = store.get('recovery'); req.onsuccess = () => guard(() => {
          const copies = nextRecoveryCopies(checkpoint, plan.head, req.result || []);
          store.put(copies, 'recovery'); store.put(Date.now(), 'checkpoint-at');
        });
      }
      store.put(plan.head, 'primary');
    })
  };

  private guarded(expected: StoredHead, action: (store: IDBObjectStore, guard: (fn: () => void) => void) => void): Promise<void> {
    return this.withStore('readwrite', (store, done, fail) => {
      const guard = (fn: () => void) => { try { fn(); } catch (err) { store.transaction.abort(); fail(err); } };
      const req = store.get('primary');
      req.onsuccess = () => guard(() => { assertExpected(req.result, expected); action(store, guard); done(); });
    });
  }

  async recoveryCopies(): Promise<VaultRecoveryCopy[]> {
    return this.withStore<VaultRecoveryCopy[]>('readonly', (store, resolve, reject) => {
      const request = store.get('recovery'); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error);
    });
  }
  async clearRecoveryCopies(): Promise<void> {
    return this.withStore<void>('readwrite', (store, resolve, reject) => {
      store.delete('checkpoint-at');
      const request = store.delete('recovery'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    await this.withStore<void>("readwrite", (store, resolve, reject) => {
      const request = store.clear();
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
      // Old builds explicitly open version 1. Fence out their unconditional primary writes.
      const request = indexedDB.open(this.databaseName, 2);
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
  copies: VaultRecoveryCopy[] = [];

  async read(): Promise<VaultEnvelope | null> {
    return this.envelope ? structuredClone(this.envelope) : null;
  }

  async write(envelope: VaultEnvelope): Promise<void> {
    this.copies = structuredClone(nextRecoveryCopies(this.envelope || undefined, envelope, this.copies));
    this.envelope = structuredClone(envelope);
  }

  async recoveryCopies(): Promise<VaultRecoveryCopy[]> { return structuredClone(this.copies); }
  async clearRecoveryCopies(): Promise<void> { this.copies = []; }

  async clear(): Promise<void> {
    this.envelope = null;
    this.copies = [];
  }
}
