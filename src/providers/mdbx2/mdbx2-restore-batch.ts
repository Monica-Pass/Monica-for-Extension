import type { LoginItem, VaultItem } from '../../core/model';
import { passwordGroupKey } from '../../core/password-groups';
import { sameProviderBinding } from '../../core/provider';
import { mdbx2RestoreScope } from '../../core/mdbx2-restore-journal';
import { mdbx2RestoreBatchSources, assertMdbx2RestoreBatchScope, mdbx2RestoreBatchInput, mdbx2RestoreBatchScope, readMdbx2RestoreBatchRequest, type Mdbx2RestoreBatchRecord, type Mdbx2RestoreBatchRequest } from '../../core/mdbx2-restore-batch-journal';
import type { SecureVaultService } from '../../security/secure-vault-service';
import type { Mdbx2NativeClient } from './native-client';
import { findDeletedMdbx2Object, prepareMdbx2RestoreRecord, readDeletedMdbx2Object } from './mdbx2-restore';
import { readMdbx2TransferBinding } from './mdbx2-transfer-verification';
import { decodeMdbx2Object } from './mdbx2-item-codec';

const changed = () => new Error('整组恢复期间成员或密码源已变化，原始内容已保留。');

/** Cached members deleted together. Callers serialize this with sync/removal on the source queue. */
export class Mdbx2RestoreBatchCoordinator {
  private readonly active = new Map<string, Promise<VaultItem[]>>();
  constructor(private readonly client: Mdbx2NativeClient, private readonly vault: SecureVaultService) {}

