import * as kdbxweb from "kdbxweb";
import type { PasskeyItem, PendingMutation, ProviderAccount, ProviderReference, ProviderSourceRecord, VaultItem } from "../../core/model";
import type { ProviderAcknowledgedMutation, ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { createSourceRecord } from "../../core/source-records";
import { normalizeCredentialId } from "../../passkey/source-policy";
import {
  KEEPASS_ATTACHMENT_MAX_BYTES,
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  ProviderAttachmentError,
  type ProviderAttachmentSummary
} from "../attachments/attachment-contract";
import { keePassSourceRecordFor, openKeePassVault, readKeePassEntries, type KeePassSkippedEntry, type KeePassVaultEntries } from "./keepass-vault";
import { createKeePassEntry, removeKeePassEntry, writeKeePassEntry } from "./keepass-writer";
import { readKeePassPasskeyFields } from "./keepass-passkey-codec";
import {
  KEEPASS_GROUP_MAX_PAGE_SIZE,
  KeePassGroupError,
  createKeePassGroup,
  deleteKeePassGroup,
  listKeePassGroupRecords,
  moveKeePassGroup,
  renameKeePassGroup,
  requireKeePassGroup,
  restoreKeePassGroup,
  truncateKeePassGroupText,
  type KeePassGroupMutationResult,
  type KeePassGroupPage,
  type KeePassGroupRecord,
  type KeePassGroupSummary
} from "./keepass-groups";
import {
  KeePassHistoryError,
  KeePassHistoryStore,
  type KeePassHistoryDetail,
  type KeePassHistoryFieldValue,
  type KeePassHistoryPage,
  type KeePassHistoryRestoreResult
} from "./keepass-history";

const KEEPASS_PENDING_SYNC_LIMIT = 100;

export class KeePassPasskeyCredentialConflictError extends Error {
  readonly code = "keepass-passkey-credential-conflict";

  constructor() {
    super("目标 KeePass 数据库中已存在相同的 Passkey 凭据 ID。");
    this.name = "KeePassPasskeyCredentialConflictError";
  }
}

/**
 * What the settings UI is allowed to see. The open `Kdbx`, the master credential and the entry fields
 * stay in this module: the popup and content scripts must never receive more than a summary.
 */
export interface KeePassSessionSummary {
  providerId: string;
  sourceMode: "local-file" | "webdav";
  databaseName: string;
  versionMajor: number;
  cipherName?: string;
  itemCount: number;
  /** Entries no codec claimed. Never rewritten, reported so the user knows they are still in the file. */
  skipped: KeePassSkippedEntry[];
  warnings: string[];
  /** Writes live in memory until the file is exported; the UI must prompt while this is true. */
  dirty: boolean;
}

interface KeePassSession {
  database: kdbxweb.Kdbx;
  databaseId: number;
  entries: KeePassVaultEntries;
  summary: Omit<KeePassSessionSummary, "itemCount" | "skipped" | "dirty">;
  dirty: boolean;
  groupRevision: number;
  historyRevision: number;
}

export interface KeePassUnlockCredential {
  password: string;
  keyFile?: Uint8Array;
  sourceName?: string;
  sourceMode?: "local-file" | "webdav";
  dirty?: boolean;
}

export interface KeePassAttachmentReadResult {
  attachment: ProviderAttachmentSummary;
  offset: number;
  nextOffset: number;
  bytes: Uint8Array;
  eof: boolean;
}

interface KeePassAttachmentHandle {
  providerId: string;
  entryUuid: string;
  fileName: string;
}

interface KeePassGroupHandle {
  providerId: string;
  groupUuid: string;
}

interface KeePassGroupCursor {
  providerId: string;
  includeRecycleBin: boolean;
  offset: number;
  revision: number;
}

interface KeePassGroupOperationReceipt {
  providerId: string;
  intent: string;
  result: KeePassGroupMutationResult;
}

/**
 * One adapter instance serves every `.kdbx` file, because `ProviderRegistry` keys adapters by
 * `ProviderKind` (`provider.ts:31`). Files are multiplexed on `account.id`.
 *
 * A session must be opened with {@link unlock} before any other method works. The bytes come from a
 * file the user picked in an extension page, and {@link exportFile} hands the edited file back for the
 * user to save over the original: the browser cannot hold a writable handle to the picked file across
 * a service-worker restart, so the extension never claims to edit the original in place.
 */
export class KeePassProvider implements ProviderAdapter {
  readonly kind = "keepass" as const;
  private readonly sessions = new Map<string, KeePassSession>();
  private readonly attachmentHandles = new Map<string, KeePassAttachmentHandle>();
  private readonly attachmentHandleByKey = new Map<string, string>();
  private readonly groupHandles = new Map<string, KeePassGroupHandle>();
  private readonly groupHandleByKey = new Map<string, string>();
  private readonly groupCursors = new Map<string, KeePassGroupCursor>();
  private readonly groupOperationReceipts = new Map<string, KeePassGroupOperationReceipt>();
  private readonly historyStore = new KeePassHistoryStore();

  async unlock(
    account: ProviderAccount,
    bytes: Uint8Array,
    credential: KeePassUnlockCredential
  ): Promise<KeePassSessionSummary> {
    const snapshot = await openKeePassVault(bytes, {
      password: credential.password,
      keyFile: credential.keyFile,
      sourceName: credential.sourceName,
      databaseId: databaseIdOf(account),
      providerId: account.id
    });

    this.lockAccount(account.id);
    this.sessions.set(account.id, {
      database: snapshot.database,
      databaseId: databaseIdOf(account),
      entries: { items: snapshot.items, skipped: snapshot.skipped, entriesByUuid: snapshot.entriesByUuid },
      summary: {
        providerId: account.id,
        sourceMode: credential.sourceMode === "webdav" ? "webdav" : "local-file",
        databaseName: snapshot.database.meta.name || credential.sourceName || "KeePass 数据库",
        versionMajor: snapshot.versionMajor,
        cipherName: snapshot.cipherName,
        warnings: snapshot.warnings
      },
      dirty: Boolean(credential.dirty),
      groupRevision: 0,
      historyRevision: 0
    });
    return this.summarize(account.id);
  }

  isUnlocked(providerId: string): boolean {
    return this.sessions.has(providerId);
  }

  summarize(providerId: string): KeePassSessionSummary {
    const session = this.requireSession(providerId);
    return {
      ...session.summary,
      itemCount: session.entries.items.filter((item) => !item.deletedAt).length,
      skipped: session.entries.skipped,
      dirty: session.dirty
    };
  }

  /**
   * Re-encrypts the whole database so the user can overwrite the original file, and clears the
   * unsaved-changes flag. The KDF is whatever the file already declares, so a KDBX 3 file stays KDBX 3.
   */
  async exportFile(providerId: string): Promise<Uint8Array> {
    const session = this.requireSession(providerId);
    const bytes = await this.snapshotFile(providerId);
    session.dirty = false;
    return bytes;
  }

  /** Saves the current encrypted KDBX without changing whether remote or local edits are pending. */
  async snapshotFile(providerId: string): Promise<Uint8Array> {
    const session = this.requireSession(providerId);
    return new Uint8Array(await session.database.save());
  }

  listGroups(
    account: ProviderAccount,
    request: { includeRecycleBin?: boolean; cursor?: string; pageSize?: number } = {}
  ): KeePassGroupPage {
    const session = this.requireKeePassAccountSession(account);
    const pageSize = request.pageSize ?? KEEPASS_GROUP_MAX_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > KEEPASS_GROUP_MAX_PAGE_SIZE) {
      throw new KeePassGroupError("keepass-group-page-size-invalid", `KeePass 分组分页数量必须介于 1 和 ${KEEPASS_GROUP_MAX_PAGE_SIZE} 之间。`);
    }
    const includeRecycleBin = request.includeRecycleBin === true;
    let offset = 0;
    if (request.cursor) {
      const cursor = this.groupCursors.get(request.cursor);
      if (!cursor || cursor.providerId !== account.id || cursor.includeRecycleBin !== includeRecycleBin) {
        throw new KeePassGroupError("keepass-group-cursor-invalid", "KeePass 分组分页标识已失效，请刷新列表。");
      }
      if (cursor.revision !== session.groupRevision) {
        throw new KeePassGroupError("keepass-group-cursor-stale", "KeePass 分组已经发生变化，请从第一页重新加载。");
      }
      offset = cursor.offset;
    }

    const records = listKeePassGroupRecords(session.database, includeRecycleBin);
    const items = records.slice(offset, offset + pageSize).map((record) => this.groupSummary(account.id, session, record));
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < records.length
      ? this.createGroupCursor({ providerId: account.id, includeRecycleBin, offset: nextOffset, revision: session.groupRevision })
      : undefined;
    const rootName = truncateKeePassGroupText(session.database.getDefaultGroup().name?.trim() || "KeePass", 128).value;
    return { items, nextCursor, rootName, recycleBinEnabled: session.database.meta.recycleBinEnabled !== false };
  }

  createGroup(account: ProviderAccount, operationId: string, name: unknown, parentGroupId?: string): KeePassGroupMutationResult {
    const session = this.requireKeePassAccountSession(account);
    const parentUuid = parentGroupId ? this.requireGroupHandle(account.id, parentGroupId).groupUuid : undefined;
    const intent = groupIntent("create", parentUuid ?? "root", name);
    return this.runGroupMutation(account.id, session, operationId, intent, () => createKeePassGroup(session.database, parentUuid, name));
  }

  renameGroup(account: ProviderAccount, operationId: string, groupId: string, name: unknown): KeePassGroupMutationResult {
    const session = this.requireKeePassAccountSession(account);
    const groupUuid = this.requireGroupHandle(account.id, groupId).groupUuid;
    const intent = groupIntent("rename", groupUuid, name);
    return this.runGroupMutation(account.id, session, operationId, intent, () => renameKeePassGroup(session.database, groupUuid, name));
  }

  moveGroup(account: ProviderAccount, operationId: string, groupId: string, targetParentGroupId?: string): KeePassGroupMutationResult {
    const session = this.requireKeePassAccountSession(account);
    const groupUuid = this.requireGroupHandle(account.id, groupId).groupUuid;
    const targetParentUuid = targetParentGroupId ? this.requireGroupHandle(account.id, targetParentGroupId).groupUuid : undefined;
    const intent = groupIntent("move", groupUuid, targetParentUuid ?? "root");
    return this.runGroupMutation(account.id, session, operationId, intent, () => moveKeePassGroup(session.database, groupUuid, targetParentUuid));
  }

  deleteGroup(account: ProviderAccount, operationId: string, groupId: string): KeePassGroupMutationResult {
    const session = this.requireKeePassAccountSession(account);
    const groupUuid = this.requireGroupHandle(account.id, groupId).groupUuid;
    const intent = groupIntent("delete", groupUuid);
    return this.runGroupMutation(account.id, session, operationId, intent, () => ({
      group: deleteKeePassGroup(session.database, groupUuid),
      changed: true
    }));
  }

  restoreGroup(account: ProviderAccount, operationId: string, groupId: string, targetParentGroupId?: string): KeePassGroupMutationResult {
    const session = this.requireKeePassAccountSession(account);
    const groupUuid = this.requireGroupHandle(account.id, groupId).groupUuid;
    const targetParentUuid = targetParentGroupId ? this.requireGroupHandle(account.id, targetParentGroupId).groupUuid : undefined;
    const intent = groupIntent("restore", groupUuid, targetParentUuid ?? "previous-or-root");
    return this.runGroupMutation(account.id, session, operationId, intent, () => ({
      group: restoreKeePassGroup(session.database, groupUuid, targetParentUuid),
      changed: true
    }));
  }

  groupUuidForHandle(providerId: string, groupId: string): string {
    return this.requireGroupHandle(providerId, groupId).groupUuid;
  }

  groupResultFromUuid(account: ProviderAccount, groupUuid: string, changed: boolean): KeePassGroupMutationResult {
    const session = this.requireKeePassAccountSession(account);
    const record = listKeePassGroupRecords(session.database, true).find((candidate) => candidate.uuid === groupUuid);
    if (!record) throw new KeePassGroupError("keepass-group-result-missing", "KeePass 持久操作完成后无法读取目标分组。");
    return { changed, group: this.groupSummary(account.id, session, record) };
  }

  listEntryHistory(
    account: ProviderAccount,
    item: VaultItem,
    request: { pageSize?: number; cursor?: string } = {}
  ): KeePassHistoryPage {
    const { session, entryUuid, entry } = this.requireHistoryEntry(account, item);
    return this.historyStore.list(account.id, entryUuid, entry, session.historyRevision, request);
  }

  getEntryHistoryDetail(account: ProviderAccount, item: VaultItem, historyId: string): KeePassHistoryDetail {
    const { session, entryUuid, entry } = this.requireHistoryEntry(account, item);
    return this.historyStore.detail(account.id, entryUuid, entry, session.historyRevision, historyId);
  }

  readEntryHistoryField(
    account: ProviderAccount,
    item: VaultItem,
    historyId: string,
    fieldId: string
  ): KeePassHistoryFieldValue {
    const { session, entryUuid, entry } = this.requireHistoryEntry(account, item);
    return this.historyStore.readField(account.id, entryUuid, entry, session.historyRevision, historyId, fieldId);
  }

  restoreEntryHistory(
    account: ProviderAccount,
    item: VaultItem,
    operationId: string,
    historyId: string
  ): KeePassHistoryRestoreResult {
    const { session, entryUuid, entry } = this.requireHistoryEntry(account, item);
    const mutation = this.historyStore.restore(
      session.database,
      account.id,
      entryUuid,
      entry,
      session.historyRevision,
      operationId,
      historyId
    );
    if (!mutation.replayed) {
      session.dirty = true;
      this.reread(session, account.id);
    }
    return mutation.result;
  }

  listAttachments(account: ProviderAccount, item: VaultItem): ProviderAttachmentSummary[] {
    const { entryUuid, entry } = this.requireAttachmentEntry(account, item);
    return [...entry.binaries.entries()].map(([fileName, binary]) => this.attachmentSummary(
      account.id,
      entryUuid,
      fileName,
      binary
    ));
  }

  readAttachment(
    account: ProviderAccount,
    item: VaultItem,
    attachmentId: string,
    offset: number,
    maxBytes = PROVIDER_ATTACHMENT_CHUNK_BYTES
  ): KeePassAttachmentReadResult {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ProviderAttachmentError("attachment-offset-invalid", "附件读取偏移量无效。");
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > PROVIDER_ATTACHMENT_CHUNK_BYTES) {
      throw new ProviderAttachmentError("attachment-chunk-size-invalid", "附件读取分块必须介于 1 字节和 256 KiB 之间。");
    }
    const { entryUuid, entry } = this.requireAttachmentEntry(account, item);
    const handle = this.requireAttachmentHandle(account.id, entryUuid, attachmentId);
    const binary = entry.binaries.get(handle.fileName);
    if (!binary) {
      this.removeAttachmentHandle(attachmentId);
      throw new ProviderAttachmentError("attachment-not-found", "此 KeePass 附件已不存在，请刷新附件列表。");
    }
    const attachment = this.attachmentSummary(account.id, entryUuid, handle.fileName, binary);
    if (offset > attachment.sizeBytes) throw new ProviderAttachmentError("attachment-offset-invalid", "附件读取偏移量超过文件大小。");
    const nextOffset = Math.min(attachment.sizeBytes, offset + maxBytes);
    const bytes = copyBinaryRange(binary, offset, nextOffset);
    return { attachment, offset, nextOffset, bytes, eof: nextOffset === attachment.sizeBytes };
  }

  async addAttachment(
    account: ProviderAccount,
    item: VaultItem,
    fileName: string,
    bytes: Uint8Array,
    replaceExisting: boolean
  ): Promise<ProviderAttachmentSummary> {
    if (bytes.byteLength > KEEPASS_ATTACHMENT_MAX_BYTES) {
      throw new ProviderAttachmentError("attachment-size-invalid", "KeePass 附件超过当前浏览器支持的 256 MiB 上限。");
    }
    const { session, entryUuid, entry } = this.requireAttachmentEntry(account, item);
    if (entry.binaries.has(fileName) && !replaceExisting) {
      throw new ProviderAttachmentError("attachment-name-conflict", "此条目已有同名附件，需要明确确认替换。");
    }
    const binary = await session.database.createBinary(bytes.slice().buffer);
    entry.pushHistory();
    entry.binaries.set(fileName, binary);
    entry.times.update();
    session.database.cleanup({ historyRules: true, binaries: true });
    session.dirty = true;
    this.reread(session, account.id);
    return this.attachmentSummary(account.id, entryUuid, fileName, binary);
  }

  deleteAttachment(account: ProviderAccount, item: VaultItem, attachmentId: string): boolean {
    const { session, entryUuid, entry } = this.requireAttachmentEntry(account, item);
    const handle = this.requireAttachmentHandle(account.id, entryUuid, attachmentId);
    if (!entry.binaries.has(handle.fileName)) {
      return false;
    }
    entry.pushHistory();
    entry.binaries.delete(handle.fileName);
    entry.times.update();
    session.database.cleanup({ historyRules: true, binaries: true });
    session.dirty = true;
    this.reread(session, account.id);
    return true;
  }

  attachmentEntryUuid(account: ProviderAccount, item: VaultItem): string {
    return this.requireAttachmentEntry(account, item).entryUuid;
  }

  attachmentResultFromName(account: ProviderAccount, item: VaultItem, fileName: string, changed: boolean): { changed: boolean; attachment: ProviderAttachmentSummary } {
    const { entryUuid, entry } = this.requireAttachmentEntry(account, item);
    const binary = entry.binaries.get(fileName);
    if (!binary) throw new ProviderAttachmentError("attachment-not-found", "持久化的 KeePass 附件已经不存在，请刷新附件列表。");
    return { changed, attachment: this.attachmentSummary(account.id, entryUuid, fileName, binary) };
  }

  assertAttachmentTarget(account: ProviderAccount, item: VaultItem): void {
    this.requireAttachmentEntry(account, item);
  }

  lockAccount(providerId: string): void {
    this.sessions.delete(providerId);
    this.removeProviderAttachmentHandles(providerId);
    this.removeProviderGroupState(providerId);
    this.historyStore.clearProvider(providerId);
  }

  lock(): void {
    this.sessions.clear();
    this.attachmentHandles.clear();
    this.attachmentHandleByKey.clear();
    this.groupHandles.clear();
    this.groupHandleByKey.clear();
    this.groupCursors.clear();
    this.groupOperationReceipts.clear();
    this.historyStore.clear();
  }

  async testConnection(account: ProviderAccount): Promise<void> {
    this.requireSession(account.id);
  }

  async sync(account: ProviderAccount, context: ProviderSyncContext): Promise<ProviderSyncResult> {
    const session = this.requireSession(account.id);
    const scoped = context.localItems.filter((item) => referenceOf(item, account.id));
    const unrelated = context.localItems.filter((item) => !referenceOf(item, account.id));
    const pendingByItemId = context.pendingMutations === undefined
      ? undefined
      : boundedPendingMutations(context.pendingMutations, account.id);
    const acknowledgedByItemId = boundedAcknowledgedMutations(context.acknowledgedMutations || []);

    const localByUuid = new Map<string, VaultItem>();
    const creations: VaultItem[] = [];
    const deferredCreations: VaultItem[] = [];
    for (const item of scoped) {
      const acknowledged = acknowledgedByItemId.get(item.id);
      if (acknowledged) {
        localByUuid.set(acknowledged.remoteId, item);
        continue;
      }
      const remoteId = referenceOf(item, account.id)?.remoteId;
      if (remoteId) localByUuid.set(remoteId, item);
      else if (!item.deletedAt) {
        if (pendingByItemId && !pendingByItemId.has(item.id)) deferredCreations.push(item);
        else creations.push(item);
      }
    }
    const remoteByUuid = new Map(session.entries.items.map((item) => [remoteIdOf(item, account.id), item]));

    const conflicts: ProviderSyncResult["conflicts"] = [];
    const keepLocal = new Map<string, VaultItem>();
    const updates: Array<{ entryUuid: string; item: VaultItem }> = [];
    const deletions: string[] = [];

    for (const [entryUuid, local] of localByUuid) {
      const reference = referenceOf(local, account.id)!;
      const remote = remoteByUuid.get(entryUuid);
      const acknowledged = acknowledgedByItemId.get(local.id);
      if (acknowledged) {
        if (acknowledged.remoteId !== entryUuid) throw new Error("KeePass 持久同步回执与条目标识不一致。");
        if (acknowledged.operation === "delete") {
          if (remote && !remote.deletedAt) throw new Error("KeePass 持久同步记录为已删除，但 KDBX 条目仍然处于活动状态。");
          continue;
        }
        if (!remote) throw new Error("KeePass 持久同步记录缺少已提交的 KDBX 条目。");
        continue;
      }
      /** No stored fingerprint means no baseline, so the safe move is always to take the file's copy. */
      const localChanged = Boolean(reference.etag) && fingerprint(local) !== reference.etag;

      if (pendingByItemId && !pendingByItemId.has(local.id) && (localChanged || local.deletedAt)) {
        keepLocal.set(entryUuid, local);
        continue;
      }

      if (!remote) {
        if (local.deletedAt) continue;
        if (reference.etag && !localChanged) continue;
        conflicts.push({ itemId: local.id, reason: "此条目已从 KeePass 数据库中移除，但浏览器中还有未同步的修改。", local });
        keepLocal.set(entryUuid, local);
        continue;
      }

      const remoteChanged = (referenceOf(remote, account.id)?.revision || "") !== (reference.revision || "");
      if (local.deletedAt) {
        if (remoteChanged) {
          conflicts.push({ itemId: local.id, reason: "此条目在浏览器中已删除，但 Monica Android 之后又修改过它。", local, remote });
          keepLocal.set(entryUuid, local);
        } else {
          deletions.push(entryUuid);
        }
        continue;
      }
      if (!localChanged) continue;
      if (remoteChanged) {
        conflicts.push({ itemId: local.id, reason: "浏览器和 Monica Android 在上次同步后都修改了此条目。", local, remote });
        keepLocal.set(entryUuid, local);
        continue;
      }
      updates.push({ entryUuid, item: local });
    }

    const passkeyConflicts = conflictingPasskeyMutations(session, updates, creations);
    for (const update of updates) {
      if (!passkeyConflicts.has(update.item.id)) continue;
      conflicts.push({
        itemId: update.item.id,
        reason: "目标 KeePass 数据库中已存在相同的 Passkey 凭据 ID。",
        local: update.item,
        remote: remoteByUuid.get(update.entryUuid)
      });
      keepLocal.set(update.entryUuid, update.item);
    }
    for (const item of creations) {
      if (!passkeyConflicts.has(item.id)) continue;
      conflicts.push({ itemId: item.id, reason: "目标 KeePass 数据库中已存在相同的 Passkey 凭据 ID。", local: item });
      deferredCreations.push(item);
    }
    const applicableUpdates = updates.filter((update) => !passkeyConflicts.has(update.item.id));
    const applicableCreations = creations.filter((item) => !passkeyConflicts.has(item.id));

    for (const update of applicableUpdates) {
      const entry = session.entries.entriesByUuid.get(update.entryUuid);
      if (entry) writeKeePassEntry(session.database, entry, update.item);
    }
    for (const item of applicableCreations) {
      const { entry } = createKeePassEntry(session.database, item, item.keepassGroupPath);
      localByUuid.set(entry.uuid.toString(), item);
    }
    for (const entryUuid of deletions) {
      const entry = session.entries.entriesByUuid.get(entryUuid);
      if (entry) removeKeePassEntry(session.database, entry);
    }

    if (applicableUpdates.length + applicableCreations.length + deletions.length) session.dirty = true;
    this.reread(session, account.id);

    const warnings = [...session.summary.warnings];
    const items = [...unrelated, ...deferredCreations];
    const emitted = new Set<string>();
    for (const remote of session.entries.items) {
      const entryUuid = remoteIdOf(remote, account.id);
      emitted.add(entryUuid);
      const conflicted = keepLocal.get(entryUuid);
      if (conflicted) items.push(conflicted);
      else if (!remote.deletedAt) items.push(finalize(remote, localByUuid.get(entryUuid), account.id));
    }
    for (const [entryUuid, local] of keepLocal) if (!emitted.has(entryUuid)) items.push(local);

    if (session.entries.skipped.length) {
      warnings.push(`有 ${session.entries.skipped.length} 个条目本版本无法解析，已原样保留、不会被改写。`);
    }
    if (session.dirty) {
      warnings.push(account.config.sourceMode === "webdav"
        ? "KeePass 数据库的改动已保存到本机工作副本，上传 WebDAV 后其他设备才能读取。"
        : "KeePass 数据库的改动仅存在于内存中，请导出文件并覆盖原文件后再在 Monica Android 或 KeePassXC 中打开。");
    }

    return {
      items,
      accountPatch: conflicts.length
        ? { lastError: `发现 ${conflicts.length} 个 KeePass 同步冲突。` }
        : { lastSyncAt: context.now, lastError: undefined },
      conflicts,
      warnings,
      sourceRecords: await skippedSourceRecords(session, account.id)
    };
  }

  /** Re-reads the current provider session after a remote three-way rebase without replaying edits. */
  async refreshFromSession(account: ProviderAccount, identityItems: VaultItem[], now: string): Promise<ProviderSyncResult> {
    const session = this.requireSession(account.id);
    const localByUuid = new Map<string, VaultItem>();
    for (const item of identityItems) {
      const remoteId = referenceOf(item, account.id)?.remoteId;
      if (remoteId) localByUuid.set(remoteId, item);
    }
    const unrelated = identityItems.filter((item) => !referenceOf(item, account.id));
    const items = [...unrelated];
    for (const remote of session.entries.items) {
      const remoteId = remoteIdOf(remote, account.id);
      const local = localByUuid.get(remoteId);
      if (!remote.deletedAt) items.push(finalize(remote, local, account.id));
    }
    const warnings = [...session.summary.warnings];
    if (session.entries.skipped.length) warnings.push(`有 ${session.entries.skipped.length} 个条目本版本无法解析，已原样保留、不会被改写。`);
    return {
      items,
      accountPatch: { lastSyncAt: now, lastError: undefined },
      conflicts: [],
      warnings,
      sourceRecords: await skippedSourceRecords(session, account.id)
    };
  }

  async create(account: ProviderAccount, item: VaultItem): Promise<VaultItem> {
    const session = this.requireSession(account.id);
    assertPasskeyCredentialAvailable(session, item);
    const { entry } = createKeePassEntry(session.database, item, item.keepassGroupPath);
    return this.afterWrite(session, account.id, entry.uuid.toString(), item);
  }

  async update(account: ProviderAccount, item: VaultItem): Promise<VaultItem> {
    const session = this.requireSession(account.id);
    const entryUuid = referenceOf(item, account.id)?.remoteId;
    const entry = entryUuid ? session.entries.entriesByUuid.get(entryUuid) : undefined;
    if (!entry || !entryUuid) return this.create(account, item);
    assertPasskeyCredentialAvailable(session, item, entryUuid);
    writeKeePassEntry(session.database, entry, item);
    return this.afterWrite(session, account.id, entryUuid, item);
  }

  async remove(account: ProviderAccount, item: VaultItem): Promise<void> {
    const session = this.requireSession(account.id);
    const entryUuid = referenceOf(item, account.id)?.remoteId;
    const entry = entryUuid ? session.entries.entriesByUuid.get(entryUuid) : undefined;
    if (!entry) return;
    removeKeePassEntry(session.database, entry);
    session.dirty = true;
    this.reread(session, account.id);
  }

  private afterWrite(session: KeePassSession, providerId: string, entryUuid: string, item: VaultItem): VaultItem {
    session.dirty = true;
    this.reread(session, providerId);
    const stored = session.entries.items.find((candidate) => remoteIdOf(candidate, providerId) === entryUuid);
    if (item.kind === "passkey" && stored?.kind !== "passkey") {
      const projected = {
        ...item,
        keepassEntryUuid: entryUuid,
        providerRefs: [...item.providerRefs.filter((reference) => reference.providerId !== providerId), { providerId, remoteId: entryUuid }]
      } as PasskeyItem;
      return finalize(projected, item, providerId);
    }
    return finalize(stored || item, item, providerId);
  }

  private reread(session: KeePassSession, providerId: string): void {
    session.entries = readKeePassEntries(session.database, session.databaseId, providerId);
    session.groupRevision += 1;
    session.historyRevision += 1;
    this.historyStore.invalidateProviderViews(providerId);
  }

  private requireKeePassAccountSession(account: ProviderAccount): KeePassSession {
    if (account.kind !== "keepass") throw new KeePassGroupError("keepass-group-provider-invalid", "所选密码源不是 KeePass 数据库。");
    return this.requireSession(account.id);
  }

  private runGroupMutation(
    providerId: string,
    session: KeePassSession,
    operationId: string,
    intent: string,
    mutate: () => { group: kdbxweb.KdbxGroup; changed: boolean }
  ): KeePassGroupMutationResult {
    assertGroupOperationId(operationId);
    const existing = this.groupOperationReceipts.get(operationId);
    if (existing) {
      if (existing.providerId !== providerId || existing.intent !== intent) {
        throw new KeePassGroupError("keepass-group-operation-reused", "KeePass 分组操作标识已经用于其他操作。");
      }
      return existing.result;
    }

    const mutation = mutate();
    if (mutation.changed) {
      session.dirty = true;
      this.reread(session, providerId);
    }
    const record = listKeePassGroupRecords(session.database, true).find((candidate) => candidate.uuid === mutation.group.uuid.toString());
    if (!record) throw new KeePassGroupError("keepass-group-result-missing", "KeePass 分组操作完成后无法读取目标分组。");
    const result = { changed: mutation.changed, group: this.groupSummary(providerId, session, record) };
    if (this.groupOperationReceipts.size >= 256) this.groupOperationReceipts.delete(this.groupOperationReceipts.keys().next().value!);
    this.groupOperationReceipts.set(operationId, { providerId, intent, result });
    return result;
  }

  private groupSummary(providerId: string, session: KeePassSession, record: KeePassGroupRecord): KeePassGroupSummary {
    requireKeePassGroup(session.database, record.uuid);
    const name = truncateKeePassGroupText(record.name, 256);
    const displayPath = truncateKeePassGroupText(record.displayPath, 1024);
    return {
      groupId: this.ensureGroupHandle(providerId, record.uuid),
      parentGroupId: record.parentUuid === session.database.getDefaultGroup().uuid.toString()
        ? undefined
        : record.parentUuid ? this.ensureGroupHandle(providerId, record.parentUuid) : undefined,
      name: name.value,
      displayPath: displayPath.value,
      depth: record.depth,
      entryCount: record.entryCount,
      childGroupCount: record.childGroupCount,
      nameTruncated: name.truncated,
      displayPathTruncated: displayPath.truncated,
      isRecycleBin: record.isRecycleBin,
      inRecycleBin: record.inRecycleBin,
      canRename: !record.inRecycleBin,
      canMove: !record.inRecycleBin,
      canDelete: !record.inRecycleBin,
      canRestore: record.canRestore
    };
  }

  private ensureGroupHandle(providerId: string, groupUuid: string): string {
    const key = `${providerId}\u0000${groupUuid}`;
    const existing = this.groupHandleByKey.get(key);
    if (existing) return existing;
    const groupId = crypto.randomUUID();
    this.groupHandles.set(groupId, { providerId, groupUuid });
    this.groupHandleByKey.set(key, groupId);
    return groupId;
  }

  private requireGroupHandle(providerId: string, groupId: string): KeePassGroupHandle {
    const handle = typeof groupId === "string" ? this.groupHandles.get(groupId) : undefined;
    if (!handle || handle.providerId !== providerId) {
      throw new KeePassGroupError("keepass-group-handle-invalid", "KeePass 分组标识已失效，请刷新分组列表。");
    }
    return handle;
  }

  private createGroupCursor(cursor: KeePassGroupCursor): string {
    if (this.groupCursors.size >= 256) this.groupCursors.delete(this.groupCursors.keys().next().value!);
    const cursorId = crypto.randomUUID();
    this.groupCursors.set(cursorId, cursor);
    return cursorId;
  }

  private removeProviderGroupCursors(providerId: string): void {
    for (const [cursorId, cursor] of this.groupCursors) if (cursor.providerId === providerId) this.groupCursors.delete(cursorId);
  }

  private removeProviderGroupState(providerId: string): void {
    this.removeProviderGroupCursors(providerId);
    for (const [groupId, handle] of this.groupHandles) {
      if (handle.providerId !== providerId) continue;
      this.groupHandles.delete(groupId);
      this.groupHandleByKey.delete(`${providerId}\u0000${handle.groupUuid}`);
    }
    for (const [operationId, receipt] of this.groupOperationReceipts) {
      if (receipt.providerId === providerId) this.groupOperationReceipts.delete(operationId);
    }
  }

  private requireAttachmentEntry(account: ProviderAccount, item: VaultItem): { session: KeePassSession; entryUuid: string; entry: kdbxweb.KdbxEntry } {
    if (account.kind !== "keepass") throw new ProviderAttachmentError("attachment-provider-invalid", "所选密码源不是 KeePass 数据库。");
    const session = this.requireSession(account.id);
    const reference = referenceOf(item, account.id);
    const entryUuid = reference?.remoteId || item.keepassEntryUuid;
    if (!entryUuid) throw new ProviderAttachmentError("attachment-target-unsynced", "此项目尚未写入 KeePass，保存并同步后才能管理附件。");
    const entry = session.entries.entriesByUuid.get(entryUuid);
    if (!entry) throw new ProviderAttachmentError("attachment-target-not-found", "KeePass 条目已不存在，请重新同步数据库。");
    return { session, entryUuid, entry };
  }

  private requireHistoryEntry(account: ProviderAccount, item: VaultItem): { session: KeePassSession; entryUuid: string; entry: kdbxweb.KdbxEntry } {
    if (account.kind !== "keepass") throw new KeePassHistoryError("keepass-history-provider-invalid", "所选密码源不是 KeePass 数据库。");
    const session = this.requireSession(account.id);
    const reference = referenceOf(item, account.id);
    const entryUuid = reference?.remoteId || item.keepassEntryUuid;
    if (!entryUuid) throw new KeePassHistoryError("keepass-history-target-unsynced", "此项目尚未写入 KeePass，保存并同步后才能查看历史。");
    const entry = session.entries.entriesByUuid.get(entryUuid);
    if (!entry) throw new KeePassHistoryError("keepass-history-target-not-found", "KeePass 条目已不存在，请重新同步数据库。");
    return { session, entryUuid, entry };
  }

  private attachmentSummary(
    providerId: string,
    entryUuid: string,
    fileName: string,
    binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash
  ): ProviderAttachmentSummary {
    return {
      attachmentId: this.ensureAttachmentHandle(providerId, entryUuid, fileName),
      providerKind: "keepass",
      fileName,
      sizeBytes: binarySize(binary),
      protected: binaryProtected(binary)
    };
  }

  private ensureAttachmentHandle(providerId: string, entryUuid: string, fileName: string): string {
    const key = attachmentHandleKey(providerId, entryUuid, fileName);
    const existing = this.attachmentHandleByKey.get(key);
    if (existing) return existing;
    const attachmentId = crypto.randomUUID();
    this.attachmentHandles.set(attachmentId, { providerId, entryUuid, fileName });
    this.attachmentHandleByKey.set(key, attachmentId);
    return attachmentId;
  }

  private requireAttachmentHandle(providerId: string, entryUuid: string, attachmentId: string): KeePassAttachmentHandle {
    const handle = this.attachmentHandles.get(attachmentId);
    if (!handle || handle.providerId !== providerId || handle.entryUuid !== entryUuid) {
      throw new ProviderAttachmentError("attachment-handle-invalid", "附件标识已失效，请刷新附件列表。");
    }
    return handle;
  }

  private removeAttachmentHandle(attachmentId: string): void {
    const handle = this.attachmentHandles.get(attachmentId);
    if (!handle) return;
    this.attachmentHandles.delete(attachmentId);
    this.attachmentHandleByKey.delete(attachmentHandleKey(handle.providerId, handle.entryUuid, handle.fileName));
  }

  private removeProviderAttachmentHandles(providerId: string): void {
    for (const [attachmentId, handle] of this.attachmentHandles) {
      if (handle.providerId === providerId) this.removeAttachmentHandle(attachmentId);
    }
  }

  private requireSession(providerId: string): KeePassSession {
    const session = this.sessions.get(providerId);
    if (!session) throw new Error("此 KeePass 数据库尚未解锁，请在 Monica 设置页中选择 .kdbx 文件并输入密码或密钥文件。");
    return session;
  }
}

