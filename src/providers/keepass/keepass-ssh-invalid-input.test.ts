import { expect, it } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { buildKeePassFixture, keePassCredentials } from './keepass-fixture';
import { readKeePassEntries } from './keepass-vault';
import { createKeePassEntry, writeKeePassEntry } from './keepass-writer';
import type { LoginItem } from '../../core/model';

it.each(['{', '[]', 'null', '"text"', '{"privateKeyOpenSsh":42}', '{"keySize":4096.5}', '{"keySize":-1}', '{"keySize":9007199254740993}', '{"keySize":"4096"}'])('rejects malformed SSH payload %s before mutating KDBX entry, history or groups', async sshKeyData => {
  const bytes=await buildKeePassFixture({password:'synthetic',entries:[{title:'SSH',fields:{MonicaLoginType:'SSH_KEY',MonicaSshPublicKey:'public',FutureField:'keep'},protectedFields:{MonicaSshPrivateKey:'private'}}]});
  const db=await kdbxweb.Kdbx.load(bytes.slice().buffer,keePassCredentials('synthetic'));
  const entry=db.getDefaultGroup().entries[0];
  const model=readKeePassEntries(db,1,'source').items[0] as LoginItem;
  const before=new Map(entry.fields);const history=entry.history.length;const groups=db.getDefaultGroup().groups.length;
  expect(()=>writeKeePassEntry(db,entry,{...model,title:'Must not apply',sshKeyData})).toThrow('SSH');
  expect(entry.fields).toEqual(before);expect(entry.history).toHaveLength(history);
  expect(()=>createKeePassEntry(db,{...model,id:'new',sshKeyData},'Must not create')).toThrow('SSH');
  expect(db.getDefaultGroup().groups).toHaveLength(groups);
});
