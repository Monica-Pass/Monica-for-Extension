import { expect, it, vi } from 'vitest';
import { createLoginItem, type ProviderAccount } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

const master = 'Synthetic intent master';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const source: ProviderAccount = { id: 'kp', kind: 'keepass', enabled: true, name: 'Test', isDefaultSaveTarget: false,
    config: { databaseId: 7, sourceMode: 'webdav', remotePath: '/synthetic.kdbx', databasePassword: 'Synthetic file password' } };
  const rows = [0, 1].map(n => ({ ...createLoginItem({ title: 'Project', password: `synthetic-secret-${n}` }),
    keepassDatabaseId: 7, keepassEntryUuid: uuid(n + 10), passwordGroupId: uuid(1), providerRefs: [{ providerId: 'kp', remoteId: uuid(n + 10) }],
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId: uuid(1), groupId: uuid(2),
      passwordId: uuid(n + 10), label: 'Main', primary: true, groupOrder: 0, passwordOrder: n }) }] }));
  const storage = new MemoryVaultStorage();
  const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup(master, rows); await service.upsertProvider(source);
  const request = { operationId: uuid(90), source, draft: { providerId: source.id, anchorItemId: rows[0].id,
    originals: structuredClone(rows), items: structuredClone(rows), removedItemIds: [rows[0].id] } };
  request.draft.items[0].notes = 'Unsaved shared note';
  return { service, storage, request, rows, source };
}

it('persists the entire source and draft encrypted without changing originals or queuing independent deletions', async () => {
  const f = await fixture(), before = await f.service.readState(), write = vi.spyOn(f.storage, 'write');
  const intent = await f.service.stageKeePassProjectRemoval(f.request);
  expect(write).toHaveBeenCalledOnce();
  expect(intent.status).toBe('staged');
  expect(intent.draft).toEqual(f.request.draft);
  const state = await f.service.readState();
  expect(state.items).toEqual(before.items); expect(state.mutationQueue).toEqual(before.mutationQueue);
  const serialized = JSON.stringify(f.storage.envelope);
  for (const secret of ['synthetic-secret-0', 'Unsaved shared note', 'Synthetic file password']) expect(serialized).not.toContain(secret);
  const restarted = new SecureVaultService(f.storage, new MemoryVaultSessionStore());
  await restarted.unlock(master);
  expect(await restarted.readKeePassProjectRemovalIntents()).toEqual([intent]);
  write.mockClear();
  expect(await restarted.stageKeePassProjectRemoval(f.request)).toEqual(intent);
  expect(write).not.toHaveBeenCalled();
});

it('retains no intent or modified members when the encrypted write fails, then retries successfully', async () => {
  const f = await fixture(), before = JSON.stringify(f.storage.envelope);
  vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('synthetic disk failure'));
  await expect(f.service.stageKeePassProjectRemoval(f.request)).rejects.toThrow('synthetic disk failure');
  expect(JSON.stringify(f.storage.envelope)).toBe(before);
  const restarted = new SecureVaultService(f.storage, new MemoryVaultSessionStore()); await restarted.unlock(master);
  expect(await restarted.readKeePassProjectRemovalIntents()).toEqual([]);
  expect((await restarted.readState()).items).toEqual(f.rows);
  expect((await restarted.stageKeePassProjectRemoval(f.request)).status).toBe('staged');
});

it('recovers an encrypted commit whose acknowledgement was lost without writing a second intent', async () => {
  const f = await fixture(), persist = f.storage.write.bind(f.storage);
  vi.spyOn(f.storage, 'write').mockImplementationOnce(async envelope => {
    await persist(envelope);
    throw new Error('synthetic response loss after commit');
  });
  await expect(f.service.stageKeePassProjectRemoval(f.request)).rejects.toThrow('response loss');
  const envelope = JSON.stringify(f.storage.envelope);
  const restarted = new SecureVaultService(f.storage, new MemoryVaultSessionStore()); await restarted.unlock(master);
  const intents = await restarted.readKeePassProjectRemovalIntents();
  expect(intents).toHaveLength(1);
  expect(await restarted.stageKeePassProjectRemoval(f.request)).toEqual(intents[0]);
  expect(JSON.stringify(f.storage.envelope)).toBe(envelope);
  expect((await restarted.readState()).items).toEqual(f.rows);
});

it.each(['content', 'file', 'database', 'operation-reuse', 'overlap'] as const)('rejects %s mismatch without writing an intent', async mode => {
  const f = await fixture();
  if (mode === 'content') f.request.draft.originals[1].notes = 'stale baseline';
  if (mode === 'file') f.request.source = { ...f.source, config: { ...f.source.config, remotePath: '/other.kdbx' } };
  if (mode === 'database') f.request.source = { ...f.source, config: { ...f.source.config, databaseId: 8 } };
  if (mode === 'operation-reuse' || mode === 'overlap') {
    await f.service.stageKeePassProjectRemoval(f.request);
    if (mode === 'operation-reuse') f.request.draft.items[0].notes = 'different draft';
    else f.request.operationId = uuid(91);
  }
  const before = JSON.stringify(f.storage.envelope);
  await expect(f.service.stageKeePassProjectRemoval(f.request)).rejects.toThrow();
  expect(JSON.stringify(f.storage.envelope)).toBe(before);
});

it('cancels only the staged intent and preserves a terminal receipt across restart and response-loss retry', async () => {
  const f = await fixture(); await f.service.stageKeePassProjectRemoval(f.request);
  await f.service.cancelKeePassProjectRemovalIntent(f.request.operationId);
  const before = JSON.stringify(f.storage.envelope);
  const restarted = new SecureVaultService(f.storage, new MemoryVaultSessionStore()); await restarted.unlock(master);
  expect((await restarted.stageKeePassProjectRemoval(f.request)).status).toBe('cancelled');
  await restarted.cancelKeePassProjectRemovalIntent(f.request.operationId);
  expect(JSON.stringify(f.storage.envelope)).toBe(before);
  expect((await restarted.readState()).items).toEqual(f.rows);
});