function passkeyCredentialId(item: VaultItem): string | undefined {
  if (item.kind !== "passkey") return undefined;
  return normalizeCredentialId(item.credentialId) || undefined;
}

function rawPasskeyCredentialOwners(session: KeePassSession): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const [entryUuid, entry] of session.entries.entriesByUuid) {
    const credentialId = normalizeCredentialId(readKeePassPasskeyFields(entry.fields)?.credentialId || "");
    if (!credentialId) continue;
    const entryUuids = owners.get(credentialId) || new Set<string>();
    entryUuids.add(entryUuid);
    owners.set(credentialId, entryUuids);
  }
  return owners;
}

function assertPasskeyCredentialAvailable(session: KeePassSession, item: VaultItem, exceptEntryUuid?: string): void {
  const credentialId = passkeyCredentialId(item);
  if (!credentialId) return;
  const owners = rawPasskeyCredentialOwners(session).get(credentialId);
  if (owners && [...owners].some((entryUuid) => entryUuid !== exceptEntryUuid)) {
    throw new KeePassPasskeyCredentialConflictError();
  }
}

function conflictingPasskeyMutations(
  session: KeePassSession,
  updates: Array<{ entryUuid: string; item: VaultItem }>,
  creations: VaultItem[]
): Set<string> {
  const existingOwners = rawPasskeyCredentialOwners(session);
  const desiredOwners = new Map<string, Array<{ itemId: string; entryUuid?: string }>>();
  for (const mutation of [
    ...updates.map((update) => ({ item: update.item, entryUuid: update.entryUuid })),
    ...creations.map((item) => ({ item, entryUuid: undefined }))
  ]) {
    const credentialId = passkeyCredentialId(mutation.item);
    if (!credentialId) continue;
    const owners = desiredOwners.get(credentialId) || [];
    owners.push({ itemId: mutation.item.id, entryUuid: mutation.entryUuid });
    desiredOwners.set(credentialId, owners);
  }

  const conflicts = new Set<string>();
  for (const [credentialId, desired] of desiredOwners) {
    if (desired.length > 1) for (const owner of desired) conflicts.add(owner.itemId);
    const existing = existingOwners.get(credentialId);
    if (!existing) continue;
    for (const owner of desired) {
      if ([...existing].some((entryUuid) => entryUuid !== owner.entryUuid)) conflicts.add(owner.itemId);
    }
  }
  return conflicts;
}