  async restoreProject(anchorItemId: string, input?: Mdbx2RestoreBatchRequest): Promise<VaultItem[]> {
    const request = input ? readMdbx2RestoreBatchRequest(input) : undefined;
    if (request && request.anchorItemId !== anchorItemId) throw changed();
    const cancelled=request && await this.vault.replayMdbx2DeletionCancellation(request.operationId,request);
    if(cancelled) return cancelled;
    const records = await this.vault.readMdbx2RestoreBatches();
    const previous = request && records.find(row => row.id === request.operationId);
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw changed();
      return this.resume(previous.id);
    }
    const pending = records.find(row => row.status === 'prepared' && mdbx2RestoreBatchSources(row).some(source => source.id === anchorItemId));
    if (pending && request) throw new Error('此项目已有待完成的恢复，请继续原操作。');
    if (pending) return this.resume(pending.id);
    const state = await this.vault.readState(), anchor = state.items.find(item => item.id === anchorItemId);
    if (anchor?.kind !== 'login' || !anchor.deletedAt) throw changed();
    const sources = state.items.filter((item): item is LoginItem => item.kind === 'login' && item.deletedAt === anchor.deletedAt
      && passwordGroupKey(item) === passwordGroupKey(anchor)).sort((a, b) => a.id.localeCompare(b.id));
    if (request && (anchor.deletedAt !== request.deletedAt || sources.length !== Object.keys(request.expected).length
      || sources.some(item => request.expected[item.id] !== item.updatedAt || item.providerRefs.length !== 1 || item.providerRefs[0].providerId !== request.providerId))) throw changed();
    if (!sources.length || sources.length > 50 || sources.some(item => item.providerRefs.length !== 1)) throw changed();
    const provider = state.providers.find(row => row.id === anchor.providerRefs[0].providerId);
    if (!provider?.enabled || provider.kind !== 'mdbx2' || sources.some(item => item.providerRefs[0].providerId !== provider.id)) throw changed();
    let mixed: Pick<Mdbx2RestoreBatchRecord, 'members' | 'cancellation' | 'request'> | undefined;
    if(sources.some(row=>!row.providerRefs[0].remoteId || state.mutationQueue.some(mutation=>mutation.itemId===row.id && mutation.operation==='delete'))) {
      const cancellation=request || {operationId:crypto.randomUUID(),anchorItemId,providerId:provider.id,deletedAt:anchor.deletedAt,
        expected:Object.fromEntries(sources.map(row=>[row.id,row.updatedAt]))};
      const deletedMembers: Mdbx2RestoreBatchRecord['members'] = [];
      const existing = sources.filter(row => row.providerRefs[0].remoteId);
      if (existing.length) {
        const binding = await readMdbx2TransferBinding(this.client, provider);
        for (const source of existing) {
          const ref = source.providerRefs[0];
          if (!ref.remoteFolderId || !ref.revision) throw changed();
          const deleted = await findDeletedMdbx2Object(this.client, binding.vaultHandle, ref.remoteFolderId, ref.remoteId!);
          if (!deleted) continue;
          if (deleted.headCommitId !== ref.revision || deleted.objectTypeId !== 'login' || deleted.payloadSchemaVersion !== 1) throw changed();
          deletedMembers.push(await prepareMdbx2RestoreRecord(this.client, source, provider));
        }
      }
      if (deletedMembers.length) {
        mixed = { members: deletedMembers, request: cancellation, cancellation: { sources,
          pendingDeletions: state.mutationQueue.filter(row => sources.some(source => source.id === row.itemId)) } };
      } else return this.vault.cancelPendingMdbx2ProjectDeletion(cancellation,sources,provider,async()=>{
        const existing=sources.filter(row=>row.providerRefs[0].remoteId);
        if(!existing.length) return;
        const binding=await readMdbx2TransferBinding(this.client,provider);
        const revision=await this.client.readWriteRevision(binding.vaultHandle);
        if(revision.vaultId!==binding.vaultId) throw changed();
        const folders=new Map<string,Set<string>>();
        for(const row of existing) {
          const ref=row.providerRefs[0];
          if(!ref.remoteId || !ref.remoteFolderId || !ref.revision) throw changed();
          const ids=folders.get(ref.remoteFolderId)||new Set<string>(); ids.add(ref.remoteId);folders.set(ref.remoteFolderId,ids);
        }
        const parents=new Set(folders.keys()),parentCursors=new Set<string>();
        let parentCursor:string|undefined,parentCount=0;
        do {
          const page=await this.client.listCollections(binding.vaultHandle,{pageSize:50,cursor:parentCursor});
          for(const folder of page.items){if(++parentCount>10_000)throw changed();if(!folder.deleted)parents.delete(folder.collectionId);}
          parentCursor=page.nextCursor;
          if(parentCursor && (!page.items.length || parentCursors.has(parentCursor) || parentCursors.size>=1_000))throw changed();
          if(parentCursor)parentCursors.add(parentCursor);
        }while(parentCursor && parents.size);
        if(parents.size)throw new Error('原目录已被删除，请先恢复目录后再恢复密码。');
        for(const [folder,ids] of folders) {
          let cursor:string|undefined;const cursors=new Set<string>();let scanned=0;
          do {
            const page=await this.client.listObjects(binding.vaultHandle,folder,{pageSize:50,cursor});
            for(const object of page.items) {
              if(++scanned>50_000) throw changed();
              if(!ids.has(object.objectId)) continue;
              const source=existing.find(row=>row.providerRefs[0].remoteId===object.objectId)!;
              if(object.deleted || object.objectTypeId!=='login' || object.payloadSchemaVersion!==1
                || object.collectionId!==folder || object.headCommitId!==source.providerRefs[0].revision) throw changed();
              ids.delete(object.objectId);
            }
            cursor=page.nextCursor;
            if(cursor && (!page.items.length || cursors.has(cursor) || cursors.size>=1_000)) throw changed();
            if(cursor)cursors.add(cursor);
          } while(cursor && ids.size);
          if(ids.size) throw new Error('数据库中的删除结果已变化，请先同步后再恢复。');
        }
        if(JSON.stringify(await this.client.readWriteRevision(binding.vaultHandle))!==JSON.stringify(revision)) throw changed();
      });
    }
    const capabilities = await this.client.hello();
    if (!capabilities.supportsObjectBatchRestore || !capabilities.supportsVaultWriteRevision) throw new Error('本机助手不支持整组恢复，请更新本机助手。');
    const members = mixed?.members || [];
    if (!mixed) for (const source of sources) members.push(await prepareMdbx2RestoreRecord(this.client, source, provider));
    await this.verifyInactiveProject(members, mixed?.cancellation?.sources);
    const revision = await this.client.readWriteRevision(String(provider.config.vaultHandle));
    if (members.some(member => member.intent.writeRevision.vaultId !== revision.vaultId
      || member.intent.writeRevision.revisionSha256 !== revision.revisionSha256)) throw changed();
    const record: Mdbx2RestoreBatchRecord = { version: 1, id: mixed?.request?.operationId || request?.operationId || crypto.randomUUID(), status: 'prepared', members,
      operationScope: '', ...(request ? { request } : {}), ...(mixed || {}) };
    record.operationScope = await mdbx2RestoreBatchScope(record);
    await this.vault.stageMdbx2RestoreBatch(record);
    return this.resume(record.id);
  }

  resume(operationId: string): Promise<VaultItem[]> {
    const pending = this.active.get(operationId);
    if (pending) return pending;
    const result = this.run(operationId).finally(() => this.active.delete(operationId));
    this.active.set(operationId, result); return result;
  }

  private async binding(record: Mdbx2RestoreBatchRecord) {
    const member = record.members[0], provider = await this.vault.getProvider(member.provider.id);
    if (!provider?.enabled || !sameProviderBinding(provider, member.provider) || provider.config.nativeVaultId !== member.provider.config.nativeVaultId) throw changed();
    return this.nativeBinding(record);
  }

  private async nativeBinding(record: Mdbx2RestoreBatchRecord) {
    const member = record.members[0];
    const actual = await readMdbx2TransferBinding(this.client, member.provider);
    if (actual.vaultId !== member.intent.writeRevision.vaultId || actual.vaultHandle !== member.provider.config.vaultHandle) throw changed();
    return actual;
  }

  private async run(operationId: string): Promise<VaultItem[]> {
    const cancelled=await this.vault.replayMdbx2DeletionCancellation(operationId);
    if(cancelled)return cancelled;
    let record = (await this.vault.readMdbx2RestoreBatches()).find(row => row.id === operationId);
    if (!record) throw new Error('找不到整组恢复记录。');
    await assertMdbx2RestoreBatchScope(record);
    if (record.status === 'completed') return this.vault.applyMdbx2RestoreBatch(record.id, record.operationScope, async () => { throw changed(); });
    const { vaultHandle: handle } = await this.binding(record);
    const status = await this.client.resolveObjectOperation(handle, record.operationScope);
    if (!status.committed) {
      const revision = await this.client.readWriteRevision(handle), original = record.members[0].intent.writeRevision;
      if (revision.vaultId !== original.vaultId) throw changed();
      if (revision.revisionSha256 !== original.revisionSha256) {
        for (const member of record.members) {
          const { intent } = member;
          const object = await readDeletedMdbx2Object(this.client, handle, intent.collectionId, intent.objectId);
          if (!object.deleted || object.payloadSchemaVersion !== 1 || object.headCommitId !== intent.expectedHeadCommitId
            || object.objectId !== intent.objectId || object.collectionId !== intent.collectionId || object.objectTypeId !== intent.objectTypeId) throw changed();
        }
        await this.verifyInactiveProject(record.members, record.cancellation?.sources);
        if ((await this.client.readWriteRevision(handle)).revisionSha256 !== revision.revisionSha256) throw changed();
        const previousScope = record.operationScope;
        record = structuredClone(record);
        for (const member of record.members) {
          member.intent.writeRevision = revision;
          member.intent.operationScope = await mdbx2RestoreScope(member);
        }
        record.operationScope = await mdbx2RestoreBatchScope(record);
        record = await this.vault.stageMdbx2RestoreBatch(record, previousScope);
      }
    }
    return this.vault.applyMdbx2RestoreBatch(record.id, record.operationScope, async saved => {
      // Service already revalidated the account under its lock. Do not reenter
      // that lock through getProvider/readState from this transaction callback.
      await this.nativeBinding(saved);
      const before = await this.client.resolveObjectOperation(handle, saved.operationScope);
      const send = () => this.client.restoreObjects(handle, saved.operationScope, mdbx2RestoreBatchInput(saved));
      let result;
      try { result = await send(); }
      catch (error) {
        const receipt = await this.client.resolveObjectOperation(handle, saved.operationScope);
        if (!receipt.known || !receipt.committed) throw error;
        result = await send();
        if (result.operationId !== receipt.operationId || result.commitId !== receipt.commitId) throw changed();
      }
      if (before.known && before.committed && (result.operationId !== before.operationId || result.commitId !== before.commitId)) throw changed();
      return result;
    });
  }

  private async verifyInactiveProject(members: Mdbx2RestoreBatchRecord['members'], allSources: LoginItem[] = []): Promise<void> {
    const { provider, source } = members[0], handle = String(provider.config.vaultHandle);
    if (source.kind !== 'login') throw changed();
    const ids = new Set(members.map(row => row.intent.objectId)), requiredFolders = new Set(members.map(row => row.intent.collectionId));
    const active = new Map(allSources.filter(row => row.providerRefs[0].remoteId && !ids.has(row.providerRefs[0].remoteId!))
      .map(row => [row.providerRefs[0].remoteId!, row]));
    for (const row of active.values()) requiredFolders.add(row.providerRefs[0].remoteFolderId!);
    const folders = new Set<string>(), objectIds = new Set<string>(), folderCursors = new Set<string>();
    let folderCursor: string | undefined;
    do {
      const page = await this.client.listCollections(handle, { pageSize: 50, cursor: folderCursor });
      for (const folder of page.items) {
        if (folder.deleted || folders.has(folder.collectionId) || folders.size >= 10_000) throw changed();
        folders.add(folder.collectionId);
        let cursor: string | undefined; const cursors = new Set<string>();
        do {
          const objects = await this.client.listObjects(handle, folder.collectionId, { pageSize: 50, cursor });
          for (const summary of objects.items) {
            if (summary.deleted || objectIds.has(summary.objectId) || objectIds.size >= 50_000 || ids.has(summary.objectId)) throw changed();
            objectIds.add(summary.objectId);
            const retained = active.get(summary.objectId);
            if (retained) {
              const ref = retained.providerRefs[0];
              if (summary.objectTypeId !== 'login' || summary.payloadSchemaVersion !== 1 || summary.collectionId !== ref.remoteFolderId
                || summary.collectionId !== folder.collectionId || summary.headCommitId !== ref.revision) throw changed();
              active.delete(summary.objectId); continue;
            }
            if (summary.objectTypeId !== 'login' || !source.passwordGroupId) continue;
            const object = await this.client.revealObject(handle, summary.objectId);
            const decoded = decodeMdbx2Object(object, summary, provider.id).item;
            if (!decoded || decoded.kind !== 'login' || object.deleted || object.objectId !== summary.objectId
              || object.collectionId !== folder.collectionId || object.headCommitId !== summary.headCommitId
              || decoded.passwordGroupId === source.passwordGroupId) throw changed();
          }
          cursor = objects.nextCursor;
          if (cursor && (!objects.items.length || cursors.has(cursor) || cursors.size >= 1_000)) throw changed();
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      folderCursor = page.nextCursor;
      if (folderCursor && (!page.items.length || folderCursors.has(folderCursor) || folderCursors.size >= 200)) throw changed();
      if (folderCursor) folderCursors.add(folderCursor);
    } while (folderCursor);
    if (active.size) throw changed();
    if ([...requiredFolders].some(folder => !folders.has(folder))) throw new Error('原文件夹已被删除，请先恢复文件夹，再恢复密码项目。');
  }
}
