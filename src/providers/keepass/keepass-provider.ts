import * as kdbxweb from "kdbxweb";
import { applyKeePassSourceRemoval, readKeePassSourceRemoval, type KeePassSourceRemovalRequest, type KeePassSourceRemovalFileResult } from './keepass-source-removal';
import { applyKeePassTransferFile, keePassTransferContentHash, type KeePassTransferDraft, type KeePassTransferFileResult, type KeePassTransferNativeSource } from './keepass-transfer-file';
import { preserveLocalPasswordHistory } from '../../core/password-history';
import { preserveLocalWalletContentOrder } from '../../core/wallet-content-order';
import { passwordGroupKey } from '../../core/password-groups';
import { planKeePassProjectRemoval, type KeePassProjectRemovalDraft } from '../../core/keepass-project-removal';
import { prepareKeePassProjectAttachmentHandoff } from './keepass-project-attachments';
import { isRemoteKeePassSource, type KeePassSourceMode } from "./keepass-source";
import type { PasskeyItem, PendingMutation, ProviderAccount, ProviderReference, ProviderSourceRecord, VaultItem } from "../../core/model";
import type { ProviderAcknowledgedMutation, ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { createSourceRecord } from "../../core/source-records";
import { normalizeCredentialId } from "../../passkey/source-policy";
import { passkeyContentFingerprint, preserveLocalPasskeyUsage } from "../../passkey/ownership-policy";
import {
  KEEPASS_ATTACHMENT_MAX_BYTES,
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  ProviderAttachmentError,
  type ProviderAttachmentSummary
} from "../attachments/attachment-contract";
import { keePassSourceRecordFor, openKeePassVault, readKeePassEntries, type KeePassSkippedEntry, type KeePassVaultEntries } from "./keepass-vault";
import { assertKnownKeePassType, createKeePassEntry, removeKeePassEntry, restoreKeePassEntry, writeKeePassEntry,
  prepareKeePassEntryWrite, validateKeePassEntryRemoval, validateKeePassEntryRestore, type PreparedKeePassEntryWrite } from "./keepass-writer";
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
  sourceMode: KeePassSourceMode;
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
  sourceMode?: KeePassSourceMode;
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
  private readonly transferHashes = new WeakMap<KeePassSession, { revision: number; value: Promise<string> }>();
  private readonly pendingUnlocks = new Map<string, object>();
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
    credential: KeePassUnlockCredential,
    preserveUnchangedAttachmentHandles = false
  ): Promise<KeePassSessionSummary> {
    const attempt = {};
    this.pendingUnlocks.set(account.id, attempt);
    try {
      const snapshot = await openKeePassVault(bytes, {
        password: credential.password,
        keyFile: credential.keyFile,
        sourceName: credential.sourceName,
        databaseId: databaseIdOf(account),
        providerId: account.id
      });
      if (this.pendingUnlocks.get(account.id) !== attempt)
        throw new Error('KeePass 文件已锁定或替换，请重新解锁。');

      // Remote publication reloads the same working copy. Keep a displayed handle
      // only while its entry, name and exact bytes still match in that live session.
      const retained = [...this.attachmentHandles].filter(([, handle]) => {
        if (!preserveUnchangedAttachmentHandles || handle.providerId !== account.id) return false;
        const before = this.sessions.get(account.id)?.entries.entriesByUuid.get(handle.entryUuid)?.binaries.get(handle.fileName);
        const after = snapshot.entriesByUuid.get(handle.entryUuid)?.binaries.get(handle.fileName);
        if (!before || !after || binarySize(before) !== binarySize(after)) return false;
        // KdbxBinaryWithHash carries the content hash kdbxweb computes at load time, so matching
        // hashes settle equality without walking up to 256 MiB of attachment bytes. A bare
        // KdbxBinary on either side still falls back to the chunked byte comparison below.
        const beforeHash = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(before) ? before.hash : undefined;
        const afterHash = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(after) ? after.hash : undefined;
        if (beforeHash !== undefined && afterHash !== undefined) return beforeHash === afterHash;
        const size = binarySize(before);
        for (let offset = 0; offset < size; offset += PROVIDER_ATTACHMENT_CHUNK_BYTES) {
          const end = Math.min(size, offset + PROVIDER_ATTACHMENT_CHUNK_BYTES);
          const left = copyBinaryRange(before, offset, end);
          const right = copyBinaryRange(after, offset, end);
          const equal = left.every((value, index) => value === right[index]);
          left.fill(0); right.fill(0);
          if (!equal) return false;
        }
        return true;
      });
      this.lockAccount(account.id);
      for (const [id, handle] of retained) {
        this.attachmentHandles.set(id, handle);
        this.attachmentHandleByKey.set(attachmentHandleKey(handle.providerId, handle.entryUuid, handle.fileName), id);
      }
      this.sessions.set(account.id, {
        database: snapshot.database,
        databaseId: databaseIdOf(account),
        entries: { items: snapshot.items, skipped: snapshot.skipped, entriesByUuid: snapshot.entriesByUuid },
        summary: {
          providerId: account.id,
          sourceMode: isRemoteKeePassSource(credential.sourceMode) ? credential.sourceMode : "local-file",
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
    } finally {
      if (this.pendingUnlocks.get(account.id) === attempt) this.pendingUnlocks.delete(account.id);
    }
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

  /** Prepare one complete file replacement in an isolated session. The caller
   * must persist these exact output bytes before conditional publication; no live
   * session, source file or local item is changed by this method, even on failure.
   */
  async prepareProjectRemovalFile(account: ProviderAccount, draft: KeePassProjectRemovalDraft, input: {
    bytes: Uint8Array; expectedSha256: string; credential: KeePassUnlockCredential;
  }) {
    const credential = structuredClone(input.credential);
    try {
      return await this.prepareProjectRemoval(account, draft, input,
        (isolated, source, bytes) => isolated.unlock(source, bytes, credential), () => undefined);
    } finally { credential.keyFile?.fill(0); }
  }

  /** Local files keep password/key-file credentials inside the live Kdbx session.
   * Clone with its existing protected credentials rather than exposing or saving
   * them in provider config. A lock or replacement cancels the preparation.
   */
  async prepareLocalProjectRemovalFile(account: ProviderAccount, draft: KeePassProjectRemovalDraft,
    input: { bytes: Uint8Array; expectedSha256: string }) {
    const live = this.requireKeePassAccountSession(account);
    const assertCurrent = this.localSessionGuard(account);
    return this.prepareProjectRemoval(account, draft, input, async (isolated, source, bytes) => {
      const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, live.database.credentials);
      assertCurrent();
      isolated.sessions.set(source.id, { database, databaseId: live.databaseId,
        entries: readKeePassEntries(database, live.databaseId, source.id), summary: structuredClone(live.summary),
        dirty: false, groupRevision: 0, historyRevision: 0 });
    }, assertCurrent);
  }

  /** Prepare a complete copy/move in a disposable session; caller commits exact bytes. */
  async prepareTransferFile(account: ProviderAccount, draft: KeePassTransferDraft, input: {
    bytes: Uint8Array; expectedSha256: string; credential?: KeePassUnlockCredential;
  }): Promise<KeePassTransferFileResult> {
    const source = structuredClone(account), request = structuredClone(draft), bytes = input.bytes.slice();
    const credential = input.credential && structuredClone(input.credential);
    const local = source.config.sourceMode === 'local-file';
    let assertCurrent = () => undefined as void;
    const digest = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const isolated = new KeePassProvider();
    try {
      const targetSession = this.sessions.get(source.id), targetRevision = targetSession?.groupRevision;
      const localGuard = local ? this.localSessionGuard(source) : () => undefined;
      assertCurrent = () => {
        localGuard();
        if (targetSession && (this.sessions.get(source.id) !== targetSession || targetSession.groupRevision !== targetRevision))
          throw new Error('准备期间目标 KeePass 已锁定或变化。');
      };
      if (!/^[a-f0-9]{64}$/.test(input.expectedSha256) || await digest(bytes) !== input.expectedSha256)
        throw new Error('目标 KeePass 文件版本已变化，请重新预览。');
      if (local || targetSession && !credential) {
        const live = this.requireKeePassAccountSession(source);
        const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, live.database.credentials);
        assertCurrent();
        isolated.sessions.set(source.id, { ...live, database, entries: readKeePassEntries(database, live.databaseId, source.id) });
      } else {
        if (!credential) throw new Error('目标 KeePass 凭据不可用。');
        await isolated.unlock(source, bytes, credential);
      }
      if (targetSession && await keePassTransferContentHash(targetSession.database)
        !== await keePassTransferContentHash(isolated.requireSession(source.id).database))
        throw new Error('目标 KeePass 仍有未持久保存的修改，请先同步后重试。');
      assertCurrent();
      const native = new Map<string, KeePassTransferNativeSource>();
      const nativeIdentities = new Set<string>();
      const nativeHashes = new Map<string, string>();
      for (const row of request.rows) {
        const item = row.source;
        if (!item.keepassEntryUuid) continue;
        const providerId = item.providerRefs.length === 1 && item.providerRefs[0].providerId;
        if (!providerId || item.providerRefs[0].remoteId !== item.keepassEntryUuid) throw new Error('KeePass 来源身份不唯一。');
        const identity = `${providerId}\u0000${item.keepassEntryUuid}`;
        if (nativeIdentities.has(identity)) throw new Error('所选项目重复引用同一原生 KeePass 条目。');
        nativeIdentities.add(identity);
        const live = this.requireSession(providerId), entry = live.entries.entriesByUuid.get(item.keepassEntryUuid);
        if (row.nativeContentSha256) {
          if (!nativeHashes.has(providerId)) nativeHashes.set(providerId, await keePassTransferContentHash(live.database));
          if (nativeHashes.get(providerId) !== row.nativeContentSha256) throw new Error('KeePass 原生字段或附件在预览后已变化。');
        }
        const original = live.entries.items.find(row => row.keepassEntryUuid === item.keepassEntryUuid);
        const baseline = restoreContentFingerprint(item.providerRefs[0].etag || '');
        if (!entry || !original || original.deletedAt || !baseline || baseline !== restoreContentFingerprint(fingerprint(original))
          || baseline !== restoreContentFingerprint(fingerprint(item))) throw new Error('KeePass 来源内容已变化或有未保存修改，请重新预览。');
        if (providerId === source.id) {
          const targetOriginal = isolated.requireSession(source.id).entries.items.find(row => row.keepassEntryUuid === item.keepassEntryUuid);
          if (!targetOriginal || baseline !== restoreContentFingerprint(fingerprint(targetOriginal))) throw new Error('来源修改尚未写入目标工作副本，请先同步。');
        }
        if (item.kind === 'login' && item.passwordGroupId) {
          const selected = new Set(request.rows.filter(row => row.source.providerRefs.length === 1 && row.source.providerRefs[0].providerId === providerId)
            .map(row => row.source.keepassEntryUuid));
          if (live.entries.items.some(row => row.kind === 'login' && !row.deletedAt && row.passwordGroupId === item.passwordGroupId
            && !selected.has(row.keepassEntryUuid))) throw new Error('KeePass 密码项目成员不完整。');
        }
        const groupRevision = live.groupRevision, historyRevision = live.historyRevision;
        native.set(item.id, { database: live.database, entry, assertCurrent: () => {
          if (this.sessions.get(providerId) !== live || live.groupRevision !== groupRevision || live.historyRevision !== historyRevision)
            throw new Error('准备期间来源 KeePass 已锁定或变化。');
        } });
      }
      const result = await applyKeePassTransferFile(isolated.requireSession(source.id).database, source, request, native);
      const output = await isolated.snapshotFile(source.id);
      try {
        const outputSha256 = await digest(output);
        assertCurrent(); for (const row of native.values()) row.assertCurrent();
        return { ...result, inputSha256: input.expectedSha256, outputSha256, bytes: output,
          assertCurrent: () => { assertCurrent(); for (const row of native.values()) row.assertCurrent(); } };
      } catch (cause) { output.fill(0); throw cause; }
    } finally { isolated.lock(); credential?.keyFile?.fill(0); bytes.fill(0); }
  }

  /** Prepare and round-trip a whole source deletion in a disposable KDBX. */
  async prepareSourceRemovalFile(account: ProviderAccount, input: KeePassSourceRemovalRequest, originalBytes: Uint8Array): Promise<KeePassSourceRemovalFileResult> {
    const source = structuredClone(account), request = readKeePassSourceRemoval(source, input), bytes = originalBytes.slice();
    let output: Uint8Array | undefined;
    const digest = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value.slice().buffer))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    try {
      const live = this.requireKeePassAccountSession(source), revision = live.groupRevision, history = live.historyRevision;
      if (live.databaseId !== databaseIdOf(source) || live.summary.sourceMode !== source.config.sourceMode)
        throw new Error('KeePass 来源会话与数据库绑定不一致，原文件已保留。');
      const assertCurrent = () => {
        if (this.sessions.get(source.id) !== live || live.groupRevision !== revision || live.historyRevision !== history)
          throw new Error('准备移除期间 KeePass 来源已锁定或变化，原文件已保留。');
      };
      if (await digest(bytes) !== request.expectedWorkingSha256) throw new Error('KeePass 来源文件版本已变化，原文件已保留。');
      if (await keePassTransferContentHash(live.database) !== request.expectedContentSha256)
        throw new Error('KeePass 来源还有未保存修改或已变化，原文件已保留。');
      assertCurrent();
      const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, live.database.credentials);
      const native = readKeePassEntries(database, Number(source.config.databaseId), source.id);
      for (const item of request.sources) {
        const original = native.items.find(row => row.keepassEntryUuid === item.keepassEntryUuid);
        if (!original || original.deletedAt) throw new Error('KeePass 来源内容已变化，原文件已保留。');
        // Reuse the native reader's field equivalence checks for older items
        // lacking redundant scope/derived labels. Whole-file hashes still pin
        // every original field, history record and attachment byte.
        this.readTransferSource(source, item, request.sources).assertCurrent();
      }
      assertCurrent();
      const result = await applyKeePassSourceRemoval(database, source, request);
      const expected = await keePassTransferContentHash(database);
      output = new Uint8Array(await database.save());
      const serialized = await kdbxweb.Kdbx.load(output.slice().buffer, live.database.credentials);
      if (await keePassTransferContentHash(serialized) !== expected) throw new Error('KeePass 来源移除后的文件内容无法完整保存，原文件已保留。');
      const deleted = readKeePassEntries(serialized, Number(source.config.databaseId), source.id).items;
      if (result.entries.some(entry => !deleted.some(item => item.keepassEntryUuid === entry.entryUuid && item.deletedAt)))
        throw new Error('KeePass 来源移除后的原生回收站校验失败，原文件已保留。');
      const outputSha256 = await digest(output); assertCurrent();
      return { ...result, inputSha256: request.expectedWorkingSha256, outputSha256, bytes: output, assertCurrent };
    } catch (cause) { output?.fill(0); throw cause; }
    finally { bytes.fill(0); }
  }

  /** Internal persistence guard; contains no credential or serializable session state. */
  async transferNativeContentHash(account: ProviderAccount): Promise<string> {
    const session = this.requireKeePassAccountSession(account), cached = this.transferHashes.get(session);
    if (cached?.revision === session.groupRevision) return cached.value;
    const value = keePassTransferContentHash(session.database);
    this.transferHashes.set(session, { revision: session.groupRevision, value });
    return value;
  }

  /** Internal native export evidence; never returned by a runtime command. */
  readTransferSource(account: ProviderAccount, item: VaultItem, indexedItems: VaultItem[]): KeePassTransferNativeSource {
    const live = this.requireKeePassAccountSession(account), ref = item.providerRefs[0];
    if (!account.enabled || live.databaseId !== databaseIdOf(account) || item.providerRefs.length !== 1
      || ref.providerId !== account.id || !item.keepassEntryUuid || ref.remoteId !== item.keepassEntryUuid)
      throw new Error('KeePass 来源身份不唯一或数据库已变化。');
    const entry = live.entries.entriesByUuid.get(item.keepassEntryUuid), original = live.entries.items.find(row => row.keepassEntryUuid === item.keepassEntryUuid);
    const baseline = restoreContentFingerprint(ref.etag || '');
    if (!entry || !original || original.deletedAt || item.deletedAt || !baseline)
      throw new Error('KeePass 来源内容已变化或有未保存修改，请先同步。');
    for (const [label, row] of [['native', original], ['index', item]] as const) {
      // Older locally-created rows may have only the authenticated provider/entry
      // binding, without the redundant numeric database scope. Never accept a
      // different explicit scope. Derived labels and empty AAGUIDs are not edits.
      const actual = restoreContentFingerprint(fingerprint({ ...row, keepassDatabaseId: row.keepassDatabaseId ?? live.databaseId }));
      if (baseline !== actual) {
        const expectedFields = JSON.parse(baseline) as Record<string, unknown>, actualFields = actual ? JSON.parse(actual) as Record<string, unknown> : {};
        if (row.kind === 'passkey') for (const fields of [expectedFields, actualFields]) {
          if (fields.aaguid === '') delete fields.aaguid;
          const derived = row.algorithm === -7 ? 'ECDSA' : row.algorithm === -257 ? 'RSA' : row.algorithm === -8 ? 'EdDSA' : undefined;
          if (derived && fields.keyAlgorithm === derived) delete fields.keyAlgorithm;
        }
        for (const fields of [expectedFields, actualFields]) if (Array.isArray(fields.customFields)) {
          fields.customFields = fields.customFields.map(({ id: _id, fieldType, ...field }) => ({ ...field,
            protected: field.protected === true || fieldType === 'HIDDEN',
            ...(fieldType !== undefined && fieldType !== 'TEXT' && fieldType !== 'HIDDEN' ? { fieldType } : {}) }));
        }
        const names = [...new Set([...Object.keys(expectedFields), ...Object.keys(actualFields)])]
          .filter(key => JSON.stringify(expectedFields[key]) !== JSON.stringify(actualFields[key]));
        if (names.length) throw new Error(`KeePass 来源 ${label} 字段已变化（${names.join(', ')}），请先同步。`);
      }
    }
    if (original.kind === 'login' && item.kind === 'login' && original.passwordGroupId !== item.passwordGroupId)
      throw new Error('KeePass 密码项目成员不完整，请先同步。');
    if (item.kind === 'login' && item.passwordGroupId) {
      const native = live.entries.items.filter(row => row.kind === 'login' && !row.deletedAt && row.passwordGroupId === item.passwordGroupId);
      const expected = indexedItems.filter(row => row.kind === 'login' && !row.deletedAt && passwordGroupKey(row) === passwordGroupKey(item));
      if (native.length !== expected.length || new Set(expected.map(row => row.keepassEntryUuid)).size !== expected.length
        || native.some(row => !expected.some(other => other.keepassEntryUuid === row.keepassEntryUuid)))
        throw new Error('KeePass 密码项目成员不完整，请先同步。');
    }
    const groupRevision = live.groupRevision, historyRevision = live.historyRevision;
    return { database: live.database, entry, assertCurrent: () => {
      if (this.sessions.get(account.id) !== live || live.groupRevision !== groupRevision || live.historyRevision !== historyRevision)
        throw new Error('读取期间 KeePass 来源已锁定或变化。');
    } };
  }

  transferSourceFolder(account: ProviderAccount, item: VaultItem) {
    const session = this.requireKeePassAccountSession(account);
    const entry = session.entries.entriesByUuid.get(item.keepassEntryUuid || '');
    if (!entry?.parentGroup) throw new Error('KeePass 来源条目不存在。');
    const identities: string[] = [], segments: string[] = [];
    let group: kdbxweb.KdbxGroup | undefined = entry.parentGroup;
    const root = session.database.getDefaultGroup(), seen = new Set<string>();
    while (group && group !== root) {
      const id = group.uuid.toString();
      if (seen.has(id) || seen.size >= 128) throw new Error('KeePass 来源分组层级无效。');
      seen.add(id); identities.unshift(id); segments.unshift(group.name || '(未命名)'); group = group.parentGroup;
    }
    if (!group) throw new Error('KeePass 来源分组缺少父目录。');
    return segments.length ? { identities, segments } : undefined;
  }

  async assertTransferReload(account: ProviderAccount, bytes: Uint8Array, originalContentSha256: string) {
    const live = this.requireKeePassAccountSession(account), revision = live.groupRevision;
    const current = await keePassTransferContentHash(live.database);
    if (current !== originalContentSha256) {
      const persisted = await kdbxweb.Kdbx.load(bytes.slice().buffer, live.database.credentials);
      if (current !== await keePassTransferContentHash(persisted)) throw new Error('KeePass 会话还有未持久保存的后续修改，请先保存后恢复传输。');
    }
    if (this.sessions.get(account.id) !== live || live.groupRevision !== revision) throw new Error('KeePass 会话在恢复前已变化。');
  }

  /** Internal persistence guard; contains no credential or serializable session state. */
  localSessionGuard(account: ProviderAccount): () => void {
    const live = this.requireKeePassAccountSession(account);
    if (account.config.sourceMode !== 'local-file' || live.summary.sourceMode !== 'local-file' || live.databaseId !== databaseIdOf(account))
      throw new Error('此操作需要已解锁的本地 KeePass 文件。');
    return () => {
      if (this.sessions.get(account.id) !== live) throw new Error('KeePass 文件已锁定或替换，原密码尚未移除。');
    };
  }

  async reloadLocalFile(account: ProviderAccount, bytes: Uint8Array, dirty: boolean): Promise<KeePassSessionSummary> {
    const assertCurrent = this.localSessionGuard(account), live = this.requireSession(account.id);
    const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, live.database.credentials);
    assertCurrent();
    const entries = readKeePassEntries(database, live.databaseId, account.id);
    this.lockAccount(account.id);
    this.sessions.set(account.id, { ...live, database, entries, dirty, groupRevision: 0, historyRevision: 0 });
    return this.summarize(account.id);
  }

  markLocalFileExported(account: ProviderAccount): void {
    this.localSessionGuard(account)();
    this.requireSession(account.id).dirty = false;
  }

  private async prepareProjectRemoval(account: ProviderAccount, draft: KeePassProjectRemovalDraft,
    input: { bytes: Uint8Array; expectedSha256: string },
    open: (isolated: KeePassProvider, source: ProviderAccount, bytes: Uint8Array) => Promise<unknown>,
    assertCurrent: () => void) {
    const source = structuredClone(account), request = structuredClone(draft);
    const bytes = input.bytes.slice(), expected = input.expectedSha256;
    const digest = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value.slice().buffer))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (!/^[a-f0-9]{64}$/.test(expected) || await digest(bytes) !== expected) throw new Error('KeePass 文件版本已变化，原密码尚未移除。');
    const plan = planKeePassProjectRemoval(request, request.originals, source);
    const isolated = new KeePassProvider();
    let handoff: ReturnType<typeof prepareKeePassProjectAttachmentHandoff> | undefined;
    try {
      await open(isolated, source, bytes);
      assertCurrent();
      const session = isolated.requireSession(source.id);
      const native = session.entries.items.filter(item => item.kind === 'login' && !item.deletedAt && item.passwordGroupId === plan.projectId);
      const originalByUuid = new Map(request.originals.map(item => [referenceOf(item, source.id)!.remoteId!, item]));
      if (native.length !== originalByUuid.size || native.some(item => !originalByUuid.has(remoteIdOf(item, source.id))))
        throw new Error('KeePass 文件项目成员已变化，原密码尚未移除。');
      for (const item of native) {
        const original = originalByUuid.get(remoteIdOf(item, source.id))!;
        const baseline = restoreContentFingerprint(referenceOf(original, source.id)?.etag || '');
        if (!baseline || baseline !== restoreContentFingerprint(fingerprint(item)))
          throw new Error('KeePass 文件项目内容已变化，原密码尚未移除。');
      }
      const entries = new Map(request.originals.map(item => [item.id, session.entries.entriesByUuid.get(referenceOf(item, source.id)!.remoteId!)!]));
      const writes = plan.retained.map(item => ({ item, entry: entries.get(item.id),
        prepared: prepareKeePassEntryWrite(item, entries.get(item.id)?.fields) }));
      for (const item of plan.removed) validateKeePassEntryRemoval(session.database, entries.get(item.id)!);
      // New retained members are created only in the disposable session. A later
      // collision, serialization or attachment failure discards the whole copy.
      for (const row of writes) if (!row.entry) {
        row.entry = createKeePassEntry(session.database, row.item, row.item.keepassGroupPath, row.prepared).entry;
        entries.set(row.item.id, row.entry);
      }
      if (plan.ownerTransfer) handoff = prepareKeePassProjectAttachmentHandoff(session.database,
        entries.get(plan.ownerTransfer.sourceItemId)!, entries.get(plan.ownerTransfer.targetItemId)!);
      handoff?.apply();
      for (const row of writes) if (originalByUuid.has(row.entry!.uuid.toString()))
        writeKeePassEntry(session.database, row.entry!, row.item, row.prepared);
      for (const item of plan.removed) removeKeePassEntry(session.database, entries.get(item.id)!);
      isolated.reread(session, source.id);
      const identityByUuid = new Map([...plan.retained, ...plan.removed].map(item => [entries.get(item.id)!.uuid.toString(), item]));
      const items = session.entries.items.filter(item => identityByUuid.has(remoteIdOf(item, source.id)))
        .map(item => finalize(item, identityByUuid.get(remoteIdOf(item, source.id)), source.id));
      if (items.length !== identityByUuid.size) throw new Error('KeePass 项目文件写入不完整，原文件已保留。');
      const output = await isolated.snapshotFile(source.id);
      try {
        const outputSha256 = await digest(output);
        assertCurrent();
        return { inputSha256: expected, outputSha256, bytes: output, items };
      } catch (cause) { output.fill(0); throw cause; }
    } finally {
      handoff?.dispose();
      isolated.lock();
      bytes.fill(0);
    }
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
    assertKnownKeePassType(entry.fields);
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
    assertKnownKeePassType(entry.fields);
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
    assertKnownKeePassType(entry.fields);
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
    this.pendingUnlocks.delete(providerId);
    this.sessions.delete(providerId);
    this.removeProviderAttachmentHandles(providerId);
    this.removeProviderGroupState(providerId);
    this.historyStore.clearProvider(providerId);
  }

  lock(): void {
    this.pendingUnlocks.clear();
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
    const restorations: Array<{ entryUuid: string; item: VaultItem; edited: boolean }> = [];
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
      const localChanged = Boolean(reference.etag) && fingerprint(local) !== storedFingerprint(reference.etag!);

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

      // UsageCount is not an edit revision: Android/KeePass clients can change
      // fields without incrementing it. Compare the represented native content.
      const remoteBaseline = restoreContentFingerprint(reference.etag || '');
      const remoteChanged = (referenceOf(remote, account.id)?.revision || "") !== (reference.revision || "")
        || Boolean(remoteBaseline && restoreContentFingerprint(fingerprint(remote)) !== remoteBaseline);
      if (remote.deletedAt) {
        if (local.deletedAt) continue; // Already in the bin: never purge it on a repeated sync.
        if (pendingByItemId?.get(local.id)?.keepassRestore) {
          const baseline = restoreContentFingerprint(reference.etag || '');
          if (!baseline || restoreContentFingerprint(fingerprint(remote)) !== baseline) {
            conflicts.push({ itemId: local.id, reason: 'KeePass 回收站条目在删除后发生变化，请核对后再恢复。', local, remote });
            keepLocal.set(entryUuid, local);
          } else {
            restorations.push({ entryUuid, item: local, edited: restoreContentFingerprint(fingerprint(local)) !== baseline });
          }
        } else if (localChanged) {
          conflicts.push({ itemId: local.id, reason: '此条目已移入 KeePass 回收站，但浏览器中仍有未同步修改。', local, remote });
          keepLocal.set(entryUuid, local);
        }
        continue;
      }
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

    const passkeyConflicts = conflictingPasskeyMutations(session, [...updates, ...restorations], creations);
    for (const update of [...updates, ...restorations]) {
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
    const prepared = new Map<string, PreparedKeePassEntryWrite>();
    // Build all patches before touching the KDBX. A malformed final member must
    // not leave preceding writes in memory for a later export/publication.
    const validate = (item: VaultItem, check: () => void) => {
      if (passkeyConflicts.has(item.id)) return;
      try { check(); }
      catch {
        conflicts.push({ itemId: item.id, reason: '此 KeePass 项目的字段、图标或回收站状态无法安全写入，请检查原始数据。', local: item,
          remote: referenceOf(item, account.id)?.remoteId ? remoteByUuid.get(referenceOf(item, account.id)!.remoteId!) : undefined });
      }
    };
    for (const update of updates) validate(update.item, () => {
      const entry = session.entries.entriesByUuid.get(update.entryUuid)!;
      prepared.set(update.item.id, prepareKeePassEntryWrite(update.item, entry.fields));
    });
    for (const restore of restorations) validate(restore.item, () => {
      const entry = session.entries.entriesByUuid.get(restore.entryUuid)!;
      validateKeePassEntryRestore(session.database, entry);
      if (restore.edited) prepared.set(restore.item.id, prepareKeePassEntryWrite(restore.item, entry.fields));
    });
    for (const item of creations) validate(item, () => { prepared.set(item.id, prepareKeePassEntryWrite(item)); });
    for (const entryUuid of deletions) validate(localByUuid.get(entryUuid)!, () => {
      validateKeePassEntryRemoval(session.database, session.entries.entriesByUuid.get(entryUuid)!);
    });

    const blockedIds = new Set(conflicts.map(conflict => conflict.itemId));
    const blockedProjects = new Set(scoped.filter(item => blockedIds.has(item.id) && item.kind === 'login' && item.passwordGroupId)
      .map(item => passwordGroupKey(item as import('../../core/model').LoginItem)));
    for (const item of scoped) {
      if (item.kind !== 'login' || !item.passwordGroupId || !blockedProjects.has(passwordGroupKey(item))) continue;
      if (!blockedIds.has(item.id)) conflicts.push({ itemId: item.id, reason: '同一密码项目的成员存在同步冲突或无效数据，整组修改已保留，请一起核对。', local: item,
        remote: referenceOf(item, account.id)?.remoteId ? remoteByUuid.get(referenceOf(item, account.id)!.remoteId!) : undefined });
      blockedIds.add(item.id);
    }
    for (const [entryUuid, item] of localByUuid) if (blockedIds.has(item.id)) keepLocal.set(entryUuid, item);
    for (const item of creations) if (blockedIds.has(item.id) && !deferredCreations.some(row => row.id === item.id)) deferredCreations.push(item);
    const applicableUpdates = updates.filter(update => !blockedIds.has(update.item.id));
    const applicableRestorations = restorations.filter(update => !blockedIds.has(update.item.id));
    const applicableCreations = creations.filter(item => !blockedIds.has(item.id));
    const applicableDeletions = deletions.filter(uuid => !blockedIds.has(localByUuid.get(uuid)!.id));

    for (const update of applicableUpdates) {
      const entry = session.entries.entriesByUuid.get(update.entryUuid);
      if (entry) writeKeePassEntry(session.database, entry, update.item, prepared.get(update.item.id)!);
    }
    for (const restore of applicableRestorations) {
      const entry = session.entries.entriesByUuid.get(restore.entryUuid)!;
      restoreKeePassEntry(session.database, entry);
      if (restore.edited) writeKeePassEntry(session.database, entry, restore.item, prepared.get(restore.item.id)!);
    }
    for (const item of applicableCreations) {
      const { entry } = createKeePassEntry(session.database, item, item.keepassGroupPath, prepared.get(item.id)!);
      localByUuid.set(entry.uuid.toString(), item);
    }
    for (const entryUuid of applicableDeletions) {
      const entry = session.entries.entriesByUuid.get(entryUuid);
      if (entry) removeKeePassEntry(session.database, entry);
    }

    if (applicableUpdates.length + applicableCreations.length + applicableRestorations.length + applicableDeletions.length) session.dirty = true;
    this.reread(session, account.id);

    const warnings = [...session.summary.warnings];
    const items = [...unrelated, ...deferredCreations];
    const emitted = new Set<string>();
    for (const remote of session.entries.items) {
      const entryUuid = remoteIdOf(remote, account.id);
      emitted.add(entryUuid);
      const conflicted = keepLocal.get(entryUuid);
      if (conflicted) items.push(conflicted);
      else items.push(finalize(remote, localByUuid.get(entryUuid), account.id));
    }
    for (const [entryUuid, local] of keepLocal) if (!emitted.has(entryUuid)) items.push(local);

    if (session.entries.skipped.length) {
      warnings.push(`有 ${session.entries.skipped.length} 个条目本版本无法解析，已原样保留、不会被改写。`);
    }
    if (session.dirty) {
      warnings.push(isRemoteKeePassSource(account.config.sourceMode)
        ? "KeePass 数据库的改动已保存到本机工作副本，同步到远端后其他设备才能读取。"
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
      items.push(finalize(remote, local, account.id));
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
    if (mutation.keepassRestore !== undefined && (mutation.keepassRestore !== true || mutation.operation !== 'update')) throw new Error('KeePass 恢复操作格式无效。');
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
 * Keeps the browser-side identity of an item that already existed locally. `favorite` and
 * `archivedAt` are local overlays: the current Android KDBX field contract does not carry them.
 * A file refresh must not silently reactivate a password or Passkey the user archived here.
 */
function finalize(remote: VaultItem, local: VaultItem | undefined, providerId: string): VaultItem {
  const content = local?.kind === "passkey" && remote.kind === "passkey" ? preserveLocalPasskeyUsage(local, remote)
    : local?.kind === 'login' && remote.kind === 'login' ? preserveLocalPasswordHistory(local, remote) : remote;
  const ordered = preserveLocalWalletContentOrder(local, content);
  const merged = (local ? { ...ordered, id: local.id, favorite: local.favorite, archivedAt: local.archivedAt } : ordered) as VaultItem;
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
  // `favorite`/`archivedAt` are browser-side overlays the KDBX contract never carries; toggling
  // favorite or archive state must not register as a local content edit against the baseline.
  const { id: _id, providerRefs: _refs, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, favorite: _favorite, archivedAt: _archivedAt, ...content } = item;
  if (content.kind === "passkey") { delete content.useCount; delete content.lastUsedAt; delete content.signCountHighWaterMark; }
  // KDBX project identity is carried by the exact custom-field metadata. Projecting
  // it for display must not make pre-upgrade cached rows look locally edited.
  if (content.kind === 'card') delete content.editorSectionOrder;
  if (content.kind === 'login') {
    delete content.passwordGroupId;
    if (content.totpSecret === '') delete content.totpSecret;
  }
  return JSON.stringify(content, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
      : value);
}

function storedFingerprint(value: string): string {
  const normalized = passkeyContentFingerprint(value);
  try {
    const content = JSON.parse(normalized);
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      // Baselines recorded before the local overlays were excluded from the fingerprint still
      // carry `favorite`/`archivedAt`; drop them first so the kind-specific keys below still apply.
      const overlay = Object.prototype.hasOwnProperty.call(content, 'favorite')
        || Object.prototype.hasOwnProperty.call(content, 'archivedAt');
      if (overlay) { delete content.favorite; delete content.archivedAt; }
      if (content.kind === 'card' && Object.prototype.hasOwnProperty.call(content, 'editorSectionOrder')) {
        delete content.editorSectionOrder;
        return JSON.stringify(content);
      }
      if (content.kind === 'login' && (Object.prototype.hasOwnProperty.call(content, 'passwordGroupId') || content.totpSecret === '')) {
        delete content.passwordGroupId;
        if (content.totpSecret === '') delete content.totpSecret;
        return JSON.stringify(content);
      }
      if (overlay) return JSON.stringify(content);
    }
  } catch { /* Preserve invalid legacy fingerprints so normal conflict handling applies. */ }
  return normalized;
}

/** Compare represented entry contents, excluding routing and local-only overlays.
 * Moving an entry into the bin changes its parent, not its credential payload. */
function restoreContentFingerprint(value: string): string | undefined {
  try {
    const content = JSON.parse(storedFingerprint(value));
    if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined;
    for (const key of ['keepassGroupPath', 'keepassGroupUuid', 'favorite', 'archivedAt', 'passwordHistory', 'passwordHistoryIncomplete']) delete content[key];
    return JSON.stringify(content);
  } catch { return undefined; }
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
  return binaryValue(binary).byteLength;
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
