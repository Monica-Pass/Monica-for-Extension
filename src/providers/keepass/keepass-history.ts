import * as kdbxweb from "kdbxweb";

export const KEEPASS_HISTORY_MAX_PAGE_SIZE = 50;
export const KEEPASS_HISTORY_MAX_ITEMS = 10_000;
export const KEEPASS_HISTORY_MAX_FIELDS = 1_024;
export const KEEPASS_HISTORY_MAX_ATTACHMENTS = 512;
export const KEEPASS_HISTORY_MAX_FIELD_BYTES = 256 * 1024;

const KEEPASS_HISTORY_MAX_TEXT_CHARS = 512;
const KEEPASS_HISTORY_MAX_HANDLES = 4_096;
const KEEPASS_HISTORY_MAX_CURSORS = 512;
const KEEPASS_HISTORY_MAX_RECEIPTS = 256;

export class KeePassHistoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KeePassHistoryError";
  }
}

export interface KeePassHistorySummary {
  historyId: string;
  modifiedAt?: string;
  fieldCount: number;
  protectedFieldCount: number;
  attachmentCount: number;
  tagCount: number;
  customDataCount: number;
  autoTypeItemCount: number;
}

export interface KeePassHistoryPage {
  items: KeePassHistorySummary[];
  totalCount: number;
  nextCursor?: string;
}

export interface KeePassHistoryFieldSummary {
  fieldId: string;
  name: string;
  nameTruncated: boolean;
  protected: boolean;
  sizeBytes: number;
}

export interface KeePassHistoryAttachmentSummary {
  fileName: string;
  fileNameTruncated: boolean;
  sizeBytes: number;
  protected: boolean;
}

export interface KeePassHistoryDetail {
  historyId: string;
  modifiedAt?: string;
  createdAt?: string;
  expires: boolean;
  expiryAt?: string;
  fields: KeePassHistoryFieldSummary[];
  attachments: KeePassHistoryAttachmentSummary[];
  tagCount: number;
  customDataCount: number;
  qualityCheck?: boolean;
  autoType: {
    enabled: boolean;
    obfuscation: number;
    hasDefaultSequence: boolean;
    itemCount: number;
  };
}

export interface KeePassHistoryFieldValue {
  fieldId: string;
  name: string;
  protected: boolean;
  value: string;
}

export interface KeePassHistoryRestoreResult {
  changed: true;
  historyCount: number;
  modifiedAt: string;
}

export interface KeePassHistoryRestoreMutation {
  result: KeePassHistoryRestoreResult;
  replayed: boolean;
}

interface HistoryHandle {
  providerId: string;
  entryUuid: string;
  historyIndex: number;
  revision: number;
}

interface FieldHandle {
  providerId: string;
  entryUuid: string;
  historyId: string;
  fieldName: string;
}

interface HistoryCursor {
  providerId: string;
  entryUuid: string;
  offset: number;
  revision: number;
}

interface RestoreReceipt {
  providerId: string;
  entryUuid: string;
  historyId: string;
  result: KeePassHistoryRestoreResult;
}

export class KeePassHistoryStore {
  private readonly historyHandles = new Map<string, HistoryHandle>();
  private readonly historyHandleByKey = new Map<string, string>();
  private readonly fieldHandles = new Map<string, FieldHandle>();
  private readonly fieldHandleByKey = new Map<string, string>();
  private readonly cursors = new Map<string, HistoryCursor>();
  private readonly receipts = new Map<string, RestoreReceipt>();

