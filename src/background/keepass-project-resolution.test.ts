import { expect, it, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import type { ProviderAccount } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { buildKeePassFixture, keePassCredentials } from '../providers/keepass/keepass-fixture';
import { KeePassProvider } from '../providers/keepass/keepass-provider';
import { KeePassRemoteSessionService, type KeePassRemoteFileClient } from '../providers/keepass/keepass-remote-session';
import { MemoryKeePassWorkingCopyStorage } from '../providers/keepass/keepass-working-copy-store';
import { MemoryKeePassConflictRecoveryStorage } from '../providers/keepass/keepass-conflict-recovery-store';
import { createKeePassCacheEncryptionKey } from '../providers/keepass/keepass-receipt-crypto';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultStorage } from '../security/vault-storage';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { ProviderOperationQueue } from './provider-operation-queue';
import { KeePassProjectResolutionWorkflow } from './keepass-project-resolution';

const master = 'Synthetic workflow master', password = 'Synthetic KDBX password';
const projectId = '00000000-0000-4000-8000-000000000099';
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function fixture() {
  const base = await buildKeePassFixture({ password, entries: [0, 1].map(n => ({ title: 'Project', protectedFields: {
    Password: `secret-${n}`, [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({ version: 1, projectId, groupId: '00000000-0000-4000-8000-000000000001',
      passwordId: `00000000-0000-4000-8000-00000000001${n}`, label: 'Main', primary: true, groupOrder: 0, passwordOrder: n }) } })) });
  const local = await kdbxweb.Kdbx.load(base.slice().buffer, keePassCredentials(password));
  local.getDefaultGroup().entries[0].fields.set('Notes', 'Local choice');
  const working = new Uint8Array(await local.save());
  const peer = await kdbxweb.Kdbx.load(base.slice().buffer, keePassCredentials(password));
  peer.getDefaultGroup().entries[0].fields.set('Notes', 'Remote choice');
  const remoteBytes = new Uint8Array(await peer.save());
  const account: ProviderAccount = { id: 'kp', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { sourceMode: 'webdav', databaseId: 7, databasePassword: password, remotePath: '/vault.kdbx', webDavBaseUrl: 'http://127.0.0.1', cacheEncryptionKey: createKeePassCacheEncryptionKey() } };
  const read = vi.fn(async () => ({ bytes: remoteBytes.slice(), etag: '"peer"', sha256: await digest(remoteBytes), sizeBytes: remoteBytes.length, fileName: 'vault.kdbx', url: 'http://127.0.0.1/vault.kdbx' }));
  const client: KeePassRemoteFileClient = { read, write: vi.fn(), stat: vi.fn(), testConnection: vi.fn() };
  const files = new MemoryKeePassWorkingCopyStorage(), recovery = new MemoryKeePassConflictRecoveryStorage(), provider = new KeePassProvider();
  await files.save({ providerId: 'kp', baseBytes: base, workingBytes: working, baseSha256: await digest(base), workingSha256: await digest(working), baseEtag: '"base"', updatedAt: '2026-10-06T00:00:00Z' }, 0);
  await provider.unlock(account, working, { password, sourceMode: 'webdav' });
  const rows = (await provider.refreshFromSession(account, [], '2026-10-06T00:00:00Z')).items;
  const storage = new MemoryVaultStorage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup(master, rows); await vault.upsertProvider(account);
  const remote = new KeePassRemoteSessionService(provider, files, () => client), queue = new ProviderOperationQueue();
  const beforeCapture = vi.fn(async () => {
    if (!provider.isUnlocked(account.id)) await remote.restore(account);
    await remote.persistWorkingCopy(account);
  });
  const beforeResolve = vi.fn(async () => undefined), invalidateSession = vi.fn((id: string) => provider.lockAccount(id));
  const make = (service: SecureVaultService) => new KeePassProjectResolutionWorkflow(service, remote, files, recovery, queue,
    { beforeCapture, beforeResolve, invalidateSession, runMutationExclusive: async (_id, task) => task() });
  const workflow = make(vault), review = await workflow.review('kp');
  const request = { operationId: 'resolve-workflow', reviewToken: review.reviewToken, choices: [{ projectId, choice: 'remote' as const }] };
  const restart = async () => { const next = new SecureVaultService(storage, new MemoryVaultSessionStore()); await next.unlock(master); return { vault: next, workflow: make(next) }; };
  return { workflow, vault, rows, request, files, recovery, storage, remote, read, client, beforeCapture, invalidateSession, restart };
}

it('adopts genuine resolved KDBX with stable local identities and no upload or terminal replay', async () => {
  const f = await fixture();
  expect((await f.workflow.resolve('kp', f.request)).status).toBe('completed');
  expect(f.invalidateSession).toHaveBeenCalledOnce();
  expect(f.client.write).not.toHaveBeenCalled();
  const state = await f.vault.readState();
  expect(state.items.map(row => row.id)).toEqual(f.rows.map(row => row.id));
  expect(state.items[0].notes).toBe('Remote choice');
  const readCount = f.read.mock.calls.length;
  await f.vault.upsertItem({ ...state.items[0], notes: 'Later edit' });
  const next = await f.restart();
  expect((await next.workflow.resolve('kp', f.request)).status).toBe('completed');
  expect(f.read).toHaveBeenCalledTimes(readCount);
  expect((await next.vault.readState()).items[0].notes).toBe('Later edit');
});

it.each(['file-response', 'vault-before', 'vault-after'] as const)('resumes %s loss from original receipt without rereading remote or flushing stale session', async mode => {
  const f = await fixture();
  if (mode === 'file-response') {
    const original = f.remote.resolveProjectConflicts.bind(f.remote);
    vi.spyOn(f.remote, 'resolveProjectConflicts').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Synthetic lost response'); });
  } else {
    const original = f.vault.completeKeePassProjectResolution.bind(f.vault);
    vi.spyOn(f.vault, 'completeKeePassProjectResolution').mockImplementationOnce(async (...args) => {
      if (mode === 'vault-after') await original(...args);
      throw new Error('Synthetic lost response');
    });
  }
  await expect(f.workflow.resolve('kp', f.request)).rejects.toThrow('Synthetic lost response');
  const saved = await f.files.read('kp'), reads = f.read.mock.calls.length, captures = f.beforeCapture.mock.calls.length;
  const next = await f.restart();
  if (mode !== 'vault-after') await expect(next.workflow.assertProviderReady('kp')).rejects.toThrow('待恢复');
  await next.workflow.resume(f.request.operationId);
  expect(await f.files.read('kp')).toEqual(saved);
  expect(f.read).toHaveBeenCalledTimes(reads); expect(f.beforeCapture).toHaveBeenCalledTimes(captures);
  expect((await next.vault.readState()).items[0].notes).toBe('Remote choice');
});

it('rejects obsolete review before staging and rejects replacement choices on replay', async () => {
  const f = await fixture();
  await expect(f.workflow.resolve('kp', { ...f.request, reviewToken: 'f'.repeat(64) })).rejects.toThrow('预览');
  expect(await f.vault.readKeePassProjectResolutions()).toEqual([]);
  await f.workflow.resolve('kp', f.request);
  await expect(f.workflow.resolve('kp', { ...f.request, choices: [{ projectId, choice: 'local' }] })).rejects.toThrow('其他选择');
});

it('preserves a newer working file when adoption was interrupted after the original file commit', async () => {
  const f = await fixture();
  vi.spyOn(f.vault, 'completeKeePassProjectResolution').mockRejectedValueOnce(new Error('Synthetic interrupted adoption'));
  await expect(f.workflow.resolve('kp', f.request)).rejects.toThrow('interrupted adoption');
  const saved = (await f.files.read('kp'))!;
  const newer = await kdbxweb.Kdbx.load(saved.workingBytes.slice().buffer, keePassCredentials(password));
  newer.getDefaultGroup().entries[0].fields.set('Notes', 'Newer native file');
  const bytes = new Uint8Array(await newer.save());
  await f.files.save({ ...saved, workingBytes: bytes, workingSha256: await digest(bytes) }, saved.revision);
  const next = await f.restart(), envelope = await f.storage.read();
  await expect(next.workflow.resume(f.request.operationId)).rejects.toThrow('后续变化');
  expect((await f.files.read('kp'))!.workingBytes).toEqual(bytes);
  expect(await f.storage.read()).toEqual(envelope);
  expect((await next.workflow.pending())[0].status).toBe('writing');
});

it.each(['normal', 'remote-drift', 'read-failure', 'cancel-response-loss'] as const)('cancels an uncommitted preparation safely: %s', async mode => {
  const f = await fixture();
  if (mode === 'remote-drift') {
    const create = f.recovery.create.bind(f.recovery), read = f.read.getMockImplementation()!;
    vi.spyOn(f.recovery, 'create').mockImplementationOnce(async capsule => {
      const saved = await create(capsule);
      f.read.mockImplementation(async () => ({ ...await read(), etag: '"new-peer"' }));
      return saved;
    });
  } else vi.spyOn(f.files, 'save').mockRejectedValueOnce(new Error('Synthetic before file commit'));
  await expect(f.workflow.resolve('kp', f.request)).rejects.toThrow(mode === 'remote-drift' ? '预览' : 'before file commit');
  expect((await f.workflow.pending())[0].status).toBe('writing');
  const file = await f.files.read('kp'), capsule = await f.recovery.read('kp', f.request.operationId);
  expect(capsule).toBeDefined();
  const next = await f.restart();
  if (mode === 'read-failure') {
    vi.spyOn(f.files, 'readReceipt').mockRejectedValueOnce(new Error('Synthetic unreadable receipts'));
    await expect(next.workflow.cancel(f.request.operationId)).rejects.toThrow('unreadable receipts');
    expect((await next.workflow.pending())[0].status).toBe('writing');
  }
  if (mode === 'cancel-response-loss') {
    const write = f.storage.write.bind(f.storage);
    vi.spyOn(f.storage, 'write').mockImplementationOnce(async envelope => { await write(envelope); throw new Error('Synthetic cancel response loss'); });
    await expect(next.workflow.cancel(f.request.operationId)).rejects.toThrow('cancel response loss');
  }
  const again = await f.restart();
  expect((await again.workflow.cancel(f.request.operationId)).status).toBe('cancelled');
  await expect(again.workflow.assertProviderReady('kp')).resolves.toBeUndefined();
  expect((await again.vault.readState()).items).toEqual(f.rows);
  expect(await f.files.read('kp')).toEqual(file);
  expect(await f.recovery.read('kp', f.request.operationId)).toEqual(capsule);
  expect((await again.workflow.resume(f.request.operationId)).status).toBe('cancelled');
  const review = await again.workflow.review('kp');
  expect(review.projects).toHaveLength(1);
});

it('refuses cancellation after a file commit even when its response was lost', async () => {
  const f = await fixture(), resolve = f.remote.resolveProjectConflicts.bind(f.remote);
  vi.spyOn(f.remote, 'resolveProjectConflicts').mockImplementationOnce(async (...args) => {
    await resolve(...args); throw new Error('Synthetic committed response loss');
  });
  await expect(f.workflow.resolve('kp', f.request)).rejects.toThrow('committed response loss');
  const next = await f.restart();
  await expect(next.workflow.cancel(f.request.operationId)).rejects.toThrow('已经提交');
  expect((await next.workflow.pending())[0].status).toBe('writing');
  expect((await next.workflow.resume(f.request.operationId)).status).toBe('completed');
});

it('only deletes the selected terminal recovery copy and retains the operation receipt for replay', async () => {
  const f = await fixture();
  await f.workflow.resolve('kp', f.request);
  const [copy] = await f.workflow.recoveryCopies('kp'); expect(copy.canDelete).toBe(true);
  const file = await f.files.read('kp'), vault = await f.storage.read();
  await expect(f.workflow.deleteRecoveryCopy('kp', copy.operationId, 'f'.repeat(64))).rejects.toThrow('已变化');
  expect(await f.recovery.read('kp', copy.operationId)).toBeDefined();
  expect(await f.workflow.deleteRecoveryCopy('kp', copy.operationId, copy.intentTag)).toEqual({ deleted: true });
  expect(await f.workflow.deleteRecoveryCopy('kp', copy.operationId, copy.intentTag)).toEqual({ deleted: false });
  expect(await f.workflow.recoveryCopies('kp')).toEqual([]);
  expect(await f.files.read('kp')).toEqual(file); expect(await f.storage.read()).toEqual(vault);
  expect((await (await f.restart()).workflow.resolve('kp', f.request)).status).toBe('completed');
});

it('protects pending recovery copies, then allows deletion after verified cancellation', async () => {
  const f = await fixture();
  vi.spyOn(f.files, 'save').mockRejectedValueOnce(new Error('Synthetic before file'));
  await expect(f.workflow.resolve('kp', f.request)).rejects.toThrow('before file');
  const [copy] = await f.workflow.recoveryCopies('kp'); expect(copy.canDelete).toBe(false);
  await expect(f.workflow.deleteRecoveryCopy('kp', copy.operationId, copy.intentTag)).rejects.toThrow('仍需要');
  expect(await f.recovery.read('kp', copy.operationId)).toBeDefined();
  await f.workflow.cancel(copy.operationId);
  expect((await f.workflow.recoveryCopies('kp'))[0].canDelete).toBe(true);
  await f.workflow.deleteRecoveryCopy('kp', copy.operationId, copy.intentTag);
  expect((await f.vault.readState()).items).toEqual(f.rows);
});

it('exports a pending recovery without completing or changing it, and refuses export across vault lock', async () => {
  const f = await fixture();
  vi.spyOn(f.files, 'save').mockRejectedValueOnce(new Error('Synthetic before file'));
  await expect(f.workflow.resolve('kp', f.request)).rejects.toThrow('before file');
  const [copy] = await f.workflow.recoveryCopies('kp');
  const fileBefore = await f.files.read('kp'), vaultBefore = await f.storage.read(), capsuleBefore = await f.recovery.read('kp', copy.operationId);
  const exported = await f.workflow.exportRecoveryCopy('kp', copy.operationId, copy.intentTag, 'Synthetic separate backup password');
  const opened = await kdbxweb.Kdbx.load(exported.slice().buffer, keePassCredentials('Synthetic separate backup password'));
  expect(opened.getDefaultGroup().entries).toHaveLength(4);
  expect(await f.files.read('kp')).toEqual(fileBefore); expect(await f.storage.read()).toEqual(vaultBefore);
  expect(await f.recovery.read('kp', copy.operationId)).toEqual(capsuleBefore);
  const read = f.recovery.read.bind(f.recovery);
  vi.spyOn(f.recovery, 'read').mockImplementationOnce(async (...args) => { const result = await read(...args); await f.vault.lock(); return result; });
  await expect(f.workflow.exportRecoveryCopy('kp', copy.operationId, copy.intentTag, 'Synthetic separate backup password')).rejects.toThrow();
  expect(await f.files.read('kp')).toEqual(fileBefore); expect(await f.recovery.read('kp', copy.operationId)).toEqual(capsuleBefore);
});
