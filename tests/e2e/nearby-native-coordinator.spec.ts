import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import path from 'node:path';
import { createLoginItem, type PasskeyItem } from '../../src/core/model';
import { createPasskey } from '../../src/passkey/webauthn-core';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';

const password = 'Synthetic nearby manager password';
async function runtime(page: Page, request: unknown): Promise<any> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(result.ok, JSON.stringify(result)).toBe(true); return result.data;
}
async function connect(page: Page): Promise<void> {
  await page.evaluate(() => {
    const port = chrome.runtime.connect({ name: 'monica-nearby-manager-v1' });
    const state = { port, id: 0, messages: [] as any[], disconnected: false };
    (window as any).nearbyManagerTest = state;
    port.onMessage.addListener(value => state.messages.push(value));
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; state.disconnected = true; });
  });
  await page.waitForFunction(() => (window as any).nearbyManagerTest.messages.some((m: any) => ['ready','closed'].includes(m.type)) || (window as any).nearbyManagerTest.disconnected, undefined, {timeout:15000});
  expect(await page.evaluate(()=>(window as any).nearbyManagerTest.messages)).toContainEqual({type:'ready'});
}
async function command(page: Page, request: Record<string, unknown>): Promise<any> {
  const id = await page.evaluate(request => {
    const state = (window as any).nearbyManagerTest; const id = ++state.id; state.port.postMessage({ ...request, id }); return id;
  }, request);
  await page.waitForFunction(id => (window as any).nearbyManagerTest.messages.some((m: any) => m.id === id), id);
  const result = await page.evaluate(id => (window as any).nearbyManagerTest.messages.find((m: any) => m.id === id), id);
  expect(result.ok, JSON.stringify(result)).toBe(true); return result.data;
}
async function closed(page: Page, reason: string) {
  await page.waitForFunction(reason => (window as any).nearbyManagerTest.messages.some((m: any) => m.type === 'closed' && m.reason === reason), reason);
}
async function cancel(page: Page) {
  await page.evaluate(() => { const s = (window as any).nearbyManagerTest; s.port.postMessage({ id: ++s.id, type: 'cancel' }); });
  await closed(page, 'cancelled');
}


