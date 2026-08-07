import { BITWARDEN_ATTACHMENT_MAX_BYTES } from "../attachments/attachment-contract";

export type BitwardenAttachmentMutationKind = "upload" | "replace" | "delete";

export type BitwardenAttachmentMutationStage =
  | "intent"
  | "preparing"
  | "prepared"
  | "uploading"
  | "verifying"
  | "verified"
  | "deleting-old"
  | "deleting"
  | "rolling-back"
  | "completed";

export interface BitwardenAttachmentMutationRecord {
  version: 1;
  revision: number;
  providerId: string;
  operationId: string;
  cipherId: string;
  kind: BitwardenAttachmentMutationKind;
  stage: BitwardenAttachmentMutationStage;
  attempt: number;
  oldAttachmentId?: string;
  newAttachmentId?: string;
  fileUploadType?: 0 | 1;
  plaintextSha256?: string;
  fileNameSha256?: string;
  encryptedFileNameSha256?: string;
  wrappedKeySha256?: string;
  plainSizeBytes?: number;
  encryptedSizeBytes?: number;
  serverRevisionDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface BitwardenAttachmentMutationStore {
  read(providerId: string, operationId: string): Promise<BitwardenAttachmentMutationRecord | undefined>;
  list(providerId: string): Promise<BitwardenAttachmentMutationRecord[]>;
  save(input: BitwardenAttachmentMutationRecord, expectedRevision: number): Promise<BitwardenAttachmentMutationRecord>;
  delete(providerId: string, operationId: string): Promise<void>;
}

export type BitwardenAttachmentMutationStoreErrorCode = "record-invalid" | "revision-stale" | "storage-failed";

export class BitwardenAttachmentMutationStoreError extends Error {
  constructor(readonly code: BitwardenAttachmentMutationStoreErrorCode, message: string) {
    super(message);
    this.name = "BitwardenAttachmentMutationStoreError";
  }
}

const MAX_CIPHERTEXT_BYTES = BITWARDEN_ATTACHMENT_MAX_BYTES + 64;
const MAX_ID_BYTES = 4096;
const MAX_PROVIDER_ID_BYTES = 512;
const MAX_RECORDS_RETURNED = 512;
const OPERATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_KEYS = new Set<keyof BitwardenAttachmentMutationRecord>([
  "version",
  "revision",
  "providerId",
  "operationId",
  "cipherId",
  "kind",
  "stage",
  "attempt",
  "oldAttachmentId",
  "newAttachmentId",
  "fileUploadType",
  "plaintextSha256",
  "fileNameSha256",
  "encryptedFileNameSha256",
  "wrappedKeySha256",
  "plainSizeBytes",
  "encryptedSizeBytes",
  "serverRevisionDate",
  "createdAt",
  "updatedAt"
]);
const KINDS = new Set<BitwardenAttachmentMutationKind>(["upload", "replace", "delete"]);
const STAGES = new Set<BitwardenAttachmentMutationStage>([
  "intent",
  "preparing",
  "prepared",
  "uploading",
  "verifying",
  "verified",
  "deleting-old",
  "deleting",
  "rolling-back",
  "completed"
]);

export class MemoryBitwardenAttachmentMutationStore implements BitwardenAttachmentMutationStore {
  constructor(private readonly records = new Map<string, BitwardenAttachmentMutationRecord>()) {}

  async read(providerId: string, operationId: string): Promise<BitwardenAttachmentMutationRecord | undefined> {
    assertProviderId(providerId);
    assertOperationId(operationId);
    const value = this.records.get(recordKey(providerId, operationId));
    return value ? cloneRecord(validateRecord(value)) : undefined;
  }

  async list(providerId: string): Promise<BitwardenAttachmentMutationRecord[]> {
    assertProviderId(providerId);
    const result: BitwardenAttachmentMutationRecord[] = [];
    for (const value of this.records.values()) {
      const record = validateRecord(value);
      if (record.providerId === providerId) result.push(cloneRecord(record));
    }
    if (result.length > MAX_RECORDS_RETURNED) throw storageError();
    return result.sort(compareRecords);
  }

  async save(input: BitwardenAttachmentMutationRecord, expectedRevision: number): Promise<BitwardenAttachmentMutationRecord> {
    assertRevision(expectedRevision);
    const base = validateRecord(input);
    const key = recordKey(base.providerId, base.operationId);
    const current = this.records.get(key);
    if ((current?.revision || 0) !== expectedRevision) throw staleRevision();
    const saved = validateRecord({ ...base, revision: expectedRevision + 1 });
    this.records.set(key, cloneRecord(saved));
    return cloneRecord(saved);
  }

  async delete(providerId: string, operationId: string): Promise<void> {
    assertProviderId(providerId);
    assertOperationId(operationId);
    this.records.delete(recordKey(providerId, operationId));
  }
}

interface PersistedMutationRecord extends BitwardenAttachmentMutationRecord {
  key: string;
}

export class IndexedDbBitwardenAttachmentMutationStore implements BitwardenAttachmentMutationStore {
  constructor(
    private readonly databaseName = "monica-bitwarden-attachment-mutations",
    private readonly storeName = "operations"
  ) {}

