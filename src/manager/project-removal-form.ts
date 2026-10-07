import type { LoginItem, ProviderAccount } from '../core/model';
import { readProjectCredential } from '../core/project-credentials';
import { reconcileProjectCredentialEdits } from '../core/project-credential-edits';
import { planPasswordProjectRemoval } from '../core/password-project-removal';
import type { LoginForm } from './login-form';
import { projectCredentialFormGroups } from './project-credential-form';
import { isRemoteKeePassSource } from '../providers/keepass/keepass-source';

export function projectRemovalRows(form: LoginForm) {
  const selected = new Set(form.removedPasswordIds ?? []);
  const groups = projectCredentialFormGroups(form);
  if (selected.size !== (form.removedPasswordIds?.length ?? 0) || selected.size && !groups)
    throw new Error('移除范围无效，原密码尚未移除。');
  const rows = groups?.flatMap((group, groupIndex) => group.rows.map((row, index) => ({
    passwordId: row.metadata!.passwordId, groupId: group.id, groupLabel: group.label,
    groupIndex, passwordIndex: index, index: row.index, removed: selected.has(row.metadata!.passwordId)
  }))) ?? [];
  if ([...selected].some(id => !rows.some(row => row.passwordId === id))) throw new Error('移除范围无效，原密码尚未移除。');
  return rows;
}

export function selectProjectPasswordRemoval(form: LoginForm, passwordIds: string[], remove: boolean): void {
  const rows = projectRemovalRows(form), selected = new Set(form.removedPasswordIds ?? []);
  if (!passwordIds.length || passwordIds.some(id => !rows.some(row => row.passwordId === id)))
    throw new Error('移除范围无效，原密码尚未移除。');
  for (const id of passwordIds) { if (remove) selected.add(id); else selected.delete(id); }
  if (selected.size >= rows.length) throw new Error('密码项目至少保留一条密码。');
  form.removedPasswordIds = [...selected];
}

export function supportsProjectMemberRemoval(form: LoginForm, owner: LoginItem | undefined, providers: ProviderAccount[]): boolean {
  const refs = [owner, ...form.groupMembers.map(row => row.original)].flatMap(row => row?.providerRefs ?? []);
  const ids = new Set([...refs.map(ref => ref.providerId), ...(form.providerId ? [form.providerId] : [])]);
  const accounts = [...ids].map(id => providers.find(p => p.id === id));
  return accounts.every(p => p?.enabled && (['local', 'mdbx2'].includes(p.kind) || p.kind === 'keepass' && isRemoteKeePassSource(p.config.sourceMode)))
    && accounts.filter(p => p?.kind !== 'local').length <= 1;
}

export function removedProjectItemIds(form: LoginForm, items: LoginItem[]): string[] {
  const selected = projectRemovalRows(form).filter(row => row.removed);
  const ids = selected.map(row => items.find(item => readProjectCredential(item.customFields)?.passwordId === row.passwordId)?.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('移除范围无效，原密码尚未移除。');
  return ids as string[];
}

/** Unsaved rows have no remote deletion; reconcile before promoting a new owner. */
export function omitUnsavedProjectPasswords(items: LoginItem[], originals: LoginItem[], removedItemIds: string[]): LoginItem[] {
  if (originals.some(row => removedItemIds.includes(row.id))) throw new Error('原密码尚未移除，请使用项目移除操作。');
  return planPasswordProjectRemoval(reconcileProjectCredentialEdits(items, originals), originals, removedItemIds).retained;
}
