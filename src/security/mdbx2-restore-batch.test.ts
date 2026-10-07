import { expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../core/model';
import { mdbx2RestoreScope, type Mdbx2RestoreRecord } from '../core/mdbx2-restore-journal';
import { assertMdbx2RestoreBatchScope, mdbx2RestoreBatchScope, readMdbx2RestoreBatchJournal, type Mdbx2RestoreBatchRecord } from '../core/mdbx2-restore-batch-journal';
import { Mdbx2Provider, mdbx2ItemFingerprint } from '../providers/mdbx2/mdbx2-provider';
import { projectRestoreRequest } from '../manager/project-restore';
import type { Mdbx2NativeClient } from '../providers/mdbx2/native-client';
import type { Mdbx2ObjectsRestoreResult } from '../providers/mdbx2/native-contract';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import type { VaultEnvelope } from './vault-crypto';

class FailableStorage extends MemoryVaultStorage {
  failNext = false;
  override async write(envelope: VaultEnvelope) {
    if (this.failNext) { this.failNext = false; throw new Error('Synthetic batch persistence failure'); }
    return super.write(envelope);
  }
}
const password = 'Synthetic group restore vault password';
async function fixture() {
  const storage = new FailableStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const provider: ProviderAccount = { id: 'native', kind: 'mdbx2', name: 'Native', enabled: true, isDefaultSaveTarget: false,
    config: { vaultHandle: 'handle', nativeVaultId: 'vault' } };
  const sources = Array.from({ length: 3 }, (_, n) => ({ ...createLoginItem({ title: 'Synthetic private project', password: `private secret ${n}` }),
    passwordGroupId: 'group', deletedAt: '2026-10-01T00:00:00.000Z', notes: '  exact\r\nnotes  ',
    customFields: [{ name: 'protected', value: ' 9007199254740993\r\n0007 ', protected: true }],
    providerRefs: [{ providerId: provider.id, remoteId: `object-${n}`, remoteFolderId: 'folder', revision: 'deleted-commit' }] }));
  await service.setup(password, sources); await service.upsertProvider(provider);
  const members: Mdbx2RestoreRecord[] = [];
  for (const source of (await service.readState()).items) {
    const member: Mdbx2RestoreRecord = { version: 1, id: `member-${source.id}`, status: 'prepared', source, provider,
      intent: { operationScope: '', objectId: source.providerRefs[0].remoteId!, collectionId: 'folder', objectTypeId: 'login', expectedHeadCommitId: 'deleted-commit',
        writeRevision: { vaultId: 'vault', revisionSha256: 'a'.repeat(64) } } };
    member.intent.operationScope = await mdbx2RestoreScope(member); members.push(member);
  }
  const record: Mdbx2RestoreBatchRecord = { version: 1, id: 'batch-operation', status: 'prepared', members, operationScope: '' };
  record.operationScope = await mdbx2RestoreBatchScope(record);
  const receipt: Mdbx2ObjectsRestoreResult = { changed: true, operationId: 'native-operation', commitId: 'one-restored-commit', alreadyCommitted: false,
    items: members.map(({ intent }) => ({ kind: 'restore', changed: true, logicalObjectId: `native:${intent.objectId}`, objectId: intent.objectId,
      collectionId: intent.collectionId, objectTypeId: intent.objectTypeId })) };
  return { storage, service, record, receipt };
}

it('acknowledges all members together after encrypted save failure and restart', async () => {
  const { storage, service, record, receipt } = await fixture();
  await service.stageMdbx2RestoreBatch(record);
  expect(JSON.stringify(storage.envelope)).not.toContain('private secret');
  const before = await service.readState(), restore = vi.fn(async () => receipt);
  storage.failNext = true;
  await expect(service.applyMdbx2RestoreBatch(record.id, record.operationScope, restore)).rejects.toThrow('persistence');
  expect(await service.readState()).toEqual(before);
  const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore()); await restarted.unlock(password);
  expect(await restarted.readMdbx2RestoreBatches()).toEqual([record]);
  const restored = await restarted.applyMdbx2RestoreBatch(record.id, record.operationScope, restore);
  expect(restored).toHaveLength(3);
  restored.forEach((item, index) => {
    const source = record.members[index].source;
    expect({ ...item, updatedAt: source.updatedAt, providerRefs: source.providerRefs, deletedAt: source.deletedAt }).toEqual(source);
    expect(item.deletedAt).toBeUndefined(); expect(item.providerRefs[0].revision).toBe(receipt.commitId);
  });
  expect((await restarted.readState()).mutationQueue).toEqual([]);
  await restarted.applyMdbx2RestoreBatch(record.id, record.operationScope, restore);
  expect(restore).toHaveBeenCalledTimes(2);
});