/**
 * Only entries no codec claimed are kept as source envelopes. Every other entry is reproducible from
 * the item plus the file itself, and mirroring the whole database here would push a large vault past
 * the 32 MiB envelope budget in `source-records.ts`.
 */
async function skippedSourceRecords(session: KeePassSession, providerId: string): Promise<ProviderSourceRecord[]> {
  const records: ProviderSourceRecord[] = [];
  for (const skipped of session.entries.skipped) {
    const entry = session.entries.entriesByUuid.get(skipped.entryUuid);
    if (!entry) continue;
    records.push(await createSourceRecord(keePassSourceRecordFor(entry, providerId)));
  }
  return records;
}

function databaseIdOf(account: ProviderAccount): number {
  const value = Number(account.config.databaseId);
  return Number.isFinite(value) ? value : 0;
}

function boundedPendingMutations(input: PendingMutation[], providerId: string): Map<string, PendingMutation> {
  if (!Array.isArray(input) || input.length > KEEPASS_PENDING_SYNC_LIMIT) throw new Error("KeePass 单批项目同步超过 100 条上限。");
  const result = new Map<string, PendingMutation>();
  for (const mutation of input) {
    if (!mutation || mutation.providerId !== providerId || !mutation.id || !mutation.itemId || result.has(mutation.itemId)) {
      throw new Error("KeePass 项目同步批次包含无效或重复操作。");
    }
    result.set(mutation.itemId, mutation);
  }
  return result;
}

