import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem } from '../../core/model';
import { decodeBitwardenCipher, encodeBitwardenCipher } from './bitwarden-cipher-codec';
import { encryptBitwardenString, decryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
const key: BitwardenSymmetricKey = {encKey:new Uint8Array(32).fill(3),macKey:new Uint8Array(32).fill(4)};
const fields = {appPackageName:'test.package',appName:'Example',email:'a@example.test',phone:'+1234',addressLine:'1 Main Street',city:'Test City',state:'Test State',zipCode:'12345',country:'Test Country',passkeyBindings:'[{"credentialId":"test","future":{"keep":true}}]'};
const read = async(raw:Record<string,unknown>) => (await decodeBitwardenCipher({...raw,id:'cipher'},'reconnected',key)).items[0] as LoginItem;

it.each(Object.keys(fields) as Array<keyof typeof fields>)('clears %s without removing other Android fields or login credentials', async property => {
  const original={...createLoginItem({title:'Account',username:'user',password:'secret'}),...fields};
  const raw=await encodeBitwardenCipher(original,key);
  const decoded=await read(raw);
  expect(decoded[property]).toBe(fields[property]);
  const updated=await encodeBitwardenCipher({...decoded,[property]:undefined},key,raw);
  const reopened=await read(updated);
  expect(reopened[property]).toBeUndefined();
  for(const name of Object.keys(fields) as Array<keyof typeof fields>) if(name!==property) expect(reopened[name]).toBe(fields[name]);
  expect(reopened.password).toBe('secret');
});

it('clears every known alias instead of reviving older values',async()=>{
  const raw=await encodeBitwardenCipher(createLoginItem({title:'Alias',password:'secret'}),key);
  raw.fields=await Promise.all(['monica_email','email'].map(async(name,index)=>({name:await encryptBitwardenString(name,key),value:await encryptBitwardenString(`alias${index}@example.test`,key),type:0,linkedId:null})));
  const decoded=await read(raw);expect(decoded.email).toBe('alias0@example.test');
  const output=await encodeBitwardenCipher({...decoded,email:undefined},key,raw);
  expect((await read(output)).email).toBeUndefined();
  expect(output.fields).toBeNull();
});

it('preserves unsupported and linked values while editing known metadata',async()=>{
  const raw=await encodeBitwardenCipher(createLoginItem({title:'Unknown',password:'secret'}),key);
  const future={name:await encryptBitwardenString('monica_email',key),value:await encryptBitwardenString('true',key),type:2,linkedId:null,future:[1,2]};
  const linked={name:await encryptBitwardenString('phone',key),value:await encryptBitwardenString('linked-value',key),type:0,linkedId:100};
  raw.fields=[future,linked];
  const decoded=await read(raw);expect(decoded.email).toBeUndefined();expect(decoded.phone).toBeUndefined();
  const output=await encodeBitwardenCipher({...decoded,email:'new@example.test'},key,raw);
  expect((output.fields as unknown[])).toEqual(expect.arrayContaining([future,linked]));
  expect((await read(output)).email).toBe('new@example.test');
});

it('keeps hidden protection and unknown metadata on an unrelated rename',async()=>{
  const raw=await encodeBitwardenCipher(createLoginItem({title:'Hidden',password:'secret'}),key);
  raw.fields=[{name:await encryptBitwardenString('monica_passkey_bindings',key),value:await encryptBitwardenString(fields.passkeyBindings,key),type:1,linkedId:null,future:{keep:true}}];
  const decoded=await read(raw);
  const output=await encodeBitwardenCipher({...decoded,title:'Renamed'},key,raw);
  const result=(output.fields as Record<string,unknown>[]).find(field=>field.type===1)!;
  expect(result).toBeDefined();expect(result.future).toEqual({keep:true});
  expect(await decryptBitwardenString(result.value as string,key)).toBe(fields.passkeyBindings);
});

it('retains remote metadata for a pre-adapter legacy model with no metadata projection',async()=>{
  const raw=await encodeBitwardenCipher({...createLoginItem({title:'Old',password:'secret'}),...fields},key);
  const legacy=createLoginItem({title:'Renamed',password:'secret'});
  const reopened=await read(await encodeBitwardenCipher(legacy,key,raw));
  for(const name of Object.keys(fields) as Array<keyof typeof fields>) expect(reopened[name]).toBe(fields[name]);
});

it('does not resurrect cleared system fields from stale custom field duplicates',async()=>{
  const raw=await encodeBitwardenCipher({...createLoginItem({title:'Duplicate',password:'secret'}),email:'old@example.test'},key);
  const decoded=await read(raw);
  const output=await encodeBitwardenCipher({...decoded,email:undefined,customFields:[{name:'email',value:'stale@example.test',protected:false}]},key,raw);
  expect((await read(output)).email).toBeUndefined();
});

it('keeps generated compatibility aliases hidden when an imported alias was hidden',async()=>{
  const raw=await encodeBitwardenCipher(createLoginItem({title:'Alias protection',password:'secret'}),key);
  raw.fields=[{name:await encryptBitwardenString('email',key),value:await encryptBitwardenString('hidden@example.test',key),type:1,linkedId:null}];
  const decoded=await read(raw);
  const output=await encodeBitwardenCipher({...decoded,title:'Renamed',email:'updated@example.test'},key,raw);
  const result=output.fields as Record<string,unknown>[];
  expect(result).toHaveLength(2);
  expect(result.every(field=>field.type===1)).toBe(true);
});

it.each(['city','state','zipCode','country'])('keeps a legacy combined address hidden when %s is hidden',async name=>{
  const raw=await encodeBitwardenCipher({...createLoginItem({title:'Address',password:'secret'}),addressLine:'1 Main Street'},key);
  (raw.fields as unknown[]).push({name:await encryptBitwardenString(name,key),value:await encryptBitwardenString('hidden-location',key),type:1,linkedId:null});
  const output=await encodeBitwardenCipher({...await read(raw),title:'Renamed'},key,raw);
  for(const field of output.fields as Record<string,unknown>[]) {
    if(await decryptBitwardenString(field.name as string,key)==='address') expect(field.type).toBe(1);
  }
});

it.each(['city','monica_city'])('retains %s metadata and duplicate values exactly on unrelated edits',async alias=>{
  const raw=await encodeBitwardenCipher(createLoginItem({title:'Legacy aliases',password:'secret'}),key);
  const aliases=await Promise.all(['first','last'].map(async(value,index)=>({name:await encryptBitwardenString(alias,key),value:await encryptBitwardenString(value,key),type:0,linkedId:null,future:{index}})));
  raw.fields=aliases;
  const decoded=await read(raw);expect(decoded.city).toBe('last');
  const renamed=await encodeBitwardenCipher({...decoded,title:'Renamed'},key,raw);
  expect(renamed.fields).toEqual(aliases);
  const updated=await encodeBitwardenCipher({...decoded,city:'New city'},key,raw);
  const oldAliases=[];
  for(const field of updated.fields as Record<string,unknown>[]) if(await decryptBitwardenString(field.name as string,key)===alias) oldAliases.push(field);
  expect(oldAliases.map(field=>field.future)).toEqual([{index:0},{index:1}]);
  for(const field of oldAliases) expect(await decryptBitwardenString(field.value as string,key)).toBe('New city');
});