it('preserves a newer explicit deletion of one member when settling the entire batch', async () => {
  const { service, storage, record, receipt } = await fixture();
  await service.stageMdbx2RestoreBatch(record);
  await service.upsertItem({ ...record.members[1].source, notes: 'later tombstone notes' });
  await service.deleteItem(record.members[1].source.id);
  const before = await service.readState(), local = before.items.find(row => row.id === record.members[1].source.id)!;
  storage.failNext = true;
  await expect(service.applyMdbx2RestoreBatch(record.id, record.operationScope, async () => receipt)).rejects.toThrow('persistence');
  const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore()); await restarted.unlock(password);
  const restored = await restarted.applyMdbx2RestoreBatch(record.id, record.operationScope, async () => ({ ...receipt, alreadyCommitted: true }));
  expect({ ...restored[1], providerRefs: local.providerRefs }).toEqual(local);
  expect(restored[0].deletedAt).toBeUndefined(); expect(restored[2].deletedAt).toBeUndefined();
  expect((await restarted.readState()).mutationQueue).toEqual(before.mutationQueue);
  expect(restored.every(row => row.providerRefs[0].revision === receipt.commitId)).toBe(true);
});

it.each(['provider', 'member-edit', 'new-member', 'missing-result', 'duplicate-result', 'partial-result'] as const)('keeps all originals when %s invalidates batch settlement', async scenario => {
  const { service, storage, record, receipt } = await fixture();
  await service.stageMdbx2RestoreBatch(record);
  if (scenario === 'provider') await service.upsertProvider({ ...record.members[0].provider, config: { vaultHandle: 'other' } });
  if (scenario === 'member-edit') await service.upsertItem({ ...record.members[1].source, notes: 'later edit' });
  if (scenario === 'new-member') await service.upsertItem({ ...record.members[0].source, id: crypto.randomUUID(), deletedAt: undefined,
    providerRefs: [{ providerId: record.members[0].provider.id }] });
  if (scenario === 'missing-result') receipt.items.pop();
  if (scenario === 'duplicate-result') receipt.items[1] = receipt.items[0];
  if (scenario === 'partial-result') (receipt as unknown as { changed: boolean }).changed = false;
  const before = await service.readState(), envelope = structuredClone(storage.envelope), restore = vi.fn(async () => receipt);
  await expect(service.applyMdbx2RestoreBatch(record.id, record.operationScope, restore)).rejects.toThrow();
  if (scenario === 'provider' || scenario === 'member-edit' || scenario === 'new-member') expect(restore).not.toHaveBeenCalled();
  expect(await service.readState()).toEqual(before); expect(storage.envelope).toEqual(envelope);
});

it('blocks single restores and ordinary sync before native dispatch while a batch remains prepared', async () => {
  const { service, record } = await fixture();
  await service.stageMdbx2RestoreBatch(record);
  await expect(service.stageMdbx2Restore(record.members[0])).rejects.toThrow('整组恢复');
  await expect(service.cancelPendingMdbx2Deletion(record.members[0].source, record.members[0].provider, async () => undefined)).rejects.toThrow('整组恢复');
  await expect(service.applyProviderSync(record.members[0].provider.id, [])).rejects.toThrow('恢复');
  const client = { vaultStatus: vi.fn() } as unknown as Mdbx2NativeClient;
  await expect(new Mdbx2Provider(client).sync(record.members[0].provider, { localItems: [], now: new Date().toISOString(),
    mdbx2RestoreBatches: [record] })).rejects.toThrow('整组恢复');
  expect(client.vaultStatus).not.toHaveBeenCalled();
});

it('refuses overlap, omitted cohort members and changed snapshots before staging', async () => {
  const { service, record } = await fixture();
  const omitted = { ...record, members: record.members.slice(0, 2) };
  omitted.operationScope = await mdbx2RestoreBatchScope(omitted);
  await expect(service.stageMdbx2RestoreBatch(omitted)).rejects.toThrow('成员已变化');
  await service.stageMdbx2Restore(record.members[0]);
  await expect(service.stageMdbx2RestoreBatch(record)).rejects.toThrow('单项恢复');
  expect(await service.readMdbx2RestoreBatches()).toEqual([]);
});

