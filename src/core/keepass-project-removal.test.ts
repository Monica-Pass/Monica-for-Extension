import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from './model';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from './project-credentials';
import { planKeePassProjectRemoval, type KeePassProjectRemovalDraft } from './keepass-project-removal';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const provider: ProviderAccount = { id: 'kp', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} };
  const rows: LoginItem[] = [0, 1, 2].map(n => ({ ...createLoginItem({ title: 'Project', username: n < 2 ? 'shared' : 'recovery', password: `password-${n}` }),
    passwordGroupId: uuid(99), keepassDatabaseId: 7, keepassEntryUuid: uuid(n + 40), providerRefs: [{ providerId: 'kp', remoteId: uuid(n + 40), etag: `revision-${n}` }],
    passwordHistory: [{ password: `old-${n}`, lastUsedAt: '2026-10-01T00:00:00Z' }],
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId: uuid(99), groupId: uuid(n < 2 ? 1 : 2), passwordId: uuid(n + 10),
      label: n < 2 ? 'Primary' : 'Recovery', primary: n < 2, groupOrder: n < 2 ? 0 : 1, passwordOrder: n < 2 ? n : 0 }).replace(/}$/, ',"future":9007199254740993}') }] }));
  rows[0].customFields.push({ name: 'shared content', value: '  exact\r\ncontent  ', protected: true });
  rows[0].imagePaths = ['source-owned-image'];
  rows[0].passkeyBindings = '{"opaque":9007199254740993}';
  const input: KeePassProjectRemovalDraft = { providerId: 'kp', anchorItemId: rows[0].id, originals: structuredClone(rows), items: structuredClone(rows), removedItemIds: [rows[0].id] };
  return { provider, rows, input };
}

it('plans complete owner removal with exact native identities, content and retained password histories', () => {
  const { provider, rows, input } = fixture();
  input.items[0].notes = 'Edited project notes';
  const before = JSON.stringify({ input, rows });
  const plan = planKeePassProjectRemoval(input, rows, provider);
  expect(plan.ownerTransfer).toEqual({ sourceItemId: rows[0].id, targetItemId: rows[1].id });
  expect(plan.removed).toEqual([rows[0]]);
  expect(plan.retained.map(row => row.password)).toEqual(['password-1', 'password-2']);
  for (const row of plan.retained) {
    const original = rows.find(candidate => candidate.id === row.id)!;
    expect(row).toMatchObject({ notes: 'Edited project notes', keepassEntryUuid: original.keepassEntryUuid, providerRefs: original.providerRefs, passwordHistory: original.passwordHistory });
    expect(row.customFields[0].value).toContain('9007199254740993');
  }
  expect(plan.retained[0]).toMatchObject({ imagePaths: rows[0].imagePaths, passkeyBindings: rows[0].passkeyBindings });
  expect(plan.retained[0].customFields).toContainEqual(rows[0].customFields[1]);
  expect(JSON.stringify({ input, rows })).toBe(before);
  plan.removed[0].customFields[0].value = 'mutated result';
  expect(JSON.stringify({ input, rows })).toBe(before);
});

it.each(['same-time-content', 'new-member', 'missing-member', 'archived-member', 'entry-swap', 'provider-change', 'duplicate-native-id', 'lost-draft', 'reused-new-id', 'new-remote-id', 'password-id'])('rejects %s before any original data changes', scenario => {
  const { provider, rows, input } = fixture();
  if (scenario === 'same-time-content') rows[2].notes = 'external edit without timestamp change';
  if (scenario === 'new-member') rows.push({ ...rows[2], id: 'concurrent member' });
  if (scenario === 'missing-member') rows.pop();
  if (scenario === 'archived-member') rows[2].archivedAt = rows[2].updatedAt;
  if (scenario === 'entry-swap') input.items[1].keepassEntryUuid = rows[2].keepassEntryUuid;
  if (scenario === 'provider-change') provider.kind = 'bitwarden';
  if (scenario === 'duplicate-native-id') { rows[2].keepassEntryUuid = rows[1].keepassEntryUuid; input.originals = structuredClone(rows); input.items = structuredClone(rows); }
  if (scenario === 'lost-draft') input.items.pop();
  if (scenario === 'reused-new-id') { rows.push({ ...rows[2], id: 'elsewhere', passwordGroupId: uuid(98) }); input.items.push({ ...input.items[2], id: 'elsewhere', keepassEntryUuid: undefined, providerRefs: [{ providerId: 'kp' }] }); }
  if (scenario === 'new-remote-id') input.items.push({ ...input.items[2], id: 'new', keepassEntryUuid: undefined });
  if (scenario === 'password-id') input.items[1].customFields[0].value = input.items[1].customFields[0].value.replace(uuid(11), uuid(55));
  const before = JSON.stringify({ rows, input });
  expect(() => planKeePassProjectRemoval(input, rows, provider)).toThrow();
  expect(JSON.stringify({ rows, input })).toBe(before);
});

it('does not include a different database with the same project ID or old trash in removal', () => {
  const { provider, rows, input } = fixture();
  const unrelated = { ...rows[0], id: 'other-file', keepassDatabaseId: 8 };
  const trash = { ...rows[1], id: 'old-trash', deletedAt: rows[1].updatedAt };
  const plan = planKeePassProjectRemoval(input, [...rows, unrelated, trash], provider);
  expect(plan.removed.map(row => row.id)).toEqual(input.removedItemIds);
  expect(plan.retained).toHaveLength(2);
});

it('promotes a remaining group while retaining its password ID and rejects removing the last password', () => {
  const { provider, rows, input } = fixture();
  input.removedItemIds = rows.slice(0, 2).map(row => row.id);
  const plan = planKeePassProjectRemoval(input, rows, provider);
  expect(readProjectCredential(plan.retained[0].customFields)).toMatchObject({ passwordId: uuid(12), primary: true, groupOrder: 0, passwordOrder: 0 });
  input.removedItemIds = rows.map(row => row.id);
  expect(() => planKeePassProjectRemoval(input, rows, provider)).toThrow('至少保留');
});
