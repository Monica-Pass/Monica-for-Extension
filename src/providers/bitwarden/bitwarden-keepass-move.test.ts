import { expect, it, vi } from 'vitest';
import type { ProviderAccount, PasskeyItem } from '../../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { sameKeePassMoveFile } from '../../core/bitwarden-keepass-move';
import { readBitwardenBatches } from '../../core/bitwarden-batch-transfer';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../../security/vault-device-key';
import { bytesToBase64 } from '../../security/encoding';
import { createSourceRecord } from '../../core/source-records';
import { createPasskey } from '../../passkey/webauthn-core';
import { buildKeePassFixture } from '../keepass/keepass-fixture';
import { openKeePassVault } from '../keepass/keepass-vault';
import { createKeePassEntry, restoreKeePassEntry } from '../keepass/keepass-writer';
import { KeePassProvider } from '../keepass/keepass-provider';
import { KeePassLocalWorkingCopyService } from '../keepass/keepass-local-working-copy';
import { KeePassRemoteSessionService, type KeePassRemoteFileClient } from '../keepass/keepass-remote-session';
import { MemoryKeePassWorkingCopyStorage } from '../keepass/keepass-working-copy-store';
import { createKeePassCacheEncryptionKey } from '../keepass/keepass-receipt-crypto';
import { KeePassBitwardenMove } from '../keepass/keepass-bitwarden-move';
import { ProviderTransportError } from '../provider-transport';
import { decodeBitwardenCipher } from './bitwarden-cipher-codec';
import { readBitwardenBatchResource } from './bitwarden-batch-resource';
import { readKeePassBitwardenSource } from './bitwarden-keepass-source';
import { BitwardenBatchTransferCoordinator } from './bitwarden-batch-coordinator';
import type { BitwardenCopyRemote } from './bitwarden-transfer-execution';
import { ProviderOperationQueue } from '../../background/provider-operation-queue';