function boundedAcknowledgedMutations(input: ProviderAcknowledgedMutation[]): Map<string, ProviderAcknowledgedMutation> {
  if (!Array.isArray(input) || input.length > KEEPASS_PENDING_SYNC_LIMIT) throw new Error("KeePass 持久同步回执超过 100 条上限。");
  const result = new Map<string, ProviderAcknowledgedMutation>();
  const mutationIds = new Set<string>();
  for (const mutation of input) {
    if (!mutation || !mutation.mutationId || !mutation.itemId || !mutation.remoteId || result.has(mutation.itemId) || mutationIds.has(mutation.mutationId)) {
      throw new Error("KeePass 持久同步回执包含无效或重复操作。");
    }
    mutationIds.add(mutation.mutationId);
    result.set(mutation.itemId, mutation);
  }
  return result;
}

function referenceOf(item: VaultItem, providerId: string): ProviderReference | undefined {
  return item.providerRefs.find((reference) => reference.providerId === providerId);
}

function remoteIdOf(item: VaultItem, providerId: string): string {
  return referenceOf(item, providerId)?.remoteId || item.keepassEntryUuid || item.id;
}

/**
 * Keeps the browser-side identity of an item that already existed locally. `favorite` is carried over
 * because a KeePass login entry has no field for it, so taking the decoded entry verbatim would reset
 * the user's local flag on every sync.
 */
