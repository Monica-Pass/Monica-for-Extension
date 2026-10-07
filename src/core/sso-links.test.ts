import {expect,it} from 'vitest';
import {createLoginItem} from './model';
import {applySsoAccountChoice,resolveSsoAccount,ssoAccountCandidates,ssoLogicalId} from './sso-links';
const login=(id:string)=>({...createLoginItem({title:'Same title'}),id,replicaGroupId:`password:${id}`});
it('uses acknowledged Cipher identity while retaining a newly created local item ID',()=>{
  const account={...login('local-id'),replicaGroupId:undefined,bitwardenCipherId:'remote-cipher',providerRefs:[{providerId:'bw',remoteId:'remote-cipher'}]};
  expect(ssoLogicalId(account)).toBe('password:bitwarden:remote-cipher');
  expect(ssoLogicalId({...account,providerRefs:[{providerId:'other',remoteId:'different'}]})).toBe('password:local-id');
});
it.each(['keepass','bitwarden'])('keeps %s account identity stable when the source connection changes',kind=>{
  const account={...login(`${kind}:old:account`),replicaGroupId:undefined,keepassEntryUuid:kind==='keepass'?'account':undefined,providerRefs:[{providerId:'old',remoteId:'account'}]};
  const owner={...login(`${kind}:old:site`),providerRefs:[{providerId:'old',remoteId:'site'}],ssoRefLogicalId:ssoLogicalId(account)};
  const reopenedAccount={...account,id:`${kind}:new:account`,providerRefs:[{providerId:'new',remoteId:'account'}]};
  const reopenedOwner={...owner,id:`${kind}:new:site`,providerRefs:[{providerId:'new',remoteId:'site'}]};
  expect(ssoLogicalId(reopenedAccount)).toBe(ssoLogicalId(account));
  expect(resolveSsoAccount(reopenedOwner,[reopenedAccount])?.id).toBe(reopenedAccount.id);
  expect(resolveSsoAccount(owner,[reopenedAccount])).toBeUndefined();
  expect(resolveSsoAccount({...owner,ssoRefLogicalId:`password:${account.id}`},[account])?.id).toBe(account.id);
  expect(resolveSsoAccount(reopenedOwner,[reopenedAccount,{...reopenedAccount,id:`${kind}:new:duplicate`}])).toBeUndefined();
});
it('resolves unique scoped logical identities without matching titles or Room IDs',()=>{
  const owner={...login('owner'),ssoRefLogicalId:'password:account',ssoRefEntryId:42},account=login('account');
  expect(resolveSsoAccount(owner,[owner,account])?.id).toBe('account');
  expect(resolveSsoAccount(owner,[owner,{...account,providerRefs:[{providerId:'other'}]}])).toBeUndefined();
  expect(resolveSsoAccount(owner,[owner,account,{...account,id:'duplicate'}])).toBeUndefined();
  expect(resolveSsoAccount({...owner,ssoRefLogicalId:undefined},[owner,account])).toBeUndefined();
  expect(resolveSsoAccount({...owner,ssoRefLogicalId:'native:account'},[owner,{...account,replicaGroupId:'native:account'}])?.id).toBe('account');
});
it('rejects self links, cycles, broken chains and unresolved legacy references',()=>{
  const owner=login('owner'),account=login('account');
  for(const target of [{...account,ssoRefLogicalId:'password:owner'},{...account,ssoRefLogicalId:'password:missing'},{...account,ssoRefEntryId:42}]) {
    expect(ssoAccountCandidates(owner,[owner,target])).toEqual([]);
    expect(()=>applySsoAccountChoice(owner,'password:account',[owner,target])).toThrow();
  }
  expect(applySsoAccountChoice({...owner,ssoRefEntryId:42},'password:account',[owner,account])).toMatchObject({ssoRefLogicalId:'password:account',ssoRefEntryId:undefined});
  expect(applySsoAccountChoice({...owner,ssoRefLogicalId:'password:missing',ssoRefEntryId:42},'',[owner])).toMatchObject({ssoRefLogicalId:undefined,ssoRefEntryId:undefined});
});
