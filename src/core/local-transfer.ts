import type { ProviderAccount, ProviderSourceRecord, VaultItem, VaultState } from './model';
import { sameProviderBinding } from './provider';
import { passwordGroupKey } from './password-groups';
import { rebaseProjectCredentialFields } from './project-credentials';
import { boundNoteLogicalId, boundNoteScope, resolveBoundNote } from './bound-notes';
import { resolveSsoAccount, ssoAccountCandidates, ssoLogicalId } from './sso-links';
import { bitwardenProjectCipherId } from './bitwarden-project-removal-local';
import { mdbx2TransferDependencies } from '../providers/mdbx2/mdbx2-transfer-dependencies';
import { assertMdbx2TransferOperationId, mdbx2TransferOperationScope as hash, mdbx2TransferUuid as uuid } from '../providers/mdbx2/mdbx2-transfer-identity';
import { base64ToBytes } from '../security/encoding';
import { inspectPasskeyKey } from '../passkey/capability';
import { normalizeCredentialId, passkeyAvailability } from '../passkey/source-policy';
import { assertPasskeyCounterNotRegressed } from '../passkey/ownership-policy';
import { normalizeRpId } from '../passkey/webauthn-core';
import { pendingRemovalTouches, readPasswordProjectRemovalJournal } from './password-project-removal-journal';
import { readMdbx2MoveJournal } from './mdbx2-move-journal';

const MAX_ITEMS = 200;
const MAX_RECEIPTS = 10_000;
const MAX_ATTACHMENTS = 512;
export const LOCAL_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = LOCAL_ATTACHMENT_MAX_BYTES;

/** Stored only inside the encrypted local vault, with the owning item. */
export interface LocalItemAttachment {
  itemId: string;
  attachmentId: string;
  fileName: string;
  mediaType?: string;
  sizeBytes: number;
  sha256: string;
  dataBase64: string;
  protected?: boolean;
}

/** Original records are archival payloads, never live remote-provider bindings. */
export interface LocalItemOrigin {
  itemId: string;
  records: ProviderSourceRecord[];
}

export interface LocalTransferFolder {
  categoryId: number;
  categoryName: string;
  /** Database + original folder identity + selected destination; names never establish identity. */
  origin: string;
}

export interface LocalTransferRequest {
  operationId: string;
  createdAt: string;
  itemIds: string[];
  targetProviderId: string;
  action: 'copy' | 'move';
  preserveCategories: boolean;
  /** Existing local category identity, as used by home-catalog. Omitted means root. */
  targetFolder?: string;
  review?: LocalTransferReview;
  sourceSnapshotHash?: string;
}

export interface LocalTransferReview {
  requestHash: string;
  items: Array<{ sourceItemId: string; title: string; kind: VaultItem['kind']; blockedReason?: string }>;
  warnings: string[];
}

/** Internal readback from an authenticated backend; never accepted from a runtime message. */
export interface LocalTransferResource {
  expected: VaultItem;
  account: ProviderAccount;
  folder?: { identity: string; label: string };
  attachments: LocalItemAttachment[];
}

export interface LocalTransferReceipt {
  version: 1;
  operationId: string;
  requestHash: string;
  intentHash: string;
  createdAt: string;
  entries: Array<{ sourceItemId: string; targetItemId: string }>;
  review?: LocalTransferReview;
}

/** Contains secrets; keep in the background, clear on lock, never serialize to the manager. */
export interface LocalTransferBatch {
  request: LocalTransferRequest;
  snapshotHash: string;
  resources: LocalTransferResource[];
  items: VaultItem[];
  attachments: LocalItemAttachment[];
  origins: LocalItemOrigin[];
  folders: LocalTransferFolder[];
  receipt: LocalTransferReceipt;
}

export function isLocalTransferItem(item: VaultItem, providers: readonly ProviderAccount[]): boolean {
  const ids = new Set(['local', ...providers.filter(row => row.kind === 'local').map(row => row.id)]);
  return item.providerRefs.every(ref => ids.has(ref.providerId));
}

