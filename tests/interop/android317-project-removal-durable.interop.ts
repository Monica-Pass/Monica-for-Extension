import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../src/core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../src/core/project-credentials';
import { Mdbx2NativeClient } from '../../src/providers/mdbx2/native-client';
import { Mdbx2Provider } from '../../src/providers/mdbx2/mdbx2-provider';
import { Mdbx2PasswordProjectRemovalCoordinator } from '../../src/providers/mdbx2/mdbx2-project-removal';
import { Mdbx2RestoreCoordinator } from '../../src/providers/mdbx2/mdbx2-restore';
import { Mdbx2RestoreBatchCoordinator } from '../../src/providers/mdbx2/mdbx2-restore-batch';
import type { Mdbx2RestoreBatchRequest } from '../../src/core/mdbx2-restore-batch-journal';
import { projectRestoreRequest } from '../../src/manager/project-restore';
import { mdbx2ProjectRemovalAttachments } from '../../src/providers/mdbx2/mdbx2-project-removal-attachments';
import { hashProviderAttachment } from '../../src/providers/attachments/attachment-transfer';
import { SecureVaultService } from '../../src/security/secure-vault-service';
import { MemoryVaultSessionStore } from '../../src/security/vault-session';
import type { VaultEnvelope } from '../../src/security/vault-crypto';
import type { VaultEnvelopeStorage } from '../../src/security/vault-storage';
import { ProcessNativeRuntime } from './mdbx2-interop-support';

const input = process.env.MONICA_317_REMOVAL_NATIVE_INPUT, output = process.env.MONICA_317_REMOVAL_NATIVE_OUTPUT;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it.skipIf(!input || !output).each(['complete','remote-delete','revision-race'] as const)('cancels an entire unsynchronized project deletion atomically: %s',async mode=>{
  const f=await fixture(`group-cancellation-${mode}-`,false);let failure:unknown;
  try {
    const originals=await Promise.all(f.rows.map(row=>f.client.revealObject(f.handle,row.providerRefs[0].remoteId!)));
    const revision=await f.client.readWriteRevision(f.handle);
    await f.local.deletePasswordGroup(f.rows[0].id,Object.fromEntries(f.rows.map(row=>[row.id,row.updatedAt])));
    const deleted=(await f.local.listDeletedItems()).filter((row):row is LoginItem=>row.kind==='login'&&row.passwordGroupId===f.rows[0].passwordGroupId);
    const request=projectRestoreRequest(deleted,deleted[0].id);
    const before=await f.local.readState();
    const nativeRestore=vi.spyOn(f.client,'restoreObjects');
    if(mode==='complete') {
      f.storage.failNext=true;
      await expect(new Mdbx2RestoreBatchCoordinator(f.client,f.local).restoreProject(request.anchorItemId,request)).rejects.toThrow('Synthetic encrypted save failure');
      expect(await f.local.readState()).toEqual(before);
      expect(await f.client.readWriteRevision(f.handle)).toEqual(revision);
      expect(nativeRestore).not.toHaveBeenCalled();
      await f.restart();
      const coordinator=new Mdbx2RestoreBatchCoordinator(f.client,f.local), spy=vi.spyOn(f.client,'restoreObjects');
      const restored=await coordinator.restoreProject(request.anchorItemId,request);
      expect(restored).toHaveLength(3);expect(restored.every(row=>!row.deletedAt)).toBe(true);
      expect((await f.local.readState()).mutationQueue).toEqual([]);
      expect(await f.client.readWriteRevision(f.handle)).toEqual(revision);
      for(const original of originals)expect(await f.client.revealObject(f.handle,original.objectId)).toEqual(original);
      const attachments=mdbx2ProjectRemovalAttachments(f.client,f.account,restored.filter((row):row is LoginItem=>row.kind==='login'));
      const attached=restored.find(row=>row.id===f.rows[0].id)!;
      const [attachment]=(await attachments.listAttachments(f.account.id,attached.id)).items;
      expect(await hashProviderAttachment(attachments,f.account.id,attached.id,attachment.attachmentId,attachment.fileName,attachment.sizeBytes)).toBe(hash(f.fileBytes));
      await f.local.deleteItem(restored[0].id);const later=await f.local.readState();
      await coordinator.restoreProject(request.anchorItemId,request);await coordinator.resume(request.operationId);
      expect(await f.local.readState()).toEqual(later);expect(spy).not.toHaveBeenCalled();
      await expect(coordinator.restoreProject(request.anchorItemId,{...request,expected:{...request.expected,[request.anchorItemId]:'2026-01-01T00:00:00Z'}})).rejects.toThrow('原请求');
      Object.assign(f.evidence,{status:'passed',allThreeDeletedLocallyThenCancelled:true,noNativeCommit:true,exactOriginalHeadsAndPayloads:true,attachmentSha256:hash(f.fileBytes),failedSaveAndRestart:true,terminalReplayPreservesLaterDeletion:true});
    } else {
      if(mode==='remote-delete')await f.client.deleteObject(f.handle,randomUUID(),`native:${originals[2].objectId}`,originals[2].headCommitId);
      else {
        const read=f.client.readWriteRevision.bind(f.client);let calls=0;
        vi.spyOn(f.client,'readWriteRevision').mockImplementation(async handle=>{
          if(++calls===2){const logical=`note:${randomUUID()}`;await f.client.upsertObject(f.handle,randomUUID(),{logicalObjectId:logical,collectionId:originals[0].collectionId,objectTypeId:'note',title:'Synthetic revision race',payloadJson:JSON.stringify({monica_entry_id:logical,kind:'note',notes:'independent'})});}
          return read(handle);
        });
      }
      await expect(new Mdbx2RestoreBatchCoordinator(f.client,f.local).restoreProject(request.anchorItemId,request)).rejects.toThrow();
      expect(await f.local.readState()).toEqual(before);expect(nativeRestore).not.toHaveBeenCalled();
      expect(await f.local.readMdbx2DeletionCancellations()).toEqual([]);
      Object.assign(f.evidence,{status:'passed',race:mode,allLocalTombstonesAndQueueRetained:true,noNativeRestoreSent:true});
    }
  }catch(error){failure=error;throw error;}finally{await f.close(failure);}
});
const credential = { method: 'password' as const, password: 'Synthetic transfer fixture password' };

