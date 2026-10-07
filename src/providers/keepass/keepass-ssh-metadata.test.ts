import { expect, it } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { createLoginItem } from '../../core/model';
import { readKeePassLoginFields, buildKeePassLoginPatch, keePassFieldText, type KeePassEntryFieldValue } from './keepass-login-codec';
import { applyKeePassFieldPatch } from './keepass-field-patch';
import { buildKeePassFixture, keePassCredentials } from './keepass-fixture';
import { readKeePassEntries } from './keepass-vault';
import { writeKeePassEntry } from './keepass-writer';
import type { LoginItem } from '../../core/model';

const names = ['MonicaSshAlgorithm','MonicaSshKeySize','MonicaSshPublicKey','MonicaSshPrivateKey','MonicaSshFingerprint','MonicaSshComment','MonicaSshFormat'];
const values = ['RSA','4096','public','private','fingerprint','comment','PEM'];
const props = ['algorithm','keySize','publicKeyOpenSsh','privateKeyOpenSsh','fingerprintSha256','comment','format'];
const seed = () => new Map<string,KeePassEntryFieldValue>([['Title','SSH'],['MonicaLoginType','SSH_KEY'],...names.map((name,index)=>[name,kdbxweb.ProtectedValue.fromString(values[index])] as [string,KeePassEntryFieldValue])]);
const item = (fields:Map<string,KeePassEntryFieldValue>) => ({...createLoginItem({title:'SSH'}),...readKeePassLoginFields(fields)});

it.each(names)('retains protected %s on rename and when replacing its value', name => {
  const original=seed();const model=item(original);
  const renamed=applyKeePassFieldPatch(original,buildKeePassLoginPatch({item:{...model,title:'Renamed'},existingFields:original}));
  expect(renamed.get(name)).toBe(original.get(name));
  const ssh=JSON.parse(model.sshKeyData!);ssh[props[names.indexOf(name)]]=name==='MonicaSshKeySize'?2048:'new';
  const updated=applyKeePassFieldPatch(original,buildKeePassLoginPatch({item:{...model,sshKeyData:JSON.stringify(ssh)},existingFields:original}));
  expect(updated.get(name)).toBeInstanceOf(kdbxweb.ProtectedValue);
});

it.each(['-1','4096junk','9007199254740993','2.5'])('retains malformed key size %s on an unrelated edit without projecting it',value=>{
  const original=seed();original.set('MonicaSshKeySize',kdbxweb.ProtectedValue.fromString(value));
  const model=item(original);expect(JSON.parse(model.sshKeyData!).keySize).toBe(0);
  const result=applyKeePassFieldPatch(original,buildKeePassLoginPatch({item:{...model,title:'Renamed'},existingFields:original}));
  expect(result.get('MonicaSshKeySize')).toBe(original.get('MonicaSshKeySize'));
});

it('retains format-only SSH data and clears every supported field',()=>{
  const original=new Map<string,KeePassEntryFieldValue>([['MonicaLoginType','SSH_KEY'],['MonicaSshFormat','PEM']]);
  expect(JSON.parse(item(original).sshKeyData!).format).toBe('PEM');
  const full=seed();const cleared=applyKeePassFieldPatch(full,buildKeePassLoginPatch({item:{...item(full),sshKeyData:undefined},existingFields:full}));
  expect(names.some(name=>cleared.has(name))).toBe(false);
  expect(readKeePassLoginFields(cleared).loginType).toBe('SSH_KEY');
  expect(keePassFieldText(full.get('MonicaSshComment'))).toBe('comment');
});

it('does not revive SSH fields from stale custom fields, and still protects imported plain private keys',()=>{
  const original=seed();original.set('MonicaSshPrivateKey','plain-private');
  const model=item(original);
  const renamed=applyKeePassFieldPatch(original,buildKeePassLoginPatch({item:{...model,title:'Renamed'},existingFields:original}));
  expect(renamed.get('MonicaSshPrivateKey')).toBeInstanceOf(kdbxweb.ProtectedValue);
  const cleared=applyKeePassFieldPatch(original,buildKeePassLoginPatch({item:{...model,sshKeyData:undefined,customFields:[{name:'MonicaSshComment',value:'stale',protected:false}]},existingFields:original}));
  expect(names.some(name=>cleared.has(name))).toBe(false);
});

it.each([3,4] as const)('retains SSH field protection and clearing through encrypted KDBX %s reopen',async version=>{
  const bytes=await buildKeePassFixture({password:'synthetic',version,entries:[{title:'SSH',fields:{MonicaLoginType:'SSH_KEY',FutureField:'keep'},protectedFields:{MonicaSshComment:'comment',MonicaSshFormat:'PEM',MonicaSshKeySize:'invalid'}}]});
  let db=await kdbxweb.Kdbx.load(bytes.slice().buffer,keePassCredentials('synthetic'));
  const read=()=>readKeePassEntries(db,1,'source').items[0] as LoginItem;
  writeKeePassEntry(db,db.getDefaultGroup().entries[0],{...read(),title:'Renamed'});
  db=await kdbxweb.Kdbx.load(await db.save(),keePassCredentials('synthetic'));
  const entry=db.getDefaultGroup().entries[0];
  expect(entry.fields.get('MonicaSshComment')).toBeInstanceOf(kdbxweb.ProtectedValue);
  expect(keePassFieldText(entry.fields.get('MonicaSshKeySize'))).toBe('invalid');
  writeKeePassEntry(db,entry,{...read(),sshKeyData:undefined});
  db=await kdbxweb.Kdbx.load(await db.save(),keePassCredentials('synthetic'));
  expect(db.getDefaultGroup().entries[0].fields.has('MonicaSshComment')).toBe(false);
  expect(db.getDefaultGroup().entries[0].fields.has('MonicaSshFormat')).toBe(false);
  expect(keePassFieldText(db.getDefaultGroup().entries[0].fields.get('MonicaSshKeySize'))).toBe('invalid');
  expect(db.getDefaultGroup().entries[0].fields.get('FutureField')).toBe('keep');
});
