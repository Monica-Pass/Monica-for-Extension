import type { LoginItem, ProviderAccount, VaultItem } from './model';
import { passwordGroupKey } from './password-groups';
import { readProjectCredential } from './project-credentials';
import { reconcileProjectCredentialEdits } from './project-credential-edits';
import { planPasswordProjectRemoval } from './password-project-removal';

export interface KeePassProjectRemovalDraft {
  providerId: string;
  anchorItemId: string;
  /** Full active project as opened, including archived members. */
  originals: LoginItem[];
  /** Full edited project, including selected removals and unsaved additions. */
  items: LoginItem[];
  removedItemIds: string[];
  allowLockedAutofill?: boolean;
}

// Key order is irrelevant; array order and exact opaque string values are not.
function snapshot(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}
const invalid = () => new Error('KeePass 项目成员或来源已变化，请重新打开项目；原密码尚未移除。');

/** Pure planning only. The caller must stage one durable operation and apply the
 * retained writes, owner attachment transfer and removals to one KDBX file revision.
 * This does not authorize independent per-entry deletion or publish a remote write.
 */
export function planKeePassProjectRemoval(input: KeePassProjectRemovalDraft, current: VaultItem[], provider: ProviderAccount) {
  if (!input || !provider.enabled || provider.kind !== 'keepass' || provider.id !== input.providerId
    || !Array.isArray(input.originals) || !input.originals.length || input.originals.length > 100
    || !Array.isArray(input.items) || !input.items.length || input.items.length > 100
    || !Array.isArray(input.removedItemIds)
    || input.allowLockedAutofill !== undefined && typeof input.allowLockedAutofill !== 'boolean') throw invalid();
  const anchor = current.find(item => item.id === input.anchorItemId);
  if (!anchor || anchor.kind !== 'login' || anchor.deletedAt || !anchor.passwordGroupId) throw invalid();
  const scope = passwordGroupKey(anchor);
  const members = current.filter((item): item is LoginItem => item.kind === 'login' && !item.deletedAt && passwordGroupKey(item) === scope);
  const originals = new Map(input.originals.map(row => [row.id, row]));
  const drafts = new Map(input.items.map(row => [row.id, row]));
  if (originals.size !== input.originals.length || drafts.size !== input.items.length
    || members.length !== originals.size || !originals.has(anchor.id)
    || members.some(row => !originals.has(row.id) || snapshot(row) !== snapshot(originals.get(row.id)) || !drafts.has(row.id))) throw invalid();
  const nativeIds = new Set<string>();
  const remoteIds = new Set<string>();
  for (const row of [...input.originals, ...input.items]) {
    if (row.kind !== 'login' || row.deletedAt || passwordGroupKey(row) !== scope
      || row.providerRefs.length !== 1 || row.providerRefs[0].providerId !== provider.id
      || readProjectCredential(row.customFields)?.projectId !== anchor.passwordGroupId) throw invalid();
  }
  for (const row of input.originals) {
    const remoteId = row.providerRefs[0].remoteId;
    if (!row.keepassEntryUuid || !remoteId || nativeIds.has(row.keepassEntryUuid) || remoteIds.has(remoteId)) throw invalid();
    nativeIds.add(row.keepassEntryUuid);
    remoteIds.add(remoteId);
  }
  for (const row of input.items) {
    const original = originals.get(row.id);
    if (original) {
      if (row.keepassEntryUuid !== original.keepassEntryUuid || snapshot(row.providerRefs) !== snapshot(original.providerRefs)
        || readProjectCredential(row.customFields)?.passwordId !== readProjectCredential(original.customFields)?.passwordId) throw invalid();
    } else if (current.some(item => item.id === row.id) || row.keepassEntryUuid || row.providerRefs[0].remoteId) throw invalid();
  }
  const reconciled = reconcileProjectCredentialEdits(structuredClone(input.items), input.originals);
  const plan = planPasswordProjectRemoval(reconciled, input.originals, input.removedItemIds);
  return structuredClone({ providerId: provider.id, projectId: anchor.passwordGroupId, ...plan });
}
