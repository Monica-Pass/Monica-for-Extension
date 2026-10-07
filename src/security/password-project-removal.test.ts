import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderKind } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { readPasswordProjectRemovalJournal, retainPasswordProjectRemovalHistory, type PasswordProjectRemovalRecord } from '../core/password-project-removal-journal';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { MonicaWebDavProvider } from '../providers/webdav/monica-webdav-provider';
import { BitwardenProvider } from '../providers/bitwarden/bitwarden-provider';
import { Mdbx2Provider } from '../providers/mdbx2/mdbx2-provider';
import { assertPasswordProjectRemovalSyncSafe } from '../core/password-project-removal-sync';
import { BitwardenDurableSyncCoordinator } from '../providers/bitwarden/bitwarden-durable-sync';
import { passwordProjectNativeDeletionScope } from '../core/password-project-removal-native';
import type { PasswordProjectNativeDeletionIntent } from '../core/password-project-removal-journal';
import { mdbx2RestoreScope, readMdbx2RestoreJournal, type Mdbx2RestoreRecord } from '../core/mdbx2-restore-journal';

const secret = 'synthetic project removal master password';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture(kind: ProviderKind = 'local', count = 3) {
  const storage = new MemoryVaultStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const rows: LoginItem[] = Array.from({ length: count }, (_, index) => ({ ...createLoginItem({ title: 'Project', username: 'shared', password: `secret-${index}` }),
    passwordGroupId: uuid(99), notes: '  original\r\nnotes  ',
    providerRefs: kind === 'local' ? [] : [{ providerId: kind, remoteId: `remote-${index}`, remoteFolderId: 'synthetic-folder', revision: 'old-revision' }],
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true,
      value: JSON.stringify({ version: 1, projectId: uuid(99), groupId: uuid(1), passwordId: uuid(index + 10),
        primary: true, label: 'Primary', groupOrder: 0, passwordOrder: index }).replace(/}$/, ',"future":9007199254740993}') }]
  }));
  rows[0].customFields.push({ name: 'Shared document', value: '  content\r\n0007  ', protected: true });
  rows[0].imagePaths = ['shared-file'];
  await service.setup(secret, rows);
  if (kind !== 'local') await service.upsertProvider({ id: kind, kind, name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: { baseUrl: 'https://synthetic.invalid', vaultHandle: 'synthetic-vault' } });
  const originals = (await service.listItems()) as LoginItem[];
  const input = { operationId: crypto.randomUUID(), items: originals.map((item, index) => index === 0 ? { ...item, notes: 'Edited shared notes' } : item),
    expected: Object.fromEntries(originals.map(item => [item.id, item.updatedAt])), removedItemIds: [originals[0].id] };
  return { service, storage, rows: originals, input };
}
async function acknowledge(service: SecureVaultService, providerId: string) {
  const state = await service.readState();
  const revision = new Date(Date.now() + 1000).toISOString();
  const acknowledged = state.items.map(item => ({ ...item, updatedAt: revision,
    providerRefs: item.providerRefs.map(ref => ref.providerId === providerId ? { ...ref, revision } : ref) }));
  await service.applyProviderSync(providerId, acknowledged, undefined, [], [], state.items);
  return (await service.readState()).items as LoginItem[];
}
const emptyProof = (record: PasswordProjectRemovalRecord) => record.ownerTransfer ? record.providerBindings.filter(provider => provider.kind !== 'local').map(provider => ({
  providerId: provider.id, ...record.ownerTransfer!, attachments: []
})) : [];

