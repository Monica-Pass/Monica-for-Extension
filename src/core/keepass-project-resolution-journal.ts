import type { ProviderAccount, VaultItem, VaultState } from './model';
import { sameProviderBinding } from './provider';
import type { KeePassProjectResolutionRequest } from '../providers/keepass/keepass-project-resolution';

export interface KeePassProjectResolutionIntent {
  version: 1;
  status: 'staged' | 'writing' | 'completed' | 'cancelled';
  createdAt: string;
  source: ProviderAccount;
  request: KeePassProjectResolutionRequest;
  originals: VaultItem[];
  resolvedSha256?: string;
}
export const resolutionSnapshotKey = (value: unknown) => JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
export function readKeePassProjectResolutionIntents(value: unknown): KeePassProjectResolutionIntent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('KeePass 冲突解决记录无效。');
  const ids = new Set<string>();
  for (const row of value as KeePassProjectResolutionIntent[]) {
    if (!row || row.version !== 1 || !['staged', 'writing', 'completed', 'cancelled'].includes(row.status)
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) || row.source?.kind !== 'keepass'
      || typeof row.source.id !== 'string' || !row.source.id || row.source.id.length > 512
      || !row.source.config || typeof row.source.config !== 'object' || Array.isArray(row.source.config)
      || !['webdav', 'onedrive'].includes(String(row.source.config.sourceMode)) || !row.request
      || typeof row.request.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.request.operationId) || ids.has(row.request.operationId)
      || typeof row.request.reviewToken !== 'string' || !/^[a-f0-9]{64}$/.test(row.request.reviewToken)
      || !Array.isArray(row.originals) || !Array.isArray(row.request.choices)
      || !row.request.choices.length || row.request.choices.length > 1000
      || row.request.choices.some(choice => typeof choice?.projectId !== 'string' || !choice.projectId || choice.projectId.length > 512 || !['local', 'remote'].includes(choice.choice))
      || new Set(row.request.choices.map(choice => choice.projectId)).size !== row.request.choices.length
      || new Set(row.originals.map(item => item?.id)).size !== row.originals.length
      || row.originals.some(item => typeof item?.id !== 'string' || !item.id || !Array.isArray(item.providerRefs) || !item.providerRefs.some(ref => ref?.providerId === row.source.id))
      || (row.status === 'completed' ? !/^[a-f0-9]{64}$/.test(row.resolvedSha256 || '') : row.resolvedSha256 !== undefined))
      throw new Error('KeePass 冲突解决记录无效。');
    ids.add(row.request.operationId);
  }
  return structuredClone(value);
}
export function assertKeePassResolutionUnchanged(state: VaultState, intent: KeePassProjectResolutionIntent): ProviderAccount {
  const source = state.providers.find(row => row.id === intent.source.id);
  if (!source || !source.enabled || !sameProviderBinding(source, intent.source) || source.config.databaseId !== intent.source.config.databaseId)
    throw new Error('KeePass 冲突解决的密码源已变化。');
  const current = state.items.filter(item => item.providerRefs.some(ref => ref.providerId === source.id));
  const ordered = (items: VaultItem[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  if (resolutionSnapshotKey(ordered(current)) !== resolutionSnapshotKey(ordered(intent.originals))
    || state.mutationQueue.some(row => row.providerId === source.id) || state.providerConflicts.some(row => row.providerId === source.id))
    throw new Error('密码源出现后续修改，已保留本机内容及冲突恢复记录。');
  return source;
}
