import type { ProviderConflictInput, VaultItem } from "../../core/model";
import { base64ToBytes } from "../../security/encoding";
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

export const KEEPASS_DURABLE_RECEIPT_LIMIT = 256;
export const KEEPASS_DURABLE_RECEIPT_MAX_PLAINTEXT_BYTES = 4 * 1024 * 1024;
const KEEPASS_DURABLE_RECEIPT_MAX_CIPHERTEXT_BYTES = KEEPASS_DURABLE_RECEIPT_MAX_PLAINTEXT_BYTES + 16;

export type KeePassDurableMutationKind =
  | "group-create"
  | "group-rename"
  | "group-move"
  | "group-delete"
  | "group-restore"
  | "history-restore"
  | "attachment-upload"
  | "attachment-delete"
  | "item-sync";

export type KeePassDurableMutationResult =
  | { type: "group"; changed: boolean; groupUuid: string }
  | { type: "history"; changed: boolean; historyCount: number; modifiedAt: string }
  | { type: "attachment"; changed: boolean; entryUuid: string; fileName: string }
  | { type: "attachment-delete"; changed: boolean }
  | {
      type: "item-sync";
      mutations: Array<{
        mutationId: string;
        itemId: string;
        operation: "create" | "update" | "delete";
        createdAt: string;
        attempts: number;
        lastError?: string;
        committed: boolean;
        remoteId?: string;
      }>;
      snapshotItems: VaultItem[];
      conflicts: ProviderConflictInput[];
      syncedAt: string;
    };

export interface KeePassDurableMutationReceipt {
  providerId: string;
  operationId: string;
  kind: KeePassDurableMutationKind;
  intentSha256: string;
  completedAt: string;
  result: KeePassDurableMutationResult;
}

export interface KeePassEncryptedMutationReceipt {
  version: 1;
  providerId: string;
  operationId: string;
  intentTag: string;
  completedAt: string;
  cipher: "AES-256-GCM";
  iv: string;
  ciphertext: string;
}

export type KeePassWorkingCopyStoreErrorCode = "record-invalid" | "revision-stale" | "operation-reused";

export class KeePassWorkingCopyStoreError extends Error {
  constructor(readonly code: KeePassWorkingCopyStoreErrorCode, message: string) {
    super(message);
    this.name = "KeePassWorkingCopyStoreError";
  }
}

