import { validateKeePassConflictRecovery, type KeePassEncryptedConflictRecovery } from './keepass-conflict-recovery';

export const KEEPASS_CONFLICT_RECOVERY_LIMIT = 8;
export interface KeePassConflictRecoverySummary {
  providerId: string; operationId: string; createdAt: string; reviewToken: string; intentTag: string;
}
export interface KeePassConflictRecoveryStorage {
  read(providerId: string, operationId: string): Promise<KeePassEncryptedConflictRecovery | undefined>;
  create(input: KeePassEncryptedConflictRecovery): Promise<KeePassEncryptedConflictRecovery>;
  list(providerId: string): Promise<KeePassConflictRecoverySummary[]>;
  delete(providerId: string, operationId: string, expectedIntentTag: string): Promise<boolean>;
}
const key = (providerId: string, operationId: string) => JSON.stringify([providerId, operationId]);
const summary = ({ providerId, operationId, createdAt, reviewToken, intentTag }: KeePassEncryptedConflictRecovery): KeePassConflictRecoverySummary =>
  ({ providerId, operationId, createdAt, reviewToken, intentTag });
function choose(input: KeePassEncryptedConflictRecovery, existing: KeePassEncryptedConflictRecovery | undefined, count: number) {
  if (existing) {
    const row = validateKeePassConflictRecovery(existing);
    if (row.providerId !== input.providerId || row.operationId !== input.operationId || row.intentTag !== input.intentTag || row.reviewToken !== input.reviewToken)
      throw new Error('KeePass 冲突恢复操作标识已被其他选择使用。');
    return row;
  }
  if (count >= KEEPASS_CONFLICT_RECOVERY_LIMIT) throw new Error('KeePass 冲突恢复副本已达到上限，请先保留并整理已有副本。');
  return validateKeePassConflictRecovery(input);
}

export class MemoryKeePassConflictRecoveryStorage implements KeePassConflictRecoveryStorage {
  constructor(private readonly records = new Map<string, KeePassEncryptedConflictRecovery>()) {}
  async read(providerId: string, operationId: string) {
    const row = this.records.get(key(providerId, operationId));
    if (row && (row.providerId !== providerId || row.operationId !== operationId)) throw new Error('KeePass 恢复副本标识不匹配。');
    return row ? validateKeePassConflictRecovery(row) : undefined;
  }
  async list(providerId: string) { return [...this.records.values()].filter(row => row.providerId === providerId).map(summary); }
  async delete(providerId: string, operationId: string, expectedIntentTag: string) {
    if (!/^[a-f0-9]{64}$/.test(expectedIntentTag)) throw new Error('恢复副本选择无效。');
    const id = key(providerId, operationId), row = this.records.get(id);
    if (!row) return false;
    if (row.intentTag !== expectedIntentTag) throw new Error('恢复副本已变化，请重新查看。');
    return this.records.delete(id);
  }
  async create(input: KeePassEncryptedConflictRecovery) {
    const row = validateKeePassConflictRecovery(input), id = key(row.providerId, row.operationId);
    const result = choose(row, this.records.get(id), [...this.records.values()].filter(item => item.providerId === row.providerId).length);
    if (!this.records.has(id)) this.records.set(id, structuredClone(result));
    return structuredClone(result);
  }
}

/** Immutable recovery is committed before the working-file transaction. A crash
 * between them leaves a recoverable prepared copy; it never removes an old copy.
 */
