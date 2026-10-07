import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";
import type { Mdbx2ObjectRecord } from "../../src/providers/mdbx2/native-contract";

const root = process.env.MONICA_315_APP_FIXTURE;
const source = process.env.MONICA_315_CONTENT_EDGE_FILE;
const phase = process.env.MONICA_315_CONTENT_PHASE || "prepare";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const orderOf = (record: Mdbx2ObjectRecord) => (JSON.parse(record.payloadJson).custom_fields || []).find((field: {title:string})=>field.title==='monica.content.order')?.value as string | undefined;

it.skipIf(!root || !source)(`actual Edge reordered database → Android application content ${phase}`, async () => {
  if (!root || !source) throw new Error("Explicit synthetic Edge source and output required");
  if (!["prepare","return"].includes(phase)) throw new Error("Unknown phase");
  await mkdir(root,{recursive:true});
  const input = phase === "prepare" ? source : join(root,"android-return.mdbx");
  const bytes = await readFile(input);
  const client = new Mdbx2NativeClient(new ProcessNativeRuntime(resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe"),await mkdtemp(join(root,'content-host-'))));
  try {
    const transfer = await client.beginInboundTransfer(bytes.length,hash(bytes));
    for(let offset=0;offset<bytes.length;){const chunk=bytes.subarray(offset,offset+transfer.maxChunkBytes);offset=(await client.sendInboundChunk(transfer.transferId,offset,chunk)).nextOffset;}
    const finished=await client.finishInboundTransfer(transfer.transferId);
    const opened=await client.openVault({kind:"file",handle:finished.fileHandle},{method:"password",password:"Synthetic transfer fixture password"});
    const collections=await client.listCollections(opened.vaultHandle);expect(collections.nextCursor).toBeUndefined();
    const records:Mdbx2ObjectRecord[]=[];
    for(const collection of collections.items){const listed=await client.listObjects(opened.vaultHandle,collection.collectionId);expect(listed.nextCursor).toBeUndefined();for(const item of listed.items)records.push(await client.revealObject(opened.vaultHandle,item.objectId));}
    if(phase==='prepare'){
      const reordered=records.filter(record=>orderOf(record)?.split(',')[1]==='FUTURE');
      expect(reordered).toHaveLength(1);
      const blobRoot=process.env.MONICA_315_CONTENT_BLOBS;
      if(!blobRoot)throw new Error('Original Android encrypted Blob directory required');
      const manifest=JSON.parse(await readFile(join(blobRoot,'android-blobs.json'),'utf8')) as Array<{blobId:string;path:string;sizeBytes:number}>;
      await mkdir(join(root,'extension-blobs'),{recursive:true});
      for(const blob of manifest){expect(blob.blobId).toMatch(/^[0-9a-f]{64}$/);expect(blob.path).toBe(`android-blobs/${blob.blobId}`);const data=await readFile(join(blobRoot,blob.path));expect(hash(data)).toBe(blob.blobId);expect(data.length).toBe(blob.sizeBytes);await writeFile(join(root,'extension-blobs',blob.blobId),data);}
      await writeFile(join(root,'extension-blobs.json'),JSON.stringify(manifest.map(blob=>({...blob,path:`extension-blobs/${blob.blobId}`})),null,2));
      await writeFile(join(root,'extension.mdbx'),bytes);
      await writeFile(join(root,'edge-before-records.json'),JSON.stringify(records,null,2));
      await writeFile(join(root,'content-prepare-evidence.json'),JSON.stringify({status:'passed',source,sha256:hash(bytes),targetId:reordered[0].objectId,order:orderOf(reordered[0]),encryptedBlobs:manifest.length,scope:'Closed real Edge Native vault copied without modifying records; original encrypted attachment Blobs restored for Android'},null,2));
    }else{
      const expected=JSON.parse(await readFile(join(root,'edge-before-records.json'),'utf8')) as Mdbx2ObjectRecord[];
      const target=expected.find(record=>orderOf(record)?.split(',')[1]==='FUTURE')!;
      expect(target).toBeDefined();
      const actual=records.find(record=>record.objectId===target.objectId)!;expect(actual).toBeDefined();
      expect(JSON.parse(actual.payloadJson).custom_fields).toEqual(JSON.parse(target.payloadJson).custom_fields);
      const projection=JSON.parse(await readFile(join(root,'extension-native-readback.json'),'utf8')) as {contentOrders:Array<{order:string}>};
      expect(projection.contentOrders.filter(entry=>entry.order===orderOf(target))).toHaveLength(1);
      expect(records.map(record=>record.objectId).sort()).toEqual(expected.map(record=>record.objectId).sort());
      await writeFile(join(root,'content-return-evidence.json'),JSON.stringify({status:'passed',targetId:target.objectId,order:orderOf(actual),androidRoomProjectionConfirmed:true,allTargetCustomFieldsExact:true,allNativeIdsPreserved:true,scope:'Actual Android repository/ViewModel import, Room custom-field projection and re-export; not Android screen UI'},null,2));
    }
    expect(hash(await readFile(input))).toBe(hash(bytes));
  }finally{client.close();}
});
