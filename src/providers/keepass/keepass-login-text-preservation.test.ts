import { expect, it } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { createLoginItem, type LoginItem } from '../../core/model';
import { readKeePassLoginFields, buildKeePassLoginPatch, keePassFieldText, type KeePassEntryFieldValue } from './keepass-login-codec';
import { applyKeePassFieldPatch } from './keepass-field-patch';
import { buildKeePassFixture, keePassCredentials } from './keepass-fixture';
import { readKeePassEntries } from './keepass-vault';
import { createKeePassEntry, writeKeePassEntry } from './keepass-writer';

const text = ' \t原文 🔑\r\nsecond line  \r\n';
const metadata = [
  ['appPackageName', 'AppPackageName'], ['appName', 'Application Name'], ['email', 'E-mail'],
  ['phone', 'Telephone'], ['addressLine', 'Address Line'], ['city', 'City'], ['state', 'Province'],
  ['zipCode', 'ZipCode'], ['country', 'Country'], ['creditCardNumber', 'CardNumber'],
  ['creditCardHolder', 'CardHolder'], ['creditCardExpiry', 'Expiry Date'], ['creditCardCVV', 'CVC']
] as const;
const sshFields = {
  algorithm: 'MonicaSshAlgorithm', publicKeyOpenSsh: 'MonicaSshPublicKey',
  privateKeyOpenSsh: 'MonicaSshPrivateKey', fingerprintSha256: 'MonicaSshFingerprint',
  comment: 'MonicaSshComment', format: 'MonicaSshFormat'
} as const;
const model = (fields: Map<string, KeePassEntryFieldValue>) => ({ ...createLoginItem({ title: 'Text' }), ...readKeePassLoginFields(fields) });

it.each(metadata)('retains exact %s text through read, rename and explicit trimming', (property, alias) => {
  const original = new Map<string, KeePassEntryFieldValue>([[alias, kdbxweb.ProtectedValue.fromString(text)]]);
  const item = model(original);
  expect(item[property]).toBe(text);
  const renamed = applyKeePassFieldPatch(original, buildKeePassLoginPatch({ item: { ...item, title: 'Renamed' }, existingFields: original }));
  expect(renamed.get(alias)).toBe(original.get(alias));
  const changed = applyKeePassFieldPatch(original, buildKeePassLoginPatch({ item: { ...item, [property]: text.trim() }, existingFields: original }));
  expect(keePassFieldText(changed.get(alias))).toBe(text.trim());
  expect(changed.get(alias)).toBeInstanceOf(kdbxweb.ProtectedValue);
});

it.each(Object.entries(sshFields))('retains exact SSH %s including CRLF before and after an explicit edit', (property, name) => {
  const original = new Map<string, KeePassEntryFieldValue>([['MonicaLoginType', ' SSH_KEY '], [name, kdbxweb.ProtectedValue.fromString(text)]]);
  const item = model(original);
  expect(item.loginType).toBe('SSH_KEY');
  const data = JSON.parse(item.sshKeyData!);
  expect(data[property]).toBe(text);
  const renamed = applyKeePassFieldPatch(original, buildKeePassLoginPatch({ item: { ...item, title: 'Renamed' }, existingFields: original }));
  expect(renamed.get(name)).toBe(original.get(name));
  const changed = applyKeePassFieldPatch(original, buildKeePassLoginPatch({ item: { ...item, sshKeyData: JSON.stringify({ ...data, [property]: text.trim() }) }, existingFields: original }));
  expect(keePassFieldText(changed.get(name))).toBe(text.trim());
  expect(changed.get(name)).toBeInstanceOf(kdbxweb.ProtectedValue);
});

it.each([['title', 'Name'], ['username', 'Login'], ['password', 'pwd'], ['url', 'Website'], ['notes', 'Comment']] as const)(
  'retains original %s from a legacy %s alias', (property, alias) => {
    const fields = new Map<string, KeePassEntryFieldValue>([[alias, kdbxweb.ProtectedValue.fromString(text)]]);
    expect(readKeePassLoginFields(fields)[property]).toBe(text);
  }
);