  async read(providerId: string, operationId: string): Promise<BitwardenAttachmentMutationRecord | undefined> {
    assertProviderId(providerId);
    assertOperationId(operationId);
    const key = recordKey(providerId, operationId);
    const database = await this.open();
    try {
      const transaction = database.transaction(this.storeName, "readonly");
      const completed = transactionDone(transaction);
      const result = await requestResult<PersistedMutationRecord | undefined>(transaction.objectStore(this.storeName).get(key));
      await completed;
      return result ? cloneRecord(validatePersistedRecord(result, key)) : undefined;
    } catch (cause) {
      if (cause instanceof BitwardenAttachmentMutationStoreError) throw cause;
      throw storageError();
    } finally {
      database.close();
    }
  }

  async list(providerId: string): Promise<BitwardenAttachmentMutationRecord[]> {
    assertProviderId(providerId);
    const database = await this.open();
    try {
      const transaction = database.transaction(this.storeName, "readonly");
      const completed = transactionDone(transaction);
      const request = transaction.objectStore(this.storeName).index("providerId").getAll(IDBKeyRange.only(providerId), MAX_RECORDS_RETURNED + 1);
      const values = await requestResult<PersistedMutationRecord[]>(request);
      await completed;
      if (values.length > MAX_RECORDS_RETURNED) throw storageError();
      return values.map((value) => cloneRecord(validatePersistedRecord(value, recordKey(value.providerId, value.operationId)))).sort(compareRecords);
    } catch (cause) {
      if (cause instanceof BitwardenAttachmentMutationStoreError) throw cause;
      throw storageError();
    } finally {
      database.close();
    }
  }

  async save(input: BitwardenAttachmentMutationRecord, expectedRevision: number): Promise<BitwardenAttachmentMutationRecord> {
    assertRevision(expectedRevision);
    const base = validateRecord(input);
    const key = recordKey(base.providerId, base.operationId);
    const saved = validateRecord({ ...base, revision: expectedRevision + 1 });
    const persisted: PersistedMutationRecord = { key, ...cloneRecord(saved) };
    const database = await this.open();
    try {
      return await new Promise<BitwardenAttachmentMutationRecord>((resolve, reject) => {
        const transaction = database.transaction(this.storeName, "readwrite");
        const store = transaction.objectStore(this.storeName);
        let failure: unknown;
        const lookup = store.get(key);
        lookup.onerror = () => {
          failure = storageError();
          transaction.abort();
        };
        lookup.onsuccess = () => {
          try {
            const current = lookup.result as PersistedMutationRecord | undefined;
            if (current) validatePersistedRecord(current, key);
            if ((current?.revision || 0) !== expectedRevision) throw staleRevision();
            store.put(persisted);
          } catch (cause) {
            failure = cause;
            transaction.abort();
          }
        };
        transaction.oncomplete = () => resolve(cloneRecord(saved));
        transaction.onabort = () => reject(failure || storageError());
        transaction.onerror = () => {
          failure ||= storageError();
        };
      });
    } catch (cause) {
      if (cause instanceof BitwardenAttachmentMutationStoreError) throw cause;
      throw storageError();
    } finally {
      database.close();
    }
  }

  async delete(providerId: string, operationId: string): Promise<void> {
    assertProviderId(providerId);
    assertOperationId(operationId);
    const database = await this.open();
    try {
      const transaction = database.transaction(this.storeName, "readwrite");
      transaction.objectStore(this.storeName).delete(recordKey(providerId, operationId));
      await transactionDone(transaction);
    } catch {
      throw storageError();
    } finally {
      database.close();
    }
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") return Promise.reject(storageError());
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(this.storeName)
          ? request.transaction!.objectStore(this.storeName)
          : database.createObjectStore(this.storeName, { keyPath: "key" });
        if (!store.indexNames.contains("providerId")) store.createIndex("providerId", "providerId", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError());
      request.onblocked = () => reject(storageError());
    });
  }
}

export function validateBitwardenAttachmentMutationRecord(input: unknown): BitwardenAttachmentMutationRecord {
  return cloneRecord(validateRecord(input));
}