function finalize(remote: VaultItem, local: VaultItem | undefined, providerId: string): VaultItem {
  const merged = (local ? { ...remote, id: local.id, favorite: local.favorite } : remote) as VaultItem;
  const reference: ProviderReference = {
    providerId,
    remoteId: remoteIdOf(remote, providerId),
    revision: referenceOf(remote, providerId)?.revision,
    etag: fingerprint(merged)
  };
  return { ...merged, providerRefs: [...merged.providerRefs.filter((candidate) => candidate.providerId !== providerId), reference] } as VaultItem;
}

/**
 * Local-change detection. A KDBX entry carries no revision the browser can compare against, so the
 * fingerprint of the last synced content is stored in the provider reference's `etag`. Keys are sorted
 * so a differently ordered but equal item does not register as an edit.
 */
function fingerprint(item: VaultItem): string {
  const { id: _id, providerRefs: _refs, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, ...content } = item;
  return JSON.stringify(content, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
      : value);
}

function attachmentHandleKey(providerId: string, entryUuid: string, fileName: string): string {
  return `${providerId}\u0000${entryUuid}\u0000${fileName}`;
}

function groupIntent(operation: string, ...parts: unknown[]): string {
  return JSON.stringify([operation, ...parts]);
}

function assertGroupOperationId(operationId: string): void {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) {
    throw new KeePassGroupError("keepass-group-operation-id-invalid", "KeePass 分组操作标识无效。");
  }
}

function binaryValue(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): kdbxweb.KdbxBinary {
  return kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
}

function binarySize(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): number {
  const value = binaryValue(binary);
  return value instanceof kdbxweb.ProtectedValue ? value.byteLength : value.byteLength;
}

function binaryProtected(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): boolean {
  return binaryValue(binary) instanceof kdbxweb.ProtectedValue;
}

function copyBinaryRange(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash, start: number, end: number): Uint8Array {
  const value = binaryValue(binary);
  if (value instanceof kdbxweb.ProtectedValue) {
    const plaintext = value.getBinary();
    try {
      return plaintext.slice(start, end);
    } finally {
      plaintext.fill(0);
    }
  }
  return new Uint8Array(value, start, end - start).slice();
}
