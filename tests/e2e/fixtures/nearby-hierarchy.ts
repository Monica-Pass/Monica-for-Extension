// Isolated acceptance only; never shipped as an extension entry point.
import { Mdbx2NativeClient, createChromeMdbx2NativeRuntime } from '../../../src/providers/mdbx2/native-client';
import { writeMdbx2Content, type Mdbx2ContentCommand, type Mdbx2ContentWriteInput } from '../../../src/providers/mdbx2/content-write';
import { NearbyNativeTransport } from '../../../src/nearby/native-transport';
import { NearbyLocalCoordinator, type NearbyEndpoint } from '../../../src/nearby/local-coordinator';
import { nativeNearbySource } from '../../../src/nearby/native-adapter';
import { captureNearbyNativeSource, nearbyNativeRootId } from '../../../src/nearby/native-source';
import { SecureVaultService } from '../../../src/security/secure-vault-service';
import { IndexedDbVaultStorage } from '../../../src/security/vault-storage';
import { ChromeVaultSessionStore } from '../../../src/security/vault-session';
import { ChromeVaultDeviceKeyStore } from '../../../src/security/vault-device-key';
import { projectNearbyNativeRecords } from '../../../src/nearby/native-records';
import { Mdbx2NativeHostError, parseMdbx2NativeResponse } from '../../../src/providers/mdbx2/native-contract';

const master='Synthetic hierarchy password';
const storage=new IndexedDbVaultStorage(),service=new SecureVaultService(storage,new ChromeVaultSessionStore(),Date.now,new ChromeVaultDeviceKeyStore());
const worker=new Worker('./mdbx-worker.js',{type:'module'}),pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
worker.onmessage=({data})=>{const value=pending.get(data.id);if(!value)return;pending.delete(data.id);if(data.error)value.reject(Error(data.error.code));else value.resolve(data.result);};
const engine=(op:string,data:unknown)=>new Promise<any>((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});worker.postMessage({id,op,data});});
const opened=engine('open',{name:'synthetic-nearby-hierarchy'});
const client=new Mdbx2NativeClient({connectNative(){throw Error('Storage must use the bundled engine');},disconnectErrorMessage(){return undefined;}});
client.request=async(method,params={})=>{
  await opened;const response=parseMdbx2NativeResponse(await engine('rpc',{protocol:2,requestId:crypto.randomUUID(),method,params}));
  if(!response)throw Error('Invalid synthetic native response');if(!response.ok)throw new Mdbx2NativeHostError(response.error.code,response.error.message,response.error.retryable);return response.result;
};
const events:Array<Record<string,unknown>>=[];
const coordinator=new NearbyLocalCoordinator(service,()=>{
  const transport=new NearbyNativeTransport(new Mdbx2NativeClient(createChromeMdbx2NativeRuntime())),call=transport.call.bind(transport);
  transport.call=async(op,params,signal)=>{const result=await call(op,params,signal);if(['progress','start','connect','acknowledge','replica_pending','replica_applied_batch'].includes(op)){const value=result as any;events.push({op,phase:value.phase,total:value.total,count:value.items?.length,time:Date.now()});if(events.length>300)events.shift();}return result;};
  return transport;
},'127.0.0.1',undefined,
  async(p,sessionId,signal,active,epoch)=>nativeNearbySource({store:service,client,providerId:p.localProviderId,replicaStorageId:p.replicaStorageId,sessionId,signal,assertActive:active,epoch,exclusive:work=>work()}));
