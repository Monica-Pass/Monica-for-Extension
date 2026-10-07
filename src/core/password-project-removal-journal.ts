import type { LoginItem, PendingMutation, ProviderAccount } from './model';
import { readProjectCredential } from './project-credentials';
import type { Mdbx2RestoreRecord } from './mdbx2-restore-journal';

export interface PasswordProjectRemovalProof {
  providerId: string;
  sourceItemId: string;
  targetItemId: string;
  /** Empty means the source was actually listed and found empty, never “not checked”. */
  attachments: Array<{ sourceAttachmentId: string; targetAttachmentId: string; fileName: string; mediaType?: string; sizeBytes: number; sha256: string }>;
}

export interface PasswordProjectRemovalRecord {
  version: 1;
  id: string;
  requestHash: string;
  createdAt: string;
  updatedAt: string;
  status: 'preparing' | 'deleting' | 'completed' | 'cancelled';
  /** Snapshots stay in the encrypted local vault and are never provider metadata. */
  retained: LoginItem[];
  removed: LoginItem[];
  /** Full draft before removal-only promotion/renumbering; encrypted, never provider metadata. */
  cancellationItems?: LoginItem[];
  providerBindings: ProviderAccount[];
  ownerTransfer?: { sourceItemId: string; targetItemId: string };
  proofs?: PasswordProjectRemovalProof[];
  nativeDeletion?: {
    intent: PasswordProjectNativeDeletionIntent;
    deletedAt: string;
    pendingMutations: PendingMutation[];
    receipt?: { operationId: string; commitId: string };
  };
}

/** Exact request persisted before Native Messaging can delete any row. */
export interface PasswordProjectNativeDeletionIntent {
  version: 1;
  providerId: string;
  vaultHandle: string;
  writeRevision: { vaultId: string; revisionSha256: string };
  operationScope: string;
  mutations: Array<{ kind: 'delete'; logicalObjectId: string; expectedHeadCommitId: string }>;
}