function validateRecord(input: unknown): BitwardenAttachmentMutationRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidRecord();
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!ALLOWED_KEYS.has(key as keyof BitwardenAttachmentMutationRecord)) throw invalidRecord();
  if (value.version !== 1) throw invalidRecord();
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw invalidRecord();
  assertProviderId(value.providerId);
  assertOperationId(value.operationId);
  assertOpaqueId(value.cipherId);
  if (!KINDS.has(value.kind as BitwardenAttachmentMutationKind)) throw invalidRecord();
  if (!STAGES.has(value.stage as BitwardenAttachmentMutationStage)) throw invalidRecord();
  if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 0 || Number(value.attempt) > 16) throw invalidRecord();
  assertTimestamp(value.serverRevisionDate);
  assertTimestamp(value.createdAt);
  assertTimestamp(value.updatedAt);
  optionalOpaqueId(value.oldAttachmentId);
  optionalOpaqueId(value.newAttachmentId);
  optionalHash(value.plaintextSha256);
  optionalHash(value.fileNameSha256);
  optionalHash(value.encryptedFileNameSha256);
  optionalHash(value.wrappedKeySha256);
  optionalSize(value.plainSizeBytes, BITWARDEN_ATTACHMENT_MAX_BYTES);
  optionalSize(value.encryptedSizeBytes, MAX_CIPHERTEXT_BYTES);
  if (value.encryptedSizeBytes !== undefined && Number(value.encryptedSizeBytes) < 64) throw invalidRecord();
  if (value.fileUploadType !== undefined && value.fileUploadType !== 0 && value.fileUploadType !== 1) throw invalidRecord();

  const kind = value.kind as BitwardenAttachmentMutationKind;
  const stage = value.stage as BitwardenAttachmentMutationStage;
  if (kind === "delete") {
    if (stage !== "deleting" && stage !== "completed") throw invalidRecord();
    if (!value.oldAttachmentId || value.newAttachmentId !== undefined || value.fileUploadType !== undefined || value.plaintextSha256 !== undefined
      || value.fileNameSha256 !== undefined || value.encryptedFileNameSha256 !== undefined || value.wrappedKeySha256 !== undefined
      || value.plainSizeBytes !== undefined || value.encryptedSizeBytes !== undefined) throw invalidRecord();
  } else {
    if (stage === "deleting" || (stage === "deleting-old" && kind !== "replace")) throw invalidRecord();
    if (!value.plaintextSha256 || !value.fileNameSha256 || value.plainSizeBytes === undefined) throw invalidRecord();
    if (kind === "replace" ? !value.oldAttachmentId : value.oldAttachmentId !== undefined) throw invalidRecord();
    if (stage === "intent" && (value.newAttachmentId !== undefined || value.fileUploadType !== undefined || value.encryptedFileNameSha256 !== undefined
      || value.wrappedKeySha256 !== undefined || value.encryptedSizeBytes !== undefined)) throw invalidRecord();
    const encryptedStage = stage !== "intent";
    if (encryptedStage && (!value.encryptedFileNameSha256 || !value.wrappedKeySha256 || value.encryptedSizeBytes === undefined)) throw invalidRecord();
    const preparedStage = new Set<BitwardenAttachmentMutationStage>(["prepared", "uploading", "verifying", "verified", "deleting-old", "rolling-back", "completed"]).has(stage);
    if (preparedStage && (!value.newAttachmentId || (value.fileUploadType !== 0 && value.fileUploadType !== 1))) throw invalidRecord();
    if ((stage === "preparing") && (value.newAttachmentId !== undefined || value.fileUploadType !== undefined)) throw invalidRecord();
  }
  return value as unknown as BitwardenAttachmentMutationRecord;
}

function validatePersistedRecord(input: PersistedMutationRecord, expectedKey: string): BitwardenAttachmentMutationRecord {
  if (!input || typeof input !== "object" || input.key !== expectedKey) throw invalidRecord();
  const { key: _key, ...record } = input;
  return validateRecord(record);
}

function cloneRecord(value: BitwardenAttachmentMutationRecord): BitwardenAttachmentMutationRecord {
  return { ...value };
}

function compareRecords(left: BitwardenAttachmentMutationRecord, right: BitwardenAttachmentMutationRecord): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.operationId.localeCompare(right.operationId);
}

function recordKey(providerId: string, operationId: string): string {
  return `${providerId}\u0000${operationId}`;
}

function assertProviderId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || utf8Length(value) > MAX_PROVIDER_ID_BYTES || hasControl(value)) throw invalidRecord();
}

function assertOperationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) throw invalidRecord();
}

function assertOpaqueId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || utf8Length(value) > MAX_ID_BYTES || hasControl(value)) throw invalidRecord();
}

function optionalOpaqueId(value: unknown): void {
  if (value !== undefined) assertOpaqueId(value);
}

function optionalHash(value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || !SHA256_PATTERN.test(value))) throw invalidRecord();
}

function optionalSize(value: unknown, maximum: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum)) throw invalidRecord();
}

function assertTimestamp(value: unknown): void {
  if (typeof value !== "string" || !value || value.length > 64 || !Number.isFinite(Date.parse(value)) || hasControl(value)) throw invalidRecord();
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidRecord();
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageError());
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(storageError());
    transaction.onabort = () => reject(storageError());
  });
}

function invalidRecord(): BitwardenAttachmentMutationStoreError {
  return new BitwardenAttachmentMutationStoreError("record-invalid", "Bitwarden 附件持久操作记录无效或含有禁止字段。");
}

function staleRevision(): BitwardenAttachmentMutationStoreError {
  return new BitwardenAttachmentMutationStoreError("revision-stale", "Bitwarden 附件持久操作记录已被其他后台任务更新。");
}

function storageError(): BitwardenAttachmentMutationStoreError {
  return new BitwardenAttachmentMutationStoreError("storage-failed", "Bitwarden 附件恢复记录无法安全读写。");
}
