import {expect,it} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {readAndroidBackup,writeAndroidBackup} from './android-backup-codec';
import {resolveSsoAccount} from '../../core/sso-links';

it('preserves a stable account relation through real ZIP encode/decode and unrelated edits',()=>{
  const rawAccount={id:1,title:'Account',username:'user@example.test',replicaGroupId:'password:account'};
  const rawWebsite={id:2,title:'Website',loginType:'SSO',ssoProvider:'GOOGLE',replicaGroupId:'password:website',ssoRefLogicalId:'password:account',ssoRefEntryId:null,future:{retained:true}};
  const zip=zipSync({'folders/_root/passwords/password_1_0.json':strToU8(JSON.stringify(rawAccount)),'folders/_root/passwords/password_2_0.json':strToU8(JSON.stringify(rawWebsite))});
  const document=readAndroidBackup(zip,'source');
  const website=document.items.find(item=>item.title==='Website')!;if(website.kind!=='login')throw new Error('Expected login');
  expect(resolveSsoAccount(website,document.items)?.title).toBe('Account');
  const output=writeAndroidBackup(document,document.items.map(item=>item.id===website.id?{...item,title:'Renamed'}:item),'source');
  const reopened=readAndroidBackup(output,'other-installation');
  const renamed=reopened.items.find(item=>item.title==='Renamed')!;if(renamed.kind!=='login')throw new Error('Expected login');
  expect(renamed.ssoRefLogicalId).toBe('password:account');
  expect(resolveSsoAccount(renamed,reopened.items)?.username).toBe('user@example.test');
  expect(reopened.records.get(renamed.id)?.raw.future).toEqual({retained:true});
  const cleared=writeAndroidBackup(reopened,reopened.items.map(item=>item.id===renamed.id?{...item,ssoRefLogicalId:undefined}:item),'other-installation');
  const clearedWebsite=readAndroidBackup(cleared,'final').items.find(item=>item.title==='Renamed');
  expect(clearedWebsite).toMatchObject({ssoRefLogicalId:undefined});
});

it('writes a newly assigned stable reference without manufacturing a Room ID',()=>{
  const document=readAndroidBackup(zipSync({'folders/_root/passwords/password_3_0.json':strToU8(JSON.stringify({id:3,title:'New link',loginType:'SSO'}))}),'source');
  const output=writeAndroidBackup(document,document.items.map(item=>({...item,ssoRefLogicalId:'password:new-account'})),'source');
  const reopened=readAndroidBackup(output,'destination');
  expect(reopened.items[0]).toMatchObject({ssoRefLogicalId:'password:new-account',ssoRefEntryId:undefined});
  expect(reopened.records.get(reopened.items[0].id)?.raw.ssoRefLogicalId).toBe('password:new-account');
});
