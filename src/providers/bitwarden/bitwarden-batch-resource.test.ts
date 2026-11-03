import { expect, it } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createEmptyVaultState, createLoginItem, type LoginItem, type PasskeyItem, type VaultItem } from '../../core/model';
import { createPasskey, createAssertion } from '../../passkey/webauthn-core';
import { readBitwardenBatchResource } from './bitwarden-batch-resource';
import { decodeBitwardenCipher } from './bitwarden-cipher-codec';

const stamp = '2026-10-12T00:00:00.000Z';
async function generated(count = 0): Promise<PasskeyItem> {
  const key = await createPasskey({ origin: 'https://example.test', challenge: Buffer.alloc(32, 4).toString('base64url'), rpName: 'Example',
    userId: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic', algorithms: [-7], excludeCredentialIds: [] });
  return { id: 'local-passkey', kind: 'passkey', title: 'Example', notes: '', favorite: false, providerRefs: [], createdAt: stamp, updatedAt: stamp,
    credentialId: key.credentialId, rpId: key.rpId, rpName: 'Example', userHandle: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic',
    algorithm: -7, publicKey: key.publicKeySpki, privateKeyPkcs8: key.privateKeyPkcs8, signCount: count, discoverable: true,
    userVerificationRequired: true, transports: ['internal'], aaguid: '', lastUsedAt: stamp, useCount: 0, passkeyMode: 'BW_COMPAT', sourceMode: 'browser-local' };
}
async function resource(item: VaultItem) {
  const state = createEmptyVaultState(stamp); state.items = [item];
  return readBitwardenBatchResource(state, [item], false, { context: async () => { throw new Error('Unexpected remote read'); }, files: async () => [] });
}

it.each([0, 19, 0xffffffff])('preserves generated local Passkey material and counter %s, proven by independent verification', async count => {
  const original = await generated(count), snapshot = structuredClone(original);
  const result = await resource(original);
  try {
    const decoded = (await decodeBitwardenCipher(result.raw, 'target', result.ownerKey)).items.find(row => row.kind === 'passkey') as PasskeyItem;
    expect(decoded).toMatchObject({ credentialId: original.credentialId, signCount: count, userVerificationRequired: true });
    expect(Buffer.from(decoded.privateKeyPkcs8!, 'base64')).toEqual(Buffer.from(original.privateKeyPkcs8!, 'base64'));
    const assertion = await createAssertion({ origin: 'https://example.test', challenge: Buffer.alloc(32, 7).toString('base64url'),
      credentialId: decoded.credentialId, userHandle: decoded.userHandle, privateKeyPkcs8: decoded.privateKeyPkcs8!, signCount: decoded.signCount, userVerified: true });
    const auth = Buffer.from(assertion.response.authenticatorData, 'base64url'); expect(auth.readUInt32BE(33)).toBe(count);
    expect(auth[32] & 0x1c).toBe(0x1c);
    const signed = Buffer.concat([auth, createHash('sha256').update(Buffer.from(assertion.response.clientDataJSON, 'base64url')).digest()]);
    expect(verify('sha256', signed, createPublicKey({ key: Buffer.from(original.publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
    expect(original).toEqual(snapshot);
  } finally { result.dispose(); }
  expect(result.ownerKey.encKey.every(byte => byte === 0)).toBe(true);
});

it('accepts explicit native backup flags and Base64URL encodings without rewriting the source', async () => {
  const key = await generated(); key.backupEligible = key.backupState = true;
  key.publicKey = Buffer.from(key.publicKey, 'base64').toString('base64url'); key.privateKeyPkcs8 = Buffer.from(key.privateKeyPkcs8!, 'base64').toString('base64url');
  const original = structuredClone(key), result = await resource(key); result.dispose(); expect(key).toEqual(original);
});

it('accepts PEM private material with identical DER and a missing optional public key', async () => {
  const key = await generated(); key.publicKey = ''; key.privateKeyPkcs8 = `-----BEGIN PRIVATE KEY-----\n${key.privateKeyPkcs8}\n-----END PRIVATE KEY-----`;
  const result = await resource(key); result.dispose();
});

it.each(['different', 'malformed'] as const)('refuses a %s source public key with a value-free error', async mode => {
  const key = await generated(); key.publicKey = mode === 'different' ? (await generated()).publicKey : 'sensitive-not-a-public-key';
  await expect(resource(key)).rejects.toThrow('publicKey 与原私钥匹配');
  await expect(resource(key)).rejects.not.toThrow(key.publicKey);
});

it.each([
  { backupEligible: false, backupState: false }, { backupState: false }, { userVerificationRequired: false },
  { transports: ['usb'] }, { aaguid: 'custom-registered-aaguid' }, { iconUrl: 'https://example.test/icon' },
  { title: 'Separate custom title' }, { signCount: -1 }, { signCount: 0x100000000 }, { algorithm: -257 }
] as Partial<PasskeyItem>[])('refuses unrepresentable Passkey policy/metadata %# without changing the original', async change => {
  const key = { ...await generated(), ...change }, before = structuredClone(key);
  await expect(resource(key)).rejects.toThrow(); expect(key).toEqual(before);
});

it('preserves Android password metadata, duplicate protected fields, URI rules and exact history', async () => {
  const item: LoginItem = { ...createLoginItem({ title: 'Rich synthetic password', username: 'synthetic', password: 'private-password',
    uris: ['https://example.test'], notes: 'First line\n第二行', favorite: true }), loginType: 'PASSWORD',
    appPackageName: 'test.example', appName: 'Example', email: 'user@example.test', phone: '+000123', addressLine: 'Synthetic street',
    city: 'City', state: 'State', zipCode: '1234', country: 'XX', passkeyBindings: '[{"credentialId":"AQID","unknown":17}]',
    customIconType: 'TEXT', customIconValue: 'E', customIconUpdatedAt: 17,
    uriRules: [{ uri: 'https://example.test', matchType: 'exact' }],
    customFields: [{ name: 'Recovery', value: 'one', protected: false, fieldType: 'HIDDEN' },
      { name: 'Recovery', value: 'two', protected: true }, { name: 'Label', value: 'Visible', protected: false, fieldType: 'TEXT' }],
    passwordHistory: [{ password: 'first', lastUsedAt: stamp }, { password: 'second', lastUsedAt: stamp }] };
  const before = structuredClone(item), result = await resource(item);
  try {
    const decoded = (await decodeBitwardenCipher(result.raw, 'target', result.ownerKey)).items[0] as LoginItem;
    expect(decoded).toMatchObject({ appPackageName: item.appPackageName, appName: item.appName, email: item.email, phone: item.phone,
      addressLine: item.addressLine, city: item.city, state: item.state, zipCode: item.zipCode, country: item.country,
      passkeyBindings: item.passkeyBindings, customIconType: item.customIconType, customIconValue: item.customIconValue,
      passwordHistory: item.passwordHistory, uriRules: item.uriRules,
      customFields: [{ name: 'Recovery', value: 'one', protected: true }, { name: 'Recovery', value: 'two', protected: true }, { name: 'Label', value: 'Visible', protected: false }] });
    expect(item).toEqual(before); expect(JSON.stringify(result.raw)).not.toContain('private-password');
  } finally { result.dispose(); }
});

it.each(['creditCardNumber','creditCardHolder','creditCardExpiry','creditCardCVV','barcodeData','steamRawJson','boundNoteEntryId'] as const)('refuses unsupported rich field %s instead of silently deleting it', async field => {
    const item = { ...createLoginItem({ title: 'Rich source' }), [field]: 'private-original-field-value' };
    await expect(resource(item)).rejects.toThrow(field);
    await expect(resource(item)).rejects.not.toThrow('private-original-field-value');
  });

it('does not turn an explicitly unlinked OTP into legacy automatic lookup', async () => {
  await expect(resource({ ...createLoginItem({ title: 'Unlinked' }), boundTotpItemId: '' })).rejects.toThrow('boundTotpItemId');
});
