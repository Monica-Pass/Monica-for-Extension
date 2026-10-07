import { expect, it, vi } from 'vitest';
import type { LoginItem, ProviderAccount } from '../../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { buildKeePassFixture } from './keepass-fixture';
import { KeePassProvider } from './keepass-provider';
import { KeePassRemoteSessionService } from './keepass-remote-session';
import { MemoryKeePassWorkingCopyStorage } from './keepass-working-copy-store';
import { createKeePassCacheEncryptionKey, KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG } from './keepass-receipt-crypto';
import { openKeePassVault } from './keepass-vault';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { KeePassProjectRemovalWorkflow } from '../../background/keepass-project-removal';
import { ProviderOperationQueue } from '../../background/provider-operation-queue';
import { LockedAutofillCache, MemoryLockedAutofillStorage } from '../../security/locked-autofill';
import { MemoryVaultDeviceKeyStore } from '../../security/vault-device-key';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

it.each([false, true])('keeps the confirmed locked-autofill choice across owner removal and restart: %s', async enabled => {
  const f = await fixture();
  const storage = new MemoryVaultStorage(), device = new MemoryVaultDeviceKeyStore();
  const cache = new LockedAutofillCache(new MemoryLockedAutofillStorage());
  let vault = new SecureVaultService(storage, new MemoryVaultSessionStore(), Date.now, device, cache);
  await vault.setup('Synthetic local master', f.request.draft.originals);
  await vault.upsertProvider(f.account);
  const [removed, retained] = f.request.draft.originals;
  await vault.setLockedAutofill(removed.id, true);
  await vault.setLockedAutofill(retained.id, !enabled);
  const request = { ...f.request, draft: { ...f.request.draft, allowLockedAutofill: enabled } };
  await vault.stageKeePassProjectRemoval({ operationId: request.operationId, source: f.account, draft: request.draft });
  await vault.beginKeePassProjectRemoval(request.operationId, request.expectedWorkingSha256);
  const receipt = await f.service.persistProjectRemoval(f.account, request);
  await vault.completeKeePassProjectRemoval(request.operationId, receipt);
  await vault.lock();
  vault = new SecureVaultService(storage, new MemoryVaultSessionStore(), Date.now, device, cache);
  expect((await vault.readAutofillContext()).items.map(item => item.id)).toEqual(enabled ? [retained.id] : []);
  await vault.unlock('Synthetic local master');
  expect(await vault.listLockedAutofillItemIds()).toEqual(enabled ? [retained.id] : []);
  // Replaying an already adopted receipt cannot reinstate an earlier user grant.
  await vault.setLockedAutofill(retained.id, !enabled);
  await vault.completeKeePassProjectRemoval(request.operationId, receipt);
  await vault.lock();
  expect((await vault.readAutofillContext()).items.map(item => item.id)).toEqual(enabled ? [] : [retained.id]);
});

