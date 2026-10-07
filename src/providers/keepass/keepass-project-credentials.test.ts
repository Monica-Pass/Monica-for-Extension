import { expect, it, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../core/model';
import * as writer from './keepass-writer';
import { groupedPasswords } from '../../core/password-groups';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { KeePassProvider } from './keepass-provider';
import { buildKeePassFixture } from './keepass-fixture';
import { openKeePassVault } from './keepass-vault';
import { keePassFieldText } from './keepass-login-codec';
import { planKeePassProjectRemoval } from '../../core/keepass-project-removal';
import { readProjectCredential } from '../../core/project-credentials';
import { prepareKeePassProjectAttachmentHandoff } from './keepass-project-attachments';

it('applies owner removal with native attachments and edited shared content in one saved project revision', async () => {
  const { provider, items } = await fixture();
  const owner = items.find(item => item.password === 'password-0')!;
  await provider.addAttachment(account, owner, 'project.bin', Uint8Array.of(11, 22, 33), false);
  const current = (await provider.sync(account, { now: '2026-10-06T05:00:00Z', localItems: [] })).items as LoginItem[];
  const originals = current.filter(item => item.passwordGroupId);
  const plan = planKeePassProjectRemoval({ providerId: account.id, anchorItemId: owner.id, originals,
    items: originals.map(row => row.id === owner.id ? { ...row, notes: 'shared edit during owner removal' } : row),
    removedItemIds: [owner.id] }, current, account);
  expect(plan.ownerTransfer?.sourceItemId).toBe(owner.id);
  const vault = await openKeePassVault(await provider.snapshotFile(account.id), { password: master, providerId: account.id, databaseId: 7 });
  const source = vault.entriesByUuid.get(owner.keepassEntryUuid!)!;
  const retainedOwner = plan.retained.find(row => row.id === plan.ownerTransfer!.targetItemId)!;
  const target = vault.entriesByUuid.get(retainedOwner.keepassEntryUuid!)!;
  const handoff = prepareKeePassProjectAttachmentHandoff(vault.database, source, target);
  const writes = plan.retained.map(item => {
    const entry = vault.entriesByUuid.get(item.keepassEntryUuid!)!;
    return { item, entry, patch: writer.prepareKeePassEntryWrite(item, entry.fields) };
  });
  writer.validateKeePassEntryRemoval(vault.database, source);
  handoff.apply();
  for (const row of writes) writer.writeKeePassEntry(vault.database, row.entry, row.item, row.patch);
  writer.removeKeePassEntry(vault.database, source);
  const reopened = await openKeePassVault(new Uint8Array(await vault.database.save()), { password: master, providerId: account.id, databaseId: 7 });
  for (const original of originals) {
    const actual = reopened.items.find(row => row.keepassEntryUuid === original.keepassEntryUuid) as LoginItem;
    expect(actual.password).toBe(original.password);
    expect(readProjectCredential(actual.customFields)?.passwordId).toBe(readProjectCredential(original.customFields)?.passwordId);
    expect(Boolean(actual.deletedAt)).toBe(original.id === owner.id);
    if (original.id !== owner.id) expect(actual.notes).toBe('shared edit during owner removal');
  }
  for (const uuid of [source.uuid.toString(), target.uuid.toString()]) {
    const binary = reopened.entriesByUuid.get(uuid)!.binaries.get('project.bin')! as { value: ArrayBuffer };
    expect([...new Uint8Array(binary.value)]).toEqual([11, 22, 33]);
  }
});

it('applies a planned single-password removal to a real encrypted KDBX without changing surviving identities', async () => {
  const { provider, items } = await fixture();
  const originals = items.filter(item => item.passwordGroupId);
  const removed = originals.find(item => readProjectCredential(item.customFields)?.passwordOrder === 1)!;
  const plan = planKeePassProjectRemoval({ providerId: account.id, anchorItemId: originals[0].id,
    originals, items: structuredClone(originals), removedItemIds: [removed.id] }, items, account);
  expect(plan.ownerTransfer).toBeUndefined();
  const now = '2026-10-06T05:00:00.000Z';
  const desired = [...items.filter(item => !item.passwordGroupId), ...plan.retained,
    ...plan.removed.map(item => ({ ...item, deletedAt: now, updatedAt: now }))];
  const result = await provider.sync(account, { now, localItems: desired });
  expect(result.conflicts).toEqual([]);
  const reopened = await openKeePassVault(await provider.snapshotFile(account.id), { password: master, providerId: account.id, databaseId: 7 });
  const originalSet = originals.map(item => item.keepassEntryUuid).sort();
  expect(reopened.items.filter(item => item.kind === 'login' && item.passwordGroupId).map(item => item.keepassEntryUuid).sort()).toEqual(originalSet);
  for (const original of originals) {
    const actual = reopened.items.find(item => item.keepassEntryUuid === original.keepassEntryUuid)!;
    expect(actual.kind).toBe('login');
    if (actual.kind !== 'login') throw new Error('Wrong reopened type');
    expect(actual.password).toBe(original.password);
    expect(readProjectCredential(actual.customFields)?.passwordId).toBe(readProjectCredential(original.customFields)?.passwordId);
    expect(Boolean(actual.deletedAt)).toBe(original.id === removed.id);
  }
  expect(reopened.items.filter(item => !item.deletedAt)).toHaveLength(3);
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const master = 'fixture master password';
const account: ProviderAccount = { id: 'kp', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: { databaseId: 7 } };
const metadata = (n: number) => `{"version":1,"projectId":"${uuid(99)}","groupId":"${uuid(n < 2 ? 1 : 2)}","passwordId":"${uuid(n + 10)}","label":"${n < 2 ? 'Primary' : 'Recovery'}","primary":${n < 2},"groupOrder":${n < 2 ? 0 : 1},"passwordOrder":${n < 2 ? n : 0},"future":9007199254740993}`;
async function fixture() {
  const bytes = await buildKeePassFixture({ entries: [2, 1, 0, 3].map(n => ({ title: 'Same title', fields: { UserName: n === 2 ? 'recovery' : 'shared' },
    protectedFields: { Password: `password-${n}`, ...(n === 3 ? {} : { [PROJECT_CREDENTIAL_FIELD]: metadata(n) }) } })) });
  const provider = new KeePassProvider(); await provider.unlock(account, bytes, { password: master });
  return { provider, bytes, items: (await provider.sync(account, { now: '2026-10-06T00:00:00Z', localItems: [] })).items as LoginItem[] };
}

async function removalFileFixture() {
  const f = await fixture();
  const owner = f.items.find(item => item.password === 'password-0')!;
  await f.provider.addAttachment(account, owner, 'project.bin', Uint8Array.of(11, 22, 33), false);
  const originals = (await f.provider.sync(account, { now: '2026-10-06T05:00:00Z', localItems: [] })).items
    .filter((item): item is LoginItem => item.kind === 'login' && !!item.passwordGroupId);
  const bytes = await f.provider.snapshotFile(account.id);
  const expectedSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const draft = { providerId: account.id, anchorItemId: owner.id, originals, items: structuredClone(originals), removedItemIds: [owner.id] };
  return { ...f, owner, originals, draft, input: { bytes, expectedSha256, credential: { password: master } } };
}

it.each([false, true])('prepares a complete isolated KDBX owner removal file with new destination=%s', async newDestination => {
  const f = await removalFileFixture();
  if (newDestination) {
    f.draft.items.push({ ...f.originals[0], id: 'new-draft-password', keepassEntryUuid: undefined, providerRefs: [{ providerId: account.id }],
      password: 'new-retained-password', customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true,
        value: metadata(4).replace(`"groupId":"${uuid(2)}"`, `"groupId":"${uuid(3)}"`).replace('"groupOrder":1', '"groupOrder":2') }] });
    f.draft.removedItemIds = f.originals.map(item => item.id);
  }
  const result = await f.provider.prepareProjectRemovalFile(account, f.draft, f.input);
  expect(result.inputSha256).toBe(f.input.expectedSha256);
  expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.outputSha256).not.toBe(result.inputSha256);
  expect(result.items.filter(item => item.deletedAt)).toHaveLength(f.draft.removedItemIds.length);
  const retained = result.items.filter(item => !item.deletedAt) as LoginItem[];
  if (newDestination) expect(retained).toMatchObject([{ id: 'new-draft-password', password: 'new-retained-password' }]);
  const reopened = await openKeePassVault(result.bytes, { password: master, providerId: account.id, databaseId: 7 });
  const owner = retained.find(item => readProjectCredential(item.customFields)?.primary && readProjectCredential(item.customFields)?.passwordOrder === 0)!;
  expect(reopened.entriesByUuid.get(owner.keepassEntryUuid!)!.binaries.has('project.bin')).toBe(true);
  expect(reopened.entriesByUuid.get(f.owner.keepassEntryUuid!)!.binaries.has('project.bin')).toBe(true);
  expect((await f.provider.sync(account, { now: '2026-10-06T06:00:00Z', localItems: [] })).items.every(item => !item.deletedAt)).toBe(true);
});

