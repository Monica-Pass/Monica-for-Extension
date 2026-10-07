import { cp, readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { Mdbx2NativeClient } from '../../src/providers/mdbx2/native-client';
import type { Mdbx2ObjectRecord, Mdbx2ObjectSummary } from '../../src/providers/mdbx2/native-contract';
import type { LoginItem, ProviderAccount } from '../../src/core/model';
import { ProcessNativeRuntime } from './mdbx2-interop-support';
import { mdbx2ProjectRemovalAttachments } from '../../src/providers/mdbx2/mdbx2-project-removal-attachments';
import { hashProviderAttachment } from '../../src/providers/attachments/attachment-transfer';
import { Mdbx2Provider } from '../../src/providers/mdbx2/mdbx2-provider';
import { parseLosslessJson } from '../../src/core/lossless-json';

const output = process.env.MONICA_315_APP_FIXTURE, edgeRoot = process.env.MONICA_317_REMOVAL_EDGE;
const blobRoot = process.env.MONICA_317_REMOVAL_BLOBS;
const phase = process.env.MONICA_317_REMOVAL_PHASE || 'prepare', mode = process.env.MONICA_317_REMOVAL_MODE || 'complete';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Expected = { synthetic: boolean; removalMode: string; restored: LoginItem[];
  originalRecords: { original: LoginItem; native: Mdbx2ObjectRecord }[]; removedRecords: Mdbx2ObjectSummary[] };

it.skipIf(!output || !edgeRoot || !blobRoot)(`actual Edge removed project ${mode} → current Android ${phase}`, async () => {
  if (!output || !edgeRoot || !blobRoot) throw new Error('Explicit synthetic roots required');
  expect(['prepare','return']).toContain(phase); expect(['complete','cancel','restart']).toContain(mode);
  await mkdir(output,{recursive:true});
  const edge = JSON.parse(await readFile(join(edgeRoot,'evidence.json'),'utf8'));
  expect(edge.status).toBe('passed'); expect(edge.removalUi.status).toBe('passed'); expect(edge.nativeRegistryRestored).toBe(true);
  const group = edge.removalRuntime.groups.find((row: {mode:string})=>row.mode===mode) as {groupId:string; original:LoginItem[]};
  expect(group).toBeDefined();
  const executable=resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
  const runtimeRoot=await mkdtemp(join(output,`native-${phase}-`));
  if (phase==='prepare') await cp(join(edgeRoot,'host-appdata'),runtimeRoot,{recursive:true});
  const client=new Mdbx2NativeClient(new ProcessNativeRuntime(executable,runtimeRoot));
  const sourceVaults=join(edgeRoot,'host-appdata','Monica Extension','MDBX2','vaults');
  const names=await readdir(sourceVaults); expect(names).toHaveLength(1); expect(names[0]).toMatch(/^[a-f0-9-]{36}$/);
  const source=phase==='prepare' ? join(sourceVaults,names[0],'vault.mdbx') : join(output,'android-return.mdbx');
  const bytes=await readFile(source), sourceSha=hash(bytes);
  const evidence:Record<string,unknown>={status:'failed',phase,mode,edgeRoot,source,sourceSha256:sourceSha,hostSha256:hash(await readFile(executable))};
  try {
    let sourceHandle:string;
    if (phase==='prepare') sourceHandle=edge.removalRuntime.vaultHandle;
    else {
      const report=JSON.parse(await readFile(join(output,'removal-project-evidence.json'),'utf8'));
      expect(report.status).toBe('passed');
      for (const key of ['androidSourcesUnchanged','testSourcesUnchanged','installedApplicationUnchanged','installedTestApkUnchanged','deviceBootUnchanged']) expect(report[key],key).toBe(true);
      for(const file of report.outputs as {name:string;sha256:string}[]) {
        expect(file.name).toMatch(/^(android-return\.mdbx|removed-project-android-readback\.json|android-return-blobs\.json|android-return-blobs\/[a-f0-9]{64})$/);
        expect(hash(await readFile(join(output,file.name)))).toBe(file.sha256);
      }
      const transfer=await client.beginInboundTransfer(bytes.length,sourceSha);
      for(let offset=0;offset<bytes.length;) offset=(await client.sendInboundChunk(transfer.transferId,offset,bytes.subarray(offset,offset+transfer.maxChunkBytes))).nextOffset;
      sourceHandle=(await client.finishInboundTransfer(transfer.transferId)).fileHandle;
    }
    const opened=await client.openVault({kind:phase==='prepare'?'vault':'file',handle:sourceHandle},{method:'password',password:'Synthetic transfer fixture password'});
    const binding=hash(`removed project ${mode} ${phase}`), state=await client.registerSyncState(opened.vaultHandle,binding);
    const prefix=phase==='prepare'?'android':'android-return', blobSource=phase==='prepare'?blobRoot:output;
    const baselineBlobs=JSON.parse(await readFile(join(blobSource,`${prefix}-blobs.json`),'utf8')) as {path:string;blobId:string;sizeBytes:number}[];
    for(const blob of baselineBlobs) {
      expect(blob.blobId).toMatch(/^[a-f0-9]{64}$/); expect(blob.path).toBe(`${prefix}-blobs/${blob.blobId}`);
      const data=await readFile(join(blobSource,blob.path)); expect(hash(data)).toBe(blob.blobId); expect(data.length).toBe(blob.sizeBytes);
      const receive=await client.beginExternalBlobReceive(opened.vaultHandle,state.stateHandle,binding,blob.blobId,data.length);
      for(let offset=receive.nextOffset;offset<data.length;) { const end=Math.min(offset+262144,data.length);
        offset=(await client.writeExternalBlobReceiveChunk(opened.vaultHandle,state.stateHandle,binding,blob.blobId,data.length,offset,data.subarray(offset,end),end===data.length)).nextOffset; }
    }
    const provider:ProviderAccount={id:edge.removalRuntime.providerId,kind:'mdbx2',name:'Synthetic Android removal return',enabled:true,isDefaultSaveTarget:false,
      config:{vaultHandle:opened.vaultHandle,nativeVaultId:opened.vaultId}};
    const projected=await new Mdbx2Provider(client).sync(provider,{localItems:[],now:new Date().toISOString()});
    const members=projected.items.filter((row):row is LoginItem=>row.kind==='login' && row.passwordGroupId===group.groupId && !row.deletedAt);
    expect(members).toHaveLength(mode==='cancel'?3:1);
    const native=await Promise.all(members.map(row=>client.revealObject(opened.vaultHandle,row.providerRefs.find(ref=>ref.providerId===provider.id)!.remoteId!)));
    const originalIds=new Set(group.original.map(row=>row.providerRefs.find(ref=>ref.providerId===provider.id)!.remoteId!));
    const deleted:Mdbx2ObjectSummary[]=[];
    for(const collectionId of new Set(group.original.map(row=>row.providerRefs[0].remoteFolderId!))) {
      let cursor:string|undefined;
      do { const page=await client.listObjects(opened.vaultHandle,collectionId,{deleted:true,cursor});
        deleted.push(...page.items.filter(row=>originalIds.has(row.objectId))); cursor=page.nextCursor; } while(cursor);
    }
    expect(deleted).toHaveLength(mode==='cancel'?0:2);
    const reader=mdbx2ProjectRemovalAttachments(client,provider,members);
    const attachments:{nativeId?:string;fileName:string;sizeBytes:number;sha256:string}[]=[];
    for(const member of members) {
      const listed=await reader.listAttachments(provider.id,member.id); expect(listed.nextCursor).toBeUndefined();
      for(const attachment of listed.items) attachments.push({nativeId:member.replicaGroupId,fileName:attachment.fileName,sizeBytes:attachment.sizeBytes,
        sha256:await hashProviderAttachment(reader,provider.id,member.id,attachment.attachmentId,attachment.fileName,attachment.sizeBytes)});
    }
    const sorted=(rows:typeof attachments)=>rows.map(row=>[row.nativeId,row.fileName,row.sizeBytes,row.sha256]).sort();
    expect(attachments.some(row=>row.fileName==='shared.txt' && row.sha256===hash(' shared runtime attachment\r\n0007 '))).toBe(true);
    if(phase==='prepare') {
      const originalRecords=await Promise.all(members.map(async original=>({original,native:await client.revealObject(opened.vaultHandle,original.providerRefs[0].remoteId!)})));
      const expected:Expected={synthetic:true,removalMode:mode,restored:members,originalRecords,removedRecords:deleted};
      await writeFile(join(output,'edge-restored-project-expected.json'),JSON.stringify(expected,null,2));
      await writeFile(join(output,'removed-project-attachments.json'),JSON.stringify(attachments,null,2));
      await writeFile(join(output,'extension.mdbx'),bytes);
      const manifest=[]; let cursor:string|undefined;
      do {
        const page=await client.listExternalBlobs(opened.vaultHandle,state.stateHandle,binding,cursor);
        for(const blob of page.items) {
          expect(blob.state).toBe('available'); expect(blob.totalSize).toBeGreaterThan(0);
          const chunks:Buffer[]=[]; let offset=0;
          while(offset<blob.totalSize!) { const chunk=await client.readExternalBlob(opened.vaultHandle,state.stateHandle,binding,blob.blobId,blob.totalSize!,offset);
            expect(chunk.nextOffset).toBeGreaterThan(offset); chunks.push(Buffer.from(chunk.dataBase64,'base64')); offset=chunk.nextOffset; }
          const data=Buffer.concat(chunks); expect(hash(data)).toBe(blob.blobId);
          await mkdir(join(output,'extension-blobs'),{recursive:true}); await writeFile(join(output,'extension-blobs',blob.blobId),data);
          manifest.push({path:`extension-blobs/${blob.blobId}`,blobId:blob.blobId,sizeBytes:data.length});
        }
        cursor=page.nextCursor;
      }while(cursor);
      await writeFile(join(output,'extension-blobs.json'),JSON.stringify(manifest,null,2));
      evidence.encryptedBlobs=manifest.length;
    } else {
      const expected=JSON.parse(await readFile(join(output,'edge-restored-project-expected.json'),'utf8')) as Expected;
      const report=JSON.parse(await readFile(join(output,'removed-project-android-readback.json'),'utf8'));
      expect(report.status).toBe('passed'); expect(report.removalMode).toBe(mode); expect(report.removedCount).toBe(deleted.length);
      const beforeAttachments=JSON.parse(await readFile(join(output,'removed-project-attachments.json'),'utf8'));
      expect(sorted(attachments)).toEqual(sorted(beforeAttachments)); expect(sorted(report.attachmentsBefore)).toEqual(sorted(beforeAttachments)); expect(sorted(report.attachmentsAfter)).toEqual(sorted(beforeAttachments));
      for(const record of expected.originalRecords) {
        const current=native.find(row=>row.objectId===record.native.objectId)!; expect(current.deleted).toBe(false);
        expect(current.collectionId).toBe(record.native.collectionId);
        const old=parseLosslessJson(record.native.payloadJson) as Record<string,unknown>, updated=parseLosslessJson(current.payloadJson) as Record<string,unknown>;
        if(record.original.replicaGroupId===report.editedNativeId) {
          expect(updated.notes).toBe(report.returnedNote); expect(updated.monica_password_encoding).toBe('plaintext-v1');
          // Mdbx2Repository.passwordMutation rebuilds JSONObject: null puts
          // remove empty bindings, PASSWORD omits empty SSO, and the default
          // collection is represented by Object.collectionId. Assert the exact
          // previous empty/redundant values before accepting these omissions.
          const omitted:Record<string,unknown>={category_id:null,bound_note_entry_id:null,bound_note_room_id:null,
            sso_provider:'',sso_ref_entry_id:null,sso_ref_logical_id:null,mdbx_folder_id:record.native.collectionId};
          const normalized={...old,monica_password_encoding:'plaintext-v1'};
          const actualOmissions=[];
          for(const [key,value] of Object.entries(omitted)) if(Object.hasOwn(old,key) && !Object.hasOwn(updated,key)) {
            expect(old[key],key).toBe(value); Reflect.deleteProperty(normalized,key); actualOmissions.push(key);
          }
          expect({...updated,notes:old.notes,room_id:old.room_id}).toEqual(normalized);
          evidence.androidEncodingOmissions=actualOmissions;
        } else expect(current.payloadJson).toBe(record.native.payloadJson);
        const member=members.find(row=>row.replicaGroupId===record.original.replicaGroupId)!;
        expect(member.password).toBe(record.original.password); expect(member.customFields).toEqual(record.original.customFields);
      }
      for(const record of expected.removedRecords) expect(deleted.find(row=>row.objectId===record.objectId)).toEqual(record);
      evidence.returnedExactRichFieldsAndTombstones=true;
    }
    expect(hash(await readFile(source))).toBe(sourceSha);
    Object.assign(evidence,{status:'passed',members:members.length,deleted:deleted.length,attachments});
  } catch(cause) { evidence.error=String(cause); throw cause; }
  finally { client.close(); await writeFile(join(output,`removed-project-${phase}-evidence.json`),JSON.stringify(evidence,null,2)); }
});