describe('durable password project removal transaction', () => {
  it.each([false, true])('cancels preparation after provider acknowledgement %s while keeping the edited full project and later password', async synced => {
    const { service, storage, rows, input } = await fixture('mdbx2');
    const record = (await service.stagePasswordProjectRemoval(input)).removal!;
    expect(record.cancellationItems).toHaveLength(3);
    if (synced) await acknowledge(service, 'mdbx2');
    const latest = await service.getItem(rows[1].id) as LoginItem;
    await service.upsertItem({ ...latest, password: 'latest independent password edit' }, undefined, latest.updatedAt);
    const before = await service.readState();
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic cancellation save failure'));
    await expect(service.cancelPasswordProjectRemovalPreparation(record.id)).rejects.toThrow('cancellation save failure');
    expect(await service.readState()).toEqual(before);
    const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore()); await restarted.unlock(secret);
    expect((await restarted.cancelPasswordProjectRemovalPreparation(record.id)).status).toBe('cancelled');
    const cancelled = await restarted.readState();
    expect(cancelled.items).toHaveLength(3); expect(cancelled.items.some(row => row.deletedAt)).toBe(false);
    for (const item of cancelled.items as LoginItem[]) {
      const draft = record.cancellationItems!.find(row => row.id === item.id)!;
      expect(item.customFields).toEqual(draft.customFields); expect(item.imagePaths).toEqual(draft.imagePaths);
      expect(item.notes).toBe('Edited shared notes');
      expect(item.password).toBe(item.id === latest.id ? 'latest independent password edit' : draft.password);
      expect(item.providerRefs).toEqual(before.items.find(row => row.id === item.id)!.providerRefs);
    }
    expect(cancelled.mutationQueue).toHaveLength(3); expect(cancelled.mutationQueue.every(row => row.operation === 'update')).toBe(true);
    expect(() => assertPasswordProjectRemovalSyncSafe(record.providerBindings[0], { localItems: cancelled.items,
      pendingMutations: cancelled.mutationQueue, passwordProjectRemovals: cancelled.passwordProjectRemovals, now: cancelled.updatedAt })).not.toThrow();
    await restarted.cancelPasswordProjectRemovalPreparation(record.id);
    expect(await restarted.readState()).toEqual(cancelled);
    expect((await restarted.stagePasswordProjectRemoval(input)).removal?.status).toBe('cancelled');
    expect(await restarted.listDeletedItems()).toEqual([]);
    // New explicit work can proceed; the cancelled operation ID stays a no-op.
    const items = cancelled.items as LoginItem[];
    await expect(restarted.stagePasswordProjectRemoval({ operationId: crypto.randomUUID(), items,
      expected: Object.fromEntries(items.map(row => [row.id, row.updatedAt])), removedItemIds: [rows[0].id] })).resolves.toMatchObject({ removal: { status: 'preparing' } });
  });

  it.each(['colliding-content', 'shared-newer-edit', 'deleted', 'new-member', 'provider', 'deleting'] as const)('keeps data and journal when cancellation encounters %s', async scenario => {
    const { service, storage, rows, input } = await fixture('mdbx2');
    const record = (await service.stagePasswordProjectRemoval(input)).removal!;
    const target = await service.getItem(rows[1].id) as LoginItem;
    if (scenario === 'colliding-content') await service.upsertItem({ ...target, customFields: [...target.customFields,
      { name: 'new protected field', value: '  never lose this ', protected: true }] });
    if (scenario === 'shared-newer-edit') await service.upsertItem({ ...target, notes: 'newer notes must not be overwritten by shared draft' });
    if (scenario === 'deleted') await service.deleteItem(target.id);
    if (scenario === 'new-member') await service.upsertItem({ ...target, id: crypto.randomUUID(), providerRefs: [{ providerId: 'mdbx2' }],
      customFields: target.customFields.map(field => field.name === PROJECT_CREDENTIAL_FIELD
        ? { ...field, value: field.value.replace(uuid(11), uuid(44)) } : field) });
    if (scenario === 'provider') await service.upsertProvider({ ...record.providerBindings[0], config: { vaultHandle: 'replacement' } });
    if (scenario === 'deleting') {
      const observed = await acknowledge(service, 'mdbx2');
      await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record));
    }
    const before = storage.envelope;
    await expect(service.cancelPasswordProjectRemovalPreparation(record.id)).rejects.toThrow();
    expect(storage.envelope).toEqual(before);
  });

  it('commits local retained content and the removed original in exactly one encrypted write, then reopens', async () => {
    const { service, storage, rows, input } = await fixture(); const write = vi.spyOn(storage, 'write');
    const result = await service.stagePasswordProjectRemoval(input);
    expect(write).toHaveBeenCalledTimes(1); expect(result.removal?.status).toBe('completed');
    expect(result.items.map(item => item.password)).toEqual(['secret-1', 'secret-2']);
    expect(result.items.every(item => item.notes === 'Edited shared notes')).toBe(true);
    expect(result.items[0]).toMatchObject({ id: rows[1].id, imagePaths: ['shared-file'] });
    expect(result.items[0].customFields).toContainEqual(rows[0].customFields[1]);
    const deleted = (await service.listDeletedItems())[0];
    expect({ ...deleted, deletedAt: undefined, updatedAt: rows[0].updatedAt }).toEqual({ ...rows[0], deletedAt: undefined });
    await service.lock();
    const fresh = new SecureVaultService(storage, new MemoryVaultSessionStore()); await fresh.unlock(secret);
    expect(await fresh.readPasswordProjectRemovals()).toEqual([result.removal]);
    expect((await fresh.listItems()).map(item => item.id).sort()).toEqual(rows.slice(1).map(item => item.id).sort());
  });

  it.each(['mdbx2', 'monica-webdav', 'bitwarden'] as const)('keeps %s originals live until retained writes and attachment verification complete', async kind => {
    const { service, storage, rows, input } = await fixture(kind);
    const staged = await service.stagePasswordProjectRemoval(input); const record = staged.removal!;
    expect(record.status).toBe('preparing'); expect(await service.listDeletedItems()).toEqual([]);
    expect(await service.getItem(rows[0].id)).toEqual(rows[0]);
    expect((await service.readState()).mutationQueue.map(mutation => mutation.operation)).toEqual(['update', 'update']);
    await expect(service.inspectPasswordProjectRemoval(record.id)).rejects.toThrow('尚未完成同步');
    await expect(service.finalizePasswordProjectRemoval(record.id, (await service.listItems()) as LoginItem[], emptyProof(record))).rejects.toThrow('尚未完成同步');
    let observed = await acknowledge(service, kind);
    expect((await service.readState()).mutationQueue).toEqual([]);
    await service.lock(); const fresh = new SecureVaultService(storage, new MemoryVaultSessionStore()); await fresh.unlock(secret);
    expect((await fresh.readPasswordProjectRemovals())[0].status).toBe('preparing');
    observed = (await fresh.readState()).items as LoginItem[];
    expect((await fresh.inspectPasswordProjectRemoval(record.id)).items).toHaveLength(3);
    await expect(fresh.finalizePasswordProjectRemoval(record.id, observed, [])).rejects.toThrow('恢复记录无效');
    expect(await fresh.listDeletedItems()).toEqual([]);
    const deleting = await fresh.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record));
    expect(deleting.status).toBe('deleting'); expect((await fresh.listDeletedItems()).map(item => item.id)).toEqual([rows[0].id]);
    expect((await fresh.readState()).mutationQueue).toEqual([expect.objectContaining({ itemId: rows[0].id, operation: 'delete' })]);
    const state = await fresh.readState(), account = (await fresh.getProvider(kind))!;
    const fetcher = vi.fn<typeof fetch>();
    const adapter = kind === 'monica-webdav' ? new MonicaWebDavProvider(fetcher) : kind === 'bitwarden' ? new BitwardenProvider(fetcher)
      : new Mdbx2Provider({} as ConstructorParameters<typeof Mdbx2Provider>[0]);
    await expect(adapter.sync(account, { now: new Date().toISOString(), localItems: state.items, pendingMutations: state.mutationQueue,
      passwordProjectRemovals: state.passwordProjectRemovals })).rejects.toThrow('普通同步不能执行');
    expect(fetcher).not.toHaveBeenCalled();
    if (kind === 'bitwarden') {
      const before = JSON.stringify(storage.envelope);
      await expect(new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), fresh).synchronize(account)).rejects.toThrow('普通同步不能执行');
      expect(JSON.stringify(storage.envelope)).toBe(before); expect(fetcher).not.toHaveBeenCalled();
    }
    await expect(fresh.completePasswordProjectRemoval(record.id)).rejects.toThrow('尚未完成远端移除');
    const beforeReplay = JSON.stringify(storage.envelope);
    expect(await fresh.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record))).toEqual(deleting);
    expect(JSON.stringify(storage.envelope)).toBe(beforeReplay);
    await acknowledge(fresh, kind);
    expect((await fresh.completePasswordProjectRemoval(record.id)).status).toBe('completed');
    expect((await fresh.listItems()).map(item => item.id).sort()).toEqual(rows.slice(1).map(item => item.id).sort());
  });

  it('replays the same operation without changing storage and refuses identifier reuse or overlapping drafts', async () => {
    const { service, storage, input } = await fixture('mdbx2');
    const first = await service.stagePasswordProjectRemoval(input), before = JSON.stringify(storage.envelope);
    expect(await service.stagePasswordProjectRemoval(input)).toEqual(first); expect(JSON.stringify(storage.envelope)).toBe(before);
    await expect(service.stagePasswordProjectRemoval({ ...input, removedItemIds: [input.items[1].id] })).rejects.toThrow('标识已用于');
    const current = (await service.listItems()) as LoginItem[];
    await expect(service.stagePasswordProjectRemoval({ ...input, operationId: crypto.randomUUID(), items: current,
      expected: Object.fromEntries(current.map(item => [item.id, item.updatedAt])) })).rejects.toThrow('待完成的移除操作');
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it.each(['stage', 'finalize'] as const)('retains encrypted data, queue and journal on %s persistence failure', async phase => {
    const { service, storage, input } = await fixture('mdbx2');
    const record = phase === 'finalize' ? (await service.stagePasswordProjectRemoval(input)).removal! : undefined;
    const observed = record ? await acknowledge(service, 'mdbx2') : [];
    const before = await service.readState(), envelope = JSON.stringify(storage.envelope);
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('synthetic persistence failure'));
    await expect(record ? service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record)) : service.stagePasswordProjectRemoval(input)).rejects.toThrow('synthetic persistence failure');
    expect(await service.readState()).toEqual(before); expect(JSON.stringify(storage.envelope)).toBe(envelope);
  });

  it.each(['edited-source', 'edited-target', 'new-member', 'replaced-provider', 'incomplete-proof-snapshot'] as const)('rejects %s without producing deletion markers', async scenario => {
    const { service, storage, input, rows } = await fixture('mdbx2');
    const record = (await service.stagePasswordProjectRemoval(input)).removal!;
    let observed = await acknowledge(service, 'mdbx2');
    if (scenario === 'edited-source' || scenario === 'edited-target') {
      const item = observed.find(item => item.id === rows[scenario === 'edited-source' ? 0 : 1].id)!;
      await service.upsertItem({ ...item, password: 'concurrent secret' }, undefined, item.updatedAt);
    }
    if (scenario === 'new-member') await service.upsertItem({ ...rows[2], id: crypto.randomUUID(), providerRefs: [{ providerId: 'mdbx2' }] });
    if (scenario === 'replaced-provider') {
      const provider = (await service.getProvider('mdbx2'))!;
      await service.upsertProvider({ ...provider, config: { ...provider.config, vaultHandle: 'other-vault' } });
    }
    if (scenario === 'incomplete-proof-snapshot') observed = observed.slice(1);
    else await expect(service.inspectPasswordProjectRemoval(record.id)).rejects.toThrow();
    const before = await service.readState(), envelope = JSON.stringify(storage.envelope);
    await expect(service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record))).rejects.toThrow();
    expect(await service.readState()).toEqual(before); expect(JSON.stringify(storage.envelope)).toBe(envelope);
    expect(await service.listDeletedItems()).toEqual([]);
  });

  it('discards an unsaved added password without creating a tombstone or recovery entry', async () => {
    const { service, input, rows } = await fixture();
    const added = { ...rows[2], id: crypto.randomUUID(), customFields: rows[2].customFields.map(field => ({ ...field,
      value: field.value.replace(uuid(12), uuid(13)).replace('"passwordOrder":2', '"passwordOrder":3') })) };
    const result = await service.stagePasswordProjectRemoval({ ...input, items: [...rows, added], removedItemIds: [added.id] });
    expect(result.removal).toBeUndefined(); expect(result.items).toHaveLength(3);
    expect(await service.getItem(added.id)).toBeUndefined(); expect(await service.listDeletedItems()).toEqual([]);
    expect(await service.readPasswordProjectRemovals()).toEqual([]);
  });

  it('rejects future and damaged recovery data rather than dropping it', async () => {
    const { service, input } = await fixture('mdbx2');
    const record = (await service.stagePasswordProjectRemoval(input)).removal!;
    for (const invalid of [{ ...record, version: 2 }, { ...record, providerBindings: [] }, { ...record, status: 'deleting' },
      { ...record, ownerTransfer: { sourceItemId: record.retained[0].id, targetItemId: record.removed[0].id } }])
      expect(() => readPasswordProjectRemovalJournal([invalid])).toThrow('恢复记录无效');
  });

  it('blocks an independent deletion of a preparing member while allowing retained writes and other providers', async () => {
    const { service, input } = await fixture('monica-webdav');
    const record = (await service.stagePasswordProjectRemoval(input)).removal!;
    const state = await service.readState(), account = (await service.getProvider('monica-webdav'))!;
    const context = { now: state.updatedAt, localItems: state.items, pendingMutations: state.mutationQueue, passwordProjectRemovals: [record] };
    expect(() => assertPasswordProjectRemovalSyncSafe(account, context)).not.toThrow();
    context.localItems = context.localItems.map(item => item.id === record.removed[0].id ? { ...item, deletedAt: state.updatedAt } : item);
    expect(() => assertPasswordProjectRemovalSyncSafe(account, context)).toThrow('尚未完成附件校验');
    expect(() => assertPasswordProjectRemovalSyncSafe({ ...account, id: 'other' }, context)).not.toThrow();
  });

  it('rejects duplicate provider references, credential identities and future credential metadata in recovery state', async () => {
    const { service, input } = await fixture('mdbx2');
    const record = (await service.stagePasswordProjectRemoval(input)).removal!;
    const base = structuredClone(record);
    base.providerBindings.push({ ...base.providerBindings[0], id: 'second-provider' });
    for (const row of [...base.retained, ...base.removed, ...base.cancellationItems!]) row.providerRefs.push({ providerId: 'second-provider', remoteId: row.id });
    expect(readPasswordProjectRemovalJournal([base])).toEqual([base]);
    const duplicateRefs = structuredClone(base);
    duplicateRefs.removed[0].providerRefs[1] = { ...duplicateRefs.removed[0].providerRefs[0] };
    expect(() => readPasswordProjectRemovalJournal([duplicateRefs])).toThrow('恢复记录无效');
    const duplicatePassword = structuredClone(record);
    duplicatePassword.removed[0].customFields[0] = duplicatePassword.retained[0].customFields[0];
    expect(() => readPasswordProjectRemovalJournal([duplicatePassword])).toThrow('恢复记录无效');
    const future = structuredClone(record);
    future.retained[0].customFields[0].value = future.retained[0].customFields[0].value.replace('"version":1', '"version":2');
    expect(() => readPasswordProjectRemovalJournal([future])).toThrow('恢复记录无效');
  });
});

