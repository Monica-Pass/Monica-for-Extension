import { expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../core/model';
import { mdbx2ItemFingerprint } from '../providers/mdbx2/mdbx2-provider';
import { assertMdbx2RestoreScope, mdbx2RestoreScope, readMdbx2RestoreJournal, type Mdbx2RestoreRecord } from '../core/mdbx2-restore-journal';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import type { VaultEnvelope } from './vault-crypto';

class FailableStorage extends MemoryVaultStorage {
  failNext = false;
  override async write(envelope: VaultEnvelope) {
    if (this.failNext) { this.failNext = false; throw new Error('Synthetic restore persistence failure'); }
    return super.write(envelope);
  }
}
const password = 'Synthetic restore master password';
async function fixture() {
  const storage = new FailableStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const provider: ProviderAccount = { id: 'native', kind: 'mdbx2', name: 'Native', enabled: true, isDefaultSaveTarget: false,
    config: { vaultHandle: 'handle', nativeVaultId: 'vault' } };
  const source: LoginItem = { ...createLoginItem({ title: 'Synthetic private title', password: 'Synthetic private restore password' }),
    deletedAt: '2026-10-01T00:00:00.000Z', notes: '  exact\r\nnotes  ',
    providerRefs: [{ providerId: provider.id, remoteId: 'object', remoteFolderId: 'folder', revision: 'deleted-commit' }] };
  source.providerRefs[0].etag = mdbx2ItemFingerprint(source);
  await service.setup(password, [source]); await service.upsertProvider(provider);
  const record: Mdbx2RestoreRecord = { version: 1, id: 'operation', status: 'prepared', source: (await service.readState()).items[0], provider,
    intent: { operationScope: '', objectId: 'object', collectionId: 'folder', objectTypeId: 'login', expectedHeadCommitId: 'deleted-commit',
      writeRevision: { vaultId: 'vault', revisionSha256: 'a'.repeat(64) } } };
  record.intent.operationScope = await mdbx2RestoreScope(record);
  const receipt = { operationId: 'native-operation', commitId: 'restored-commit', alreadyCommitted: false,
    logicalObjectId: 'native:object', objectId: 'object', collectionId: 'folder', objectTypeId: 'login' };
  return { storage, service, record, receipt };
}

it('keeps the encrypted tombstone until a native receipt and local acknowledgement survive restart', async () => {
  const { storage, service, record, receipt } = await fixture();
  await service.stageMdbx2Restore(record);
  expect(JSON.stringify(storage.envelope)).not.toContain(record.source.title);
  expect(JSON.stringify(storage.envelope)).not.toContain('Synthetic private restore password');
  const restore = vi.fn(async () => receipt);
  storage.failNext = true;
  await expect(service.applyMdbx2Restore(record.id, record.intent.operationScope, restore)).rejects.toThrow('persistence');
  expect(restore).toHaveBeenCalledOnce();
  const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await restarted.unlock(password);
  expect(await restarted.readMdbx2Restores()).toEqual([record]);
  expect((await restarted.readState()).items[0]).toEqual(record.source);
  const restored = await restarted.applyMdbx2Restore(record.id, record.intent.operationScope, restore);
  expect({ ...restored, updatedAt: record.source.updatedAt, providerRefs: record.source.providerRefs, deletedAt: record.source.deletedAt }).toEqual(record.source);
  expect(restored.deletedAt).toBeUndefined();
  expect(restored.providerRefs[0].revision).toBe(receipt.commitId);
  expect((await restarted.readState()).mutationQueue).toEqual([]);
  await restarted.applyMdbx2Restore(record.id, record.intent.operationScope, restore);
  expect(restore).toHaveBeenCalledTimes(2);
});

it('retains the previous durable revision if preparing or replacing a request fails', async () => {
  const { service, storage, record, receipt } = await fixture();
  storage.failNext = true;
  await expect(service.stageMdbx2Restore(record)).rejects.toThrow('persistence');
  expect(await service.readMdbx2Restores()).toEqual([]);
  await service.stageMdbx2Restore(record);
  const replacement = structuredClone(record); replacement.intent.writeRevision.revisionSha256 = 'b'.repeat(64);
  replacement.intent.operationScope = await mdbx2RestoreScope(replacement);
  await expect(service.stageMdbx2Restore(replacement, 'wrong-scope')).rejects.toThrow('已变化');
  storage.failNext = true;
  await expect(service.stageMdbx2Restore(replacement, record.intent.operationScope)).rejects.toThrow('persistence');
  expect(await service.readMdbx2Restores()).toEqual([record]);
  await service.stageMdbx2Restore(replacement, record.intent.operationScope);
  const restore = vi.fn(async () => receipt);
  await expect(service.applyMdbx2Restore(record.id, record.intent.operationScope, restore)).rejects.toThrow('已变化');
  expect(restore).not.toHaveBeenCalled();
  expect(await service.readMdbx2Restores()).toEqual([replacement]);
});

it('settles an original restore while preserving a newer deletion through acknowledgement failure and restart', async () => {
  const { service, storage, record, receipt } = await fixture();
  await service.stageMdbx2Restore(record);
  await service.upsertItem({ ...record.source, notes: 'newest local tombstone content' });
  await service.deleteItem(record.source.id);
  const before = await service.readState(), local = before.items[0];
  const execute = vi.fn(async () => receipt);
  storage.failNext = true;
  await expect(service.applyMdbx2Restore(record.id, record.intent.operationScope, execute)).rejects.toThrow('persistence');
  expect(execute).toHaveBeenCalledOnce();
  expect(await service.readState()).toEqual(before);
  const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await restarted.unlock(password);
  const result = await restarted.applyMdbx2Restore(record.id, record.intent.operationScope, async saved => {
    expect(saved).toEqual(record);
    return { ...receipt, alreadyCommitted: true };
  });
  expect({ ...result, providerRefs: local.providerRefs }).toEqual(local);
  expect(result.providerRefs[0].revision).toBe(receipt.commitId);
  expect(result.deletedAt).toBe(local.deletedAt);
  expect((await restarted.readState()).mutationQueue).toEqual(before.mutationQueue);
  expect((await restarted.readMdbx2Restores())[0].status).toBe('completed');
  const settled = await restarted.readState();
  await restarted.applyMdbx2Restore(record.id, record.intent.operationScope, execute);
  expect(await restarted.readState()).toEqual(settled);
  expect(execute).toHaveBeenCalledOnce();
});

it('can persist a fresh revision for the original restore without dropping the later deletion', async () => {
  const { service, record } = await fixture();
  await service.stageMdbx2Restore(record);
  await service.deleteItem(record.source.id);
  const before = await service.readState();
  const replacement = structuredClone(record);
  replacement.intent.writeRevision.revisionSha256 = 'b'.repeat(64);
  replacement.intent.operationScope = await mdbx2RestoreScope(replacement);
  await service.stageMdbx2Restore(replacement, record.intent.operationScope);
  const after = await service.readState();
  expect(after.items).toEqual(before.items);
  expect(after.mutationQueue).toEqual(before.mutationQueue);
  expect(after.mdbx2Restores).toEqual([replacement]);
});

it.each(['provider', 'local-edit', 'sync', 'invalid-receipt'] as const)('retains newer state and pending restore after %s', async scenario => {
  const { service, storage, record, receipt } = await fixture();
  await service.stageMdbx2Restore(record);
  const restore = vi.fn(async () => receipt);
  if (scenario === 'provider') await service.upsertProvider({ ...record.provider, config: { vaultHandle: 'replacement', nativeVaultId: 'replacement' } });
  if (scenario === 'local-edit') await service.upsertItem({ ...record.source, notes: 'newer local value' });
  const before = storage.envelope;
  if (scenario === 'sync') await expect(service.applyProviderSync(record.provider.id, [])).rejects.toThrow('恢复');
  else if (scenario === 'invalid-receipt') await expect(service.applyMdbx2Restore(record.id, record.intent.operationScope,
    async () => ({ ...receipt, objectId: 'unrelated' }))).rejects.toThrow('无效');
  else await expect(service.applyMdbx2Restore(record.id, record.intent.operationScope, restore)).rejects.toThrow('已变化');
  expect(restore).not.toHaveBeenCalled();
  expect(storage.envelope).toEqual(before);
  expect(await service.readMdbx2Restores()).toEqual([record]);
});

it('rejects damaged journal identities, duplicate pending items and tampered scopes without discarding input', async () => {
  const { record } = await fixture();
  const original = structuredClone(record);
  expect(readMdbx2RestoreJournal(undefined)).toEqual([]);
  for (const changed of [{ ...record, version: 2 }, { ...record, status: 'completed' },
    { ...record, intent: { ...record.intent, objectId: 'wrong' } }]) expect(() => readMdbx2RestoreJournal([changed])).toThrow('无效');
  expect(() => readMdbx2RestoreJournal([record, { ...record, id: 'duplicate-item' }])).toThrow('无效');
  await expect(assertMdbx2RestoreScope({ ...record, id: 'tampered' })).rejects.toThrow('无效');
  expect(record).toEqual(original);
});

it('cancels an unsent deletion only after checking the native object, retaining the queue if saving fails', async () => {
  const { service, storage, record } = await fixture();
  await service.deleteItem(record.source.id);
  const source = (await service.listDeletedItems())[0];
  const verify = vi.fn(async () => undefined);
  storage.failNext = true;
  await expect(service.cancelPendingMdbx2Deletion(source, record.provider, verify)).rejects.toThrow('persistence');
  expect(verify).toHaveBeenCalledOnce();
  expect((await service.readState()).mutationQueue).toHaveLength(1);
  const restored = await service.cancelPendingMdbx2Deletion(source, record.provider, verify);
  expect(restored.deletedAt).toBeUndefined();
  expect(restored.providerRefs).toEqual(source.providerRefs);
  expect((await service.readState()).mutationQueue).toEqual([]);
  expect(await service.readMdbx2Restores()).toEqual([]);
});

it('keeps a pending deletion when the remote check fails or a newer local value exists', async () => {
  const { service, record } = await fixture();
  await service.deleteItem(record.source.id);
  const source = (await service.listDeletedItems())[0];
  await expect(service.cancelPendingMdbx2Deletion(source, record.provider, async () => { throw new Error('Native still unknown'); })).rejects.toThrow('unknown');
  expect((await service.listDeletedItems())[0]).toEqual(source);
  await service.upsertItem({ ...source, notes: 'Newer edit' });
  const verify = vi.fn(async () => undefined);
  await expect(service.cancelPendingMdbx2Deletion(source, record.provider, verify)).rejects.toThrow('尚未确认');
  expect(verify).not.toHaveBeenCalled();
});

async function queuedRestoreFixture() {
  const f = await fixture();
  await f.service.deleteItem(f.record.source.id);
  const state = await f.service.readState();
  f.record.source = state.items[0];
  f.record.supersededDeletion = state.mutationQueue[0];
  f.record.intent.operationScope = await mdbx2RestoreScope(f.record);
  return f;
}

it('replaces an exact queued deletion with a durable restore atomically and survives acknowledgement failure', async () => {
  const { service, storage, record, receipt } = await queuedRestoreFixture();
  const before = await service.readState();
  storage.failNext = true;
  await expect(service.stageMdbx2Restore(record)).rejects.toThrow('persistence');
  expect(await service.readState()).toEqual(before);
  await service.stageMdbx2Restore(record);
  expect((await service.readState()).mutationQueue).toEqual([]);
  expect((await service.readState()).items).toEqual(before.items);
  const staged = await service.readState();
  storage.failNext = true;
  await expect(service.applyMdbx2Restore(record.id, record.intent.operationScope, async () => receipt)).rejects.toThrow('persistence');
  expect(await service.readState()).toEqual(staged);
  const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await restarted.unlock(password);
  const restored = await restarted.applyMdbx2Restore(record.id, record.intent.operationScope, async () => receipt);
  expect(restored.deletedAt).toBeUndefined();
  expect(restored.providerRefs[0].revision).toBe(receipt.commitId);
  expect((await restarted.readState()).mutationQueue).toEqual([]);
  const current = await restarted.readState();
  const execute = vi.fn();
  await restarted.applyMdbx2Restore(record.id, record.intent.operationScope, execute);
  expect(execute).not.toHaveBeenCalled(); expect(await restarted.readState()).toEqual(current);
});

it('preserves a still newer deletion after superseding an earlier queued deletion', async () => {
  const { service, record, receipt } = await queuedRestoreFixture();
  await service.stageMdbx2Restore(record);
  await service.deleteItem(record.source.id);
  const before = await service.readState();
  expect(before.mutationQueue[0].id).not.toBe(record.supersededDeletion!.id);
  const restored = await service.applyMdbx2Restore(record.id, record.intent.operationScope, async () => receipt);
  expect(restored.deletedAt).toBe(before.items[0].deletedAt);
  expect((await service.readState()).mutationQueue).toEqual(before.mutationQueue);
});

it.each(['edited', 'queue', 'attempted', 'orphan-receipt'] as const)('refuses unsafe supersession without consuming the delete: %s', async mode => {
  const { service, record, storage } = await queuedRestoreFixture();
  const mutation = record.supersededDeletion!;
  if (mode === 'edited') await service.upsertItem({ ...record.source, notes: 'concurrent changed content' });
  if (mode === 'queue') { record.supersededDeletion = { ...mutation, id: 'wrong' }; record.intent.operationScope = await mdbx2RestoreScope(record); }
  if (mode === 'attempted' || mode === 'orphan-receipt') {
    const mutationId = mode === 'orphan-receipt' ? 'old-mutation' : mutation.id;
    await service.prepareProviderMutationReceipts([{ version: 1, providerId: record.provider.id, mutationId, itemId: record.source.id,
      operation: 'delete', stage: 'prepared', intentFingerprint: 'a'.repeat(64), attemptCount: 0,
      createdAt: mutation.createdAt, updatedAt: mutation.createdAt }]);
    if (mode === 'attempted') await service.markProviderMutationReceiptsAttempted(record.provider.id, [mutation.id]);
  }
  const before = storage.envelope;
  await expect(service.stageMdbx2Restore(record)).rejects.toThrow('尚未确认');
  expect(storage.envelope).toEqual(before); expect(await service.readMdbx2Restores()).toEqual([]);
});

it('binds superseded deletion identity to the durable scope and rejects malformed snapshots', async () => {
  const { service, record } = await queuedRestoreFixture();
  const changed = structuredClone(record); changed.supersededDeletion!.id = 'different';
  await expect(assertMdbx2RestoreScope(changed)).rejects.toThrow('无效');
  for (const mutation of [{ ...record.supersededDeletion, operation: 'update' }, { ...record.supersededDeletion, itemId: 'other' },
    { ...record.supersededDeletion, createdAt: 'invalid' }]) expect(() => readMdbx2RestoreJournal([{ ...record, supersededDeletion: mutation }])).toThrow('无效');
  await service.stageMdbx2Restore(record);
  changed.intent.writeRevision.revisionSha256 = 'b'.repeat(64);
  changed.intent.operationScope = await mdbx2RestoreScope(changed);
  await expect(service.stageMdbx2Restore(changed, record.intent.operationScope)).rejects.toThrow('已变化');
});

it('consumes only the matching prepared receipt with the superseded deletion', async () => {
  const { service, record } = await queuedRestoreFixture();
  const mutation = record.supersededDeletion!;
  await service.prepareProviderMutationReceipts([{ version: 1, providerId: record.provider.id, mutationId: mutation.id, itemId: mutation.itemId,
    operation: 'delete', stage: 'prepared', intentFingerprint: 'a'.repeat(64), attemptCount: 0,
    createdAt: mutation.createdAt, updatedAt: mutation.createdAt }]);
  await service.stageMdbx2Restore(record);
  const state = await service.readState();
  expect(state.mutationQueue).toEqual([]); expect(state.providerMutationReceipts).toEqual([]);
  expect(state.mdbx2Restores?.[0].supersededDeletion).toEqual(mutation);
});

it.each(['active-native', 'deleted-native'] as const)('retains dirty rich fields and queues an update after undo: %s', async mode => {
  const { service, record, receipt } = await fixture();
  const edited = await service.upsertItem({ ...record.source, notes: '  dirty notes\r\n0007 ',
    ...(record.source.kind === 'login' ? { customFields: [{ name: 'protected', value: '9007199254740993', protected: true }] } : {}) });
  await service.deleteItem(edited.id);
  const state = await service.readState(), source = state.items[0];
  if (mode === 'active-native') await service.cancelPendingMdbx2Deletion(source, record.provider, async () => undefined);
  else {
    record.source = source; record.supersededDeletion = state.mutationQueue[0];
    record.intent.operationScope = await mdbx2RestoreScope(record);
    await service.stageMdbx2Restore(record);
    await service.applyMdbx2Restore(record.id, record.intent.operationScope, async () => receipt);
  }
  const restored = await service.readState();
  expect(restored.items[0].notes).toBe(edited.notes);
  expect(restored.items[0].deletedAt).toBeUndefined();
  expect(restored.mutationQueue).toMatchObject([{ itemId: edited.id, operation: 'update' }]);
});