const invalid = () => new Error('密码项目移除恢复记录无效，原始数据已保留。');
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Reject damaged/future recovery state; never silently drop a pending removal. */
export function readPasswordProjectRemovalJournal(value: unknown): PasswordProjectRemovalRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const operations = new Set<string>();
  for (const record of value as PasswordProjectRemovalRecord[]) {
    if (!record || record.version !== 1 || !id(record.id) || operations.has(record.id) || !hash(record.requestHash)
      || !['preparing', 'deleting', 'completed', 'cancelled'].includes(record.status)
      || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))
      || !Array.isArray(record.retained) || !record.retained.length || !Array.isArray(record.removed) || !record.removed.length
      || record.retained.length + record.removed.length > 100 || !Array.isArray(record.providerBindings)) throw invalid();
    operations.add(record.id);
    const rowIds = new Set<string>(), passwordIds = new Set<string>();
    for (const row of [...record.retained, ...record.removed]) {
      if (!row || row.kind !== 'login' || !id(row.id) || rowIds.has(row.id) || row.deletedAt || !id(row.passwordGroupId)
        || !Array.isArray(row.providerRefs) || !Array.isArray(row.customFields)
        || row.providerRefs.some(ref => !ref || !id(ref.providerId) || ref.remoteId !== undefined && !id(ref.remoteId))
        || typeof row.password !== 'string' || typeof row.username !== 'string' || typeof row.notes !== 'string'
        || !Array.isArray(row.uris) || row.uris.some(uri => typeof uri !== 'string')
        || row.customFields.some(field => !field || typeof field.name !== 'string' || typeof field.value !== 'string')
        || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.updatedAt))) throw invalid();
      const metadata = readProjectCredential(row.customFields);
      if (!metadata || passwordIds.has(metadata.passwordId) || row.passwordGroupId !== record.retained[0].passwordGroupId
        || metadata.projectId !== undefined && metadata.projectId !== row.passwordGroupId) throw invalid();
      passwordIds.add(metadata.passwordId);
      rowIds.add(row.id);
    }
    const providerIds = new Set<string>();
    for (const provider of record.providerBindings) {
      if (!provider || !id(provider.id) || providerIds.has(provider.id) || !['local', 'mdbx2', 'monica-webdav', 'bitwarden'].includes(provider.kind)
        || !provider.config || typeof provider.config !== 'object' || Array.isArray(provider.config)) throw invalid();
      providerIds.add(provider.id);
    }
    const rowProviders = new Set(record.retained[0].providerRefs.map(ref => ref.providerId));
    if (rowProviders.size !== providerIds.size || [...rowProviders].some(id => !providerIds.has(id))
      || [...record.retained, ...record.removed].some(row => row.providerRefs.length !== rowProviders.size
        || row.providerRefs.some(ref => !ref || !rowProviders.has(ref.providerId))
        || new Set(row.providerRefs.map(ref => ref.providerId)).size !== rowProviders.size)) throw invalid();
    const externalProviderIds = new Set(record.providerBindings.filter(provider => provider.kind !== 'local').map(provider => provider.id));
    if (record.ownerTransfer && (!record.removed.some(row => row.id === record.ownerTransfer!.sourceItemId)
      || !record.retained.some(row => row.id === record.ownerTransfer!.targetItemId))) throw invalid();
    if (!['preparing', 'cancelled'].includes(record.status) && !Array.isArray(record.proofs)) throw invalid();
    if (record.proofs !== undefined) {
      if (!Array.isArray(record.proofs) || record.proofs.length > providerIds.size) throw invalid();
      const verified = new Set<string>();
      for (const proof of record.proofs) {
        if (!proof || !record.ownerTransfer || !externalProviderIds.has(proof.providerId) || verified.has(proof.providerId)
          || proof.sourceItemId !== record.ownerTransfer.sourceItemId || proof.targetItemId !== record.ownerTransfer.targetItemId
          || !Array.isArray(proof.attachments) || proof.attachments.length > 512) throw invalid();
        verified.add(proof.providerId);
        const sources = new Set<string>(), targets = new Set<string>();
        for (const attachment of proof.attachments) {
          if (!attachment || !id(attachment.sourceAttachmentId) || !id(attachment.targetAttachmentId)
            || sources.has(attachment.sourceAttachmentId) || targets.has(attachment.targetAttachmentId)
            || typeof attachment.fileName !== 'string' || !attachment.fileName || attachment.fileName.length > 1024
            || attachment.mediaType !== undefined && typeof attachment.mediaType !== 'string'
            || !Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0 || attachment.sizeBytes > 64 * 1024 * 1024
            || !hash(attachment.sha256)) throw invalid();
          sources.add(attachment.sourceAttachmentId); targets.add(attachment.targetAttachmentId);
        }
      }
      if (!['preparing', 'cancelled'].includes(record.status) && record.ownerTransfer && verified.size !== externalProviderIds.size) throw invalid();
    }
    if (record.nativeDeletion !== undefined) {
      if (!record.nativeDeletion || typeof record.nativeDeletion !== 'object') throw invalid();
      const { intent, deletedAt, pendingMutations, receipt } = record.nativeDeletion;
      const external = record.providerBindings.filter(provider => provider.kind !== 'local');
      if (['preparing', 'cancelled'].includes(record.status) || !intent || intent.version !== 1 || external.length !== 1 || external[0].kind !== 'mdbx2'
        || intent.providerId !== external[0].id || !id(intent.vaultHandle) || intent.vaultHandle !== external[0].config.vaultHandle
        || !intent.writeRevision || !id(intent.writeRevision.vaultId) || !hash(intent.writeRevision.revisionSha256)
        || external[0].config.nativeVaultId !== undefined && external[0].config.nativeVaultId !== intent.writeRevision.vaultId
        || !hash(intent.operationScope) || !Array.isArray(intent.mutations) || intent.mutations.length !== record.removed.length
        || intent.mutations.length > 50 || !Number.isFinite(Date.parse(deletedAt))
        || !Array.isArray(pendingMutations) || pendingMutations.length !== record.removed.length) throw invalid();
      const nativeIds = new Set<string>();
      for (const row of [...record.retained, ...record.removed]) {
        const ref = row.providerRefs.find(ref => ref.providerId === intent.providerId)!;
        if (!id(ref.remoteId) || !id(ref.revision) || !id(ref.remoteFolderId) || nativeIds.has(ref.remoteId)) throw invalid();
        nativeIds.add(ref.remoteId);
      }
      const sorted = record.removed.map(row => {
        const ref = row.providerRefs.find(ref => ref.providerId === intent.providerId)!;
        return { kind: 'delete', logicalObjectId: `native:${ref.remoteId}`, expectedHeadCommitId: ref.revision };
      }).sort((a, b) => a.logicalObjectId.localeCompare(b.logicalObjectId));
      if (intent.mutations.some((mutation, index) => !mutation || mutation.kind !== 'delete'
        || mutation.logicalObjectId !== sorted[index].logicalObjectId || mutation.expectedHeadCommitId !== sorted[index].expectedHeadCommitId)) throw invalid();
      const queueIds = new Set<string>(), queuedRows = new Set<string>();
      for (const mutation of pendingMutations) {
        if (!mutation || !id(mutation.id) || queueIds.has(mutation.id) || queuedRows.has(mutation.itemId)
          || mutation.providerId !== intent.providerId || mutation.operation !== 'delete'
          || !record.removed.some(row => row.id === mutation.itemId) || mutation.createdAt !== deletedAt
          || !Number.isSafeInteger(mutation.attempts) || mutation.attempts < 0) throw invalid();
        queueIds.add(mutation.id); queuedRows.add(mutation.itemId);
      }
      if (receipt && (!id(receipt.operationId) || !id(receipt.commitId)) || (record.status === 'completed') !== Boolean(receipt)) throw invalid();
    }
    if (record.cancellationItems !== undefined) {
      if (!Array.isArray(record.cancellationItems) || record.cancellationItems.length !== rowIds.size
        || new Set(record.cancellationItems.map(row => row?.id)).size !== rowIds.size) throw invalid();
      // Reuse the full snapshot validator without recursively carrying cancellation data.
      const { cancellationItems, nativeDeletion: _native, proofs: _proofs, ...base } = record;
      const cancellation = readPasswordProjectRemovalJournal([{ ...base, status: 'preparing', ownerTransfer: undefined,
        retained: cancellationItems.filter(row => record.retained.some(item => item.id === row?.id)),
        removed: cancellationItems.filter(row => record.removed.some(item => item.id === row?.id)) }])[0];
      if ([...cancellation.retained, ...cancellation.removed].length !== rowIds.size
        || cancellationItems.some(row => {
          const expected = [...record.retained, ...record.removed].find(item => item.id === row.id);
          const metadata = readProjectCredential(row.customFields), original = expected && readProjectCredential(expected.customFields);
          return !expected || row.passwordGroupId !== expected.passwordGroupId || metadata?.passwordId !== original?.passwordId
            || metadata?.groupId !== original?.groupId;
        })) throw invalid();
    }
    if (record.status === 'cancelled' && !record.cancellationItems) throw invalid();
  }
  return structuredClone(value);
}