it('refreshes only the revision and retains the old request when saving the replacement fails', async () => {
  const { service, storage, record } = await fixture();
  storage.failNext = true;
  await expect(service.stageMdbx2RestoreBatch(record)).rejects.toThrow('persistence');
  expect(await service.readMdbx2RestoreBatches()).toEqual([]);
  await service.stageMdbx2RestoreBatch(record);
  const fresh = structuredClone(record);
  for (const member of fresh.members) {
    member.intent.writeRevision.revisionSha256 = 'b'.repeat(64); member.intent.operationScope = await mdbx2RestoreScope(member);
  }
  fresh.operationScope = await mdbx2RestoreBatchScope(fresh);
  storage.failNext = true;
  await expect(service.stageMdbx2RestoreBatch(fresh, record.operationScope)).rejects.toThrow('persistence');
  expect(await service.readMdbx2RestoreBatches()).toEqual([record]);
  await service.stageMdbx2RestoreBatch(fresh, record.operationScope);
  const changed = structuredClone(fresh); (changed.members[0].source as LoginItem).notes = 'tampered';
  changed.members[0].intent.operationScope = await mdbx2RestoreScope(changed.members[0]);
  changed.operationScope = await mdbx2RestoreBatchScope(changed);
  await expect(service.stageMdbx2RestoreBatch(changed, fresh.operationScope)).rejects.toThrow('已变化');
});

it('validates encrypted batch identity, source scope, member versions and complete receipts', async () => {
  const { record } = await fixture();
  expect(readMdbx2RestoreBatchJournal(undefined)).toEqual([]);
  for (const change of [() => ({ ...record, members: [] }), () => ({ ...record, members: [record.members[0], record.members[0]] }),
    () => ({ ...record, status: 'completed' }), () => ({ ...record, members: record.members.map((member, index) => index ? member
      : { ...member, source: { ...member.source, deletedAt: '2026-10-02T00:00:00.000Z' } }) })])
    expect(() => readMdbx2RestoreBatchJournal([change()])).toThrow();
  expect(() => readMdbx2RestoreBatchJournal([record, { ...record, id: 'other-batch' }])).toThrow();
  await expect(assertMdbx2RestoreBatchScope({ ...record, id: 'other-batch' })).rejects.toThrow();
});

async function mixedFixture(dirty = false) {
  const f = await fixture();
  const storage = new FailableStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const initial = f.record.members.map((member, index) => ({ ...member.source, deletedAt: undefined,
    providerRefs: [index === 2 ? { providerId: 'native' } : { ...member.source.providerRefs[0], etag: mdbx2ItemFingerprint(member.source) }] }));
  await service.setup(password, initial); await service.upsertProvider(f.record.members[0].provider);
  for (const [index, source] of initial.entries()) {
    await service.upsertItem({ ...source, ...(dirty && index < 2 ? { notes: `dirty rich notes ${index}\r\n0007` } : {}) });
  }
  const active = await service.listItems();
  await service.deletePasswordGroup(active[0].id, Object.fromEntries(active.map(row => [row.id, row.updatedAt])));
  const state = await service.readState(), sources = state.items as LoginItem[];
  const member = { ...f.record.members[0], source: sources[0] };
  member.intent.operationScope = await mdbx2RestoreScope(member);
  f.record.members = [member];
  f.record.request = projectRestoreRequest(sources, sources[1].id);
  f.record.id = f.record.request.operationId;
  f.record.cancellation = { sources, pendingDeletions: state.mutationQueue };
  f.record.operationScope = await mdbx2RestoreBatchScope(f.record);
  f.receipt.items = f.receipt.items.slice(0, 1);
  return { ...f, storage, service, sources };
}

it('atomically restores deleted, active and unpublished members after stage and acknowledgement failure', async () => {
  const { service, storage, record, receipt, sources } = await mixedFixture();
  const before = await service.readState(); storage.failNext = true;
  await expect(service.stageMdbx2RestoreBatch(record)).rejects.toThrow('persistence');
  expect(await service.readState()).toEqual(before);
  await service.stageMdbx2RestoreBatch(record);
  const staged = await service.readState();
  expect(staged.items).toEqual(before.items); expect(staged.mutationQueue).toEqual([]);
  storage.failNext = true;
  await expect(service.applyMdbx2RestoreBatch(record.id, record.operationScope, async () => receipt)).rejects.toThrow('persistence');
  expect(await service.readState()).toEqual(staged);
  const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore()); await restarted.unlock(password);
  const restored = await restarted.applyMdbx2RestoreBatch(record.id, record.operationScope, async () => receipt);
  expect(restored).toHaveLength(3); expect(restored.every(row => !row.deletedAt)).toBe(true);
  restored.forEach((row, index) => expect({ ...row, updatedAt: sources[index].updatedAt, deletedAt: sources[index].deletedAt,
    providerRefs: sources[index].providerRefs }).toEqual(sources[index]));
  expect(restored[0].providerRefs[0].revision).toBe(receipt.commitId);
  expect(restored.slice(1).map(row => row.providerRefs)).toEqual(sources.slice(1).map(row => row.providerRefs));
  expect((await restarted.readState()).mutationQueue).toMatchObject([{ itemId: sources[2].id, operation: 'create' }]);
  await restarted.deleteItem(sources[1].id); const later = await restarted.readState();
  await restarted.applyMdbx2RestoreBatch(record.id, record.operationScope, async () => { throw new Error('replay wrote'); });
  expect(await restarted.readState()).toEqual(later);
});