it('retains SSO provider, SSID and Wi-Fi JSON text while keeping marker parsing normalized', () => {
  expect(readKeePassLoginFields(new Map([['MonicaLoginType', ' SSO '], ['SSO Provider', text]])).ssoProvider).toBe(text);
  const wifi = readKeePassLoginFields(new Map([['MonicaLoginType', ' WIFI '], ['SSID', ' Home Wi-Fi ']]));
  expect(JSON.parse(wifi.wifiMetadata!).ssid).toBe(' Home Wi-Fi ');
  const json = ' \n { "ssid": " Home Wi-Fi " } \n ';
  expect(readKeePassLoginFields(new Map([['MonicaWifiData', json], ['MonicaLoginType', ' WIFI ']])).wifiMetadata).toBe(json);
});

it.each([3, 4] as const)('copies exact modeled text into a separate encrypted KDBX %s and reopens after edits', async version => {
  const originalText = '\n-----BEGIN OPENSSH PRIVATE KEY-----\r\nsynthetic-private\r\n-----END OPENSSH PRIVATE KEY-----\n';
  const seed = await buildKeePassFixture({ password: 'synthetic', version, entries: [{
    title: 'Exact text', fields: { MonicaLoginType: 'SSH_KEY', MonicaSshAlgorithm: 'RSA', MonicaSshPublicKey: ' ssh-rsa synthetic-public\n', FutureField: 'keep' },
    protectedFields: { MonicaSshPrivateKey: originalText, MonicaSshComment: text, 'E-mail': text, CardHolder: text }
  }] });
  const source = await kdbxweb.Kdbx.load(seed.slice().buffer, keePassCredentials('synthetic'));
  const item = readKeePassEntries(source, 1, 'source').items[0] as LoginItem;
  const empty = await buildKeePassFixture({ password: 'synthetic', version, entries: [] });
  let destination = await kdbxweb.Kdbx.load(empty.slice().buffer, keePassCredentials('synthetic'));
  createKeePassEntry(destination, item);
  destination = await kdbxweb.Kdbx.load(await destination.save(), keePassCredentials('synthetic'));
  const read = () => readKeePassEntries(destination, 2, 'other-source').items[0] as LoginItem;
  expect(read().email).toBe(text); expect(read().creditCardHolder).toBe(text);
  expect(JSON.parse(read().sshKeyData!)).toMatchObject({ privateKeyOpenSsh: originalText, publicKeyOpenSsh: ' ssh-rsa synthetic-public\n', comment: text });
  const entry = destination.getDefaultGroup().entries[0];
  writeKeePassEntry(destination, entry, { ...read(), title: 'Edited', sshKeyData: JSON.stringify({ ...JSON.parse(read().sshKeyData!), comment: text.trim() }) });
  destination = await kdbxweb.Kdbx.load(await destination.save(), keePassCredentials('synthetic'));
  expect(JSON.parse(read().sshKeyData!)).toMatchObject({ privateKeyOpenSsh: originalText, comment: text.trim() });
  expect(destination.getDefaultGroup().entries[0].fields.get('MonicaSshPrivateKey')).toBeInstanceOf(kdbxweb.ProtectedValue);
  expect(destination.getDefaultGroup().entries[0].fields.get('FutureField')).toBe('keep');
});

it.each([3, 4] as const)('retains XML-sensitive login and custom text when creating KDBX %s', async version => {
  const empty = await buildKeePassFixture({ password: 'synthetic', version, entries: [] });
  const db = await kdbxweb.Kdbx.load(empty.slice().buffer, keePassCredentials('synthetic'));
  createKeePassEntry(db, { ...createLoginItem({ title: 'Text' }), title: text, username: text, notes: text,
    customFields: [{ name: 'Plain custom text', value: 'a\tb\rc\u0000d', protected: false }, { name: 'Ordinary text', value: 'unchanged', protected: false }] });
  const reopened = await kdbxweb.Kdbx.load(await db.save(), keePassCredentials('synthetic'));
  const item = readKeePassEntries(reopened, 1, 'destination').items[0] as LoginItem;
  expect(item.title).toBe(text); expect(item.username).toBe(text); expect(item.notes).toBe(text);
  expect(item.customFields).toContainEqual({ name: 'Plain custom text', value: 'a\tb\rc\u0000d', protected: true });
  expect(reopened.getDefaultGroup().entries[0].fields.get('Ordinary text')).toBe('unchanged');
});
