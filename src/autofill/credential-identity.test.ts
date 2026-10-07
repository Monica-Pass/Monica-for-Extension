import { describe, expect, it } from 'vitest';
import { createLoginItem } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { autofillCredentialIdentities, formatAutofillCredential } from './credential-identity';

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function login(group: number, password: number) {
  return {...createLoginItem({title: 'Example', username: 'same-user', password: 'secret-sentinel', uris: ['https://example.test']}),
    id: `row-${group}-${password}`, passwordGroupId: uuid(99),
    customFields: [{name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({
      version: 1, projectId: uuid(99), groupId: uuid(group + 1), passwordId: uuid(10 + group * 10 + password),
      label: group ? 'Backup' : 'Work', primary: !group, groupOrder: group, passwordOrder: password
    })}]};
}
describe('autofill credential identity', () => {
  it('distinguishes repeated accounts in exported project order before matching or limiting', () => {
    const first = login(0, 0), second = login(0, 1), third = login(1, 0);
    first.uris = ['https://different.test'];
    const items = [third, second, first];
    const original = JSON.stringify(items);
    const result = autofillCredentialIdentities(items);
    expect(result).toEqual({[first.id]: {groupLabel: 'Work', passwordNumber: 1},
      [second.id]: {groupLabel: 'Work', passwordNumber: 2}, [third.id]: {groupLabel: 'Backup', passwordNumber: 3}});
    expect(JSON.stringify(items)).toBe(original);
    expect(JSON.stringify(result)).not.toMatch(/secret-sentinel|00000000|monica.content/);
  });
  it('never infers membership from a shared name, account, website or metadata alone', () => {
    const a = login(0, 0), b = login(0, 1);
    a.passwordGroupId = ''; b.passwordGroupId = '';
    expect(autofillCredentialIdentities([a, b])).toEqual({});
  });
  it('scopes duplicate project IDs to their providers and databases', () => {
    const a = login(0, 0), b = login(0, 1);
    const copies = [a, b].map(item => ({...item, id: `copy-${item.id}`, providerRefs: [{providerId: 'remote'}]}));
    const db = [a, b].map(item => ({...item, id: `db-${item.id}`, mdbxDatabaseId: 2}));
    const result = autofillCredentialIdentities([b, ...copies, a, ...db]);
    expect(Object.values(result).map(v => v.passwordNumber).sort()).toEqual([1, 1, 1, 2, 2, 2]);
  });
  it('numbers only repeated exact accounts and ignores removed, archived and non-password records', () => {
    const a = login(0, 0), b = login(1, 0), removed = login(2, 0), archived = login(3, 0), ssh = login(4, 0);
    b.username = 'different-user';
    const result = autofillCredentialIdentities([a, b, {...removed, deletedAt: '2026-10-05'},
      {...archived, archivedAt: '2026-10-05'}, {...ssh, loginType: 'SSH_KEY'}]);
    expect(result).toEqual({[a.id]: {groupLabel: 'Work'}, [b.id]: {groupLabel: 'Backup'}});
  });
  it('keeps legacy explicit projects distinct without interpreting invalid group metadata', () => {
    const a = login(0, 0), b = login(0, 1);
    a.customFields = []; b.customFields = [];
    const result = autofillCredentialIdentities([b, a]);
    expect(result[a.id].passwordNumber).not.toBe(result[b.id].passwordNumber);
    expect(Object.values(result).every(v => !v.groupLabel)).toBe(true);
  });
  it('uses reorder metadata and omits conflicting labels without changing original carriers', () => {
    const a = login(0, 1), b = login(0, 0);
    a.id = 'first-id'; b.id = 'last-id';
    expect(autofillCredentialIdentities([a, b])[b.id].passwordNumber).toBe(1);
    const raw = JSON.parse(a.customFields[0].value); raw.label = 'Conflicting';
    a.customFields[0].value = JSON.stringify(raw);
    expect(autofillCredentialIdentities([a, b])[a.id]).not.toHaveProperty('groupLabel');
  });
  it('formats a localized identity without any secret or identifier fallback', () => {
    const translate = (source: string, params?: Record<string, unknown>) => source.replace('{0}', String(params?.[0]));
    expect(formatAutofillCredential({groupLabel: 'Work', passwordNumber: 2}, translate)).toBe('密码 2 · Work');
    expect(formatAutofillCredential(undefined, translate)).toBe('');
  });
});
