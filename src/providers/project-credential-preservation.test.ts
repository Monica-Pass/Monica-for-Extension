import { expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from '../core/project-credentials';
import { readAndroidBackup, writeAndroidBackup } from './webdav/android-backup-codec';
import { encodeBitwardenCipher, decodeBitwardenCipher } from './bitwarden/bitwarden-cipher-codec';
import { encodeMdbx2Object, decodeMdbx2Object } from './mdbx2/mdbx2-item-codec';
import { KeePassProvider } from './keepass/keepass-provider';
import { buildKeePassFixture } from './keepass/keepass-fixture';

const carrier = '{ "version":1,"projectId":"00000000-0000-0000-0000-000000000001","groupId":"00000000-0000-0000-0000-000000000002","passwordId":"00000000-0000-0000-0000-000000000003","label":"  工作账号 🔑  ","primary":true,"groupOrder":0,"passwordOrder":1,"future":9007199254740993 }';
const item: LoginItem = { ...createLoginItem({ title: 'Credential project', username: 'account', password: 'synthetic-password' }),
  customFields: [{ name: 'before', value: '0007', protected: true },
    { name: PROJECT_CREDENTIAL_FIELD, value: carrier, protected: true },
    { name: 'after', value: '  future  ', protected: false }] };
const edit = (value: LoginItem): LoginItem => ({ ...value, title: 'Changed title', password: 'edited-password' });
const check = (value: LoginItem, expected = item.customFields) => {
  expect(value.title).toBe('Changed title'); expect(value.password).toBe('edited-password');
  expect(value.customFields).toEqual(expected);
  expect(value.customFields.find(field => field.name === PROJECT_CREDENTIAL_FIELD)?.value).toBe(carrier);
  expect(readProjectCredential(value.customFields)?.passwordOrder).toBe(1);
};

it('preserves Android credential identity and unknown JSON through native ordinary edit', () => {
  const decode = (value: LoginItem) => {
    const encoded = encodeMdbx2Object(value)!;
    return decodeMdbx2Object({ objectId: 'synthetic', collectionId: 'passwords', objectTypeId: 'login',
      title: value.title, payloadSchemaVersion: 1, deleted: false, payloadJson: encoded.payloadJson },
      { headCommitId: 'synthetic', updatedAt: value.updatedAt }, 'native').item as LoginItem;
  };
  check(decode(edit(decode(item))));
});
it('preserves Android credential identity and unknown JSON through ZIP ordinary edit', () => {
  const first = writeAndroidBackup(readAndroidBackup(zipSync({}), 'zip'), [item], 'zip');
  const document = readAndroidBackup(first, 'zip');
  check(readAndroidBackup(writeAndroidBackup(document, [edit(document.items[0] as LoginItem)], 'zip'), 'zip').items[0] as LoginItem);
});
it('preserves Android credential identity and unknown JSON through encrypted cipher ordinary edit', async () => {
  const key = { encKey: new Uint8Array(32).fill(5), macKey: new Uint8Array(32).fill(6) };
  const first = await encodeBitwardenCipher(item, key);
  const original = (await decodeBitwardenCipher({ ...first, id: 'credential' }, 'bw', key)).items[0] as LoginItem;
  const changed = await encodeBitwardenCipher(edit(original), key, first);
  check((await decodeBitwardenCipher({ ...changed, id: 'credential' }, 'bw', key)).items[0] as LoginItem);
});
it.each([3, 4] as const)('preserves credential metadata through KDBX%s edit and reopen', async version => {
  const account: ProviderAccount = { id: 'credential-kdbx', kind: 'keepass', name: 'Credentials', enabled: true, isDefaultSaveTarget: false, config: {} };
  const bytes = await buildKeePassFixture({ password: 'synthetic', version, entries: [{ title: item.title,
    fields: { after: '  future  ' }, protectedFields: { Password: item.password, before: '0007', [PROJECT_CREDENTIAL_FIELD]: carrier } }] });
  const provider = new KeePassProvider(); await provider.unlock(account, bytes, { password: 'synthetic' });
  const original = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items[0] as LoginItem;
  await provider.update(account, edit(original)); const saved = await provider.exportFile(account.id); provider.lock();
  const reopened = new KeePassProvider(); await reopened.unlock(account, saved, { password: 'synthetic' });
  check((await reopened.sync(account, { now: new Date().toISOString(), localItems: [] })).items[0] as LoginItem, original.customFields);
  reopened.lock();
});