const password = 'Synthetic source password', stamp = '2026-10-12T00:00:00.000Z';
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(b => b.toString(16).padStart(2, '0')).join('');
async function fixture(mode: 'local-file' | 'webdav' | 'onedrive' = 'local-file') {
  const projectId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const initial = await buildKeePassFixture({ password, entries: [0, 1].map(n => ({ title: `Member ${n}`, fields: { UserName: 'user' },
    protectedFields: { Password: `original secret ${n}`, [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({ version: 1, projectId, groupId,
      passwordId: crypto.randomUUID(), label: 'Main', primary: n === 0, groupOrder: 0, passwordOrder: n }) } })) });
  const opened = await openKeePassVault(initial, { password, databaseId: 1, providerId: 'source' });
  const generated = await createPasskey({ origin: 'https://example.test', challenge: 'AQIDBAUGBwgJCgsMDQ4PEA', rpName: 'Synthetic', userId: 'BQYH', userName: 'user', userDisplayName: 'User', algorithms: [-7], excludeCredentialIds: [] });
  const keyItem: PasskeyItem = { id: crypto.randomUUID(), kind: 'passkey', title: 'Synthetic', favorite: false, notes: '', createdAt: stamp, updatedAt: stamp, providerRefs: [],
    credentialId: generated.credentialId, privateKeyPkcs8: generated.privateKeyPkcs8, publicKey: generated.publicKeySpki,
    rpId: 'example.test', rpName: 'Synthetic', userHandle: 'BQYH', userName: 'user', userDisplayName: 'User', algorithm: -7, signCount: 0,
    sourceMode: 'browser-local', discoverable: true, backupEligible: true, backupState: true };
  createKeePassEntry(opened.database, keyItem);
  const original = new Uint8Array(await opened.database.save()), originalHash = await digest(original);
  let remoteBytes = original.slice(), remoteSha = originalHash, remoteVersion = 1, publicationWrites = 0;
  const source: ProviderAccount = { id: 'source', kind: 'keepass', name: 'Synthetic source', enabled: true, isDefaultSaveTarget: false,
    config: { sourceMode: mode, databaseId: 1, localFileSourceSha256: mode === 'local-file' ? originalHash : undefined,
      cacheEncryptionKey: createKeePassCacheEncryptionKey(), databasePassword: mode === 'local-file' ? undefined : password,
      webDavBaseUrl: 'https://example.invalid', webDavUsername: 'synthetic', webDavPassword: 'synthetic', remotePath: '/source.kdbx',
      oneDriveDriveId: 'drive', oneDriveItemId: 'item', ...(mode === 'onedrive' ? { oneDriveConnection: { id: 'connection', clientId: 'client', profile: { id: 'user' } } } : {}) } };
  const stat = () => ({ url: 'https://example.invalid/source.kdbx', fileName: 'source.kdbx', etag: `"${remoteVersion}"`, sizeBytes: remoteBytes.length });
  const client: KeePassRemoteFileClient = {
    testConnection: async () => {},
    stat: async () => stat(), read: async () => ({ ...stat(), bytes: remoteBytes.slice(), sha256: remoteSha }),
    write: vi.fn(async (bytes, etag) => {
      const sha = await digest(bytes);
      if (sha === remoteSha) return { ...stat(), bytes: remoteBytes.slice(), sha256: sha, alreadyApplied: true };
      if (etag !== stat().etag) throw new ProviderTransportError('conflict', 'Remote changed', { retryable: false, operation: 'Synthetic write', attempts: 1 });
      remoteBytes = bytes.slice(); remoteSha = sha; remoteVersion++; publicationWrites++;
      return { ...stat(), bytes: remoteBytes.slice(), sha256: sha, alreadyApplied: false };
    })
  };
  let native = new KeePassProvider();
  const files = new MemoryKeePassWorkingCopyStorage();
  await native.unlock(source, original, { password, sourceMode: mode });
  const originals = (await native.sync(source, { now: stamp, localItems: [] })).items;
  await files.save({ providerId: source.id, baseBytes: original, workingBytes: original, baseSha256: originalHash, workingSha256: originalHash, baseEtag: stat().etag, updatedAt: stamp }, 0);
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), device = new MemoryVaultDeviceKeyStore();
  let vault = new SecureVaultService(storage, sessions, Date.now, device);
  await vault.setup('', originals); await vault.upsertProvider(source);
  const targetKey = { encKey: new Uint8Array(32).fill(3), macKey: new Uint8Array(32).fill(4) };
  const target: ProviderAccount = { id: 'target', kind: 'bitwarden', name: 'Target', enabled: true, isDefaultSaveTarget: false,
    config: { apiUrl: 'https://target.invalid/api', vaultKeyEnc: bytesToBase64(targetKey.encKey), vaultKeyMac: bytesToBase64(targetKey.macKey) } };
  await vault.upsertProvider(target);
  const raw: Record<string, unknown>[] = [];
  const remote: BitwardenCopyRemote & { dispose(): void } = {
    list: async () => structuredClone(raw), read: async id => structuredClone(raw.find(row => row.id === id) || null),
    create: vi.fn(async payload => { const row = { ...payload, id: `cipher-${raw.length}`, revisionDate: stamp }; raw.push(row); return structuredClone(row); }),
    upload: async () => { throw new Error('Unexpected file'); }, readFile: async () => { throw new Error('Unexpected file'); }, dispose() {}
  };
  const provider = { sync: vi.fn(async () => ({ items: [...(await vault.readState()).items.filter(row => !row.providerRefs.some(ref => ref.providerId === target.id)), ...(await Promise.all(raw.map(row => decodeBitwardenCipher(row, target.id, targetKey)))).flatMap(row => row.items)],
    conflicts: [], warnings: [], sourceRecords: await Promise.all(raw.map(row => createSourceRecord({ providerId: target.id, remoteId: String(row.id), revision: stamp, format: 'bitwarden-cipher', encoding: 'json', payload: JSON.stringify(row) }))) })) };
  let local = new KeePassLocalWorkingCopyService(native, files), cloud = new KeePassRemoteSessionService(native, files, () => client, () => client);
  const persistence = () => mode === 'local-file' ? local : cloud;
  const ensure = async (account: ProviderAccount) => {
    if (native.isUnlocked(account.id)) return;
    if (mode === 'local-file') await local.restore(account, { password }); else await cloud.restore(account);
  };
  let mover = new KeePassBitwardenMove(native, files, { ensure, persistence, reload: account => mode === 'local-file' ? local.reload(account) : cloud.restore(account), publish: (account, signal) => mode === 'local-file' ? local.publishWorkingCopy(account, signal) : cloud.publishWorkingCopy(account, signal, false) });
  const resource = vi.fn((state, items, preserve) => readBitwardenBatchResource(state, items, preserve, {
    context: async () => { throw new Error('Unexpected Bitwarden source'); }, files: async () => [],
    portableSource: (account, item, preserve) => readKeePassBitwardenSource(state, account, item, preserve, { provider: native, prepare: () => ensure(account), assertCurrent: async () => {},
      files: { listSourceAttachments: async () => [], readSourceAttachment: async () => { throw new Error('Unexpected file'); } } })
  }));
  const queue = new ProviderOperationQueue();
  const make = () => new BitwardenBatchTransferCoordinator(vault, provider, { resource, keepass: mover,
    folders: async () => [], folderRemote: () => ({ list: async () => [], create: async () => { throw new Error('Unexpected folder'); } }), remote: () => remote,
    exclusive: (id, work) => queue.run(id, work), exclusiveMany: (ids, work) => queue.runMany(ids, work) });
  let coordinator = make();
  return { source, target, storage, files, originals, keyItem, remote, provider, resource, client, original, targetKey, raw,
    get native() { return native; }, get mover() { return mover; }, get vault() { return vault; }, get coordinator() { return coordinator; },
    async setRemote(bytes: Uint8Array) { remoteBytes = bytes.slice(); remoteSha = await digest(bytes); remoteVersion++; },
    get publicationWrites() { return publicationWrites; }, get remoteBytes() { return remoteBytes.slice(); },
    async restart() {
      coordinator.clear(); native.lock(); native = new KeePassProvider(); vault = new SecureVaultService(storage, sessions, Date.now, device);
      local = new KeePassLocalWorkingCopyService(native, files); cloud = new KeePassRemoteSessionService(native, files, () => client, () => client);
      mover = new KeePassBitwardenMove(native, files, { ensure, persistence, reload: account => mode === 'local-file' ? local.reload(account) : cloud.restore(account), publish: (account, signal) => mode === 'local-file' ? local.publishWorkingCopy(account, signal) : cloud.publishWorkingCopy(account, signal, false) });
      coordinator = make();
    },
    input: { itemIds: originals.map(row => row.id), targetProviderId: target.id, action: 'move' as const, preserveCategories: false }
  };
}
async function planned(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = await f.coordinator.plan(f.input); expect(plan.items.map(row => row.blockedReason)).toEqual([undefined, undefined, undefined]);
  return { ...f.input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt, confirmed: true };
}

