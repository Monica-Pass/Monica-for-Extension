import { expect, it, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import type { ProviderAccount } from '../../core/model';
import { buildKeePassFixture, keePassCredentials } from './keepass-fixture';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { KeePassProvider } from './keepass-provider';
import { KeePassRemoteSessionService, type KeePassRemoteFileClient } from './keepass-remote-session';
import { MemoryKeePassWorkingCopyStorage } from './keepass-working-copy-store';
import { MemoryKeePassConflictRecoveryStorage } from './keepass-conflict-recovery-store';
import { createKeePassCacheEncryptionKey } from './keepass-receipt-crypto';
import { openKeePassConflictRecovery } from './keepass-conflict-recovery';

const password = 'Synthetic transaction password', projectId = '00000000-0000-4000-8000-000000000099';
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function fixture(choice: 'local' | 'remote' = 'local') {
  const baseBytes = await buildKeePassFixture({ password, entries: [0, 1].map(n => ({ title: 'Project', protectedFields: {
    Password: `secret-${n}`, [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({ version: 1, projectId, groupId: '00000000-0000-4000-8000-000000000001',
      passwordId: `00000000-0000-4000-8000-00000000001${n}`, label: 'Main', primary: true, groupOrder: 0, passwordOrder: n }) } })) });
  const local = await kdbxweb.Kdbx.load(baseBytes.slice().buffer, keePassCredentials(password));
  local.remove(local.getDefaultGroup().entries[0]);
  const localBytes = new Uint8Array(await local.save());
  const peer = await kdbxweb.Kdbx.load(baseBytes.slice().buffer, keePassCredentials(password));
  peer.getDefaultGroup().entries[1].fields.set('Notes', 'Peer note');
  const remote = { bytes: new Uint8Array(await peer.save()), etag: '"peer-1"' };
  const read = vi.fn(async () => ({ bytes: remote.bytes.slice(), etag: remote.etag, sha256: await digest(remote.bytes), fileName: 'vault.kdbx', url: 'http://127.0.0.1/vault.kdbx', sizeBytes: remote.bytes.length }));
  const write = vi.fn(async (bytes: Uint8Array, etag: string | null) => {
    if (etag !== remote.etag) throw new Error('Synthetic stale ETag');
    remote.bytes = bytes.slice(); remote.etag = '"published"';
    return { ...(await read()), alreadyApplied: false };
  });
  const client: KeePassRemoteFileClient = { read, write, stat: vi.fn(async () => ({ etag: remote.etag, fileName: 'vault.kdbx',
    url: 'http://127.0.0.1/vault.kdbx', sizeBytes: remote.bytes.length })), testConnection: vi.fn() };
  const account: ProviderAccount = { id: 'kp', kind: 'keepass', enabled: true, name: 'Synthetic', isDefaultSaveTarget: false,
    config: { sourceMode: 'webdav', databaseId: 1, databasePassword: password, webDavBaseUrl: 'http://127.0.0.1', remotePath: '/vault.kdbx', cacheEncryptionKey: createKeePassCacheEncryptionKey() } };
  const storage = new MemoryKeePassWorkingCopyStorage(), recovery = new MemoryKeePassConflictRecoveryStorage();
  await storage.save({ providerId: account.id, baseBytes, workingBytes: localBytes, baseSha256: await digest(baseBytes), workingSha256: await digest(localBytes), baseEtag: '"base"', updatedAt: '2026-10-06T00:00:00Z' }, 0);
  const sessions = new KeePassRemoteSessionService(new KeePassProvider(), storage, () => client);
  const review = await sessions.reviewProjectConflicts(account);
  const request = { operationId: 'resolve-project', reviewToken: review.reviewToken, choices: [{ projectId, choice }] };
  return { account, storage, recovery, sessions, request, remote, read, write, baseBytes, localBytes };
}

it.each(['local', 'remote'] as const)('commits the selected %s file and receipt only after recoverable originals, and never replays over later edits', async choice => {
  const f = await fixture(choice), remoteBefore = f.remote.bytes.slice();
  const receipt = await f.sessions.resolveProjectConflicts(f.account, f.request, f.recovery);
  expect(receipt.kind).toBe('project-resolve');
  const saved = (await f.storage.read(f.account.id))!; expect(saved.revision).toBe(2); expect(saved.baseBytes).toEqual(remoteBefore);
  const capsule = await openKeePassConflictRecovery(f.account, (await f.recovery.read(f.account.id, f.request.operationId))!);
  expect(capsule.files.base).toEqual(f.baseBytes); expect(capsule.files.working).toEqual(f.localBytes); expect(capsule.files.remote).toEqual(remoteBefore);
  expect(capsule.files.resolved).toEqual(saved.workingBytes);
  const decoded = await kdbxweb.Kdbx.load(saved.workingBytes.slice().buffer, keePassCredentials(password));
  expect(decoded.getDefaultGroup().entries).toHaveLength(choice === 'local' ? 1 : 2);
  expect(f.remote.bytes).toEqual(remoteBefore); expect(f.write).not.toHaveBeenCalled();
  // A later working revision is never replaced by the old terminal receipt.
  decoded.getDefaultGroup().entries[0].fields.set('Notes', 'Later edit');
  const later = new Uint8Array(await decoded.save());
  await f.storage.save({ ...saved, workingBytes: later, workingSha256: await digest(later) }, saved.revision);
  f.read.mockClear();
  expect(await f.sessions.resolveProjectConflicts(f.account, f.request, f.recovery)).toEqual(receipt);
  expect(f.read).not.toHaveBeenCalled(); expect((await f.storage.read(f.account.id))!.workingBytes).toEqual(later);
  expect((await f.storage.read(f.account.id))!.revision).toBe(3);
});

it.each(['before-recovery', 'lost-recovery-response', 'before-file', 'lost-file-response'] as const)('recovers %s without another resolution or partial file', async mode => {
  const f = await fixture(), before = await f.storage.read(f.account.id);
  if (mode.includes('recovery')) {
    const create = f.recovery.create.bind(f.recovery);
    vi.spyOn(f.recovery, 'create').mockImplementationOnce(async input => {
      if (mode === 'lost-recovery-response') await create(input);
      throw new Error('Synthetic interruption');
    });
  } else {
    const save = f.storage.save.bind(f.storage);
    vi.spyOn(f.storage, 'save').mockImplementationOnce(async (...args) => {
      if (mode === 'lost-file-response') await save(...args);
      throw new Error('Synthetic interruption');
    });
  }
  await expect(f.sessions.resolveProjectConflicts(f.account, f.request, f.recovery)).rejects.toThrow('Synthetic interruption');
  if (mode !== 'lost-file-response') expect(await f.storage.read(f.account.id)).toEqual(before);
  expect((await f.sessions.resolveProjectConflicts(f.account, f.request, f.recovery)).kind).toBe('project-resolve');
  expect((await f.storage.read(f.account.id))!.revision).toBe(2); expect(await f.recovery.list(f.account.id)).toHaveLength(1);
});

it.each(['local', 'remote'] as const)('rejects %s changes during recovery preparation and retains the recovery capsule', async side => {
  const f = await fixture(), create = f.recovery.create.bind(f.recovery);
  vi.spyOn(f.recovery, 'create').mockImplementationOnce(async input => {
    const saved = await create(input);
    if (side === 'remote') f.remote.etag = '"new-peer"';
    else { const record = (await f.storage.read(f.account.id))!; await f.storage.save(record, record.revision); }
    return saved;
  });
  await expect(f.sessions.resolveProjectConflicts(f.account, f.request, f.recovery)).rejects.toThrow();
  expect((await f.storage.read(f.account.id))!.revision).toBe(side === 'local' ? 2 : 1);
  expect(await f.storage.readReceipt(f.account.id, f.request.operationId)).toBeUndefined();
  expect(await f.recovery.list(f.account.id)).toHaveLength(1); expect(f.write).not.toHaveBeenCalled();
});

it.each(['local', 'remote'] as const)('publishes the committed %s choice using the reviewed remote baseline', async choice => {
  const f = await fixture(choice);
  await f.sessions.resolveProjectConflicts(f.account, f.request, f.recovery);
  const resolved = (await f.storage.read(f.account.id))!.workingBytes;
  expect((await f.sessions.publishWorkingCopy(f.account))?.status).toBe('uploaded');
  expect(f.write).toHaveBeenCalledTimes(1); expect(f.write.mock.calls[0][1]).toBe('"peer-1"');
  expect(f.remote.bytes).toEqual(resolved);
  const record = (await f.storage.read(f.account.id))!;
  expect(record.baseSha256).toBe(record.workingSha256); expect(await f.recovery.list(f.account.id)).toHaveLength(1);
});

it('rejects an outdated preview before retaining or changing any file', async () => {
  const f = await fixture(), before = await f.storage.read(f.account.id);
  f.remote.etag = '"new-peer"';
  await expect(f.sessions.resolveProjectConflicts(f.account, f.request, f.recovery)).rejects.toThrow('预览');
  expect(await f.recovery.list(f.account.id)).toEqual([]); expect(await f.storage.read(f.account.id)).toEqual(before);
});

it('rejects operation reuse for another choice or replacement source without rewriting the committed file', async () => {
  const f = await fixture();
  await f.sessions.resolveProjectConflicts(f.account, f.request, f.recovery);
  const before = await f.storage.read(f.account.id);
  await expect(f.sessions.resolveProjectConflicts(f.account, { ...f.request, choices: [{ projectId, choice: 'remote' }] }, f.recovery)).rejects.toThrow();
  await expect(f.sessions.resolveProjectConflicts({ ...f.account, config: { ...f.account.config, remotePath: '/another.kdbx' } }, f.request, f.recovery)).rejects.toThrow();
  expect(await f.storage.read(f.account.id)).toEqual(before);
});
