import type { LoginItem } from './model';
import type { PasswordProjectRemovalRecord } from './password-project-removal-journal';
import { passwordGroupKey } from './password-groups';
import { readProjectCredential } from './project-credentials';

// Provider acknowledgements are retained; cancellation never restores stale remote routing.
const acknowledgement = new Set(['updatedAt', 'createdAt', 'providerRefs', 'replicaGroupId', 'mdbxFolderId',
  'bitwardenCustomFieldsVersion', 'bitwardenCipherId']);
const value = (row: LoginItem, key: string) => JSON.stringify([Object.prototype.hasOwnProperty.call(row, key), Reflect.get(row, key)]);
const changed = () => new Error('移除准备后项目又有变化，取消未覆盖新内容，请重新核对整个项目。');

export function cancelPasswordProjectRemovalDraft(record: PasswordProjectRemovalRecord, current: LoginItem[]): LoginItem[] {
  if (!record.cancellationItems) throw new Error('此旧移除记录缺少取消快照，原始数据已保留。');
  const staged = [...record.retained, ...record.removed];
  if (current.length !== staged.length || new Set(current.map(row => row.id)).size !== staged.length) throw changed();
  return record.cancellationItems.map(desired => {
    const before = staged.find(row => row.id === desired.id)!, latest = current.find(row => row.id === desired.id);
    if (!latest || latest.deletedAt || passwordGroupKey(latest) !== passwordGroupKey(before)
      || readProjectCredential(latest.customFields)?.passwordId !== readProjectCredential(before.customFields)?.passwordId
      || before.providerRefs.some(ref => !latest.providerRefs.some(actual => actual.providerId === ref.providerId
        && (!ref.remoteId || ref.remoteId === actual.remoteId) && (!ref.remoteFolderId || ref.remoteFolderId === actual.remoteFolderId)))) throw changed();
    const result = structuredClone(latest);
    for (const key of new Set([...Object.keys(desired), ...Object.keys(before)])) {
      if (acknowledgement.has(key) || value(desired, key) === value(before, key)) continue;
      if (value(latest, key) !== value(before, key) && value(latest, key) !== value(desired, key)) throw changed();
      if (Object.prototype.hasOwnProperty.call(desired, key)) Reflect.set(result, key, structuredClone(Reflect.get(desired, key)));
      else Reflect.deleteProperty(result, key);
    }
    return result;
  });
}

/** Shared-field reconciliation must not overwrite an independent later edit. */
export function assertCancellationPreservesLaterEdits(record: PasswordProjectRemovalRecord, current: LoginItem[], saved: LoginItem[]): void {
  for (const before of [...record.retained, ...record.removed]) {
    const latest = current.find(row => row.id === before.id)!, result = saved.find(row => row.id === before.id)!;
    for (const key of new Set([...Object.keys(before), ...Object.keys(latest)])) {
      if (!acknowledgement.has(key) && value(latest, key) !== value(before, key) && value(result, key) !== value(latest, key)) throw changed();
    }
  }
}