  list(
    providerId: string,
    entryUuid: string,
    entry: kdbxweb.KdbxEntry,
    revision: number,
    request: { pageSize?: number; cursor?: string } = {}
  ): KeePassHistoryPage {
    const pageSize = request.pageSize ?? KEEPASS_HISTORY_MAX_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > KEEPASS_HISTORY_MAX_PAGE_SIZE) {
      throw new KeePassHistoryError(
        "keepass-history-page-size-invalid",
        `KeePass 历史分页数量必须介于 1 和 ${KEEPASS_HISTORY_MAX_PAGE_SIZE} 之间。`
      );
    }
    assertHistoryCount(entry.history.length);
    let offset = 0;
    if (request.cursor) {
      const cursor = this.cursors.get(request.cursor);
      if (!cursor || cursor.providerId !== providerId || cursor.entryUuid !== entryUuid) {
        throw new KeePassHistoryError("keepass-history-cursor-invalid", "KeePass 历史分页标识已失效，请重新加载。");
      }
      if (cursor.revision !== revision) {
        throw new KeePassHistoryError("keepass-history-cursor-stale", "KeePass 条目已经发生变化，请从第一页重新加载历史。");
      }
      offset = cursor.offset;
    }

    const end = Math.min(entry.history.length, offset + pageSize);
    const items: KeePassHistorySummary[] = [];
    for (let displayIndex = offset; displayIndex < end; displayIndex += 1) {
      const historyIndex = entry.history.length - 1 - displayIndex;
      const history = entry.history[historyIndex];
      const historyId = this.ensureHistoryHandle(providerId, entryUuid, historyIndex, revision);
      items.push(historySummary(historyId, history));
    }
    const nextCursor = end < entry.history.length
      ? this.createCursor({ providerId, entryUuid, offset: end, revision })
      : undefined;
    return { items, totalCount: entry.history.length, nextCursor };
  }

  detail(
    providerId: string,
    entryUuid: string,
    entry: kdbxweb.KdbxEntry,
    revision: number,
    historyId: string
  ): KeePassHistoryDetail {
    const history = this.resolveHistory(providerId, entryUuid, entry, revision, historyId);
    assertHistoryStructureBounds(history);
    const fields = [...history.fields.entries()].map(([name, value]) => {
      const displayName = truncateText(name);
      return {
        fieldId: this.ensureFieldHandle(providerId, entryUuid, historyId, name),
        name: displayName.value,
        nameTruncated: displayName.truncated,
        protected: value instanceof kdbxweb.ProtectedValue,
        sizeBytes: historyFieldSize(value)
      };
    });
    const attachments = [...history.binaries.entries()].map(([fileName, binary]) => {
      const displayName = truncateText(fileName);
      return {
        fileName: displayName.value,
        fileNameTruncated: displayName.truncated,
        sizeBytes: binarySize(binary),
        protected: binaryProtected(binary)
      };
    });
    return {
      historyId,
      modifiedAt: safeIso(history.times.lastModTime),
      createdAt: safeIso(history.times.creationTime),
      expires: history.times.expires === true,
      expiryAt: safeIso(history.times.expiryTime),
      fields,
      attachments,
      tagCount: history.tags.length,
      customDataCount: history.customData?.size ?? 0,
      qualityCheck: history.qualityCheck,
      autoType: {
        enabled: history.autoType.enabled,
        obfuscation: history.autoType.obfuscation,
        hasDefaultSequence: Boolean(history.autoType.defaultSequence),
        itemCount: history.autoType.items.length
      }
    };
  }

  readField(
    providerId: string,
    entryUuid: string,
    entry: kdbxweb.KdbxEntry,
    revision: number,
    historyId: string,
    fieldId: string
  ): KeePassHistoryFieldValue {
    const history = this.resolveHistory(providerId, entryUuid, entry, revision, historyId);
    const handle = typeof fieldId === "string" ? this.fieldHandles.get(fieldId) : undefined;
    if (!handle || handle.providerId !== providerId || handle.entryUuid !== entryUuid || handle.historyId !== historyId) {
      throw new KeePassHistoryError("keepass-history-field-handle-invalid", "KeePass 历史字段标识已失效，请重新打开历史详情。");
    }
    const value = history.fields.get(handle.fieldName);
    if (value === undefined) {
      throw new KeePassHistoryError("keepass-history-field-missing", "所选 KeePass 历史字段已不存在，请刷新详情。");
    }
    const sizeBytes = historyFieldSize(value);
    if (sizeBytes > KEEPASS_HISTORY_MAX_FIELD_BYTES) {
      throw new KeePassHistoryError(
        "keepass-history-field-too-large",
        `此 KeePass 历史字段超过安全上限（${KEEPASS_HISTORY_MAX_FIELD_BYTES / 1024} KiB），无法在管理页显示。`
      );
    }
    return {
      fieldId,
      name: truncateText(handle.fieldName).value,
      protected: value instanceof kdbxweb.ProtectedValue,
      value: historyFieldText(value)
    };
  }

  restore(
    database: kdbxweb.Kdbx,
    providerId: string,
    entryUuid: string,
    entry: kdbxweb.KdbxEntry,
    revision: number,
    operationId: string,
    historyId: string
  ): KeePassHistoryRestoreMutation {
    assertOperationId(operationId);
    const existing = this.receipts.get(operationId);
    if (existing) {
      if (existing.providerId !== providerId || existing.entryUuid !== entryUuid || existing.historyId !== historyId) {
        throw new KeePassHistoryError(
          "keepass-history-operation-reused",
          "KeePass 操作标识已经用于其他历史恢复。"
        );
      }
      return { result: existing.result, replayed: true };
    }

    const source = this.resolveHistory(providerId, entryUuid, entry, revision, historyId);
    const rollback = cloneCompleteEntry(entry);
    try {
      const currentParent = entry.parentGroup;
      const currentPreviousParent = cloneUuid(entry.previousParentGroup);
      const currentEditState = cloneEditState(entry._editState);

      entry.pushHistory();
      const currentSnapshot = entry.history[entry.history.length - 1];
      if (!currentSnapshot) {
        throw new KeePassHistoryError("keepass-history-snapshot-failed", "无法为当前 KeePass 条目建立恢复前快照。");
      }
      copyExtendedMetadata(currentSnapshot, entry);
      const retainedHistory = entry.history.slice();

      copyCompleteState(entry, source);
      entry.history = retainedHistory;
      entry.parentGroup = currentParent;
      entry.previousParentGroup = currentPreviousParent;
      entry._editState = currentEditState;
      entry.times.update();
      database.cleanup({ historyRules: true, binaries: true });

      const result: KeePassHistoryRestoreResult = {
        changed: true,
        historyCount: entry.history.length,
        modifiedAt: safeIso(entry.times.lastModTime) ?? new Date().toISOString()
      };
      if (this.receipts.size >= KEEPASS_HISTORY_MAX_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value!);
      this.receipts.set(operationId, { providerId, entryUuid, historyId, result });
      return { result, replayed: false };
    } catch (error) {
      restoreCompleteEntry(entry, rollback);
      throw error;
    }
  }

  invalidateProviderViews(providerId: string): void {
    // Keep old cursors and handles long enough to report a deterministic revision-stale error.
    // Locking clears them; normal mutations only advance the session revision.
    void providerId;
  }

  clearProvider(providerId: string): void {
    this.invalidateProviderViews(providerId);
    for (const [operationId, receipt] of this.receipts) if (receipt.providerId === providerId) this.receipts.delete(operationId);
  }

  clear(): void {
    this.historyHandles.clear();
    this.historyHandleByKey.clear();
    this.fieldHandles.clear();
    this.fieldHandleByKey.clear();
    this.cursors.clear();
    this.receipts.clear();
  }

  private resolveHistory(
    providerId: string,
    entryUuid: string,
    entry: kdbxweb.KdbxEntry,
    revision: number,
    historyId: string
  ): kdbxweb.KdbxEntry {
    const handle = typeof historyId === "string" ? this.historyHandles.get(historyId) : undefined;
    if (!handle || handle.providerId !== providerId || handle.entryUuid !== entryUuid) {
      throw new KeePassHistoryError("keepass-history-handle-invalid", "KeePass 历史标识已失效，请重新加载历史列表。");
    }
    if (handle.revision !== revision) {
      throw new KeePassHistoryError("keepass-history-handle-stale", "KeePass 条目已经发生变化，请重新加载历史列表。");
    }
    const history = entry.history[handle.historyIndex];
    if (!history) {
      throw new KeePassHistoryError("keepass-history-missing", "所选 KeePass 历史版本已不存在，请刷新列表。");
    }
    return history;
  }

  private ensureHistoryHandle(providerId: string, entryUuid: string, historyIndex: number, revision: number): string {
    const key = `${providerId}\u0000${entryUuid}\u0000${revision}\u0000${historyIndex}`;
    const existing = this.historyHandleByKey.get(key);
    if (existing) return existing;
    if (this.historyHandles.size >= KEEPASS_HISTORY_MAX_HANDLES) {
      this.removeHistoryHandle(this.historyHandles.keys().next().value!);
    }
    const historyId = crypto.randomUUID();
    this.historyHandles.set(historyId, { providerId, entryUuid, historyIndex, revision });
    this.historyHandleByKey.set(key, historyId);
    return historyId;
  }

  private removeHistoryHandle(historyId: string): void {
    const handle = this.historyHandles.get(historyId);
    if (!handle) return;
    this.historyHandles.delete(historyId);
    this.historyHandleByKey.delete(`${handle.providerId}\u0000${handle.entryUuid}\u0000${handle.revision}\u0000${handle.historyIndex}`);
    for (const [fieldId, field] of this.fieldHandles) {
      if (field.historyId !== historyId) continue;
      this.fieldHandles.delete(fieldId);
      this.fieldHandleByKey.delete(`${historyId}\u0000${field.fieldName}`);
    }
  }

  private ensureFieldHandle(providerId: string, entryUuid: string, historyId: string, fieldName: string): string {
    const key = `${historyId}\u0000${fieldName}`;
    const existing = this.fieldHandleByKey.get(key);
    if (existing) return existing;
    if (this.fieldHandles.size >= KEEPASS_HISTORY_MAX_HANDLES) {
      const oldest = this.fieldHandles.keys().next().value!;
      const handle = this.fieldHandles.get(oldest)!;
      this.fieldHandles.delete(oldest);
      this.fieldHandleByKey.delete(`${handle.historyId}\u0000${handle.fieldName}`);
    }
    const fieldId = crypto.randomUUID();
    this.fieldHandles.set(fieldId, { providerId, entryUuid, historyId, fieldName });
    this.fieldHandleByKey.set(key, fieldId);
    return fieldId;
  }

  private createCursor(cursor: HistoryCursor): string {
    if (this.cursors.size >= KEEPASS_HISTORY_MAX_CURSORS) this.cursors.delete(this.cursors.keys().next().value!);
    const cursorId = crypto.randomUUID();
    this.cursors.set(cursorId, cursor);
    return cursorId;
  }
}

