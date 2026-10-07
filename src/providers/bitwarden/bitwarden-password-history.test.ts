import { describe, expect, it } from 'vitest';
import { createLoginItem, type LoginItem } from '../../core/model';
import { encodeMdbx2Object } from '../mdbx2/mdbx2-item-codec';
import { buildKeePassLoginFields } from '../keepass/keepass-login-codec';
import { writeAndroidBackup } from '../webdav/android-backup-codec';
import { decodeBitwardenCipher, encodeBitwardenCipher } from './bitwarden-cipher-codec';
import { encryptBitwardenBytes, encryptBitwardenString, decryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';

const key: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(12), macKey: new Uint8Array(32).fill(23) };
const cipherKey: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(34), macKey: new Uint8Array(32).fill(45) };
const time = '2026-10-06T00:00:00.000Z';
async function fixture() {
  return { Id: 'history', Type: 1, Name: await encryptBitwardenString('History', cipherKey),
    Key: await encryptBitwardenBytes(new Uint8Array([...cipherKey.encKey, ...cipherKey.macKey]), key),
    Login: { Password: await encryptBitwardenString('current', cipherKey) },
    PasswordHistory: [{ Password: await encryptBitwardenString(' old\r\n', cipherKey), LastUsedDate: time, Future: { preserve: true } }] };
}
describe('Bitwarden native password history', () => {
  it('decrypts with the per-cipher key and copies through a different vault key', async () => {
    const raw = await fixture();
    const item = (await decodeBitwardenCipher(raw, 'source', key)).items[0] as LoginItem;
    expect(item.passwordHistory).toEqual([{ password: ' old\r\n', lastUsedAt: time }]);
    const exported = await encodeBitwardenCipher(item, key);
    const fresh = (await decodeBitwardenCipher({ ...exported, id: 'copy' }, 'target', key)).items[0] as LoginItem;
    expect(fresh.passwordHistory).toEqual(item.passwordHistory);
    expect(JSON.stringify(exported)).not.toContain(JSON.stringify(' old\r\n'));
  });

  it('keeps unchanged ciphertext, unknown properties, and unreadable entries through unrelated edits', async () => {
    const raw = await fixture();
    const unreadable = { Password: '2.future-format', LastUsedDate: time, Unknown: true };
    const mixed = { ...raw, PasswordHistory: [...raw.PasswordHistory, unreadable, null] };
    const decoded = await decodeBitwardenCipher(mixed, 'source', key);
    expect(decoded.historyWarning).toMatch(/历史/);
    const item = decoded.items[0] as LoginItem;
    expect(item.passwordHistory).toHaveLength(1);
    expect(item.passwordHistoryIncomplete).toBe(true);
    await expect(encodeBitwardenCipher(item, key)).rejects.toThrow(/历史/);
    expect(() => encodeMdbx2Object(item)).toThrow(/历史/);
    expect(() => buildKeePassLoginFields({ item })).toThrow(/历史/);
    expect(() => writeAndroidBackup({ entries: {}, items: [], records: new Map(), warnings: [] }, [item], 'target')).toThrow(/历史/);
    const result = await encodeBitwardenCipher({ ...item, notes: 'changed' }, cipherKey, mixed);
    expect(result.passwordHistory).toEqual(mixed.PasswordHistory);
    const updated = await encodeBitwardenCipher({ ...item, passwordHistory: [{ password: 'new history', lastUsedAt: time }, ...item.passwordHistory!] }, cipherKey, mixed);
    const rows = updated.passwordHistory as Record<string, unknown>[];
    expect(rows).toEqual(expect.arrayContaining(mixed.PasswordHistory));
    expect(await decryptBitwardenString(rows[0].password as string, cipherKey)).toBe('new history');
  });

  it('writes imported histories and removes only explicitly removed readable entries', async () => {
    const raw = await fixture();
    const item = (await decodeBitwardenCipher(raw, 'source', key)).items[0] as LoginItem;
    const cleared = await encodeBitwardenCipher({ ...item, passwordHistory: [] }, cipherKey, raw);
    expect(cleared.passwordHistory).toEqual([]);
    const imported = { ...createLoginItem({ title: 'Imported', password: 'present' }), passwordHistory: [{ password: 'previous', lastUsedAt: time }] };
    const result = await encodeBitwardenCipher(imported, key);
    expect(((await decodeBitwardenCipher({ ...result, id: 'new' }, 'source', key)).items[0] as LoginItem).passwordHistory).toEqual(imported.passwordHistory);
  });
});