const folders=['00000001-1111-4111-8111-111111111111','00000002-1111-4111-8111-111111111111','ffffffff-1111-4111-8111-111111111111'];
let vaultOpened=false;
async function ready(){
  if(await service.status()==='locked')await service.unlock(master);
  const provider=(await service.readState()).providers.find(p=>p.kind==='mdbx2')!;
  if(!vaultOpened){await client.openVault({kind:'vault',handle:provider.config.vaultHandle as string},{method:'password',password:master});vaultOpened=true;}
  return {providerId:provider.id,vaultHandle:provider.config.vaultHandle as string};
}
async function write(binding:Awaited<ReturnType<typeof ready>>,commands:Mdbx2ContentCommand[],attachments:Mdbx2ContentWriteInput['plan']['attachments']=[],assets:Mdbx2ContentWriteInput['assets']=[]){
  return writeMdbx2Content(client,binding.vaultHandle,{operationId:crypto.randomUUID(),writeRevision:await client.readWriteRevision(binding.vaultHandle),plan:{commands,attachments},assets});
}
async function setup(seed:boolean){
  await service.setup(master);
  const vault=await client.createVault(master,'multi'),providerId=crypto.randomUUID();
  vaultOpened=true;
  await service.upsertProvider({id:providerId,kind:'mdbx2',name:'Synthetic hierarchy',enabled:true,isDefaultSaveTarget:false,config:{vaultHandle:vault.vaultHandle}});
  const session=(await service.passkeySessionId())!,p=await service.nearbySessionPreferences(session);
  await service.updateNearbyPreferences({kind:'source',providerId},p.epoch,session);
  // This lifecycle suite explicitly exercises full trash/restore propagation.
  const full=await service.nearbySessionPreferences(session);
  await service.updateNearbyPreferences({kind:'preferences',incrementalOnly:false},full.epoch,session);
  const binding={providerId,vaultHandle:vault.vaultHandle};
  if(seed){
    const root=await nearbyNativeRootId((await client.readWriteRevision(vault.vaultHandle)).vaultId);
    await write(binding,[{kind:'collection-create',collectionId:root,title:'.monica-root',parentId:null},...folders.map((collectionId,i)=>({kind:'collection-create' as const,collectionId,title:`Level ${i}`,parentId:i?folders[i-1]:root}))]);
    for(let start=0;start<260;start+=64){
      const commands=Array.from({length:Math.min(64,260-start)},(_,i)=>({kind:'object-create' as const,objectId:crypto.randomUUID(),collectionId:folders[2],objectTypeId:'login',title:`Item ${start+i}`,payloadJson:JSON.stringify({kind:'password',password_plain:`synthetic-value-${start+i}`})}));
      await write(binding,commands);
    }
    const asset=crypto.randomUUID();
    await write(binding,[],[{kind:'create',attachmentId:crypto.randomUUID(),collectionId:folders[2],objectId:null,fileName:'retained.bin',assetId:asset}],[{id:asset,bytes:new Uint8Array(120000).fill(83)}]);
  }
  return inspect();
}
async function inspect(){
  const binding=await ready(),source=await captureNearbyNativeSource(client,binding),projection=await projectNearbyNativeRecords(source);
  const files=[];
  for(const file of source.attachments.filter(f=>!f.deleted)){
    const bytes=await client.readContentAttachmentBytes(binding.vaultHandle,{writeRevision:source.writeRevision,attachment:file});
    files.push({id:file.attachmentId,owner:file.collectionId,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('')});bytes.fill(0);
  }
  return {revision:source.writeRevision,folders:source.collections.filter(f=>f.collectionId!==source.rootId).map(f=>({id:f.collectionId,parent:f.groupId,deleted:f.deleted})).sort((a,b)=>a.id.localeCompare(b.id)),
    objects:source.objects.map(o=>({id:o.summary.objectId,owner:o.summary.collectionId,deleted:o.summary.deleted,payload:o.record?.payloadJson})).sort((a,b)=>a.id.localeCompare(b.id)),files,blockers:projection.blockers,journal:(await service.readNearbyNativeJournal((await service.passkeySessionId())!))?.intent};
}
async function lifecycle(deleted:boolean){
  const binding=await ready(),source=await captureNearbyNativeSource(client,binding);
  if(!deleted)await write(binding,folders.map((collectionId,i)=>({kind:'collection-restore',collectionId,parentId:i?folders[i-1]:source.rootId})));
  for(let start=0;start<source.objects.length;start+=64)await write(binding,source.objects.slice(start,start+64).map(o=>({kind:deleted?'object-delete':'object-restore',objectId:o.summary.objectId,collectionId:o.summary.collectionId})));
  if(deleted)await write(binding,[...folders].reverse().map(collectionId=>({kind:'collection-trash',collectionId})));
}
(window as any).hierarchy={setup,inspect,lifecycle,events:()=>events,
  async moveOut(){const binding=await ready(),source=await captureNearbyNativeSource(client,binding);await write(binding,[{kind:'collection-move',collectionId:folders[2],parentId:source.rootId},{kind:'collection-trash',collectionId:folders[1]},{kind:'collection-trash',collectionId:folders[0]}]);},
  async pair(invitation?:string){await ready();return coordinator.pair(invitation);},
  async prepare(peer:string){await ready();return coordinator.prepare(peer);},confirm:(id:string)=>coordinator.confirm(id),start:(endpoint?:NearbyEndpoint)=>coordinator.start(endpoint),poll:()=>coordinator.poll(),status:()=>coordinator.status(),close:async()=>{coordinator.close();client.close();await engine('close',{});worker.terminate();}
};