it.skipIf(!input || !output).each(['complete', 'later-deleted', 'later-active', 'later-new', 'remote-active-change', 'stale-revision', 'edge-fixture'] as const)(
  'restores a partially acknowledged whole-project deletion with unpublished members: %s', async mode => {
    const f = await fixture(`mixed-restore-${mode}-`, false); let failure: unknown;
    try {
      const originals = await Promise.all(f.rows.map(row => f.client.revealObject(f.handle, row.providerRefs[0].remoteId!)));
      const added = await f.local.upsertItem({ ...f.rows[2], id: randomUUID(), replicaGroupId: undefined, providerRefs: [{ providerId: f.account.id }],
        password: 'synthetic-unpublished-secret', customFields: f.rows[2].customFields.map(field => field.name === PROJECT_CREDENTIAL_FIELD ? {
          ...field, value: field.value.replace(/"passwordId":"[^"]+"/, `"passwordId":"${randomUUID()}"`).replace(/"passwordOrder":2/, '"passwordOrder":3') } : field) });
      const active = (await f.local.listItems()).filter(row => row.kind === 'login' && row.passwordGroupId === f.rows[0].passwordGroupId);
      expect(active).toHaveLength(4);
      await f.local.deletePasswordGroup(active[0].id, Object.fromEntries(active.map(row => [row.id, row.updatedAt])));
      const state = await f.local.readState(), first = f.rows[0];
      const deletion = await f.client.deleteObject(f.handle, randomUUID(), `native:${originals[0].objectId}`, originals[0].headCommitId);
      const mutation = state.mutationQueue.find(row => row.itemId === first.id)!;
      // Deliver exactly one actual native acknowledgement; the other writes were not sent.
      const projected = state.items.map(row => row.id === first.id ? { ...row,
        providerRefs: row.providerRefs.map(ref => ({ ...ref, revision: deletion.commitId })) } : row);
      const applied = await f.local.applyProviderSync(f.account.id, projected, undefined, [], undefined, state.items,
        [{ mutationId: mutation.id, itemId: first.id, operation: 'delete', remoteId: originals[0].objectId }],
        [], false, state.mutationQueue.filter(row => row.id !== mutation.id).map(row => row.id));
      expect(applied.conflicts).toBe(0);
      const deleted = (await f.local.listDeletedItems()).filter((row): row is LoginItem => row.kind === 'login' && row.passwordGroupId === first.passwordGroupId);
      const request = projectRestoreRequest(deleted, added.id);
      const before = await f.local.readState();
      expect(before.mutationQueue.filter(row => row.itemId === first.id)).toEqual([]);
      if (mode === 'edge-fixture') {
        const backup = join(f.root, 'mixed-restore-backup.json');
        await writeFile(backup, JSON.stringify(await f.local.exportEncryptedBackup('Synthetic-Edge-315-fixture-password')));
        await f.client.lockVault(f.handle);
        await writeFile(join(f.root, 'mixed-restore-fixture.json'), JSON.stringify({ synthetic: true, kind: 'mixed-restore', appData: f.root,
          backup, providerId: f.account.id, request, sources: deleted, originals, addedId: added.id, attachmentSha256: hash(f.fileBytes) }, null, 2));
        Object.assign(f.evidence, { status: 'passed', layer: 'Actual partial native acknowledgement plus encrypted backup prepared for separate Edge UI acceptance',
          fixture: join(f.root, 'mixed-restore-fixture.json'), cachedMembers: deleted.length });
        return;
      }
      const dispatch = vi.spyOn(f.client, 'restoreObjects');
      f.storage.failNext = true;
      await expect(new Mdbx2RestoreBatchCoordinator(f.client, f.local).restoreProject(added.id, request)).rejects.toThrow('Synthetic encrypted save failure');
      expect(await f.local.readState()).toEqual(before); expect(dispatch).not.toHaveBeenCalled(); dispatch.mockRestore();
      const stop = vi.spyOn(f.client, 'restoreObjects').mockRejectedValue(new Error('Synthetic mixed restore interruption'));
      await expect(new Mdbx2RestoreBatchCoordinator(f.client, f.local).restoreProject(added.id, request)).rejects.toThrow('Synthetic mixed restore interruption');
      stop.mockRestore();
      const [saved] = await f.local.readMdbx2RestoreBatches();
      expect(saved.members).toHaveLength(1); expect(saved.cancellation!.sources).toHaveLength(4);
      expect((await f.local.readState()).mutationQueue).toEqual([]);
      expect((await f.local.readState()).items).toEqual(before.items);
      if (mode === 'remote-active-change') {
        const original = originals[1];
        await f.client.upsertObject(f.handle, randomUUID(), { logicalObjectId: `native:${original.objectId}`, collectionId: original.collectionId,
          objectTypeId: 'login', title: 'Concurrent native edit', payloadJson: original.payloadJson, expectedHeadCommitId: original.headCommitId });
        const envelope = await readFile(f.storage.path, 'utf8');
        await f.restart();
        await expect(new Mdbx2RestoreBatchCoordinator(f.client, f.local).resume(saved.id)).rejects.toThrow('变化');
        expect(await readFile(f.storage.path, 'utf8')).toBe(envelope);
        expect((await f.client.resolveObjectOperation(f.handle, saved.operationScope)).committed).toBe(false);
        Object.assign(f.evidence, { status: 'passed', mixedRetainedRemoteEditRefused: true, fullLocalCohortAndJournalKept: true });
        return;
      }
      if (mode === 'stale-revision') {
        const logicalObjectId = `note:${randomUUID()}`;
        await f.client.upsertObject(f.handle, randomUUID(), { logicalObjectId, collectionId: originals[0].collectionId, objectTypeId: 'note',
          title: 'Unrelated revision', payloadJson: JSON.stringify({ monica_entry_id: logicalObjectId, kind: 'note', notes: 'unrelated' }) });
        f.storage.failNext = true;
        await expect(new Mdbx2RestoreBatchCoordinator(f.client, f.local).resume(saved.id)).rejects.toThrow('Synthetic encrypted save failure');
        expect((await f.local.readMdbx2RestoreBatches())[0]).toEqual(saved);
      }
      await f.restart();
      const send = f.client.restoreObjects.bind(f.client); let commit = '';
      vi.spyOn(f.client, 'restoreObjects').mockImplementation(async (...args) => {
        expect(args[2].objects).toHaveLength(1);
        const result = await send(...args); commit = result.commitId;
        vi.spyOn(f.client, 'resolveObjectOperation').mockRejectedValue(new Error('Synthetic committed mixed response lost'));
        f.client.close(); throw new Error('Synthetic committed mixed response lost');
      });
      await expect(new Mdbx2RestoreBatchCoordinator(f.client, f.local).resume(saved.id)).rejects.toThrow('Synthetic committed mixed response lost');
      expect(commit).not.toBe(''); await f.restart();
      const laterId = mode === 'later-deleted' ? first.id : mode === 'later-active' ? f.rows[1].id : mode === 'later-new' ? added.id : undefined;
      if (laterId) await f.local.deleteItem(laterId);
      const later = await f.local.readState();
      f.storage.failNext = true;
      await expect(new Mdbx2RestoreBatchCoordinator(f.client, f.local).resume(saved.id)).rejects.toThrow('Synthetic encrypted save failure');
      expect(await f.local.readState()).toEqual(later);
      const restored = await new Mdbx2RestoreBatchCoordinator(f.client, f.local).restoreProject(added.id, request);
      expect(restored).toHaveLength(4);
      expect(restored.filter(row => row.deletedAt).map(row => row.id)).toEqual(laterId ? [laterId] : []);
      for (const original of originals) {
        const native = await f.client.revealObject(f.handle, original.objectId);
        expect({ ...native, headCommitId: original.headCommitId }).toEqual(original);
        expect(native.headCommitId).toBe(original.objectId === originals[0].objectId ? commit : original.headCommitId);
      }
      const backend = mdbx2ProjectRemovalAttachments(f.client, f.account, restored.filter((row): row is LoginItem => row.kind === 'login'));
      const [attachment] = (await backend.listAttachments(f.account.id, first.id)).items;
      expect(await hashProviderAttachment(backend, f.account.id, first.id, attachment.attachmentId, attachment.fileName, attachment.sizeBytes)).toBe(hash(f.fileBytes));
      const final = await f.local.readState();
      expect(final.mutationQueue.filter(row => row.itemId === added.id)).toMatchObject([{ operation: laterId === added.id ? 'delete' : 'create' }]);
      if (laterId) expect(final.mutationQueue).toEqual(expect.arrayContaining(later.mutationQueue));
      const rowById = new Map(restored.map(row => [row.id, row]));
      for (const source of deleted) {
        const row = rowById.get(source.id)!;
        expect({ ...row, updatedAt: source.updatedAt, deletedAt: source.deletedAt, providerRefs: source.providerRefs }).toEqual(source);
      }
      await f.local.deleteItem(f.rows[2].id); const newest = await f.local.readState();
      await new Mdbx2RestoreBatchCoordinator(f.client, f.local).resume(saved.id);
      expect(await f.local.readState()).toEqual(newest);
      Object.assign(f.evidence, { status: 'passed', mode, nativeSubsetRestoredAtomically: 1, completeCachedCohort: 4,
        keptActiveHeadsUnchanged: true, unpublishedCreateRetained: laterId !== added.id, stagingAndAckFailuresRecovered: true,
        lostNativeResponseAndProcessRestart: true, allRichFieldsAndOriginalAttachmentExact: true, completedReplayPreservesLaterDeletion: true });
    } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
  });
const secret = 'Synthetic durable removal envelope password';
class DiskStorage implements VaultEnvelopeStorage {
  failNext = false;
  constructor(readonly path: string) {}
  async read(): Promise<VaultEnvelope | null> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async write(envelope: VaultEnvelope) {
    if (this.failNext) { this.failNext = false; throw new Error('Synthetic encrypted save failure'); }
    await writeFile(this.path, JSON.stringify(envelope));
  }
  async clear() { throw new Error('Evidence must be preserved'); }
}

async function fixture(label: string, stageRemoval = true) {
  if (!input || !output) throw new Error('Explicit synthetic input and output required');
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, label)), executable = resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
  const connect = () => new Mdbx2NativeClient(new ProcessNativeRuntime(executable, root));
  let client = connect();
  const storage = new DiskStorage(join(root, 'encrypted-local-vault.json'));
  let local = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const evidence: Record<string, unknown> = { status: 'failed', root, executable, hostSha256: hash(await readFile(executable)),
    inputSha256: hash(await readFile(input)), scope: 'Actual Native process + Mdbx2Provider + deletion coordinator + disk encrypted envelope. Synthetic bootstrap; no Edge or fresh Android app run.' };
  try {
    const bytes = await readFile(input), transfer = await client.beginInboundTransfer(bytes.length, hash(bytes));
    for (let offset = 0; offset < bytes.length;) offset = (await client.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
    const file = await client.finishInboundTransfer(transfer.transferId);
    const opened = await client.openVault({ kind: 'file', handle: file.fileHandle }, credential);
    const handle = opened.vaultHandle;
    const account: ProviderAccount = { id: 'removal-native', kind: 'mdbx2', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
      config: { vaultHandle: handle, nativeVaultId: opened.vaultId } };
    const provider = new Mdbx2Provider(client), group = randomUUID(), credentialGroup = randomUUID();
    const seeded: LoginItem[] = [];
    for (let n = 0; n < 3; n++) {
      const row: LoginItem = { ...createLoginItem({ title: 'Synthetic rich project', username: 'shared-account', password: `synthetic-secret-${n}` }),
        notes: '  exact notes\r\n0007  ', email: 'synthetic@example.invalid', phone: '001020', passwordGroupId: group,
        providerRefs: [{ providerId: account.id }], customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true,
          value: JSON.stringify({ version: 1, projectId: group, groupId: credentialGroup, passwordId: randomUUID(), primary: true,
            label: 'Original', groupOrder: 0, passwordOrder: n }).replace(/}$/, ',"future":9007199254740993}') }] };
      if (!n) row.customFields.push({ name: 'Shared custom', value: ' 0000123\r\nsecret ', protected: true });
      seeded.push(await provider.create(account, row) as LoginItem);
    }
    await local.setup(secret); await local.upsertProvider(account);
    const first = await provider.sync(account, { localItems: [], now: new Date().toISOString() });
    await local.applyProviderSync(account.id, first.items);
    const rows = (await local.listItems()).filter((row): row is LoginItem => row.kind === 'login' && row.passwordGroupId === group)
      .sort((a, b) => a.password.localeCompare(b.password));
    expect(rows).toHaveLength(3);
    const attachmentId = randomUUID(), fileBytes = new TextEncoder().encode(' shared document\r\n0007 ');
    const upload = async (row: LoginItem, attachment: string, content: Uint8Array, mode: 'create' | 'replace') => {
      const ref = row.providerRefs.find(ref => ref.providerId === account.id)!;
      const started = await client.beginAttachmentUpload(handle, { operationId: randomUUID(), attachmentId: attachment,
        objectId: ref.remoteId!, collectionId: ref.remoteFolderId!, fileName: 'shared.txt', mediaType: 'text/plain', sizeBytes: content.length,
        sha256: hash(content), mode });
      try { await client.sendAttachmentUploadChunk(started.transferId, 0, content); await client.finishAttachmentUpload(started.transferId); }
      finally { await client.abortAttachmentUpload(started.transferId); }
    };
    await upload(rows[0], attachmentId, fileBytes, 'create');
    const operationId = randomUUID();
    if (stageRemoval) await local.stagePasswordProjectRemoval({ operationId, items: rows, expected: Object.fromEntries(rows.map(row => [row.id, row.updatedAt])),
      removedItemIds: rows.slice(0, 2).map(row => row.id) });
    const restart = async () => {
      await local.lock(); client.close(); client = connect();
      await client.openVault({ kind: 'vault', handle }, credential);
      local = new SecureVaultService(storage, new MemoryVaultSessionStore()); await local.unlock(secret);
    };
    return { root, handle, account, rows, operationId, storage, fileBytes, upload, restart, evidence,
      get client() { return client; }, get local() { return local; },
      run: () => new Mdbx2PasswordProjectRemovalCoordinator(client, local).resume(operationId),
      async close(error?: unknown) {
        client.close(); if (error) evidence.error = error instanceof Error ? error.message : String(error);
        await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
      }
    };
  } catch (error) { client.close(); evidence.error = String(error); await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); throw error; }
}