function categoryKey(item: Pick<VaultItem, 'categoryId' | 'categoryName'>): string | undefined {
  return item.categoryId != null ? `id:${item.categoryId}` : item.categoryName ? `name:${item.categoryName}` : undefined;
}

export function localTransferFolders(state: VaultState): Array<{ key: string; categoryId?: number; categoryName: string }> {
  const rows = new Map<string, { key: string; categoryId?: number; categoryName: string }>();
  for (const row of [...(state.localTransferFolders || []), ...state.items.filter(item => isLocalTransferItem(item, state.providers))]) {
    const key = categoryKey(row);
    if (!key) continue;
    const next = { key, categoryId: row.categoryId, categoryName: row.categoryName || '' };
    const old = rows.get(key);
    if (old && old.categoryName && next.categoryName && old.categoryName !== next.categoryName) throw new Error('本地文件夹名称不一致，请先修复分类。');
    if (!old || next.categoryName) rows.set(key, next);
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function selectedItems(state: VaultState, request: LocalTransferRequest): VaultItem[] {
  assertMdbx2TransferOperationId(request.operationId);
  if (!Number.isFinite(Date.parse(request.createdAt)) || request.createdAt.length > 64
    || !['copy', 'move'].includes(request.action) || typeof request.preserveCategories !== 'boolean'
    || !request.itemIds.length || request.itemIds.length > MAX_ITEMS || new Set(request.itemIds).size !== request.itemIds.length)
    throw new Error('本地传输请求无效。');
  const ids = new Set(mdbx2TransferDependencies(request.itemIds, state.items, request.action).selectedIds);
  if (ids.size > MAX_ITEMS) throw new Error('包含关联项目后超过单次 200 项上限。');
  const items = state.items.filter(item => ids.has(item.id)).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(items.map(item => item.id)).size !== items.length || items.some(item => item.deletedAt)) throw new Error('所选项目已删除或身份重复，请重新预览。');
  if (state.mutationQueue.some(row => ids.has(row.itemId) && row.operation === 'delete')
    || request.action === 'move' && state.mutationQueue.some(row => ids.has(row.itemId))
    || state.providerConflicts.some(row => ids.has(row.itemId))
    || readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row => row.status !== 'completed' && row.entries.some(entry => ids.has(entry.expected.id)))
    || pendingRemovalTouches(readPasswordProjectRemovalJournal(state.passwordProjectRemovals), ids)) throw new Error('所选项目仍有冲突、移除或移动操作，请先完成恢复。');
  return items;
}

function sourceRecords(state: VaultState, item: VaultItem): ProviderSourceRecord[] {
  return state.sourceRecords.filter(record => item.providerRefs.some(ref => ref.providerId === record.providerId
    && (record.itemId === item.id || ref.remoteId === record.remoteId || (state.providers.find(p => p.id === ref.providerId)?.kind === 'bitwarden'
      && ref.remoteId && bitwardenProjectCipherId(ref.remoteId) === record.remoteId))));
}

/** Includes dependency expansion, source data and destination folder/credential identities. */
async function snapshotHash(state: VaultState, request: LocalTransferRequest): Promise<string> {
  const items = selectedItems(state, request), ids = new Set(items.map(item => item.id));
  const providerIds = new Set([request.targetProviderId, ...items.flatMap(item => item.providerRefs.map(ref => ref.providerId))]);
  return hash({ items, providers: state.providers.filter(p => providerIds.has(p.id)),
    records: items.map(item => sourceRecords(state, item)),
    attachments: (state.localItemAttachments || []).filter(row => ids.has(row.itemId)),
    origins: (state.localItemOrigins || []).filter(row => ids.has(row.itemId)),
    folders: localTransferFolders(state), folderOrigins: state.localTransferFolders || [],
    passkeys: state.items.filter(item => item.kind === 'passkey' && !item.deletedAt && isLocalTransferItem(item, state.providers))
      .map(item => ({ id: item.id, credentialId: item.kind === 'passkey' ? item.credentialId : '' })),
    queue: state.mutationQueue.filter(row => ids.has(row.itemId)) });
}

