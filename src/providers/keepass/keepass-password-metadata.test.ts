import { expect, it } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { createLoginItem, type LoginItem } from '../../core/model';
import { readKeePassLoginFields, buildKeePassLoginPatch, keePassFieldText, type KeePassEntryFieldValue } from './keepass-login-codec';
import { applyKeePassFieldPatch } from './keepass-field-patch';
import { buildKeePassFixture, keePassCredentials } from './keepass-fixture';
import { readKeePassEntries } from './keepass-vault';
import { writeKeePassEntry } from './keepass-writer';

const cases = [
  ['appPackageName', 'AppPackageName'], ['appName', 'Application Name'], ['email', 'E-mail'],
  ['phone', 'Telephone'], ['addressLine', 'Address Line'], ['city', 'City'], ['state', 'Province'],
  ['zipCode', 'ZipCode'], ['country', 'Country'], ['creditCardNumber', 'CardNumber'],
  ['creditCardHolder', 'CardHolder'], ['creditCardExpiry', 'Expiry Date'], ['creditCardCVV', 'CVC']
] as const;

it.each(['Application Name', 'AndroidAppPackageName', 'PackageName'])('does not use protected metadata %s as a missing password', alias => {
  const fields = new Map<string,KeePassEntryFieldValue>([['Title','Account'],[alias,kdbxweb.ProtectedValue.fromString('application.value')]]);
  expect(readKeePassLoginFields(fields).password).toBe('');
});

it.each(cases)('preserves protected %s alias %s on rename, then replaces and clears it', (property, alias) => {
  const value = kdbxweb.ProtectedValue.fromString('original');
  const original = new Map<string, KeePassEntryFieldValue>([['Title', 'Account'], ['Password', 'secret'], [alias, value], ['Unknown field', 'keep']]);
  const item: LoginItem = { ...createLoginItem({title:'Account'}), ...readKeePassLoginFields(original) };
  expect(item[property]).toBe('original');
  const renamed = applyKeePassFieldPatch(original, buildKeePassLoginPatch({item:{...item,title:'Renamed'},existingFields:original}));
  expect(renamed.get(alias)).toBe(value);
  const replaced = applyKeePassFieldPatch(renamed, buildKeePassLoginPatch({item:{...item,[property]:'replacement'},existingFields:renamed}));
  expect(readKeePassLoginFields(replaced)[property]).toBe('replacement');
  expect(keePassFieldText(replaced.get(alias))).toBe('replacement');
  expect(replaced.get(alias)).toBeInstanceOf(kdbxweb.ProtectedValue);
  const cleared = applyKeePassFieldPatch(replaced, buildKeePassLoginPatch({item:{...item,[property]:undefined},existingFields:replaced}));
  expect(readKeePassLoginFields(cleared)[property]).toBeUndefined();
  expect(cleared.has(alias)).toBe(false);
  expect(cleared.get('Unknown field')).toBe('keep');
  expect(keePassFieldText(cleared.get('Password'))).toBe('secret');
});

it('retains distinct alias values on rename and updates all aliases on an explicit change', () => {
  const original = new Map<string,KeePassEntryFieldValue>([['Email','first'],['Mail',kdbxweb.ProtectedValue.fromString('second')]]);
  const item = {...createLoginItem({title:'Alias'}),...readKeePassLoginFields(original)};
  const renamed=applyKeePassFieldPatch(original,buildKeePassLoginPatch({item:{...item,title:'Renamed'},existingFields:original}));
  expect(keePassFieldText(renamed.get('Email'))).toBe('first');
  expect(renamed.get('Mail')).toBe(original.get('Mail'));
  const updated=applyKeePassFieldPatch(renamed,buildKeePassLoginPatch({item:{...item,email:'new'},existingFields:renamed}));
  expect(keePassFieldText(updated.get('Email'))).toBe('new');
  expect(keePassFieldText(updated.get('Mail'))).toBe('new');
});

it.each([3,4] as const)('persists alias deletion in encrypted KDBX %s while retaining history and unknown fields', async version => {
  const bytes = await buildKeePassFixture({password:'synthetic',version,entries:[{title:'Account',fields:{FutureField:'keep'},protectedFields:{Password:'secret','E-mail':'contact@example.test',Province:'region',CardNumber:'1234'}}]});
  let db = await kdbxweb.Kdbx.load(bytes.slice().buffer,keePassCredentials('synthetic'));
  const read=()=>readKeePassEntries(db,1,'reconnected').items[0] as LoginItem;
  const initial=read();
  expect(initial.email).toBe('contact@example.test');
  const uuid=db.getDefaultGroup().entries[0].uuid.toString();
  writeKeePassEntry(db,db.getDefaultGroup().entries[0],{...initial,title:'Renamed'});
  db=await kdbxweb.Kdbx.load(await db.save(),keePassCredentials('synthetic'));
  expect(db.getDefaultGroup().entries[0].fields.get('E-mail')).toBeInstanceOf(kdbxweb.ProtectedValue);
  writeKeePassEntry(db,db.getDefaultGroup().entries[0],{...read(),email:undefined,state:undefined,creditCardNumber:undefined});
  db=await kdbxweb.Kdbx.load(await db.save(),keePassCredentials('synthetic'));
  expect(read().email).toBeUndefined();expect(read().state).toBeUndefined();expect(read().creditCardNumber).toBeUndefined();
  expect(read().password).toBe('secret');
  const entry=db.getDefaultGroup().entries[0];
  expect(entry.uuid.toString()).toBe(uuid);expect(entry.fields.get('FutureField')).toBe('keep');
  expect(entry.fields.has('E-mail')).toBe(false);
  expect(entry.history.some(history=>keePassFieldText(history.fields.get('E-mail'))==='contact@example.test')).toBe(true);
});