export function isPasswordProjectRemovalPending(record: PasswordProjectRemovalRecord): boolean {
  return record.status === 'preparing' || record.status === 'deleting';
}

/** Required recovery receipts outlive the ordinary recent-history window. */
export function retainPasswordProjectRemovalHistory(records: PasswordProjectRemovalRecord[], restores: Mdbx2RestoreRecord[]): PasswordProjectRemovalRecord[] {
  const required = new Set(restores.flatMap(row => row.status === 'prepared' && row.reapply ? [row.reapply.deletionOperationId] : []));
  if ([...required].some(id => !records.some(row => row.id === id && row.status === 'completed' && row.nativeDeletion?.receipt)))
    throw new Error('待恢复项目缺少原始删除回执，不能清理恢复历史。');
  const keep = records.filter(row => isPasswordProjectRemovalPending(row) || required.has(row.id));
  // Leave one slot for the new operation, without ever discarding a dependency.
  if (keep.length >= 100) throw new Error('恢复记录已满，请先完成待恢复操作。');
  const historySlots = Math.min(19, 99 - keep.length);
  const recent = records.filter(row => !isPasswordProjectRemovalPending(row) && !required.has(row.id));
  return [...keep, ...(historySlots ? recent.slice(-historySlots) : [])];
}

/** Compare content conservatively after provider-only acknowledgement changes. */
export function passwordProjectRemovalContent(item: LoginItem): string {
  const { updatedAt: _updatedAt, providerRefs: _refs, bitwardenCustomFieldsVersion: _version, bitwardenCipherId: _cipher, ...content } = item;
  const normalized = { ...content, loginType: item.loginType || 'PASSWORD',
    uriRules: item.uriRules ?? item.uris.map(uri => ({ uri, matchType: 'base-domain' })) };
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)])) : value;
  return JSON.stringify(stable(normalized));
}
