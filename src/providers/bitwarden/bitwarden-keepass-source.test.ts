import { expect, it, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { createEmptyVaultState, type ProviderAccount, type LoginItem, type PasskeyItem } from '../../core/model';
import { buildKeePassFixture } from '../keepass/keepass-fixture';
import { openKeePassVault } from '../keepass/keepass-vault';
import { KeePassProvider } from '../keepass/keepass-provider';
import { createKeePassEntry } from '../keepass/keepass-writer';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { createPasskey } from '../../passkey/webauthn-core';
import { readKeePassBitwardenSource } from './bitwarden-keepass-source';
import { readBitwardenBatchResource } from './bitwarden-batch-resource';
import { decodeBitwardenCipher } from './bitwarden-cipher-codec';

const stamp = '2026-10-12T00:00:00.000Z', password = 'fixture master password';
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
async function fixture(options: { mutate?(entry: kdbxweb.KdbxEntry): void; passkey?: boolean; group?: boolean } = {}) {
  const bytes = await buildKeePassFixture({ entries: options.passkey ? [] : [0, ...(options.group ? [1] : [])].map(index => ({
    title: `Synthetic ${index}`, group: 'Accounts', fields: { UserName: 'user', URL: 'https://example.test', Notes: 'notes', 'App Name': 'App' },
    protectedFields: { Password: `secret-${index}`, Recovery: '  \n保留\t  ', ...(options.group ? { [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({
      version: 1, projectId: id(1), groupId: id(2), passwordId: id(3 + index), label: 'Accounts', primary: index === 0, groupOrder: 0, passwordOrder: index }) } : {}) }
  })) });
  const opened = await openKeePassVault(bytes, { password, providerId: 'source', databaseId: 1 });
  const generated = options.passkey ? await createPasskey({ origin: 'https://example.test', challenge: Buffer.alloc(32, 7).toString('base64url'),
    rpName: 'Synthetic', userId: 'dXNlcg', userName: 'user', userDisplayName: 'User', algorithms: [-7], excludeCredentialIds: [] }) : undefined;
  if (generated) createKeePassEntry(opened.database, { id: id(9), kind: 'passkey', title: 'Synthetic', notes: '', favorite: false, providerRefs: [],
    createdAt: stamp, updatedAt: stamp, credentialId: generated.credentialId, rpId: 'example.test', rpName: 'Synthetic', userHandle: 'dXNlcg', userName: 'user', userDisplayName: 'User',
    algorithm: -7, publicKey: generated.publicKeySpki, privateKeyPkcs8: generated.privateKeyPkcs8, signCount: 0, discoverable: false,
    userVerificationRequired: true, sourceMode: 'browser-local' });
  const originalEntry = generated ? opened.database.getDefaultGroup().entries[0] : [...opened.entriesByUuid.values()][0];
  options.mutate?.(originalEntry);
  const account: ProviderAccount = { id: 'source', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { databaseId: 1, sourceMode: 'local-file' } };
  const provider = new KeePassProvider(); await provider.unlock(account, new Uint8Array(await opened.database.save()), { password, sourceMode: 'local-file' });
  const state = createEmptyVaultState(stamp); state.providers = [account]; state.items = (await provider.sync(account, { localItems: [], now: stamp })).items;
  const item = state.items.find(row => row.title === 'Synthetic 0' || row.title === 'Synthetic')!;
  const dependencies = { provider, prepare: vi.fn(async () => {}), assertCurrent: vi.fn(async () => {}), files: {
    listSourceAttachments: vi.fn(async () => [{ attachmentId: 'file', fileName: 'synthetic.txt', sizeBytes: 3 }]),
    readSourceAttachment: vi.fn(async () => Uint8Array.of(1,2,3)) } };
  const resource = () => readBitwardenBatchResource(state, [item], true, { context: async () => { throw new Error('Unexpected BW read'); }, files: async () => [],
    portableSource: (account, item, preserve) => readKeePassBitwardenSource(state, account, item, preserve, dependencies) });
  return { account, provider, state, item, generated, dependencies, resource };
}

it('copies native password fields, whitespace, protection and files through Bitwarden', async () => {
  const f = await fixture(), snapshot = structuredClone(f.state), result = await f.resource();
  try {
    expect(result.path).toEqual(['Accounts']); expect(result.files[0].dataBase64).toBe('AQID');
    expect((await decodeBitwardenCipher(result.raw, 'target', result.ownerKey)).items[0]).toMatchObject({ kind: 'login', username: 'user', password: 'secret-0',
      appName: 'App', customFields: [{ name: 'Recovery', value: '  \n保留\t  ', protected: true }] });
    expect(f.state).toEqual(snapshot);
  } finally { result.dispose(); f.provider.lock(); }
});

it('retains original portable key bytes, credential ID, non-discoverability and zero counter', async () => {
  const f = await fixture({ passkey: true }), result = await f.resource();
  try { expect((await decodeBitwardenCipher(result.raw, 'target', result.ownerKey)).items.find(row => row.kind === 'passkey')).toMatchObject({
    credentialId: f.generated!.credentialId, privateKeyPkcs8: f.generated!.privateKeyPkcs8, discoverable: false, signCount: 0 });
  } finally { result.dispose(); f.provider.lock(); }
});

it('accepts a missing redundant local database scope and derived Passkey labels', async () => {
  const f = await fixture({ passkey: true }); delete f.item.keepassDatabaseId;
  (f.item as PasskeyItem).keyAlgorithm = 'ECDSA'; (f.item as PasskeyItem).aaguid = '';
  const result = await f.resource(); result.dispose(); f.provider.lock();
});

it('accepts an equivalent hidden field type while retaining the original protection', async () => {
  const f = await fixture(); (f.item as LoginItem).customFields[0].fieldType = 'HIDDEN';
  const result = await f.resource(); result.dispose(); f.provider.lock();
});

it('refuses a changed custom-field value or protection', async () => {
  for (const patch of [{ protected: false }, { value: '' }, { fieldType: 'BOOLEAN' as const }]) {
    const f = await fixture(); Object.assign((f.item as LoginItem).customFields[0], patch);
    try { await expect(f.resource()).rejects.toThrow('customFields'); } finally { f.provider.lock(); }
  }
});

it.each(['database','algorithm','aaguid'] as const)('still refuses conflicting explicit %s metadata', async field => {
  const f = await fixture({ passkey: true });
  if (field === 'database') f.item.keepassDatabaseId = 99;
  if (field === 'algorithm') (f.item as PasskeyItem).keyAlgorithm = 'unknown';
  if (field === 'aaguid') (f.item as PasskeyItem).aaguid = id(5);
  try { await expect(f.resource()).rejects.toThrow('字段已变化'); } finally { f.provider.lock(); }
});

it('converts password-only native history without losing the current password', async () => {
  const f = await fixture({ mutate: entry => { entry.pushHistory(); entry.history[0].fields.set('Password', kdbxweb.ProtectedValue.fromString('older'));
    entry.history[0].times.lastModTime = new Date(stamp); } });
  const result = await f.resource();
  try { expect((await decodeBitwardenCipher(result.raw, 'target', result.ownerKey)).items[0]).toMatchObject({ password: 'secret-0',
    passwordHistory: [{ password: 'older', lastUsedAt: stamp }] }); } finally { result.dispose(); f.provider.lock(); }
});

it.each(['history-notes','history-files','tags','custom-data','auto-type','expires','dual-passkey','unknown-passkey-json'] as const)('refuses unrepresented %s data before copying any files', async mode => {
    const f = await fixture({ passkey: mode === 'unknown-passkey-json', mutate: entry => {
      if (mode.startsWith('history')) { entry.pushHistory(); if (mode === 'history-notes') entry.history[0].fields.set('Notes', 'older');
        else entry.history[0].binaries.set('old.bin', Uint8Array.of(1).buffer); }
      if (mode === 'tags') entry.tags = ['native'];
      if (mode === 'custom-data') entry.customData = new Map([['future', { value: 'keep' }]]);
      if (mode === 'auto-type') entry.autoType.defaultSequence = '{PASSWORD}';
      if (mode === 'expires') entry.times.expires = true;
      if (mode === 'dual-passkey') entry.fields.set('KPEX_PASSKEY_PRIVATE_KEY_PEM', kdbxweb.ProtectedValue.fromString('must-not-drop'));
      if (mode === 'unknown-passkey-json') { const data = entry.fields.get('MonicaPasskeyData') as kdbxweb.ProtectedValue;
        entry.fields.set('MonicaPasskeyData', kdbxweb.ProtectedValue.fromString(JSON.stringify({ ...JSON.parse(data.getText()), future: 'keep' }))); }
    } });
    try { await expect(f.resource()).rejects.toThrow('KeePass'); expect(f.dependencies.files.readSourceAttachment).not.toHaveBeenCalled(); }
    finally { f.provider.lock(); }
  });

it.each(['password','removed-email','group','missing-member'] as const)('refuses stale %s indexed content', async mode => {
  const f = await fixture({ group: true });
  if (mode === 'password') (f.item as LoginItem).password = 'unsaved';
  if (mode === 'removed-email') delete (f.item as LoginItem).appName;
  if (mode === 'group') delete (f.item as LoginItem).passwordGroupId;
  if (mode === 'missing-member') f.state.items = [f.item];
  try { await expect(f.resource()).rejects.toThrow('KeePass'); } finally { f.provider.lock(); }
});

it.each(['lock','remove','config'] as const)('refuses %s during attachment reads', async mode => {
  const f = await fixture(); f.dependencies.files.readSourceAttachment.mockImplementationOnce(async () => {
    if (mode === 'lock') f.provider.lock();
    if (mode === 'remove') await f.provider.remove(f.account, f.item);
    if (mode === 'config') f.dependencies.assertCurrent.mockRejectedValue(new Error('Changed source'));
    return Uint8Array.of(1,2,3);
  });
  try { await expect(f.resource()).rejects.toThrow(); } finally { f.provider.lock(); }
});
