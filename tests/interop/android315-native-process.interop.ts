import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parseLosslessJson } from "../../src/core/lossless-json";
import { createLoginItem, type ProviderAccount } from "../../src/core/model";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { MDBX2_MAX_BINARY_CHUNK_BYTES, type Mdbx2ObjectRecord } from "../../src/providers/mdbx2/native-contract";
import { decodeMdbx2Object } from "../../src/providers/mdbx2/mdbx2-item-codec";
import { Mdbx2Provider } from "../../src/providers/mdbx2/mdbx2-provider";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";

const fixtureRoot = process.env.MONICA_315_APP_FIXTURE ? resolve(process.env.MONICA_315_APP_FIXTURE) : undefined;
const phase = process.env.MONICA_315_NATIVE_PHASE || "forward";
if (phase !== "forward" && phase !== "return") throw new Error("MONICA_315_NATIVE_PHASE must be forward or return");
const input = fixtureRoot && join(fixtureRoot, phase === "forward" ? "android.mdbx" : "android-return.mdbx");
const available = Boolean(input && existsSync(input));
const executable = resolve(process.env.MONICA_MDBX2_HOST || "native/mdbx2-host/target/debug/monica-mdbx2-host.exe");
const password = "Synthetic transfer fixture password";
const credential = { method: "password" as const, password };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface SnapshotRecord extends Mdbx2ObjectRecord { updatedAt: string }
interface AttachmentEvidence { objectId: string; attachmentId: string; fileName: string; storageMode: string; sizeBytes: number; sha256: string }
interface BlobFixture { blobId: string; bytes: Buffer }

it.skipIf(!available || phase !== "forward")("rejects a missing Blob without mutating Android Object data", async () => {
  if (!fixtureRoot || !input) throw new Error("Explicit fixture directory is required");
  const processRoot = await mkdtemp(join(fixtureRoot, "native-missing-blob-"));
  const client = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, processRoot));
  try {
    const opened = await openFile(client, input);
    const before = await snapshot(client, opened.vaultHandle);
    let denied = 0;
    for (const record of before) {
      const listed = await client.listAttachments(opened.vaultHandle, record.collectionId, record.objectId);
      for (const attachment of listed.items.filter(item => item.storageMode === "external-hash-ref")) {
        await expect(client.beginAttachmentRead(opened.vaultHandle, attachment.attachmentId)).rejects.toMatchObject({ code: "attachment-integrity-failed" });
        denied++;
      }
    }
    expect(denied).toBeGreaterThan(0);
    expect(await snapshot(client, opened.vaultHandle)).toEqual(before);
    await writeFile(join(fixtureRoot, "native-missing-blob-evidence.json"), JSON.stringify({ status: "passed", fault: "external Blob intentionally not transferred", rejectedAttachmentReads: denied, objectCount: before.length,
      objectPayloadIdentityAndRevisionsUnchanged: true, inputSha256: hash(await readFile(input)), hostSha256: hash(await readFile(executable)) }, null, 2));
  } finally { client.close(); }
});

