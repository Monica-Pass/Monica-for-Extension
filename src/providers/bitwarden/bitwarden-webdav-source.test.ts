import { expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { createEmptyVaultState, createLoginItem, type LoginItem, type ProviderAccount } from '../../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { readAndroidBackup, vaultItemToAndroidRecord } from '../webdav/android-backup-codec';
import { createPasskey } from '../../passkey/webauthn-core';
import { BitwardenWebDavSources } from './bitwarden-webdav-source';
import { readBitwardenBatchResource } from './bitwarden-batch-resource';
import { decodeBitwardenCipher } from './bitwarden-cipher-codec';

const stamp = '2026-10-12T00:00:00.000Z', fileName = 'monica_backup_20261012.enc.zip';
const group = '00000000-0000-4000-8000-000000000001';
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(value => value.toString(16).padStart(2,'0')).join('');
async function fixture(options: { passkey?: boolean; group?: boolean; rawPatch?: Record<string, unknown>; history?: unknown[]; attachmentPatch?: Record<string, unknown>; emptyFile?: boolean } = {}) {
  const account: ProviderAccount = { id: 'dav', name: 'Synthetic', kind: 'monica-webdav', enabled: true, isDefaultSaveTarget: false,
    config: { baseUrl: 'https://example.test/dav', username: 'synthetic', password: 'synthetic', lastFileName: fileName, lastEtag: '"revision"' } };
  const generated = options.passkey ? await createPasskey({ origin: 'https://example.test', challenge: Buffer.alloc(32, 7).toString('base64url'), rpName: 'Synthetic',
    userId: 'dXNlcg', userName: 'user', userDisplayName: 'User', algorithms: [-7], excludeCredentialIds: [] }) : undefined;
  const login = { ...createLoginItem({ title: 'Synthetic', password: 'current', username: 'user', uris: ['https://example.test'] }),
    email: 'synthetic@example.test', createdAt: stamp, updatedAt: stamp, categoryName: 'Accounts', categoryId: 5,
    customFields: [{ name: 'Recovery', value: 'first', protected: true }, { name: 'Recovery', value: 'second', protected: true }],
    ...(options.group ? { passwordGroupId: group } : {}) };
  if (options.group) login.customFields.push({ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId: group,
    groupId: group, passwordId: group, label: 'Accounts', primary: true, groupOrder: 0, passwordOrder: 0 }) });
  const source = generated ? { id: 'key', kind: 'passkey' as const, title: 'Synthetic', notes: '', favorite: false, providerRefs: [], createdAt: stamp, updatedAt: stamp,
    credentialId: generated.credentialId, rpId: 'example.test', rpName: 'Synthetic', userHandle: 'dXNlcg', userName: 'user', userDisplayName: 'User', algorithm: -7,
    publicKey: generated.publicKeySpki, privateKeyPkcs8: generated.privateKeyPkcs8, signCount: 0, discoverable: false, userVerificationRequired: true, sourceMode: 'browser-local' as const } : login;
  const raw = { ...vaultItemToAndroidRecord(source, undefined, undefined, { allowPortablePasskeys: true }), id: 42, ...options.rawPatch };
  const entryPath = generated ? 'passkeys/passkey_42.json' : 'passwords/password_42.json';
  const data = options.emptyFile ? new Uint8Array(0) : Uint8Array.of(1,2,3), sha = await digest(data);
  const attachment = { parentPasswordId: 42, payloadPath: 'attachments_portable/test.bin', sizeBytes: data.length, fileName: 'recovery.txt', sha256Hex: sha, ...options.attachmentPatch };
  const archive: Record<string, Uint8Array> = { [entryPath]: strToU8(JSON.stringify(raw)) };
  if (!generated) {
    archive['attachments_portable/attachments_portable.json'] = strToU8(JSON.stringify({ version: 2, entries: [attachment] }));
    archive[attachment.payloadPath] = data.slice();
    archive['password_history.json'] = strToU8(JSON.stringify(options.history || [{ entryId: 42, password: 'older', lastUsedAt: 0 }]));
  }
  if (options.group) archive['passwords/password_43.json'] = strToU8(JSON.stringify({ ...raw, id: 43, title: 'Sibling' }));
  const document = readAndroidBackup(zipSync(archive), account.id, { allowPortablePasskeys: true, allowPortableAttachments: true });
  const state = createEmptyVaultState(stamp); state.providers = [account]; state.items = structuredClone(document.items);
  for (const item of state.items) item.providerRefs[0] = { ...item.providerRefs[0], revision: item.updatedAt, etag: '"revision"' };
  const item = state.items[0], provider = { readTransferSnapshot: vi.fn(async () => ({ document, sha256: sha, file: { name: fileName,
    url: `https://example.test/dav/Monica_Backups/${fileName}`, encrypted: true, etag: '"revision"' } })) }, current = vi.fn(async () => {});
  const reader = new BitwardenWebDavSources(provider);
  const read = () => reader.read(state, account, item, true, current);
  const resource = () => readBitwardenBatchResource(state, [item], true, { context: async () => { throw new Error('Unexpected BW'); }, files: async () => [],
    portableSource: (account, item, preserve) => reader.read(state, account, item, preserve, current) });
  return { account, state, item, generated, document, provider, current, reader, read, resource };
}

