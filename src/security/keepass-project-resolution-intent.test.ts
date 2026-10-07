import { expect, it, vi } from 'vitest';
import { createLoginItem, type PasskeyItem, type ProviderAccount, type VaultItem } from '../core/model';
import { keePassProjectResolutionRequestHash } from '../providers/keepass/keepass-project-resolution';
import type { KeePassDurableMutationReceipt } from '../providers/keepass/keepass-working-copy-store';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

const master = 'Synthetic resolution master';
async function fixture(passkey = false) {
  const source: ProviderAccount = { id: 'kp', kind: 'keepass', enabled: true, name: 'Synthetic', isDefaultSaveTarget: false,
    config: { sourceMode: 'webdav', databaseId: 7, remotePath: '/vault.kdbx', databasePassword: 'Synthetic file secret' } };
  const login = { ...createLoginItem({ title: 'Project', password: 'Synthetic login secret' }), providerRefs: [{ providerId: 'kp', remoteId: 'entry' }] };
  const credential: PasskeyItem = { id: 'passkey', kind: 'passkey', title: 'Synthetic RP', notes: '', favorite: false,
    createdAt: login.createdAt, updatedAt: login.updatedAt, providerRefs: [{ providerId: 'kp', remoteId: 'credential' }],
    credentialId: '00112233-4455-6677-8899-aabbccddeeff', rpId: 'example.com', rpName: 'Example', userHandle: 'dXNlcg',
    userName: 'user', userDisplayName: 'User', algorithm: -7, publicKey: '', privateKeyPkcs8: '', signCount: 0,
    discoverable: true, sourceMode: 'browser-local', useCount: 9, lastUsedAt: login.createdAt };
  const rows: VaultItem[] = passkey ? [login, credential] : [login];
  const storage = new MemoryVaultStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup(master, rows); await service.upsertProvider(source);
  const request = { operationId: 'resolve-1', reviewToken: 'a'.repeat(64), choices: [{ projectId: 'project', choice: 'remote' as const }] };
  const receipt: KeePassDurableMutationReceipt = { providerId: 'kp', operationId: request.operationId, kind: 'project-resolve',
    intentSha256: await keePassProjectResolutionRequestHash(request), completedAt: '2026-10-06T00:00:00Z',
    result: { type: 'project-resolve', reviewToken: request.reviewToken, recoveryIntentTag: 'b'.repeat(64), baseSha256: 'c'.repeat(64), resolvedSha256: 'd'.repeat(64) } };
  const input = { source, request, originals: structuredClone(rows) };
  const result = { receipt, projectionSha256: 'd'.repeat(64), items: structuredClone(rows), sourceRecords: [] };
  const restart = async () => { const next = new SecureVaultService(storage, new MemoryVaultSessionStore()); await next.unlock(master); return next; };
  return { source, rows, input, result, service, storage, restart };
}

it('retains encrypted preparation across restart, supports cancellation only before writing', async () => {
  const f = await fixture();
  const intent = await f.service.stageKeePassProjectResolution(f.input);
  expect((await f.service.readState()).items).toEqual(f.rows);
  expect(JSON.stringify(f.storage.envelope)).not.toContain('Synthetic file secret');
  const next = await f.restart();
  expect(await next.readKeePassProjectResolutions()).toEqual([intent]);
  expect((await next.cancelKeePassProjectResolution('resolve-1')).status).toBe('cancelled');
  await expect(next.completeKeePassProjectResolution('resolve-1', f.result)).rejects.toThrow();
  f.input.request.operationId = 'resolve-2';
  await next.stageKeePassProjectResolution(f.input); await next.beginKeePassProjectResolution('resolve-2');
  await expect(next.cancelKeePassProjectResolution('resolve-2')).rejects.toThrow();
});

