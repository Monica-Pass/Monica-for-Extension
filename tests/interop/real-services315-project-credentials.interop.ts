import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../src/core/model';
import { groupedPasswords } from '../../src/core/password-groups';
import { readProjectCredential } from '../../src/core/project-credentials';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from '../../src/providers/bitwarden/bitwarden-durable-sync';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { decryptAndroidBackup } from '../../src/providers/webdav/android-backup-crypto';
import { readAndroidBackup } from '../../src/providers/webdav/android-backup-codec';
import { SecureVaultService } from '../../src/security/secure-vault-service';
import { MemoryVaultStorage } from '../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../src/security/vault-session';
import { addProjectCredentialPassword, projectCredentialFormGroups, setProjectCredentialFormValue } from '../../src/manager/project-credential-form';
import { createProjectPassword } from '../../src/manager/project-password-create';
import type { LoginForm } from '../../src/manager/login-form';

const configPath=process.env.MONICA_315_REAL_SERVICES_CONFIG;
it.skipIf(!configPath)('edits Android credential groups through real Vaultwarden and reconnects without losing membership', async () => {
  const config=JSON.parse(await readFile(resolve(configPath!), 'utf8')).vaultwarden as {baseUrl:string;password:string};
  expect(new URL(config.baseUrl).hostname).toBe('127.0.0.1');
  await mkdir(resolve('.tmp/bw-project-credentials-317'),{recursive:true});
  const output=await mkdtemp(join(resolve('.tmp/bw-project-credentials-317'),'run-'));
  const report:Record<string,unknown>={status:'failed',layer:'Actual Android seed archive -> real Vaultwarden HTTP and encrypted durable sync; browser/Android screen acceptance separate'};
  try {
    const root=resolve('.tmp/android-project-order-317');
    const proof=JSON.parse(await readFile(join(root,'project-credentials-export-evidence.json'),'utf8'));
    const archive=await readFile(join(root,'android-project-credentials.zip'));
    expect(proof.status).toBe('passed');
    expect(createHash('sha256').update(archive).digest('hex')).toBe(proof.outputs.find((row:{name:string})=>row.name==='android-project-credentials.zip').sha256);
    report.androidSeedSha256=createHash('sha256').update(archive).digest('hex'); report.androidVersion=proof.androidVersion;
    const seed=readAndroidBackup(await decryptAndroidBackup(archive,'synthetic archive password'),'android').items as LoginItem[];
    expect(seed).toHaveLength(3); expect(groupedPasswords(seed)).toHaveLength(1);
    const client=new BitwardenClient(), email=`project-${randomUUID()}@example.invalid`;
    const master=await deriveBitwardenMasterKey(config.password,email,{type:0,iterations:600000});
    const key={encKey:crypto.getRandomValues(new Uint8Array(32)),macKey:crypto.getRandomValues(new Uint8Array(32))};
    try {
      const response=await fetch(`${config.baseUrl}/identity/accounts/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        email,name:'Synthetic Android project interop',masterPasswordHash:await deriveBitwardenMasterPasswordHash(master,config.password),
        key:await client.protectVaultKey(key,await stretchBitwardenMasterKey(master),crypto.getRandomValues(new Uint8Array(16))),kdf:0,kdfIterations:600000
      })});expect(response.ok).toBe(true);
    } finally { master.fill(0);key.encKey.fill(0);key.macKey.fill(0); }
    const login=await client.login({vaultUrl:config.baseUrl,email,masterPassword:config.password,deviceId:randomUUID()});
    if(login.status!=='authenticated') throw new Error('Synthetic login failed');
    const account:ProviderAccount={id:'bw-project',kind:'bitwarden',name:'Android project Vaultwarden',enabled:true,isDefaultSaveTarget:false,config:login.session};
    const provider=new BitwardenProvider();
    for(const item of seed) await provider.create(account,{...item,title:'Bitwarden credential project',providerRefs:[{providerId:account.id}]});
    await provider.create(account,createLoginItem({title:'Bitwarden credential project',username:'independent',password:'independent-password',providerRefs:[{providerId:account.id}]}));
    const storage=new MemoryVaultStorage(), service=new SecureVaultService(storage,new MemoryVaultSessionStore());
    await service.setup('Synthetic local vault',[]);await service.upsertProvider(account);
    const sync=()=>new BitwardenDurableSyncCoordinator(new BitwardenProvider(),service).synchronize(account);
    await sync();
    const initial=(await service.listItems()).filter((item):item is LoginItem=>item.kind==='login');
    expect(initial).toHaveLength(4);
    const project=groupedPasswords(initial).find(rows=>rows.length===3)!;expect(project).toBeDefined();
    const independent=initial.find(item=>!item.passwordGroupId)!;
    const [anchor,...members]=project;
    const form={username:anchor.username,password:anchor.password,totpSecret:anchor.totpSecret??'',passwordGroupId:anchor.passwordGroupId,customFields:structuredClone(anchor.customFields),
      groupMembers:members.map(original=>({id:original.id,username:original.username,password:original.password,original}))} as LoginForm;
    const groups=projectCredentialFormGroups(form)!;expect(groups.map(group=>group.rows.length)).toEqual([2,1]);
    setProjectCredentialFormValue(form,groups[0].rows.map(row=>row.index),'username','server-shared');
    setProjectCredentialFormValue(form,groups[0].rows.map(row=>row.index),'totpSecret','');
    const addedId=addProjectCredentialPassword(form,groups[0].id);form.groupMembers.find(row=>row.id===addedId)!.password='server-added-password';
    const updatedAnchor={...anchor,username:form.username,totpSecret:form.totpSecret,notes:'  Shared server note\r\n\t汉字  '};
    const edited=[updatedAnchor,...form.groupMembers.map(member=>member.original?{...member.original,username:member.username,password:member.password,
      ...(member.totpSecret!==undefined?{totpSecret:member.totpSecret}:{}),...(member.customFields?{customFields:member.customFields}:{})}:createProjectPassword(updatedAnchor,member))];
    await service.savePasswordGroup(edited,Object.fromEntries(project.map(item=>[item.id,item.updatedAt])));
    await sync();
    expect((await service.readState()).mutationQueue).toHaveLength(0);
    const remote=(await new BitwardenProvider().sync({...account,id:'reconnected'}, {now:new Date().toISOString(),localItems:[]})).items as LoginItem[];
    expect(remote).toHaveLength(5);const returned=groupedPasswords(remote).find(rows=>rows.length===4)!;expect(returned).toBeDefined();
    const untouched=remote.find(item=>item.bitwardenCipherId===independent.bitwardenCipherId)!;
    expect(untouched.passwordGroupId).toBeUndefined();expect(untouched.password).toBe(independent.password);expect(untouched.notes).toBe(independent.notes);
    expect(returned.every(item=>item.notes===updatedAnchor.notes)).toBe(true);
    expect(returned.slice(0,3).every(item=>item.username==='server-shared'&&!item.totpSecret)).toBe(true);
    expect(returned[3].username).toBe('recovery-user');
    for(const original of project){const item=returned.find(item=>item.bitwardenCipherId===original.bitwardenCipherId)!;expect(item).toBeDefined();expect(item.password).toBe(original.password);expect(item.customFields).toEqual(original.customFields);}
    expect(returned.find(item=>item.password==='server-added-password')).toBeDefined();
    await service.lock();const restored=await service.unlock('Synthetic local vault');expect(restored.mutationQueue).toHaveLength(0);
    const fixture={synthetic:true,name:account.name,baseUrl:config.baseUrl,email,password:config.password,title:anchor.title,items:remote,projectId:anchor.passwordGroupId};
    await writeFile(join(output,'edge-fixture.json'),JSON.stringify(fixture,null,2));
    Object.assign(report,{status:'passed',count:remote.length,projectId:anchor.passwordGroupId,credentialGroups:new Set(returned.map(item=>readProjectCredential(item.customFields)!.groupId)).size,
      fixture:join(output,'edge-fixture.json'),checks:['actual Android three-row seed','encrypted explicit membership','atomic local group edit and queue','real durable update/create and queue drained','fresh provider connection restores four-member project','independent same-title login unchanged','local lock/unlock']});
  }catch(error){report.error=error instanceof Error?error.message:String(error);throw error;}
  finally {await writeFile(join(output,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,status:report.status}));}
});
