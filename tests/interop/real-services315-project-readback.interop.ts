import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { LoginItem, ProviderAccount } from '../../src/core/model';
import { groupedPasswords } from '../../src/core/password-groups';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';

const path=process.env.MONICA_BW_PROJECT_EDGE_READBACK;
it.skipIf(!path)('independently reads all real Edge project writes from Vaultwarden after fresh authentication', async()=>{
  const input=JSON.parse(await readFile(resolve(path!), 'utf8')) as {synthetic:boolean;fixturePath:string;items:LoginItem[]};
  expect(input.synthetic).toBe(true);expect(input.items).toHaveLength(9);
  const fixture=JSON.parse(await readFile(input.fixturePath,'utf8'));
  expect(new URL(fixture.baseUrl).hostname).toBe('127.0.0.1');
  const report:Record<string,unknown>={status:'failed',layer:'Fresh authentication and actual server HTTP reads, with no local extension cache'};
  try{
    const login=await new BitwardenClient().login({vaultUrl:fixture.baseUrl,email:fixture.email,masterPassword:fixture.password,deviceId:randomUUID()});
    if(login.status!=='authenticated')throw new Error('Synthetic login failed');
    const account:ProviderAccount={id:'independent-server-readback',name:'Synthetic',kind:'bitwarden',enabled:true,isDefaultSaveTarget:false,config:login.session};
    const items=(await new BitwardenProvider().sync(account,{now:new Date().toISOString(),localItems:[]})).items as LoginItem[];
    expect(items).toHaveLength(9);expect(groupedPasswords(items).map(group=>group.length).sort((a,b)=>a-b)).toEqual([1,2,6]);
    const cipherId=(item:LoginItem)=>item.bitwardenCipherId??item.providerRefs.find(ref=>ref.remoteId)?.remoteId;
    const snapshot=(item:LoginItem)=>({title:item.title,username:item.username,password:item.password,notes:item.notes,uris:item.uris,
      group:item.passwordGroupId,otp:item.totpSecret??'',fields:item.customFields,cipher:cipherId(item)});
    for(const expected of input.items){const item=items.find(item=>cipherId(item)===cipherId(expected));expect(item).toBeDefined();expect(snapshot(item!)).toEqual(snapshot(expected));}
    Object.assign(report,{status:'passed',items:items.length,groups:[1,2,6],checks:['fresh authentication','all nine exact semantic records','stable cipher and project identities','independent same-title item retained']});
  }catch(error){report.error=error instanceof Error?error.message:String(error);throw error;}
  finally{await writeFile(join(dirname(resolve(path!)),'bw-project-independent-readback.json'),JSON.stringify(report,null,2));}
});
