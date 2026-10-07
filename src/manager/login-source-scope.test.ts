import { expect, it } from 'vitest';
import { createLoginItem, type ProviderAccount } from '../core/model';
import { applySsoAccountChoice, ssoAccountCandidates, ssoLogicalId } from '../core/sso-links';
import { withLoginDraftSource } from './login-source-scope';

it.each([['12',12], [undefined,0], ['invalid',0]])('uses the same KeePass database scope for choosing and saving (%s)',(configured,expected)=>{
  const provider: ProviderAccount={id:'kp',kind:'keepass',name:'Test',enabled:true,isDefaultSaveTarget:false,config:{databaseId:configured}};
  const draft=withLoginDraftSource({...createLoginItem({title:'Site'}),providerRefs:[{providerId:'kp'}]},provider);
  const account={...createLoginItem({title:'Account'}),keepassDatabaseId:expected,keepassEntryUuid:'uuid',providerRefs:[{providerId:'kp',remoteId:'uuid'}]};
  const other={...account,id:'other',keepassDatabaseId:99};
  expect(ssoAccountCandidates(draft,[account,other])).toEqual([account]);
  expect(applySsoAccountChoice(draft,ssoLogicalId(account),[account,other]).ssoRefLogicalId).toBe('password:keepass:uuid');
});
