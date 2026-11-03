import { expect, it, vi } from 'vitest';
import { createEmptyVaultState, createLoginItem, type ProviderAccount, type PasskeyItem } from '../../core/model';
import { decodeMdbx2Object, encodeMdbx2Object } from '../mdbx2/mdbx2-item-codec';
import { createPasskey } from '../../passkey/webauthn-core';
import { readMdbxBitwardenSource } from './bitwarden-mdbx-source';
import { MdbxBitwardenMembers } from './bitwarden-mdbx-members';
import { readBitwardenBatchResource } from './bitwarden-batch-resource';
import { decodeBitwardenCipher } from './bitwarden-cipher-codec';
import type { Mdbx2ObjectRecord, Mdbx2CollectionSummary } from '../mdbx2/native-contract';

const stamp = '2026-10-12T00:00:00.000Z';
async function fixture(payloadPatch: Record<string, unknown> = {}, passkey = false) {
  const account: ProviderAccount = { id: 'mdbx-source', kind: 'mdbx2', name: 'Source', enabled: true, isDefaultSaveTarget: false,
    config: { vaultHandle: 'native-session', nativeVaultId: 'source-vault' } };
  const local = { ...createLoginItem({ title: 'Synthetic password', username: 'synthetic', password: 'source-secret', uris: ['https://example.test'] }),
    appPackageName: 'test.example', email: 'user@example.test', city: 'City', customFields: [{ name: 'Recovery', value: 'first', protected: true },
      { name: 'Recovery', value: 'second', protected: true }], mdbxFolderId: 'child', createdAt: stamp, updatedAt: stamp };
  const generated = passkey ? await createPasskey({ origin: 'https://example.test', challenge: Buffer.alloc(32, 8).toString('base64url'), rpName: 'Synthetic',
    userId: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic', algorithms: [-7], excludeCredentialIds: [] }) : undefined;
  const source = generated ? { id: 'source-key', kind: 'passkey' as const, title: 'Synthetic', notes: '', favorite: false, providerRefs: [],
    createdAt: stamp, updatedAt: stamp, credentialId: generated.credentialId, rpId: 'example.test', rpName: 'Synthetic', userHandle: 'dXNlcg',
    userName: 'synthetic', userDisplayName: 'Synthetic', algorithm: -7, publicKey: generated.publicKeySpki, privateKeyPkcs8: generated.privateKeyPkcs8,
    signCount: 0, discoverable: false, userVerificationRequired: true, sourceMode: 'browser-local' as const } : local;
  const encoded = encodeMdbx2Object(source)!;
  let record: Mdbx2ObjectRecord = { objectId: 'source-object', collectionId: 'child', objectTypeId: encoded.objectTypeId,
    title: source.title, payloadSchemaVersion: 1, deleted: false, headCommitId: 'head', payloadJson: JSON.stringify({ ...JSON.parse(encoded.payloadJson), ...payloadPatch }) };
  const item = decodeMdbx2Object(record, { headCommitId: 'head', updatedAt: stamp }, account.id).item!;
  const state = createEmptyVaultState(stamp); state.items = [item]; state.providers = [account];
  const folderState = { favorite: false, archived: false, attachmentCount: 0, headCommitId: 'head', deleted: false, updatedAt: stamp };
  let folders: Mdbx2CollectionSummary[] = [{ ...folderState, collectionId: 'parent', title: 'Accounts', groupId: 'root' },
    { ...folderState, collectionId: 'child', title: 'Games', groupId: 'parent' }];
  const bytes = new TextEncoder().encode('synthetic-file'), catalog = [{ attachmentId: 'file', fileName: 'recovery.txt', sizeBytes: bytes.length }];
  const dependencies = {
    members: new MdbxBitwardenMembers(),
    native: { vaultStatus: vi.fn(async () => ({ vaultHandle: 'native-session', vaultId: 'source-vault', open: true, available: true })),
      readWriteRevision: vi.fn(async () => ({ vaultId: 'source-vault', revisionSha256: 'revision' })),
      listObjects: vi.fn(async () => ({ items: [] })),
      revealObject: vi.fn(async () => structuredClone(record)) },
    collections: vi.fn(async () => structuredClone(folders)), assertCurrent: vi.fn(async () => {}),
    files: { listSourceAttachments: vi.fn(async () => structuredClone(catalog)), readSourceAttachment: vi.fn(async () => bytes.slice()) }
  };
  const read = () => readMdbxBitwardenSource(state, account, item, true, dependencies);
  const resource = () => readBitwardenBatchResource(state, [item], true, { context: async () => { throw new Error('Unexpected BW read'); }, files: async () => [],
    portableSource: (account, item, preserve) => readMdbxBitwardenSource(state, account, item, preserve, dependencies) });
  return { account, state, item, generated, dependencies, read, resource, setRecord: (patch: Partial<Mdbx2ObjectRecord>) => { record = { ...record, ...patch }; },
    renameFolder: () => { folders = folders.map(row => ({ ...row, title: row.title + ' changed' })); } };
}

it('copies authenticated MDBX content, duplicate fields and bytes through native Bitwarden encoding', async () => {
  const f = await fixture(), original = structuredClone(f.state), result = await f.resource();
  try {
    expect(result.path).toEqual(['Accounts','Games']); expect(result.files).toMatchObject([{ fileName: 'recovery.txt', itemId: f.item.id }]);
    const decoded = (await decodeBitwardenCipher(result.raw, 'target', result.ownerKey)).items[0];
    expect(decoded).toMatchObject({ title: 'Synthetic password', password: 'source-secret', appPackageName: 'test.example', email: 'user@example.test', city: 'City',
      customFields: [{ name: 'Recovery', value: 'first', protected: true }, { name: 'Recovery', value: 'second', protected: true }] });
    expect(f.state).toEqual(original); expect(f.dependencies.native.revealObject).toHaveBeenCalledTimes(2);
  } finally { result.dispose(); }
});

it('retains a non-discoverable MDBX Passkey with unchanged private key, credential ID and zero counter', async () => {
  const f = await fixture({}, true), result = await f.resource();
  try { const item = (await decodeBitwardenCipher(result.raw, 'target', result.ownerKey)).items.find(row => row.kind === 'passkey') as PasskeyItem;
    expect(item).toMatchObject({ credentialId: f.generated!.credentialId, privateKeyPkcs8: f.generated!.privateKeyPkcs8,
      discoverable: false, userVerificationRequired: true, signCount: 0 });
  } finally { result.dispose(); }
});

it('resolves an authenticated native root UUID as the unnamed root', async () => {
  const f = await fixture();
  f.dependencies.collections.mockResolvedValue([{ collectionId: 'child', title: '.monica-root', collectionTypeId: 'root',
    favorite: false, archived: false, attachmentCount: 0, headCommitId: 'head', deleted: false, updatedAt: stamp }]);
  const result = await f.resource();
  try { expect(result.path).toEqual([]); } finally { result.dispose(); }
});

it('does not mistake a missing native root UUID for an authenticated root', async () => {
  const f = await fixture(); f.dependencies.collections.mockResolvedValue([]);
  await expect(f.resource()).rejects.toThrow('层级不完整');
});

it.each([{ future_secret: 'do-not-lose' }, { custom_fields: [{ title: 'Recovery', value: 'secret', is_protected: true, future: 'do-not-lose' }] },
  { password: 'conflicting-alias' }, { bound_password_entry_id: 'password:unmapped' }])('refuses unprojected native data %#', async patch => {
  const f = await fixture(patch); await expect(f.resource()).rejects.toThrow('原生'); expect(f.dependencies.files.readSourceAttachment).not.toHaveBeenCalled();
});

it.each([{ headCommitId: undefined }, { headCommitId: 'newer' }, { objectId: 'other' }, { collectionId: 'other' }, { deleted: true }])('refuses stale, missing or wrong native identity %#', async patch => { const f = await fixture(); f.setRecord(patch); await expect(f.resource()).rejects.toThrow('原生来源已变化'); });

it('refuses a queued local edit before reading attachments', async () => {
  const f = await fixture(); if (f.item.kind === 'login') f.item.password = 'unsaved';
  await expect(f.resource()).rejects.toThrow('password'); expect(f.dependencies.files.readSourceAttachment).not.toHaveBeenCalled();
});

it('refuses a queued removal of an optional native field before reading attachments', async () => {
  const f = await fixture(); if (f.item.kind === 'login') delete f.item.email;
  await expect(f.resource()).rejects.toThrow('email'); expect(f.dependencies.files.readSourceAttachment).not.toHaveBeenCalled();
});

it.each(['record','folder','binding','lock','revision'] as const)('refuses %s changes during attachment reads', async mode => {
  const f = await fixture(), read = f.dependencies.files.readSourceAttachment.getMockImplementation()!;
  f.dependencies.files.readSourceAttachment.mockImplementationOnce(async () => {
    if (mode === 'record') f.setRecord({ headCommitId: 'newer' });
    if (mode === 'folder') f.renameFolder();
    if (mode === 'binding') f.dependencies.native.vaultStatus.mockResolvedValue({ vaultHandle: 'native-session', vaultId: 'other', open: true, available: true });
    if (mode === 'lock') f.dependencies.assertCurrent.mockRejectedValue(new Error('Locked'));
    if (mode === 'revision') f.dependencies.native.readWriteRevision.mockResolvedValue({ vaultId: 'source-vault', revisionSha256: 'newer' });
    return read();
  });
  await expect(f.resource()).rejects.toThrow();
});
