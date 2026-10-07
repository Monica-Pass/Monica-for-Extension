import { expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../core/model';
import { putApiKeyFields } from '../core/credential-fields';
import { KeePassProvider } from './keepass/keepass-provider';
import { buildKeePassFixture } from './keepass/keepass-fixture';
import { encodeBitwardenCipher, decodeBitwardenCipher } from './bitwarden/bitwarden-cipher-codec';
import { readAndroidBackup, writeAndroidBackup } from './webdav/android-backup-codec';

const endpoints=['/v1/chat/completions','internal service: staging','javascript:synthetic()',''];
const item:LoginItem={...createLoginItem({title:'API address',password:'synthetic-secret'}),loginType:'API_KEY',
  customFields:[{name:'before',value:'retained',protected:true},
    {name:'monica_api_key_type',value:'API_KEY',protected:true},
    {name:'monica_api_key_url',value:'/old',protected:true},
    {name:'after',value:'0007',protected:true}]};
const address=(item:LoginItem)=>item.customFields.find(field=>field.name==='monica_api_key_url');
const check=(value:LoginItem,endpoint:string)=>{
  expect(value.loginType).toBe('API_KEY');expect(value.password).toBe('synthetic-secret');
  expect(address(value)).toMatchObject({value:endpoint,protected:true});
  expect(value.customFields).toEqual(expect.arrayContaining(item.customFields.filter(field=>field.name!=='monica_api_key_url')));
};

it.each([3,4] as const)('roundtrips free-form API addresses and protected fields through encrypted KDBX%s',async version=>{
  const account:ProviderAccount={id:'api-kdbx',kind:'keepass',name:'API',enabled:true,isDefaultSaveTarget:false,config:{databaseId:316}};
  let bytes=await buildKeePassFixture({password:'synthetic',version,entries:[{title:item.title,
    protectedFields:{Password:item.password,before:'retained',monica_api_key_type:'API_KEY',monica_api_key_url:'/old',after:'0007'}}]});
  for(const endpoint of endpoints){
    const provider=new KeePassProvider();await provider.unlock(account,bytes,{password:'synthetic'});
    const original=(await provider.sync(account,{now:new Date().toISOString(),localItems:[]})).items[0] as LoginItem;
    await provider.update(account,{...original,customFields:putApiKeyFields(original.customFields,endpoint)});
    bytes=await provider.exportFile(account.id);provider.lock();
    const reopened=new KeePassProvider();await reopened.unlock(account,bytes,{password:'synthetic'});
    const current=(await reopened.sync(account,{now:new Date().toISOString(),localItems:[]})).items[0] as LoginItem;
    check(current,endpoint);
    expect(current.customFields).toEqual(original.customFields.map(field=>field.name==='monica_api_key_url'?{...field,value:endpoint}:field));
    reopened.lock();
  }
});

it('roundtrips arbitrary API address changes and clear through encrypted Bitwarden ciphers',async()=>{
  const key={encKey:new Uint8Array(32).fill(3),macKey:new Uint8Array(32).fill(4)};
  let raw=await encodeBitwardenCipher(item,key);
  for(const endpoint of endpoints){
    const original=(await decodeBitwardenCipher({...raw,id:'api-cipher'},'bw',key)).items[0] as LoginItem;
    if(endpoint===endpoints[0]) expect(original.customFields).toEqual(item.customFields);
    raw=await encodeBitwardenCipher({...original,customFields:putApiKeyFields(original.customFields,endpoint)},key,raw);
    const current=(await decodeBitwardenCipher({...raw,id:'api-cipher'},'bw',key)).items[0] as LoginItem;
    check(current,endpoint);
    expect(current.customFields).toEqual(original.customFields.map(field=>field.name==='monica_api_key_url'?{...field,value:endpoint}:field));
  }
});

it('roundtrips arbitrary API address changes and clear through Android ZIP records',()=>{
  const provider='api-zip';
  let bytes=writeAndroidBackup(readAndroidBackup(zipSync({}),provider),[item],provider);
  for(const endpoint of endpoints){
    const document=readAndroidBackup(bytes,provider),original=document.items[0] as LoginItem;
    bytes=writeAndroidBackup(document,[{...original,customFields:putApiKeyFields(original.customFields,endpoint)}],provider);
    check(readAndroidBackup(bytes,provider).items[0] as LoginItem,endpoint);
  }
});