it.each(['before', 'after'] as const)('recovers atomic adoption when failure happens %s encrypted persistence', async mode => {
  const f = await fixture();
  await f.service.stageKeePassProjectResolution(f.input); await f.service.beginKeePassProjectResolution('resolve-1');
  f.result.items[0].notes = 'Resolved note';
  const write = f.storage.write.bind(f.storage);
  vi.spyOn(f.storage, 'write').mockImplementationOnce(async envelope => {
    if (mode === 'after') await write(envelope);
    throw new Error('Synthetic persistence fault');
  });
  await expect(f.service.completeKeePassProjectResolution('resolve-1', f.result)).rejects.toThrow('Synthetic persistence fault');
  const next = await f.restart(), before = await next.readState();
  expect(before.items[0].notes).toBe(mode === 'before' ? '' : 'Resolved note');
  expect((await next.readKeePassProjectResolutions())[0].status).toBe(mode === 'before' ? 'writing' : 'completed');
  await next.completeKeePassProjectResolution('resolve-1', f.result);
  await next.upsertItem({ ...f.result.items[0], notes: 'Later edit' });
  await next.completeKeePassProjectResolution('resolve-1', f.result);
  expect((await next.readState()).items[0].notes).toBe('Later edit');
});

it.each(['edit', 'source', 'receipt', 'projection', 'duplicate'] as const)('rejects %s drift without adopting anything', async mode => {
  const f = await fixture();
  await f.service.stageKeePassProjectResolution(f.input); await f.service.beginKeePassProjectResolution('resolve-1');
  if (mode === 'edit') await f.service.upsertItem({ ...f.rows[0], notes: 'Later edit' });
  if (mode === 'source') await f.service.upsertProvider({ ...f.source, config: { ...f.source.config, databaseId: 8 } });
  if (mode === 'receipt') f.result.receipt.intentSha256 = 'e'.repeat(64);
  if (mode === 'projection') f.result.projectionSha256 = 'e'.repeat(64);
  if (mode === 'duplicate') f.result.items.push(f.result.items[0]);
  const before = await f.storage.read();
  await expect(f.service.completeKeePassProjectResolution('resolve-1', f.result)).rejects.toThrow();
  expect(await f.storage.read()).toEqual(before);
});

it('retains local Passkey usage and a history-only observation even when the merge keeps local content', async () => {
  const f = await fixture(true);
  await f.service.stageKeePassProjectResolution(f.input); await f.service.beginKeePassProjectResolution('resolve-1');
  const incoming = f.result.items[1] as PasskeyItem;
  incoming.signCountHighWaterMark = 43; incoming.useCount = 0; delete incoming.lastUsedAt;
  await f.service.completeKeePassProjectResolution('resolve-1', f.result);
  expect((await (await f.restart()).readState()).items[1]).toMatchObject({ signCount: 0, signCountHighWaterMark: 43, useCount: 9, lastUsedAt: f.rows[1].createdAt });
});

it('adopts a resolved removal while retaining unrelated local records and rejecting a stale membership snapshot', async () => {
  const f = await fixture();
  const unrelated = createLoginItem({ title: 'Unrelated local account', password: 'Local secret' });
  await f.service.upsertItem(unrelated);
  const savedUnrelated = (await f.service.readState()).items.find(item => item.id === unrelated.id)!;
  await f.service.stageKeePassProjectResolution(f.input); await f.service.beginKeePassProjectResolution('resolve-1');
  f.result.items = [];
  await f.service.completeKeePassProjectResolution('resolve-1', f.result);
  expect((await (await f.restart()).readState()).items).toEqual([savedUnrelated]);
  f.input.request.operationId = 'resolve-2';
  await expect(f.service.stageKeePassProjectResolution(f.input)).rejects.toThrow('后续修改');
});

it('does not erase another source reference when the selected file removes a shared record', async () => {
  const f = await fixture();
  const shared = { ...f.rows[0], providerRefs: [...f.rows[0].providerRefs, { providerId: 'other', remoteId: 'other-entry' }] };
  // Load a pre-existing multi-source record without queuing a new edit.
  const storage = new MemoryVaultStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup(master, [shared]); await service.upsertProvider(f.source);
  f.input.originals = [shared];
  await service.stageKeePassProjectResolution(f.input); await service.beginKeePassProjectResolution('resolve-1');
  f.result.items = [];
  await expect(service.completeKeePassProjectResolution('resolve-1', f.result)).rejects.toThrow('其他密码源');
  expect((await service.readState()).items).toEqual([shared]);
});