export interface KeePassWorkingCopyStorage {
  read(providerId: string): Promise<KeePassRemoteWorkingCopyRecord | undefined>;
  readReceipt(providerId: string, operationId: string): Promise<KeePassEncryptedMutationReceipt | undefined>;
  hasReceipts(providerId: string): Promise<boolean>;
  save(input: KeePassRemoteWorkingCopyInput, expectedRevision: number, receipt?: KeePassEncryptedMutationReceipt): Promise<KeePassRemoteWorkingCopyRecord>;
  deleteReceipt(providerId: string, operationId: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export class MemoryKeePassWorkingCopyStorage implements KeePassWorkingCopyStorage {
  constructor(
    private readonly records = new Map<string, KeePassRemoteWorkingCopyRecord>(),
    private readonly receipts = new Map<string, KeePassEncryptedMutationReceipt>()
  ) {}

  async read(providerId: string): Promise<KeePassRemoteWorkingCopyRecord | undefined> {
    assertProviderId(providerId);
    const record = this.records.get(providerId);
    if (!record) return undefined;
    const validated = validateStoredRecord(record);
    if (validated.providerId !== providerId) throw invalidRecord();
    return cloneRecord(validated);
  }

  async readReceipt(providerId: string, operationId: string): Promise<KeePassEncryptedMutationReceipt | undefined> {
    assertProviderId(providerId);
    assertOperationId(operationId);
    const receipt = this.receipts.get(receiptKey(providerId, operationId));
    return receipt ? cloneEncryptedReceipt(validateEncryptedReceipt(receipt)) : undefined;
  }

  async hasReceipts(providerId: string): Promise<boolean> {
    assertProviderId(providerId);
    for (const receipt of this.receipts.values()) if (receipt.providerId === providerId) return true;
    return false;
  }

  async save(input: KeePassRemoteWorkingCopyInput, expectedRevision: number, receipt?: KeePassEncryptedMutationReceipt): Promise<KeePassRemoteWorkingCopyRecord> {
    const record = nextRecord(input, expectedRevision, this.records.get(input.providerId));
    const durableReceipt = receipt ? nextEncryptedReceipt(receipt, this.receipts.get(receiptKey(receipt.providerId, receipt.operationId))) : undefined;
    this.records.set(record.providerId, cloneRecord(record));
    if (durableReceipt && !this.receipts.has(receiptKey(durableReceipt.providerId, durableReceipt.operationId))) {
      pruneMemoryReceipts(this.receipts, durableReceipt.providerId);
      this.receipts.set(receiptKey(durableReceipt.providerId, durableReceipt.operationId), cloneEncryptedReceipt(durableReceipt));
    }
    return cloneRecord(record);
  }

  async deleteReceipt(providerId: string, operationId: string): Promise<void> {
    assertProviderId(providerId);
    assertOperationId(operationId);
    this.receipts.delete(receiptKey(providerId, operationId));
  }

  async delete(providerId: string): Promise<void> {
    assertProviderId(providerId);
    this.records.delete(providerId);
    for (const [key, receipt] of this.receipts) if (receipt.providerId === providerId) this.receipts.delete(key);
  }
}

export class IndexedDbKeePassWorkingCopyStorage implements KeePassWorkingCopyStorage {
  private readonly storeName = "working-copies";
  private readonly receiptStoreName = "operation-receipts";

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

  async readReceipt(providerId: string, operationId: string): Promise<KeePassEncryptedMutationReceipt | undefined> {
    assertProviderId(providerId);
    assertOperationId(operationId);
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.receiptStoreName, "readonly");
      const request = transaction.objectStore(this.receiptStoreName).get(receiptKey(providerId, operationId));
      let result: KeePassEncryptedMutationReceipt | undefined;
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
          result = request.result ? validateEncryptedReceipt(request.result) : undefined;
          if (result && (result.providerId !== providerId || result.operationId !== operationId)) throw invalidRecord();
        } catch (cause) {
          fail(cause);
        }
      };
      request.onerror = () => fail(request.error);
      transaction.oncomplete = () => {
        database.close();
        if (!failed) resolve(result ? cloneEncryptedReceipt(result) : undefined);
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => {
        if (!failed) fail(transaction.error || new Error("KeePass operation-receipt transaction aborted"));
      };
    });
  }

  async hasReceipts(providerId: string): Promise<boolean> {
    assertProviderId(providerId);
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.receiptStoreName, "readonly");
      const request = transaction.objectStore(this.receiptStoreName).index("providerId").count(IDBKeyRange.only(providerId));
      let count = 0;
      request.onsuccess = () => { count = request.result; };
      request.onerror = () => { try { transaction.abort(); } catch { /* inactive */ } };
      transaction.oncomplete = () => { database.close(); resolve(count > 0); };
      transaction.onerror = () => { database.close(); reject(transaction.error || request.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error || request.error || new Error("KeePass operation-receipt transaction aborted")); };
    });
  }

  async save(input: KeePassRemoteWorkingCopyInput, expectedRevision: number, receipt?: KeePassEncryptedMutationReceipt): Promise<KeePassRemoteWorkingCopyRecord> {
    assertInput(input);
    assertExpectedRevision(expectedRevision);
    if (receipt) assertEncryptedReceipt(receipt);
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([this.storeName, this.receiptStoreName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.get(input.providerId);
      const receiptStore = transaction.objectStore(this.receiptStoreName);
      const receiptRequest = receipt ? receiptStore.get(receiptKey(receipt.providerId, receipt.operationId)) : undefined;
      const receiptListRequest = receipt ? receiptStore.index("providerId").getAll(receipt.providerId, KEEPASS_DURABLE_RECEIPT_LIMIT + 1) : undefined;
      let result: KeePassRemoteWorkingCopyRecord | undefined;
      let rejected = false;
      let recordReady = false;
      let receiptReady = !receipt;
      let receiptListReady = !receipt;
      let existingReceipt: KeePassEncryptedMutationReceipt | undefined;
      let providerReceipts: KeePassEncryptedMutationReceipt[] = [];
      const fail = (cause: unknown) => {
        if (rejected) return;
        rejected = true;
        try { transaction.abort(); } catch { /* transaction may already be inactive */ }
        database.close();
        reject(cause);
      };
      const maybeWrite = () => {
        if (rejected || !recordReady || !receiptReady || !receiptListReady) return;
        try {
          if (receipt) {
            const durableReceipt = nextEncryptedReceipt(receipt, existingReceipt);
            if (!existingReceipt) {
              if (providerReceipts.length >= KEEPASS_DURABLE_RECEIPT_LIMIT) {
                const oldest = [...providerReceipts].sort((left, right) => left.completedAt.localeCompare(right.completedAt))[0];
                if (oldest) receiptStore.delete(receiptKey(oldest.providerId, oldest.operationId));
              }
              receiptStore.put({ key: receiptKey(durableReceipt.providerId, durableReceipt.operationId), ...cloneEncryptedReceipt(durableReceipt) });
            }
          }
          store.put(cloneRecord(result!), input.providerId);
        } catch (cause) {
          fail(cause);
        }
      };
      request.onsuccess = () => {
        try {
          const existing = request.result ? validateStoredRecord(request.result) : undefined;
          result = nextRecord(input, expectedRevision, existing);
          recordReady = true;
          maybeWrite();
        } catch (cause) {
          fail(cause);
        }
      };
      request.onerror = () => fail(request.error);
      if (receiptRequest) {
        receiptRequest.onsuccess = () => {
          try {
            existingReceipt = receiptRequest.result ? validateEncryptedReceipt(receiptRequest.result) : undefined;
            receiptReady = true;
            maybeWrite();
          } catch (cause) {
            fail(cause);
          }
        };
        receiptRequest.onerror = () => fail(receiptRequest.error);
      }
      if (receiptListRequest) {
        receiptListRequest.onsuccess = () => {
          try {
            providerReceipts = (receiptListRequest.result || []).map(validateEncryptedReceipt);
            receiptListReady = true;
            maybeWrite();
          } catch (cause) {
            fail(cause);
          }
        };
        receiptListRequest.onerror = () => fail(receiptListRequest.error);
      }
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

  async deleteReceipt(providerId: string, operationId: string): Promise<void> {
    assertProviderId(providerId);
    assertOperationId(operationId);
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.receiptStoreName, "readwrite");
      transaction.objectStore(this.receiptStoreName).delete(receiptKey(providerId, operationId));
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error || new Error("KeePass operation-receipt transaction aborted")); };
    });
  }

  async delete(providerId: string): Promise<void> {
    assertProviderId(providerId);
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([this.storeName, this.receiptStoreName], "readwrite");
      transaction.objectStore(this.storeName).delete(providerId);
      const receiptStore = transaction.objectStore(this.receiptStoreName);
      const cursor = receiptStore.index("providerId").openKeyCursor(IDBKeyRange.only(providerId));
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        receiptStore.delete(cursor.result.primaryKey);
        cursor.result.continue();
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error || new Error("KeePass working-copy transaction aborted")); };
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName);
        if (!request.result.objectStoreNames.contains(this.receiptStoreName)) {
          const store = request.result.createObjectStore(this.receiptStoreName, { keyPath: "key" });
          store.createIndex("providerId", "providerId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("KeePass working-copy database upgrade was blocked"));
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

function nextEncryptedReceipt(
  receipt: KeePassEncryptedMutationReceipt,
  existing: KeePassEncryptedMutationReceipt | undefined
): KeePassEncryptedMutationReceipt {
  const validated = validateEncryptedReceipt(receipt);
  if (!existing) return validated;
  const current = validateEncryptedReceipt(existing);
  if (current.providerId !== validated.providerId || current.operationId !== validated.operationId || current.intentTag !== validated.intentTag) {
    throw new KeePassWorkingCopyStoreError("operation-reused", "KeePass 操作标识已经用于其他持久操作。");
  }
  return current;
}

function validateEncryptedReceipt(value: unknown): KeePassEncryptedMutationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRecord();
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["key", "version", "providerId", "operationId", "intentTag", "completedAt", "cipher", "iv", "ciphertext"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) throw invalidRecord();
  const receipt: KeePassEncryptedMutationReceipt = {
    version: candidate.version as 1,
    providerId: candidate.providerId as string,
    operationId: candidate.operationId as string,
    intentTag: candidate.intentTag as string,
    completedAt: candidate.completedAt as string,
    cipher: candidate.cipher as "AES-256-GCM",
    iv: candidate.iv as string,
    ciphertext: candidate.ciphertext as string
  };
  assertEncryptedReceipt(receipt);
  if (candidate.key !== undefined && candidate.key !== receiptKey(receipt.providerId, receipt.operationId)) throw invalidRecord();
  return cloneEncryptedReceipt(receipt);
}

function assertEncryptedReceipt(receipt: KeePassEncryptedMutationReceipt): void {
  if (receipt.version !== 1 || receipt.cipher !== "AES-256-GCM") throw invalidRecord();
  assertProviderId(receipt.providerId);
  assertOperationId(receipt.operationId);
  assertSha256(receipt.intentTag);
  if (typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt))) throw invalidRecord();
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = base64ToBytes(receipt.iv);
    ciphertext = base64ToBytes(receipt.ciphertext);
  } catch {
    throw invalidRecord();
  }
  if (iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > KEEPASS_DURABLE_RECEIPT_MAX_CIPHERTEXT_BYTES) throw invalidRecord();
}

