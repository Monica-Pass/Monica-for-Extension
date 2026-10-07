import { expect, it } from 'vitest';
import type { LoginItem } from '../../core/model';
import { decodeBitwardenCipher, encodeBitwardenCipher } from './bitwarden-cipher-codec';
import { encryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
const key: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(7), macKey: new Uint8Array(32).fill(9) };
const date = '2026-10-01T00:00:00.000Z';
const login = (): LoginItem => ({ id: 'local', kind: 'login', title: 'Icon account', username: 'user', password: 'secret', uris: [], customFields: [], favorite: false, notes: '', createdAt: date, updatedAt: date, providerRefs: [] });
const read = async (raw: Record<string, unknown>) => (await decodeBitwardenCipher({ ...raw, id: 'remote', revisionDate: date, creationDate: date }, 'new-source', key)).items[0] as LoginItem;

it.each(['EMOJI', 'SIMPLE_ICON', 'FUTURE_ICON'])('retains %s through encrypted create, reconnect, edit and explicit clear', async type => {
  const original = { ...login(), customIconType: type, customIconValue: type === 'EMOJI' ? '🔐' : 'github', customIconUpdatedAt: 1790812800000 };
  const raw = await encodeBitwardenCipher(original, key);
  expect(JSON.stringify(raw)).not.toContain('monica_custom_icon');
  const decoded = await read(raw);
  expect(decoded).toMatchObject({ customIconType: type, customIconValue: original.customIconValue, customIconUpdatedAt: original.customIconUpdatedAt });
  expect(decoded.customFields).toEqual([]);
  const renamedRaw = await encodeBitwardenCipher({ ...decoded, title: 'Renamed' }, key, raw);
  const renamed = await read(renamedRaw);
  expect(renamed.customIconValue).toBe(original.customIconValue);
  const clearedRaw = await encodeBitwardenCipher({ ...renamed, customIconType: 'NONE', customIconValue: undefined, customIconUpdatedAt: 1790812800001 }, key, renamedRaw);
  expect(await read(clearedRaw)).toMatchObject({ customIconType: 'NONE', customIconUpdatedAt: 1790812800001 });
  expect((await read(clearedRaw)).customIconValue).toBeUndefined();
});

it('retains custom icons on native SSH Cipher type 5', async () => {
  const raw = { id: 'ssh', type: 5, name: await encryptBitwardenString('SSH', key), sshKey: { publicKey: await encryptBitwardenString('ssh-ed25519 AAAA', key) } };
  const decoded = await read(raw);
  const updated = await encodeBitwardenCipher({ ...decoded, customIconType: 'EMOJI', customIconValue: '🔑', customIconUpdatedAt: 10 }, key, raw);
  expect(updated.type).toBe(5);
  expect(await read(updated)).toMatchObject({ customIconType: 'EMOJI', customIconValue: '🔑', customIconUpdatedAt: 10 });
});

it('preserves unknown, linked and unsafe timestamp fields without projecting them into the icon', async () => {
  const base = await encodeBitwardenCipher(login(), key);
  const entries = await Promise.all([
    { name: 'monica_custom_icon_type', value: 'true', type: 2, linkedId: null },
    { name: 'monica_custom_icon_value', value: 'future linked value', type: 0, linkedId: 100 },
    { name: 'monica_custom_icon_updated_at', value: '9007199254740993', type: 1, linkedId: null }
  ].map(async field => ({ ...field, name: await encryptBitwardenString(field.name, key), value: await encryptBitwardenString(field.value, key), future: { retained: true } })));
  const raw = { ...base, fields: entries };
  const decoded = await read(raw);
  expect(decoded.customIconType).toBeUndefined();
  expect(decoded.customIconValue).toBeUndefined();
  expect(decoded.customIconUpdatedAt).toBeUndefined();
  const updated = await encodeBitwardenCipher({ ...decoded, title: 'Renamed' }, key, raw);
  expect(updated.fields).toEqual(entries);
  const replaced = await encodeBitwardenCipher({ ...decoded, customIconType: 'EMOJI', customIconValue: '🔑', customIconUpdatedAt: 100 }, key, raw);
  expect((replaced.fields as unknown[]).slice(0, 3)).toEqual(entries);
  expect(await read(replaced)).toMatchObject({ customIconType: 'EMOJI', customIconValue: '🔑', customIconUpdatedAt: 100 });
});
