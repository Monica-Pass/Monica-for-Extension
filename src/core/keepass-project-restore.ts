import type { LoginItem, ProviderAccount, VaultItem } from './model';
import { passwordGroupKey } from './password-groups';
import { passwordProjectGroups } from './password-project-view';
import { readProjectCredential } from './project-credentials';

export interface KeePassProjectRestoreRequest {
  backend: 'keepass';
  operationId: string;
  providerId: string;
  anchorItemId: string;
  /** Complete project snapshot, including active members; never a deletion timestamp cohort. */
  expected: Record<string, string>;
  restoreIds: string[];
}
/** Local encrypted queue receipt. Completion acknowledges local staging, not remote publication. */
export interface KeePassProjectRestoreReceipt {
  version: 1;
  request: KeePassProjectRestoreRequest;
  title: string;
  queuedAt: string;
}
const invalid = () => new Error('KeePass 整组恢复范围无效，请重新打开项目。');
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const stamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && Number.isFinite(Date.parse(value));

export function readKeePassProjectRestoreRequest(value: KeePassProjectRestoreRequest): KeePassProjectRestoreRequest {
  if (!value || value.backend !== 'keepass' || !id(value.operationId) || !id(value.providerId) || !id(value.anchorItemId)
    || !value.expected || typeof value.expected !== 'object' || Array.isArray(value.expected)
    || !Array.isArray(value.restoreIds) || !value.restoreIds.length || value.restoreIds.length > 100
    || value.restoreIds.some(item => !id(item)) || new Set(value.restoreIds).size !== value.restoreIds.length
    || !value.restoreIds.includes(value.anchorItemId)) throw invalid();
  const entries = Object.entries(value.expected);
  if (!entries.length || entries.length > 100 || entries.some(([key, value]) => !id(key) || !stamp(value))
    || value.restoreIds.some(key => !Object.prototype.hasOwnProperty.call(value.expected, key))) throw invalid();
  return { backend: 'keepass', operationId: value.operationId, providerId: value.providerId, anchorItemId: value.anchorItemId,
    expected: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))), restoreIds: [...value.restoreIds].sort() };
}

export function readKeePassProjectRestoreReceipts(value: unknown): KeePassProjectRestoreReceipt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const ids = new Set<string>();
  return value.map(row => {
    if (!row || row.version !== 1 || typeof row.title !== 'string' || !stamp(row.queuedAt)) throw invalid();
    const request = readKeePassProjectRestoreRequest(row.request);
    if (ids.has(request.operationId)) throw invalid();
    ids.add(request.operationId);
    return { version: 1, request, title: row.title, queuedAt: row.queuedAt };
  });
}

export function keePassRestoreProject(anchor: VaultItem, items: VaultItem[], providers: ProviderAccount[]): LoginItem[] {
  if (anchor.kind !== 'login' || !anchor.deletedAt || !anchor.passwordGroupId || anchor.providerRefs.length !== 1
    || !providers.some(provider => provider.id === anchor.providerRefs[0].providerId && provider.kind === 'keepass')) return [];
  return items.filter((item): item is LoginItem => item.kind === 'login' && passwordGroupKey(item) === passwordGroupKey(anchor))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function assertKeePassRestoreProject(members: LoginItem[], request: KeePassProjectRestoreRequest): LoginItem[] {
  if (members.length !== Object.keys(request.expected).length || members.some(item => request.expected[item.id] !== item.updatedAt)
    || new Set(members.map(item => item.id)).size !== members.length) throw new Error('项目成员或内容已变化，请重新打开整组恢复。');
  const targets = members.filter(item => item.deletedAt);
  if (JSON.stringify(targets.map(item => item.id).sort()) !== JSON.stringify([...request.restoreIds].sort()))
    throw new Error('回收站成员已变化，请重新打开整组恢复。');
  if (!members.length || !passwordProjectGroups(members) || members.some(item =>
    item.providerRefs.length !== 1 || item.providerRefs[0].providerId !== request.providerId
    || readProjectCredential(item.customFields)?.projectId !== item.passwordGroupId))
    throw new Error('项目凭据分组存在冲突，请先核对原始成员；所有密码均已保留。');
  const remoteIds = members.flatMap(item => item.providerRefs[0].remoteId ? [item.providerRefs[0].remoteId!] : []);
  if (new Set(remoteIds).size !== remoteIds.length) throw invalid();
  return targets;
}