async function fixture() {
  const account: ProviderAccount = { id: 'kp', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { sourceMode: 'webdav', databaseId: 7, databasePassword: 'fixture master password',
      remotePath: '/test.kdbx', webDavBaseUrl: 'http://127.0.0.1:8787', [KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]: createKeePassCacheEncryptionKey() } };
  const bytes = await buildKeePassFixture({ entries: [0, 1].map(n => ({ title: 'Project', fields: { URL: 'https://example.com' }, protectedFields: {
    Password: `synthetic-secret-${n}`, [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({ version: 1, projectId: uuid(1), groupId: uuid(2),
      passwordId: uuid(n + 10), label: 'Main', primary: true, groupOrder: 0, passwordOrder: n }) },
    binaries: n === 0 ? { 'project.bin': Uint8Array.of(1, 3, 5) } : undefined })) });
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const storage = new MemoryKeePassWorkingCopyStorage();
  await storage.save({ providerId: account.id, baseBytes: bytes, workingBytes: bytes, baseSha256: sha, workingSha256: sha,
    baseEtag: '"original"', updatedAt: '2026-10-06T00:00:00Z' }, 0);
  const provider = new KeePassProvider(); await provider.unlock(account, bytes, { password: String(account.config.databasePassword) });
  const originals = (await provider.sync(account, { now: '2026-10-06T00:00:00Z', localItems: [] })).items as LoginItem[];
  const request = { operationId: uuid(90), expectedWorkingSha256: sha, draft: { providerId: account.id, anchorItemId: originals[0].id,
    originals, items: structuredClone(originals), removedItemIds: [originals[0].id] } };
  const service = new KeePassRemoteSessionService(provider, storage);
  return { account, storage, provider, request, service, bytes };
}

it('commits encrypted file and receipt together, then recovers through fresh session without repeating removal', async () => {
  const f = await fixture(), receipt = await f.service.persistProjectRemoval(f.account, f.request);
  expect(receipt.result.type).toBe('project-remove');
  const record = (await f.storage.read(f.account.id))!;
  expect(record.revision).toBe(2); expect(record.baseBytes).toEqual(f.bytes);
  expect(JSON.stringify(await f.storage.readReceipt(f.account.id, f.request.operationId))).not.toContain('synthetic-secret');
  const reopened = await openKeePassVault(record.workingBytes, { password: String(f.account.config.databasePassword), providerId: f.account.id, databaseId: 7 });
  expect(reopened.items.filter(item => item.deletedAt)).toHaveLength(1);
  expect(reopened.items.every(item => reopened.entriesByUuid.get(item.keepassEntryUuid!)!.binaries.has('project.bin'))).toBe(true);
  const nextProvider = new KeePassProvider(), next = new KeePassRemoteSessionService(nextProvider, f.storage);
  expect(await next.persistProjectRemoval(f.account, f.request)).toEqual(receipt);
  expect((await f.storage.read(f.account.id))!.revision).toBe(2);
  await next.restore(f.account);
  expect(nextProvider.summarize(f.account.id).itemCount).toBe(1);
});

it.each(['before-commit', 'lost-response', 'revision-race'] as const)('handles %s without a partial file or duplicate removal', async mode => {
  const f = await fixture(), save = f.storage.save.bind(f.storage);
  vi.spyOn(f.storage, 'save').mockImplementationOnce(async (input, expected, receipt) => {
    if (mode === 'before-commit') throw new Error('Synthetic disk failure');
    if (mode === 'revision-race') {
      const current = (await f.storage.read(f.account.id))!;
      await save({ ...current, updatedAt: '2026-10-06T01:00:00Z' }, current.revision);
      return save(input, expected, receipt);
    }
    await save(input, expected, receipt);
    throw new Error('Synthetic lost acknowledgement');
  });
  await expect(f.service.persistProjectRemoval(f.account, f.request)).rejects.toThrow();
  const record = (await f.storage.read(f.account.id))!;
  if (mode !== 'lost-response') {
    expect(record.workingBytes).toEqual(f.bytes);
    expect(await f.storage.readReceipt(f.account.id, f.request.operationId)).toBeUndefined();
  }
  const next = new KeePassRemoteSessionService(new KeePassProvider(), f.storage);
  expect((await next.persistProjectRemoval(f.account, f.request)).result.type).toBe('project-remove');
  expect((await f.storage.read(f.account.id))!.revision).toBe(mode === 'revision-race' ? 3 : 2);
});

it('rejects operation reuse for a different source or draft and a changed working file hash', async () => {
  const f = await fixture();
  await expect(f.service.persistProjectRemoval(f.account, { ...f.request, expectedWorkingSha256: '0'.repeat(64) })).rejects.toThrow();
  await f.service.persistProjectRemoval(f.account, f.request);
  const before = (await f.storage.read(f.account.id))!.revision;
  await expect(f.service.persistProjectRemoval({ ...f.account, config: { ...f.account.config, remotePath: '/different.kdbx' } }, f.request)).rejects.toThrow();
  const changed = structuredClone(f.request); changed.draft.items[0].notes = 'different draft';
  await expect(f.service.persistProjectRemoval(f.account, changed)).rejects.toThrow();
  expect((await f.storage.read(f.account.id))!.revision).toBe(before);
});

it.each(['before-commit', 'lost-acknowledgement'] as const)('recovers local adoption %s, then never overwrites a later edit on receipt replay', async mode => {
  const f = await fixture(), storage = new MemoryVaultStorage();
  let vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup('Synthetic local master', f.request.draft.originals); await vault.upsertProvider(f.account);
  await vault.stageKeePassProjectRemoval({ operationId: f.request.operationId, source: f.account, draft: f.request.draft });
  await vault.beginKeePassProjectRemoval(f.request.operationId, f.request.expectedWorkingSha256);
  await expect(vault.cancelKeePassProjectRemovalIntent(f.request.operationId)).rejects.toThrow();
  const receipt = await f.service.persistProjectRemoval(f.account, f.request);
  const persist = storage.write.bind(storage);
  vi.spyOn(storage, 'write').mockImplementationOnce(async envelope => {
    if (mode === 'lost-acknowledgement') await persist(envelope);
    throw new Error('Synthetic local adoption failure');
  });
  await expect(vault.completeKeePassProjectRemoval(f.request.operationId, receipt)).rejects.toThrow('adoption failure');
  vault = new SecureVaultService(storage, new MemoryVaultSessionStore()); await vault.unlock('Synthetic local master');
  expect((await vault.readKeePassProjectRemovalIntents())[0].status).toBe(mode === 'before-commit' ? 'writing' : 'completed');
  expect((await vault.readState()).items.every(item => !item.deletedAt)).toBe(mode === 'before-commit');
  expect((await vault.completeKeePassProjectRemoval(f.request.operationId, receipt)).status).toBe('completed');
  const retained = (await vault.readState()).items.find(item => !item.deletedAt)!;
  await vault.upsertItem({ ...retained, notes: 'later user edit' });
  const before = JSON.stringify(storage.envelope);
  await vault.completeKeePassProjectRemoval(f.request.operationId, receipt);
  expect(JSON.stringify(storage.envelope)).toBe(before);
  expect((await vault.readState()).items.find(item => item.id === retained.id)?.notes).toBe('later user edit');
  expect((await f.storage.read(f.account.id))!.revision).toBe(2);
});

it('rejects mismatched receipts and preserves concurrent local edits with the native receipt still recoverable', async () => {
  const f = await fixture(), storage = new MemoryVaultStorage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup('Synthetic local master', f.request.draft.originals); await vault.upsertProvider(f.account);
  await vault.stageKeePassProjectRemoval({ operationId: f.request.operationId, source: f.account, draft: f.request.draft });
  await vault.beginKeePassProjectRemoval(f.request.operationId, f.request.expectedWorkingSha256);
  const receipt = await f.service.persistProjectRemoval(f.account, f.request);
  const bad = structuredClone(receipt); bad.intentSha256 = '0'.repeat(64);
  const before = JSON.stringify(storage.envelope);
  await expect(vault.completeKeePassProjectRemoval(f.request.operationId, bad)).rejects.toThrow();
  expect(JSON.stringify(storage.envelope)).toBe(before);
  await vault.upsertItem({ ...f.request.draft.originals[1], notes: 'concurrent edit' });
  const edited = JSON.stringify(storage.envelope);
  await expect(vault.completeKeePassProjectRemoval(f.request.operationId, receipt)).rejects.toThrow();
  expect(JSON.stringify(storage.envelope)).toBe(edited);
  expect((await vault.readKeePassProjectRemovalIntents())[0].status).toBe('writing');
  expect(await f.service.persistProjectRemoval(f.account, f.request)).toEqual(receipt);
});

it('coordinates native response-loss recovery after restart and emits only manager-safe status', async () => {
  const f = await fixture(), storage = new MemoryVaultStorage();
  let vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup('Synthetic local master', f.request.draft.originals); await vault.upsertProvider(f.account);
  const first = new KeePassProjectRemovalWorkflow(vault, f.service, new ProviderOperationQueue());
  const save = f.storage.save.bind(f.storage);
  vi.spyOn(f.storage, 'save').mockImplementationOnce(async (input, revision, receipt) => {
    await save(input, revision, receipt); throw new Error('Synthetic native response lost');
  });
  await expect(first.stage({ operationId: f.request.operationId, source: f.account, draft: f.request.draft })).rejects.toThrow('response lost');
  const pending = await first.pending();
  expect(pending).toMatchObject([{ status: 'writing', canCancel: false, localAdoptionCompleted: false }]);
  expect(JSON.stringify(pending)).not.toContain('synthetic-secret');
  expect(JSON.stringify(pending)).not.toContain('fixture master password');
  vault = new SecureVaultService(storage, new MemoryVaultSessionStore()); await vault.unlock('Synthetic local master');
  const next = new KeePassProjectRemovalWorkflow(vault, new KeePassRemoteSessionService(new KeePassProvider(), f.storage), new ProviderOperationQueue());
  expect(await next.resume(f.request.operationId)).toMatchObject({ status: 'completed', localAdoptionCompleted: true });
  expect(await next.pending()).toEqual([]);
  expect((await vault.readState()).items.filter(item => item.deletedAt)).toHaveLength(1);
  expect((await f.storage.read(f.account.id))!.revision).toBe(2);
});

it('rejects a source replaced while queued and stops a later edit before the first native write', async () => {
  const f = await fixture(), storage = new MemoryVaultStorage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup('Synthetic local master', f.request.draft.originals); await vault.upsertProvider(f.account);
  const queue = new ProviderOperationQueue(), workflow = new KeePassProjectRemovalWorkflow(vault, f.service, queue);
  let release!: () => void;
  const hold = queue.run(f.account.id, () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const staged = workflow.stage({ operationId: f.request.operationId, source: f.account, draft: f.request.draft });
  const rejected = expect(staged).rejects.toThrow();
  await vault.upsertProvider({ ...f.account, config: { ...f.account.config, remotePath: '/replaced.kdbx' } });
  release(); await hold; await rejected;
  expect(await vault.readKeePassProjectRemovalIntents()).toEqual([]);
  await vault.upsertProvider(f.account);
  await vault.stageKeePassProjectRemoval({ operationId: f.request.operationId, source: f.account, draft: f.request.draft });
  await vault.beginKeePassProjectRemoval(f.request.operationId, f.request.expectedWorkingSha256);
  await vault.upsertItem({ ...f.request.draft.originals[1], notes: 'edit before native write' });
  await expect(workflow.resume(f.request.operationId)).rejects.toThrow();
  expect((await f.storage.read(f.account.id))!.revision).toBe(1);
  expect(await f.storage.readReceipt(f.account.id, f.request.operationId)).toBeUndefined();
});

it.each([false, true])('persists live attachments before capture and invalidates the old session after commit, response loss=%s', async lostResponse => {
  const f = await fixture(), storage = new MemoryVaultStorage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup('Synthetic local master', f.request.draft.originals); await vault.upsertProvider(f.account);
  await f.provider.addAttachment(f.account, f.request.draft.originals[0], 'fresh-live.bin', Uint8Array.of(7, 8, 9), false);
  const nativeQueue = new ProviderOperationQueue();
  const captures = vi.fn(async (account: ProviderAccount) => { await f.service.persistWorkingCopy(account); });
  const invalidate = vi.fn((providerId: string) => f.provider.lockAccount(providerId));
  const workflow = new KeePassProjectRemovalWorkflow(vault, f.service, new ProviderOperationQueue(), undefined, {
    runMutationExclusive: (id, task) => nativeQueue.run(id, task), beforeCapture: captures, invalidateSession: invalidate
  });
  if (lostResponse) {
    const persist = f.service.persistProjectRemoval.bind(f.service);
    vi.spyOn(f.service, 'persistProjectRemoval').mockImplementationOnce(async (account, request) => {
      await persist(account, request); throw new Error('Synthetic commit response lost');
    });
    await expect(workflow.stage({ operationId: f.request.operationId, source: f.account, draft: f.request.draft })).rejects.toThrow('response lost');
    expect(f.provider.isUnlocked(f.account.id)).toBe(false);
    await expect(workflow.assertProviderReady(f.account.id)).rejects.toThrow();
    // Recovery is called with the outer provider queue already owned in production.
    await workflow.recoverProvider(f.account.id);
  } else {
    await workflow.stage({ operationId: f.request.operationId, source: f.account, draft: f.request.draft });
  }
  expect(captures).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalled(); expect(f.provider.isUnlocked(f.account.id)).toBe(false);
  await expect(workflow.assertProviderReady(f.account.id)).resolves.toBeUndefined();
  await f.service.restore(f.account);
  const state = await vault.readState();
  const synced = await f.provider.sync(f.account, { now: '2026-10-06T08:00:00Z', localItems: state.items, pendingMutations: [] });
  expect(synced.conflicts).toEqual([]);
  expect(synced.items.filter(item => item.deletedAt)).toHaveLength(1);
  await f.service.persistWorkingCopy(f.account);
  const record = (await f.storage.read(f.account.id))!;
  const reopened = await openKeePassVault(record.workingBytes, { password: String(f.account.config.databasePassword), providerId: f.account.id, databaseId: 7 });
  expect(reopened.items.filter(item => item.deletedAt)).toHaveLength(1);
  for (const item of reopened.items) {
    expect(reopened.entriesByUuid.get(item.keepassEntryUuid!)!.binaries.has('fresh-live.bin')).toBe(true);
    expect(reopened.entriesByUuid.get(item.keepassEntryUuid!)!.binaries.has('project.bin')).toBe(true);
  }
});

it('accepts a manager request with an opaque editor token without sending provider credentials to the manager', async () => {
  const f = await fixture(), vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  await vault.setup('Synthetic local master', f.request.draft.originals); await vault.upsertProvider(f.account);
  const workflow = new KeePassProjectRemovalWorkflow(vault, f.service, new ProviderOperationQueue());
  const token = await workflow.sourceToken(f.account.id);
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  await vault.upsertProvider({ ...f.account, lastSyncAt: '2026-10-06T10:00:00Z', config: { ...f.account.config, workingCopyRevision: 42 } });
  expect(await workflow.sourceToken(f.account.id)).toBe(token);
  expect(await workflow.stageFromManager({ operationId: f.request.operationId, sourceToken: token, draft: f.request.draft }))
    .toMatchObject({ status: 'completed', localAdoptionCompleted: true });
});

it.each(['path', 'credential', 'unlock-session'] as const)('rejects an editor token after %s changes before any journal or native file write', async mode => {
  const f = await fixture(), vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  await vault.setup('Synthetic local master', f.request.draft.originals); await vault.upsertProvider(f.account);
  const workflow = new KeePassProjectRemovalWorkflow(vault, f.service, new ProviderOperationQueue());
  const token = await workflow.sourceToken(f.account.id);
  if (mode === 'path') await vault.upsertProvider({ ...f.account, config: { ...f.account.config, remotePath: '/other.kdbx' } });
  if (mode === 'credential') await vault.upsertProvider({ ...f.account, config: { ...f.account.config, databasePassword: 'different secret' } });
  if (mode === 'unlock-session') { await vault.lock(); await vault.unlock('Synthetic local master'); }
  expect(await workflow.sourceToken(f.account.id)).not.toBe(token);
  await expect(workflow.stageFromManager({ operationId: f.request.operationId, sourceToken: token, draft: f.request.draft }))
    .rejects.toMatchObject({ code: 'password-project-removal-not-staged' });
  expect(await vault.readKeePassProjectRemovalIntents()).toEqual([]);
  expect((await f.storage.read(f.account.id))!.revision).toBe(1);
});

it.each(['lost-commit-response', 'journal-unavailable'] as const)('never releases the frozen manager request when outcome is ambiguous: %s', async mode => {
  const f = await fixture(), storage = new MemoryVaultStorage();
  const vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup('Synthetic local master', f.request.draft.originals); await vault.upsertProvider(f.account);
  const workflow = new KeePassProjectRemovalWorkflow(vault, f.service, new ProviderOperationQueue());
  const token = await workflow.sourceToken(f.account.id);
  if (mode === 'lost-commit-response') {
    const write = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementationOnce(async envelope => { await write(envelope); throw new Error('lost commit response'); });
  } else {
    await vault.upsertProvider({ ...f.account, config: { ...f.account.config, remotePath: '/changed.kdbx' } });
    vi.spyOn(vault, 'readKeePassProjectRemovalIntents').mockRejectedValueOnce(new Error('journal read unavailable'));
  }
  try {
    await workflow.stageFromManager({ operationId: f.request.operationId, sourceToken: token, draft: f.request.draft });
    throw new Error('Expected staging to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('code', 'password-project-removal-not-staged');
    expect((error as Error).message).toContain(mode === 'lost-commit-response' ? 'lost commit response' : '已变化');
  }
  expect((await vault.readKeePassProjectRemovalIntents()).length).toBe(mode === 'lost-commit-response' ? 1 : 0);
});
