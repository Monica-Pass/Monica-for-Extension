import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { decodeBitwardenCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import type { PasskeyItem } from '../../src/core/model';

const directory=path.resolve('.tmp/android-bitwarden-repaired-318');
const password='Synthetic returned copies password',email='copies-return@example.invalid';
const host='https://copies-return.example.test',rp='example.test';
const challenge=Buffer.alloc(32,83).toString('base64url');
const html=`<!doctype html><title>Returned Passkey copies</title><button id="login">Sign in</button><output id="result"></output><script>
window.credentialId='';login.onclick=async()=>{result.textContent='waiting';try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'required'})});window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent=e.name+':'+e.message;}};</script>`;
async function send(page:Page,request:object):Promise<any>{const result=await page.evaluate(input=>chrome.runtime.sendMessage(input),request);expect(result.ok,result.error).toBe(true);return result.data;}
async function approve(context:BrowserContext,page:Page,index:number){
  await expect(page.locator('#monica-passkey-prompt-host')).toHaveCount(1);
  await expect.poll(()=>page.evaluate(()=>document.activeElement?.id)).toBe('monica-passkey-prompt-host');
  // Real trusted keyboard selection also confirms a duplicate credential's exact source binding.
  await page.keyboard.press('Home');for(let i=0;i<index;i++)await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');await page.keyboard.press('Tab');
  const opened=context.waitForEvent('page');await page.keyboard.press('Enter');const verification=await opened;
  await verification.getByLabel('Monica 主密码',{exact:true}).fill(password);
  await verification.getByRole('button',{name:'确认',exact:true}).click();
}
for(const name of ['copies-complete','copies-cancel'])test(`Android repaired ${name} returns every source binding to actual browser sign-in`,async ({},info)=>{
  test.skip(process.env.MONICA_BITWARDEN_SNAPSHOT_PHASE!=='return','Explicit repaired Android return required');
  expect(path.resolve(process.env.MONICA_BITWARDEN_SNAPSHOT_DIR||'')).toBe(directory);
  const read=async(file:string)=>JSON.parse(await readFile(path.join(directory,file),'utf8'));
  const input=await read(`${name}-input.json`),device=await read('android-bitwarden-copies.json');
  const returned=device.cases.find((row:any)=>row.name===name);expect(returned.status).toBe('passed');
  const rows:any[]=structuredClone(returned.ciphers),before=structuredClone(rows);
  const key={encKey:new Uint8Array(Buffer.from(input.vaultKeyEnc,'base64')),macKey:new Uint8Array(Buffer.from(input.vaultKeyMac,'base64'))};
  const protectedKey=await new BitwardenClient().protectVaultKey(key,await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(password,email,{type:0,iterations:10_000})),new Uint8Array(16));
  const events:string[]=[];let revision=0;
  const options={locale:'zh-CN',args:[`--disable-extensions-except=${path.resolve('dist')}`,`--load-extension=${path.resolve('dist')}`]};
  let context=await launchEdgeContext(info.outputPath('profile'),options);
  const route=async()=>{
    await context.route(`${host}/**`,async route=>{
      const request=route.request(),url=new URL(request.url()),method=request.method();
      const json=(body:unknown,status=200)=>route.fulfill({contentType:'application/json',body:JSON.stringify(body),status});
      if(url.pathname==='/identity/accounts/prelogin/password')return json({Kdf:0,KdfIterations:10_000});
      if(url.pathname==='/identity/connect/token')return json({access_token:'synthetic',refresh_token:'synthetic',expires_in:3600,Key:protectedKey});
      if(url.pathname==='/api/sync')return json({Profile:{Id:'snapshot',Email:email},Ciphers:rows,Folders:[]});
      const match=url.pathname.match(/^\/api\/ciphers\/([^/]+)(?:\/details)?$/);
      if(match){
        const index=rows.findIndex(row=>row.id===match[1]);if(index<0)return json({},404);
        if(method==='GET'){events.push(`get:${match[1]}`);return json(rows[index]);}
        if(method==='PUT'){
          const incoming=request.postDataJSON();expect(incoming.lastKnownRevisionDate).toBe(rows[index].revisionDate);
          delete incoming.lastKnownRevisionDate;
          rows[index]={...incoming,id:rows[index].id,creationDate:rows[index].creationDate,revisionDate:new Date(Date.UTC(2026,9,11,0,0,++revision)).toISOString()};
          events.push(`update:${match[1]}`);return json(rows[index]);
        }
      }
      events.push(`unexpected:${method}:${url.pathname}`);return route.abort('failed');
    });
    await context.route(`https://${rp}/**`,route=>route.fulfill({contentType:'text/html',body:html}));
  };
  let assertions=0;
  try{
    await route();let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    let manager=await context.newPage();await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(manager,{type:'VAULT_SETUP',masterPassword:password});await manager.evaluate(()=>chrome.storage.local.set({'monica.sync.preferences.v1':{enabled:false}}));
    const {providerId}=await send(manager,{type:'BITWARDEN_LOGIN',name:'Returned Android copies',vaultUrl:host,email,masterPassword:password,isDefaultSaveTarget:true});
    await send(manager,{type:'PROVIDER_SYNC',providerId});let website=await context.newPage();await website.goto(`https://${rp}/`);
    for(const restarted of [false,true]){
      if(restarted){
        await send(manager,{type:'VAULT_LOCK'});await context.close();context=await launchEdgeContext(info.outputPath('profile'),options);await route();
        worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');manager=await context.newPage();await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
        await send(manager,{type:'VAULT_UNLOCK',masterPassword:password});website=await context.newPage();await website.goto(`https://${rp}/`);
      }
      for(const wanted of input.expected){
        const items=(await send(manager,{type:'VAULT_LIST_ITEMS'}) as PasskeyItem[]).filter(row=>row.kind==='passkey'&&row.credentialId===wanted.credentialId);
        const index=items.findIndex(row=>row.providerRefs[0].remoteId?.split('#')[0]===wanted.cipherId);expect(index).toBeGreaterThanOrEqual(0);
        const selected=items[index],count=selected.signCount===0?0:selected.signCount+1;
        await website.evaluate(id=>{(window as any).credentialId=id;},wanted.credentialId);await website.locator('#login').click();await approve(context,website,index);
        await expect(website.locator('#result')).toHaveText('authenticated');const assertion=await website.evaluate(()=>(window as any).assertion);
        expect(assertion.id).toBe(wanted.credentialId);expect(assertion.response.userHandle).toBe(wanted.userHandle);
        const auth=Buffer.from(assertion.response.authenticatorData,'base64url'),client=Buffer.from(assertion.response.clientDataJSON,'base64url');
        expect(auth.subarray(0,32)).toEqual(createHash('sha256').update(rp).digest());expect(auth[32]).toBe(0x1d);expect(auth.readUInt32BE(33)).toBe(count);
        expect(JSON.parse(client.toString())).toMatchObject({origin:`https://${rp}`,challenge,type:'webauthn.get',crossOrigin:false});
        expect(verify('sha256',Buffer.concat([auth,createHash('sha256').update(client).digest()]),createPublicKey({key:Buffer.from(wanted.spki,'base64'),format:'der',type:'spki'}),Buffer.from(assertion.response.signature,'base64url'))).toBe(true);
        const after=(await send(manager,{type:'VAULT_LIST_ITEMS'}) as PasskeyItem[]).find(row=>row.id===selected.id)!;
        expect(after).toMatchObject({signCount:count,useCount:(selected.useCount||0)+1,privateKeyPkcs8:selected.privateKeyPkcs8});assertions++;
      }
    }
    // Counter writes must not modify sibling keys, passwords, shared fields or notes.
    for(const prior of before){
      const oldItems=(await decodeBitwardenCipher(prior,'snapshot',key)).items;
      const newItems=(await decodeBitwardenCipher(rows.find(row=>row.id===prior.id),'snapshot',key)).items;
      const stable=(items:typeof oldItems)=>items.map(item=>{const value=structuredClone(item) as any;delete value.updatedAt;delete value.providerRefs;delete value.signCount;return value;});
      expect(stable(newItems)).toEqual(stable(oldItems));
    }
    expect(events.filter(event=>event.startsWith('unexpected:'))).toEqual([]);
    expect(events.filter(event=>event.startsWith('update:'))).toHaveLength(input.expected.filter((row:any)=>row.signCount>0).length*2);
    await writeFile(path.join(directory,`edge-return-${name}.json`),JSON.stringify({status:'passed',assertions,restarted:true,explicitSourceSelection:true,syntheticHttp:true,events},null,2));
  }finally{await context.close();}
});
