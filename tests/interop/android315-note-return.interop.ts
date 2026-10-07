import { readFile, writeFile, mkdir, mkdtemp, readdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";
import type { Mdbx2ObjectRecord } from "../../src/providers/mdbx2/native-contract";

const root = process.env.MONICA_315_APP_FIXTURE;
const source = process.env.MONICA_315_NOTE_EDGE_FILE;
const phase = process.env.MONICA_315_NOTE_PHASE || "prepare";
// Optional explicit copy target when the source vault also retains its linked original.
const targetId = process.env.MONICA_315_NOTE_TARGET_ID;
const expectedLinks = Number(process.env.MONICA_315_NOTE_EXPECTED_LINKS || "1");
const nativeBlobRoot = process.env.MONICA_315_NOTE_NATIVE_BLOBS;
const selectedLink = (record: Mdbx2ObjectRecord) => record.objectTypeId === 'login'
  && (!targetId || record.objectId === targetId) && typeof linkOf(record) === 'string' && Boolean(linkOf(record));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const linkOf = (record: Mdbx2ObjectRecord) => JSON.parse(record.payloadJson).bound_note_entry_id as string | undefined;
const logicalId = (record: Mdbx2ObjectRecord) => JSON.parse(record.payloadJson).monica_entry_id as string;

it.skipIf(!root || !source)(`actual Edge linked note → Android application relation ${phase}`, async () => {
  if (!root || !source) throw new Error("Explicit synthetic Edge source and output required");
  if (!["prepare","return"].includes(phase)) throw new Error("Unknown phase");
  await mkdir(root,{recursive:true});
  const input = phase === "prepare" ? source : join(root,"android-return.mdbx");
  await expect(access(`${input}-wal`)).rejects.toThrow();
  const bytes = await readFile(input);
  const appData = await mkdtemp(join(root,'content-host-'));
  const client = new Mdbx2NativeClient(new ProcessNativeRuntime(resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe"),appData));
  if (nativeBlobRoot && phase === 'prepare') {
    const manifest = [];
    await mkdir(join(root, 'native-blob-input', 'android-blobs'), { recursive: true });
    for (const path of await readdir(nativeBlobRoot, { recursive: true })) {
      const blobId = path.split(/[\\/]/).at(-1)!;
      if (!/^[0-9a-f]{64}$/.test(blobId)) continue;
      const data = await readFile(join(nativeBlobRoot, path)); expect(hash(data)).toBe(blobId);
      await writeFile(join(root, 'native-blob-input', 'android-blobs', blobId), data);
      manifest.push({ blobId, path: `android-blobs/${blobId}`, sizeBytes: data.length });
    }
    await writeFile(join(root, 'native-blob-input', 'android-blobs.json'), JSON.stringify(manifest));
  }
  try {
    const transfer = await client.beginInboundTransfer(bytes.length,hash(bytes));
    for(let offset=0;offset<bytes.length;){const chunk=bytes.subarray(offset,offset+transfer.maxChunkBytes);offset=(await client.sendInboundChunk(transfer.transferId,offset,chunk)).nextOffset;}
    const finished=await client.finishInboundTransfer(transfer.transferId);
    const opened=await client.openVault({kind:"file",handle:finished.fileHandle},{method:"password",password:"Synthetic transfer fixture password"});
    const collections=await client.listCollections(opened.vaultHandle);expect(collections.nextCursor).toBeUndefined();
    const records:Mdbx2ObjectRecord[]=[];
    for(const collection of collections.items){const listed=await client.listObjects(opened.vaultHandle,collection.collectionId);expect(listed.nextCursor).toBeUndefined();for(const item of listed.items)records.push(await client.revealObject(opened.vaultHandle,item.objectId));}
    if(phase==='prepare'){
      const reordered=records.filter(selectedLink);
      expect(reordered).toHaveLength(expectedLinks);
      const blobRoot=nativeBlobRoot ? join(root, 'native-blob-input') : process.env.MONICA_315_NOTE_BLOBS;
      if(!blobRoot)throw new Error('Original Android encrypted Blob directory required');
      const manifest=JSON.parse(await readFile(join(blobRoot,'android-blobs.json'),'utf8')) as Array<{blobId:string;path:string;sizeBytes:number}>;
      await mkdir(join(root,'extension-blobs'),{recursive:true});
      for(const blob of manifest){expect(blob.blobId).toMatch(/^[0-9a-f]{64}$/);expect(blob.path).toBe(`android-blobs/${blob.blobId}`);const data=await readFile(join(blobRoot,blob.path));expect(hash(data)).toBe(blob.blobId);expect(data.length).toBe(blob.sizeBytes);await writeFile(join(root,'extension-blobs',blob.blobId),data);}
      await writeFile(join(root,'extension-blobs.json'),JSON.stringify(manifest.map(blob=>({...blob,path:`extension-blobs/${blob.blobId}`})),null,2));
      await writeFile(join(root,'extension.mdbx'),bytes);
      await writeFile(join(root,'edge-before-records.json'),JSON.stringify(records,null,2));
      await writeFile(join(root,'note-prepare-evidence.json'),JSON.stringify({status:'passed',source,sha256:hash(bytes),targetId:reordered[0].objectId,noteLogicalId:linkOf(reordered[0]),encryptedBlobs:manifest.length,scope:'Closed real Edge Native vault copied without modifying records; original encrypted attachment Blobs restored for Android'},null,2));
    }else{
      const expected=JSON.parse(await readFile(join(root,'edge-before-records.json'),'utf8')) as Mdbx2ObjectRecord[];
      const targets=expected.filter(selectedLink);
      expect(targets).toHaveLength(expectedLinks);
      const verifiedLinks = [];
      for (const target of targets) {
      const note=expected.find(record=>record.objectTypeId==='note' && logicalId(record)===linkOf(target));
      expect(note).toBeDefined();
      const actual=records.find(record=>record.objectId===target.objectId)!;expect(actual).toBeDefined();
      expect(linkOf(actual)).toBe(linkOf(target));
      expect(actual.collectionId).toBe(target.collectionId);
      expect(JSON.parse(actual.payloadJson).password_group_id).toBe(JSON.parse(target.payloadJson).password_group_id);
      const returnedNote=records.find(record=>record.objectId===note!.objectId)!;expect(returnedNote).toBeDefined();
      expect(JSON.parse(returnedNote.payloadJson).item_data).toEqual(JSON.parse(note!.payloadJson).item_data);
      const projection=JSON.parse(await readFile(join(root,'extension-native-readback.json'),'utf8')) as {noteLinks:Array<{passwordReplicaGroupId:string;boundNoteRoomId:number|null;resolvedNoteRoomId:number|null;noteReplicaGroupId:string|null}>};
      const links=projection.noteLinks.filter(entry=>entry.passwordReplicaGroupId===logicalId(target));
      expect(links).toHaveLength(1);
      expect(links[0].boundNoteRoomId).toBeGreaterThan(0);
      expect(links[0].resolvedNoteRoomId).toBe(links[0].boundNoteRoomId);
      expect(links[0].noteReplicaGroupId).toBe(linkOf(target));
      verifiedLinks.push({ passwordId: target.objectId, noteId: note!.objectId, noteLogicalId: linkOf(actual), androidRoomLink: links[0] });
      }
      expect(records.map(record=>record.objectId).sort()).toEqual(expected.map(record=>record.objectId).sort());
      if (expectedLinks > 1) {
        expect(new Set(verifiedLinks.map(link => link.noteId)).size).toBe(1);
        expect(new Set(verifiedLinks.map(link => link.androidRoomLink.boundNoteRoomId)).size).toBe(1);
      }
      await writeFile(join(root,'note-return-evidence.json'),JSON.stringify({status:'passed',...verifiedLinks[0],verifiedLinks,noteContentExact:true,allNativeIdsPreserved:true,groupAndFolderPreserved:true,scope:'Actual Android repository/ViewModel import reconstructs Room boundNoteId from stable ID and re-exports it; not Android screen UI'},null,2));
    }
    if (nativeBlobRoot) {
      await client.lockVault(opened.vaultHandle);
      const prefix = phase === 'prepare' ? 'extension' : 'android-return';
      const manifest = JSON.parse(await readFile(join(root, `${prefix}-blobs.json`), 'utf8')) as Array<{blobId:string;path:string;sizeBytes:number}>;
      const vaultRoot = join(appData, 'Monica Extension', 'MDBX2', 'vaults');
      const vaults = await readdir(vaultRoot); expect(vaults).toHaveLength(1);
      for (const blob of manifest) {
        expect(blob.blobId).toMatch(/^[0-9a-f]{64}$/); expect(blob.path).toBe(`${prefix}-blobs/${blob.blobId}`);
        const data = await readFile(join(root, blob.path)); expect(hash(data)).toBe(blob.blobId); expect(data.length).toBe(blob.sizeBytes);
        const dir = join(vaultRoot, vaults[0], 'vault.mdbx.blobs', blob.blobId.slice(0,2), blob.blobId.slice(2,4));
        await mkdir(dir, { recursive: true }); await writeFile(join(dir, blob.blobId), data);
      }
      await client.openVault({kind:'vault',handle:opened.vaultHandle},{method:'password',password:'Synthetic transfer fixture password'});
      const proofs = [];
      for (const record of records) {
        const attachments = await client.listAttachments(opened.vaultHandle, record.collectionId, record.objectId); expect(attachments.nextCursor).toBeUndefined();
        for (const attachment of attachments.items) {
          const read = await client.beginAttachmentRead(opened.vaultHandle, attachment.attachmentId), chunks: Buffer[] = [];
          try {
            for (let offset=0;offset<read.sizeBytes;) { const chunk=await client.readAttachmentChunk(read.readHandle,offset); expect(chunk.nextOffset).toBeGreaterThan(offset); chunks.push(Buffer.from(chunk.dataBase64,'base64'));offset=chunk.nextOffset; }
          } finally { await client.releaseAttachmentRead(read.readHandle); }
          proofs.push({objectId:record.objectId,collectionId:record.collectionId,attachmentId:attachment.attachmentId,fileName:attachment.fileName,mediaType:attachment.mediaType,sizeBytes:attachment.sizeBytes,sha256:hash(Buffer.concat(chunks))});
        }
      }
      proofs.sort((a,b)=>a.attachmentId.localeCompare(b.attachmentId));
      if(phase==='prepare') await writeFile(join(root,'note-attachment-proofs.json'),JSON.stringify(proofs,null,2));
      else {
        expect(proofs).toEqual(JSON.parse(await readFile(join(root,'note-attachment-proofs.json'),'utf8')));
        await writeFile(join(root,'note-attachment-return-evidence.json'),JSON.stringify({status:'passed',attachmentCount:proofs.length,proofs,scope:'Actual Native decrypted bytes after Android import/edit/re-export, including note attachments'},null,2));
      }
      await client.lockVault(opened.vaultHandle);
    }
    expect(hash(await readFile(input))).toBe(hash(bytes));
  }finally{client.close();}
});