it('preserves raw password content, duplicate protected fields, epoch-zero history and file bytes', async () => {
  const f = await fixture(), result = await f.resource();
  try { expect(result.path).toEqual(['Accounts']); expect(result.files[0].dataBase64).toBe('AQID');
    expect((await decodeBitwardenCipher(result.raw, 'target', result.ownerKey)).items[0]).toMatchObject({ password: 'current', email: 'synthetic@example.test',
      customFields: [{ name: 'Recovery', value: 'first', protected: true }, { name: 'Recovery', value: 'second', protected: true }],
      passwordHistory: [{ password: 'older', lastUsedAt: '1970-01-01T00:00:00.000Z' }] });
  } finally { result.dispose(); }
});

it('copies an encrypted-backup portable Passkey without changing original bytes or zero', async () => {
  const f = await fixture({ passkey: true }), result = await f.resource();
  try { expect((await decodeBitwardenCipher(result.raw, 'target', result.ownerKey)).items.find(row => row.kind === 'passkey')).toMatchObject({
    credentialId: f.generated!.credentialId, privateKeyPkcs8: f.generated!.privateKeyPkcs8, signCount: 0, discoverable: false });
  } finally { result.dispose(); }
});

it('retains a valid empty attachment with its empty-content checksum', async () => {
  const f = await fixture({ emptyFile: true }), result = await f.resource();
  try { expect(result.files).toHaveLength(1); expect(result.files[0]).toMatchObject({ sizeBytes: 0, dataBase64: '', sha256: await digest(new Uint8Array(0)) }); }
  finally { result.dispose(); }
});

it('accepts the redundant attachment ID written by the native archive writer', async () => {
  const f = await fixture({ attachmentPatch: { attachmentId: 'android-portable:attachments_portable/test.bin' } }), result = await f.resource();
  try { expect(result.files[0].dataBase64).toBe('AQID'); } finally { result.dispose(); }
});

it('refuses a lock while the archive is downloading', async () => {
  const f = await fixture();
  f.provider.readTransferSnapshot.mockImplementationOnce(async () => {
    f.current.mockRejectedValue(new Error('Locked during download'));
    return { document: f.document, sha256: '', file: { name: fileName, url: 'https://example.test/dav/Monica_Backups/' + fileName, encrypted: true, etag: '"revision"' } };
  });
  await expect(f.resource()).rejects.toThrow('Locked during download');
});

it('loads a whole archive only once per state, then reloads for a new preview or execution', async () => {
  const f = await fixture({ group: true }); await f.read(); await f.reader.read(f.state, f.account, f.state.items[1], true, f.current);
  expect(f.provider.readTransferSnapshot).toHaveBeenCalledTimes(1);
  await f.reader.read(structuredClone(f.state), f.account, f.item, true, f.current); expect(f.provider.readTransferSnapshot).toHaveBeenCalledTimes(2);
});

it.each(['new-member','missing-member','field-clear','revision','binding','lock'] as const)('refuses %s changes', async mode => {
  const f = await fixture({ group: true });
  if (mode === 'new-member') f.state.items = [f.item];
  if (mode === 'missing-member') f.document.items = [f.document.items[0]];
  if (mode === 'field-clear') delete (f.item as LoginItem).email;
  if (mode === 'revision') f.item.providerRefs[0].revision = stamp + 'changed';
  if (mode === 'binding') f.item.providerRefs[0].providerId = 'other';
  if (mode === 'lock') f.current.mockRejectedValueOnce(new Error('Locked'));
  await expect(f.read()).rejects.toThrow();
});

it.each([{ future: 'keep' }, { customFields: [{ title: 'Recovery', value: 'first', isProtected: true, future: 'keep' }] }])('refuses unprojected native raw data %#', async rawPatch => { const f = await fixture({ rawPatch }); await expect(f.resource()).rejects.toThrow('原生'); });

it.each([
  { history: [{ entryId: 42, password: 'older', lastUsedAt: 0, future: 'keep' }] },
  { history: [{ entryId: 42, unknown: 'history' }] },
  { history: [{ password: 'orphan', lastUsedAt: 0 }] }
])('refuses unrepresented history %#', async ({ history }) => { const f = await fixture({ history }); await expect(f.resource()).rejects.toThrow(); });

it.each([{ future: 'keep' }, { sizeBytes: 9 }, { sha256Hex: '0'.repeat(64) }, { parentSecureItemId: 42 }, { sizeBytes: -1 },
  { attachmentId: 'other' }, { mimeType: 42 }, { createdAt: 'invalid' }])('refuses unrepresented or corrupt attachment data %#', async attachmentPatch => { const f = await fixture({ attachmentPatch }); await expect(f.resource()).rejects.toThrow(); });

it('refuses hidden portable attachments in an unencrypted backup', async () => {
  const f = await fixture(); f.document.portableAttachmentsAllowed = false; await expect(f.read()).rejects.toThrow('unencrypted');
});

it('caches a failed load for the current batch, avoiding repeated full-download attempts', async () => {
  const f = await fixture(); f.provider.readTransferSnapshot.mockRejectedValue(new Error('Unavailable'));
  await expect(f.read()).rejects.toThrow('Unavailable'); await expect(f.read()).rejects.toThrow('Unavailable');
  expect(f.provider.readTransferSnapshot).toHaveBeenCalledTimes(1);
});
