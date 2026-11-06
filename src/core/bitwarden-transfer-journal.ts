import type { ProviderAccount, VaultItem, VaultState } from './model';
import { validateLocalAttachments, type LocalItemAttachment } from './local-transfer';
import { readMdbx2MoveJournal } from './mdbx2-move-journal';
import { pendingRemovalTouches, readPasswordProjectRemovalJournal } from './password-project-removal-journal';
import { bitwardenProjectCipherId } from './bitwarden-project-removal-local';
import { assertWritableBitwardenPasskey } from '../providers/bitwarden/bitwarden-cipher-codec';
import { inspectPasskeyKey } from '../passkey/capability';
import { sameProviderBinding } from './provider';
import type { BitwardenTransferCipher } from '../providers/bitwarden/bitwarden-transfer-cipher';
import { mdbx2TransferOperationScope as hash, assertMdbx2TransferOperationId } from '../providers/mdbx2/mdbx2-transfer-identity';

/** Cipher and attachment preparations are local encrypted transaction data,
 * never a normal vault item or a plaintext remote-provider setting. */
export interface BitwardenCipherCopyRecord {
  version: 1;
  revision: number;
  target: ProviderAccount;
  sourceItemIds: string[];
  sourceSnapshotSha256: string;
  prepared: BitwardenTransferCipher;
  files: LocalItemAttachment[];
  stage: 'prepared' | 'attempted' | 'created' | 'verified';
  remoteId?: string;
  attachmentReceipts: Array<{ sourceAttachmentId: string; targetAttachmentId: string }>;
  verifiedItems?: VaultItem[];
  batchOperationId?: string;
}

const invalid = () => new Error('Bitwarden 迁移恢复记录无效，已保留原密码库。');
const id = (value: unknown, max = 512): value is string => typeof value === 'string' && !!value && value.length <= max && !/[\u0000-\u001f]/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function readBitwardenCipherCopies(value: unknown): BitwardenCipherCopyRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw invalid();
  const seen = new Set<string>();
  return value.map(raw => {
    const row = raw as BitwardenCipherCopyRecord, plan = row?.prepared;
    if (!row || row.version !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.target?.kind !== 'bitwarden'
      || row.target.enabled !== true || !id(row.target.id) || !row.target.config || typeof row.target.config !== 'object' || Array.isArray(row.target.config)
      || plan?.version !== 1 || row.target.id !== plan.targetProviderId || !id(plan.sourceCipherId)
      || !['prepared', 'attempted', 'created', 'verified'].includes(row.stage)
      || !Array.isArray(row.sourceItemIds) || !row.sourceItemIds.length || row.sourceItemIds.length > 200
      || row.sourceItemIds.some(value => !id(value, 4096)) || new Set(row.sourceItemIds).size !== row.sourceItemIds.length
      || !Array.isArray(row.files) || row.files.length > 512 || row.files.some(file => !file || !row.sourceItemIds.includes(file.itemId))
      || !digest(row.sourceSnapshotSha256) || !digest(plan.sourceSha256)
      || !digest(plan.contentSha256) || typeof plan.payloadJson !== 'string' || !plan.payloadJson || new TextEncoder().encode(plan.payloadJson).length > 8 * 1024 * 1024
      || !Array.isArray(plan.attachments) || plan.attachments.length !== row.files.length
      || plan.attachments.some(row => !row || !id(row.sourceAttachmentId) || !id(row.fileName, 1024))
      || new Set(plan.attachments.map(row => row.sourceAttachmentId)).size !== plan.attachments.length
      || !Array.isArray(plan.credentialIds) || plan.credentialIds.length > 200 || plan.credentialIds.some(value => !id(value))
      || new Set(plan.credentialIds).size !== plan.credentialIds.length
      || seen.has(plan.copyId) || (['created', 'verified'].includes(row.stage) !== Boolean(row.remoteId))
      || row.remoteId !== undefined && (!id(row.remoteId) || row.remoteId === plan.sourceCipherId)
      || !Array.isArray(row.attachmentReceipts) || row.attachmentReceipts.length > row.files.length
      || !['created', 'verified'].includes(row.stage) && row.attachmentReceipts.length !== 0
      || row.stage === 'verified' && (!Array.isArray(row.verifiedItems) || !row.verifiedItems.length || row.verifiedItems.length > 202)
      || row.stage !== 'verified' && row.verifiedItems !== undefined) throw invalid();
    assertMdbx2TransferOperationId(plan.copyId); assertMdbx2TransferOperationId(plan.operationId);
    if (row.batchOperationId !== undefined) {
      assertMdbx2TransferOperationId(row.batchOperationId);
      if (row.batchOperationId !== plan.operationId) throw invalid();
    }
    if (plan.pendingSso && (row.stage !== 'prepared' || !row.batchOperationId || plan.boundSso || !id(plan.pendingSso.sourceLogicalId))) throw invalid();
    if (plan.pendingFolderKey && (row.stage !== 'prepared' || !row.batchOperationId || !id(plan.pendingFolderKey))) throw invalid();
    if (plan.boundSso && (!row.batchOperationId || !id(plan.boundSso.sourceLogicalId) || !id(plan.boundSso.targetCipherId))) throw invalid();
    const files = new Set<string>();
    for (const file of row.files) {
      if (!id(file.attachmentId) || !id(file.fileName, 1024) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > 16 * 1024 * 1024
        || !digest(file.sha256) || typeof file.dataBase64 !== 'string' || file.dataBase64.length > Math.ceil(16 * 1024 * 1024 / 3) * 4
        || file.mediaType !== undefined && (typeof file.mediaType !== 'string' || file.mediaType.length > 256)
        || file.protected !== undefined && typeof file.protected !== 'boolean'
        || files.has(file.attachmentId) || !plan.attachments.some(expected => expected.sourceAttachmentId === file.attachmentId && expected.fileName === file.fileName)) throw invalid();
      files.add(file.attachmentId);
    }
    if (row.files.reduce((sum, file) => sum + file.sizeBytes, 0) > 16 * 1024 * 1024) throw invalid();
    if (row.attachmentReceipts.some((receipt, index) => !receipt || receipt.sourceAttachmentId !== row.files[index].attachmentId || !id(receipt.targetAttachmentId))
      || new Set(row.attachmentReceipts.map(receipt => receipt.targetAttachmentId)).size !== row.attachmentReceipts.length) throw invalid();
    if (row.stage === 'verified' && (row.attachmentReceipts.length !== row.files.length
      || new Set(row.verifiedItems!.map(item => item?.id)).size !== row.verifiedItems!.length
      || row.verifiedItems!.some(item => !item || !id(item.id, 4096) || item.deletedAt
        || !['login', 'totp', 'passkey', 'secure-note', 'card', 'identity', 'api-token', 'billing-address', 'payment-account'].includes(item.kind)
        || !Array.isArray(item.providerRefs) || item.providerRefs.length !== 1
        || item.providerRefs[0].providerId !== row.target.id || !id(item.providerRefs[0].remoteId, 4096)
        || bitwardenProjectCipherId(item.providerRefs[0].remoteId) !== row.remoteId))) throw invalid();
    seen.add(plan.copyId); return structuredClone(row);
  });
}

