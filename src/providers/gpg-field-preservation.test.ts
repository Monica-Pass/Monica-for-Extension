import { expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../core/model';
import { putGpgFields, readGpgFields } from '../core/credential-fields';
import { KeePassProvider } from './keepass/keepass-provider';
import { buildKeePassFixture } from './keepass/keepass-fixture';
import { encodeBitwardenCipher, decodeBitwardenCipher } from './bitwarden/bitwarden-cipher-codec';
import { readAndroidBackup, writeAndroidBackup } from './webdav/android-backup-codec';

const item: LoginItem = { ...createLoginItem({ title: 'Synthetic GPG', password: 'synthetic-private-key' }), loginType: 'GPG_KEY',
  customFields: [
    { name: 'before', value: 'retained', protected: true },
    { name: 'monica_gpg_type', value: 'GPG_KEY', protected: true },
    { name: 'monica_gpg_public_0000', value: '-----BEGIN PGP PUBLIC KEY BLOCK-----\r\n', protected: true },
    { name: 'monica_gpg_fingerprint', value: 'old fingerprint', protected: true },
    { name: 'middle', value: '0007', protected: true },
    { name: 'monica_gpg_public_0001', value: 'synthetic\tpublic key\r\n', protected: true },
    { name: 'monica_gpg_user_id', value: 'old user', protected: true },
  ] };

const edit = (original: LoginItem, clear: boolean): LoginItem => ({ ...original,
  customFields: putGpgFields(original.customFields, { ...readGpgFields(original.customFields),
    ...(clear ? { userId: '' } : { fingerprint: '  edited fingerprint\t  ' }) }) });
const check = (original: LoginItem, result: LoginItem, clear: boolean) => {
  expect(result.loginType).toBe('GPG_KEY');
  expect(result.password).toBe(item.password);
  const name = clear ? 'monica_gpg_user_id' : 'monica_gpg_fingerprint';
  expect(result.customFields).toEqual(original.customFields.map(field => field.name === name
    ? { ...field, value: clear ? '' : '  edited fingerprint\t  ' } : field));
  expect(readGpgFields(result.customFields).publicKey).toBe(readGpgFields(original.customFields).publicKey);
};

it.each([3, 4] as const)('retains protected GPG carriers through KDBX%s metadata edit, clear and reopen', async version => {
  const account: ProviderAccount = { id: 'gpg-keepass', kind: 'keepass', name: 'GPG', enabled: true, isDefaultSaveTarget: false, config: {} };
  let bytes = await buildKeePassFixture({ password: 'synthetic', version, entries: [{ title: item.title,
    fields: Object.fromEntries(item.customFields.filter(field => !field.protected).map(field => [field.name, field.value])),
    protectedFields: { Password: item.password, ...Object.fromEntries(item.customFields.filter(field => field.protected).map(field => [field.name, field.value])) } }] });
  for (const clear of [false, true]) {
    const provider = new KeePassProvider(); await provider.unlock(account, bytes, { password: 'synthetic' });
    const original = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items[0] as LoginItem;
    await provider.update(account, edit(original, clear)); bytes = await provider.exportFile(account.id); provider.lock();
    const reopened = new KeePassProvider(); await reopened.unlock(account, bytes, { password: 'synthetic' });
    check(original, (await reopened.sync(account, { now: new Date().toISOString(), localItems: [] })).items[0] as LoginItem, clear);
    reopened.lock();
  }
});

it('retains protected GPG carriers through Bitwarden cipher edit and clear', async () => {
  const key = { encKey: new Uint8Array(32).fill(5), macKey: new Uint8Array(32).fill(6) };
  let raw = await encodeBitwardenCipher(item, key);
  for (const clear of [false, true]) {
    const original = (await decodeBitwardenCipher({ ...raw, id: 'gpg-cipher' }, 'bw', key)).items[0] as LoginItem;
    if (!clear) expect(original.customFields).toEqual(item.customFields);
    raw = await encodeBitwardenCipher(edit(original, clear), key, raw);
    check(original, (await decodeBitwardenCipher({ ...raw, id: 'gpg-cipher' }, 'bw', key)).items[0] as LoginItem, clear);
  }
});

it('retains protected GPG carriers through Android ZIP edit and clear', () => {
  const provider = 'gpg-zip'; let bytes = writeAndroidBackup(readAndroidBackup(zipSync({}), provider), [item], provider);
  for (const clear of [false, true]) {
    const document = readAndroidBackup(bytes, provider), original = document.items[0] as LoginItem;
    bytes = writeAndroidBackup(document, [edit(original, clear)], provider);
    check(original, readAndroidBackup(bytes, provider).items[0] as LoginItem, clear);
  }
});
