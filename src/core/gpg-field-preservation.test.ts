import { expect, it } from 'vitest';
import { putGpgFields, readGpgFields } from './credential-fields';
import type { SecureCustomField } from './model';

const publicKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\r\nsynthetic\t公钥\r\n';
const field = (name: string, value: string): SecureCustomField => ({ name, value, protected: true });
const legacy = () => [
  field('before', 'retained'),
  { ...field('monica_gpg_fingerprint', 'old'), fieldType: 'HIDDEN' as const, id: 17, future: { v: 2 } },
  field('monica_gpg_public_0000', publicKey.slice(0, 23)),
  field('monica_gpg_type', 'GPG_KEY'),
  field('middle', 'retained'),
  field('monica_gpg_public_0001', publicKey.slice(23)),
  field('monica_gpg_user_id', 'old user'),
  field('after', 'retained'),
];

it.each(['monica_gpg_fingerprint', 'monica_gpg_user_id'])('edits only %s in a legacy GPG record', name => {
  const fields = legacy(), before = structuredClone(fields);
  const value = { ...readGpgFields(fields), [name.endsWith('fingerprint') ? 'fingerprint' : 'userId']: '  new\t值  ' };
  const actual = putGpgFields(fields, value);
  expect(actual).toEqual(fields.map(item => item.name === name ? { ...item, value: '  new\t值  ' } : item));
  expect(readGpgFields(actual)).toEqual(value);
  expect(fields).toEqual(before);
});

it('preserves base64 chunk boundaries and encoding attributes on a metadata edit', () => {
  const original = putGpgFields([], { publicKey, fingerprint: 'old', userId: 'old user' });
  const encoded = original.find(item => item.name === 'monica_gpg_public_0000')!.value;
  const fields = original.filter(item => !item.name.startsWith('monica_gpg_public_')).map(item => ({ ...item, protected: true }));
  fields.splice(1, 0, field('monica_gpg_public_0000', encoded.slice(0, 12)), field('middle', 'retained'));
  fields.push(field('monica_gpg_public_0001', encoded.slice(12)));
  const value = { ...readGpgFields(fields), userId: '' };
  expect(putGpgFields(fields, value)).toEqual(fields.map(item => item.name === 'monica_gpg_user_id' ? { ...item, value: '' } : item));
});

it('keeps an absent optional metadata field absent when editing the other one', () => {
  const fields = legacy().filter(item => item.name !== 'monica_gpg_user_id');
  expect(putGpgFields(fields, { ...readGpgFields(fields), fingerprint: 'new' }))
    .toEqual(fields.map(item => item.name === 'monica_gpg_fingerprint' ? { ...item, value: 'new' } : item));
});

it('replaces public chunks while retaining existing attributes and surrounding field order', () => {
  const fields = legacy(), value = { ...readGpgFields(fields), publicKey: 'replacement' };
  const actual = putGpgFields(fields, value);
  expect(readGpgFields(actual)).toEqual(value);
  expect(actual.filter(item => item.name !== 'monica_gpg_encoding')).toEqual(fields
    .filter(item => item.name !== 'monica_gpg_public_0001')
    .map(item => item.name === 'monica_gpg_public_0000' ? { ...item, value: btoa('replacement') } : item));
  const longer = putGpgFields(actual, { ...value, publicKey: 'synthetic'.repeat(900) });
  expect(longer.filter(item => item.name.startsWith('monica_gpg_public_')).every(item => item.protected)).toBe(true);
  expect(readGpgFields(longer).publicKey).toBe('synthetic'.repeat(900));
});

it.each(['monica_gpg_type', 'monica_gpg_fingerprint', 'monica_gpg_user_id'])('rejects duplicate %s without changing the source', name => {
  const fields = legacy(); fields.push({ ...fields.find(item => item.name === name)! });
  const before = structuredClone(fields);
  expect(() => putGpgFields(fields, { publicKey, fingerprint: 'new', userId: 'new' })).toThrow();
  expect(fields).toEqual(before);
});
