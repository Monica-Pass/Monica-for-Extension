import { describe, expect, it } from 'vitest';
import { createLoginItem } from './model';
import { groupedPasswords, passwordGroupMembers } from './password-groups';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential, rebaseProjectCredentialFields } from './project-credentials';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const metadata = (groupOrder = 0, passwordOrder = 0) => ({ version: 1, projectId: id(99),
  groupId: id(groupOrder + 1), passwordId: id(10 + groupOrder * 10 + passwordOrder),
  label: '账号组 🔑', primary: groupOrder === 0, groupOrder, passwordOrder });
const field = (value: unknown) => ({ name: PROJECT_CREDENTIAL_FIELD, value: JSON.stringify(value), protected: true });
const login = (group: number, password: number) => ({ ...createLoginItem({ title: 'Same project' }),
  id: `${group}-${password}`, passwordGroupId: 'explicit-project', sortOrder: -(group * 10 + password),
  customFields: [field(metadata(group, password))] });

describe('Android project credential metadata', () => {
  it('reads current metadata without rewriting future JSON, protection or field order', () => {
    const fields = [{ name: 'before', value: 'unchanged', protected: false },
      { ...field(metadata()), value: JSON.stringify(metadata()).replace(/}$/, ',"future":9007199254740993}') }];
    const original = JSON.stringify(fields);
    expect(readProjectCredential(fields)).toMatchObject({ groupId: id(1), passwordId: id(10), label: '账号组 🔑' });
    expect(JSON.stringify(fields)).toBe(original);
    const legacy = metadata(); delete (legacy as Partial<typeof legacy>).projectId;
    expect(readProjectCredential([field(legacy)])).toBeDefined();
  });
  it.each([
    { version: 2 }, { groupId: 'not-a-uuid' }, { passwordId: 'bad' }, { projectId: 'bad' },
    { label: 5 }, { primary: 'true' }, { groupOrder: -1 }, { passwordOrder: 1.5 }, { groupOrder: 2147483648 }
  ])('leaves unsupported metadata uninterpreted: %j', patch => {
    expect(readProjectCredential([field({ ...metadata(), ...patch })])).toBeUndefined();
  });
  it('does not select one of duplicate metadata fields', () => {
    expect(readProjectCredential([field(metadata()), field(metadata(1))])).toBeUndefined();
  });
  it('orders explicit project members by Android group and password order in list and detail', () => {
    const items = [login(1, 1), login(0, 1), login(1, 0), login(0, 0)];
    const before = JSON.stringify(items);
    expect(groupedPasswords(items)[0].map(item => item.id)).toEqual(['0-0', '0-1', '1-0', '1-1']);
    expect(passwordGroupMembers(items[0], items).map(item => item.id)).toEqual(['0-0', '0-1', '1-0', '1-1']);
    expect(JSON.stringify(items)).toBe(before);
  });
  it('never uses metadata, shared title or account to join independent or cross-provider projects', () => {
    const first = login(0, 0);
    const independent = { ...login(0, 1), passwordGroupId: undefined };
    const otherVault = { ...login(1, 0), mdbxDatabaseId: 9 };
    expect(groupedPasswords([first, independent, otherVault])).toHaveLength(3);
    expect(passwordGroupMembers(first, [first, independent, otherVault])).toEqual([first]);
  });
  it('keeps legacy ordering for mixed, unsupported or duplicate password identities', () => {
    const first = login(0, 0); const second = login(0, 1);
    for (const customFields of [[], [field({ ...metadata(), version: 2 })], first.customFields]) {
      expect(groupedPasswords([first, { ...second, customFields }])[0].map(item => item.id)).toEqual(['0-1', '0-0']);
    }
  });
});

it('rebases only project identity like Android while preserving future numbers and field attributes', () => {
  const fields = [{ name: 'before', value: '0007', protected: false },
    { ...field(metadata()), value: JSON.stringify(metadata()).replace(/}$/, ',"future":9007199254740993}') }];
  const before = JSON.stringify(fields);
  const rebased = rebaseProjectCredentialFields(fields, id(100));
  expect(readProjectCredential(rebased)).toEqual({ ...readProjectCredential(fields), projectId: id(100) });
  expect(rebased[1].value).toContain('9007199254740993'); expect(rebased[1].protected).toBe(true);
  expect(rebased[0]).toBe(fields[0]); expect(JSON.stringify(fields)).toBe(before);
  expect(rebaseProjectCredentialFields(rebased, id(100))).toBe(rebased);
  expect(rebaseProjectCredentialFields([fields[0]], 'legacy-group')).toEqual([fields[0]]);
});
it('rejects unknown or duplicated credential metadata without rewriting it for a new project', () => {
  for (const fields of [[field({ ...metadata(), version: 2 })], [field(metadata()), field(metadata())]]) {
    const before = JSON.stringify(fields);
    expect(() => rebaseProjectCredentialFields(fields, id(100))).toThrow('元数据');
    expect(JSON.stringify(fields)).toBe(before);
  }
});
