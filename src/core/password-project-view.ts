import type { LoginItem } from './model';
import { passwordGroupKey } from './password-groups';
import { readProjectCredential, type ProjectCredentialMetadata } from './project-credentials';

export interface PasswordProjectGroupView {
  id: string;
  label: string;
  primary: boolean;
  order: number;
  rows: Array<{ item: LoginItem; metadata: ProjectCredentialMetadata }>;
}

/** Read-only presentation of an already scoped project. Never infer groups from accounts. */
export function passwordProjectGroups(members: LoginItem[]): PasswordProjectGroupView[] | undefined {
  if (!members.length || !members[0].passwordGroupId || members.some(item =>
    passwordGroupKey(item) !== passwordGroupKey(members[0]) || item.loginType && item.loginType !== 'PASSWORD')) return undefined;
  const groups = new Map<string, PasswordProjectGroupView>();
  const passwordIds = new Set<string>();
  for (const item of members) {
    const metadata = readProjectCredential(item.customFields);
    if (!metadata || passwordIds.has(metadata.passwordId)) return undefined;
    passwordIds.add(metadata.passwordId);
    const group = groups.get(metadata.groupId);
    if (group) {
      const first = group.rows[0].item;
      if (metadata.label !== group.label || metadata.primary !== group.primary || metadata.groupOrder !== group.order
        || item.username !== first.username || (item.totpSecret ?? '') !== (first.totpSecret ?? '')) return undefined;
      group.rows.push({ item, metadata });
    } else groups.set(metadata.groupId, { id: metadata.groupId, label: metadata.label,
      primary: metadata.primary, order: metadata.groupOrder, rows: [{ item, metadata }] });
  }
  return [...groups.values()].sort((a, b) => Number(b.primary) - Number(a.primary) || a.order - b.order)
    .map(group => ({ ...group, rows: [...group.rows].sort((a, b) => a.metadata.passwordOrder - b.metadata.passwordOrder) }));
}