function historySummary(historyId: string, history: kdbxweb.KdbxEntry): KeePassHistorySummary {
  assertHistoryStructureBounds(history);
  let protectedFieldCount = 0;
  for (const value of history.fields.values()) if (value instanceof kdbxweb.ProtectedValue) protectedFieldCount += 1;
  return {
    historyId,
    modifiedAt: safeIso(history.times.lastModTime),
    fieldCount: history.fields.size,
    protectedFieldCount,
    attachmentCount: history.binaries.size,
    tagCount: history.tags.length,
    customDataCount: history.customData?.size ?? 0,
    autoTypeItemCount: history.autoType.items.length
  };
}

function assertHistoryCount(count: number): void {
  if (count > KEEPASS_HISTORY_MAX_ITEMS) {
    throw new KeePassHistoryError(
      "keepass-history-count-limit",
      `此 KeePass 条目的历史版本超过 ${KEEPASS_HISTORY_MAX_ITEMS} 项安全上限，数据保持原样但无法在管理页中展开。`
    );
  }
}

function assertHistoryStructureBounds(history: kdbxweb.KdbxEntry): void {
  if (history.fields.size > KEEPASS_HISTORY_MAX_FIELDS) {
    throw new KeePassHistoryError(
      "keepass-history-field-count-limit",
      `此 KeePass 历史版本包含超过 ${KEEPASS_HISTORY_MAX_FIELDS} 个字段，数据保持原样但无法在管理页中展开。`
    );
  }
  if (history.binaries.size > KEEPASS_HISTORY_MAX_ATTACHMENTS) {
    throw new KeePassHistoryError(
      "keepass-history-attachment-count-limit",
      `此 KeePass 历史版本包含超过 ${KEEPASS_HISTORY_MAX_ATTACHMENTS} 个附件，数据保持原样但无法在管理页中展开。`
    );
  }
}