it.skipIf(!input || !output).each(['response-loss', 'redelete', 'stale-revision', 'remote-member-change', 'new-remote-member'] as const)(
  'actual atomic group restoration preserves native identities and durable recovery: %s', async scenario => {
    const f = await fixture(`batch-restore-${scenario}-`, false); let failure: unknown;
    try {
      const originals = await Promise.all(f.rows.map(row => f.client.revealObject(f.handle, row.providerRefs[0].remoteId!)));
      const synchronize = async () => {
        const state = await f.local.readState();
        const result = await new Mdbx2Provider(f.client).sync(f.account, { localItems: state.items, pendingMutations: state.mutationQueue,
          mdbx2RestoreBatches: state.mdbx2RestoreBatches, now: new Date().toISOString() });
        expect(result.conflicts).toEqual([]);
        await f.local.applyProviderSync(f.account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, state.items);
      };
      let request: Mdbx2RestoreBatchRequest;
      const run = () => new Mdbx2RestoreBatchCoordinator(f.client, f.local).restoreProject(f.rows[0].id, request);
      await f.local.deletePasswordGroup(f.rows[0].id, Object.fromEntries(f.rows.map(row => [row.id, row.updatedAt])));
      await synchronize();
      const tombstones = (await f.local.listDeletedItems()).filter(row => f.rows.some(original => original.id === row.id));
      expect(tombstones).toHaveLength(3);
      request = { operationId: randomUUID(), anchorItemId: f.rows[0].id, providerId: f.account.id, deletedAt: tombstones[0].deletedAt!,
        expected: Object.fromEntries(tombstones.map(row => [row.id, row.updatedAt])) };
      const writes = vi.spyOn(f.client, 'restoreObjects');
      f.storage.failNext = true;
      await expect(run()).rejects.toThrow('Synthetic encrypted save failure');
      expect(writes).not.toHaveBeenCalled(); expect(await f.local.readMdbx2RestoreBatches()).toEqual([]);
      writes.mockRestore();
      const stop = vi.spyOn(f.client, 'restoreObjects').mockRejectedValue(new Error('Synthetic stop before atomic restore'));
      await expect(run()).rejects.toThrow('Synthetic stop before atomic restore'); stop.mockRestore();
      const [saved] = await f.local.readMdbx2RestoreBatches(); expect(saved.members).toHaveLength(3);
      const nativeBefore = await f.client.listObjects(f.handle, saved.members[0].intent.collectionId, { deleted: true });
      expect(nativeBefore.items.filter(row => originals.some(item => item.objectId === row.objectId))).toHaveLength(3);
      let restoreCommit: string | undefined;
      if (scenario === 'stale-revision') {
        const logicalObjectId = `note:${randomUUID()}`;
        await f.client.upsertObject(f.handle, randomUUID(), { logicalObjectId, collectionId: saved.members[0].intent.collectionId,
          objectTypeId: 'note', title: 'Synthetic interleave', payloadJson: JSON.stringify({ monica_entry_id: logicalObjectId, kind: 'note', notes: 'later' }) });
        const before = await readFile(f.storage.path, 'utf8'); f.storage.failNext = true;
        const noWrite = vi.spyOn(f.client, 'restoreObjects');
        await expect(run()).rejects.toThrow('Synthetic encrypted save failure'); expect(noWrite).not.toHaveBeenCalled(); noWrite.mockRestore();
        expect(await readFile(f.storage.path, 'utf8')).toBe(before);
        expect((await f.client.resolveObjectOperation(f.handle, saved.operationScope)).committed).toBe(false);
        await f.restart(); await run();
        const [completed] = await f.local.readMdbx2RestoreBatches();
        expect(completed.operationScope).not.toBe(saved.operationScope); restoreCommit = completed.receipt!.commitId;
      } else if (scenario === 'remote-member-change' || scenario === 'new-remote-member') {
        const member = saved.members[1];
        if (scenario === 'remote-member-change')
          await f.client.restoreObject(f.handle, 'f'.repeat(64), { ...member.intent, writeRevision: await f.client.readWriteRevision(f.handle) });
        else {
          const logicalObjectId = `password:${randomUUID()}`;
          const payload = { ...JSON.parse(originals[0].payloadJson), monica_entry_id: logicalObjectId };
          const created = await f.client.upsertObject(f.handle, randomUUID(), { logicalObjectId, objectTypeId: 'login',
            collectionId: member.intent.collectionId, title: 'New remote member', payloadJson: JSON.stringify(payload) });
          expect(originals.some(row => row.objectId === created.objectId)).toBe(false);
        }
        const before = await readFile(f.storage.path, 'utf8'), noWrite = vi.spyOn(f.client, 'restoreObjects');
        await expect(run()).rejects.toThrow('已变化'); expect(noWrite).not.toHaveBeenCalled();
        expect(await readFile(f.storage.path, 'utf8')).toBe(before);
        const after = await f.client.listObjects(f.handle, member.intent.collectionId, { deleted: true });
        expect(after.items.filter(row => originals.some(item => item.objectId === row.objectId))).toHaveLength(scenario === 'remote-member-change' ? 2 : 3);
        expect((await f.local.listDeletedItems()).filter(row => f.rows.some(original => original.id === row.id))).toHaveLength(3);
        Object.assign(f.evidence, { status: 'passed', scope: 'Actual Native batch restore refused after another client restored or added a member; cached snapshot and remaining tombstones retained',
          scenario, noPartialRestore: true, durableIntentRetained: true });
        return;
      } else {
        const restore = f.client.restoreObjects.bind(f.client);
        vi.spyOn(f.client, 'restoreObjects').mockImplementationOnce(async (...args) => {
          const result = await restore(...args); restoreCommit = result.commitId;
          vi.spyOn(f.client, 'resolveObjectOperation').mockRejectedValue(new Error('Synthetic batch connection lost'));
          f.client.close(); throw new Error('Synthetic atomic restore response lost');
        });
        await expect(run()).rejects.toThrow('Synthetic batch connection lost'); expect(restoreCommit).toBeTruthy();
        await f.restart();
        if (scenario === 'redelete') {
          await f.local.upsertItem({ ...tombstones[1], notes: 'latest local tombstone note' });
          await f.local.deleteItem(tombstones[1].id);
        }
        const before = await readFile(f.storage.path, 'utf8');
        const noRead = vi.spyOn(f.client, 'listObjects').mockRejectedValue(new Error('Receipt recovery must not reread sources'));
        f.storage.failNext = true;
        await expect(run()).rejects.toThrow('Synthetic encrypted save failure'); expect(noRead).not.toHaveBeenCalled();
        expect(await readFile(f.storage.path, 'utf8')).toBe(before);
        await f.restart();
        const noReadAgain = vi.spyOn(f.client, 'listObjects').mockRejectedValue(new Error('Receipt recovery reread sources'));
        await run(); expect(noReadAgain).not.toHaveBeenCalled(); noReadAgain.mockRestore();
        expect((await f.local.readMdbx2RestoreBatches())[0].operationScope).toBe(saved.operationScope);
      }
      const [completed] = await f.local.readMdbx2RestoreBatches();
      expect(completed.status).toBe('completed'); expect(completed.receipt!.items).toHaveLength(3);
      expect(completed.id).toBe(request.operationId);
      expect(completed.request).toEqual(request);
      const duplicate = vi.spyOn(f.client, 'restoreObjects');
      await run(); expect(duplicate).not.toHaveBeenCalled();
      await expect(new Mdbx2RestoreBatchCoordinator(f.client, f.local).restoreProject(f.rows[0].id,
        { ...request, expected: { ...request.expected, [f.rows[0].id]: new Date().toISOString() } })).rejects.toThrow('已变化');
      expect(duplicate).not.toHaveBeenCalled(); duplicate.mockRestore();
      const locals = (await f.local.readState()).items.filter(row => f.rows.some(original => original.id === row.id));
      expect(locals.every(row => row.providerRefs[0].revision === restoreCommit)).toBe(true);
      for (const original of originals) {
        const actual = await f.client.revealObject(f.handle, original.objectId);
        expect({ ...actual, headCommitId: original.headCommitId }).toEqual(original);
        expect(actual.headCommitId).toBe(restoreCommit);
      }
      const backend = mdbx2ProjectRemovalAttachments(f.client, f.account, f.rows);
      const files = await backend.listAttachments(f.account.id, f.rows[0].id); expect(files.items).toHaveLength(1);
      const attachmentHash = await hashProviderAttachment(backend, f.account.id, f.rows[0].id, files.items[0].attachmentId, 'shared.txt', f.fileBytes.length);
      expect(attachmentHash).toBe(hash(f.fileBytes));
      await synchronize();
      const deletedCount = scenario === 'redelete' ? 1 : 0;
      expect((await f.local.listDeletedItems()).filter(row => f.rows.some(original => original.id === row.id))).toHaveLength(deletedCount);
      expect((await f.local.readState()).mutationQueue).toEqual([]);
      await f.restart();
      const noReplayWrite = vi.spyOn(f.client, 'restoreObjects');
      await new Mdbx2RestoreBatchCoordinator(f.client, f.local).resume(completed.id); expect(noReplayWrite).not.toHaveBeenCalled();
      const deleted = await f.client.listObjects(f.handle, saved.members[0].intent.collectionId, { deleted: true });
      expect(deleted.items.filter(row => originals.some(item => item.objectId === row.objectId))).toHaveLength(deletedCount);
      Object.assign(f.evidence, { status: 'passed', scope: 'Actual Native process + atomic group restore + encrypted local batch journal; no Edge/current Android screen acceptance',
        scenario, restoreCommit, sharedAttachmentHash: attachmentHash, allRawPayloadsExact: true, allNativeIdentitiesExact: true,
        noRestoreBeforeIntentSaved: true, restartVerified: true, localAcknowledgementAtomic: true, latestDeletePreserved: scenario === 'redelete' });
    } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
  });