export class IndexedDbKeePassConflictRecoveryStorage implements KeePassConflictRecoveryStorage {
  constructor(private readonly databaseName = 'monica-extension-keepass-conflict-recovery') {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 2);
      request.onupgradeneeded = () => {
        const store = request.result.objectStoreNames.contains('recoveries') ? request.transaction!.objectStore('recoveries')
          : request.result.createObjectStore('recoveries', { keyPath: 'key' });
        if (!store.indexNames.contains('providerId')) store.createIndex('providerId', 'providerId', { unique: false });
        if (!store.indexNames.contains('summaries')) store.createIndex('summaries', ['providerId', 'createdAt', 'operationId', 'reviewToken', 'intentTag'], { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('KeePass 冲突恢复存储暂不可用。'));
    });
  }
  async read(providerId: string, operationId: string): Promise<KeePassEncryptedConflictRecovery | undefined> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('recoveries', 'readonly');
      const request = transaction.objectStore('recoveries').get(key(providerId, operationId));
      let result: KeePassEncryptedConflictRecovery | undefined, error: unknown;
      request.onsuccess = () => {
        try {
          if (request.result) {
            result = validateKeePassConflictRecovery(request.result);
            if (result.providerId !== providerId || result.operationId !== operationId) throw new Error('KeePass 恢复副本标识不匹配。');
          }
        } catch (cause) { error = cause; transaction.abort(); }
      };
      transaction.oncomplete = () => { database.close(); resolve(result); };
      transaction.onabort = transaction.onerror = () => { database.close(); reject(error || transaction.error || new Error('KeePass 恢复副本读取失败。')); };
    });
  }
  async list(providerId: string): Promise<KeePassConflictRecoverySummary[]> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('recoveries', 'readonly');
      const request = transaction.objectStore('recoveries').index('summaries').openKeyCursor(IDBKeyRange.bound([providerId], [providerId, []]));
      let result: KeePassConflictRecoverySummary[] = [], error: unknown;
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) return;
          if (result.length >= KEEPASS_CONFLICT_RECOVERY_LIMIT) throw new Error('KeePass 恢复副本数量无效。');
          const [owner, createdAt, operationId, reviewToken, intentTag] = cursor.key as string[];
          if (owner !== providerId || !operationId || !Number.isFinite(Date.parse(createdAt))
            || !/^[a-f0-9]{64}$/.test(reviewToken) || !/^[a-f0-9]{64}$/.test(intentTag)) throw new Error('KeePass 恢复副本摘要无效。');
          result.push({ providerId: owner, createdAt, operationId, reviewToken, intentTag });
          cursor.continue();
        } catch (cause) { error = cause; transaction.abort(); }
      };
      transaction.oncomplete = () => { database.close(); resolve(result); };
      transaction.onabort = transaction.onerror = () => { database.close(); reject(error || transaction.error || new Error('KeePass 恢复列表读取失败。')); };
    });
  }
  async create(input: KeePassEncryptedConflictRecovery): Promise<KeePassEncryptedConflictRecovery> {
    const row = validateKeePassConflictRecovery(input), database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('recoveries', 'readwrite'), store = transaction.objectStore('recoveries');
      const id = key(row.providerId, row.operationId), existing = store.get(id), count = store.index('providerId').count(row.providerId);
      let found = false, counted = false, result: KeePassEncryptedConflictRecovery | undefined, error: unknown;
      const save = () => {
        if (!found || !counted) return;
        try {
          result = choose(row, existing.result, count.result);
          if (!existing.result) store.add({ key: id, ...result });
        } catch (cause) { error = cause; transaction.abort(); }
      };
      existing.onsuccess = () => { found = true; save(); }; count.onsuccess = () => { counted = true; save(); };
      transaction.oncomplete = () => { database.close(); resolve(structuredClone(result!)); };
      transaction.onabort = transaction.onerror = () => { database.close(); reject(error || transaction.error || new Error('KeePass 恢复副本写入失败。')); };
    });
  }
  /** Use index keys rather than loading up to four large encrypted files. The
   * selected intent and its deletion are checked in the same transaction. */
  async delete(providerId: string, operationId: string, expectedIntentTag: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(expectedIntentTag)) throw new Error('恢复副本选择无效。');
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('recoveries', 'readwrite'), store = transaction.objectStore('recoveries');
      const request = store.index('summaries').openKeyCursor(IDBKeyRange.bound([providerId], [providerId, []]));
      let deleted = false, error: unknown;
      request.onsuccess = () => {
        try {
          const cursor = request.result; if (!cursor) return;
          const [owner, , operation, , tag] = cursor.key as string[];
          if (owner !== providerId) throw new Error('恢复副本选择无效。');
          if (operation === operationId) {
            if (tag !== expectedIntentTag || cursor.primaryKey !== key(providerId, operationId)) throw new Error('恢复副本已变化，请重新查看。');
            store.delete(cursor.primaryKey); deleted = true;
          } else cursor.continue();
        } catch (cause) { error = cause; transaction.abort(); }
      };
      transaction.oncomplete = () => { database.close(); resolve(deleted); };
      transaction.onabort = transaction.onerror = () => { database.close(); reject(error || transaction.error || new Error('恢复副本删除失败。')); };
    });
  }
}