function assertOperationId(operationId: string): void {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) {
    throw new KeePassHistoryError("keepass-history-operation-id-invalid", "KeePass 历史恢复操作标识无效。");
  }
}

function truncateText(value: string): { value: string; truncated: boolean } {
  if (value.length <= KEEPASS_HISTORY_MAX_TEXT_CHARS) return { value, truncated: false };
  return { value: value.slice(0, KEEPASS_HISTORY_MAX_TEXT_CHARS), truncated: true };
}

function safeIso(value: Date | undefined): string | undefined {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
}

function historyFieldSize(value: kdbxweb.KdbxEntryField): number {
  return value instanceof kdbxweb.ProtectedValue ? value.byteLength : new TextEncoder().encode(value).byteLength;
}

function historyFieldText(value: kdbxweb.KdbxEntryField): string {
  if (typeof value === "string") return value;
  const bytes = value.getBinary();
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

function binaryValue(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): kdbxweb.KdbxBinary {
  return kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
}

function binarySize(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): number {
  return binaryValue(binary).byteLength;
}

function binaryProtected(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): boolean {
  return binaryValue(binary) instanceof kdbxweb.ProtectedValue;
}

function cloneCustomData(customData: kdbxweb.KdbxCustomDataMap | undefined): kdbxweb.KdbxCustomDataMap | undefined {
  if (!customData) return undefined;
  return new Map([...customData.entries()].map(([key, item]) => [key, {
    value: item.value,
    lastModified: item.lastModified ? new Date(item.lastModified) : undefined
  }]));
}

function cloneUuid(uuid: kdbxweb.KdbxUuid | undefined): kdbxweb.KdbxUuid | undefined {
  return uuid ? new kdbxweb.KdbxUuid(uuid.toString()) : undefined;
}

function cloneEditState(editState: kdbxweb.KdbxEntryEditState | undefined): kdbxweb.KdbxEntryEditState | undefined {
  return editState ? { added: [...editState.added], deleted: [...editState.deleted] } : undefined;
}

function copyExtendedMetadata(target: kdbxweb.KdbxEntry, source: kdbxweb.KdbxEntry): void {
  target.customData = cloneCustomData(source.customData);
  target.qualityCheck = source.qualityCheck;
  target.previousParentGroup = cloneUuid(source.previousParentGroup);
}

function copyCompleteState(target: kdbxweb.KdbxEntry, source: kdbxweb.KdbxEntry): void {
  target.copyFrom(source);
  copyExtendedMetadata(target, source);
}

function cloneCompleteEntry(source: kdbxweb.KdbxEntry): kdbxweb.KdbxEntry {
  const clone = new kdbxweb.KdbxEntry();
  copyCompleteState(clone, source);
  clone.history = source.history.map((history) => {
    const historyClone = new kdbxweb.KdbxEntry();
    copyCompleteState(historyClone, history);
    return historyClone;
  });
  clone.parentGroup = source.parentGroup;
  clone.previousParentGroup = cloneUuid(source.previousParentGroup);
  clone._editState = cloneEditState(source._editState);
  return clone;
}

function restoreCompleteEntry(target: kdbxweb.KdbxEntry, source: kdbxweb.KdbxEntry): void {
  copyCompleteState(target, source);
  target.history = source.history.map((history) => {
    const historyClone = new kdbxweb.KdbxEntry();
    copyCompleteState(historyClone, history);
    return historyClone;
  });
  target.parentGroup = source.parentGroup;
  target.previousParentGroup = cloneUuid(source.previousParentGroup);
  target._editState = cloneEditState(source._editState);
}
