import { KEEPASS_REMOTE_MAX_DATABASE_BYTES } from "./keepass-webdav-client";

export interface KeePassRemoteWorkingCopyInput {
  providerId: string;
  baseBytes: Uint8Array;
  workingBytes: Uint8Array;
  baseEtag?: string;
  baseLastModified?: string;
  baseSha256: string;
  workingSha256: string;
  updatedAt: string;
}

export interface KeePassRemoteWorkingCopyRecord extends KeePassRemoteWorkingCopyInput {
  revision: number;
}

export type KeePassWorkingCopyStoreErrorCode = "record-invalid" | "revision-stale";

export class KeePassWorkingCopyStoreError extends Error {
  constructor(readonly code: KeePassWorkingCopyStoreErrorCode, message: string) {
    super(message);
    this.name = "KeePassWorkingCopyStoreError";
  }
}

export interface KeePassWorkingCopyStorage {
  read(providerId: string): Promise<KeePassRemoteWorkingCopyRecord | undefined>;
  save(input: KeePassRemoteWorkingCopyInput, expectedRevision: number): Promise<KeePassRemoteWorkingCopyRecord>;
  delete(providerId: string): Promise<void>;
}

export class MemoryKeePassWorkingCopyStorage implements KeePassWorkingCopyStorage {
  constructor(private readonly records = new Map<string, KeePassRemoteWorkingCopyRecord>()) {}

  async read(providerId: string): Promise<KeePassRemoteWorkingCopyRecord | undefined> {
    assertProviderId(providerId);
    const record = this.records.get(providerId);
    if (!record) return undefined;
    const validated = validateStoredRecord(record);
    if (validated.providerId !== providerId) throw invalidRecord();
    return cloneRecord(validated);
  }

  async save(input: KeePassRemoteWorkingCopyInput, expectedRevision: number): Promise<KeePassRemoteWorkingCopyRecord> {
    const record = nextRecord(input, expectedRevision, this.records.get(input.providerId));
    this.records.set(record.providerId, cloneRecord(record));
    return cloneRecord(record);
  }

  async delete(providerId: string): Promise<void> {
    assertProviderId(providerId);
    this.records.delete(providerId);
  }
}

export class IndexedDbKeePassWorkingCopyStorage implements KeePassWorkingCopyStorage {
  private readonly storeName = "working-copies";

  constructor(private readonly databaseName = "monica-extension-keepass-working-copies") {}

  async read(providerId: string): Promise<KeePassRemoteWorkingCopyRecord | undefined> {
    assertProviderId(providerId);
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readonly");
      const request = transaction.objectStore(this.storeName).get(providerId);
      let result: KeePassRemoteWorkingCopyRecord | undefined;
      let failed = false;
      const fail = (cause: unknown) => {
        if (failed) return;
        failed = true;
        try { transaction.abort(); } catch { /* transaction may already be inactive */ }
        database.close();
        reject(cause);
      };
      request.onsuccess = () => {
        try {
          result = request.result ? validateStoredRecord(request.result) : undefined;
          if (result && result.providerId !== providerId) throw invalidRecord();
        } catch (cause) {
          fail(cause);
        }
      };
      request.onerror = () => fail(request.error);
      transaction.oncomplete = () => {
        database.close();
        if (!failed) resolve(result ? cloneRecord(result) : undefined);
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => {
        if (!failed) fail(transaction.error || new Error("KeePass working-copy transaction aborted"));
      };
    });
  }

  async save(input: KeePassRemoteWorkingCopyInput, expectedRevision: number): Promise<KeePassRemoteWorkingCopyRecord> {
    assertInput(input);
    assertExpectedRevision(expectedRevision);
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.get(input.providerId);
      let result: KeePassRemoteWorkingCopyRecord | undefined;
      let rejected = false;
      const fail = (cause: unknown) => {
        if (rejected) return;
        rejected = true;
        try { transaction.abort(); } catch { /* transaction may already be inactive */ }
        database.close();
        reject(cause);
      };
      request.onsuccess = () => {
        try {
          const existing = request.result ? validateStoredRecord(request.result) : undefined;
          result = nextRecord(input, expectedRevision, existing);
          store.put(cloneRecord(result), input.providerId);
        } catch (cause) {
          fail(cause);
        }
      };
      request.onerror = () => fail(request.error);
      transaction.oncomplete = () => {
        database.close();
        if (!rejected && result) resolve(cloneRecord(result));
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => {
        if (!rejected) fail(transaction.error || new Error("KeePass working-copy transaction aborted"));
      };
    });
  }

  async delete(providerId: string): Promise<void> {
    assertProviderId(providerId);
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readwrite");
      transaction.objectStore(this.storeName).delete(providerId);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error || new Error("KeePass working-copy transaction aborted")); };
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

function nextRecord(
  input: KeePassRemoteWorkingCopyInput,
  expectedRevision: number,
  existing: KeePassRemoteWorkingCopyRecord | undefined
): KeePassRemoteWorkingCopyRecord {
  assertInput(input);
  assertExpectedRevision(expectedRevision);
  const actualRevision = existing?.revision || 0;
  if (actualRevision !== expectedRevision) {
    throw new KeePassWorkingCopyStoreError("revision-stale", "KeePass 工作副本已经被另一个后台实例更新。");
  }
  return cloneRecord({ ...input, revision: expectedRevision + 1 });
}

function validateStoredRecord(value: unknown): KeePassRemoteWorkingCopyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRecord();
  const record = value as KeePassRemoteWorkingCopyRecord;
  assertInput(record);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw invalidRecord();
  return cloneRecord(record);
}

function assertInput(input: KeePassRemoteWorkingCopyInput): void {
  if (!input || typeof input !== "object") throw invalidRecord();
  assertProviderId(input.providerId);
  assertBytes(input.baseBytes);
  assertBytes(input.workingBytes);
  assertSha256(input.baseSha256);
  assertSha256(input.workingSha256);
  if (input.baseEtag !== undefined && (typeof input.baseEtag !== "string" || !input.baseEtag.trim() || input.baseEtag.length > 1024 || /[\r\n]/.test(input.baseEtag))) throw invalidRecord();
  if (input.baseLastModified !== undefined && (typeof input.baseLastModified !== "string" || input.baseLastModified.length > 256)) throw invalidRecord();
  if (typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) throw invalidRecord();
}

function assertProviderId(providerId: string): void {
  if (typeof providerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(providerId)) throw invalidRecord();
}

function assertBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > KEEPASS_REMOTE_MAX_DATABASE_BYTES) throw invalidRecord();
}

function assertSha256(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalidRecord();
}

function assertExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidRecord();
}

function invalidRecord(): KeePassWorkingCopyStoreError {
  return new KeePassWorkingCopyStoreError("record-invalid", "KeePass 工作副本记录无效。");
}

function cloneRecord(record: KeePassRemoteWorkingCopyRecord): KeePassRemoteWorkingCopyRecord {
  return {
    ...record,
    baseBytes: record.baseBytes.slice(),
    workingBytes: record.workingBytes.slice()
  };
}
