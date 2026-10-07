import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createLoginItem} from '../../src/core/model';
import {Mdbx2NativeClient} from '../../src/providers/mdbx2/native-client';
import {Mdbx2Provider} from '../../src/providers/mdbx2/mdbx2-provider';
import {Mdbx2TransferAttachmentService} from '../../src/providers/mdbx2/mdbx2-transfer-attachments';
import {Mdbx2BatchTransferCoordinator} from '../../src/providers/mdbx2/mdbx2-batch-transfer-coordinator';
import {SecureVaultService} from '../../src/security/secure-vault-service';
import {MemoryVaultSessionStore} from '../../src/security/vault-session';
import {resolveSsoAccount} from '../../src/core/sso-links';
import {decodeMdbx2Object} from '../../src/providers/mdbx2/mdbx2-item-codec';
import {ProcessNativeRuntime} from './mdbx2-interop-support';
const source=process.env.MONICA_315_SSO_SOURCE,output=process.env.MONICA_315_SSO_COPY_OUTPUT;
const secondVault=process.env.MONICA_315_SSO_SECOND_VAULT;
it.skipIf(!source||!output)('copies a shared SSO account through real Native and resolves it after Host restart',async()=>{
  if(!source||!output)throw new Error('Explicit synthetic input required');
  await mkdir(output,{recursive:true});const host=await mkdtemp(join(output,'host-'));
  const connect=()=>new Mdbx2NativeClient(new ProcessNativeRuntime(resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe'),host));let client=connect();
  try{
    const bytes=await readFile(source),transfer=await client.beginInboundTransfer(bytes.length,createHash('sha256').update(bytes).digest('hex'));
    for(let offset=0;offset<bytes.length;)offset=(await client.sendInboundChunk(transfer.transferId,offset,bytes.subarray(offset,offset+transfer.maxChunkBytes))).nextOffset;
    const credential={method:'password' as const,password:'Synthetic transfer fixture password'};
    const opened=await client.openVault({kind:'file',handle:(await client.finishInboundTransfer(transfer.transferId)).fileHandle},credential);
    let envelope:import('../../src/security/vault-crypto').VaultEnvelope|null=null;
    const service=new SecureVaultService({read:async()=>envelope,write:async value=>{envelope=structuredClone(value);},clear:async()=>{envelope=null;}},new MemoryVaultSessionStore());
    await service.setup('Synthetic SSO copy password');
    const provider={id:'sso-copy-target',kind:'mdbx2' as const,name:'Synthetic target',enabled:true,isDefaultSaveTarget:false,config:{vaultHandle:opened.vaultHandle}};await service.upsertProvider(provider);
    const account=await service.upsertItem({...createLoginItem({title:'Synthetic shared account',username:'user@example.test'}),replicaGroupId:'password:source-account'});
    const websites=await Promise.all(['first','second'].map(title=>service.upsertItem({...createLoginItem({title:`Synthetic ${title}`}),loginType:'SSO',ssoRefLogicalId:'password:source-account'})));
    const registry={get:()=>{throw new Error('Unexpected provider');}};
    const attachments=new Mdbx2TransferAttachmentService(client,{listAttachments:()=>[],readAttachment:()=>{throw new Error('Unexpected attachment');}});
    const coordinator=new Mdbx2BatchTransferCoordinator(service,registry,new Mdbx2Provider(client),client,attachments);
    const request={itemIds:websites.map(i=>i.id),targetProviderId:provider.id,action:'copy' as const,preserveCategories:false,operationId:randomUUID(),operationCreatedAt:new Date().toISOString()};
    const result=await coordinator.execute(request);expect(result.completedCount,JSON.stringify(result)).toBe(3);
    expect((await coordinator.execute(request)).completedCount).toBe(3);
    const targets=(await service.listItems()).filter(i=>i.providerRefs.some(r=>r.providerId===provider.id));expect(targets).toHaveLength(3);
    await client.lockVault(opened.vaultHandle);client.close();client=connect();await client.openVault({kind:'vault',handle:opened.vaultHandle},credential);
    const decoded=[];const nativeBefore=new Map<string,unknown>();
    for(const target of targets){const ref=target.providerRefs.find(r=>r.providerId===provider.id)!;const record=await client.revealObject(opened.vaultHandle,ref.remoteId!);nativeBefore.set(ref.remoteId!,record);decoded.push(decodeMdbx2Object(record,{headCommitId:ref.revision!,updatedAt:target.updatedAt},provider.id).item!);}
    const copied=decoded.find(i=>i.title===account.title)!;expect(copied.replicaGroupId).not.toBe(account.replicaGroupId);
    for(const item of decoded.filter(i=>i.title!==account.title)){if(item.kind!=='login')throw new Error('Expected login');expect(resolveSsoAccount(item,decoded)?.id).toBe(copied.id);expect(item.ssoRefEntryId).toBeUndefined();}
    expect(await service.getItem(account.id)).toEqual(account);for(const website of websites)expect(await service.getItem(website.id)).toEqual(website);
    let nativeToNative=false;
    if(secondVault){
      for(const [index,target] of [...targets,...targets].entries()){
        const ref=target.providerRefs.find(r=>r.providerId===provider.id)!;
        const data=Buffer.from(`Synthetic SSO attachment ${index}`);
        const upload=await client.beginAttachmentUpload(opened.vaultHandle,{operationId:randomUUID(),attachmentId:randomUUID(),collectionId:ref.remoteFolderId!,objectId:ref.remoteId!,fileName:`sso-${index}.txt`,mediaType:'text/plain',mode:'create',sizeBytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
        await client.sendAttachmentUploadChunk(upload.transferId,0,data);await client.finishAttachmentUpload(upload.transferId);await client.abortAttachmentUpload(upload.transferId);
      }
      const secondBytes=await readFile(secondVault),incoming=await client.beginInboundTransfer(secondBytes.length,createHash('sha256').update(secondBytes).digest('hex'));
      for(let offset=0;offset<secondBytes.length;)offset=(await client.sendInboundChunk(incoming.transferId,offset,secondBytes.subarray(offset,offset+incoming.maxChunkBytes))).nextOffset;
      const destination=await client.openVault({kind:'file',handle:(await client.finishInboundTransfer(incoming.transferId)).fileHandle},credential);
      expect(destination.vaultId).not.toBe(opened.vaultId);
      const otherProvider={...provider,id:'sso-second-target',config:{vaultHandle:destination.vaultHandle}};await service.upsertProvider(otherProvider);
      const bridge=new Mdbx2TransferAttachmentService(client,{listAttachments:()=>[],readAttachment:()=>{throw new Error('Unexpected attachment');}});
      const nextCoordinator=new Mdbx2BatchTransferCoordinator(service,registry,new Mdbx2Provider(client),client,bridge);
      const nextRequest={...request,itemIds:targets.filter(i=>i.title!==account.title).map(i=>i.id),targetProviderId:otherProvider.id,operationId:randomUUID()};
      const nextResult=await nextCoordinator.execute(nextRequest);expect(nextResult.completedCount,JSON.stringify(nextResult)).toBe(3);
      expect((await nextCoordinator.execute(nextRequest)).completedCount).toBe(3);
      const nextTargets=(await service.listItems()).filter(i=>i.providerRefs.some(r=>r.providerId===otherProvider.id));expect(nextTargets).toHaveLength(3);
      await client.lockVault(opened.vaultHandle);await client.lockVault(destination.vaultHandle);client.close();client=connect();
      await client.openVault({kind:'vault',handle:destination.vaultHandle},credential);
      const reopened=[];
      for(const target of nextTargets){const ref=target.providerRefs.find(r=>r.providerId===otherProvider.id)!;const record=await client.revealObject(destination.vaultHandle,ref.remoteId!);reopened.push(decodeMdbx2Object(record,{headCommitId:ref.revision!,updatedAt:target.updatedAt},otherProvider.id).item!);}
      const nextAccount=reopened.find(i=>i.title===account.title)!;expect(nextAccount.replicaGroupId).not.toBe(copied.replicaGroupId);
      for(const target of nextTargets){
        const ref=target.providerRefs.find(r=>r.providerId===otherProvider.id)!;
        const listed=await client.listAttachments(destination.vaultHandle,ref.remoteFolderId!,ref.remoteId!);expect(listed.items).toHaveLength(2);expect(listed.nextCursor).toBeUndefined();
        const originalIndex=targets.findIndex(i=>i.title===target.title);
        for(const index of [originalIndex,originalIndex+targets.length]){ const attachment=listed.items.find(a=>a.fileName===`sso-${index}.txt`)!;expect(attachment).toBeDefined();
        const read=await client.beginAttachmentRead(destination.vaultHandle,attachment.attachmentId);
        try{const chunk=await client.readAttachmentChunk(read.readHandle,0);expect(chunk.eof).toBe(true);expect(Buffer.from(chunk.dataBase64,'base64')).toEqual(Buffer.from(`Synthetic SSO attachment ${index}`));}finally{await client.releaseAttachmentRead(read.readHandle);}}
      }
      for(const item of reopened.filter(i=>i.title!==account.title)){if(item.kind!=='login')throw new Error('Expected login');expect(resolveSsoAccount(item,reopened)?.id).toBe(nextAccount.id);}
      await client.openVault({kind:'vault',handle:opened.vaultHandle},credential);
      for(const original of targets){expect(await service.getItem(original.id)).toEqual(original);const ref=original.providerRefs.find(r=>r.providerId===provider.id)!;const record=await client.revealObject(opened.vaultHandle,ref.remoteId!);expect(record.deleted).toBe(false);expect(record).toEqual(nativeBefore.get(ref.remoteId!));}
      await client.lockVault(destination.vaultHandle);nativeToNative=true;
    }
    await client.lockVault(opened.vaultHandle);
    await writeFile(join(output,'evidence.json'),JSON.stringify({status:'passed',copiedItems:3,sharedTargetCount:1,retryIdempotent:true,resolvedAfterNativeRestart:true,sourcesUnchanged:true,nativeToNative,attachmentsVerified:nativeToNative?6:0,scope:'Local-to-Native and optional distinct Native-to-Native copy; Android and move recovery not inferred'},null,2));
  }finally{client.close();}
});
