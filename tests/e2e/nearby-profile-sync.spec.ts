import {test,expect,type BrowserContext} from '@playwright/test';
import {build} from 'esbuild';
import {copyFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import path from 'node:path';
import {launchEdgeContext} from './fixtures/edge';
import {createEmptyVaultState} from '../../src/core/model';
import {applyNearbyLocalBatch,captureNearbyLocalSnapshot} from '../../src/nearby/local-adoption';
import type {NearbyNativeSource} from '../../src/nearby/native-source';
import type {NearbyNativeProjection} from '../../src/nearby/native-records';
import {NATIVE_COLLECTION_ARCHIVE} from '../../src/nearby/native-profiles';
import {adoptNearbyNativeGroups} from '../../src/nearby/native-batches';
import {NearbyDataError,type NearbyWireData} from '../../src/nearby/wire-shape';
import {groupNearbyPending} from '../../src/nearby/pending';
import {scheduleNearbyNativeGroups} from '../../src/nearby/native-schedule';

test('native profiles survive local forwarding, atomic restoration and independent foreign root archives',async({},info)=>{
  test.skip(process.platform!=='win32','Installed Edge');test.setTimeout(240000);
  const run=path.resolve(info.outputPath('isolated')),extension=path.join(run,'extension'),database=`synthetic-profile-sync-${randomUUID()}`;
  await mkdir(extension,{recursive:true});
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Synthetic profile sync',version:'1.0.0',background:{service_worker:'background.js'},content_security_policy:{extension_pages:"script-src 'self' 'wasm-unsafe-eval'; object-src 'none'"}}));
  await writeFile(path.join(extension,'background.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
  await writeFile(path.join(extension,'index.html'),'<script src="harness.js"></script>');
  await writeFile(path.join(extension,'harness.js'),`const worker=new Worker('./worker.js',{type:'module'}),pending=new Map();worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error.code+': '+data.error.message)):p.resolve(data.result);};window.probe=(op,data)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});worker.postMessage({id,op,data});});`);
  for(const name of ['engine.js','monica_mdbx2_browser.wasm'])await copyFile(path.resolve('native/mdbx2-browser/pkg',name),path.join(extension,name));
  await build({entryPoints:['tests/e2e/fixtures/mdbx-browser-worker.ts'],outfile:path.join(extension,'worker.js'),bundle:true,format:'esm',target:'chrome130',external:['./engine.js'],alias:{crypto:path.resolve('scripts/stubs/node-crypto.js')}});
  let context:BrowserContext|undefined;const evidence:Record<string,unknown>={status:'failed',androidApplicationAcceptance:false};
  try{
    const connect=async()=>{
      context=await launchEdgeContext(path.join(run,'profile'),{args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});evidence.edgeVersion=context.browser()?.version();
      const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      return(op:string,data?:unknown):Promise<any>=>page.evaluate(({op,data})=>(window as any).probe(op,data),{op,data});
    };
    let call=await connect();
    const rpc=async(method:string,params:Record<string,unknown>)=>{const r=await call('rpc',{protocol:2,requestId:randomUUID(),method,params});if(!r.ok)throw Error(r.error.code);return r.result;};
    await call('open',{name:database});const password='synthetic-profile-sync-password';
    const sourceHandle=(await rpc('vault.create',{password,mode:'multi'})).vaultHandle,targetHandle=(await rpc('vault.create',{password,mode:'multi'})).vaultHandle;
    const providerId=randomUUID(),targetProvider=randomUUID(),folder=randomUUID(),assetId=randomUUID();
    const loginId=randomUUID(),passkeyId=randomUUID(),keyPair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const privateKey=keyPair.privateKey.export({format:'der',type:'pkcs8'}),publicKey=keyPair.publicKey.export({format:'der',type:'spki'}).toString('base64');
    const credential=Buffer.from('synthetic-profile-credential').toString('base64');
    const keyPayload={credential_id:credential,rp_id:'example.test',user_id:'dXNlcg==',public_key:publicKey,public_key_algorithm:-7,private_key_alias:privateKey.toString('base64'),key_status:'portable',sign_count:19};
    const bytes=Buffer.from(Uint8Array.from({length:1024*1024},(_,i)=>(i*37+11)%256)),hash=createHash('sha256').update(bytes).digest('hex');
    const file=Buffer.alloc(1024*1024,0x5a),fileHash=createHash('sha256').update(file).digest('hex'),fileAsset=randomUUID(),fileId=randomUUID();
    const source=():Promise<NearbyNativeSource>=>call('nearby-native-source',{providerId,vaultHandle:sourceHandle});
    const target=():Promise<NearbyNativeSource>=>call('nearby-native-source',{providerId:targetProvider,vaultHandle:targetHandle});
    await call('content-write',{handle:sourceHandle,input:{operationId:randomUUID(),writeRevision:(await source()).writeRevision,plan:{commands:[
      {kind:'collection-create',collectionId:folder,title:'Profile folder',parentId:null},
      {kind:'collection-profile-set',collectionId:folder,collectionTypeId:'com.monica.passwords',payloadSchemaVersion:1,allowedObjectTypeIds:['login','passkey'],requiredCapabilityIds:[],assetId},
      {kind:'collection-presentation',collectionId:folder,favorite:true,archived:true,iconRef:'key'},
      {kind:'object-create',collectionId:folder,objectId:loginId,objectTypeId:'login',title:'Profile password',payloadJson:JSON.stringify({kind:'password',username:'alice',password_plain:'synthetic-profile-password',monica_password_encoding:'plaintext-v1'})},
      {kind:'object-create',collectionId:folder,objectId:passkeyId,objectTypeId:'passkey',title:'Profile Passkey',payloadJson:JSON.stringify(keyPayload)}],attachments:[]},assets:[{id:assetId,base64:bytes.toString('base64')}]}});
    await call('content-write',{handle:sourceHandle,input:{operationId:randomUUID(),writeRevision:(await source()).writeRevision,plan:{commands:[],attachments:[
      {kind:'create',attachmentId:fileId,collectionId:folder,objectId:null,fileName:'profile-folder-file.bin',mediaType:'application/octet-stream',assetId:fileAsset}]},assets:[{id:fileAsset,base64:file.toString('base64')}]}});
    const before=await source(),projection:NearbyNativeProjection=await call('nearby-native-project',before);expect(projection.blockers).toEqual([]);
    const original=projection.records.find(r=>r.global_id===folder)!;expect(JSON.stringify(original.data).length).toBeLessThan(4000);
    let local=createEmptyVaultState(),localSnapshot=await captureNearbyLocalSnapshot(local);const localProvider=local.providers.find(p=>p.kind==='local')!.id;
    local=(await applyNearbyLocalBatch(local,{providerId:localProvider,sourceHash:localSnapshot.sourceHash,records:projection.records.map(r=>({id:r.global_id,deleted:r.deleted,clockJson:'{"source":1}',dataJson:JSON.stringify(r.data)})),assets:[{id:hash,dataBase64:bytes.toString('base64')},{id:fileHash,dataBase64:file.toString('base64')}]},'2026-10-15T00:00:00Z')).state;
    localSnapshot=await captureNearbyLocalSnapshot(JSON.parse(JSON.stringify(local)));expect(localSnapshot.records.find(r=>r.global_id===folder)!.data).toEqual(original.data);expect(localSnapshot.assets.find(a=>a.id===hash)!.dataBase64).toBe(bytes.toString('base64'));
    let current=await target();
    const records=localSnapshot.records.map(r=>({id:r.global_id,deleted:r.deleted,clockJson:'{"source":1}',dataJson:JSON.stringify(r.data)}));
    const empty:NearbyNativeProjection=await call('nearby-native-project',current);
    const groups=scheduleNearbyNativeGroups(groupNearbyPending(records,new Map(),new Map(),128,false),{sourceHash:current.sourceHash,records:empty.records,readAsset:async()=>{throw Error('not used');}});
    const adoptRecords=async(values:typeof records)=>{
      let plan;try{plan=await call('nearby-native-adopt-plan',{source:current,batch:{operationId:randomUUID(),sourceHash:current.sourceHash,records:values,assets:localSnapshot.assets}});}
      catch(error){if(String(error).includes('native-adoption-limit'))throw new NearbyDataError('native-adoption-limit');throw error;}
      if(plan.remainingWrites?.length){
        await call('nearby-native-journal-stage',{plan});
        await call('content-write',{handle:targetHandle,input:plan.write});
        await call('nearby-native-journal-scan',[password,bytes.toString('base64').slice(0,512),file.toString('base64').slice(0,512)]);
        await call('close');await context!.close();context=undefined;call=await connect();await call('open',{name:database});
        await rpc('vault.open',{source:{kind:'vault',handle:targetHandle},credential:{method:'password',password}});
        const retained=await call('nearby-native-journal-read');
        const recovered=await call('nearby-native-coordinator-recover',{operationId:retained.intent.operationId});expect(recovered.applied).toBe(values.length);
        expect((await call('nearby-native-journal-read')).intent).toBeUndefined();return recovered;
      }
      expect(plan.write.plan.attachments).toEqual([]);return call('content-write',{handle:targetHandle,input:plan.write});
    };
    while(groups.length){const adopted=await adoptNearbyNativeGroups(groups,adoptRecords);let used=0;while(used<adopted.count)used+=groups.shift()!.length;current=await target();}
    expect(Buffer.from(current.profiles![0].payloadBase64,'base64').equals(bytes)).toBe(true);
    expect(current.collections.find(c=>c.collectionId===folder)).toMatchObject({favorite:true,archived:true,iconRef:'key'});
    const copiedFile=current.attachments.find(a=>a.collectionId===folder&&!a.deleted)!;
    expect(await call('content-attachment-bytes',{handle:targetHandle,input:{writeRevision:current.writeRevision,attachment:copiedFile}})).toEqual({sizeBytes:file.length,sha256:fileHash});
    let outgoing:NearbyNativeProjection=await call('nearby-native-project',current);expect(outgoing.blockers).toEqual([]);
    expect(outgoing.records.find(r=>r.global_id===folder)!.data).toEqual(original.data);
    expect(JSON.parse(current.objects.find(o=>o.summary.objectId===loginId)!.record!.payloadJson).password_plain).toBe('synthetic-profile-password');
    expect(await call('verify-key',{payload:current.objects.find(o=>o.summary.objectId===passkeyId)!.record!.payloadJson,expected:{id:credential,hash:createHash('sha256').update(privateKey).digest('hex'),publicKey,counter:19}})).toBe(true);
    // Foreign roots use ordinary owned files. They must not install a profile
    // or change the favorite/archive/icon fields of the shared target root.
    const rootBefore=current.collections.find(c=>c.collectionId===current.rootId)!;
    const roots=[randomUUID(),randomUUID()],rootData:NearbyWireData={...structuredClone(original.data as NearbyWireData),entry_type:'vault-metadata',title:'Foreign root'};
    delete (rootData.payload as any).path;
    let remaining=roots.map(id=>[{id,deleted:false,clockJson:'{"source":1}',dataJson:JSON.stringify(rootData)}]);const attempts:number[]=[];
    while(remaining.length){
      const adopted=await adoptNearbyNativeGroups(remaining,async records=>{
        attempts.push(records.length);let plan;
        try{plan=await call('nearby-native-adopt-plan',{source:current,batch:{operationId:randomUUID(),sourceHash:current.sourceHash,records,assets:localSnapshot.assets}});}
        catch(error){if(String(error).includes('native-adoption-limit'))throw new NearbyDataError('native-adoption-limit');throw error;}
        expect(plan.write.plan.commands.some((c:any)=>c.kind==='collection-profile-set'||c.kind==='collection-presentation')).toBe(false);
        if(plan.remainingWrites?.length){
          const result=await call('nearby-native-adopt',{source:current,batch:{sourceHash:current.sourceHash,records,assets:localSnapshot.assets}});
          expect(result.acknowledgements).toHaveLength(records.length);return result;
        }
        return call('content-write',{handle:targetHandle,input:plan.write});
      });remaining=remaining.slice(adopted.count);current=await target();
    }
    expect(attempts).toEqual([2,1,1]);outgoing=await call('nearby-native-project',current);
    expect(current.profiles).toHaveLength(1);expect(current.collections.find(c=>c.collectionId===current.rootId)).toMatchObject({favorite:rootBefore.favorite,archived:rootBefore.archived,iconRef:rootBefore.iconRef});
    for(const id of roots)expect((outgoing.records.find(r=>r.global_id===id)!.data.payload as any)[NATIVE_COLLECTION_ARCHIVE]).toEqual((original.data.payload as any)[NATIVE_COLLECTION_ARCHIVE]);
    const deleted=outgoing.records.find(r=>r.global_id===roots[0])!,survivor=outgoing.records.find(r=>r.global_id===roots[1])!;
    const purge=await call('nearby-native-adopt-plan',{source:current,batch:{operationId:randomUUID(),sourceHash:current.sourceHash,records:[{
      id:roots[0],deleted:true,clockJson:'{"source":2}',dataJson:'{}',localId:deleted.local_id,scope:deleted.scope,expectedGuard:deleted.guard}],assets:[]}});
    expect(purge.remainingWrites?.length).toBeGreaterThan(0);
    await call('nearby-native-journal-stage',{plan:purge});await call('nearby-native-journal-recover');current=await target();outgoing=await call('nearby-native-project',current);
    expect(outgoing.records.find(r=>r.global_id===roots[1])!.data).toEqual(survivor.data);
    const files=current.attachments.filter(a=>a.collectionId===current.rootId&&!a.deleted);expect(files).toHaveLength(2);
    expect(await call('content-attachment-bytes',{handle:targetHandle,input:{writeRevision:current.writeRevision,attachment:files.find(a=>a.contentHash===hash)!}})).toEqual({sizeBytes:bytes.length,sha256:hash});
    expect(await call('content-attachment-bytes',{handle:targetHandle,input:{writeRevision:current.writeRevision,attachment:files.find(a=>a.contentHash===fileHash)!}})).toEqual({sizeBytes:file.length,sha256:fileHash});
    await call('scan',[password,bytes.toString('base64').slice(0,512)]);await call('close');await context!.close();context=undefined;
    call=await connect();await call('open',{name:database});await rpc('vault.open',{source:{kind:'vault',handle:targetHandle},credential:{method:'password',password}});
    const restarted=await target();expect(restarted.profiles).toEqual(current.profiles);expect(restarted.writeRevision).toEqual(current.writeRevision);
    const restored:NearbyNativeProjection=await call('nearby-native-project',restarted);expect(restored.records.find(r=>r.global_id===folder)!.data).toEqual(original.data);
    // A second receive is interrupted AFTER a binary step has committed. A
    // genuine subsequent native edit must survive both restart and repeated
    // recovery, while every already-applied incoming byte remains encrypted.
    const conflictOwner=randomUUID(),conflictData=structuredClone(rootData),previousJournal=await call('nearby-native-journal-read');
    const conflictPlan=await call('nearby-native-adopt-plan',{source:restarted,batch:{operationId:randomUUID(),sourceHash:restarted.sourceHash,
      records:[{id:conflictOwner,deleted:false,dataJson:JSON.stringify(conflictData),clockJson:'{"syntheticPeer":1}'}],assets:localSnapshot.assets}});
    expect(conflictPlan.remainingWrites?.length).toBeGreaterThan(1);
    await call('nearby-native-journal-stage',{plan:conflictPlan});
    const allWrites=[conflictPlan.write,...conflictPlan.remainingWrites];
    const firstBinary=allWrites.findIndex(w=>w.assets.length>0);expect(firstBinary).toBeGreaterThanOrEqual(0);
    await expect(call('nearby-native-journal-recover',{pauseAfterConfirmedSteps:firstBinary+1})).rejects.toThrow('synthetic-interruption');
    const partial=await call('nearby-native-journal-read');expect(partial.acknowledgements).toEqual(previousJournal.acknowledgements);
    const committedAsset=partial.intent.sequence.completed.flatMap((step:any)=>step.write.assets)[0];expect(committedAsset).toBeTruthy();
    expect(Buffer.from(committedAsset.dataBase64,'base64')).toEqual(Buffer.from(allWrites[firstBinary].assets[0].base64,'base64'));
    await call('content-write',{handle:targetHandle,input:{operationId:randomUUID(),writeRevision:(await target()).writeRevision,plan:{commands:[{
      kind:'object-update',objectId:loginId,collectionId:folder,objectTypeId:'login',title:'Local edit after interrupted receive',
      payloadJson:JSON.stringify({...JSON.parse(restarted.objects.find(o=>o.summary.objectId===loginId)!.record!.payloadJson),notes:'synthetic newer local note'})
    }],attachments:[]},assets:[]}});
    const edited=await target();
    for(let attempt=0;attempt<2;attempt++){
      await expect(call('nearby-native-coordinator-recover',{operationId:partial.intent.operationId})).rejects.toThrow('native-sequence-conflict');
      const retained=await call('nearby-native-journal-read');expect(retained.intent.sequence.conflict).toBe(true);expect(retained.acknowledgements).toEqual(previousJournal.acknowledgements);
      expect(retained.intent.sequence.completed).toEqual(partial.intent.sequence.completed);expect(retained.intent.write).toEqual(partial.intent.write);
      expect((await target()).writeRevision).toEqual(edited.writeRevision);
      if(attempt===0){
        await call('nearby-native-journal-scan',[committedAsset.dataBase64.slice(0,512)]);
        await call('close');await context!.close();context=undefined;call=await connect();await call('open',{name:database});
        await rpc('vault.open',{source:{kind:'vault',handle:targetHandle},credential:{method:'password',password}});
      }
    }
    const afterConflict=await target();expect(afterConflict.objects.find(o=>o.summary.objectId===loginId)!.record!.title).toBe('Local edit after interrupted receive');
    expect(await call('verify-key',{payload:afterConflict.objects.find(o=>o.summary.objectId===passkeyId)!.record!.payloadJson,expected:{id:credential,hash:createHash('sha256').update(privateKey).digest('hex'),publicKey,counter:19}})).toBe(true);
    const history=await rpc('history.list',{vaultHandle:targetHandle,pageSize:50,cursor:null});
    evidence.reviewHistory=history;
    evidence.reviewDiff=await rpc('history.diff',{vaultHandle:targetHandle,commitId:history.items[0].commitId});
    evidence.remainingPlan=(await call('nearby-native-journal-read')).intent.write.plan;
    const review=await call('nearby-native-coordinator-review',{operationId:partial.intent.operationId});
    expect(review).toMatchObject({editedEntries:1,interveningCommits:1});
    expect((await target()).writeRevision).toEqual(afterConflict.writeRevision);
    await call('content-write',{handle:targetHandle,input:{operationId:randomUUID(),writeRevision:afterConflict.writeRevision,plan:{commands:[{
      kind:'object-update',objectId:loginId,collectionId:folder,objectTypeId:'login',title:'Local edit after review',
      payloadJson:JSON.stringify({...JSON.parse(afterConflict.objects.find(o=>o.summary.objectId===loginId)!.record!.payloadJson),notes:'synthetic latest local note'})
    }],attachments:[]},assets:[]}});
    await expect(call('nearby-native-coordinator-confirm',{reviewId:review.reviewId})).rejects.toThrow('native-recovery-changed');
    const finalReview=await call('nearby-native-coordinator-review',{operationId:partial.intent.operationId,loseConfirmedReply:true});
    expect(finalReview).toMatchObject({editedEntries:1,interveningCommits:2});
    await expect(call('nearby-native-coordinator-confirm',{reviewId:finalReview.reviewId})).rejects.toThrow();
    const approved=(await call('nearby-native-journal-read')).intent;
    expect(approved.operationId).not.toBe(partial.intent.operationId);
    expect(approved.sequence.resolutions).toHaveLength(1);
    expect(approved.sequence.completed).toEqual(partial.intent.sequence.completed);
    await call('close');await context!.close();context=undefined;call=await connect();await call('open',{name:database});
    await rpc('vault.open',{source:{kind:'vault',handle:targetHandle},credential:{method:'password',password}});
    expect(await call('nearby-native-coordinator-recover',{operationId:approved.operationId})).toEqual({applied:1});
    expect((await call('nearby-native-journal-read')).intent).toBeUndefined();
    const continued=await target(),forwarded:NearbyNativeProjection=await call('nearby-native-project',continued);
    expect(continued.objects.find(o=>o.summary.objectId===loginId)!.record!.title).toBe('Local edit after review');
    expect(JSON.parse(continued.objects.find(o=>o.summary.objectId===loginId)!.record!.payloadJson).notes).toBe('synthetic latest local note');
    const receivedData=forwarded.records.find(r=>r.global_id===conflictOwner)!.data;
    expect({...receivedData,assets:undefined}).toEqual({...conflictData,assets:undefined});
    const expectedAssets=conflictData.assets;
    if(!Array.isArray(expectedAssets))throw new Error('Expected conflict fixture assets');
    expect(receivedData.assets).toHaveLength(expectedAssets.length);
    expect(receivedData.assets).toEqual(expect.arrayContaining(expectedAssets));
    for(const attachment of continued.attachments.filter(a=>a.collectionId===continued.rootId&&!a.deleted)) {
      expect([hash,fileHash]).toContain(attachment.contentHash);
      expect(await call('content-attachment-bytes',{handle:targetHandle,input:{writeRevision:continued.writeRevision,attachment}})).toEqual({sizeBytes:1048576,sha256:attachment.contentHash});
    }
    expect(await call('verify-key',{payload:continued.objects.find(o=>o.summary.objectId===passkeyId)!.record!.payloadJson,expected:{id:credential,hash:createHash('sha256').update(privateKey).digest('hex'),publicKey,counter:19}})).toBe(true);
    await call('close');Object.assign(evidence,{status:'passed',binaryBytes:bytes.length,fileBytes:file.length,encryptedSequenceRestartRecovery:true,offlineCoordinatorRecovery:true,
      explicitNonOverlapContinuation:true,editAfterReviewRejected:true,committedReplyLossRecovered:true,
      actualInterveningEditRetained:true,completedBinaryInputsRetained:true,conflictSurvivesRestart:true,localForwarding:true,nativeRestore:true,stableProjection:true,profiledPassword:true,profiledPasskeySignature:true,counter19Preserved:true,rootOwnerIsolation:true,purgePreservesOtherRoot:true,restart:true,sha256:hash});
  }finally{await context?.close();await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2));}
});
