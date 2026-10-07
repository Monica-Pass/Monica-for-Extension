import { readFile, writeFile, mkdir, mkdtemp, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { Mdbx2NativeClient } from '../../src/providers/mdbx2/native-client';
import type { Mdbx2ObjectRecord } from '../../src/providers/mdbx2/native-contract';
import type { LoginItem, ProviderAccount } from '../../src/core/model';
import { ProcessNativeRuntime } from './mdbx2-interop-support';
import { mdbx2ProjectRemovalAttachments } from '../../src/providers/mdbx2/mdbx2-project-removal-attachments';
import { hashProviderAttachment } from '../../src/providers/attachments/attachment-transfer';
import { Mdbx2Provider } from '../../src/providers/mdbx2/mdbx2-provider';
import { parseLosslessJson } from '../../src/core/lossless-json';

const output = process.env.MONICA_315_APP_FIXTURE, edgeRoot = process.env.MONICA_317_RESTORED_EDGE;
const blobRoot = process.env.MONICA_317_RESTORED_BLOBS;
const phase = process.env.MONICA_317_RESTORED_PHASE || 'prepare';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

it.skipIf(!output || !edgeRoot || !blobRoot)(`real Edge restored project + encrypted Blobs → current Android ${phase}`, async () => {
  if (!output || !edgeRoot || !blobRoot) throw new Error('Explicit synthetic roots required');
  expect(['prepare', 'return']).toContain(phase);
  await mkdir(output, { recursive: true });
  const edge = JSON.parse(await readFile(join(edgeRoot, 'evidence.json'), 'utf8'));
  expect(edge.status).toBe('passed'); expect(edge.nativeRegistryRestored).toBe(true);
  const expected = JSON.parse(await readFile(join(edgeRoot, 'edge-restored-project-expected.json'), 'utf8')) as {
    synthetic: boolean; restorationMode?: 'mixed'; originalRecords: { original: LoginItem; ref: LoginItem['providerRefs'][number]; native: Mdbx2ObjectRecord }[]; restored: LoginItem[]
  };
  expect([undefined, 'mixed']).toContain(expected.restorationMode);
  const mixed = expected.restorationMode === 'mixed', memberCount = mixed ? 4 : 3;
  expect((mixed ? edge.mixedRestore : edge.nativeRestore).restartVerified).toBe(true);
  expect(expected.synthetic).toBe(true); expect(expected.restored).toHaveLength(memberCount);
  expect(expected.originalRecords).toHaveLength(memberCount);
  expect(new Set(expected.restored.map(row => row.replicaGroupId)).size).toBe(memberCount);
  expect(new Set(expected.originalRecords.map(row => row.native.objectId)).size).toBe(memberCount);
  const account = edge.checks.find((check: { name: string }) => check.name === 'real-native-host-hello');
  expect(account).toBeDefined();
  // Read only the explicitly supplied, closed synthetic Edge working copy.
  const providers = expected.restored[0].providerRefs;
  const hostRegistryRoot = join(edgeRoot, 'host-appdata', 'Monica Extension', 'MDBX2');
  const { readdir } = await import('node:fs/promises');
  const vaults = await readdir(join(hostRegistryRoot, 'vaults'));
  expect(vaults).toHaveLength(1); expect(vaults[0]).toMatch(/^[0-9a-f-]{36}$/);
  const source = phase === 'prepare' ? join(hostRegistryRoot, 'vaults', vaults[0], 'vault.mdbx') : join(output, 'android-return.mdbx');
  const bytes = await readFile(source);
  if (phase === 'return') {
    const proof = JSON.parse(await readFile(join(output, 'restore-project-evidence.json'), 'utf8'));
    expect(proof.status).toBe('passed');
    if (mixed) {
      const build = JSON.parse(await readFile(join(output, 'build-evidence.json'), 'utf8'));
      expect(build.status).toBe('passed');
      expect(proof.installedApkSha256).toBe(build.builtAppApkSha256);
      expect(proof.installedTestApkSha256).toBe(build.builtTestApkSha256);
      expect(proof.baseline).toEqual(build.baseline);
      expect(proof.testSourceHashes).toEqual(build.testSourceHashes);
      const blobs = JSON.parse(await readFile(join(output, 'extension-blobs.json'), 'utf8')) as { path: string }[];
      expect(proof.inputs.map((entry: { name: string }) => entry.name).sort()).toEqual(['extension.mdbx', 'edge-restored-project-expected.json', ...blobs.map(blob => blob.path)].sort());
      for (const input of proof.inputs as { name: string; sha256: string }[]) expect(hash(await readFile(join(output, input.name)))).toBe(input.sha256);
    }
    for (const key of ['androidSourcesUnchanged', 'testSourcesUnchanged', 'installedApplicationUnchanged', 'installedTestApkUnchanged', 'deviceBootUnchanged']) expect(proof[key], key).toBe(true);
    expect(hash(bytes)).toBe(proof.outputs.find((file: { name: string }) => file.name === 'android-return.mdbx').sha256);
    for (const file of proof.outputs as { name: string; sha256: string }[]) {
      expect(file.name).toMatch(/^(android-return\.mdbx|restored-project-android-readback\.json|android-return-blobs\.json|android-return-blobs\/[a-f0-9]{64})$/);
      expect(hash(await readFile(join(output, file.name)))).toBe(file.sha256);
    }
  }
  const executable = resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
  const root = await mkdtemp(join(output, `restored-${phase}-host-`));
  if (mixed && phase === 'prepare') await cp(join(edgeRoot, 'host-appdata'), root, { recursive: true });
  const client = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, root));
  const evidence: Record<string, unknown> = { status: 'failed', phase, source, sourceSha256: hash(bytes), hostSha256: hash(await readFile(executable)), edgeRoot };
  try {
    let handle = vaults[0];
    if (!(mixed && phase === 'prepare')) {
      const transfer = await client.beginInboundTransfer(bytes.length, hash(bytes));
      for (let offset = 0; offset < bytes.length;) offset = (await client.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
      handle = (await client.finishInboundTransfer(transfer.transferId)).fileHandle;
    }
    const opened = await client.openVault({ kind: mixed && phase === 'prepare' ? 'vault' : 'file', handle }, { method: 'password', password: 'Synthetic transfer fixture password' });
    const binding = hash(`Synthetic restored project ${phase}`), state = await client.registerSyncState(opened.vaultHandle, binding);
    const prefix = phase === 'prepare' ? 'android-blobs' : 'android-return-blobs';
    const blobSource = phase === 'prepare' ? blobRoot : output;
    const manifest = JSON.parse(await readFile(join(blobSource, `${prefix}.json`), 'utf8')) as { path: string; blobId: string; sizeBytes: number }[];
    expect(new Set(manifest.map(blob => blob.blobId)).size).toBe(manifest.length);
    const encrypted = [];
    for (const blob of manifest) {
      expect(blob.blobId).toMatch(/^[a-f0-9]{64}$/); expect(blob.path).toBe(`${prefix}/${blob.blobId}`);
      const data = await readFile(join(blobSource, blob.path)); expect(hash(data)).toBe(blob.blobId); expect(data.length).toBe(blob.sizeBytes);
      const receive = await client.beginExternalBlobReceive(opened.vaultHandle, state.stateHandle, binding, blob.blobId, data.length);
      for (let offset = receive.nextOffset; offset < data.length;) {
        const end = Math.min(offset + 262144, data.length);
        offset = (await client.writeExternalBlobReceiveChunk(opened.vaultHandle, state.stateHandle, binding, blob.blobId, data.length,
          offset, data.subarray(offset, end), end === data.length)).nextOffset;
      }
      encrypted.push({ ...blob, data });
    }
    const native = await Promise.all(expected.originalRecords.map(record => client.revealObject(opened.vaultHandle, record.native.objectId)));
    const provider: ProviderAccount = { id: providers[0].providerId, kind: 'mdbx2', enabled: true, name: 'Synthetic returned project',
      isDefaultSaveTarget: false, config: { vaultHandle: opened.vaultHandle, nativeVaultId: opened.vaultId } };
    const projected = await new Mdbx2Provider(client).sync(provider, { localItems: [], now: new Date().toISOString() });
    const members = projected.items.filter((item): item is LoginItem => item.kind === 'login' && item.passwordGroupId === expected.restored[0].passwordGroupId && !item.deletedAt);
    expect(members).toHaveLength(memberCount);
    expect(members.map(row => row.replicaGroupId).sort()).toEqual(expected.restored.map(row => row.replicaGroupId).sort());
    const attachmentReader = mdbx2ProjectRemovalAttachments(client, provider, members);
    const attachments: { nativeId?: string; fileName: string; sizeBytes: number; sha256: string }[] = [];
    for (const member of members) {
      const listed = await attachmentReader.listAttachments(provider.id, member.id); expect(listed.nextCursor).toBeUndefined();
      for (const attachment of listed.items) attachments.push({ nativeId: member.replicaGroupId, fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes, sha256: await hashProviderAttachment(attachmentReader, provider.id, member.id,
          attachment.attachmentId, attachment.fileName, attachment.sizeBytes) });
    }
    attachments.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(attachments.length).toBeGreaterThan(0);
    if (phase === 'prepare') {
      for (const [index, original] of expected.originalRecords.entries()) {
        expect(native[index].payloadJson).toBe(original.native.payloadJson);
        expect(native[index].collectionId).toBe(original.native.collectionId); expect(native[index].deleted).toBe(false);
      }
      await writeFile(join(output, 'extension.mdbx'), bytes);
      await mkdir(join(output, 'extension-blobs'), { recursive: true });
      if (mixed) {
        // Include attachments created by the actual Edge restore fixture as well as bootstrap Blobs.
        encrypted.length = 0;
        let cursor: string | undefined;
        do {
          const page = await client.listExternalBlobs(opened.vaultHandle, state.stateHandle, binding, cursor);
          for (const blob of page.items) {
            expect(blob.state).toBe('available'); expect(blob.totalSize).toBeGreaterThan(0);
            const chunks: Buffer[] = []; let offset = 0;
            while (offset < blob.totalSize!) {
              const chunk = await client.readExternalBlob(opened.vaultHandle, state.stateHandle, binding, blob.blobId, blob.totalSize!, offset);
              expect(chunk.nextOffset).toBeGreaterThan(offset);
              chunks.push(Buffer.from(chunk.dataBase64, 'base64')); offset = chunk.nextOffset;
            }
            const data = Buffer.concat(chunks); expect(hash(data)).toBe(blob.blobId); expect(data.length).toBe(blob.totalSize);
            encrypted.push({ blobId: blob.blobId, sizeBytes: data.length, path: `extension-blobs/${blob.blobId}`, data });
          }
          cursor = page.nextCursor;
        } while (cursor);
      }
      for (const blob of encrypted) await writeFile(join(output, 'extension-blobs', blob.blobId), blob.data);
      await writeFile(join(output, 'extension-blobs.json'), JSON.stringify(encrypted.map(({ blobId, sizeBytes }) => ({ blobId, sizeBytes, path: `extension-blobs/${blobId}` })), null, 2));
      await writeFile(join(output, 'edge-restored-project-expected.json'), JSON.stringify(expected, null, 2));
      await writeFile(join(output, 'restored-project-attachments.json'), JSON.stringify(attachments, null, 2));
      Object.assign(evidence, { status: 'passed', nativeRows: native.length, encryptedBlobs: encrypted.length, attachments,
        layer: 'Actual closed Edge Native vault + original Android encrypted Blob files, independently reopened and plaintext hashes checked; no single-file export claim' });
    } else {
      const report = JSON.parse(await readFile(join(output, 'restored-project-android-readback.json'), 'utf8'));
      expect(report.status).toBe('passed'); expect(report.members).toHaveLength(memberCount);
      const beforeAttachments = JSON.parse(await readFile(join(output, 'restored-project-attachments.json'), 'utf8'));
      const sorted = (rows: typeof attachments) => rows.map(row => [row.nativeId, row.fileName, row.sizeBytes, row.sha256]).sort();
      expect(sorted(attachments)).toEqual(sorted(beforeAttachments));
      expect(sorted(report.attachmentsBefore)).toEqual(sorted(beforeAttachments)); expect(sorted(report.attachmentsAfter)).toEqual(sorted(beforeAttachments));
      for (const [index, original] of expected.originalRecords.entries()) {
        const current = native[index]; expect(current.objectId).toBe(original.native.objectId); expect(current.deleted).toBe(false);
        expect(current.collectionId).toBe(original.native.collectionId);
        const old = parseLosslessJson(original.native.payloadJson) as Record<string, unknown>, updated = parseLosslessJson(current.payloadJson) as Record<string, unknown>;
        if (original.original.replicaGroupId === report.editedNativeId) {
          expect(updated.notes).toBe(report.returnedNote);
          expect(updated.monica_password_encoding).toBe('plaintext-v1');
          // Android omits empty bindings/SSO fields when rebuilding PASSWORD JSON.
          // Folder membership is authoritative on the native object. Permit only
          // these proven empty/redundant inputs, never drop populated values.
          const omitted: Record<string, unknown> = { category_id: null, bound_note_entry_id: null, bound_note_room_id: null,
            sso_provider: '', sso_ref_entry_id: null, sso_ref_logical_id: null, mdbx_folder_id: original.native.collectionId };
          const normalized: Record<string, unknown> = { ...old, monica_password_encoding: 'plaintext-v1' };
          const actualOmissions: string[] = [];
          for (const [key, value] of Object.entries(omitted)) if (Object.hasOwn(old, key) && !Object.hasOwn(updated, key)) {
            expect(old[key], key).toBe(value); Reflect.deleteProperty(normalized, key); actualOmissions.push(key);
          }
          expect({ ...updated, notes: old.notes, room_id: old.room_id }).toEqual(normalized);
          evidence.androidEncodingOmissions = actualOmissions;
        } else expect(current.payloadJson).toBe(original.native.payloadJson);
        const member = members.find(row => row.replicaGroupId === original.original.replicaGroupId)!;
        expect(member.password).toBe(original.original.password); expect(member.customFields).toEqual(original.original.customFields);
      }
      Object.assign(evidence, { status: 'passed', nativeRows: native.length, encryptedBlobs: encrypted.length, attachments,
        exactUneditedPayloads: true, editedPayloadOnlyNotesRoomProjectionIdPlaintextMarkerAndVerifiedEmptyEncodingChanged: true,
        layer: 'Current Android app import/projection/edit/export → independent extension Native readback including all original attachment plaintext hashes' });
    }
    expect(hash(await readFile(source))).toBe(hash(bytes));
  } catch (error) { evidence.error = String(error); throw error; }
  finally { client.close(); await writeFile(join(output, `restored-project-${phase}-evidence.json`), JSON.stringify(evidence, null, 2)); }
});