test('production Wi-Fi coordinator receives into bundled MDBX and returns native edits', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge and Native Messaging'); test.setTimeout(240000);
  const extension=path.resolve('dist'),run=path.resolve(info.outputPath('isolated'));await mkdir(run,{recursive:true});
  const contexts:BrowserContext[]=[], evidence:Record<string,any>={status:'failed',productionCoordinator:true,bundledMdbx:true,androidApplicationAcceptance:false};
  let registration:Awaited<ReturnType<typeof temporaryNativeHost>>|undefined;
  const launch=async(name:string)=>{
    const appData=path.join(run,`appdata-${name}`);await mkdir(appData,{recursive:true});
    const context=await launchEdgeContext(path.join(run,`profile-${name}`),{env:{...process.env,APPDATA:appData,LOCALAPPDATA:appData},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});contexts.push(context);
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);evidence.edgeVersion=context.browser()?.version();return page;
  };
  try{
    const a=await launch('a');registration=await temporaryNativeHost(new URL(a.url()).host,path.join(run,'native'));const b=await launch('b');
    for(const page of [a,b])await runtime(page,{type:'VAULT_SETUP',masterPassword:password});
    const native=await runtime(b,{type:'MDBX2_VAULT_CREATE',input:{name:'Synthetic nearby MDBX',password:'Synthetic native password'}}),providerId=native.account.id;
    const login=createLoginItem({title:'Nearby original',username:'alice',password:'synthetic preserved password'});login.customFields=[{name:'extra',value:'keep original',protected:true}];
    const key=await createPasskey({origin:'https://example.test',challenge:Buffer.alloc(32,3).toString('base64url'),rpName:'Synthetic',userId:'dXNlcg',userName:'alice',userDisplayName:'Alice',algorithms:[-7],excludeCredentialIds:[]});
    const passkey:PasskeyItem={...createLoginItem({title:'Nearby original Passkey'}),kind:'passkey',rpId:key.rpId,rpName:'Synthetic',userHandle:'dXNlcg',userName:'alice',userDisplayName:'Alice',credentialId:key.credentialId,publicKey:key.publicKeySpki,privateKeyPkcs8:key.privateKeyPkcs8,signCount:0,algorithm:-7,discoverable:true,backupEligible:true,sourceMode:'browser-local'};
    const groupId=crypto.randomUUID(),bulk=Array.from({length:140},(_,i)=>({...createLoginItem({title:`Batch ${i}`,password:`synthetic-${i}`}),...(i<40?{passwordGroupId:groupId}:{})}));
    await runtime(a,{type:'VAULT_IMPORT_ITEMS',items:[login,passkey,...bulk]});
    const localProvider=(await runtime(a,{type:'PROVIDER_LIST'})).find((p:any)=>p.kind==='local').id;
    const fileBytes=Buffer.alloc(600000,137),fileHash=createHash('sha256').update(fileBytes).digest('hex');
    const upload=await runtime(a,{type:'PROVIDER_ATTACHMENT_UPLOAD_BEGIN',providerId:localProvider,itemId:login.id,fileName:'preserved.bin',mediaType:'application/octet-stream',sizeBytes:fileBytes.length,sha256:fileHash});
    for(let offset=0;offset<fileBytes.length;offset+=128000)await runtime(a,{type:'PROVIDER_ATTACHMENT_UPLOAD_CHUNK',providerId:localProvider,transferId:upload.transferId,offset,dataBase64:fileBytes.subarray(offset,offset+128000).toString('base64')});
    await runtime(a,{type:'PROVIDER_ATTACHMENT_UPLOAD_FINISH',providerId:localProvider,itemId:login.id,transferId:upload.transferId});
    await connect(a);await connect(b);
    const p=await command(b,{type:'preferences'});await command(b,{type:'update',epoch:p.epoch,change:{kind:'source',providerId}});
    const complete=async(includeReceived=false)=>expect.poll(async()=>{
      const pages=[a,b], result=await Promise.all(pages.map(page=>command(page,{type:'progress'})));
      for(let i=0;i<result.length;i++) if(result[i].deletionReview?.incoming){
        expect(result[i].phase).toBe('review'); expect(result[i].deletionReview.count).toBe(1);
        await command(pages[i],{type:'confirm-deletions',reviewId:result[i].deletionReview.id,choice:includeReceived?'include':'omit'});
      }
      return result.map(v=>v.phase);
    },{timeout:45000}).toEqual(['completed','completed']);
    const pair=await command(a,{type:'pair'});await command(b,{type:'pair',invitation:pair.pairing.invitations[0]});await complete();
    const peerA=(await command(a,{type:'status'})).peerId,peerB=(await command(b,{type:'status'})).peerId;
    const exchange=async(automaticDiscovery=false,includeDeletions=false)=>{
      for(const [page,peerId]of [[a,peerA],[b,peerB]]as const){let v=await command(page,{type:'prepare',peerId});
        if(v.review)v=await command(page,{type:'confirm',reviewId:v.review.id});
        if(v.deletionReview)v=await command(page,{type:'confirm-deletions',reviewId:v.deletionReview.id,choice:includeDeletions?'include':'omit'});
        expect(v.phase).toBe('ready');}
      const aListens=peerB>peerA;
      const transfer=await command(aListens?a:b,{type:'start'});await command(aListens?b:a,{type:'start',...(!automaticDiscovery?{endpoint:transfer.endpoint}:{})});await complete(includeDeletions);
    };
    await exchange();
    const collections=await runtime(b,{type:'MDBX2_COLLECTION_LIST',providerId});expect(collections.items.length).toBeGreaterThan(0);
    const objects:any[]=[];for(const c of collections.items)objects.push(...(await runtime(b,{type:'MDBX2_OBJECT_LIST',providerId,collectionId:c.collectionId})).items);
    const saved=objects.find(row=>row.title===login.title),savedKey=objects.find(row=>row.title===passkey.title);expect(saved).toBeTruthy();expect(savedKey).toBeTruthy();
    const original=await runtime(b,{type:'MDBX2_OBJECT_REVEAL',providerId,objectId:saved.objectId}),keyRecord=await runtime(b,{type:'MDBX2_OBJECT_REVEAL',providerId,objectId:savedKey.objectId});
    const keyPayload=JSON.parse(keyRecord.payloadJson);expect(keyPayload.private_key_alias).toBe(passkey.privateKeyPkcs8);expect(keyPayload.sign_count).toBe(0);
    const challenge=Buffer.from('real native adoption signature');expect(verify('sha256',challenge,createPublicKey({key:Buffer.from(passkey.publicKey!,'base64'),format:'der',type:'spki'}),sign('sha256',challenge,createPrivateKey({key:Buffer.from(keyPayload.private_key_alias,'base64'),format:'der',type:'pkcs8'})))).toBe(true);
    const payload=JSON.parse(original.payloadJson);payload.password_plain='synthetic reciprocal password';
    await runtime(b,{type:'MDBX2_OBJECT_UPSERT',providerId,operationId:crypto.randomUUID(),input:{logicalObjectId:`native:${saved.objectId}`,collectionId:saved.collectionId,objectTypeId:'login',title:saved.title,payloadJson:JSON.stringify(payload),payloadSchemaVersion:1,expectedHeadCommitId:original.headCommitId}});
    await exchange();const items=await runtime(a,{type:'VAULT_LIST_ITEMS'});expect(items.filter((row:any)=>row.kind==='login')).toHaveLength(141);expect(items.find((row:any)=>row.id===login.id).password).toBe('synthetic reciprocal password');
    const beforeRepeat=await runtime(b,{type:'MDBX2_OBJECT_LIST',providerId,collectionId:saved.collectionId});
    await exchange(true);expect(await runtime(b,{type:'MDBX2_OBJECT_LIST',providerId,collectionId:saved.collectionId})).toEqual(beforeRepeat);const again=await runtime(a,{type:'VAULT_LIST_ITEMS'});expect(again).toHaveLength(items.length);
    const current=await runtime(b,{type:'MDBX2_OBJECT_REVEAL',providerId,objectId:saved.objectId});
    await runtime(b,{type:'MDBX2_OBJECT_DELETE',providerId,operationId:crypto.randomUUID(),logicalObjectId:`native:${saved.objectId}`,expectedHeadCommitId:current.headCommitId});
    await exchange();expect((await runtime(a,{type:'VAULT_LIST_ITEMS'})).some((row:any)=>row.id===login.id)).toBe(true);
    // The default scan preserves the previous live replica record, so there is
    // no tombstone to explicitly include yet. Create a historical deletion in
    // a cancelled full-sync preparation, then test the one-transfer choice.
    const beforeFull=await command(b,{type:'preferences'});
    await command(b,{type:'update',epoch:beforeFull.epoch,change:{kind:'preferences',incrementalOnly:false}});
    let full=await command(b,{type:'prepare',peerId:peerB});
    if(full.review)full=await command(b,{type:'confirm',reviewId:full.review.id});
    expect(full.phase).toBe('ready');await cancel(b);await connect(b);
    const beforeProtected=await command(b,{type:'preferences'});
    await command(b,{type:'update',epoch:beforeProtected.epoch,change:{kind:'preferences',incrementalOnly:true}});
    await exchange(false,true);expect((await runtime(a,{type:'VAULT_LIST_ITEMS'})).some((row:any)=>row.id===login.id)).toBe(false);
    await runtime(a,{type:'VAULT_RESTORE_ITEM',itemId:login.id});
    await exchange();
    expect((await runtime(a,{type:'VAULT_LIST_ITEMS'})).find((row:any)=>row.id===login.id)).toBeTruthy();
    expect((await runtime(b,{type:'MDBX2_OBJECT_LIST',providerId,collectionId:saved.collectionId})).items
      .find((row:any)=>row.objectId===saved.objectId)).toMatchObject({deleted:false});
    expect(JSON.parse((await runtime(b,{type:'MDBX2_OBJECT_REVEAL',providerId,objectId:saved.objectId})).payloadJson).password_plain).toBe('synthetic reciprocal password');
    expect((await runtime(a,{type:'VAULT_LIST_ITEMS'})).filter((row:any)=>row.id===login.id)).toHaveLength(1);
    const files=await runtime(a,{type:'PROVIDER_ATTACHMENT_LIST',providerId:localProvider,itemId:login.id});expect(files.items).toHaveLength(1);
    const read=await runtime(a,{type:'PROVIDER_ATTACHMENT_READ_BEGIN',providerId:localProvider,itemId:login.id,attachmentId:files.items[0].attachmentId});
    const readBytes:Buffer[]=[];for(let offset=0;offset<fileBytes.length;){const part=await runtime(a,{type:'PROVIDER_ATTACHMENT_READ_CHUNK',providerId:localProvider,readHandle:read.readHandle,offset,maxBytes:128000});const bytes=Buffer.from(part.dataBase64,'base64');expect(bytes.length).toBeGreaterThan(0);readBytes.push(bytes);offset+=bytes.length;}
    await runtime(a,{type:'PROVIDER_ATTACHMENT_READ_RELEASE',providerId:localProvider,readHandle:read.readHandle});
    expect(createHash('sha256').update(Buffer.concat(readBytes)).digest('hex')).toBe(fileHash);
    evidence.trashAttachmentBytes=fileBytes.length;evidence.trashAttachmentHash=true;
    evidence.status='passed';evidence.signature=true;evidence.stableRepeatedSync=true;evidence.connectedProjectRecords=40;evidence.totalItemRecords=142;
  }finally{for(const c of contexts)await c.close();await registration?.restore();await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2));}
});
