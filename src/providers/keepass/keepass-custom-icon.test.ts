import { expect, it } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { buildKeePassFixture, keePassCredentials } from './keepass-fixture';
import { readKeePassEntries } from './keepass-vault';
import { createKeePassEntry, writeKeePassEntry } from './keepass-writer';
import { KEEPASS_CUSTOM_ICON_TYPE } from './keepass-custom-icon';
import { base64ToBytes } from '../../security/encoding';
import type { LoginItem } from '../../core/model';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
async function fixture(version: 3 | 4 = 4) {
  const bytes = await buildKeePassFixture({ password: 'synthetic', version, entries: [{ title: 'Account', fields: { UserName: 'user', Password: 'synthetic', FutureField: 'keep' } }] });
  return kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials('synthetic'));
}
const read = (db: kdbxweb.Kdbx) => readKeePassEntries(db, 1, 'source').items[0] as LoginItem;

it.each([3, 4] as const)('retains native icon UUID, data and metadata across unrelated KDBX %s edits and encrypted reopen', async version => {
  const db = await fixture(version);
  if (version === 4) db.header.versionMinor = 1; // Names and modification dates require KDBX 4.1.
  const entry = db.getDefaultGroup().entries[0];
  const duplicate = kdbxweb.KdbxUuid.random();
  const uuid = kdbxweb.KdbxUuid.random();
  db.meta.customIcons.set(duplicate.toString(), { data: base64ToBytes(png).slice().buffer, name: 'Other icon' });
  db.meta.customIcons.set(uuid.toString(), { data: base64ToBytes(png).slice().buffer, name: 'Original icon', lastModified: new Date('2026-10-01T00:00:00Z') });
  entry.customIcon = uuid;
  const item = read(db);
  expect(item).toMatchObject({ customIconType: KEEPASS_CUSTOM_ICON_TYPE, customIconValue: png });
  writeKeePassEntry(db, entry, { ...item, title: 'Renamed' });
  expect(entry.customIcon?.toString()).toBe(uuid.toString());
  expect(entry.history[entry.history.length - 1]?.customIcon?.toString()).toBe(uuid.toString());
  const reopened = await kdbxweb.Kdbx.load(await db.save(), keePassCredentials('synthetic'));
  expect(read(reopened)).toMatchObject({ title: 'Renamed', customIconType: KEEPASS_CUSTOM_ICON_TYPE, customIconValue: png });
  expect(reopened.meta.customIcons.get(uuid.toString())?.data).toEqual(base64ToBytes(png).slice().buffer);
  if (version === 4) expect(reopened.meta.customIcons.get(uuid.toString())?.name).toBe('Original icon');
  expect(reopened.getDefaultGroup().entries[0].fields.get('FutureField')).toBe('keep');
});

it('copies native image bytes to a different database, reuses its pool and clears only the entry reference', async () => {
  const sourceDb = await fixture();
  const sourceEntry = sourceDb.getDefaultGroup().entries[0];
  writeKeePassEntry(sourceDb, sourceEntry, { ...read(sourceDb), customIconType: KEEPASS_CUSTOM_ICON_TYPE, customIconValue: png });
  const source = read(await kdbxweb.Kdbx.load(await sourceDb.save(), keePassCredentials('synthetic')));
  const db = await fixture();
  const copy = { ...source, id: 'copy', customIconType: KEEPASS_CUSTOM_ICON_TYPE, customIconValue: png };
  const { entry } = createKeePassEntry(db, copy);
  const { entry: sibling } = createKeePassEntry(db, { ...copy, id: 'sibling' });
  const uuid = entry.customIcon!.toString();
  expect(sibling.customIcon!.toString()).toBe(uuid);
  expect(db.meta.customIcons.size).toBe(1);
  writeKeePassEntry(db, entry, { ...copy, customIconType: 'NONE', customIconValue: undefined });
  expect(entry.customIcon).toBeUndefined();
  expect(sibling.customIcon!.toString()).toBe(uuid);
  expect(entry.history[entry.history.length - 1]?.customIcon?.toString()).toBe(uuid);
  expect(db.meta.customIcons.get(uuid)?.data).toEqual(base64ToBytes(png).slice().buffer);
  const reopened = await kdbxweb.Kdbx.load(await db.save(), keePassCredentials('synthetic'));
  expect(reopened.getDefaultGroup().entries.find(item => item.uuid.toString() === entry.uuid.toString())?.customIcon).toBeUndefined();
  expect(reopened.meta.customIcons.has(uuid)).toBe(true);
});

it('rejects malformed binary before changing entry, history, groups or pool', async () => {
  const db = await fixture();
  const entry = db.getDefaultGroup().entries[0];
  const item = { ...read(db), title: 'Must not apply', customIconType: KEEPASS_CUSTOM_ICON_TYPE, customIconValue: 'not base64!' };
  expect(() => writeKeePassEntry(db, entry, item)).toThrow('图标数据无效');
  expect(entry.fields.get('Title')).toBe('Account');
  expect(entry.history).toHaveLength(0);
  const groups = db.getDefaultGroup().groups.length;
  expect(() => createKeePassEntry(db, item, 'Must not create')).toThrow('图标数据无效');
  expect(db.getDefaultGroup().groups).toHaveLength(groups);
  expect(db.meta.customIcons.size).toBe(0);
});
