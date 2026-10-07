import type { LoginItem, VaultItem } from '../core/model';
import { groupedPasswords } from '../core/password-groups';
import { passwordProjectGroups } from '../core/password-project-view';

/** Public display data only. Never contains project IDs, passwords or raw metadata. */
export interface AutofillCredentialIdentity {
  groupLabel?: string;
  passwordNumber?: number;
}

/** Compute against the full active vault BEFORE site/search/grant/limit filtering. */
export function autofillCredentialIdentities(items: VaultItem[]): Record<string, AutofillCredentialIdentity> {
  const logins = items.filter((item): item is LoginItem => item.kind === 'login' && !item.deletedAt && !item.archivedAt
    && (!item.loginType || item.loginType === 'PASSWORD') && Boolean(item.passwordGroupId));
  const identities = new Map<string, AutofillCredentialIdentity>();
  for (const members of groupedPasswords(logins)) {
    const groups = passwordProjectGroups(members);
    const labels = new Map(groups?.flatMap(group => group.rows.map(row => [row.item.id, group.label] as const)));
    // Android's local Room IDs are not portable. Prefer exchanged group/password
    // order (also used by the project editor), with the legacy stable order fallback.
    const ordered = groups?.flatMap(group => group.rows.map(row => row.item)) ?? members;
    const accounts = new Map<string, LoginItem[]>();
    for (const item of ordered) {
      const account = accounts.get(item.username) ?? [];
      account.push(item); accounts.set(item.username, account);
    }
    for (const account of accounts.values()) account.forEach((item, index) => {
      const groupLabel = labels.get(item.id)?.trim().slice(0, 160);
      if (groupLabel || account.length > 1) identities.set(item.id, {
        ...(groupLabel ? {groupLabel} : {}), ...(account.length > 1 ? {passwordNumber: index + 1} : {})
      });
    });
  }
  return Object.fromEntries(identities);
}

export function formatAutofillCredential(identity: AutofillCredentialIdentity | undefined,
  translate: (source: string, params?: Record<string, unknown>) => string): string {
  if (!identity) return '';
  return [identity.passwordNumber ? translate('密码 {0}', {0: identity.passwordNumber}) : '', identity.groupLabel]
    .filter(Boolean).join(' · ');
}
