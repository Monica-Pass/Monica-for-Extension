import type { ProviderAccount, VaultItem } from '../../core/model';
import { sameProviderBinding } from '../../core/provider';
import { assertMdbx2RestoreScope, mdbx2RestoreScope, type Mdbx2RestoreRecord } from '../../core/mdbx2-restore-journal';
import type { SecureVaultService } from '../../security/secure-vault-service';
import type { Mdbx2NativeClient } from './native-client';
import { readMdbx2TransferBinding } from './mdbx2-transfer-verification';

const changed = () => new Error('MDBX 恢复期间项目或密码源已变化，原始内容已保留。');

/** Restores the existing native object; never reconstructs its payload or attachments. */
export class Mdbx2RestoreCoordinator {
  private readonly active = new Map<string, Promise<VaultItem>>();
  constructor(private readonly client: Mdbx2NativeClient, private readonly vault: SecureVaultService) {}

  restore(itemId: string): Promise<VaultItem> {
    const existing = this.active.get(itemId);
    if (existing) return existing;
    const result = this.run(itemId).finally(() => this.active.delete(itemId));
    this.active.set(itemId, result); return result;
  }

  private async run(itemId: string): Promise<VaultItem> {
    let record = (await this.vault.readMdbx2Restores()).find(entry => entry.source.id === itemId && entry.status === 'prepared');
    if (!record) {
      const state = await this.vault.readState(), source = state.items.find(item => item.id === itemId);
      if (!source) throw new Error('回收站项目不存在。');
      if (!source.deletedAt) return source;
      const external = source.providerRefs.flatMap(ref => state.providers.filter(provider => provider.id === ref.providerId && provider.kind !== 'local'));
      if (!external.some(provider => provider.kind === 'mdbx2')) return this.vault.restoreItem(itemId);
      if (external.length !== 1 || external[0].kind !== 'mdbx2' || source.kind === 'opaque') throw new Error('此项目暂不支持原生恢复，请保留原始备份。');
      const provider = external[0], ref = source.providerRefs.find(ref => ref.providerId === provider.id)!;
      const queuedDelete = state.mutationQueue.find(row => row.itemId === itemId && row.providerId === provider.id && row.operation === 'delete');
      let nativeTombstone = false;
      if (ref.remoteId && queuedDelete) {
        if (!ref.remoteFolderId || !ref.revision) throw changed();
        const binding = await readMdbx2TransferBinding(this.client, provider);
        const object = await findDeletedMdbx2Object(this.client, binding.vaultHandle, ref.remoteFolderId, ref.remoteId);
        if (object) {
          if (!object.deleted || object.payloadSchemaVersion !== 1 || object.collectionId !== ref.remoteFolderId
            || object.headCommitId !== ref.revision) throw changed();
          nativeTombstone = true;
        }
      }
      if (!ref.remoteId || queuedDelete && !nativeTombstone) {
        return this.vault.cancelPendingMdbx2Deletion(source, provider, async () => {
          if (!ref.remoteId) return;
          const binding = await readMdbx2TransferBinding(this.client, provider);
          const revision = await this.client.readWriteRevision(binding.vaultHandle);
          const object = await this.client.revealObject(binding.vaultHandle, ref.remoteId);
          if (revision.vaultId !== binding.vaultId || object.deleted || object.payloadSchemaVersion !== 1
            || object.objectId !== ref.remoteId || object.collectionId !== ref.remoteFolderId || object.headCommitId !== ref.revision
            || JSON.stringify(await this.client.readWriteRevision(binding.vaultHandle)) !== JSON.stringify(revision))
            throw new Error('删除结果尚未确认，请先同步后再恢复。');
        });
      }
      if (!ref.remoteId || !ref.remoteFolderId || !ref.revision) throw changed();
      record = await prepareMdbx2RestoreRecord(this.client, source, provider);
      if (queuedDelete) {
        record.supersededDeletion = structuredClone(queuedDelete);
        record.intent.operationScope = await mdbx2RestoreScope(record);
      }
      record = await this.vault.stageMdbx2Restore(record);
    }
    await assertMdbx2RestoreScope(record);
    const current = await this.vault.getProvider(record.provider.id);
    if (!current?.enabled || !sameProviderBinding(current, record.provider) || current.config.nativeVaultId !== record.provider.config.nativeVaultId) throw changed();
    await this.verifyBinding(current, record);
    const handle = String(current.config.vaultHandle);
    const status = await this.client.resolveObjectOperation(handle, record.intent.operationScope);
    if (!status.committed) {
      const revision = await this.client.readWriteRevision(handle);
      if (revision.revisionSha256 !== record.intent.writeRevision.revisionSha256) {
        const object = await this.deletedObject(handle, record.intent.collectionId, record.intent.objectId);
        if (!object.deleted || object.payloadSchemaVersion !== 1 || object.objectId !== record.intent.objectId
          || object.collectionId !== record.intent.collectionId || object.objectTypeId !== record.intent.objectTypeId
          || object.headCommitId !== record.intent.expectedHeadCommitId || revision.vaultId !== record.intent.writeRevision.vaultId) throw changed();
        const oldScope = record.intent.operationScope;
        record = { ...record, intent: { ...record.intent, writeRevision: revision } };
        record.intent.operationScope = await mdbx2RestoreScope(record);
        record = await this.vault.stageMdbx2Restore(record, oldScope);
      }
    }
    return this.vault.applyMdbx2Restore(record.id, record.intent.operationScope, async saved => {
      await this.verifyBinding(current, saved);
      const before = await this.client.resolveObjectOperation(handle, saved.intent.operationScope);
      const send = () => this.client.restoreObject(handle, saved.intent.operationScope, saved.intent);
      let result;
      try { result = await send(); }
      catch (error) {
        const receipt = await this.client.resolveObjectOperation(handle, saved.intent.operationScope);
        if (!receipt.known || !receipt.committed) throw error;
        result = await send();
        if (result.operationId !== receipt.operationId || result.commitId !== receipt.commitId) throw changed();
      }
      if (before.known && before.committed && (result.operationId !== before.operationId || result.commitId !== before.commitId)) throw changed();
      return result;
    });
  }

