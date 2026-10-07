import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Mdbx2NativeClient } from '../../src/providers/mdbx2/native-client';
import { mdbx2TransferOperationScope } from '../../src/providers/mdbx2/mdbx2-transfer-identity';
import type { Mdbx2ObjectMutationInput, Mdbx2ObjectWriteResult } from '../../src/providers/mdbx2/native-contract';
import { ProcessNativeRuntime } from './mdbx2-interop-support';

const input = process.env.MONICA_317_REMOVAL_NATIVE_INPUT, output = process.env.MONICA_317_REMOVAL_NATIVE_OUTPUT;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
it.skipIf(!input || !output)('actual Native process guards a project delete against attachment revisions and recovers after process restart', async () => {
  if (!input || !output) throw new Error('Explicit synthetic bootstrap and output required');
  await mkdir(output, { recursive: true });
  const hostRoot = await mkdtemp(join(output, 'host-')), executable = resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
  const connect = () => new Mdbx2NativeClient(new ProcessNativeRuntime(executable, hostRoot));
  const credential = { method: 'password' as const, password: 'Synthetic transfer fixture password' };
  let client = connect();
  const evidence: Record<string, unknown> = { status: 'failed', scope: 'Actual Native process and vendored engine, isolated synthetic password/attachment rows; no browser UI or fresh Android run',
    executable, hostSha256: hash(await readFile(executable)), hostRoot, input, inputSha256: hash(await readFile(input)) };
  try {
    evidence.capabilities = await client.hello();
    const bytes = await readFile(input), incoming = await client.beginInboundTransfer(bytes.length, hash(bytes));
    for (let offset = 0; offset < bytes.length;) offset = (await client.sendInboundChunk(incoming.transferId, offset, bytes.subarray(offset, offset + incoming.maxChunkBytes))).nextOffset;
    const file = await client.finishInboundTransfer(incoming.transferId), vault = await client.openVault({ kind: 'file', handle: file.fileHandle }, credential);
    const handle = vault.vaultHandle, collectionId = randomUUID();
    await client.createCollection(handle, randomUUID(), collectionId, 'Synthetic project removal');
    const rows: Mdbx2ObjectWriteResult[] = [];
    for (let n = 0; n < 3; n++) {
      const logicalObjectId = `password:${randomUUID()}`;
      rows.push(await client.upsertObject(handle, randomUUID(), { logicalObjectId, collectionId, objectTypeId: 'login', title: `Synthetic ${n}`,
        payloadJson: JSON.stringify({ monica_entry_id: logicalObjectId, password_plain: `synthetic-${n}`, notes: '  shared\r\n0007  ' }).replace(/}$/, ',"future":9007199254740993}') }));
    }
    const [source, second, target] = rows, sourceAttachment = randomUUID(), targetAttachment = randomUUID();
    const originalBytes = new TextEncoder().encode(' shared file\r\n0007 ');
    const upload = async (row: Mdbx2ObjectWriteResult, attachmentId: string, bytes: Uint8Array, mode: 'create' | 'replace') => {
      const transfer = await client.beginAttachmentUpload(handle, { operationId: randomUUID(), attachmentId, collectionId, objectId: row.objectId,
        fileName: 'shared.txt', mediaType: 'text/plain', sizeBytes: bytes.length, sha256: hash(bytes), mode });
      try { await client.sendAttachmentUploadChunk(transfer.transferId, 0, bytes); await client.finishAttachmentUpload(transfer.transferId); }
      finally { await client.abortAttachmentUpload(transfer.transferId); }
    };
    const readHash = async (attachmentId: string) => {
      const read = await client.beginAttachmentRead(handle, attachmentId), digest = createHash('sha256');
      try { for (let offset = 0; offset < read.sizeBytes;) {
        const part = await client.readAttachmentChunk(read.readHandle, offset); digest.update(Buffer.from(part.dataBase64, 'base64')); offset = part.nextOffset;
      } return digest.digest('hex'); } finally { await client.releaseAttachmentRead(read.readHandle); }
    };
    await upload(source, sourceAttachment, originalBytes, 'create'); await upload(target, targetAttachment, originalBytes, 'create');
    const originalRows = await Promise.all(rows.map(row => client.revealObject(handle, row.objectId)));
    const revision = await client.readWriteRevision(handle);
    expect(await readHash(sourceAttachment)).toBe(await readHash(targetAttachment));
    const changedBytes = originalBytes.slice(); changedBytes[0] ^= 1;
    await upload(target, targetAttachment, changedBytes, 'replace');
    expect(await client.revealObject(handle, target.objectId)).toEqual(originalRows[2]);
    const mutations: Mdbx2ObjectMutationInput[] = [source, second].map(row => ({ kind: 'delete', logicalObjectId: `native:${row.objectId}`, expectedHeadCommitId: row.commitId }));
    const oldScope = await mdbx2TransferOperationScope({ purpose: 'project-removal-test', revision, mutations });
    await expect(client.mutateObjects(handle, oldScope, mutations, 120_000, revision)).rejects.toMatchObject({ code: 'vault-revision-conflict' });
    expect(await Promise.all(rows.map(row => client.revealObject(handle, row.objectId)))).toEqual(originalRows);
    await upload(target, targetAttachment, originalBytes, 'replace');
    const verified = await client.readWriteRevision(handle);
    expect(await readHash(sourceAttachment)).toBe(hash(originalBytes)); expect(await readHash(targetAttachment)).toBe(hash(originalBytes));
    expect(await client.readWriteRevision(handle)).toEqual(verified);
    const scope = await mdbx2TransferOperationScope({ purpose: 'project-removal-test', revision: verified, mutations });
    await writeFile(join(output, 'guarded-request.json'), JSON.stringify({ handle, scope, mutations, verified }, null, 2));
    // The delete really commits, then its response is intentionally discarded.
    await client.mutateObjects(handle, scope, mutations, 120_000, verified);
    client.close(); client = connect();
    await client.openVault({ kind: 'vault', handle }, credential);
    const resolution = await client.resolveObjectOperation(handle, scope);
    expect(resolution.known && resolution.committed).toBe(true);
    const retry = await client.mutateObjects(handle, scope, mutations, 120_000, verified);
    expect(retry.alreadyCommitted).toBe(true);
    if (resolution.known && resolution.committed) expect(retry.commitId).toBe(resolution.commitId);
    expect(await client.revealObject(handle, target.objectId)).toEqual(originalRows[2]); expect(await readHash(targetAttachment)).toBe(hash(originalBytes));
    const deleted = await client.listObjects(handle, collectionId, { deleted: true });
    expect(deleted.items.map(row => row.objectId).sort()).toEqual([source.objectId, second.objectId].sort());
    expect(deleted.items.every(row => row.headCommitId === retry.commitId)).toBe(true);
    expect(hash(await readFile(input))).toBe(evidence.inputSha256);
    Object.assign(evidence, { status: 'passed', attachmentOnlyChangeLeavesObjectUnchanged: true, staleRevisionZeroObjectWrites: true,
      guardedDeleteSharesOneCommit: true, discardedResponseRecoveredAfterProcessRestart: true, targetPayloadAndAttachmentExact: true,
      deletedObjectIds: deleted.items.map(row => row.objectId), commitId: retry.commitId, attachmentSha256: hash(originalBytes) });
  } catch (error) { evidence.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { client.close(); await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
});