export function validateKeePassDurableMutationReceipt(value: unknown): KeePassDurableMutationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRecord();
  const receipt = value as KeePassDurableMutationReceipt;
  assertDurableReceipt(receipt);
  return structuredClone(receipt);
}

function assertDurableReceipt(receipt: KeePassDurableMutationReceipt): void {
  assertProviderId(receipt.providerId);
  assertOperationId(receipt.operationId);
  assertSha256(receipt.intentSha256);
  if (typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt))) throw invalidRecord();
  const groupKinds: KeePassDurableMutationKind[] = ["group-create", "group-rename", "group-move", "group-delete", "group-restore"];
  if (groupKinds.includes(receipt.kind)) {
    if (receipt.result?.type !== "group" || typeof receipt.result.changed !== "boolean") throw invalidRecord();
    assertOpaqueId(receipt.result.groupUuid);
    return;
  }
  if (receipt.kind === "history-restore") {
    if (receipt.result?.type !== "history" || typeof receipt.result.changed !== "boolean") throw invalidRecord();
    if (!Number.isSafeInteger(receipt.result.historyCount) || receipt.result.historyCount < 0 || receipt.result.historyCount > 100_000) throw invalidRecord();
    if (typeof receipt.result.modifiedAt !== "string" || !Number.isFinite(Date.parse(receipt.result.modifiedAt))) throw invalidRecord();
    return;
  }
  if (receipt.kind === "attachment-upload") {
    if (receipt.result?.type !== "attachment" || typeof receipt.result.changed !== "boolean") throw invalidRecord();
    assertOpaqueId(receipt.result.entryUuid);
    if (typeof receipt.result.fileName !== "string" || !receipt.result.fileName || receipt.result.fileName.includes("\0") || new TextEncoder().encode(receipt.result.fileName).byteLength > 4096) throw invalidRecord();
    return;
  }
  if (receipt.kind === "attachment-delete") {
    if (receipt.result?.type !== "attachment-delete" || typeof receipt.result.changed !== "boolean") throw invalidRecord();
    return;
  }
  if (receipt.kind === "item-sync") {
    if (receipt.result?.type !== "item-sync" || !Array.isArray(receipt.result.mutations) || !receipt.result.mutations.length || receipt.result.mutations.length > 100) throw invalidRecord();
    if (!Array.isArray(receipt.result.snapshotItems) || receipt.result.snapshotItems.length !== receipt.result.mutations.length) throw invalidRecord();
    if (!Array.isArray(receipt.result.conflicts) || receipt.result.conflicts.length > 100) throw invalidRecord();
    if (typeof receipt.result.syncedAt !== "string" || !Number.isFinite(Date.parse(receipt.result.syncedAt))) throw invalidRecord();
    const mutationIds = new Set<string>();
    const itemIds = new Set<string>();
    for (const mutation of receipt.result.mutations) {
      if (!mutation || typeof mutation !== "object") throw invalidRecord();
      assertOperationId(mutation.mutationId);
      assertOpaqueId(mutation.itemId);
      if (mutation.operation !== "create" && mutation.operation !== "update" && mutation.operation !== "delete") throw invalidRecord();
      if (typeof mutation.createdAt !== "string" || !Number.isFinite(Date.parse(mutation.createdAt))) throw invalidRecord();
      if (!Number.isSafeInteger(mutation.attempts) || mutation.attempts < 0 || mutation.attempts > 5) throw invalidRecord();
      if (mutation.lastError !== undefined && (typeof mutation.lastError !== "string" || mutation.lastError.length > 4096)) throw invalidRecord();
      if (typeof mutation.committed !== "boolean") throw invalidRecord();
      if (mutation.remoteId !== undefined) assertOpaqueId(mutation.remoteId);
      if (mutation.committed && !mutation.remoteId) throw invalidRecord();
      if (mutationIds.has(mutation.mutationId) || itemIds.has(mutation.itemId)) throw invalidRecord();
      mutationIds.add(mutation.mutationId);
      itemIds.add(mutation.itemId);
    }
    const snapshotIds = new Set<string>();
    for (const item of receipt.result.snapshotItems) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidRecord();
      assertOpaqueId(item.id);
      if (!itemIds.has(item.id) || snapshotIds.has(item.id)) throw invalidRecord();
      snapshotIds.add(item.id);
    }
    for (const conflict of receipt.result.conflicts) {
      if (!conflict || typeof conflict !== "object" || Array.isArray(conflict)) throw invalidRecord();
      assertOpaqueId(conflict.itemId);
      if (!itemIds.has(conflict.itemId) || typeof conflict.reason !== "string" || !conflict.reason || conflict.reason.length > 4096) throw invalidRecord();
      if (conflict.local !== undefined && (!conflict.local || typeof conflict.local !== "object" || Array.isArray(conflict.local))) throw invalidRecord();
      if (conflict.remote !== undefined && (!conflict.remote || typeof conflict.remote !== "object" || Array.isArray(conflict.remote))) throw invalidRecord();
    }
    return;
  }
  throw invalidRecord();
}

function assertOperationId(operationId: string): void {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) throw invalidRecord();
}

function assertOpaqueId(value: string): void {
  if (typeof value !== "string" || !value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw invalidRecord();
}

function receiptKey(providerId: string, operationId: string): string {
  return `${providerId}\u0000${operationId}`;
}

function pruneMemoryReceipts(receipts: Map<string, KeePassEncryptedMutationReceipt>, providerId: string): void {
  const providerReceipts = [...receipts.entries()].filter(([, receipt]) => receipt.providerId === providerId);
  if (providerReceipts.length < KEEPASS_DURABLE_RECEIPT_LIMIT) return;
  providerReceipts.sort(([, left], [, right]) => left.completedAt.localeCompare(right.completedAt));
  receipts.delete(providerReceipts[0][0]);
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

function cloneEncryptedReceipt(receipt: KeePassEncryptedMutationReceipt): KeePassEncryptedMutationReceipt {
  return { ...receipt };
}