/** Validate decrypted bytes before creating anything remotely, including on recovery. */
export async function validateBitwardenCopyFiles(row: BitwardenCipherCopyRecord): Promise<void> {
  readBitwardenCipherCopies([row]);
  for (const itemId of row.sourceItemIds) await validateLocalAttachments(row.files.filter(file => file.itemId === itemId), itemId);
}

export type BitwardenCopyProgress = Pick<BitwardenCipherCopyRecord, 'stage' | 'remoteId' | 'verifiedItems' | 'attachmentReceipts'>;
export function advanceBitwardenCipherCopy(row: BitwardenCipherCopyRecord, expectedRevision: number, progress: BitwardenCopyProgress): BitwardenCipherCopyRecord {
  if (!progress || Object.keys(progress).some(key => !['stage', 'remoteId', 'verifiedItems', 'attachmentReceipts'].includes(key))
    || expectedRevision !== row.revision || row.stage === 'verified'
    || !({ prepared: ['attempted', 'created'], attempted: ['created'], created: ['created', 'verified'] }[row.stage]).includes(progress.stage)
    || row.remoteId !== undefined && progress.remoteId !== row.remoteId) throw invalid();
  const next = readBitwardenCipherCopies([{ ...row, ...progress, revision: row.revision + 1 }])[0];
  if (JSON.stringify(next.attachmentReceipts.slice(0, row.attachmentReceipts.length)) !== JSON.stringify(row.attachmentReceipts)
    || next.attachmentReceipts.length > row.attachmentReceipts.length + 1
    || row.stage === 'created' && next.stage === 'created' && next.attachmentReceipts.length !== row.attachmentReceipts.length + 1) throw invalid();
  return next;
}

export async function bitwardenCopySourceHash(state: VaultState, ids: string[], allowSsoGraph = false): Promise<string> {
  const items = state.items.filter(row => ids.includes(row.id));
  if (items.length !== ids.length || items.some(row => row.deletedAt)
    || new Set(items.map(row => row.id)).size !== ids.length
    || state.mutationQueue.some(row => ids.includes(row.itemId)) || state.providerConflicts.some(row => ids.includes(row.itemId))
    || readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row => row.status !== 'completed' && row.entries.some(entry => ids.includes(entry.expected.id)))
    || pendingRemovalTouches(readPasswordProjectRemovalJournal(state.passwordProjectRemovals), new Set(ids)))
    throw new Error('迁移来源已变化或仍有未完成修改，请重新预览。');
  for (const item of items) if (item.kind === 'passkey') {
    assertWritableBitwardenPasskey(item);
    if (await inspectPasskeyKey(item.privateKeyPkcs8, item.algorithm) !== 'usable') throw new Error('迁移来源 Passkey 私钥不可用，已保留原记录。');
  }
  if (items.some(item => item.kind === 'login' && (item.boundNoteEntryId || item.boundNoteId != null
    || (!allowSsoGraph || !item.ssoRefLogicalId) && (item.ssoRefLogicalId || item.ssoRefEntryId != null) || item.boundTotpItemId)))
    throw new Error('迁移来源包含尚未重建的关联，已保留原记录。');
  const providers = new Set(items.flatMap(row => row.providerRefs.map(ref => ref.providerId)));
  return hash({ items, providers: state.providers.filter(row => providers.has(row.id)),
    records: state.sourceRecords.filter(row => providers.has(row.providerId)),
    files: (state.localItemAttachments || []).filter(row => ids.includes(row.itemId)),
    origins: (state.localItemOrigins || []).filter(row => ids.includes(row.itemId)) });
}

export function assertBitwardenCopyTarget(state: VaultState, row: BitwardenCipherCopyRecord) {
  const account = state.providers.find(account => account.id === row.target.id);
  if (!account?.enabled || !sameProviderBinding(account, row.target)) throw new Error('Bitwarden 迁移目标已变化，已停止写入。');
  return account;
}

export function bitwardenCopyIntent(row: BitwardenCipherCopyRecord) {
  return { target: row.target, sourceItemIds: row.sourceItemIds, sourceSnapshotSha256: row.sourceSnapshotSha256, prepared: row.prepared, files: row.files,
    ...(row.batchOperationId ? { batchOperationId: row.batchOperationId } : {}) };
}