async function nativeIntent(record: PasswordProjectRemovalRecord, observed = [...record.retained, ...record.removed], revision = 'a'.repeat(64)) {
  const intent: PasswordProjectNativeDeletionIntent = { version: 1, providerId: 'mdbx2', vaultHandle: 'synthetic-vault',
    writeRevision: { vaultId: 'synthetic-native-vault', revisionSha256: revision }, operationScope: '',
    mutations: record.removed.map(row => {
      const ref = observed.find(item => item.id === row.id)!.providerRefs.find(ref => ref.providerId === 'mdbx2')!;
      return { kind: 'delete' as const, logicalObjectId: `native:${ref.remoteId}`, expectedHeadCommitId: ref.revision! };
    }).sort((a, b) => a.logicalObjectId.localeCompare(b.logicalObjectId)) };
  intent.operationScope = await passwordProjectNativeDeletionScope(record, intent); return intent;
}
async function nativeFixture() {
  const fixtureData = await fixture('mdbx2');
  const record = (await fixtureData.service.stagePasswordProjectRemoval(fixtureData.input)).removal!;
  const observed = await acknowledge(fixtureData.service, 'mdbx2');
  const intent = await nativeIntent(record, observed);
  return { ...fixtureData, record, observed, intent };
}
const receiptFor = (record: PasswordProjectRemovalRecord) => ({ changed: true, operationId: 'native-operation', commitId: 'native-commit',
  items: record.nativeDeletion!.intent.mutations.map(mutation => ({ kind: 'delete' as const, changed: true,
    logicalObjectId: mutation.logicalObjectId, objectId: mutation.logicalObjectId.slice('native:'.length) })) });