it.skipIf(!available)(`Android app → actual Native Host process → Android ${phase} (requires MONICA_315_APP_FIXTURE and real exported fixture; no synthetic fallback)`, async () => {
  if (!fixtureRoot || !input) throw new Error("Explicit fixture directory is required");
  const processRoot = await mkdtemp(join(fixtureRoot, `native-${phase}-`));
  const evidence: Record<string, unknown> = { phase, layer: "Android app fixture / actual Native Host process / extension provider codec; not Edge UI", input,
    inputSha256: hash(await readFile(input)), hostExecutable: executable, hostSha256: hash(await readFile(executable)), status: "failed", browser: "not used", checks: [] };
  const checks = evidence.checks as string[];
  let client = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, processRoot));
  try {
    evidence.capabilities = await client.hello(30_000);
    const opened = await openFile(client, input);
    const binding = hash(`synthetic-android315:${processRoot}`);
    const blobPrefix = phase === "forward" ? "android-blobs" : "android-return-blobs";
    const sourceBlobs = await loadBlobs(fixtureRoot, blobPrefix);
    const stateHandle = await receiveBlobs(client, opened.vaultHandle, binding, sourceBlobs);
    evidence.inputBlobs = sourceBlobs.map(blob => ({ blobId: blob.blobId, sizeBytes: blob.bytes.length, sha256: hash(blob.bytes) }));
    checks.push("Real encrypted Android Blob files imported through authenticated Host sync.blob.receive API; content hash and declared length verified");
    let records = await snapshot(client, opened.vaultHandle);
    expect(records.length).toBeGreaterThan(0);
    const attachments = await attachmentEvidence(client, opened.vaultHandle, records);
    evidence.initialRecordCount = records.length;
    evidence.attachments = attachments;
    checks.push("Every listed attachment read through authenticated Native Host API and SHA-256 computed");
    if (phase === "return") {
      const expected = JSON.parse(await readFile(join(fixtureRoot, "extension-native-records.json"), "utf8")) as SnapshotRecord[];
      let androidEdits = 0;
      const comparisons: Array<Record<string, unknown>> = [];
      const unexpectedDifferences: Array<{ objectId: string; field: string; beforeJson: string; afterJson: string }> = [];
      for (const before of expected) {
        const after = records.find(record => record.objectId === before.objectId);
        if (!after) {
          unexpectedDifferences.push({ objectId: before.objectId, field: "/record", beforeJson: "present", afterJson: "[absent]" });
          comparisons.push({ objectId: before.objectId, present: false });
          continue;
        }
        const a = parseLosslessJson(before.payloadJson) as Record<string, unknown>;
        const b = parseLosslessJson(after.payloadJson) as Record<string, unknown>;
        const notesEdited = b.notes === `${a.notes || ""}\nAndroid roundtrip edit`;
        const allPayloadDifferences = jsonDifferences(a, b, "/payload");
        if (notesEdited) { androidEdits++; b.notes = a.notes; }
        const payloadDifferences = jsonDifferences(a, b, "/payload");
        const metadata = (record: SnapshotRecord) => ({ title: record.title, objectTypeId: record.objectTypeId, payloadSchemaVersion: record.payloadSchemaVersion, collectionId: record.collectionId, deleted: record.deleted });
        const metadataDifferences = jsonDifferences(metadata(before), metadata(after), "/metadata");
        unexpectedDifferences.push(...[...payloadDifferences, ...metadataDifferences].map(difference => ({ objectId: before.objectId, ...difference })));
        comparisons.push({ objectId: before.objectId, nativeType: before.objectTypeId, logicalIdBefore: a.monica_entry_id, logicalIdAfter: b.monica_entry_id,
          notesEdited, allPayloadDifferences, unexpectedPayloadDifferences: payloadDifferences, metadataDifferences,
          revisionBefore: before.headCommitId, revisionAfter: after.headCommitId, revisionChanged: before.headCommitId !== after.headCommitId,
          updatedAtBefore: before.updatedAt, updatedAtAfter: after.updatedAt });
      }
      for (const after of records) if (!expected.some(before => before.objectId === after.objectId)) {
        unexpectedDifferences.push({ objectId: after.objectId, field: "/record", beforeJson: "[absent]", afterJson: "present" });
      }
      const priorEvidence = JSON.parse(await readFile(join(fixtureRoot, "native-forward-evidence.json"), "utf8")) as { attachments: AttachmentEvidence[] };
      evidence.returnComparison = { expectedRecordCount: expected.length, actualRecordCount: records.length, expectedNotesEditCount: 1, actualNotesEditCount: androidEdits,
        nativeIdsEqual: canonical(records.map(record => record.objectId).sort()) === canonical(expected.map(record => record.objectId).sort()),
        attachmentsEqual: canonical(attachments) === canonical(priorEvidence.attachments), comparisons, unexpectedDifferences };
      await writeFile(join(fixtureRoot, "native-return-records.json"), JSON.stringify(records, null, 2));
      // Collect every field/revision difference before asserting: a legitimate
      // local Room-ID rebinding is evidence to analyze, not silently ignore.
      expect(androidEdits).toBe(1);
      expect(attachments).toEqual(priorEvidence.attachments);
      expect(unexpectedDifferences, "Android return changed fields beyond the explicitly requested notes edit; see returnComparison").toEqual([]);
      checks.push("Android app notes edit returned; all other payload fields, native IDs, types and attachment bytes unchanged");
    } else {
      const androidRecords = JSON.parse(await readFile(join(fixtureRoot, "android-records.json"), "utf8")) as Array<{ entryId: string; type: string; title: string; payloadJson: string }>;
      expect(records).toHaveLength(androidRecords.length);
      for (const android of androidRecords) {
        const actual = records.find(record => record.objectId === android.entryId || (parseLosslessJson(record.payloadJson) as Record<string, unknown>).monica_entry_id === android.entryId);
        expect(actual, `Missing Android logical/native identity ${android.entryId}`).toBeDefined();
        expect(actual).toMatchObject({ title: android.title, objectTypeId: android.type });
        expect(canonical(parseLosslessJson(actual!.payloadJson))).toBe(canonical(parseLosslessJson(android.payloadJson)));
      }
      checks.push("Android application export payloads match actual Native Host disclosure losslessly");
      const account: ProviderAccount = { id: "android315-process", kind: "mdbx2", name: "Synthetic Android315", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: opened.vaultHandle } };
      const provider = new Mdbx2Provider(client);
      const edits: Array<{ objectId: string; nativeType: string; modelKind?: string; status: string }> = [];
      evidence.edits = edits;
      for (const record of records) {
        const decoded = decodeMdbx2Object(record, { headCommitId: record.headCommitId!, updatedAt: record.updatedAt }, account.id);
        expect(decoded.item, `No visible item for ${record.objectTypeId}`).toBeDefined();
        const payload = parseLosslessJson(record.payloadJson) as Record<string, unknown>;
        if (payload.login_type === "WIFI" && payload.wifi_metadata) {
          expect(decoded.item?.kind).toBe("login");
          if (decoded.item?.kind !== "login") throw new Error("Android Wi-Fi must decode as a login");
          expect(decoded.item.wifiMetadata).toBe(typeof payload.wifi_metadata === "string" ? payload.wifi_metadata : JSON.stringify(payload.wifi_metadata));
          checks.push("Current Android Wi-Fi native metadata decoded completely into the editable extension model");
        }
        if (decoded.item!.kind === "opaque") {
          edits.push({ objectId: record.objectId, nativeType: record.objectTypeId, modelKind: "opaque", status: "readonly; not edited" });
          continue;
        }
        const updated = await provider.update(account, { ...decoded.item!, title: `${record.title} · Extension315` });
        const after = await client.revealObject(opened.vaultHandle, record.objectId);
        expect(after.objectTypeId).toBe(record.objectTypeId);
        expect(canonical(parseLosslessJson(after.payloadJson)), `Title-only edit rewrote payload for ${record.objectTypeId}/${record.objectId}`).toBe(canonical(parseLosslessJson(record.payloadJson)));
        expect(updated.providerRefs[0].remoteId).toBe(record.objectId);
        await expect(provider.update(account, decoded.item!)).rejects.toThrow("已变化");
        edits.push({ objectId: record.objectId, nativeType: record.objectTypeId, modelKind: decoded.item!.kind, status: "title edited; all payload fields unchanged; stale revision rejected" });
      }
      const created = await provider.create(account, createLoginItem({ title: "Extension315-native-created", username: "synthetic-extension-user", password: "synthetic-extension-password", notes: "Created by actual extension provider; not UI" }));
      expect(created.providerRefs[0].remoteId).toBeTruthy();
      records = await snapshot(client, opened.vaultHandle);
      checks.push("All editable Android records title-edited by extension provider without changing payloads; new extension login created");

      await client.lockVault(opened.vaultHandle);
      expect((await client.vaultStatus(opened.vaultHandle)).open).toBe(false);
      client.close();
      client = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, processRoot));
      await expect(client.openVault({ kind: "vault", handle: opened.vaultHandle }, { method: "password", password: "deliberately-wrong-synthetic-password" })).rejects.toThrow();
      await client.openVault({ kind: "vault", handle: opened.vaultHandle }, credential);
      expect(await snapshot(client, opened.vaultHandle)).toEqual(records);
      expect(await attachmentEvidence(client, opened.vaultHandle, records)).toEqual(attachments);
      checks.push("Lock, Native Host process restart, wrong-password rejection and correct-password reopen preserve objects and attachment bytes");
      const exportedBlobs = await exportBlobs(client, opened.vaultHandle, stateHandle, binding);
      const exportBinding = hash(`${binding}:outgoing-bootstrap`);
      const exported = await client.prepareSyncBootstrap(opened.vaultHandle, exportBinding);
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < exported.file.sizeBytes) {
        const chunk = await client.readOutputFile(opened.vaultHandle, exported.stateHandle, exportBinding, exported.file.fileHandle, offset);
        expect(chunk.nextOffset).toBeGreaterThan(offset);
        chunks.push(Buffer.from(chunk.dataBase64, "base64")); offset = chunk.nextOffset;
      }
      const bytes = Buffer.concat(chunks);
      expect(hash(bytes)).toBe(exported.file.sha256);
      // Verify generated bootstrap in an independent Host state before publishing it.
      const probeRoot = await mkdtemp(join(fixtureRoot, "native-bootstrap-check-"));
      const probe = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, probeRoot));
      try {
        const source = await stageBytes(probe, bytes);
        const portable = await probe.openVault({ kind: "file", handle: source }, credential);
        await receiveBlobs(probe, portable.vaultHandle, binding, exportedBlobs);
        expect(await snapshot(probe, portable.vaultHandle)).toEqual(records);
        expect(await attachmentEvidence(probe, portable.vaultHandle, records)).toEqual(attachments);
      } finally { probe.close(); }
      await writeFile(join(fixtureRoot, "extension.mdbx"), bytes);
      await mkdir(join(fixtureRoot, "extension-blobs"), { recursive: true });
      for (const blob of exportedBlobs) await writeFile(join(fixtureRoot, "extension-blobs", blob.blobId), blob.bytes);
      await writeFile(join(fixtureRoot, "extension-blobs.json"), JSON.stringify(exportedBlobs.map(blob => ({ path: `extension-blobs/${blob.blobId}`, blobId: blob.blobId, sizeBytes: blob.bytes.length })), null, 2));
      await writeFile(join(fixtureRoot, "extension-native-records.json"), JSON.stringify(records, null, 2));
      evidence.outputSha256 = hash(bytes);
      evidence.outputBlobs = exportedBlobs.map(blob => ({ blobId: blob.blobId, sizeBytes: blob.bytes.length, sha256: hash(blob.bytes) }));
      checks.push("Engine-created bootstrap plus separately transferred encrypted Blobs reopened independently; records and all attachment bytes verified before output (not a standalone single-file backup)");
    }
    evidence.status = "passed";
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    client.close();
    await writeFile(join(fixtureRoot, `native-${phase}-evidence.json`), JSON.stringify(evidence, null, 2));
  }
});

