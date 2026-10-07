import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem } from '../../core/model';
import { decodeMdbx2Object, encodeMdbx2Object } from './mdbx2-item-codec';
import { androidRecordToItem } from '../webdav/android-backup-codec';

const keys = ['email', 'phone', 'addressLine', 'city', 'state', 'zipCode', 'country', 'creditCardNumber', 'creditCardHolder', 'creditCardExpiry', 'creditCardCVV'] as const;
const metadata = { headCommitId: 'synthetic', updatedAt: '2026-10-03T00:00:00Z' };

it('retains explicitly empty supplemental text when a newly saved native login is reopened', () => {
  const original: LoginItem = { ...createLoginItem({ title: 'API blank content', password: 'synthetic' }),
    ...Object.fromEntries(keys.map(key => [key, ''])) };
  const encoded = encodeMdbx2Object(original)!;
  const actual = decodeMdbx2Object({ objectId: 'synthetic', collectionId: 'passwords', objectTypeId: 'login',
    title: original.title, payloadSchemaVersion: 1, deleted: false, payloadJson: encoded.payloadJson }, metadata, 'native').item as LoginItem;
  for (const key of keys) expect(actual[key], key).toBe('');
});

it.each([undefined, '', '  synthetic\t文本\r\n  '])('preserves absent, empty and verbatim Android supplemental text: %j', value => {
  const raw = { id: 1, title: 'content', username: '', password: 'synthetic',
    ...Object.fromEntries(keys.filter(() => value !== undefined).map(key => [key, value])) };
  const actual = androidRecordToItem('folders/test/passwords/1.json', raw, 'zip') as LoginItem;
  for (const key of keys) expect(actual[key], key).toBe(value);
});
