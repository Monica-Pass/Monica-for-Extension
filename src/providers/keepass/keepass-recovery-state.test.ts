import { expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../core/model';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { buildKeePassFixture } from './keepass-fixture';
import { KeePassProvider } from './keepass-provider';
import { KeePassDurableSyncCoordinator, KEEPASS_ITEM_SYNC_RECEIPT_ID } from './keepass-durable-sync';
import { KeePassRemoteSessionService, type KeePassRemoteFileClient } from './keepass-remote-session';
import { MemoryKeePassWorkingCopyStorage } from './keepass-working-copy-store';
import { createHash } from 'node:crypto';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { openKeePassVault } from './keepass-vault';
import { keePassFieldText } from './keepass-login-codec';

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const password = 'Synthetic KDBX recovery password';
async function fixture(count = 2, groupedTail = 0, nativeExtras = false, disabledBin = false) {
  let bytes = await buildKeePassFixture({ password, entries: Array.from({ length: count }, (_, n) => ({
    ...(nativeExtras ? { group: 'Original folder', binaries: { 'evidence.bin': Uint8Array.of(0, 255, 10, n) } } : {}),
    title: `Remote ${n}`, fields: { UserName: n < count - groupedTail ? `user-${n}` : 'shared' }, protectedFields: { Password: `secret-${n}`,
      ...(nativeExtras ? { FutureProtectedField: '  unknown\r\n保留  ' } : {}),
      ...(n < count - groupedTail ? {} : { [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({ version: 1,
        projectId: '00000000-0000-4000-8000-000000000001', groupId: '00000000-0000-4000-8000-000000000002',
        passwordId: `00000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}`, groupOrder: 0, passwordOrder: n, label: 'Primary', primary: true }) }) }
  })) });
  if (nativeExtras || disabledBin) {
    const source = await openKeePassVault(bytes, { password, providerId: 'fixture', databaseId: 1 });
    if (nativeExtras) source.database.header.versionMinor = 1; // Standard PreviousParentGroup was added in KDBX 4.1.
    if (disabledBin) { source.database.meta.recycleBinEnabled = false; source.database.meta.recycleBinUuid = undefined; }
    bytes = new Uint8Array(await source.database.save());
  }
  let revision = 1;
  const stat = () => ({ url: 'http://127.0.0.1:8787/recovery/vault.kdbx', fileName: 'vault.kdbx', etag: `"${revision}"`, sizeBytes: bytes.length });
  const client: KeePassRemoteFileClient = {
    async testConnection() {}, async stat() { return stat(); },
    async read() { return { ...stat(), bytes: bytes.slice(), sha256: await sha256Hex(bytes) }; },
    async write(next) { bytes = next.slice(); revision++; return { ...stat(), bytes: bytes.slice(), sha256: await sha256Hex(bytes), alreadyApplied: false }; }
  };
  const storage = new MemoryKeePassWorkingCopyStorage(), provider = new KeePassProvider();
  const sessions = new KeePassRemoteSessionService(provider, storage, () => client);
  let account: ProviderAccount = { id: 'recovery', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: { databaseId: 1 } };
  const opened = await sessions.open(account, { baseUrl: 'http://127.0.0.1:8787/recovery', username: 'synthetic', webDavPassword: 'synthetic', remotePath: 'vault.kdbx', databasePassword: password });
  account = { ...account, config: opened.accountConfig };
  const initial = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items.map((item, index) => ({ ...item, id: `local-stable-${index}` })) as LoginItem[];
  const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  await service.setup('Synthetic local recovery master', initial); await service.upsertProvider(account);
  const writeAccount = async (_account: ProviderAccount, config: Record<string, unknown>) => {
    account = { ...account, config }; await service.upsertProvider(account, false); return account;
  };
  const coordinator = new KeePassDurableSyncCoordinator(provider, sessions, service, writeAccount);
  const restart = async () => {
    provider.lock(); const fresh = new KeePassProvider(), remote = new KeePassRemoteSessionService(fresh, storage, () => client);
    const restored = await remote.restore(account); await writeAccount(account, restored.accountConfig);
    return { provider: fresh, sessions: remote, coordinator: new KeePassDurableSyncCoordinator(fresh, remote, service, writeAccount) };
  };
  return { service, initial, coordinator, provider, sessions, storage, client, restart, account: () => account, bytes: () => bytes.slice() };
}

it.each(['create', 'update'] as const)('retains post-crash %s edits and unrelated cached identities with the real encrypted service', async operation => {
  const f = await fixture();
  const item = operation === 'create' ? { ...createLoginItem({ title: 'Created', username: 'first', password: 'first-secret', providerRefs: [{ providerId: f.account().id }] }), loginType: 'PASSWORD' as const } : f.initial[0];
  const saved = await f.service.upsertItem({ ...item, username: 'committed-before-crash' }) as LoginItem;
  vi.spyOn(f.service, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic process loss after publish'));
  await expect(f.coordinator.synchronize(f.account())).rejects.toThrow('Synthetic process loss');
  expect(await f.sessions.readAnyDurableReceipt(f.account(), KEEPASS_ITEM_SYNC_RECEIPT_ID)).toBeTruthy();
  const changed = await f.service.upsertItem({ ...saved, password: 'new-after-crash', username: 'new-after-crash' }) as LoginItem;
  const restarted = await f.restart();
  await restarted.coordinator.synchronize(f.account());
  const state = await f.service.readState(), returned = state.items.find(row => row.id === saved.id) as LoginItem;
  expect(returned.password).toBe(changed.password); expect(returned.username).toBe(changed.username);
  expect(state.items.filter(row => row.id === f.initial[1].id)).toHaveLength(1);
  expect(state.items).toHaveLength(operation === 'create' ? 3 : 2);
  expect(state.providerConflicts).toEqual([]); expect(state.mutationQueue).toEqual([]);
  const reader = new KeePassProvider(); await reader.unlock(f.account(), f.bytes(), { password });
  const remote = (await reader.sync(f.account(), { now: new Date().toISOString(), localItems: [] })).items as LoginItem[];
  expect(remote.find(row => row.keepassEntryUuid === returned.keepassEntryUuid)?.password).toBe(changed.password);
});

it('does not revive a create deleted after publication but before local acknowledgement', async () => {
  const f = await fixture(0);
  const item = await f.service.upsertItem({ ...createLoginItem({ title: 'Created then deleted', password: 'secret', providerRefs: [{ providerId: f.account().id }] }), loginType: 'PASSWORD' });
  vi.spyOn(f.service, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic process loss'));
  await expect(f.coordinator.synchronize(f.account())).rejects.toThrow();
  await f.service.deleteItem(item.id);
  const restarted = await f.restart(); await restarted.coordinator.synchronize(f.account());
  expect((await f.service.readState()).items.filter(row => !row.deletedAt)).toHaveLength(0);
  const reader = new KeePassProvider(); await reader.unlock(f.account(), f.bytes(), { password });
  const remote = (await reader.sync(f.account(), { now: new Date().toISOString(), localItems: [] })).items;
  expect(remote).toHaveLength(1); expect(remote[0].deletedAt).toBeTruthy();
});

it('retains updates beyond the 100-item boundary until their own successful batch', async () => {
  const f = await fixture(101);
  for (const item of f.initial) await f.service.upsertItem({ ...item, password: `updated-${item.id}` });
  await f.coordinator.synchronize(f.account());
  const pending = (await f.service.readState()).mutationQueue;
  expect(pending).toHaveLength(1);
  expect(pending[0].operation).toBe('update');
  await f.coordinator.synchronize(f.account());
  expect((await f.service.readState()).mutationQueue).toEqual([]);
  const reader = new KeePassProvider(); await reader.unlock(f.account(), f.bytes(), { password });
  const remote = (await reader.sync(f.account(), { now: new Date().toISOString(), localItems: [] })).items as LoginItem[];
  expect(remote).toHaveLength(101); expect(remote.every(row => row.password.startsWith('updated-'))).toBe(true);
}, 30_000);

it('defers the complete three-password project beyond 98 independent updates', async () => {
  const f = await fixture(101, 3), group = f.initial.filter(row => row.passwordGroupId);
  for (const item of f.initial.filter(row => !row.passwordGroupId)) await f.service.upsertItem({ ...item, password: `updated-${item.id}` });
  await f.service.savePasswordGroup(group.map(row => ({ ...row, username: 'shared', password: `updated-${row.id}` })), Object.fromEntries(group.map(row => [row.id, row.updatedAt])));
  const result = await f.coordinator.synchronize(f.account()), state = await f.service.readState();
  expect(state.mutationQueue.map(row => row.itemId).sort()).toEqual(group.map(row => row.id).sort());
  expect(result.warnings.join(' ')).toContain('98');
  const read = async () => {
    const reader = new KeePassProvider(); await reader.unlock(f.account(), f.bytes(), { password });
    return (await reader.sync(f.account(), { now: new Date().toISOString(), localItems: [] })).items as LoginItem[];
  };
  const first = await read();
  expect(first.filter(row => !row.passwordGroupId).every(row => row.password.startsWith('updated-'))).toBe(true);
  for (const old of group) expect(first.find(row => row.keepassEntryUuid === old.keepassEntryUuid)?.password).toBe(old.password);
  await f.coordinator.synchronize(f.account());
  expect((await f.service.readState()).mutationQueue).toEqual([]);
  const final = await read(); expect(final).toHaveLength(101);
  expect(final.every(row => row.password.startsWith('updated-'))).toBe(true);
}, 30_000);

it('retains an oversized imported project without partially publishing it', async () => {
  const f = await fixture(101, 101);
  for (const item of f.initial) await f.service.upsertItem({ ...item, password: `updated-${item.id}` });
  const before = await f.service.readState(), bytes = f.bytes(), write = vi.spyOn(f.client, 'write');
  await expect(f.coordinator.synchronize(f.account())).rejects.toThrow(/100/);
  expect(write).not.toHaveBeenCalled(); expect(f.bytes()).toEqual(bytes);
  expect((await f.service.readState()).mutationQueue).toEqual(before.mutationQueue);
  expect((await f.service.readState()).items).toEqual(before.items);
}, 30_000);

it('keeps independent post-crash queued updates and creates outside the recovered receipt', async () => {
  const f = await fixture();
  await f.service.upsertItem({ ...f.initial[0], password: 'committed-first' });
  vi.spyOn(f.service, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic process loss'));
  await expect(f.coordinator.synchronize(f.account())).rejects.toThrow();
  await f.service.upsertItem({ ...f.initial[1], password: 'later-unrelated' });
  const created = await f.service.upsertItem(createLoginItem({ title: 'Later new', password: 'later-new', providerRefs: [{ providerId: f.account().id }] }));
  const restarted = await f.restart(); await restarted.coordinator.synchronize(f.account());
  const state = await f.service.readState();
  expect(state.items).toHaveLength(3); expect(state.providerConflicts).toEqual([]); expect(state.mutationQueue).toEqual([]);
  expect((state.items.find(row => row.id === f.initial[1].id) as LoginItem).password).toBe('later-unrelated');
  expect((state.items.find(row => row.id === created.id) as LoginItem).password).toBe('later-new');
});

it('preserves a create edited during publication and confirms only the older intent', async () => {
  const f = await fixture(0);
  const initial = await f.service.upsertItem(createLoginItem({ title: 'In flight', password: 'first', providerRefs: [{ providerId: f.account().id }] }));
  const write = f.client.write.bind(f.client);
  vi.spyOn(f.client, 'write').mockImplementationOnce(async (...args) => {
    const result = await write(...args);
    await f.service.upsertItem({ ...initial, password: 'second' } as LoginItem);
    return result;
  });
  await f.coordinator.synchronize(f.account());
  const state = await f.service.readState(), saved = state.items[0] as LoginItem;
  expect(saved.password).toBe('second'); expect(saved.keepassEntryUuid).toBeTruthy();
  expect(state.mutationQueue).toHaveLength(1); expect(state.mutationQueue[0].operation).toBe('update');
  await f.coordinator.synchronize(f.account());
  expect((await f.service.readState()).mutationQueue).toEqual([]);
});

it('replays an acknowledged receipt whose cleanup failed without issuing a duplicate remote write', async () => {
  const f = await fixture(); await f.service.upsertItem({ ...f.initial[0], password: 'committed' });
  vi.spyOn(f.sessions, 'deleteDurableReceipt').mockRejectedValueOnce(new Error('Receipt cleanup lost'));
  await expect(f.coordinator.synchronize(f.account())).rejects.toThrow('Receipt cleanup lost');
  const before = await f.service.readState(); expect(before.mutationQueue).toEqual([]);
  const writes = vi.spyOn(f.client, 'write'), restarted = await f.restart();
  await restarted.coordinator.synchronize(f.account());
  expect(writes).not.toHaveBeenCalled();
  const state = await f.service.readState(); expect(state.items.map(row => row.id)).toEqual(before.items.map(row => row.id));
  expect(state.providerConflicts).toEqual([]); expect(state.mutationQueue).toEqual([]);
});

it.each(['before-ack', 'after-ack'] as const)('restores a deleted entry after interrupted publication %s without losing its UUID', async interruption => {
  const f = await fixture(); await f.service.deleteItem(f.initial[0].id);
  if (interruption === 'before-ack') vi.spyOn(f.service, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic delete ACK loss'));
  else vi.spyOn(f.sessions, 'deleteDurableReceipt').mockRejectedValueOnce(new Error('Synthetic receipt cleanup loss'));
  await expect(f.coordinator.synchronize(f.account())).rejects.toThrow(/Synthetic/);
  await f.service.restoreItem(f.initial[0].id);
  const restarted = await f.restart(); await restarted.coordinator.synchronize(f.account());
  const state = await f.service.readState(), row = state.items.find(item => item.id === f.initial[0].id) as LoginItem;
  expect(row).toBeTruthy(); expect(row.deletedAt).toBeUndefined(); expect(row.password).toBe(f.initial[0].password);
  expect(state.providerConflicts).toEqual([]); expect(state.mutationQueue).toEqual([]);
  const reader = new KeePassProvider(); await reader.unlock(f.account(), f.bytes(), { password });
  const remote = (await reader.sync(f.account(), { now: new Date().toISOString(), localItems: [] })).items;
  expect(remote.filter(item => !item.deletedAt)).toHaveLength(2);
  expect(remote.find(item => item.keepassEntryUuid === f.initial[0].keepassEntryUuid)?.deletedAt).toBeUndefined();
});

it('retains native trash across repeated sync and restores the original folder, UUID, history and binary bytes', async () => {
  const f = await fixture(1, 0, true);
  await f.service.upsertItem({ ...f.initial[0], password: 'updated-before-delete' }); await f.coordinator.synchronize(f.account());
  const original = await openKeePassVault(f.bytes(), { password, providerId: f.account().id, databaseId: 1 });
  const originalEntry = original.entriesByUuid.get(f.initial[0].keepassEntryUuid!)!;
  expect(originalEntry.history).toHaveLength(1);
  await f.service.deleteItem(f.initial[0].id); await f.coordinator.synchronize(f.account());
  expect((await f.service.listDeletedItems()).map(row => row.id)).toEqual([f.initial[0].id]);
  expect((await f.service.readState()).mutationQueue).toEqual([]);
  const writes = vi.spyOn(f.client, 'write'); await f.coordinator.synchronize(f.account()); expect(writes).not.toHaveBeenCalled();
  const restarted = await f.restart(); await restarted.coordinator.synchronize(f.account());
  expect(writes).not.toHaveBeenCalled(); expect(await f.service.listDeletedItems()).toHaveLength(1);
  await f.service.restoreItem(f.initial[0].id); await restarted.coordinator.synchronize(f.account());
  const state = await f.service.readState(), row = state.items[0] as LoginItem;
  expect(state.mutationQueue).toEqual([]); expect(state.providerConflicts).toEqual([]); expect(row.deletedAt).toBeUndefined();
  expect(row.keepassEntryUuid).toBe(f.initial[0].keepassEntryUuid); expect(row.keepassGroupUuid).toBe(f.initial[0].keepassGroupUuid);
  expect(row.password).toBe('updated-before-delete');
  const after = await openKeePassVault(f.bytes(), { password, providerId: f.account().id, databaseId: 1 });
  const entry = after.entriesByUuid.get(row.keepassEntryUuid!)!;
  expect(entry.history).toHaveLength(originalEntry.history.length);
  expect(keePassFieldText(entry.fields.get('FutureProtectedField'))).toBe('  unknown\r\n保留  ');
  expect(entry.binaries.get('evidence.bin')).toEqual(originalEntry.binaries.get('evidence.bin'));
  const attachment = restarted.provider.listAttachments(f.account(), row)[0];
  expect(restarted.provider.readAttachment(f.account(), row, attachment.attachmentId, 0).bytes).toEqual(Uint8Array.of(0, 255, 10, 0));
});

it('retains edits made after restore, and a newer delete made while restoration is being published', async () => {
  const f = await fixture(1); await f.service.deleteItem(f.initial[0].id); await f.coordinator.synchronize(f.account());
  const restored = await f.service.restoreItem(f.initial[0].id) as LoginItem;
  await f.service.upsertItem({ ...restored, password: 'edited-after-restore' });
  expect((await f.service.readState()).mutationQueue[0].keepassRestore).toBe(true);
  const write = f.client.write.bind(f.client);
  vi.spyOn(f.client, 'write').mockImplementationOnce(async (...args) => {
    const result = await write(...args); await f.service.deleteItem(restored.id); return result;
  });
  await f.coordinator.synchronize(f.account());
  const pending = (await f.service.readState()).mutationQueue[0];
  expect(pending.operation).toBe('delete'); expect(pending.keepassRestore).toBeUndefined();
  await f.coordinator.synchronize(f.account());
  const state = await f.service.readState(); expect(state.mutationQueue).toEqual([]); expect(state.providerConflicts).toEqual([]);
  expect(state.items[0].deletedAt).toBeTruthy(); expect((state.items[0] as LoginItem).password).toBe('edited-after-restore');
  const native = await openKeePassVault(f.bytes(), { password, providerId: f.account().id, databaseId: 1 });
  expect(native.items).toHaveLength(1); expect(native.items[0].deletedAt).toBeTruthy();
});

it('refuses to overwrite changed native trash when an explicit restore is queued', async () => {
  const f = await fixture(1); await f.service.deleteItem(f.initial[0].id); await f.coordinator.synchronize(f.account());
  const trash = (await f.service.listDeletedItems())[0] as LoginItem;
  await f.provider.update(f.account(), { ...trash, password: 'changed-in-native-trash' });
  await f.sessions.persistWorkingCopy(f.account()); await f.sessions.publishWorkingCopy(f.account());
  await f.service.restoreItem(trash.id);
  await f.coordinator.synchronize(f.account());
  const state = await f.service.readState(); expect(state.providerConflicts).toHaveLength(1); expect(state.mutationQueue).toHaveLength(1);
  const native = await openKeePassVault(f.bytes(), { password, providerId: f.account().id, databaseId: 1 });
  expect(native.items[0].deletedAt).toBeTruthy(); expect((native.items[0] as LoginItem).password).toBe('changed-in-native-trash');
});

it('cancels an unsent delete without rewriting or duplicating the existing native entry', async () => {
  const f = await fixture(1); await f.service.deleteItem(f.initial[0].id); await f.service.restoreItem(f.initial[0].id);
  await f.coordinator.synchronize(f.account());
  const native = await openKeePassVault(f.bytes(), { password, providerId: f.account().id, databaseId: 1 });
  expect(native.items).toHaveLength(1); expect(native.items[0].keepassEntryUuid).toBe(f.initial[0].keepassEntryUuid);
  expect(native.entriesByUuid.get(f.initial[0].keepassEntryUuid!)!.history).toEqual([]);
  expect((await f.service.readState()).mutationQueue).toEqual([]);
  expect(await f.service.listDeletedItems()).toEqual([]);
});

it('restores a whole project after a lost delete receipt and restart with original native binaries', async () => {
  const f = await fixture(3, 3, true, true);
  await f.service.deletePasswordGroup(f.initial[0].id, Object.fromEntries(f.initial.map(row => [row.id, row.updatedAt])));
  vi.spyOn(f.service, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic lost delete ACK'));
  await expect(f.coordinator.synchronize(f.account())).rejects.toThrow('lost delete ACK');
  const deleted = await f.service.listDeletedItems();
  const request = { backend: 'keepass' as const, operationId: crypto.randomUUID(), anchorItemId: deleted[0].id, providerId: f.account().id,
    expected: Object.fromEntries(deleted.map(row => [row.id, row.updatedAt])), restoreIds: deleted.map(row => row.id) };
  await f.service.restoreKeePassPasswordProject(request);
  const restarted = await f.restart(); await restarted.coordinator.synchronize(f.account());
  const state = await f.service.readState();
  expect(state.mutationQueue).toEqual([]); expect(state.providerConflicts).toEqual([]);
  expect(await f.service.listDeletedItems()).toEqual([]);
  const native = await openKeePassVault(f.bytes(), { password, providerId: f.account().id, databaseId: 1 });
  expect(native.items).toHaveLength(3);
  for (const [index, row] of f.initial.entries()) {
    const after = native.items.find(item => item.keepassEntryUuid === row.keepassEntryUuid)!;
    expect(after.deletedAt).toBeUndefined(); expect(after.keepassGroupUuid).toBe(row.keepassGroupUuid);
    const entry = native.entriesByUuid.get(row.keepassEntryUuid!)!;
    expect(keePassFieldText(entry.fields.get('Password'))).toBe(row.password);
    expect(keePassFieldText(entry.fields.get('FutureProtectedField'))).toBe('  unknown\r\n保留  ');
    const attachment = restarted.provider.listAttachments(f.account(), after)[0];
    expect(restarted.provider.readAttachment(f.account(), after, attachment.attachmentId, 0).bytes).toEqual(Uint8Array.of(0, 255, 10, index));
  }
});

it('repairs disabled native recycle-bin metadata before deleting, as Android does', async () => {
  const f = await fixture(3, 3, true, true);
  await f.service.deletePasswordGroup(f.initial[0].id, Object.fromEntries(f.initial.map(row => [row.id, row.updatedAt])));
  await f.coordinator.synchronize(f.account());
  const deleted = await openKeePassVault(f.bytes(), { password, providerId: f.account().id, databaseId: 1 });
  expect(deleted.database.meta.recycleBinEnabled).toBe(true); expect(deleted.database.meta.recycleBinUuid).toBeTruthy();
  expect(deleted.items).toHaveLength(3); expect(deleted.items.every(row => row.deletedAt)).toBe(true);
  expect((await f.service.listDeletedItems()).map(row => row.id).sort()).toEqual(f.initial.map(row => row.id).sort());
  for (const row of f.initial) await f.service.restoreItem(row.id);
  await f.coordinator.synchronize(f.account());
  const restored = await openKeePassVault(f.bytes(), { password, providerId: f.account().id, databaseId: 1 });
  expect(restored.items).toHaveLength(3);
  for (const row of restored.items) { expect(row.deletedAt).toBeUndefined(); expect(row.keepassGroupUuid).toBe(f.initial[0].keepassGroupUuid); }
});