it.each(['local-file','webdav','onedrive'] as const)('moves a real %s project and original Passkey with durable source and publication confirmation', async mode => {
  const f = await fixture(mode), request = await planned(f);
  expect(await f.coordinator.execute(request)).toMatchObject({ completedCount: 3, action: 'move' });
  const state = await f.vault.readState(), group = state.bitwardenBatchTransfers![0].keepassMoves![0];
  expect(state.items).toHaveLength(4); expect(state.items.find(row => row.kind === 'passkey')).toMatchObject({ privateKeyPkcs8: f.keyItem.privateKeyPkcs8, credentialId: f.keyItem.credentialId, signCount: 0 });
  expect(group.deletion).toBeDefined(); expect(group.receipt).toBeDefined(); expect(group.publication).toBeDefined();
  const checkpoint = (await f.files.read(f.source.id))!, source = await openKeePassVault(checkpoint.workingBytes, { password, databaseId: 1, providerId: f.source.id });
  expect(source.items.filter(row => row.deletedAt)).toHaveLength(3);
  expect(source.items.find(row => row.kind === 'passkey')).toMatchObject({ privateKeyPkcs8: f.keyItem.privateKeyPkcs8, signCount: 0 });
  if (mode !== 'local-file') { expect(f.remoteBytes).toEqual(checkpoint.workingBytes); expect(f.publicationWrites).toBe(1); }
  await f.restart(); expect(await f.coordinator.execute(request)).toMatchObject({ completedCount: 3 }); expect(f.raw).toHaveLength(3);
});

