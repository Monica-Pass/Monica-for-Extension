import { assertMdbx2RestoreScope, readMdbx2RestoreJournal, type Mdbx2RestoreRecord } from './mdbx2-restore-journal';
import { passwordGroupKey } from './password-groups';
import type { Mdbx2ObjectsRestoreInput, Mdbx2ObjectsRestoreResult } from '../providers/mdbx2/native-contract';
import type { LoginItem, PendingMutation, VaultItem } from './model';

/** Encrypted local receipt for a single atomic native restoration, never synced as item data. */
export interface Mdbx2RestoreBatchRecord {
  version: 1;
  id: string;
  status: 'prepared' | 'completed';
  members: Mdbx2RestoreRecord[];
  operationScope: string;
  receipt?: Mdbx2ObjectsRestoreResult;
  request?: Mdbx2RestoreBatchRequest;
  /** Complete cached cohort when only a subset needs native restoration. */
  cancellation?: { sources: LoginItem[]; pendingDeletions: PendingMutation[] };
}
export function mdbx2RestoreBatchSources(record: Mdbx2RestoreBatchRecord): VaultItem[] {
  return record.cancellation?.sources || record.members.map(member => member.source);
}
export interface Mdbx2RestoreBatchRequest {
  operationId: string;
  anchorItemId: string;
  providerId: string;
  deletedAt: string;
  expected: Record<string, string>;
}
const invalid = () => new Error('MDBX 整组恢复记录无效，原始记录已保留。');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;

export function readMdbx2RestoreBatchRequest(value: Mdbx2RestoreBatchRequest): Mdbx2RestoreBatchRequest {
  if (!value || !id(value.operationId) || !id(value.anchorItemId) || !id(value.providerId)
    || typeof value.deletedAt !== 'string' || value.deletedAt.length > 128 || !Number.isFinite(Date.parse(value.deletedAt))
    || !value.expected || typeof value.expected !== 'object' || Array.isArray(value.expected)) throw invalid();
  const entries = Object.entries(value.expected);
  if (!entries.length || entries.length > 50 || !entries.some(([key]) => key === value.anchorItemId)
    || entries.some(([key, stamp]) => !id(key) || typeof stamp !== 'string' || stamp.length > 128 || !Number.isFinite(Date.parse(stamp)))) throw invalid();
  return { operationId: value.operationId, anchorItemId: value.anchorItemId, providerId: value.providerId, deletedAt: value.deletedAt,
    expected: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) };
}

export function mdbx2RestoreBatchInput(record: Mdbx2RestoreBatchRecord): Mdbx2ObjectsRestoreInput {
  return { writeRevision: structuredClone(record.members[0].intent.writeRevision), objects: record.members.map(({ intent }) => ({
    objectId: intent.objectId, collectionId: intent.collectionId, objectTypeId: intent.objectTypeId, expectedHeadCommitId: intent.expectedHeadCommitId,
  })) };
}