  private async verifyBinding(account: ProviderAccount, record: Mdbx2RestoreRecord) {
    const actual = await readMdbx2TransferBinding(this.client, account);
    if (actual.vaultId !== record.intent.writeRevision.vaultId || actual.vaultHandle !== record.provider.config.vaultHandle) throw changed();
  }

  private async deletedObject(handle: string, collectionId: string, objectId: string) {
    return readDeletedMdbx2Object(this.client, handle, collectionId, objectId);
  }
}

export async function prepareMdbx2RestoreRecord(client: Mdbx2NativeClient, source: VaultItem, provider: ProviderAccount,
  reapply?: Mdbx2RestoreRecord['reapply']): Promise<Mdbx2RestoreRecord> {
  const ref = source.providerRefs.find(row => row.providerId === provider.id);
  if (!source.deletedAt || !ref?.remoteId || !ref.remoteFolderId || !ref.revision) throw changed();
  const binding = await readMdbx2TransferBinding(client, provider);
  const revision = await client.readWriteRevision(binding.vaultHandle);
  const object = await readDeletedMdbx2Object(client, binding.vaultHandle, ref.remoteFolderId, ref.remoteId);
  if (!object.deleted || object.payloadSchemaVersion !== 1 || object.objectId !== ref.remoteId || object.collectionId !== ref.remoteFolderId
    || object.headCommitId !== ref.revision || revision.vaultId !== binding.vaultId) throw changed();
  const record: Mdbx2RestoreRecord = { version: 1, id: crypto.randomUUID(), status: 'prepared', source, provider,
    ...(reapply ? { reapply } : {}), intent: { objectId: object.objectId, collectionId: object.collectionId, objectTypeId: object.objectTypeId,
      expectedHeadCommitId: ref.revision, writeRevision: revision, operationScope: '' } };
  record.intent.operationScope = await mdbx2RestoreScope(record);
  return record;
}

export async function readDeletedMdbx2Object(client: Mdbx2NativeClient, handle: string, collectionId: string, objectId: string) {
  const object = await findDeletedMdbx2Object(client, handle, collectionId, objectId);
  if (!object) throw changed();
  return object;
}

export async function findDeletedMdbx2Object(client: Mdbx2NativeClient, handle: string, collectionId: string, objectId: string) {
  let cursor: string | undefined;
  const seen = new Set<string>(); let scanned = 0;
  do {
    const page = await client.listObjects(handle, collectionId, { deleted: true, pageSize: 50, cursor });
    scanned += page.items.length;
    if (scanned > 50_000) throw changed();
    const found = page.items.find(row => row.objectId === objectId);
    if (found) return found;
    cursor = page.nextCursor;
    if (cursor && (!page.items.length || seen.has(cursor) || seen.size >= 1_000)) throw changed();
    if (cursor) seen.add(cursor);
  } while (cursor);
  return undefined;
}
