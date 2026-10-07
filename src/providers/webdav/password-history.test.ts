import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { readAndroidBackup, writeAndroidBackup } from './android-backup-codec';
import { capturePasswordHistory } from '../../core/password-history';
import type { LoginItem } from '../../core/model';

const changedAt = '2026-10-06T01:02:03.000Z';
function fixture(history: string, path = 'password_history.json', id = '42') {
  const archive = zipSync({
    'passwords/password_42.json': strToU8(`{"id":${id},"title":"Synthetic","username":"test","password":"current","createdAt":1700000000000,"updatedAt":1700000001000}`),
    [path]: strToU8(history)
  });
  const document = readAndroidBackup(archive, 'source');
  return { document, item: document.items[0] as LoginItem, path };
}
function output(f: ReturnType<typeof fixture>, item: LoginItem) {
  return unzipSync(writeAndroidBackup(f.document, [item], 'source'));
}
describe('Android password history preservation', () => {
  it('records change time and permits a repeated older password without duplicating service snapshots', () => {
    const f = fixture('[{"entryId":42,"password":"current","lastUsedAt":0},{"entryId":42,"password":"other","lastUsedAt":1000}]');
    const saved = capturePasswordHistory(f.item, { ...f.item, password: 'new', updatedAt: changedAt }, changedAt);
    const entries = JSON.parse(strFromU8(output(f, saved)[f.path]));
    expect(entries.map((row: { password: string }) => row.password)).toEqual(['current', 'current', 'other']);
    expect(entries[0].lastUsedAt).toBe(Date.parse(changedAt));
    expect(entries[1].lastUsedAt).toBe(0);
    const reopened = readAndroidBackup(zipSync(output(f, saved)), 'source').items[0] as LoginItem;
    expect(reopened.passwordHistory).toEqual(saved.passwordHistory);
  });

  it('retains unknown numbers, malformed same-owner rows, exact file casing and epoch zero', () => {
    const f = fixture('[{"entryId":42,"password":"old","lastUsedAt":0,"future":9007199254740993},{"entryId":42,"future":"opaque"}]', 'PASSWORD_HISTORY.JSON');
    const result = output(f, { ...f.item, password: 'new', updatedAt: changedAt });
    expect(result['password_history.json']).toBeUndefined();
    expect(Object.keys(result).filter(path => path.toLowerCase() === 'password_history.json')).toEqual([f.path]);
    const raw = strFromU8(result[f.path]);
    expect(raw).toContain('"future":9007199254740993');
    expect(JSON.parse(raw)).toEqual(expect.arrayContaining([
      expect.objectContaining({ password: 'old', lastUsedAt: 0 }), { entryId: 42, future: 'opaque' }
    ]));
  });

  it('preserves rows beyond the projection limit when adding a new snapshot', () => {
    const raw = Array.from({ length: 1003 }, (_, n) => ({ entryId: 42, password: `old-${n}`, lastUsedAt: n }));
    const f = fixture(JSON.stringify(raw));
    const result = JSON.parse(strFromU8(output(f, { ...f.item, password: 'new', updatedAt: changedAt })[f.path]));
    expect(result).toHaveLength(1004);
    for (const row of raw) expect(result).toContainEqual(row);
  });

  it('does not replace an unreadable history archive while editing a password', () => {
    const f = fixture('unreadable future history');
    expect(output(f, { ...f.item, notes: 'unrelated' })[f.path]).toEqual(f.document.entries[f.path]);
    expect(() => output(f, { ...f.item, password: 'new', updatedAt: changedAt })).toThrow(/历史/);
  });

  it('keeps distinct Android Long owner IDs exact', () => {
    const f = fixture('[{"entryId":9007199254740993,"password":"mine","lastUsedAt":0},{"entryId":9007199254740992,"password":"other owner","lastUsedAt":1}]', undefined, '9007199254740993');
    expect(f.item.passwordHistory?.map(row => row.password)).toEqual(['mine']);
    const raw = strFromU8(output(f, { ...f.item, password: 'new', updatedAt: changedAt })[f.path]);
    expect(raw).toContain('"entryId":9007199254740993');
    expect(raw).toContain('"entryId":9007199254740992,"password":"other owner"');
  });
});