export async function validateLocalAttachments(rows: readonly LocalItemAttachment[], itemId: string): Promise<void> {
  if (rows.length > MAX_ATTACHMENTS || new Set(rows.map(row => row.attachmentId)).size !== rows.length) throw new Error('附件清单重复或超过上限。');
  let total = 0;
  for (const row of rows) {
    if (row.itemId !== itemId || !row.attachmentId || !row.fileName || row.fileName.length > 1024
      || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || row.sizeBytes > MAX_ATTACHMENT_BYTES
      || typeof row.dataBase64 !== 'string' || row.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
      || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('附件内容或归属无效。');
    total += row.sizeBytes;
    if (total > MAX_ATTACHMENT_BYTES) throw new Error('本地传输附件合计超过 16 MiB 上限。');
    const bytes = base64ToBytes(row.dataBase64);
    try {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
      if (bytes.length !== row.sizeBytes || [...digest].map(n => n.toString(16).padStart(2, '0')).join('') !== row.sha256)
        throw new Error('附件完整性校验失败，原始数据已保留。');
    } finally { bytes.fill(0); }
  }
}

function detach(item: VaultItem, id: string, now: string, copy: boolean): VaultItem {
  const next = structuredClone(item);
  next.id = id;
  next.updatedAt = now;
  if (copy) { next.createdAt = now; delete next.replicaGroupId; }
  next.providerRefs = [];
  delete next.mdbxDatabaseId; delete next.mdbxFolderId;
  delete next.keepassDatabaseId; delete next.keepassEntryUuid; delete next.keepassGroupPath; delete next.keepassGroupUuid;
  if (next.kind === 'login') {
    delete next.bitwardenCipherId; delete next.bitwardenCustomFieldsVersion; delete next.bitwardenSshKeyMode;
  }
  if (next.kind === 'passkey' && next.sourceMode !== 'android-metadata-only') next.sourceMode = 'browser-local';
  return next;
}

/** Builds one all-or-none local transaction. External deletion is deliberately not performed here. */
export async function prepareLocalTransferBatch(state: VaultState, input: LocalTransferRequest,
  readbacks: readonly LocalTransferResource[] = []): Promise<LocalTransferBatch> {
  const request = structuredClone(input), sources = selectedItems(state, request);
  if (request.sourceSnapshotHash && await hash(sources) !== request.sourceSnapshotHash) throw new Error('预览期间来源项目已变化，请重新选择。');
  const target = state.providers.find(p => p.id === request.targetProviderId);
  if (!target || target.kind !== 'local' || !target.enabled) throw new Error('本地目标密码库不可用。');
  const folders = localTransferFolders(state);
  const base = request.targetFolder ? folders.find(row => row.key === request.targetFolder) : undefined;
  if (request.targetFolder && !base) throw new Error('目标文件夹已变化，请重新预览。');
  const resources = structuredClone([...readbacks]);
  const sourceIds = new Set(sources.map(item => item.id));
  if (new Set(resources.map(row => row.expected.id)).size !== resources.length || resources.some(row => !sourceIds.has(row.expected.id)))
    throw new Error('来源读取结果包含重复或未选择的项目。');
  const newFolders: LocalTransferFolder[] = [], attachments: LocalItemAttachment[] = [], origins: LocalItemOrigin[] = [];
  const targetBySource = new Map<string, VaultItem>();
  const groupIds = new Map<string, string>();
  const knownCredentials = new Set(state.items.filter(item => item.kind === 'passkey' && !item.deletedAt && isLocalTransferItem(item, state.providers))
    .flatMap(item => item.kind === 'passkey' ? [normalizeCredentialId(item.credentialId)] : []));
  let maxCategory = folders.reduce((maximum, row) => Math.max(maximum, row.categoryId ?? 0), 0);
  for (const item of sources) {
    const local = isLocalTransferItem(item, state.providers);
    const resource = resources.find(row => row.expected.id === item.id);
    if (request.action === 'move' && !local) throw new Error('跨库移动必须先完成持久来源删除，本地事务不能代替远端删除。');
    if (local && resource) throw new Error('本地项目必须从当前加密密码库读取。');
    if (!local) {
      const account = resource && state.providers.find(row => row.id === resource.account.id);
      if (!resource || !account || !account.enabled || item.providerRefs.length !== 1 || item.providerRefs[0].providerId !== account.id
        || !sameProviderBinding(account, resource.account) || await hash(item) !== await hash(resource.expected))
        throw new Error('来源项目或连接已变化，请重新读取。');
    }
    if (item.kind === 'passkey' && !(local && request.action === 'move')) {
      const key = await inspectPasskeyKey(item.privateKeyPkcs8, item.algorithm);
      assertPasskeyCounterNotRegressed(item);
      if (key !== 'usable' || passkeyAvailability(item) !== 'ready' || !normalizeRpId(item.rpId) || !item.credentialId.trim())
        throw new Error('此 Passkey 私钥或属性不可用，原始记录已保留。');
      const credential = normalizeCredentialId(item.credentialId);
      if (knownCredentials.has(credential)) throw new Error('本地密码库已存在同一 Passkey 凭据，不能复制或覆盖。');
      knownCredentials.add(credential);
    }
    const next = detach(item, request.action === 'copy' ? await uuid(request.operationId, `local-item:${target.id}:${item.id}`) : item.id,
      request.createdAt, request.action === 'copy');
    if (request.action === 'copy' && state.items.some(row => row.id === next.id)) throw new Error('目标项目身份已存在，不能覆盖或重新创建。');
    if (next.kind === 'login' && item.kind === 'login' && item.passwordGroupId && request.action === 'copy') {
      const key = passwordGroupKey(item);
      const group = groupIds.get(key) || await uuid(request.operationId, `local-project:${key}`);
      groupIds.set(key, group); next.passwordGroupId = group;
      next.customFields = rebaseProjectCredentialFields(next.customFields, group);
    }
    delete next.categoryId; delete next.categoryName;
    const sourceFolder = local ? categoryKey(item) : resource?.folder?.identity;
    const sourceLabel = local ? item.categoryName || '' : resource?.folder?.label || '';
    if (request.preserveCategories && !local && (item.categoryId != null || item.categoryName || item.keepassGroupPath || item.mdbxFolderId
      || item.providerRefs.some(ref => ref.remoteFolderId)) && !resource?.folder) throw new Error('来源分类无法读取，不能静默丢弃。');
    if (request.preserveCategories && sourceFolder) {
      if (local && !base) { next.categoryId = item.categoryId; next.categoryName = item.categoryName; }
      else {
        if (!sourceLabel || base && !base.categoryName) throw new Error('来源或目标分类缺少名称，不能保留路径。');
        const origin = JSON.stringify([base?.key || '', local ? target.id : resource!.account.id, sourceFolder]);
        let folder = [...(state.localTransferFolders || []), ...newFolders].find(row => row.origin === origin);
        if (!folder) {
          maxCategory++;
          if (!Number.isSafeInteger(maxCategory)) throw new Error('本地文件夹身份超出范围。');
          folder = { categoryId: maxCategory, categoryName: [base?.categoryName, sourceLabel].filter(Boolean).join(' / '), origin };
          newFolders.push(folder);
        } else if (folder.categoryName !== [base?.categoryName, sourceLabel].filter(Boolean).join(' / ')) throw new Error('来源文件夹已改名，请重新选择目标文件夹。');
        next.categoryId = folder.categoryId; next.categoryName = folder.categoryName;
      }
    } else if (base) { next.categoryId = base.categoryId; next.categoryName = base.categoryName; }
    const files = local ? (state.localItemAttachments || []).filter(row => row.itemId === item.id) : resource!.attachments;
    await validateLocalAttachments(files, item.id);
    if (item.imagePaths?.length && !files.length) throw new Error('来源图片无法读取，不能生成丢失附件的副本。');
    for (const file of files) attachments.push({ ...file, itemId: next.id,
      attachmentId: request.action === 'move' ? file.attachmentId : await uuid(request.operationId, `local-attachment:${item.id}:${file.attachmentId}`) });
    const records = local ? (state.localItemOrigins || []).filter(row => row.itemId === item.id).flatMap(row => row.records) : sourceRecords(state, item);
    if (records.length) origins.push({ itemId: next.id, records: structuredClone(records) });
    targetBySource.set(item.id, next);
  }
  // Preserve links by logical identity; never transplant Android Room IDs.
  for (const source of sources) {
    const next = targetBySource.get(source.id)!;
    if (source.kind === 'login' && next.kind === 'login') {
      if (source.boundNoteEntryId || source.boundNoteId != null) {
        const note = resolveBoundNote(source, sources), targetNote = note && targetBySource.get(note.id);
        if (targetNote?.kind !== 'secure-note') throw new Error('关联笔记无法唯一识别，整组保留在来源库。');
        next.boundNoteEntryId = boundNoteLogicalId(targetNote); delete next.boundNoteId;
      }
      if (source.ssoRefLogicalId || source.ssoRefEntryId != null) {
        const account = resolveSsoAccount(source, sources), targetAccount = account && targetBySource.get(account.id);
        if (!account || targetAccount?.kind !== 'login' || !ssoAccountCandidates(source, sources).some(row => row.id === account.id))
          throw new Error('SSO 关联无法唯一识别或形成循环，整组保留在来源库。');
        next.ssoRefLogicalId = ssoLogicalId(targetAccount); delete next.ssoRefEntryId;
      }
      if (source.boundTotpItemId) {
        const otp = sources.find(row => row.id === source.boundTotpItemId);
        if (otp?.kind !== 'totp' || boundNoteScope(otp) !== boundNoteScope(source)
          || sources.filter(row => row.kind === 'login' && row.boundTotpItemId === otp.id).length !== 1) throw new Error('验证码关联无法唯一识别，整组保留在来源库。');
        next.boundTotpItemId = targetBySource.get(otp.id)!.id;
      }
    }
    if ((source.kind === 'totp' || source.kind === 'passkey') && source.boundPasswordId != null) {
      if (source.kind === 'passkey' || sources.filter(row => row.kind === 'login' && row.boundTotpItemId === source.id).length !== 1)
        throw new Error('数字绑定身份无法迁移，整组保留在来源库。');
      if (next.kind === 'totp') delete next.boundPasswordId;
    }
  }
  if (attachments.reduce((sum, row) => sum + row.sizeBytes, 0) > MAX_ATTACHMENT_BYTES) throw new Error('本地传输附件合计超过 16 MiB 上限。');
  const batch = { request, snapshotHash: await snapshotHash(state, request), resources, items: [...targetBySource.values()], attachments, origins, folders: newFolders };
  return { ...batch, receipt: { version: 1, operationId: request.operationId, createdAt: request.createdAt,
    ...(request.review ? { review: structuredClone(request.review) } : {}),
    requestHash: await hash(request), intentHash: await hash(batch),
    entries: sources.map(item => ({ sourceItemId: item.id, targetItemId: targetBySource.get(item.id)!.id })) } };
}

/** Mutates only the caller's private clone. Persist it once to commit both items and receipt. */
export async function applyLocalTransferBatch(state: VaultState, batch: LocalTransferBatch): Promise<{ receipt: LocalTransferReceipt; replayed: boolean }> {
  const { receipt, ...intent } = batch;
  if (receipt.version !== 1 || receipt.operationId !== batch.request.operationId || receipt.requestHash !== await hash(batch.request)
    || receipt.createdAt !== batch.request.createdAt || receipt.intentHash !== await hash(intent)) throw new Error('本地传输预览已变化，请重新预览。');
  const receipts = readLocalTransferReceipts(state.localTransferReceipts);
  const previous = receipts.find(row => row.operationId === receipt.operationId);
  if (previous) {
    if (await hash(previous) !== await hash(receipt)) throw new Error('传输操作 ID 已用于其他内容。');
    // The original commit remains successful even if either side was subsequently edited or deleted.
    return { receipt: structuredClone(previous), replayed: true };
  }
  if (receipts.length >= MAX_RECEIPTS) throw new Error('本地传输回执已达上限，未写入任何项目。');
  if (await snapshotHash(state, batch.request) !== batch.snapshotHash) throw new Error('项目、附件或文件夹已发生变化，请重新预览。');
  // Re-derive the intended result under the write lock; caller-provided targets cannot overwrite data.
  const verified = await prepareLocalTransferBatch(state, batch.request, batch.resources);
  if (await hash(verified.receipt) !== await hash(receipt)) throw new Error('本地传输结果不符合预览，未写入任何项目。');
  const ids = new Set(batch.items.map(row => row.id));
  state.items = [...state.items.filter(row => !ids.has(row.id)), ...structuredClone(batch.items)];
  state.localItemAttachments = [...(state.localItemAttachments || []).filter(row => !ids.has(row.itemId)), ...structuredClone(batch.attachments)];
  state.localItemOrigins = [...(state.localItemOrigins || []).filter(row => !ids.has(row.itemId)), ...structuredClone(batch.origins)];
  state.localTransferFolders = [...(state.localTransferFolders || []), ...structuredClone(batch.folders)];
  state.localTransferReceipts = [...receipts, structuredClone(receipt)];
  state.updatedAt = new Date().toISOString();
  return { receipt: structuredClone(receipt), replayed: false };
}

/** Corrupt receipts must fail closed; dropping one could recreate a deleted copy on retry. */
export function readLocalTransferReceipts(value: unknown): LocalTransferReceipt[] {
  if (value === undefined) return [];
  const digest = (input: unknown) => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input);
  if (!Array.isArray(value) || value.length > MAX_RECEIPTS) throw new Error('本地传输回执无效。');
  const ids = new Set<string>();
  for (const row of value as LocalTransferReceipt[]) {
    if (!row || row.version !== 1 || typeof row.operationId !== 'string' || ids.has(row.operationId)
      || !digest(row.requestHash) || !digest(row.intentHash) || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
      || !Array.isArray(row.entries) || !row.entries.length || row.entries.length > MAX_ITEMS
      || row.entries.some(entry => !entry || typeof entry.sourceItemId !== 'string' || !entry.sourceItemId || typeof entry.targetItemId !== 'string' || !entry.targetItemId)
      || new Set(row.entries.map(entry => entry.sourceItemId)).size !== row.entries.length
      || new Set(row.entries.map(entry => entry.targetItemId)).size !== row.entries.length) throw new Error('本地传输回执无效。');
    assertMdbx2TransferOperationId(row.operationId); ids.add(row.operationId);
    if (row.review !== undefined) {
      const review = row.review;
      const kinds = ['login', 'secure-note', 'api-token', 'totp', 'card', 'identity', 'billing-address', 'payment-account', 'passkey', 'opaque'];
      if (!review || !digest(review.requestHash) || !Array.isArray(review.items) || !review.items.length || review.items.length > MAX_ITEMS
        || !Array.isArray(review.warnings) || review.warnings.length > MAX_ITEMS || review.warnings.some(warning => typeof warning !== 'string')
        || review.items.some(item => !item || typeof item.sourceItemId !== 'string' || !item.sourceItemId || typeof item.title !== 'string'
          || !kinds.includes(item.kind) || (item.blockedReason !== undefined && (typeof item.blockedReason !== 'string' || !item.blockedReason)))
        || new Set(review.items.map(item => item.sourceItemId)).size !== review.items.length
        || review.items.filter(item => !item.blockedReason).length !== row.entries.length
        || row.entries.some(entry => !review.items.some(item => item.sourceItemId === entry.sourceItemId && !item.blockedReason)))
        throw new Error('本地传输回执预览无效。');
    }
  }
  return structuredClone(value);
}