describe('encrypted native project removal intent', () => {
  it.each(['edit-target', 'new-member', 'restore-source'] as const)('acknowledges an already committed delete without losing a later %s', async scenario => {
    const { service, storage, record, observed, intent } = await nativeFixture();
    const deleting = await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent);
    if (scenario === 'edit-target') {
      const row = (await service.getItem(record.retained[0].id))!;
      await service.upsertItem({ ...row, notes: 'newer retained notes' }, undefined, row.updatedAt);
    } else if (scenario === 'new-member') {
      await service.upsertItem({ ...observed[1], id: crypto.randomUUID(), providerRefs: [{ providerId: 'mdbx2' }] });
    } else {
      const row = (await service.listDeletedItems()).find(item => item.id === record.removed[0].id)!;
      await service.upsertItem({ ...row, deletedAt: undefined, password: 'newer restored password' } as LoginItem, undefined, row.updatedAt);
    }
    const before = await service.readState();
    const pendingIds = new Set(deleting.nativeDeletion!.pendingMutations.map(row => row.id));
    const confirm = vi.fn(async (saved: PasswordProjectRemovalRecord, pending: NonNullable<Mdbx2RestoreRecord['reapply']>[]) => {
      const result = { ...receiptFor(saved), alreadyCommitted: true };
      const restores = await Promise.all(pending.map(async reapply => {
        const original = saved.removed.find(row => row.id === reapply.item.id)!;
        const source = { ...original, deletedAt: saved.nativeDeletion!.deletedAt, updatedAt: saved.nativeDeletion!.deletedAt,
          providerRefs: original.providerRefs.map(ref => ref.providerId === intent.providerId ? { ...ref, revision: result.commitId } : ref) };
        const ref = source.providerRefs.find(ref => ref.providerId === intent.providerId)!;
        const restore: Mdbx2RestoreRecord = { version: 1, id: crypto.randomUUID(), status: 'prepared', source, reapply,
          provider: saved.providerBindings.find(provider => provider.id === intent.providerId)!, intent: { objectId: ref.remoteId!,
            collectionId: ref.remoteFolderId!, objectTypeId: 'login', expectedHeadCommitId: result.commitId,
            writeRevision: intent.writeRevision, operationScope: '' } };
        restore.intent.operationScope = await mdbx2RestoreScope(restore); return restore;
      }));
      return { result, restores };
    });
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic reconciliation save failed'));
    await expect(service.acknowledgeCommittedPasswordProjectDeletion(record.id, intent.operationScope, confirm)).rejects.toThrow('reconciliation save');
    expect(await service.readState()).toEqual(before);
    await service.lock(); const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore()); await restarted.unlock(secret);
    const completed = await restarted.acknowledgeCommittedPasswordProjectDeletion(record.id, intent.operationScope, confirm);
    expect(completed.status).toBe('completed');
    const after = await restarted.readState();
    const newerQueue = before.mutationQueue.filter(row => !pendingIds.has(row.id) || row.operation !== 'delete');
    expect(after.mutationQueue).toEqual(newerQueue);
    for (const row of before.items.filter(row => !deleting.removed.some(removed => removed.id === row.id) || !row.deletedAt))
      expect(after.items.find(item => item.id === row.id)).toEqual(row);
    const restores = await restarted.readMdbx2Restores();
    expect(restores).toHaveLength(scenario === 'restore-source' ? 1 : 0);
    if (scenario === 'restore-source') {
      const restore = restores[0];
      const members = after.items.filter((row): row is LoginItem => row.kind === 'login' && !row.deletedAt && row.passwordGroupId === record.retained[0].passwordGroupId);
      await expect(restarted.stagePasswordProjectRemoval({ operationId: crypto.randomUUID(), items: members,
        expected: Object.fromEntries(members.map(row => [row.id, row.updatedAt])), removedItemIds: [members[0].id] })).rejects.toThrow('待完成的恢复');
      expect(await restarted.readState()).toEqual(after);
      const history = [completed, ...Array.from({ length: 25 }, (_, index) => ({ ...completed, id: `history-${index}` }))];
      const retained = retainPasswordProjectRemovalHistory(history, restores);
      expect(retained).toContainEqual(completed);
      expect(retained).not.toContainEqual(history[1]);
      expect(retained).toHaveLength(20);
      expect(retainPasswordProjectRemovalHistory(history, [{ ...restore, status: 'completed' }])).not.toContainEqual(completed);
      expect(() => retainPasswordProjectRemovalHistory(history.slice(1), restores)).toThrow('缺少原始删除回执');
      const required = Array.from({ length: 80 }, (_, index) => ({ ...restore, id: `restore-${index}`, reapply: { ...restore.reapply!, deletionOperationId: `pinned-${index}` } }));
      const pinned = required.map(row => ({ ...completed, id: row.reapply.deletionOperationId }));
      const bounded = retainPasswordProjectRemovalHistory([...pinned, ...history], required);
      expect(bounded).toHaveLength(99);
      for (const row of pinned) expect(bounded).toContainEqual(row);
      expect(restore.reapply!.item).toEqual(before.items.find(row => row.id === deleting.removed[0].id));
      expect(restore.reapply!.pendingMutations).toEqual(newerQueue);
      expect(restore.source.providerRefs[0].revision).toBe('native-commit');
      for (const invalid of [{ ...restore, reapply: null },
        { ...restore, reapply: { ...restore.reapply, item: { ...restore.reapply!.item, deletedAt: restore.source.deletedAt } } },
        { ...restore, reapply: { ...restore.reapply, pendingMutations: [{ ...newerQueue[0], providerId: 'unrelated' }] } }])
        expect(() => readMdbx2RestoreJournal([invalid])).toThrow('恢复记录无效');
      const unrelated = { ...restore, id: crypto.randomUUID(), reapply: { ...restore.reapply!, deletionOperationId: crypto.randomUUID() } };
      unrelated.intent = { ...restore.intent, operationScope: '' }; unrelated.intent.operationScope = await mdbx2RestoreScope(unrelated);
      await expect(restarted.stageMdbx2Restore(unrelated)).rejects.toThrow('缺少已确认');
      const native = { alreadyCommitted: true, operationId: 'restore-operation', commitId: 'restore-commit', logicalObjectId: 'native:remote-0',
        objectId: 'remote-0', collectionId: 'synthetic-folder', objectTypeId: 'login' };
      const restored = await restarted.applyMdbx2Restore(restore.id, restore.intent.operationScope, async () => native) as LoginItem;
      expect(restored.password).toBe('newer restored password'); expect(restored.deletedAt).toBeUndefined();
      expect(restored.providerRefs[0].revision).toBe('restore-commit');
      expect(restored.providerRefs[0].etag).not.toContain('newer restored password');
      expect((await restarted.readState()).mutationQueue).toEqual(newerQueue);
    }
    const final = await restarted.readState();
    await restarted.acknowledgeCommittedPasswordProjectDeletion(record.id, intent.operationScope, confirm);
    expect(await restarted.readState()).toEqual(final); expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing committed receipt and replacement provider before reconciling', async () => {
    const { service, storage, record, observed, intent } = await nativeFixture();
    const deleting = await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent);
    const before = storage.envelope;
    await expect(service.acknowledgeCommittedPasswordProjectDeletion(record.id, intent.operationScope,
      async () => ({ result: receiptFor(deleting), restores: [] }))).rejects.toThrow('已提交');
    expect(storage.envelope).toEqual(before);
    const provider = (await service.getProvider('mdbx2'))!;
    await service.upsertProvider({ ...provider, config: { ...provider.config, vaultHandle: 'replacement' } });
    const confirm = vi.fn();
    await expect(service.acknowledgeCommittedPasswordProjectDeletion(record.id, intent.operationScope, confirm)).rejects.toThrow('密码源已变化');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps a newer deletion which reuses the original queue ID', async () => {
    const { service, record, observed, intent } = await nativeFixture();
    const deleting = await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent);
    const source = (await service.listDeletedItems()).find(row => row.id === record.removed[0].id)!;
    await service.deleteItem(source.id);
    const before = await service.readState();
    expect(before.mutationQueue[0].id).toBe(deleting.nativeDeletion!.pendingMutations[0].id);
    await service.acknowledgeCommittedPasswordProjectDeletion(record.id, intent.operationScope, async (saved, candidates) => {
      expect(candidates).toEqual([]);
      return { result: { ...receiptFor(saved), alreadyCommitted: true }, restores: [] };
    });
    const after = await service.readState();
    expect(after.mutationQueue).toEqual(before.mutationQueue);
    const previous = before.items.find(row => row.id === source.id)!, current = after.items.find(row => row.id === source.id)!;
    expect({ ...current, providerRefs: previous.providerRefs }).toEqual(previous);
  });

  it('refuses oversized native deletion before staging survivors or a recovery journal', async () => {
    const { service, storage, rows, input } = await fixture('mdbx2', 52);
    const before = JSON.stringify(storage.envelope);
    await expect(service.stagePasswordProjectRemoval({ ...input, removedItemIds: rows.slice(0, 51).map(row => row.id) })).rejects.toThrow('最多移除 50');
    expect(JSON.stringify(storage.envelope)).toBe(before);
    expect(await service.readPasswordProjectRemovals()).toEqual([]);
  });
  it('saves the exact queue and native request before deletion, then acknowledges once across restart', async () => {
    const { service, storage, record, observed, intent } = await nativeFixture();
    const saved = await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent);
    expect(saved.nativeDeletion!.pendingMutations).toEqual((await service.readState()).mutationQueue);
    expect(JSON.stringify(storage.envelope)).not.toContain('synthetic-native-vault');
    await service.lock(); const reopened = new SecureVaultService(storage, new MemoryVaultSessionStore()); await reopened.unlock(secret);
    expect((await reopened.readPasswordProjectRemovals())[0]).toEqual(saved);
    const execute = vi.fn(async (row: PasswordProjectRemovalRecord) => receiptFor(row));
    const completed = await reopened.applyPasswordProjectNativeDeletion(record.id, intent.operationScope, execute);
    expect(completed.status).toBe('completed'); expect(completed.nativeDeletion!.receipt!.commitId).toBe('native-commit');
    expect((await reopened.readState()).mutationQueue).toEqual([]);
    expect(await reopened.applyPasswordProjectNativeDeletion(record.id, intent.operationScope, execute)).toEqual(completed);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a durable request after remote success followed by local save failure', async () => {
    const { service, storage, record, observed, intent } = await nativeFixture();
    await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent);
    const before = await service.readState();
    const remote = vi.fn(async (row: PasswordProjectRemovalRecord) => receiptFor(row));
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic local write failed after remote success'));
    await expect(service.applyPasswordProjectNativeDeletion(record.id, intent.operationScope, remote)).rejects.toThrow('after remote success');
    expect(remote).toHaveBeenCalledTimes(1); expect(await service.readState()).toEqual(before);
    await service.lock(); const reopened = new SecureVaultService(storage, new MemoryVaultSessionStore()); await reopened.unlock(secret);
    expect((await reopened.readPasswordProjectRemovals())[0].nativeDeletion!.intent).toEqual(intent);
    await reopened.applyPasswordProjectNativeDeletion(record.id, intent.operationScope, remote);
    expect(remote.mock.calls[0][0]).toEqual(remote.mock.calls[1][0]);
  });

  it('never exposes an unsaved deletion request after persistence failure', async () => {
    const { service, storage, record, observed, intent } = await nativeFixture();
    const before = await service.readState();
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic intent save failed'));
    await expect(service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent)).rejects.toThrow('intent save failed');
    expect(await service.readState()).toEqual(before);
    const remote = vi.fn();
    await expect(service.applyPasswordProjectNativeDeletion(record.id, intent.operationScope, remote)).rejects.toThrow('删除请求已变化');
    expect(remote).not.toHaveBeenCalled();
  });

  it.each(['restore-source', 'edit-target', 'new-member', 'replace-provider'] as const)('preserves %s and refuses to consume newer local state', async scenario => {
    const { service, storage, record, observed, intent } = await nativeFixture();
    await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent);
    if (scenario === 'restore-source') {
      await expect(service.restoreItem(record.removed[0].id)).rejects.toThrow('原生恢复流程');
      // An older caller or restored backup can still supply a newer live row.
      const source = (await service.listDeletedItems()).find(item => item.id === record.removed[0].id)!;
      await service.upsertItem({ ...source, deletedAt: undefined }, undefined, source.updatedAt);
    }
    if (scenario === 'edit-target') {
      const row = (await service.getItem(record.retained[0].id)) as LoginItem;
      await service.upsertItem({ ...row, password: 'newer secret' }, undefined, row.updatedAt);
    }
    if (scenario === 'new-member') await service.upsertItem({ ...observed[1], id: crypto.randomUUID(), providerRefs: [{ providerId: 'mdbx2' }] });
    if (scenario === 'replace-provider') {
      const account = (await service.getProvider('mdbx2'))!;
      await service.upsertProvider({ ...account, config: { ...account.config, vaultHandle: 'replacement' } });
    }
    const before = JSON.stringify(storage.envelope), remote = vi.fn();
    await expect(service.applyPasswordProjectNativeDeletion(record.id, intent.operationScope, remote)).rejects.toThrow();
    expect(remote).not.toHaveBeenCalled(); expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it('replaces only a verified new revision and preserves the old request if saving it fails', async () => {
    const { service, storage, record, observed, intent } = await nativeFixture();
    const deleting = await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent);
    const fresh = await nativeIntent(deleting, undefined, 'b'.repeat(64));
    const before = JSON.stringify(storage.envelope);
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic replacement save failed'));
    await expect(service.replacePasswordProjectNativeDeletionIntent(record.id, intent.operationScope, async () => fresh)).rejects.toThrow('replacement save failed');
    expect(JSON.stringify(storage.envelope)).toBe(before);
    await expect(service.replacePasswordProjectNativeDeletionIntent(record.id, intent.operationScope, async () => intent)).rejects.toThrow('缺少新的');
    const saved = await service.replacePasswordProjectNativeDeletionIntent(record.id, intent.operationScope, async () => fresh);
    expect(saved.nativeDeletion!.intent).toEqual(fresh);
    const remote = vi.fn();
    await expect(service.applyPasswordProjectNativeDeletion(record.id, intent.operationScope, remote)).rejects.toThrow('删除请求已变化');
    expect(remote).not.toHaveBeenCalled();
  });

  it('rejects malformed intents, altered scope, receipts and generic completion', async () => {
    const { service, storage, record, observed, intent } = await nativeFixture();
    for (const damaged of [{ ...intent, operationScope: 'b'.repeat(64) }, { ...intent, mutations: [] },
      { ...intent, mutations: [{ ...intent.mutations[0], kind: 'upsert' }] }, { ...intent, writeRevision: { ...intent.writeRevision, revisionSha256: 'invalid' } }]) {
      await expect(service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), damaged as PasswordProjectNativeDeletionIntent)).rejects.toThrow();
      expect(await service.listDeletedItems()).toEqual([]);
    }
    const deleting = await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent);
    const before = JSON.stringify(storage.envelope);
    await expect(service.applyPasswordProjectNativeDeletion(record.id, intent.operationScope, async () => ({ ...receiptFor(deleting), items: [] }))).rejects.toThrow('回执');
    await expect(service.completePasswordProjectRemoval(record.id)).rejects.toThrow('原生删除必须');
    expect(JSON.stringify(storage.envelope)).toBe(before);
    for (const bad of [{ ...deleting, status: 'completed' }, { ...deleting, nativeDeletion: null },
      { ...deleting, nativeDeletion: { ...deleting.nativeDeletion, pendingMutations: [] } }]) expect(() => readPasswordProjectRemovalJournal([bad])).toThrow();
  });

  it('serializes local edits after deletion acknowledgement without discarding the newer write', async () => {
    const { service, record, observed, intent } = await nativeFixture();
    await service.finalizePasswordProjectRemoval(record.id, observed, emptyProof(record), intent);
    const target = (await service.getItem(record.retained[0].id)) as LoginItem;
    let started!: () => void, release!: () => void;
    const executing = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const deletion = service.applyPasswordProjectNativeDeletion(record.id, intent.operationScope, async saved => {
      started(); await blocked; return receiptFor(saved);
    });
    await executing;
    let edited = false;
    const edit = service.upsertItem({ ...target, notes: 'newer notes after commit' }, undefined, target.updatedAt).then(() => { edited = true; });
    await Promise.resolve(); expect(edited).toBe(false); release();
    await deletion; await edit;
    expect((await service.getItem(target.id))?.notes).toBe('newer notes after commit');
    expect((await service.readState()).mutationQueue).toEqual([expect.objectContaining({ itemId: target.id, operation: 'update' })]);
  });
});
