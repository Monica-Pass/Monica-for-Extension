import {test,expect,type BrowserContext} from '@playwright/test';
import {build} from 'esbuild';
import {copyFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {launchEdgeContext} from './fixtures/edge';

test('native folder and root metadata keep attachment ownership across native/local adoption and restart',async({},info)=>{
  test.skip(process.platform!=='win32','Installed Edge');test.setTimeout(180000);
  const run=path.resolve(info.outputPath('isolated')),extension=path.join(run,'extension'),database=`synthetic-metadata-${randomUUID()}`;
  await mkdir(extension,{recursive:true});
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Synthetic native metadata',version:'1.0.0',background:{service_worker:'background.js'},content_security_policy:{extension_pages:"script-src 'self' 'wasm-unsafe-eval'; object-src 'none'"}}));
  await writeFile(path.join(extension,'background.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
  await writeFile(path.join(extension,'index.html'),'<script src="harness.js"></script>');
  for(const name of ['engine.js','monica_mdbx2_browser.wasm'])await copyFile(path.resolve('native/mdbx2-browser/pkg',name),path.join(extension,name));
  await build({entryPoints:['tests/e2e/fixtures/mdbx-browser-worker.ts'],outfile:path.join(extension,'worker.js'),bundle:true,format:'esm',target:'chrome130',external:['./engine.js'],alias:{crypto:path.resolve('scripts/stubs/node-crypto.js')}});
  await writeFile(path.join(extension,'harness.js'),`const w=new Worker('./worker.js',{type:'module'}),p=new Map();w.onmessage=({data})=>{const q=p.get(data.id);if(!q)return;p.delete(data.id);data.error?q.reject(Error(data.error.code+': '+data.error.message)):q.resolve(data.result)};window.probe=(op,data)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();p.set(id,{resolve,reject});w.postMessage({id,op,data})});`);
  let context:BrowserContext|undefined;
  const evidence:Record<string,unknown>={status:'failed',productionNativeWriter:true,productionLocalAdoption:true,androidApplicationAcceptance:false};
  try{
    const connect=async()=>{
      context=await launchEdgeContext(path.join(run,'profile'),{args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
      const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      return(op:string,data?:unknown):Promise<any>=>page.evaluate(({op,data})=>(window as any).probe(op,data),{op,data});
    };
    let call=await connect();
    const rpc=async(method:string,params:unknown)=>{const r=await call('rpc',{protocol:2,requestId:randomUUID(),method,params});expect(r.ok,JSON.stringify(r)).toBe(true);return r.result;};
    await call('open',{name:database});
    const password='synthetic metadata password',a=(await rpc('vault.create',{password,mode:'multi'})).vaultHandle,b=(await rpc('vault.create',{password,mode:'multi'})).vaultHandle;
    const providerA=randomUUID(),providerB=randomUUID(),capture=(handle:string,providerId:string)=>call('nearby-native-source',{vaultHandle:handle,providerId});
    let source=await capture(a,providerA),target=await capture(b,providerB);
    const folder=randomUUID(),folderFile=randomUUID(),rootFile=randomUUID(),folderLabel=randomUUID(),rootLabel=randomUUID(),ownLabel=randomUUID(),assetId=randomUUID();
    const bytes=Buffer.alloc(280000,93),hash=createHash('sha256').update(bytes).digest('hex');
    await call('content-write',{handle:a,input:{operationId:randomUUID(),writeRevision:source.writeRevision,assets:[{id:assetId,base64:bytes.toString('base64')}],plan:{commands:[
      {kind:'collection-create',collectionId:source.rootId,title:'.monica-root',parentId:null},{kind:'collection-create',collectionId:folder,title:'Folder',parentId:source.rootId},
      {kind:'label-create',labelId:folderLabel,collectionId:folder,name:'Folder label',payloadJson:'{"secret":"synthetic-label","n":9007199254740993}',payloadSchemaVersion:7},
      {kind:'label-create',labelId:rootLabel,collectionId:source.rootId,name:'Root label',payloadJson:'{"d":1.00000000000000001}',payloadSchemaVersion:3}
    ],attachments:[{kind:'create',attachmentId:folderFile,collectionId:folder,objectId:null,fileName:'folder.bin',assetId},{kind:'create',attachmentId:rootFile,collectionId:source.rootId,objectId:null,fileName:'root.bin',assetId}]}}});
    await call('content-write',{handle:b,input:{operationId:randomUUID(),writeRevision:target.writeRevision,assets:[],plan:{commands:[{kind:'collection-create',collectionId:target.rootId,title:'.monica-root',parentId:null},{kind:'label-create',labelId:ownLabel,collectionId:target.rootId,name:'B own label',payloadJson:'{"own":true}',payloadSchemaVersion:1}],attachments:[]}}});
    source=await capture(a,providerA);target=await capture(b,providerB);
    const sourceProjection=await call('nearby-native-project',source);expect(sourceProjection.blockers).toEqual([]);
    const incoming=(projection:any,clock:number)=>projection.records.map((row:any)=>({id:row.global_id,deleted:row.deleted,clockJson:JSON.stringify({peer:clock}),dataJson:JSON.stringify(row.data)}));
    const asset={id:hash,dataBase64:bytes.toString('base64')};
    const adopt=async(handle:string,state:any,records:unknown[],assets:unknown[])=>{const plan=await call('nearby-native-adopt-plan',{source:state,batch:{operationId:randomUUID(),sourceHash:state.sourceHash,records,assets}});return call('content-write',{handle,input:plan.write});};
    await adopt(b,target,incoming(sourceProjection,1),[asset]);target=await capture(b,providerB);
    let projection=await call('nearby-native-project',target);expect(projection.blockers).toEqual([]);
    expect(projection.records.find((r:any)=>r.global_id===target.rootId).data.labels).toMatchObject([{name:'B own label'}]);
    expect(projection.records.find((r:any)=>r.global_id===source.rootId).data.labels).toMatchObject([{name:'Root label'}]);
    const updatedBytes=Buffer.alloc(180000,117),updatedHash=createHash('sha256').update(updatedBytes).digest('hex');
    const changed=projection.records.filter((r:any)=>[folder,source.rootId].includes(r.global_id)).map((row:any)=>{
      const data=structuredClone(row.data);if(row.global_id===folder){data.title='Renamed';data.payload.future={retained:'folder-extra'};data.assets[0]={...data.assets[0],id:updatedHash,size:updatedBytes.length,file_name:'replacement.bin'};}else data.labels=[];
      return{id:row.global_id,deleted:false,clockJson:'{"peer":2}',dataJson:JSON.stringify(data),localId:row.local_id,scope:row.scope,expectedGuard:row.guard};
    });
    await adopt(b,target,changed,[{id:updatedHash,dataBase64:updatedBytes.toString('base64')},asset]);
    target=await capture(b,providerB);projection=await call('nearby-native-project',target);
    expect(target.metadata.labels.find((label:any)=>label.labelId===ownLabel).deleted).toBe(false);
    const forwarded=await call('nearby-local-forward',{records:incoming(projection,3),assets:[asset,{id:updatedHash,dataBase64:updatedBytes.toString('base64')}]});
    const sendBack=forwarded.records.filter((r:any)=>[folder,source.rootId].includes(r.global_id)).map((row:any)=>{
      const old=sourceProjection.records.find((r:any)=>r.global_id===row.global_id);return{id:row.global_id,deleted:row.deleted,clockJson:'{"peer":3}',dataJson:JSON.stringify(row.data),localId:old.local_id,scope:old.scope,expectedGuard:old.guard};
    });
    await adopt(a,source,sendBack,forwarded.assets);
    const retained=projection.records.filter((r:any)=>[folder,source.rootId].includes(r.global_id));
    const boundRecords=(current:any,records:any[],deleted:boolean,purge=false)=>records.map((row:any)=>{
      const before=current.records.find((r:any)=>r.global_id===row.global_id),data=purge?{}:{...row.data,trashed:deleted};
      return{id:row.global_id,deleted,clockJson:'{"peer":4}',dataJson:JSON.stringify(data),localId:before.local_id,scope:before.scope,expectedGuard:before.guard};
    });
    await adopt(b,target,boundRecords(projection,retained,true),[]);
    target=await capture(b,providerB);projection=await call('nearby-native-project',target);
    for(const row of retained){const trashed=projection.records.find((r:any)=>r.global_id===row.global_id);expect(trashed.deleted).toBe(true);expect(trashed.data.assets).toEqual(row.data.assets);expect(trashed.data.payload).toEqual(row.data.payload);}
    const forwardedTrash=await call('nearby-local-forward',{records:incoming(projection,4),assets:[asset,{id:updatedHash,dataBase64:updatedBytes.toString('base64')}]});
    for(const row of retained){
      const trashed=forwardedTrash.records.find((r:any)=>r.global_id===row.global_id);
      expect(trashed.deleted).toBe(true);expect(trashed.data.assets).toEqual(row.data.assets);expect(trashed.data.payload).toEqual(row.data.payload);expect(trashed.data.labels).toEqual(row.data.labels);
      for(const descriptor of row.data.assets){const file=forwardedTrash.assets.find((a:any)=>a.id===descriptor.id);expect(createHash('sha256').update(Buffer.from(file.dataBase64,'base64')).digest('hex')).toBe(descriptor.id);}
    }
    source=await capture(a,providerA);
    await adopt(a,source,boundRecords(await call('nearby-native-project',source),forwardedTrash.records.filter((r:any)=>[folder,source.rootId].includes(r.global_id)),true),forwardedTrash.assets);
    source=await capture(a,providerA);
    const returnedTrash=await call('nearby-native-project',source);
    for(const row of retained)expect(returnedTrash.records.find((r:any)=>r.global_id===row.global_id)).toMatchObject({deleted:true,data:{assets:row.data.assets,payload:row.data.payload}});
    await adopt(a,source,boundRecords(returnedTrash,retained,false),[]);
    await adopt(b,target,boundRecords(projection,retained,false),[]);
    target=await capture(b,providerB);projection=await call('nearby-native-project',target);
    const rootRecord=projection.records.find((r:any)=>r.global_id===source.rootId),rootNativeFile=target.attachments.find((f:any)=>f.objectId===null&&f.collectionId===target.rootId&&!f.deleted);
    await adopt(b,target,boundRecords(projection,[rootRecord],true,true),[]);
    target=await capture(b,providerB);projection=await call('nearby-native-project',target);
    expect(projection.records.find((r:any)=>r.global_id===source.rootId)).toMatchObject({deleted:true,data:{}});
    expect(target.attachments.find((f:any)=>f.attachmentId===rootNativeFile.attachmentId).deleted).toBe(true);
    expect(target.metadata.labels.find((l:any)=>l.labelId===ownLabel).deleted).toBe(false);
    expect(projection.records.find((r:any)=>r.global_id===folder).data.assets).toEqual(retained.find((r:any)=>r.global_id===folder).data.assets);
    await adopt(b,target,boundRecords(projection,[rootRecord],false),[asset]);
    target=await capture(b,providerB);projection=await call('nearby-native-project',target);
    expect(projection.records.find((r:any)=>r.global_id===source.rootId).data.assets).toEqual(rootRecord.data.assets);
    const folderRecord=projection.records.find((r:any)=>r.global_id===folder);
    await adopt(b,target,boundRecords(projection,[folderRecord],true,true),[]);
    target=await capture(b,providerB);projection=await call('nearby-native-project',target);
    expect(projection.records.find((r:any)=>r.global_id===folder)).toMatchObject({deleted:true,data:{}});
    expect(target.attachments.filter((file:any)=>file.collectionId===folder&&!file.deleted)).toEqual([]);
    expect(projection.records.find((r:any)=>r.global_id===source.rootId).data.assets).toEqual(rootRecord.data.assets);
    await adopt(b,target,boundRecords(projection,[folderRecord],false),[{id:updatedHash,dataBase64:updatedBytes.toString('base64')}]);
    await call('close');await context!.close();call=await connect();await call('open',{name:database});
    await rpc('vault.open',{source:{kind:'vault',handle:a},credential:{method:'password',password}});
    source=await capture(a,providerA);projection=await call('nearby-native-project',source);expect(projection.blockers).toEqual([]);
    expect(projection.records.find((r:any)=>r.global_id===folder).data).toMatchObject({title:'Renamed',payload:{future:{retained:'folder-extra'}},assets:[{attachment_id:folderFile,id:updatedHash,size:updatedBytes.length}]});
    expect(source.metadata.labels.find((row:any)=>row.labelId===rootLabel).deleted).toBe(true);
    for(const [id,expected,size]of [[folderFile,updatedHash,updatedBytes.length],[rootFile,hash,bytes.length]]as const){const file=source.attachments.find((row:any)=>row.attachmentId===id);expect(file.deleted).toBe(false);expect(await call('content-attachment-bytes',{handle:a,input:{writeRevision:source.writeRevision,attachment:file}})).toEqual({sizeBytes:size,sha256:expected});}
    await rpc('vault.open',{source:{kind:'vault',handle:b},credential:{method:'password',password}});
    target=await capture(b,providerB);projection=await call('nearby-native-project',target);
    const restoredFolder=projection.records.find((r:any)=>r.global_id===folder);
    expect(restoredFolder).toMatchObject({deleted:false,data:{assets:folderRecord.data.assets}});
    const restoredFile=target.attachments.find((file:any)=>file.collectionId===folder&&!file.deleted);
    expect(await call('content-attachment-bytes',{handle:b,input:{writeRevision:target.writeRevision,attachment:restoredFile}})).toEqual({sizeBytes:updatedBytes.length,sha256:updatedHash});
    expect(target.metadata.labels.find((label:any)=>label.labelId===ownLabel).deleted).toBe(false);
    await call('scan',[password,'synthetic-label']);await call('nearby-native-journal-scan',['synthetic-label']);
    Object.assign(evidence,{status:'passed',rootOwnerIsolation:true,nativeLocalNativeRoundtrip:true,retainedTrashLocalForwarding:true,folderAndRootAttachmentIdentity:true,byteHashes:true,unknownFolderFields:true,actualRestart:true,rootTrashRestore:true,rootPurgeOwnerIsolation:true,folderAttachmentTrash:true,folderPurgeRestore:true});
    await call('close');
  }finally{await context?.close();await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2));}
});