it.each([0, 1, 2])('retains a later deletion of mixed cohort member %s through recovery', async index => {
  const { service, record, receipt, sources } = await mixedFixture();
  await service.stageMdbx2RestoreBatch(record);
  await service.deleteItem(sources[index].id);
  const before = await service.readState();
  const restored = await service.applyMdbx2RestoreBatch(record.id, record.operationScope, async () => receipt);
  expect(restored[index].deletedAt).toBe(before.items[index].deletedAt);
  expect((await service.readState()).mutationQueue).toEqual(expect.arrayContaining(before.mutationQueue));
  expect(restored.filter(row => row.deletedAt)).toHaveLength(1);
});

it('retains dirty updates for both active and restored native members alongside unpublished creation', async () => {
  const { service, record, receipt, sources } = await mixedFixture(true);
  await service.stageMdbx2RestoreBatch(record);
  await service.applyMdbx2RestoreBatch(record.id, record.operationScope, async () => receipt);
  const state = await service.readState();
  expect(state.mutationQueue.map(row => [row.itemId, row.operation])).toEqual(sources.map((row, index) => [row.id, index === 2 ? 'create' : 'update']));
  expect(state.items.slice(0, 2).map(row => row.notes)).toEqual(sources.slice(0, 2).map(row => row.notes));
});

it.each(['changed-member', 'missing-delete', 'attempted-receipt', 'failed-attempt', 'overlap'] as const)('keeps mixed cohort and queue when %s prevents staging', async mode => {
  const { service, record, sources } = await mixedFixture();
  if (mode === 'changed-member') await service.upsertItem({ ...sources[1], notes: 'concurrent' });
  if (mode === 'missing-delete') {
    record.cancellation!.pendingDeletions = [];
    record.operationScope = await mdbx2RestoreBatchScope(record);
  }
  if (mode === 'attempted-receipt') {
    const mutation = record.cancellation!.pendingDeletions[0];
    await service.prepareProviderMutationReceipts([{ version: 1, providerId: mutation.providerId, mutationId: mutation.id, itemId: mutation.itemId,
      operation: 'delete', stage: 'prepared', intentFingerprint: 'a'.repeat(64), attemptCount: 0, createdAt: mutation.createdAt, updatedAt: mutation.createdAt }]);
    await service.markProviderMutationReceiptsAttempted(mutation.providerId, [mutation.id]);
  }
  if (mode === 'failed-attempt') {
    await service.markProviderSyncFailure('native', 'Synthetic uncertain deletion attempt');
    record.cancellation!.pendingDeletions = (await service.readState()).mutationQueue;
    record.operationScope = await mdbx2RestoreBatchScope(record);
  }
  if (mode === 'overlap') {
    await service.stageMdbx2RestoreBatch(record);
    const before = await service.readState();
    await expect(service.cancelPendingMdbx2Deletion(sources[1], record.members[0].provider, async () => undefined)).rejects.toThrow('整组恢复');
    expect(await service.readState()).toEqual(before); return;
  }
  const before = await service.readState();
  await expect(service.stageMdbx2RestoreBatch(record)).rejects.toThrow();
  expect(await service.readState()).toEqual(before);
});

it('validates and scopes the complete mixed cohort, not just the restored native subset', async () => {
  const { record } = await mixedFixture();
  const changed = structuredClone(record); changed.cancellation!.sources[1].notes = 'tampered';
  await expect(assertMdbx2RestoreBatchScope(changed)).rejects.toThrow();
  for (const change of [() => ({ ...record, cancellation: null }),
    () => ({ ...record, cancellation: { ...record.cancellation, sources: record.cancellation!.sources.map(source => ({ ...source, replicaGroupId: 'same-native-logical-id' })) } }),
    () => ({ ...record, cancellation: { ...record.cancellation, sources: record.cancellation!.sources.slice(1) } }),
    () => ({ ...record, cancellation: { ...record.cancellation, sources: [record.cancellation!.sources[0], record.cancellation!.sources[0]] } })])
    expect(() => readMdbx2RestoreBatchJournal([change()])).toThrow();
});
