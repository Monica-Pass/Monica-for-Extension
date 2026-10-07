import type { PendingMutation, ProviderAccount, VaultItem } from './model';
import type { Mdbx2ObjectRestoreInput, Mdbx2ObjectRestoreResult } from '../providers/mdbx2/native-contract';

export interface Mdbx2RestoreRecord {
  version: 1;
  id: string;
  status: 'prepared' | 'completed';
  source: VaultItem;
  provider: ProviderAccount;
  intent: Mdbx2ObjectRestoreInput & { operationScope: string };
  receipt?: Mdbx2ObjectRestoreResult;
  /** A later local restore/edit must survive restoring the original native payload. */
  reapply?: { deletionOperationId: string; item: VaultItem; pendingMutations: PendingMutation[] };
  /** Exact queued deletion replaced atomically by this durable restore request. */
  supersededDeletion?: PendingMutation;
}

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new Error('MDBX 恢复记录无效，原始记录已保留。');

export function readMdbx2RestoreJournal(value: unknown): Mdbx2RestoreRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const ids = new Set<string>(), pending = new Set<string>();
  for (const record of value as Mdbx2RestoreRecord[]) {
    if (!record || record.version !== 1 || !validId(record.id) || ids.has(record.id) || !['prepared', 'completed'].includes(record.status)
      || !record.source || !validId(record.source.id) || !Number.isFinite(Date.parse(record.source.deletedAt || ''))
      || !Number.isFinite(Date.parse(record.source.updatedAt)) || record.source.kind === 'opaque'
      || !record.provider || record.provider.kind !== 'mdbx2' || !validId(record.provider.id) || !record.provider.config
      || !validId(record.provider.config.vaultHandle) || !record.intent || !hash(record.intent.operationScope)
      || !validId(record.intent.objectId) || !validId(record.intent.collectionId) || !validId(record.intent.objectTypeId)
      || !validId(record.intent.expectedHeadCommitId) || !record.intent.writeRevision || !validId(record.intent.writeRevision.vaultId)
      || !hash(record.intent.writeRevision.revisionSha256) || !Array.isArray(record.source.providerRefs)) throw invalid();
    ids.add(record.id);
    const refs = record.source.providerRefs.filter(ref => ref.providerId === record.provider.id);
    if (refs.length !== 1 || refs[0].remoteId !== record.intent.objectId || refs[0].revision !== record.intent.expectedHeadCommitId
      || refs[0].remoteFolderId !== record.intent.collectionId
      || record.provider.config.nativeVaultId !== undefined && record.provider.config.nativeVaultId !== record.intent.writeRevision.vaultId
      || (record.status === 'completed') !== Boolean(record.receipt)) throw invalid();
    if (record.receipt && (!validId(record.receipt.operationId) || !validId(record.receipt.commitId)
      || record.receipt.objectId !== record.intent.objectId || record.receipt.collectionId !== record.intent.collectionId
      || record.receipt.objectTypeId !== record.intent.objectTypeId || record.receipt.logicalObjectId !== `native:${record.intent.objectId}`)) throw invalid();
    if (record.reapply !== undefined) {
      if (!record.reapply || !validId(record.reapply.deletionOperationId)) throw invalid();
      const { item, pendingMutations } = record.reapply;
      if (!item || item.id !== record.source.id || item.kind !== 'login' || record.source.kind !== 'login' || item.deletedAt
        || typeof item.password !== 'string' || typeof item.username !== 'string' || typeof item.notes !== 'string'
        || !Number.isFinite(Date.parse(item.updatedAt)) || !Array.isArray(item.providerRefs)
        || item.providerRefs.length !== record.source.providerRefs.length
        || record.source.providerRefs.some(ref => !item.providerRefs.some(current => current.providerId === ref.providerId
          && current.remoteId === ref.remoteId && current.remoteFolderId === ref.remoteFolderId))
        || !Array.isArray(pendingMutations) || pendingMutations.length > item.providerRefs.length
        || new Set(pendingMutations.map(row => row.id)).size !== pendingMutations.length
        || pendingMutations.some(row => !validId(row.id) || row.itemId !== item.id || row.operation !== 'update'
          || !item.providerRefs.some(ref => ref.providerId === row.providerId) || !Number.isFinite(Date.parse(row.createdAt)))) throw invalid();
    }
    if (record.supersededDeletion !== undefined) {
      const deletion = record.supersededDeletion;
      if (record.reapply || !deletion || !validId(deletion.id) || deletion.itemId !== record.source.id
        || deletion.providerId !== record.provider.id || deletion.operation !== 'delete'
        || !Number.isFinite(Date.parse(deletion.createdAt)) || !Number.isSafeInteger(deletion.attempts) || deletion.attempts < 0
        || record.source.providerRefs.length !== 1) throw invalid();
    }
    if (record.status === 'prepared') {
      if (pending.has(record.source.id)) throw invalid();
      pending.add(record.source.id);
    }
  }
  return structuredClone(value);
}

export async function mdbx2RestoreScope(record: Mdbx2RestoreRecord): Promise<string> {
  const { intent, source, provider } = record;
  const data = [1, 'restore-original-object', record.id, source.id, source.deletedAt, source.updatedAt, provider.id, provider.config.vaultHandle,
    intent.objectId, intent.collectionId, intent.objectTypeId, intent.expectedHeadCommitId, intent.writeRevision.vaultId, intent.writeRevision.revisionSha256];
  if (record.reapply) data.push(JSON.stringify(record.reapply));
  if (record.supersededDeletion) data.push('superseded-deletion', JSON.stringify(record.supersededDeletion));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function assertMdbx2RestoreScope(record: Mdbx2RestoreRecord): Promise<void> {
  if (await mdbx2RestoreScope(record) !== record.intent.operationScope) throw invalid();
}
