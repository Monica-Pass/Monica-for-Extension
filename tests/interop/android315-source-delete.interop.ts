import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { decodeMdbx2Object } from "../../src/providers/mdbx2/mdbx2-item-codec";
import { deleteMdbx2TransferSources } from "../../src/providers/mdbx2/mdbx2-transfer-source-delete";
import { readMdbx2TransferBinding, verifyMdbx2TransferBinding, verifyMdbx2TransferTargets } from "../../src/providers/mdbx2/mdbx2-transfer-verification";
import type { Mdbx2ObjectRecord } from "../../src/providers/mdbx2/native-contract";
import type { ProviderAccount, VaultItem } from "../../src/core/model";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";

const input = process.env.MONICA_315_DELETE_FIXTURE;
const root = process.env.MONICA_315_DELETE_OUTPUT;
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
it.skipIf(!input || !root)('actual Native atomic group deletion: stale last member and lost successful response', async () => {
  if (!input || !root) throw new Error('Explicit synthetic input and isolated output required');
  await mkdir(root,{recursive:true});
  const client = new Mdbx2NativeClient(new ProcessNativeRuntime(resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe'),await mkdtemp(join(root,'host-'))));
  const bytes = await readFile(input), inputHash = hash(bytes);
  try {
    const transfer = await client.beginInboundTransfer(bytes.length,inputHash);
    for (let offset=0;offset<bytes.length;) offset=(await client.sendInboundChunk(transfer.transferId,offset,bytes.subarray(offset,offset+transfer.maxChunkBytes))).nextOffset;
    const file=await client.finishInboundTransfer(transfer.transferId);
    const vault=await client.openVault({kind:'file',handle:file.fileHandle},{method:'password',password:'Synthetic transfer fixture password'});
    const snapshot=async () => {
      const records:Mdbx2ObjectRecord[]=[];
      const collections=await client.listCollections(vault.vaultHandle);expect(collections.nextCursor).toBeUndefined();
      for(const collection of collections.items){
        const page=await client.listObjects(vault.vaultHandle,collection.collectionId);expect(page.nextCursor).toBeUndefined();
        for(const item of page.items) records.push({...await client.revealObject(vault.vaultHandle,item.objectId),headCommitId:item.headCommitId});
      }
      return records.sort((a,b)=>a.objectId.localeCompare(b.objectId));
    };
    const before=await snapshot();
    const password=before.find(record=>record.objectTypeId==='login' && JSON.parse(record.payloadJson).bound_note_entry_id);
    expect(password).toBeDefined();
    const note=before.find(record=>record.objectTypeId==='note' && JSON.parse(record.payloadJson).monica_entry_id===JSON.parse(password!.payloadJson).bound_note_entry_id);
    expect(note).toBeDefined();
    const source:ProviderAccount={id:'synthetic-source',kind:'mdbx2',name:'Synthetic',enabled:true,isDefaultSaveTarget:false,config:{vaultHandle:vault.vaultHandle}};
    const items=[password!,note!].map(record=>decodeMdbx2Object(record,{headCommitId:record.headCommitId!,updatedAt:'2026-10-01T00:00:00Z'},source.id).item!) as VaultItem[];
    expect(items.every(Boolean)).toBe(true);
    const binding = await readMdbx2TransferBinding(client, source);
    await verifyMdbx2TransferBinding(client, source, binding);
    await verifyMdbx2TransferTargets(client, binding, items);
    const stale=structuredClone(items);stale[1].providerRefs[0].revision='ffffffff-ffff-4fff-8fff-ffffffffffff';
    await expect(deleteMdbx2TransferSources(client,source,stale,crypto.randomUUID(),'synthetic-target')).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    let calls=0, drop=true;
    const lossy={resolveObjectOperation:client.resolveObjectOperation.bind(client),mutateObjects:async (...args:Parameters<Mdbx2NativeClient['mutateObjects']>)=>{
      calls++;const result=await client.mutateObjects(...args);
      if(drop){drop=false;throw new Error('Synthetic lost response after actual commit');}return result;
    }};
    const operationId=crypto.randomUUID();
    const result=await deleteMdbx2TransferSources(lossy,source,items,operationId,'synthetic-target');
    expect(calls).toBe(2);expect(result.alreadyCommitted).toBe(true);
    await expect(verifyMdbx2TransferTargets(client, binding, items)).rejects.toThrow();
    const targetIds=new Set([password!.objectId,note!.objectId]);
    for(const original of before){
      if(targetIds.has(original.objectId)) {
        // Deleted objects are not disclosed by the Native API. Inspect tombstone
        // metadata rather than claiming deleted payload readback was possible.
        const page=await client.listObjects(vault.vaultHandle,original.collectionId,{deleted:true});
        expect(page.nextCursor).toBeUndefined();
        const tombstone=page.items.find(item=>item.objectId===original.objectId);
        expect(tombstone).toMatchObject({deleted:true,headCommitId:result.commitId});
      } else {
        const actual=await client.revealObject(vault.vaultHandle,original.objectId);
        expect(actual.deleted).toBe(false);
        expect(actual.payloadJson).toBe(original.payloadJson);
        expect(actual.headCommitId).toBe(original.headCommitId);
      }
    }
    const repeated=await deleteMdbx2TransferSources(client,source,[...items].reverse(),operationId,'synthetic-target');
    expect(repeated.commitId).toBe(result.commitId);expect(repeated.alreadyCommitted).toBe(true);
    expect(hash(await readFile(input))).toBe(inputHash);
    await writeFile(join(root,'source-delete-evidence.json'),JSON.stringify({status:'passed',input,inputSha256:inputHash,
      sourceIds:[...targetIds],commitId:result.commitId,staleGroupZeroWrites:true,lostResponseRecovered:true,reversedOrderRetrySameCommit:true,
      deletedGroupSharesCommit:true,otherRecordPayloadsAndRevisionsUnchanged:true,liveBindingAndRevisionCheckPassed:true,deletedTargetCheckRejected:true,
      scope:'Real Native Host isolated source deletion primitive; deleted payloads are not disclosed; not end-to-end move recovery'},null,2));
  }finally{client.close();}
});
