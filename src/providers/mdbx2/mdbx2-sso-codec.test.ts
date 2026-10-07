import {expect,it} from 'vitest';
import {decodeMdbx2Object,encodeMdbx2Object} from './mdbx2-item-codec';

function decode(payload:Record<string,unknown>) {
  const result=decodeMdbx2Object({objectId:'sso-object',collectionId:'folder',objectTypeId:'login',title:'SSO',payloadSchemaVersion:1,deleted:false,payloadJson:JSON.stringify(payload)},{headCommitId:'head',updatedAt:'2026-10-01T00:00:00Z'},'provider').item;
  if(result?.kind!=='login')throw new Error('Expected login');
  return result;
}
it('reads native SSO fields and persists provider/reference changes and explicit unlink',()=>{
  const payload={kind:'password',monica_entry_id:'password:sso',login_type:'SSO',sso_provider:'GOOGLE',sso_ref_entry_id:42,sso_ref_logical_id:'password:account',future:{keep:true}};
  const original=decode(payload);
  expect(original).toMatchObject({loginType:'SSO',ssoProvider:'GOOGLE',ssoRefEntryId:42});
  expect(original.ssoRefLogicalId).toBe('password:account');
  expect(JSON.parse(encodeMdbx2Object({...original,title:'Renamed'},payload,original)!.payloadJson)).toEqual(payload);
  const changed=JSON.parse(encodeMdbx2Object({...original,ssoProvider:'GITHUB',ssoRefEntryId:73},payload,original)!.payloadJson);
  expect(changed).toMatchObject({sso_provider:'GITHUB',sso_ref_entry_id:73,future:{keep:true}});
  expect(decode(changed)).toMatchObject({ssoProvider:'GITHUB',ssoRefEntryId:73});
  const cleared=JSON.parse(encodeMdbx2Object({...original,ssoRefEntryId:undefined},payload,original)!.payloadJson);
  expect(cleared.sso_ref_entry_id).toBeNull();
  expect(decode(cleared).ssoRefEntryId).toBeUndefined();
});
it('preserves absent, null and legacy SSO wire shapes during unrelated edits',()=>{
  for(const fields of [{},{sso_provider:null,sso_ref_entry_id:null},{ssoProvider:'OTHER',ssoRefEntryId:91}]) {
    const payload={kind:'password',monica_entry_id:'password:sso',login_type:'SSO',...fields};
    const original=decode(payload);
    expect(JSON.parse(encodeMdbx2Object({...original,title:'Renamed'},payload,original)!.payloadJson)).toEqual(payload);
  }
});
it('does not resurrect a legacy reference after an explicit native unlink',()=>{
  const payload={kind:'password',monica_entry_id:'password:sso',login_type:'SSO',ssoProvider:'OTHER',ssoRefEntryId:91};
  const original=decode(payload);
  expect(original.ssoRefEntryId).toBe(91);
  const cleared=JSON.parse(encodeMdbx2Object({...original,ssoRefEntryId:undefined},payload,original)!.payloadJson);
  expect(cleared.sso_ref_entry_id).toBeNull();
  expect(decode(cleared).ssoRefEntryId).toBeUndefined();
});