export function readMdbx2RestoreBatchJournal(value: unknown): Mdbx2RestoreBatchRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const ids = new Set<string>(), pendingItems = new Set<string>();
  for (const record of value as Mdbx2RestoreBatchRecord[]) {
    if (!record || record.version !== 1 || !id(record.id) || ids.has(record.id) || !['prepared', 'completed'].includes(record.status)
      || typeof record.operationScope !== 'string' || !/^[a-f0-9]{64}$/.test(record.operationScope)
      || !Array.isArray(record.members) || !record.members.length || record.members.length > 50
      || (record.status === 'completed') !== Boolean(record.receipt)) throw invalid();
    ids.add(record.id);
    const members = readMdbx2RestoreJournal(record.members), first = members[0];
    if (record.cancellation !== undefined) {
      if (!record.cancellation) throw invalid();
      const { sources, pendingDeletions } = record.cancellation;
      if (!record.request || !Array.isArray(sources) || sources.length < members.length || sources.length > 50
        || sources.some(source => !source || source.kind !== 'login' || !id(source.id)
          || source.deletedAt !== first.source.deletedAt || !Number.isFinite(Date.parse(source.updatedAt))
          || typeof source.password !== 'string' || typeof source.username !== 'string' || typeof source.notes !== 'string'
          || !Array.isArray(source.providerRefs) || source.providerRefs.length !== 1 || source.providerRefs[0].providerId !== first.provider.id
          || source.providerRefs[0].remoteId && (!id(source.providerRefs[0].remoteId) || !id(source.providerRefs[0].remoteFolderId) || !id(source.providerRefs[0].revision))
          || first.source.kind !== 'login' || passwordGroupKey(source) !== passwordGroupKey(first.source))
        || new Set(sources.map(source => source.id)).size !== sources.length
        || new Set(sources.flatMap(source => source.replicaGroupId ? [source.replicaGroupId] : [])).size !== sources.filter(source => source.replicaGroupId).length
        || new Set(sources.flatMap(source => source.providerRefs[0].remoteId ? [source.providerRefs[0].remoteId] : [])).size !== sources.filter(source => source.providerRefs[0].remoteId).length
        || members.some(member => !same(sources.find(source => source.id === member.source.id), member.source))
        || !Array.isArray(pendingDeletions) || pendingDeletions.length > sources.length
        || new Set(pendingDeletions.map(row => row.id)).size !== pendingDeletions.length
        || new Set(pendingDeletions.map(row => row.itemId)).size !== pendingDeletions.length
        || pendingDeletions.some(row => !id(row.id) || row.operation !== 'delete' || row.providerId !== first.provider.id
          || !sources.some(source => source.id === row.itemId) || !Number.isFinite(Date.parse(row.createdAt))
          || !Number.isSafeInteger(row.attempts) || row.attempts < 0)) throw invalid();
    }
    const sources = mdbx2RestoreBatchSources(record);
    if (record.request) {
      const request = readMdbx2RestoreBatchRequest(record.request);
      if (request.operationId !== record.id || request.providerId !== first.provider.id || request.deletedAt !== first.source.deletedAt
        || Object.keys(request.expected).length !== sources.length || sources.some(source => request.expected[source.id] !== source.updatedAt)) throw invalid();
    }
    if (first.source.kind !== 'login') throw invalid();
    const key = passwordGroupKey(first.source), objects = new Set<string>();
    for (const member of members) {
      if (member.status !== 'prepared' || member.reapply || member.supersededDeletion || !same(member.provider, first.provider)
        || member.source.kind !== 'login' || member.intent.objectTypeId !== 'login' || member.source.providerRefs.length !== 1
        || passwordGroupKey(member.source) !== key || member.source.deletedAt !== first.source.deletedAt
        || !same(member.intent.writeRevision, first.intent.writeRevision) || objects.has(member.intent.objectId)) throw invalid();
      objects.add(member.intent.objectId);
    }
    if (record.status === 'prepared') for (const source of sources) {
      if (pendingItems.has(source.id)) throw invalid();
      pendingItems.add(source.id);
    }
    if (record.receipt) {
      const receipt = record.receipt;
      if (receipt.changed !== true || !id(receipt.operationId) || !id(receipt.commitId) || typeof receipt.alreadyCommitted !== 'boolean'
        || !Array.isArray(receipt.items) || receipt.items.length !== members.length) throw invalid();
      for (let index = 0; index < members.length; index++) {
        const item = receipt.items[index], { intent } = members[index];
        if (!item || item.changed !== true || item.kind !== 'restore' || item.objectId !== intent.objectId || item.collectionId !== intent.collectionId
          || item.objectTypeId !== intent.objectTypeId || item.logicalObjectId !== `native:${intent.objectId}`) throw invalid();
      }
    }
  }
  return structuredClone(value);
}

export async function mdbx2RestoreBatchScope(record: Mdbx2RestoreBatchRecord): Promise<string> {
  const data = JSON.stringify([1, 'restore-password-project-batch', record.id, record.members, ...(record.request ? [record.request] : []),
    ...(record.cancellation ? ['cancellation', record.cancellation] : [])]);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function assertMdbx2RestoreBatchScope(record: Mdbx2RestoreBatchRecord): Promise<void> {
  for (const member of record.members) await assertMdbx2RestoreScope(member);
  if (await mdbx2RestoreBatchScope(record) !== record.operationScope) throw invalid();
}