it.each(['hash', 'stale-native', 'last-invalid-write', 'attachment-collision', 'save-failure', 'write-failure'] as const)(
  'discards the isolated file for %s without changing the live provider or original bytes', async mode => {
    const f = await removalFileFixture();
    if (mode === 'hash') f.input.expectedSha256 = '0'.repeat(64);
    if (mode === 'stale-native') {
      const changed = await openKeePassVault(f.input.bytes, { password: master, providerId: account.id, databaseId: 7 });
      changed.entriesByUuid.get(f.originals[1].keepassEntryUuid!)!.fields.set('Notes', 'external edit without changing UsageCount');
      f.input.bytes = new Uint8Array(await changed.database.save());
      f.input.expectedSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', f.input.bytes.slice().buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    if (mode === 'last-invalid-write') f.draft.items.filter(item => item.id !== f.owner.id).slice(-1)[0].passwordHistoryIncomplete = true;
    if (mode === 'attachment-collision') {
      const plan = planKeePassProjectRemoval(f.draft, f.originals, account);
      const target = f.originals.find(item => item.id === plan.ownerTransfer!.targetItemId)!;
      await f.provider.addAttachment(account, target, 'project.bin', Uint8Array.of(99), false);
      f.input.bytes = await f.provider.snapshotFile(account.id);
      f.input.expectedSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', f.input.bytes.slice().buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    const originalBytes = f.input.bytes.slice();
    const originalItems = (await f.provider.sync(account, { now: '2026-10-06T06:00:00Z', localItems: [] })).items;
    const failure = mode === 'save-failure' ? vi.spyOn(kdbxweb.Kdbx.prototype, 'save').mockRejectedValueOnce(new Error('Synthetic save failure'))
      : mode === 'write-failure' ? vi.spyOn(writer, 'writeKeePassEntry').mockImplementationOnce(() => { throw new Error('Synthetic write failure'); }) : undefined;
    try { await expect(f.provider.prepareProjectRemovalFile(account, f.draft, f.input)).rejects.toThrow(); }
    finally { failure?.mockRestore(); }
    expect(f.input.bytes).toEqual(originalBytes);
    expect((await f.provider.sync(account, { now: '2026-10-06T06:00:00Z', localItems: [] })).items).toEqual(originalItems);
  }
);
it.each(['update', 'delete', 'restore'] as const)('keeps a whole project pending when one member has a %s conflict', async action => {
  const { provider, items } = await fixture();
  const members = items.filter(item => item.passwordGroupId), independent = items.find(item => !item.passwordGroupId)!;
  let baseline = items;
  if (action === 'restore') {
    const deleted = items.map(row => row.passwordGroupId ? { ...row, deletedAt: '2026-10-06T01:00:00Z' } : row);
    baseline = (await provider.sync(account, { now: '2026-10-06T01:00:00Z', localItems: deleted })).items as LoginItem[];
  }
  const remote = await openKeePassVault(await provider.snapshotFile(account.id), { password: master, providerId: 'fresh', databaseId: 7 });
  const conflicted = remote.entriesByUuid.get(members[1].keepassEntryUuid!)!;
  conflicted.fields.set('Notes', 'concurrent Android edit'); conflicted.times.lastModTime = new Date('2026-10-06T02:00:00Z');
  await provider.unlock(account, new Uint8Array(await remote.database.save()), { password: master });
  const desired = baseline.map(row => ({ ...row, notes: row.passwordGroupId ? 'local project edit' : 'independent accepted',
    deletedAt: row.passwordGroupId && action === 'delete' ? '2026-10-06T03:00:00Z' : undefined }));
  const result = await provider.sync(account, { now: '2026-10-06T03:00:00Z', localItems: desired,
    pendingMutations: desired.map(row => ({ id: row.id, itemId: row.id, providerId: account.id, operation: row.passwordGroupId && action === 'delete' ? 'delete' as const : 'update' as const,
      createdAt: row.updatedAt, attempts: 0, ...(row.passwordGroupId && action === 'restore' ? { keepassRestore: true as const } : {}) })) });
  expect(result.conflicts.map(row => row.itemId).sort()).toEqual(members.map(row => row.id).sort());
  const actual = await openKeePassVault(await provider.snapshotFile(account.id), { password: master, providerId: 'check', databaseId: 7 });
  for (const member of members) {
    const row = actual.items.find(item => item.keepassEntryUuid === member.keepassEntryUuid)!;
    expect(row.notes).toBe(member.id === members[1].id ? 'concurrent Android edit' : '');
    expect(Boolean(row.deletedAt)).toBe(action === 'restore');
  }
  expect(actual.items.find(row => row.keepassEntryUuid === independent.keepassEntryUuid)?.notes).toBe('independent accepted');
});

it('validates the last project write before changing earlier members or creating a new member', async () => {
  const { provider, items } = await fixture();
  const members = items.filter(item => item.passwordGroupId);
  const desired = items.map(row => row.passwordGroupId ? { ...row, notes: 'must not leak partial write',
    ...(row.id === members[1].id ? { passwordHistoryIncomplete: true } : {}) } : { ...row, notes: 'independent accepted' });
  desired.push({ ...members[0], id: 'new-member', keepassEntryUuid: undefined, providerRefs: [{ providerId: account.id }], notes: 'must not create',
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, value: metadata(4), protected: true }] });
  const result = await provider.sync(account, { now: '2026-10-06T03:00:00Z', localItems: desired });
  expect(result.conflicts).toHaveLength(4);
  const actual = await openKeePassVault(await provider.snapshotFile(account.id), { password: master, providerId: 'check', databaseId: 7 });
  expect(actual.items).toHaveLength(4);
  for (const member of members) expect(keePassFieldText(actual.entriesByUuid.get(member.keepassEntryUuid!)!.fields.get('Notes'))).toBe('');
  expect(actual.items.find(row => !('passwordGroupId' in row) || !row.passwordGroupId)?.notes).toBe('independent accepted');
});
it('restores only explicit Android KDBX project membership and isolates separate files/accounts', async () => {
  const { items, bytes } = await fixture();
  expect(groupedPasswords(items).map(rows => rows.map(row => row.password))).toEqual([['password-0', 'password-1', 'password-2'], ['password-3']]);
  const provider = new KeePassProvider(), other = { ...account, id: 'other', config: { databaseId: 8 } };
  await provider.unlock(other, bytes, { password: master });
  const copy = (await provider.sync(other, { now: '2026-10-06T00:00:00Z', localItems: [] })).items as LoginItem[];
  expect(groupedPasswords([...items, ...copy])).toHaveLength(4);
  expect(items.filter(row => row.passwordGroupId).every(row => row.customFields[0].value.includes('9007199254740993'))).toBe(true);
});
it('keeps malformed, future and legacy metadata exact without inventing a project identity', async () => {
  for (const value of ['{', metadata(0).replace('"version":1', '"version":2'), metadata(0).replace(`"projectId":"${uuid(99)}",`, '')]) {
    const bytes = await buildKeePassFixture({ entries: [{ title: 'Same title', protectedFields: { Password: 'x', [PROJECT_CREDENTIAL_FIELD]: value } }] });
    const provider = new KeePassProvider(); await provider.unlock(account, bytes, { password: master });
    const [item] = (await provider.sync(account, { now: '2026-10-06T00:00:00Z', localItems: [] })).items as LoginItem[];
    expect(item.passwordGroupId).toBeUndefined(); expect(item.customFields[0].value).toBe(value);
  }
});
it('upgrades cached grouping without writing the KDBX or changing local identities', async () => {
  const { provider, items } = await fixture();
  const cached = items.map(item => ({ ...item, id: `cached-${item.id}`, passwordGroupId: undefined,
    providerRefs: item.providerRefs.map(ref => ({ ...ref, etag: JSON.stringify({ ...JSON.parse(ref.etag!), passwordGroupId: undefined }) })) }));
  const write = vi.spyOn(writer, 'writeKeePassEntry');
  const restored = await provider.sync(account, { now: '2026-10-06T00:00:00Z', localItems: cached });
  expect(restored.conflicts).toEqual([]); expect(restored.items.map(item => item.id)).toEqual(cached.map(item => item.id));
  expect(groupedPasswords(restored.items as LoginItem[])).toHaveLength(2);
  expect(write).not.toHaveBeenCalled(); expect(provider.summarize(account.id).dirty).toBe(false);
  write.mockRestore();
});
it('commits known complete projects and rejects mismatched, incomplete or duplicate identities before storage changes', async () => {
  const { items } = await fixture();
  const storage = new MemoryVaultStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup('Synthetic project password', items); await service.upsertProvider(account);
  const rows = items.filter(row => row.passwordGroupId), versions = Object.fromEntries(rows.map(row => [row.id, row.updatedAt]));
  expect(rows).toHaveLength(3);
  const saved = await service.savePasswordGroup(rows.map(row => row.password === 'password-0' ? { ...row, username: 'edited', notes: '  shared\r\n' } : row), versions);
  expect(saved.filter(row => row.password !== 'password-2').map(row => row.username)).toEqual(['edited', 'edited']);
  expect((await service.readState()).mutationQueue).toHaveLength(3);
  const expected = Object.fromEntries(saved.map(row => [row.id, row.updatedAt])), envelope = JSON.stringify(storage.envelope);
  for (const invalid of [saved.slice(1), saved.map(row => ({ ...row, customFields: [] })),
    saved.map(row => ({ ...row, passwordGroupId: uuid(98) })),
    saved.map((row, n) => n === 1 ? { ...row, customFields: saved[0].customFields } : row)]) {
    await expect(service.savePasswordGroup(invalid, expected)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(envelope);
  }
  const independent = (await service.readState()).items.find(row => row.id === items.find(row => row.password === 'password-3')!.id);
  expect(independent).toEqual(items.find(row => row.password === 'password-3'));
});
it('preserves grouping and metadata after edit, export and a fresh provider connection', async () => {
  const { provider, items } = await fixture();
  const row = items.find(item => item.password === 'password-0')!;
  await provider.update(account, { ...row, notes: '  edited\r\n' });
  const exported = await provider.exportFile(account.id), fresh = new KeePassProvider();
  await fresh.unlock(account, exported, { password: master });
  const returned = (await fresh.sync(account, { now: '2026-10-06T00:00:00Z', localItems: [] })).items as LoginItem[];
  expect(groupedPasswords(returned)).toHaveLength(2);
  for (const original of items) {
    const actual = returned.find(item => item.keepassEntryUuid === original.keepassEntryUuid)!;
    expect(actual.customFields).toEqual(original.customFields); expect(actual.password).toBe(original.password);
  }
  expect(returned.find(item => item.keepassEntryUuid === row.keepassEntryUuid)!.notes).toBe('  edited\r\n');
});

it('adopts KDBX entry routing on create acknowledgement without overwriting an in-flight edit', async () => {
  const { provider } = await fixture();
  const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  await service.setup('Synthetic routing password'); await service.upsertProvider(account);
  const original = await service.upsertItem({ ...createLoginItem({ title: 'New credential', username: 'original', password: 'secret' }),
    providerRefs: [{ providerId: account.id }], keepassDatabaseId: 7 }) as LoginItem;
  const snapshot = (await service.readState()).items;
  const created = await provider.create(account, original) as LoginItem;
  await service.upsertItem({ ...original, username: 'edited while writing' });
  await service.applyProviderSync(account.id, [created], undefined, [], undefined, snapshot);
  const saved = (await service.readState()).items.find(row => row.id === original.id) as LoginItem;
  expect(saved.username).toBe('edited while writing'); expect(saved.password).toBe('secret');
  expect(saved.keepassEntryUuid).toBe(created.keepassEntryUuid); expect(saved.keepassEntryUuid).toBeTruthy();
  expect(saved.keepassGroupUuid).toBe(created.keepassGroupUuid);
  expect(saved.providerRefs[0].remoteId).toBe(created.keepassEntryUuid);
  expect((await service.readState()).mutationQueue[0].operation).toBe('update');
});

it('does not rewrite a freshly acknowledged password with an empty OTP on its next sync', async () => {
  const { provider } = await fixture();
  const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  await service.setup('Synthetic routing password'); await service.upsertProvider(account);
  const original = await service.upsertItem({ ...createLoginItem({ title: 'New credential', username: 'original', password: 'secret' }),
    loginType: 'PASSWORD', totpSecret: '', providerRefs: [{ providerId: account.id }], keepassDatabaseId: 7 }) as LoginItem;
  const snapshot = (await service.readState()).items;
  const created = await provider.create(account, original);
  await service.applyProviderSync(account.id, [created], undefined, [], undefined, snapshot);
  const write = vi.spyOn(writer, 'writeKeePassEntry');
  try {
    const result = await provider.sync(account, { now: '2026-10-06T00:00:00Z', localItems: (await service.readState()).items });
    expect(result.conflicts).toEqual([]); expect(write).not.toHaveBeenCalled();
  } finally { write.mockRestore(); }
});
