import { access, readFile, writeFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";

const root = process.env.MONICA_315_APP_FIXTURE;
const source = process.env.MONICA_315_MOVE_EDGE_FILE;
const locationFile = process.env.MONICA_315_MOVE_LOCATION;
const phase = process.env.MONICA_315_MOVE_PHASE || "prepare";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Blob = { blobId: string; path: string; sizeBytes: number };

it.skipIf(!root || !source || !locationFile)(`actual Edge moved attachment Android ${phase}`, async () => {
  if (!root || !source || !locationFile) throw new Error("Explicit synthetic fixture paths required");
  expect(["prepare", "return"]).toContain(phase);
  await mkdir(root, { recursive: true });
  const location = JSON.parse(await readFile(locationFile, "utf8"));
  const input = phase === "prepare" ? source : join(root, "android-return.mdbx");
  // Only a closed database may be copied: never silently discard pending WAL data.
  await expect(access(`${input}-wal`)).rejects.toThrow();
  const bytes = await readFile(input);
  let blobs: Blob[];
  if (phase === "prepare") {
    blobs = [];
    await mkdir(join(root, "extension-blobs"), { recursive: true });
    for (const path of await readdir(`${source}.blobs`, { recursive: true })) {
      const blobId = path.split(/[\\/]/).at(-1)!;
      if (!/^[0-9a-f]{64}$/.test(blobId)) continue;
      const data = await readFile(join(`${source}.blobs`, path));
      expect(hash(data)).toBe(blobId);
      const destination = `extension-blobs/${blobId}`;
      await writeFile(join(root, destination), data);
      blobs.push({ blobId, path: destination, sizeBytes: data.length });
    }
    expect(blobs.length).toBeGreaterThan(0);
    await writeFile(join(root, "extension-blobs.json"), JSON.stringify(blobs, null, 2));
    await writeFile(join(root, "extension.mdbx"), bytes);
  } else blobs = JSON.parse(await readFile(join(root, "android-return-blobs.json"), "utf8"));
  const appData = await mkdtemp(join(root, "move-return-host-"));
  const client = new Mdbx2NativeClient(new ProcessNativeRuntime(resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe"), appData));
  try {
    const transfer = await client.beginInboundTransfer(bytes.length, hash(bytes));
    for (let offset = 0; offset < bytes.length;) {
      offset = (await client.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
    }
    const file = await client.finishInboundTransfer(transfer.transferId);
    const credential = { method: "password" as const, password: "Synthetic transfer fixture password" };
    const opened = await client.openVault({ kind: "file", handle: file.fileHandle }, credential);
    await client.lockVault(opened.vaultHandle);
    // Restore verified encrypted Blobs into this test-owned imported vault only.
    const vaultRoot = join(appData, "Monica Extension", "MDBX2", "vaults");
    const vaults = await readdir(vaultRoot); expect(vaults).toHaveLength(1);
    for (const blob of blobs) {
      expect(blob.blobId).toMatch(/^[0-9a-f]{64}$/);
      expect(blob.path).toBe(`${phase === "prepare" ? "extension" : "android-return"}-blobs/${blob.blobId}`);
      const data = await readFile(join(root, blob.path)); expect(hash(data)).toBe(blob.blobId); expect(data.length).toBe(blob.sizeBytes);
      const directory = join(vaultRoot, vaults[0], "vault.mdbx.blobs", blob.blobId.slice(0, 2), blob.blobId.slice(2, 4));
      await mkdir(directory, { recursive: true }); await writeFile(join(directory, blob.blobId), data);
    }
    await client.openVault({ kind: "vault", handle: opened.vaultHandle }, credential);
    const record = await client.revealObject(opened.vaultHandle, location.objectId);
    expect(record.collectionId).toBe(location.newCollectionId);
    const attachments = await client.listAttachments(opened.vaultHandle, record.collectionId, record.objectId);
    expect(attachments.nextCursor).toBeUndefined();
    expect(attachments.items.map(item => item.attachmentId).sort()).toEqual(location.savedAttachmentProofs.map((item: { attachmentId: string }) => item.attachmentId).sort());
    for (const proof of location.savedAttachmentProofs) {
      expect(attachments.items.find(item => item.attachmentId === proof.attachmentId)).toMatchObject({ fileName: proof.fileName, mediaType: proof.mediaType, sizeBytes: proof.sizeBytes });
      const read = await client.beginAttachmentRead(opened.vaultHandle, proof.attachmentId);
      const chunks: Buffer[] = [];
      try {
        for (let offset = 0; offset < read.sizeBytes;) {
          const chunk = await client.readAttachmentChunk(read.readHandle, offset);
          expect(chunk.nextOffset).toBeGreaterThan(offset);
          chunks.push(Buffer.from(chunk.dataBase64, "base64")); offset = chunk.nextOffset;
        }
      } finally { await client.releaseAttachmentRead(read.readHandle); }
      expect(hash(Buffer.concat(chunks))).toBe(proof.sha256);
    }
    const payload = JSON.parse(record.payloadJson);
    if (phase === "prepare") await writeFile(join(root, "move-before-record.json"), JSON.stringify(record, null, 2));
    else {
      const before = JSON.parse(await readFile(join(root, "move-before-record.json"), "utf8"));
      expect(payload.monica_entry_id).toBe(JSON.parse(before.payloadJson).monica_entry_id);
      expect(payload.password).toBe(JSON.parse(before.payloadJson).password);
      const projection = JSON.parse(await readFile(join(root, "extension-native-readback.json"), "utf8"));
      for (const key of ["attachmentsBeforeEdit", "attachmentsAfterEdit"]) {
        const actual = projection[key].filter((item: { replicaGroupId: string }) => item.replicaGroupId === payload.monica_entry_id);
        expect(actual).toHaveLength(location.savedAttachmentProofs.length);
        for (const proof of location.savedAttachmentProofs) expect(actual).toContainEqual({ replicaGroupId: payload.monica_entry_id, fileName: proof.fileName, sizeBytes: proof.sizeBytes, sha256: proof.sha256 });
      }
    }
    await writeFile(join(root, `moved-attachment-${phase}-evidence.json`), JSON.stringify({ status: "passed", source, sourceSha256: hash(bytes), objectId: record.objectId,
      collectionId: record.collectionId, attachmentIds: attachments.items.map(item => item.attachmentId), encryptedBlobs: blobs.length,
      actualNativeBytesVerified: true, androidFacadeBeforeAndAfterEditVerified: phase === "return",
      scope: "Actual Edge same-vault recovery -> Android repository/ViewModel edit/reopen -> Native attachment bytes; Android screen UI is separate" }, null, 2));
    await client.lockVault(opened.vaultHandle);
    expect(hash(await readFile(input))).toBe(hash(bytes));
  } finally { client.close(); }
});