it.skipIf(!input || !output).each(['before-finalize', 'finalize-race'] as const)('actual preparation cancellation preserves all native members and copied attachments: %s', async phase => {
  const f = await fixture(`cancel-preparation-${phase}-`); let failure: unknown;
  try {
    const staged = (await f.local.readPasswordProjectRemovals())[0];
    const finalize = f.local.finalizePasswordProjectRemoval.bind(f.local);
    const intercept = vi.spyOn(f.local, 'finalizePasswordProjectRemoval').mockImplementation(async (...args) => {
      if (phase === 'before-finalize') throw new Error('Synthetic stop after attachment copy');
      await f.local.cancelPasswordProjectRemovalPreparation(f.operationId);
      return finalize(...args);
    });
    if (phase === 'before-finalize') {
      await expect(f.run()).rejects.toThrow('Synthetic stop after attachment copy'); intercept.mockRestore();
      const before = await readFile(f.storage.path, 'utf8'); f.storage.failNext = true;
      await expect(f.local.cancelPasswordProjectRemovalPreparation(f.operationId)).rejects.toThrow('Synthetic encrypted save failure');
      expect(await readFile(f.storage.path, 'utf8')).toBe(before);
      await f.restart();
      const later = await f.local.getItem(staged.retained[0].id) as LoginItem;
      await f.local.upsertItem({ ...later, password: 'latest password while preparing cancellation' }, undefined, later.updatedAt);
      await f.local.cancelPasswordProjectRemovalPreparation(f.operationId);
    } else expect((await f.run()).status).toBe('cancelled');
    const cancelled = await f.local.readState();
    expect(cancelled.passwordProjectRemovals![0].status).toBe('cancelled');
    expect(cancelled.items.filter(row => f.rows.some(original => original.id === row.id) && !row.deletedAt)).toHaveLength(3);
    await f.restart();
    const writes = vi.spyOn(f.client, 'mutateObjects');
    expect((await f.run()).status).toBe('cancelled'); expect(writes).not.toHaveBeenCalled();
    const sourceBackend = mdbx2ProjectRemovalAttachments(f.client, f.account, f.rows);
    // Cancellation keeps all verified copies, including a copy made before local cancellation persisted.
    for (const rowId of [staged.ownerTransfer!.sourceItemId, staged.ownerTransfer!.targetItemId]) {
      const files = await sourceBackend.listAttachments(f.account.id, rowId); expect(files.items).toHaveLength(1);
      expect(await hashProviderAttachment(sourceBackend, f.account.id, rowId, files.items[0].attachmentId, 'shared.txt', f.fileBytes.length)).toBe(hash(f.fileBytes));
    }
    const synced = await new Mdbx2Provider(f.client).sync(f.account, { localItems: cancelled.items, pendingMutations: cancelled.mutationQueue,
      passwordProjectRemovals: cancelled.passwordProjectRemovals, now: new Date().toISOString() });
    expect(synced.conflicts).toEqual([]);
    await f.local.applyProviderSync(f.account.id, synced.items, synced.accountPatch, synced.conflicts, synced.sourceRecords, cancelled.items);
    for (const original of f.rows) {
      const desired = cancelled.items.find(row => row.id === original.id) as LoginItem;
      const remote = await f.client.revealObject(f.handle, original.providerRefs[0].remoteId!);
      const payload = JSON.parse(remote.payloadJson);
      expect(remote.deleted).toBe(false); expect(remote.collectionId).toBe(original.providerRefs[0].remoteFolderId);
      expect(payload.password_plain).toBe(desired.password); expect(payload.notes).toBe(desired.notes);
      expect(payload.custom_fields.map((field: { title: string; value: string; is_protected: boolean }) =>
        ({ name: field.title, value: field.value, protected: field.is_protected }))).toEqual(original.customFields);
    }
    expect((await f.local.readState()).mutationQueue).toEqual([]);
    await f.restart(); expect((await f.run()).status).toBe('cancelled');
    Object.assign(f.evidence, { status: 'passed', phase, noNativeDeletionRequest: true, originalMembersAndOrderPreserved: true,
      originalAndCopiedAttachmentHashesExact: true, encryptedCancelFailureRetried: phase === 'before-finalize',
      concurrentFinalizeCannotDelete: phase === 'finalize-race', ordinarySyncNoConflicts: true });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output)('real deletion coordinator recovers exact native receipt after response loss and encrypted save failure', async () => {
  const f = await fixture('receipt-'); let failure: unknown;
  try {
    const finishUpload = f.client.finishAttachmentUpload.bind(f.client);
    const lostUpload = vi.spyOn(f.client, 'finishAttachmentUpload').mockImplementationOnce(async (...args) => {
      await finishUpload(...args); throw new Error('Synthetic lost attachment response');
    });
    await expect(f.run()).rejects.toThrow('Synthetic lost attachment response'); lostUpload.mockRestore();
    expect((await f.local.readPasswordProjectRemovals())[0].status).toBe('preparing');
    const finalize = f.local.finalizePasswordProjectRemoval.bind(f.local);
    const failBefore = vi.spyOn(f.local, 'finalizePasswordProjectRemoval').mockImplementationOnce(async (...args) => {
      f.storage.failNext = true; return finalize(...args);
    });
    await expect(f.run()).rejects.toThrow('Synthetic encrypted save failure'); failBefore.mockRestore();
    expect((await f.local.readPasswordProjectRemovals())[0].status).toBe('preparing');
    expect(await f.local.listDeletedItems()).toEqual([]);
    for (const row of f.rows) expect((await f.client.revealObject(f.handle, row.providerRefs[0].remoteId!)).deleted).toBe(false);
    let originalCommit: string | undefined;
    const mutate = f.client.mutateObjects.bind(f.client);
    vi.spyOn(f.client, 'mutateObjects').mockImplementation(async (...args) => {
      const result = await mutate(...args);
      if (args[4]) {
        originalCommit = result.commitId;
        vi.spyOn(f.client, 'resolveObjectOperation').mockRejectedValue(new Error('Synthetic worker disconnected'));
        f.client.close(); throw new Error('Synthetic lost successful delete response');
      }
      return result;
    });
    await expect(f.run()).rejects.toThrow('Synthetic worker disconnected'); expect(originalCommit).toBeTruthy();
    const durable = (await f.local.readPasswordProjectRemovals())[0]; expect(durable.status).toBe('deleting');
    expect(durable.nativeDeletion!.intent.mutations).toHaveLength(2);
    await f.restart();
    // Recovery must resolve/replay before attempting source or target reads.
    const firstRead = vi.spyOn(f.client, 'revealObject').mockRejectedValue(new Error('Recovery tried to read deleted source'));
    f.storage.failNext = true;
    await expect(f.run()).rejects.toThrow('Synthetic encrypted save failure');
    expect(firstRead).not.toHaveBeenCalled(); expect((await f.local.readPasswordProjectRemovals())[0]).toEqual(durable);
    await f.restart();
    const noRead = vi.spyOn(f.client, 'revealObject').mockRejectedValue(new Error('Recovery tried to read source'));
    const completed = await f.run(); expect(completed.status).toBe('completed'); expect(noRead).not.toHaveBeenCalled(); noRead.mockRestore();
    expect(completed.nativeDeletion!.receipt!.commitId).toBe(originalCommit);
    expect(completed.nativeDeletion!.intent).toEqual(durable.nativeDeletion!.intent);
    expect((await f.local.readState()).mutationQueue).toEqual([]);
    const target = completed.retained[0], backend = mdbx2ProjectRemovalAttachments(f.client, f.account, completed.retained);
    const targetFiles = await backend.listAttachments(f.account.id, target.id); expect(targetFiles.items).toHaveLength(1);
    expect(await hashProviderAttachment(backend, f.account.id, target.id, targetFiles.items[0].attachmentId, 'shared.txt', f.fileBytes.length)).toBe(hash(f.fileBytes));
    expect(target.customFields.some(field => field.value.includes('9007199254740993'))).toBe(true);
    expect(target.customFields).toContainEqual({ name: 'Shared custom', value: ' 0000123\r\nsecret ', protected: true });
    const deleted = await f.client.listObjects(f.handle, f.rows[0].providerRefs[0].remoteFolderId!, { deleted: true });
    const actual = deleted.items.filter(row => f.rows.slice(0, 2).some(original => original.providerRefs[0].remoteId === row.objectId));
    expect(actual).toHaveLength(2); expect(actual.every(row => row.headCommitId === originalCommit)).toBe(true);
    const envelope = await readFile(f.storage.path, 'utf8'); expect(envelope).not.toContain('synthetic-secret'); expect(envelope).not.toContain(durable.nativeDeletion!.intent.operationScope);
    const state = await f.local.readState();
    const synced = await new Mdbx2Provider(f.client).sync(f.account, { localItems: state.items, pendingMutations: state.mutationQueue,
      passwordProjectRemovals: state.passwordProjectRemovals, now: new Date().toISOString() });
    expect(synced.conflicts).toEqual([]);
    for (const row of f.rows.slice(0, 2)) expect(synced.items.find(item => item.id === row.id)?.deletedAt).toBeTruthy();
    Object.assign(f.evidence, { status: 'passed', unsavedIntentNoDelete: true, lostResponseThenHostRestart: true, localSaveFailureAfterCommit: true,
      replayWithoutSourceReads: true, sharedAttachmentAndRichFieldsPreserved: true, uploadResponseLossNoDuplicate: true,
      subsequentOrdinarySyncNoFalseConflict: true, oneAtomicCommit: originalCommit });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output).each(['retained-and-new', 'restored-member'] as const)('real committed removal preserves later local %s through restart and sync', async scenario => {
  const f = await fixture(`reconcile-${scenario}-`); let failure: unknown;
  try {
    const mutate = f.client.mutateObjects.bind(f.client);
    let deletionCommit = '';
    const failAcknowledgement = vi.spyOn(f.client, 'mutateObjects').mockImplementation(async (...args) => {
      const result = await mutate(...args);
      if (args[4]) { deletionCommit = result.commitId!; f.storage.failNext = true; }
      return result;
    });
    await expect(f.run()).rejects.toThrow('Synthetic encrypted save failure'); failAcknowledgement.mockRestore();
    const durable = (await f.local.readPasswordProjectRemovals())[0];
    expect(durable.status).toBe('deleting'); expect(deletionCommit).toBeTruthy();
    const desired: LoginItem[] = [];
    if (scenario === 'retained-and-new') {
      const target = await f.local.getItem(durable.retained[0].id) as LoginItem;
      desired.push(await f.local.upsertItem({ ...target, notes: 'newer retained note after native commit' }, undefined, target.updatedAt) as LoginItem);
      const extra: LoginItem = { ...target, id: randomUUID(), replicaGroupId: undefined, password: 'new password after native commit',
        providerRefs: [{ providerId: f.account.id }], customFields: target.customFields.map(field => field.name === PROJECT_CREDENTIAL_FIELD
          ? { ...field, value: field.value.replace(/"passwordId":"[^"]+"/, `"passwordId":"${randomUUID()}"`).replace('"passwordOrder":0', '"passwordOrder":1') } : field) };
      desired.push(await f.local.upsertItem(extra) as LoginItem);
    } else {
      const source = (await f.local.listDeletedItems()).find(row => row.id === durable.ownerTransfer!.sourceItemId) as LoginItem;
      desired.push(await f.local.upsertItem({ ...source, deletedAt: undefined, password: 'new secret on restored original',
        customFields: source.customFields.map(field => field.name === PROJECT_CREDENTIAL_FIELD
          ? { ...field, value: field.value.replace('"passwordOrder":0', '"passwordOrder":1') } : field) }, undefined, source.updatedAt) as LoginItem);
    }
    const queued = (await f.local.readState()).mutationQueue.filter(row => desired.some(item => item.id === row.itemId));
    await f.restart();
    const before = await readFile(f.storage.path, 'utf8');
    f.storage.failNext = true;
    await expect(f.run()).rejects.toThrow('Synthetic encrypted save failure');
    expect(await readFile(f.storage.path, 'utf8')).toBe(before);
    await f.restart();
    if (scenario === 'restored-member') {
      const restore = f.client.restoreObject.bind(f.client);
      const loseRestoreAcknowledgement = vi.spyOn(f.client, 'restoreObject').mockImplementationOnce(async (...args) => {
        const result = await restore(...args); f.storage.failNext = true; return result;
      });
      await expect(f.run()).rejects.toThrow('Synthetic encrypted save failure'); loseRestoreAcknowledgement.mockRestore();
      expect((await f.local.readPasswordProjectRemovals())[0].status).toBe('completed');
      expect((await f.local.readMdbx2Restores())[0].status).toBe('prepared');
      expect((await f.local.getItem(desired[0].id) as LoginItem).password).toBe(desired[0].password);
      const latest = await f.local.getItem(desired[0].id) as LoginItem;
      desired[0] = await f.local.upsertItem({ ...latest, password: 'even newer restored password', notes: 'edited again after native restore commit' },
        undefined, latest.updatedAt) as LoginItem;
      await f.restart();
    }
    const completed = await f.run();
    expect(completed.nativeDeletion!.receipt!.commitId).toBe(deletionCommit);
    expect(completed.nativeDeletion!.intent).toEqual(durable.nativeDeletion!.intent);
    expect((await f.local.readState()).mutationQueue).toEqual(queued);
    for (const row of desired) {
      const current = await f.local.getItem(row.id) as LoginItem;
      expect(current.password).toBe(row.password); expect(current.notes).toBe(row.notes); expect(current.customFields).toEqual(row.customFields);
    }
    const state = await f.local.readState();
    const synced = await new Mdbx2Provider(f.client).sync(f.account, { localItems: state.items, pendingMutations: state.mutationQueue,
      passwordProjectRemovals: state.passwordProjectRemovals, now: new Date().toISOString() });
    expect(synced.conflicts).toEqual([]);
    await f.local.applyProviderSync(f.account.id, synced.items, synced.accountPatch, synced.conflicts, synced.sourceRecords, state.items);
    for (const row of desired) {
      const current = await f.local.getItem(row.id) as LoginItem;
      const remote = await f.client.revealObject(f.handle, current.providerRefs.find(ref => ref.providerId === f.account.id)!.remoteId!);
      const payload = JSON.parse(remote.payloadJson);
      expect(payload.password_plain).toBe(row.password); expect(payload.notes).toBe(row.notes);
      expect(payload.username).toBe(row.username); expect(payload.email).toBe(row.email); expect(payload.phone).toBe(row.phone);
      expect(payload.custom_fields.map((field: { title: string; value: string; is_protected: boolean }) =>
        ({ name: field.title, value: field.value, protected: field.is_protected }))).toEqual(row.customFields);
    }
    if (scenario === 'restored-member') {
      const originalRef = f.rows.find(row => row.id === desired[0].id)!.providerRefs.find(ref => ref.providerId === f.account.id)!;
      expect((await f.local.getItem(desired[0].id))!.providerRefs.find(ref => ref.providerId === f.account.id)!.remoteId).toBe(originalRef.remoteId);
      const backend = mdbx2ProjectRemovalAttachments(f.client, f.account, [await f.local.getItem(desired[0].id) as LoginItem]);
      const files = await backend.listAttachments(f.account.id, desired[0].id); expect(files.items).toHaveLength(1);
      expect(await hashProviderAttachment(backend, f.account.id, desired[0].id, files.items[0].attachmentId, 'shared.txt', f.fileBytes.length)).toBe(hash(f.fileBytes));
    }
    const deleted = await f.client.listObjects(f.handle, f.rows[0].providerRefs[0].remoteFolderId!, { deleted: true });
    expect(deleted.items.filter(row => durable.removed.some(original => original.providerRefs[0].remoteId === row.objectId)))
      .toHaveLength(scenario === 'restored-member' ? 1 : 2);
    Object.assign(f.evidence, { status: 'passed', scenario, deletionCommit, exactReceiptReplayed: true, encryptedAcknowledgementFailurePreserved: true,
      latestLocalQueueAndContentPreserved: true, subsequentSyncPublishedLatestValues: true,
      ...(scenario === 'restored-member' ? { nativeRestoreAcknowledgementFailureAndRestartRecovered: true, originalObjectAndAttachmentRestored: true } : {}) });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output).each([
  ['ordinary', 'unsent'], ['ordinary', 'committed'], ['ordinary', 'late-commit'],
  ['reapply', 'unsent'], ['reapply', 'committed'], ['reapply', 'late-commit'],
] as const)('actual %s restore followed by another deletion survives %s outcome and restart', async (kind, outcome) => {
  const f = await fixture(`redelete-${kind}-${outcome}-`); let failure: unknown;
  try {
    const originalRef = f.rows[0].providerRefs.find(ref => ref.providerId === f.account.id)!;
    const original = await f.client.revealObject(f.handle, originalRef.remoteId!);
    if (kind === 'reapply') {
      const mutate = f.client.mutateObjects.bind(f.client);
      const loseDeleteAck = vi.spyOn(f.client, 'mutateObjects').mockImplementation(async (...args) => {
        const result = await mutate(...args); if (args[4]) f.storage.failNext = true; return result;
      });
      await expect(f.run()).rejects.toThrow('Synthetic encrypted save failure'); loseDeleteAck.mockRestore();
      const row = (await f.local.listDeletedItems()).find(row => row.id === f.rows[0].id) as LoginItem;
      await f.local.upsertItem({ ...row, deletedAt: undefined, password: 'new local secret before cancellation',
        customFields: row.customFields.map(field => field.name === PROJECT_CREDENTIAL_FIELD
          ? { ...field, value: field.value.replace('"passwordOrder":0', '"passwordOrder":1') } : field) }, undefined, row.updatedAt);
    } else await f.run();
    const restore = f.client.restoreObject.bind(f.client);
    let restoreCommit: string | undefined;
    const interrupt = vi.spyOn(f.client, 'restoreObject').mockImplementation(async (...args) => {
      if (outcome === 'committed') {
        restoreCommit = (await restore(...args)).commitId;
        vi.spyOn(f.client, 'resolveObjectOperation').mockRejectedValue(new Error('Synthetic restore receipt connection lost'));
      }
      throw new Error('Synthetic restore interrupted');
    });
    const resume = () => kind === 'reapply' ? f.run() : new Mdbx2RestoreCoordinator(f.client, f.local).restore(f.rows[0].id);
    await expect(resume()).rejects.toThrow('Synthetic restore'); interrupt.mockRestore();
    const [pending] = await f.local.readMdbx2Restores();
    expect(pending.status).toBe('prepared'); expect(Boolean(pending.reapply)).toBe(kind === 'reapply');
    await f.local.deleteItem(f.rows[0].id);
    const before = await f.local.readState(), tombstone = before.items.find(row => row.id === f.rows[0].id)!;
    expect(before.mutationQueue).toEqual([expect.objectContaining({ itemId: tombstone.id, operation: 'delete' })]);
    await f.restart();
    if (outcome === 'late-commit') {
      expect((await f.client.resolveObjectOperation(f.handle, pending.intent.operationScope)).committed).toBe(false);
      // The original request arrives only after the user has deleted again.
      restoreCommit = (await f.client.restoreObject(f.handle, pending.intent.operationScope, pending.intent)).commitId;
    } else if (outcome === 'unsent') {
      const logicalObjectId = `note:${randomUUID()}`;
      await f.client.upsertObject(f.handle, randomUUID(), { logicalObjectId, collectionId: pending.intent.collectionId,
        objectTypeId: 'note', title: 'Unrelated revision', payloadJson: JSON.stringify({ monica_entry_id: logicalObjectId, kind: 'note', notes: 'independent' }) });
      f.storage.failNext = true;
      await expect(resume()).rejects.toThrow('Synthetic encrypted save failure');
      expect((await f.local.readMdbx2Restores())[0]).toEqual(pending);
      expect((await f.client.listObjects(f.handle, pending.intent.collectionId, { deleted: true })).items
        .find(row => row.objectId === pending.intent.objectId)?.deleted).toBe(true);
      await f.restart();
    }
    const replay = f.client.restoreObject.bind(f.client);
    vi.spyOn(f.client, 'restoreObject').mockImplementation(async (...args) => {
      const result = await replay(...args);
      if (restoreCommit) expect(result.commitId).toBe(restoreCommit);
      restoreCommit = result.commitId; f.storage.failNext = true; return result;
    });
    await expect(resume()).rejects.toThrow('Synthetic encrypted save failure');
    expect((await f.local.readState()).items).toEqual(before.items);
    expect((await f.local.readState()).mutationQueue).toEqual(before.mutationQueue);
    await f.restart();
    // A newer delete reuses the queue ID; settlement must preserve this one too.
    await f.local.deleteItem(tombstone.id);
    const latest = await f.local.readState(), latestRow = latest.items.find(row => row.id === tombstone.id)!;
    await resume();
    const settled = await f.local.readState(), settledRow = settled.items.find(row => row.id === tombstone.id)!;
    expect({ ...settledRow, providerRefs: latestRow.providerRefs }).toEqual(latestRow);
    expect(settledRow.providerRefs.find(ref => ref.providerId === f.account.id)!.revision).toBe(restoreCommit);
    expect(settled.mutationQueue).toEqual(latest.mutationQueue);
    const [completed] = await f.local.readMdbx2Restores();
    expect(completed.status).toBe('completed'); expect(completed.receipt!.commitId).toBe(restoreCommit);
    const stillOriginal = await f.client.revealObject(f.handle, original.objectId);
    expect(stillOriginal.payloadJson).toBe(original.payloadJson);
    const backend = mdbx2ProjectRemovalAttachments(f.client, f.account, [{ ...settledRow, deletedAt: undefined } as LoginItem]);
    const files = await backend.listAttachments(f.account.id, settledRow.id); expect(files.items).toHaveLength(1);
    expect(await hashProviderAttachment(backend, f.account.id, settledRow.id, files.items[0].attachmentId, 'shared.txt', f.fileBytes.length)).toBe(hash(f.fileBytes));
    const synced = await new Mdbx2Provider(f.client).sync(f.account, { localItems: settled.items, pendingMutations: settled.mutationQueue,
      passwordProjectRemovals: settled.passwordProjectRemovals, now: new Date().toISOString() });
    expect(synced.conflicts).toEqual([]);
    await f.local.applyProviderSync(f.account.id, synced.items, synced.accountPatch, synced.conflicts, synced.sourceRecords, settled.items);
    expect((await f.local.readState()).mutationQueue).toEqual([]);
    const deleted = (await f.client.listObjects(f.handle, original.collectionId, { deleted: true })).items.find(row => row.objectId === original.objectId)!;
    expect(deleted.deleted).toBe(true); expect(deleted.headCommitId).not.toBe(restoreCommit);
    await f.restart();
    // An old in-flight replay after the final delete returns the old receipt and cannot revive the object.
    const oldReplay = await f.client.restoreObject(f.handle, completed.intent.operationScope, completed.intent);
    expect(oldReplay.alreadyCommitted).toBe(true); expect(oldReplay.commitId).toBe(restoreCommit);
    expect((await f.client.listObjects(f.handle, original.collectionId, { deleted: true })).items.find(row => row.objectId === original.objectId))
      .toEqual(deleted);
    expect((await f.local.listDeletedItems()).find(row => row.id === tombstone.id)?.deletedAt).toBe(latestRow.deletedAt);
    Object.assign(f.evidence, { status: 'passed', kind, outcome, restoreCommit, deleteCommit: deleted.headCommitId,
      latestDeletionNeverLocallyRevived: true, queuePreservedAcrossAcknowledgementFailure: true, exactOriginalPayloadAndAttachment: true,
      laterDeleteSyncedWithoutConflict: true, delayedRestoreReplayAfterDeleteCannotRevive: true });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output)('real deletion coordinator revalidates stale attachment proof before replacing the durable request', async () => {
  const f = await fixture('stale-'); let failure: unknown;
  try {
    const mutate = f.client.mutateObjects.bind(f.client); let target: LoginItem | undefined, targetAttachment: string | undefined;
    const finalize = f.local.finalizePasswordProjectRemoval.bind(f.local);
    vi.spyOn(f.local, 'finalizePasswordProjectRemoval').mockImplementation(async (...args) => {
      const record = await finalize(...args);
      target = record.retained[0]; targetAttachment = record.proofs![0].attachments[0].targetAttachmentId;
      return record;
    });
    let injected = false;
    const interleave = vi.spyOn(f.client, 'mutateObjects').mockImplementation(async (...args) => {
      if (args[4] && !injected) {
        injected = true;
        const replaced = f.fileBytes.slice(); replaced[0] ^= 1;
        await f.upload(target!, targetAttachment!, replaced, 'replace');
      }
      return mutate(...args);
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'vault-revision-conflict' }); interleave.mockRestore();
    const durable = (await f.local.readPasswordProjectRemovals())[0]; expect(durable.status).toBe('deleting');
    for (const row of f.rows) expect((await f.client.revealObject(f.handle, row.providerRefs[0].remoteId!)).deleted).toBe(false);
    const envelope = await readFile(f.storage.path, 'utf8');
    await f.restart(); await expect(f.run()).rejects.toThrow('附件已变化');
    expect(await readFile(f.storage.path, 'utf8')).toBe(envelope);
    await f.upload(target!, targetAttachment!, f.fileBytes, 'replace');
    const replace = f.local.replacePasswordProjectNativeDeletionIntent.bind(f.local);
    vi.spyOn(f.local, 'replacePasswordProjectNativeDeletionIntent').mockImplementationOnce(async (...args) => {
      f.storage.failNext = true; return replace(...args);
    });
    await expect(f.run()).rejects.toThrow('Synthetic encrypted save failure');
    expect(await readFile(f.storage.path, 'utf8')).toBe(envelope);
    for (const row of f.rows) expect((await f.client.revealObject(f.handle, row.providerRefs[0].remoteId!)).deleted).toBe(false);
    await f.restart();
    const completed = await f.run(); expect(completed.status).toBe('completed');
    expect(completed.nativeDeletion!.intent.operationScope).not.toBe(durable.nativeDeletion!.intent.operationScope);
    expect(completed.nativeDeletion!.intent.writeRevision).not.toEqual(durable.nativeDeletion!.intent.writeRevision);
    expect(completed.nativeDeletion!.intent.mutations).toEqual(durable.nativeDeletion!.intent.mutations);
    const prior = await f.client.resolveObjectOperation(f.handle, durable.nativeDeletion!.intent.operationScope); expect(prior.committed).toBe(false);
    Object.assign(f.evidence, { status: 'passed', interleavedAttachmentChangeRejectedAtomically: true, staleBadProofNeverReplaced: true,
      restoredBytesFullyReverified: true, replacementSaveFailureNoDelete: true, newRequestPersistedThenCommitted: true, originalRequestNeverCommitted: true });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output).each(['source', 'target', 'new-member', 'provider'] as const)('real deletion recovery retains changed %s state', async scenario => {
  const f = await fixture(`changed-${scenario}-`); let failure: unknown;
  try {
    const mutate = f.client.mutateObjects.bind(f.client);
    const stop = vi.spyOn(f.client, 'mutateObjects').mockImplementation(async (...args) => {
      if (args[4]) throw new Error('Synthetic interruption before native deletion');
      return mutate(...args);
    });
    await expect(f.run()).rejects.toThrow('Synthetic interruption'); stop.mockRestore();
    const saved = (await f.local.readPasswordProjectRemovals())[0]; expect(saved.status).toBe('deleting');
    if (scenario === 'source' || scenario === 'target') {
      const ref = f.rows[scenario === 'source' ? 0 : 2].providerRefs[0];
      const row = await f.client.revealObject(f.handle, ref.remoteId!);
      await f.client.upsertObject(f.handle, randomUUID(), { logicalObjectId: `native:${row.objectId}`, collectionId: row.collectionId,
        objectTypeId: row.objectTypeId, title: `${row.title} concurrent edit`, payloadJson: row.payloadJson, expectedHeadCommitId: row.headCommitId });
    }
    if (scenario === 'new-member') {
      const row = saved.retained[0];
      await new Mdbx2Provider(f.client).create(f.account, { ...row, id: randomUUID(), replicaGroupId: undefined,
        providerRefs: [{ providerId: f.account.id }], password: 'synthetic-new-member', customFields: row.customFields.map(field =>
          field.name === PROJECT_CREDENTIAL_FIELD ? { ...field, value: field.value.replace(/"passwordId":"[^"]+"/, `"passwordId":"${randomUUID()}"`) } : field) });
    }
    if (scenario === 'provider') await f.local.upsertProvider({ ...f.account, config: { ...f.account.config, vaultHandle: 'synthetic-replacement' } });
    const envelope = await readFile(f.storage.path, 'utf8');
    const originals = await Promise.all(f.rows.map(row => f.client.revealObject(f.handle, row.providerRefs[0].remoteId!)));
    await f.restart(); await expect(f.run()).rejects.toThrow('变化');
    expect(await readFile(f.storage.path, 'utf8')).toBe(envelope);
    expect(await Promise.all(f.rows.map(row => f.client.revealObject(f.handle, row.providerRefs[0].remoteId!)))).toEqual(originals);
    expect(originals.every(row => !row.deleted)).toBe(true);
    expect((await f.client.resolveObjectOperation(f.handle, saved.nativeDeletion!.intent.operationScope)).committed).toBe(false);
    Object.assign(f.evidence, { status: 'passed', scenario, interruptedBeforeDelete: true, changedStateKept: true, noRemoteDeletion: true });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output)('actual restore coordinator retains original native JSON and attachment through response loss and restart', async () => {
  const f = await fixture('restore-'); let failure: unknown;
  try {
    const original = await f.client.revealObject(f.handle, f.rows[0].providerRefs[0].remoteId!);
    await f.run();
    const removed = (await f.local.listDeletedItems()).find(row => row.id === f.rows[0].id)!;
    f.storage.failNext = true;
    await expect(new Mdbx2RestoreCoordinator(f.client, f.local).restore(removed.id)).rejects.toThrow('Synthetic encrypted save failure');
    expect((await f.client.listObjects(f.handle, original.collectionId, { deleted: true })).items.some(row => row.objectId === original.objectId)).toBe(true);
    expect(await f.local.readMdbx2Restores()).toEqual([]);
    let restoreCommit: string | undefined;
    const restore = f.client.restoreObject.bind(f.client);
    vi.spyOn(f.client, 'restoreObject').mockImplementation(async (...args) => {
      const result = await restore(...args); restoreCommit = result.commitId;
      vi.spyOn(f.client, 'resolveObjectOperation').mockRejectedValue(new Error('Synthetic restore connection lost'));
      f.client.close(); throw new Error('Synthetic successful restore response lost');
    });
    await expect(new Mdbx2RestoreCoordinator(f.client, f.local).restore(removed.id)).rejects.toThrow('Synthetic restore connection lost');
    expect(restoreCommit).toBeTruthy();
    const [durable] = await f.local.readMdbx2Restores(); expect(durable.status).toBe('prepared');
    expect((await f.local.listDeletedItems()).find(row => row.id === removed.id)).toEqual(removed);
    await f.restart();
    const noRead = vi.spyOn(f.client, 'listObjects').mockRejectedValue(new Error('Recovery reread a restored source'));
    f.storage.failNext = true;
    await expect(new Mdbx2RestoreCoordinator(f.client, f.local).restore(removed.id)).rejects.toThrow('Synthetic encrypted save failure');
    expect(noRead).not.toHaveBeenCalled();
    await f.restart();
    const restored = await new Mdbx2RestoreCoordinator(f.client, f.local).restore(removed.id);
    expect(restored.id).toBe(removed.id); expect(restored.deletedAt).toBeUndefined();
    expect(restored.providerRefs[0].remoteId).toBe(original.objectId); expect(restored.providerRefs[0].revision).toBe(restoreCommit);
    const [completed] = await f.local.readMdbx2Restores(); expect(completed.status).toBe('completed');
    expect(completed.intent).toEqual(durable.intent); expect(completed.receipt!.commitId).toBe(restoreCommit);
    const after = await f.client.revealObject(f.handle, original.objectId);
    expect({ ...after, headCommitId: original.headCommitId }).toEqual(original);
    const backend = mdbx2ProjectRemovalAttachments(f.client, f.account, [restored as LoginItem]);
    const attachments = await backend.listAttachments(f.account.id, restored.id); expect(attachments.items).toHaveLength(1);
    expect(await hashProviderAttachment(backend, f.account.id, restored.id, attachments.items[0].attachmentId, 'shared.txt', f.fileBytes.length)).toBe(hash(f.fileBytes));
    const state = await f.local.readState();
    const synced = await new Mdbx2Provider(f.client).sync(f.account, { localItems: state.items, pendingMutations: state.mutationQueue,
      passwordProjectRemovals: state.passwordProjectRemovals, now: new Date().toISOString() });
    expect(synced.conflicts).toEqual([]); expect(synced.items.find(row => row.id === restored.id)?.deletedAt).toBeUndefined();
    Object.assign(f.evidence, { status: 'passed', scope: 'Actual Native restore RPC + encrypted restore journal + coordinator; no Edge/current Android restore acceptance',
      restoreCommit, originalObjectAndPayloadExact: true, sourceAttachmentHashExact: true, restoreResponseLossAndHostRestart: true,
      encryptedSaveFailuresBeforeAndAfterNativeRestore: true, subsequentSyncNoConflict: true });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output).each([false, true])('ordinary deletion sync retains restorable encrypted group tombstones (response loss %s)', async loseResponse => {
  const f = await fixture(`ordinary-${loseResponse}-`, false); let failure: unknown;
  try {
    const originals = await Promise.all(f.rows.map(row => f.client.revealObject(f.handle, row.providerRefs[0].remoteId!)));
    await f.local.deletePasswordGroup(f.rows[0].id, Object.fromEntries(f.rows.map(row => [row.id, row.updatedAt])));
    const synchronize = async () => {
      const state = await f.local.readState();
      const result = await new Mdbx2Provider(f.client).sync(f.account, { localItems: state.items, pendingMutations: state.mutationQueue,
        now: new Date().toISOString() });
      expect(result.conflicts).toEqual([]);
      await f.local.applyProviderSync(f.account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, state.items);
    };
    if (loseResponse) {
      const mutate = f.client.mutateObjects.bind(f.client);
      vi.spyOn(f.client, 'mutateObjects').mockImplementationOnce(async (...args) => {
        await mutate(...args); throw new Error('Synthetic ordinary deletion response loss');
      });
      await expect(synchronize()).rejects.toThrow('Synthetic ordinary deletion response loss');
      await f.restart();
    }
    await synchronize();
    const deleted = (await f.local.listDeletedItems()).filter(item => f.rows.some(row => row.id === item.id));
    expect(deleted).toHaveLength(3);
    expect((await f.local.readState()).mutationQueue).toEqual([]);
    await f.restart(); await synchronize();
    const coordinator = new Mdbx2RestoreCoordinator(f.client, f.local);
    for (const row of f.rows) {
      const restored = await coordinator.restore(row.id);
      expect(restored.deletedAt).toBeUndefined();
      expect(restored.providerRefs[0].remoteId).toBe(row.providerRefs[0].remoteId);
    }
    await synchronize();
    for (const original of originals) {
      const current = await f.client.revealObject(f.handle, original.objectId);
      expect({ ...current, headCommitId: original.headCommitId }).toEqual(original);
    }
    expect((await f.local.listDeletedItems()).filter(item => f.rows.some(row => row.id === item.id))).toEqual([]);
    Object.assign(f.evidence, { status: 'passed', ordinarySync: true, loseResponse, encryptedTombstonesSurviveSyncAndRestart: true,
      originalThreeNativeObjectsRestored: true, allRawPayloadsExact: true, pendingQueueEmpty: true });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output)('restoring an unsent delete keeps native contents and removes only that local queue entry', async () => {
  const f = await fixture('unsent-delete-', false); let failure: unknown;
  try {
    const original = await f.client.revealObject(f.handle, f.rows[0].providerRefs[0].remoteId!);
    await f.local.deletePasswordGroup(f.rows[0].id, Object.fromEntries(f.rows.map(row => [row.id, row.updatedAt])));
    await f.restart();
    const nativeRestore = vi.spyOn(f.client, 'restoreObject');
    f.storage.failNext = true;
    await expect(new Mdbx2RestoreCoordinator(f.client, f.local).restore(f.rows[0].id)).rejects.toThrow('Synthetic encrypted save failure');
    expect((await f.local.readState()).mutationQueue).toHaveLength(3);
    await new Mdbx2RestoreCoordinator(f.client, f.local).restore(f.rows[0].id);
    expect((await f.local.readState()).mutationQueue.map(row => row.itemId).sort()).toEqual(f.rows.slice(1).map(row => row.id).sort());
    expect(await f.client.revealObject(f.handle, original.objectId)).toEqual(original);
    expect(nativeRestore).not.toHaveBeenCalled();
    expect(await f.local.readMdbx2Restores()).toEqual([]);
    Object.assign(f.evidence, { status: 'passed', unsentDeleteCancelled: true, nativeOriginalExactIncludingHead: true,
      noNativeRestoreSent: true, unrelatedPendingDeletesPreserved: true, saveFailureRetainsQueue: true });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output).each(['complete', 'dirty', 'later-delete'] as const)(
  'restores an acknowledged tombstone immediately after queued re-deletion: %s', async mode => {
    const f = await fixture(`queued-redelete-${mode}-`, false); let failure: unknown;
    try {
      const id = f.rows[0].id, original = await f.client.revealObject(f.handle, f.rows[0].providerRefs[0].remoteId!);
      const sync = async () => {
        const state = await f.local.readState();
        const result = await new Mdbx2Provider(f.client).sync(f.account, { localItems: state.items, pendingMutations: state.mutationQueue,
          now: new Date().toISOString() });
        expect(result.conflicts).toEqual([]);
        await f.local.applyProviderSync(f.account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, state.items);
      };
      await f.local.deleteItem(id); await sync();
      const acknowledged = (await f.local.listDeletedItems()).find(row => row.id === id)!;
      if (mode === 'dirty') await f.local.upsertItem({ ...acknowledged, notes: '  unsynchronized edit\r\n9007199254740993 ' });
      await f.local.deleteItem(id);
      const before = await f.local.readState(), queued = before.mutationQueue.find(row => row.itemId === id)!;
      const writes = vi.spyOn(f.client, 'restoreObject');
      f.storage.failNext = true;
      await expect(new Mdbx2RestoreCoordinator(f.client, f.local).restore(id)).rejects.toThrow('Synthetic encrypted save failure');
      expect(await f.local.readState()).toEqual(before); expect(writes).not.toHaveBeenCalled(); writes.mockRestore();
      const stop = vi.spyOn(f.client, 'restoreObject').mockRejectedValue(new Error('Synthetic stop after supersession'));
      await expect(new Mdbx2RestoreCoordinator(f.client, f.local).restore(id)).rejects.toThrow('Synthetic stop after supersession');
      stop.mockRestore();
      const [saved] = await f.local.readMdbx2Restores();
      expect(saved.supersededDeletion).toEqual(queued);
      expect((await f.local.readState()).mutationQueue).toEqual([]);
      expect((await f.local.readState()).items).toEqual(before.items);
      await f.restart();
      const send = f.client.restoreObject.bind(f.client); let restoreCommit = '';
      vi.spyOn(f.client, 'restoreObject').mockImplementation(async (...args) => {
        const result = await send(...args); restoreCommit = result.commitId; f.storage.failNext = true; return result;
      });
      await expect(new Mdbx2RestoreCoordinator(f.client, f.local).restore(id)).rejects.toThrow('Synthetic encrypted save failure');
      expect(restoreCommit).not.toBe('');
      await f.restart();
      if (mode === 'later-delete') await f.local.deleteItem(id);
      const later = await f.local.readState();
      const restored = await new Mdbx2RestoreCoordinator(f.client, f.local).restore(id);
      expect(restored.providerRefs[0].revision).toBe(restoreCommit);
      expect(restored.deletedAt).toBe(mode === 'later-delete' ? later.items.find(row => row.id === id)!.deletedAt : undefined);
      const native = await f.client.revealObject(f.handle, original.objectId);
      expect({ ...native, headCommitId: original.headCommitId }).toEqual(original);
      // A delayed old deletion at the tombstone head cannot erase the restored object.
      await expect(f.client.deleteObject(f.handle, randomUUID(), `native:${original.objectId}`, acknowledged.providerRefs[0].revision)).rejects.toThrow();
      expect(await f.client.revealObject(f.handle, original.objectId)).toEqual(native);
      const attachmentBackend = mdbx2ProjectRemovalAttachments(f.client, f.account, [restored as LoginItem]);
      const [attachment] = (await attachmentBackend.listAttachments(f.account.id, id)).items;
      expect(await hashProviderAttachment(attachmentBackend, f.account.id, id, attachment.attachmentId, attachment.fileName, attachment.sizeBytes)).toBe(hash(f.fileBytes));
      const settled = await f.local.readState();
      if (mode === 'dirty') {
        expect(settled.mutationQueue).toMatchObject([{ itemId: id, operation: 'update' }]);
        expect(restored.notes).toBe('  unsynchronized edit\r\n9007199254740993 ');
      } else expect(settled.mutationQueue).toEqual(mode === 'later-delete' ? later.mutationQueue : []);
      await sync();
      if (mode === 'later-delete') {
        const tombstones = await f.client.listObjects(f.handle, original.collectionId, { deleted: true });
        expect(tombstones.items.some(row => row.objectId === original.objectId)).toBe(true);
        const snapshot = await f.local.readState();
        await f.local.applyMdbx2Restore(saved.id, saved.intent.operationScope, async () => { throw new Error('Completed replay wrote again'); });
        expect(await f.local.readState()).toEqual(snapshot);
      } else {
        const final = (await f.local.listItems()).find(row => row.id === id)!;
        expect(final.notes).toBe(restored.notes);
        expect((final as LoginItem).customFields).toEqual((restored as LoginItem).customFields);
      }
      Object.assign(f.evidence, { status: 'passed', mode, exactQueuedDeleteSupersededAtomically: true, noPreRestoreSync: true,
        stagingFailureAndAcknowledgementFailureRecovered: true, actualHostAndEncryptedEnvelopeRestart: true,
        nativePayloadUnchangedByRestore: true, lateOldDeleteRejected: true, originalAttachmentSha256: hash(f.fileBytes),
        laterDeletionPreserved: mode === 'later-delete', dirtyUpdateRetained: mode === 'dirty' });
    } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
  });

it.skipIf(!input || !output)('unsent single cancellation keeps dirty rich fields queued through actual native synchronization', async () => {
  const f = await fixture('single-cancel-dirty-', false); let failure: unknown;
  try {
    const source = f.rows[0], original = await f.client.revealObject(f.handle, source.providerRefs[0].remoteId!);
    const notes = '  edited before deleting\r\n9007199254740993 ';
    await f.local.upsertItem({ ...source, notes }); await f.local.deleteItem(source.id);
    const restored = await new Mdbx2RestoreCoordinator(f.client, f.local).restore(source.id);
    expect(restored.deletedAt).toBeUndefined(); expect(restored.notes).toBe(notes);
    expect(await f.client.revealObject(f.handle, original.objectId)).toEqual(original);
    await f.restart();
    const state = await f.local.readState();
    expect(state.mutationQueue).toMatchObject([{ itemId: source.id, operation: 'update' }]);
    const result = await new Mdbx2Provider(f.client).sync(f.account, { localItems: state.items, pendingMutations: state.mutationQueue,
      now: new Date().toISOString() });
    expect(result.conflicts).toEqual([]);
    const row = result.items.find(row => row.id === source.id) as LoginItem;
    expect(row.notes).toBe(notes); expect(row.customFields).toEqual(source.customFields);
    expect(row.password).toBe(source.password); expect(row.providerRefs[0].remoteId).toBe(original.objectId);
    const backend = mdbx2ProjectRemovalAttachments(f.client, f.account, [row]);
    const [attachment] = (await backend.listAttachments(f.account.id, row.id)).items;
    expect(await hashProviderAttachment(backend, f.account.id, row.id, attachment.attachmentId, attachment.fileName, attachment.sizeBytes)).toBe(hash(f.fileBytes));
    Object.assign(f.evidence, { status: 'passed', dirtySingleCancellationNoNativeWrite: true, queuedUpdateSurvivedRestart: true,
      nativeSyncPreservedRichFieldsAndOriginalIdentity: true, attachmentSha256: hash(f.fileBytes) });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});

it.skipIf(!input || !output)('restoration durably replaces a stale vault revision without changing the intended tombstone', async () => {
  const f = await fixture('restore-revision-'); let failure: unknown;
  try {
    await f.run();
    const source = (await f.local.listDeletedItems()).find(row => row.id === f.rows[0].id)!;
    const stop = vi.spyOn(f.client, 'restoreObject').mockRejectedValue(new Error('Synthetic interruption before restore'));
    await expect(new Mdbx2RestoreCoordinator(f.client, f.local).restore(source.id)).rejects.toThrow('Synthetic interruption');
    stop.mockRestore();
    const [saved] = await f.local.readMdbx2Restores();
    const logicalObjectId = `note:${randomUUID()}`;
    await f.client.upsertObject(f.handle, randomUUID(), { logicalObjectId, collectionId: saved.intent.collectionId,
      objectTypeId: 'note', title: 'Synthetic unrelated note', payloadJson: JSON.stringify({ monica_entry_id: logicalObjectId, kind: 'note', notes: 'independent' }) });
    const envelope = await readFile(f.storage.path, 'utf8');
    f.storage.failNext = true;
    await expect(new Mdbx2RestoreCoordinator(f.client, f.local).restore(source.id)).rejects.toThrow('Synthetic encrypted save failure');
    expect(await readFile(f.storage.path, 'utf8')).toBe(envelope);
    const deleted = await f.client.listObjects(f.handle, saved.intent.collectionId, { deleted: true });
    expect(deleted.items.find(row => row.objectId === saved.intent.objectId)?.deleted).toBe(true);
    await f.restart();
    await new Mdbx2RestoreCoordinator(f.client, f.local).restore(source.id);
    const [completed] = await f.local.readMdbx2Restores();
    expect(completed.status).toBe('completed');
    expect(completed.intent.operationScope).not.toBe(saved.intent.operationScope);
    expect(completed.intent.expectedHeadCommitId).toBe(saved.intent.expectedHeadCommitId);
    expect(completed.intent.objectId).toBe(saved.intent.objectId);
    expect((await f.client.resolveObjectOperation(f.handle, saved.intent.operationScope)).committed).toBe(false);
    Object.assign(f.evidence, { status: 'passed', staleRevisionRevalidated: true, replacementSaveFailureNoRestore: true,
      newIntentDurableBeforeCommit: true, originalIntentUncommitted: true });
  } catch (error) { failure = error; throw error; } finally { await f.close(failure); }
});