it.each(['before-file','file-reply','receipt-save','publication','publication-save','adoption'] as const)('resumes a KeePass move after %s failure without copying again or refreshing the deletion request', async failure => {
  const f = await fixture('webdav'), request = await planned(f);
  if (failure === 'before-file') vi.spyOn(f.mover, 'remove').mockRejectedValueOnce(new Error('File unavailable'));
  else if (failure === 'file-reply' || failure === 'receipt-save') {
    const remove = f.mover.remove.bind(f.mover);
    vi.spyOn(f.mover, 'remove').mockImplementationOnce(async (...args) => { const result = await remove(...args);
      if (failure === 'file-reply') throw new Error('Lost source reply');
      vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Lost receipt persistence')); return result; });
  } else if (failure === 'publication') vi.spyOn(f.mover, 'publish').mockRejectedValueOnce(new Error('Cloud offline'));
  else if (failure === 'publication-save') vi.spyOn(f.vault, 'confirmBitwardenKeePassPublication').mockRejectedValueOnce(new Error('Publication receipt unavailable'));
  else vi.spyOn(f.vault, 'applyProviderSync').mockRejectedValueOnce(new Error('Adoption unavailable'));
  await expect(f.coordinator.execute(request)).rejects.toThrow();
  const state = await f.vault.readState(), deletion = state.bitwardenBatchTransfers![0].keepassMoves![0].deletion;
  expect(deletion).toBeDefined(); expect(state.items.map(row => row.id)).toEqual(f.originals.map(row => row.id));
  await expect(f.coordinator.keepBoth(f.target.id, request.operationId, true)).rejects.toThrow('删除');
  const reads = f.resource.mock.calls.length;
  await f.restart(); expect(await f.coordinator.execute(request)).toMatchObject({ completedCount: 3 });
  expect(f.resource).toHaveBeenCalledTimes(reads); expect(f.publicationWrites).toBe(1); expect(f.raw).toHaveLength(3);
  expect((await f.vault.readState()).bitwardenBatchTransfers![0].keepassMoves![0].deletion).toEqual(deletion);
});

it('preserves edited KeePass sources through explicit keep-both before any deletion authorization', async () => {
  const f = await fixture(), request = await planned(f), create = f.remote.create;
  vi.spyOn(f.remote, 'create').mockImplementationOnce(async payload => { await create(payload); throw new Error('Lost Cipher reply'); });
  await expect(f.coordinator.execute(request)).rejects.toThrow('Lost Cipher');
  const edited = { ...f.originals[0], notes: 'Later edit' }; await f.vault.upsertItem(edited);
  const choice = await f.coordinator.keepBoth(f.target.id, request.operationId, true); expect(choice).toMatchObject({ keptBoth: true, canKeepBoth: false });
  expect((await f.vault.readState()).bitwardenBatchTransfers![0].version).toBe(6);
  await f.restart(); expect(await f.coordinator.execute(request)).toMatchObject({ action: 'copy', completedCount: 3 });
  expect((await f.files.read(f.source.id))!.workingBytes).toEqual(f.original);
  expect((await f.vault.readState()).items.find(row => row.id === edited.id)).toMatchObject({ notes: 'Later edit' });
});

it('freezes sources, source aliases and ordinary sync after durable deletion authorization', async () => {
  const f = await fixture(), request = await planned(f);
  const alias = { ...f.source, id: 'alias' }; await f.vault.upsertProvider(alias);
  vi.spyOn(f.mover, 'remove').mockRejectedValueOnce(new Error('Source unavailable'));
  await expect(f.coordinator.execute(request)).rejects.toThrow('Source unavailable');
  const before = await f.storage.read();
  await expect(f.vault.upsertItem({ ...f.originals[0], notes: 'Later' })).rejects.toThrow();
  await expect(f.vault.removeProvider(f.source.id)).rejects.toThrow();
  await expect(f.vault.assertNoBitwardenKeePassMove(alias.id)).rejects.toThrow('待恢复');
  await expect(f.vault.applyProviderSync(f.source.id, [])).rejects.toThrow('恢复快照');
  expect(await f.storage.read()).toEqual(before);
});

it('does not finish after the source was externally restored following an interrupted file removal', async () => {
  const f = await fixture(), request = await planned(f);
  vi.spyOn(f.mover, 'publish').mockRejectedValueOnce(new Error('Interrupted'));
  await expect(f.coordinator.execute(request)).rejects.toThrow('Interrupted');
  const record = (await f.files.read(f.source.id))!, db = await openKeePassVault(record.workingBytes, { password, databaseId: 1, providerId: f.source.id });
  for (const entry of db.entriesByUuid.values()) restoreKeePassEntry(db.database, entry);
  const restored = new Uint8Array(await db.database.save());
  await f.files.save({ ...record, workingBytes: restored, workingSha256: await digest(restored) }, record.revision);
  await f.restart(); await expect(f.coordinator.execute(request)).rejects.toThrow('恢复或变化');
  expect((await f.files.read(f.source.id))!.workingBytes).toEqual(restored); expect((await f.vault.readState()).items).toHaveLength(3);
});

it('rejects downgraded journals and incomplete file/publication receipts', async () => {
  const f = await fixture(), request = await planned(f); await f.coordinator.execute(request);
  const batch = (await f.vault.readState()).bitwardenBatchTransfers![0];
  for (const version of [1, 2, 3, 4]) expect(() => readBitwardenBatches([{ ...batch, version }])).toThrow();
  for (const edit of [ { receipt: undefined }, { publication: undefined }, { deletion: undefined }, { receipt: { ...batch.keepassMoves![0].receipt, entries: [] } } ])
    expect(() => readBitwardenBatches([{ ...batch, keepassMoves: [{ ...batch.keepassMoves![0], ...edit }] }])).toThrow();
});

it.each(['deletion', 'receipt', 'publication'] as const)('rejects explicit null %s even in a pending or keep-both journal', async field => {
  const f = await fixture(), request = await planned(f);
  vi.spyOn(f.remote, 'create').mockRejectedValueOnce(new Error('Offline'));
  await expect(f.coordinator.execute(request)).rejects.toThrow('Offline');
  const batch = (await f.vault.readState()).bitwardenBatchTransfers![0];
  for (const kept of [false, true]) expect(() => readBitwardenBatches([{ ...batch,
    version: kept ? 6 : 5, resolution: kept ? { version: 1, kind: 'keep-both', originalVersion: 5, confirmedAt: stamp } : undefined,
    keepassMoves: [{ ...batch.keepassMoves![0], [field]: null }] }])).toThrow();
});

it('rejects multiple selected aliases of one file before creating any target', async () => {
  const f = await fixture(), alias = { ...f.source, id: 'alias', config: { ...f.source.config, databaseId: 2 } };
  await f.vault.upsertProvider(alias);
  const items = f.originals.map(item => ({ ...item, id: `alias-${item.id}`, keepassDatabaseId: 2,
    providerRefs: item.providerRefs.map(ref => ({ ...ref, providerId: alias.id })) }));
  await f.vault.importItems(items);
  const plan = await f.coordinator.plan({ ...f.input, itemIds: [...f.input.itemIds, ...items.map(row => row.id)] });
  expect(plan.transferableCount).toBe(0); expect(f.remote.create).not.toHaveBeenCalled();
  expect((await f.files.read(f.source.id))!.workingBytes).toEqual(f.original);
});

it('recognizes equivalent WebDAV URLs and credentials as the same physical file', async () => {
  const f = await fixture('webdav');
  expect(sameKeePassMoveFile(f.source, { ...f.source, id: 'alias', config: { ...f.source.config,
    webDavBaseUrl: 'https://EXAMPLE.invalid:443/', remotePath: '//source.kdbx/', webDavUsername: 'another-user' } })).toBe(true);
  expect(sameKeePassMoveFile(f.source, { ...f.source, id: 'other', config: { ...f.source.config, remotePath: '/other.kdbx' } })).toBe(false);
});

it.each(['history', 'file'] as const)('refuses %s changes after preview before any target write', async change => {
  const f = await fixture(), request = await planned(f);
  if (change === 'history') {
    // Native history edits do not change the indexed current password.
    const db = await openKeePassVault(f.original, { password, databaseId: 1, providerId: f.source.id });
    [...db.entriesByUuid.values()][0].pushHistory();
    await f.native.unlock(f.source, new Uint8Array(await db.database.save()), { password, sourceMode: 'local-file' });
  } else {
    const record = (await f.files.read(f.source.id))!;
    const db = await openKeePassVault(record.workingBytes, { password, databaseId: 1, providerId: f.source.id });
    const bytes = new Uint8Array(await db.database.save());
    await f.files.save({ ...record, workingBytes: bytes, workingSha256: await digest(bytes) }, record.revision);
  }
  await expect(f.coordinator.execute(request)).rejects.toThrow(); expect(f.remote.create).not.toHaveBeenCalled();
});

it('does not authorize source deletion when fresh target readback is incomplete', async () => {
  const f = await fixture(), request = await planned(f), sync = f.provider.sync.getMockImplementation()!;
  vi.spyOn(f.provider, 'sync').mockImplementation(async () => ({ ...await sync(), sourceRecords: [] }));
  await expect(f.coordinator.execute(request)).rejects.toThrow();
  expect((await f.files.read(f.source.id))!.workingBytes).toEqual(f.original);
  expect((await f.vault.readState()).bitwardenBatchTransfers![0].keepassMoves![0].deletion).toBeUndefined();
});

it('retains rotated OneDrive tokens across publication recovery while rejecting account replacement', async () => {
  const f = await fixture('onedrive'), request = await planned(f);
  vi.spyOn(f.mover, 'publish').mockRejectedValueOnce(new Error('Offline'));
  await expect(f.coordinator.execute(request)).rejects.toThrow('Offline');
  const current = (await f.vault.readState()).providers.find(row => row.id === f.source.id)!;
  const connection = { ...(current.config.oneDriveConnection as object), accessToken: 'synthetic-rotated', refreshToken: 'synthetic-new' };
  await f.vault.upsertProvider({ ...current, config: { ...current.config, oneDriveConnection: connection } });
  await expect(f.vault.upsertProvider({ ...current, config: { ...current.config, oneDriveConnection: { ...connection, id: 'other' } } })).rejects.toThrow();
  await f.restart(); await f.coordinator.execute(request);
  expect((await f.vault.readState()).providers.find(row => row.id === f.source.id)!.config.oneDriveConnection).toEqual(connection);
});

it.each(['before-publication', 'after-publication'] as const)('preserves an externally changed remote file %s without rebase or adoption', async when => {
  const f = await fixture('webdav'), request = await planned(f);
  if (when === 'before-publication') vi.spyOn(f.mover, 'publish').mockRejectedValueOnce(new Error('Offline'));
  else vi.spyOn(f.vault, 'applyProviderSync').mockRejectedValueOnce(new Error('Offline'));
  await expect(f.coordinator.execute(request)).rejects.toThrow('Offline');
  const db = await openKeePassVault(f.original, { password, databaseId: 1, providerId: f.source.id });
  [...db.entriesByUuid.values()][0].fields.set('Notes', 'New edit on another device');
  const edited = new Uint8Array(await db.database.save()); await f.setRemote(edited);
  await f.restart(); await expect(f.coordinator.execute(request)).rejects.toThrow();
  expect(f.remoteBytes).toEqual(edited); expect(f.publicationWrites).toBe(when === 'before-publication' ? 0 : 1);
  expect((await f.vault.readState()).bitwardenBatchTransfers![0].status).toBe('writing');
});

it('aborts publication on lock and resumes with the same file receipt after unlock', async () => {
  const f = await fixture('webdav'), request = await planned(f), publish = f.mover.publish.bind(f.mover);
  vi.spyOn(f.mover, 'publish').mockImplementationOnce(async (...args) => { f.coordinator.clear(); return publish(...args); });
  await expect(f.coordinator.execute(request)).rejects.toThrow(); expect(f.publicationWrites).toBe(0);
  await f.restart(); await f.coordinator.execute(request); expect(f.publicationWrites).toBe(1);
});