function canonical(value: unknown): string {
  const isRaw = (JSON as typeof JSON & { isRawJSON?: (input: unknown) => boolean }).isRawJSON;
  return JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child) && !isRaw?.(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
}

function jsonDifferences(before: unknown, after: unknown, field: string): Array<{ field: string; beforeJson: string; afterJson: string }> {
  const a = canonical(before);
  const b = canonical(after);
  if (a === b) return [];
  const isRaw = (JSON as typeof JSON & { isRawJSON?: (input: unknown) => boolean }).isRawJSON;
  if (before && after && typeof before === "object" && typeof after === "object" && !isRaw?.(before) && !isRaw?.(after) && Array.isArray(before) === Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap(key => jsonDifferences((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], `${field}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  }
  return [{ field, beforeJson: a ?? "[absent]", afterJson: b ?? "[absent]" }];
}

async function stageBytes(client: Mdbx2NativeClient, bytes: Uint8Array): Promise<string> {
  const transfer = await client.beginInboundTransfer(bytes.length, hash(bytes));
  for (let offset = 0; offset < bytes.length; offset += MDBX2_MAX_BINARY_CHUNK_BYTES) await client.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + MDBX2_MAX_BINARY_CHUNK_BYTES));
  return (await client.finishInboundTransfer(transfer.transferId)).fileHandle;
}

async function openFile(client: Mdbx2NativeClient, path: string) {
  return client.openVault({ kind: "file", handle: await stageBytes(client, await readFile(path)) }, credential);
}

async function loadBlobs(root: string, prefix: string): Promise<BlobFixture[]> {
  const manifest = JSON.parse(await readFile(join(root, `${prefix}.json`), "utf8")) as Array<{ path: string; blobId: string; sizeBytes: number }>;
  expect(Array.isArray(manifest)).toBe(true);
  expect(new Set(manifest.map(blob => blob.blobId)).size).toBe(manifest.length);
  return Promise.all(manifest.map(async blob => {
    expect(blob.blobId).toMatch(/^[a-f0-9]{64}$/);
    expect(blob.path).toBe(`${prefix}/${blob.blobId}`);
    const bytes = await readFile(join(root, prefix, blob.blobId));
    expect(bytes.length).toBe(blob.sizeBytes); expect(hash(bytes)).toBe(blob.blobId);
    return { blobId: blob.blobId, bytes };
  }));
}

async function receiveBlobs(client: Mdbx2NativeClient, vaultHandle: string, binding: string, blobs: BlobFixture[]): Promise<string> {
  const state = await client.registerSyncState(vaultHandle, binding);
  for (const blob of blobs) {
    const begun = await client.beginExternalBlobReceive(vaultHandle, state.stateHandle, binding, blob.blobId, blob.bytes.length);
    for (let offset = begun.nextOffset; offset < blob.bytes.length; offset += MDBX2_MAX_BINARY_CHUNK_BYTES) {
      const bytes = blob.bytes.subarray(offset, offset + MDBX2_MAX_BINARY_CHUNK_BYTES);
      await client.writeExternalBlobReceiveChunk(vaultHandle, state.stateHandle, binding, blob.blobId, blob.bytes.length, offset, bytes, offset + bytes.length === blob.bytes.length);
    }
  }
  return state.stateHandle;
}

async function exportBlobs(client: Mdbx2NativeClient, vaultHandle: string, stateHandle: string, binding: string): Promise<BlobFixture[]> {
  const blobs: BlobFixture[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listExternalBlobs(vaultHandle, stateHandle, binding, cursor);
    for (const blob of page.items) {
      expect(blob.state).toBe("available"); expect(blob.totalSize).toBeGreaterThan(0);
      const chunks: Buffer[] = []; let offset = 0;
      while (offset < blob.totalSize!) {
        const chunk = await client.readExternalBlob(vaultHandle, stateHandle, binding, blob.blobId, blob.totalSize!, offset);
        expect(chunk.nextOffset).toBeGreaterThan(offset); chunks.push(Buffer.from(chunk.dataBase64, "base64")); offset = chunk.nextOffset;
      }
      const bytes = Buffer.concat(chunks); expect(hash(bytes)).toBe(blob.blobId); expect(bytes.length).toBe(blob.totalSize);
      blobs.push({ blobId: blob.blobId, bytes });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return blobs;
}

async function snapshot(client: Mdbx2NativeClient, vaultHandle: string): Promise<SnapshotRecord[]> {
  const output: SnapshotRecord[] = [];
  let collectionCursor: string | undefined;
  do {
    const collections = await client.listCollections(vaultHandle, { cursor: collectionCursor });
    for (const collection of collections.items) {
      let cursor: string | undefined;
      do {
        const page = await client.listObjects(vaultHandle, collection.collectionId, { cursor });
        for (const item of page.items) output.push({ ...await client.revealObject(vaultHandle, item.objectId), headCommitId: item.headCommitId, updatedAt: item.updatedAt });
        cursor = page.nextCursor;
      } while (cursor);
    }
    collectionCursor = collections.nextCursor;
  } while (collectionCursor);
  return output.sort((a, b) => a.objectId.localeCompare(b.objectId));
}

async function attachmentEvidence(client: Mdbx2NativeClient, vaultHandle: string, records: SnapshotRecord[]): Promise<AttachmentEvidence[]> {
  const output: AttachmentEvidence[] = [];
  for (const record of records) {
    let cursor: string | undefined;
    do {
      const page = await client.listAttachments(vaultHandle, record.collectionId, record.objectId, { cursor });
      for (const attachment of page.items) {
        const begun = await client.beginAttachmentRead(vaultHandle, attachment.attachmentId);
        const chunks: Buffer[] = [];
        let offset = 0;
        try {
          while (offset < begun.sizeBytes) {
            const chunk = await client.readAttachmentChunk(begun.readHandle, offset);
            expect(chunk.nextOffset).toBeGreaterThan(offset);
            chunks.push(Buffer.from(chunk.dataBase64, "base64")); offset = chunk.nextOffset;
          }
        } finally { await client.releaseAttachmentRead(begun.readHandle); }
        const bytes = Buffer.concat(chunks);
        expect(bytes.length).toBe(attachment.sizeBytes);
        output.push({ objectId: record.objectId, attachmentId: attachment.attachmentId, fileName: attachment.fileName, storageMode: attachment.storageMode, sizeBytes: bytes.length, sha256: hash(bytes) });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  return output.sort((a, b) => a.attachmentId.localeCompare(b.attachmentId));
}
