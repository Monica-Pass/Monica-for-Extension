import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { Mdbx2LocalFileExports } from "../../src/providers/mdbx2/local-file-export";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";

const fixtureRoot = process.env.MONICA_315_APP_FIXTURE ? resolve(process.env.MONICA_315_APP_FIXTURE) : undefined;
const source = fixtureRoot && join(fixtureRoot, "android-ui.mdbx");
const executable = resolve(process.env.MONICA_MDBX2_HOST || "native/mdbx2-host/target/debug/monica-mdbx2-host.exe");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const credential = { method: "password" as const, password: "Synthetic transfer fixture password" };

it.skipIf(!source || !existsSync(source))("exports the actual attachment-free Android UI fixture through the bounded native download service", async () => {
  if (!source || !fixtureRoot) throw new Error("Actual Android fixture required");
  const processRoot = await mkdtemp(join(fixtureRoot, "native-ui-export-"));
  const native = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, processRoot));
  let exports: Mdbx2LocalFileExports | undefined;
  try {
    const sourceBytes = await readFile(source);
    const opened = await openBytes(native, sourceBytes);
    const before = await records(native, opened.vaultHandle);
    expect(before.length).toBeGreaterThan(0);
    exports = new Mdbx2LocalFileExports(native, async () => ({ vaultHandle: opened.vaultHandle, fileName: "Android-UI.mdbx" }));
    const begun = await exports.begin("synthetic-provider", "synthetic-document");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < begun.sizeBytes;) {
      const chunk = await exports.read("synthetic-provider", "synthetic-document", begun.downloadHandle, offset);
      chunks.push(Buffer.from(chunk.dataBase64, "base64")); offset = chunk.nextOffset;
    }
    const output = Buffer.concat(chunks);
    expect(output.byteLength).toBe(begun.sizeBytes);
    expect(hash(output)).toBe(begun.sha256);
    expect(await exports.release("synthetic-provider", "synthetic-document", begun.downloadHandle)).toBe(true);
    await expect(exports.read("synthetic-provider", "synthetic-document", begun.downloadHandle, 0)).rejects.toThrow("过期");
    const reopened = await openBytes(native, output);
    expect(await records(native, reopened.vaultHandle)).toEqual(before);
    expect(await records(native, opened.vaultHandle)).toEqual(before);
    expect(hash(await readFile(source))).toBe(hash(sourceBytes));
    await writeFile(join(fixtureRoot, "native-local-export-evidence.json"), JSON.stringify({ status: "passed", layer: "actual Native Host process and bounded download service; not Edge UI", input: source, inputSha256: hash(sourceBytes), outputSha256: hash(output), hostSha256: hash(await readFile(executable)), objectCount: before.length, sourceUnchanged: true, outputReopenedAndPayloadsEqual: true, scope: "attachment-free database only" }, null, 2));
  } finally { await exports?.clear(); native.close(); }
});

async function openBytes(native: Mdbx2NativeClient, bytes: Uint8Array) {
  const transfer = await native.beginInboundTransfer(bytes.length, hash(bytes));
  for (let offset = 0; offset < bytes.length;) {
    const chunk = bytes.subarray(offset, offset + transfer.maxChunkBytes);
    const sent = await native.sendInboundChunk(transfer.transferId, offset, chunk); offset = sent.nextOffset;
  }
  const finished = await native.finishInboundTransfer(transfer.transferId);
  return native.openVault({ kind: "file", handle: finished.fileHandle }, credential);
}
async function records(native: Mdbx2NativeClient, vaultHandle: string) {
  const result: unknown[] = [];
  const collections = await native.listCollections(vaultHandle);
  expect(collections.nextCursor).toBeUndefined();
  for (const collection of collections.items) {
    const items = await native.listObjects(vaultHandle, collection.collectionId);
    expect(items.nextCursor).toBeUndefined();
    for (const item of items.items) result.push(await native.revealObject(vaultHandle, item.objectId));
  }
  return result;
}
