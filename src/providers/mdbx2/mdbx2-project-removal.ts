import type { LoginItem, ProviderAccount } from '../../core/model';
import { sameProviderBinding } from '../../core/provider';
import { passwordProjectRemovalContent, type PasswordProjectNativeDeletionIntent, type PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { assertPasswordProjectNativeDeletionScope, passwordProjectNativeDeletionScope } from '../../core/password-project-removal-native';
import type { SecureVaultService } from '../../security/secure-vault-service';
import { preparePasswordProjectRemovalAttachments, verifyPasswordProjectRemovalAttachments } from '../attachments/password-project-removal-attachments';
import { mdbx2ProjectRemovalAttachments } from './mdbx2-project-removal-attachments';
import type { Mdbx2NativeClient } from './native-client';
import { MDBX2_MAX_OBJECT_BATCH_MUTATIONS, type Mdbx2ObjectBatchResult, type Mdbx2WriteRevision } from './native-contract';
import { Mdbx2Provider } from './mdbx2-provider';
import { decodeMdbx2Object } from './mdbx2-item-codec';
import { readMdbx2TransferBinding } from './mdbx2-transfer-verification';
import { Mdbx2RestoreCoordinator, prepareMdbx2RestoreRecord } from './mdbx2-restore';

const changed = () => new Error('密码项目或数据库在移除校验期间已变化，请重新检查恢复记录。');

/** Dedicated deletion path; the ordinary sync safety gate must remain enabled. */
export class Mdbx2PasswordProjectRemovalCoordinator {
  private readonly active = new Map<string, Promise<PasswordProjectRemovalRecord>>();
  constructor(private readonly client: Mdbx2NativeClient, private readonly vault: SecureVaultService,
    private readonly provider = new Mdbx2Provider(client)) {}

  resume(operationId: string): Promise<PasswordProjectRemovalRecord> {
    const existing = this.active.get(operationId);
    if (existing) return existing;
    const promise = this.run(operationId).catch(async error => {
      const current = (await this.vault.readPasswordProjectRemovals()).find(row => row.id === operationId);
      if (current?.status === 'cancelled') return current;
      throw error;
    }).finally(() => this.active.delete(operationId));
    this.active.set(operationId, promise); return promise;
  }

  private async run(operationId: string): Promise<PasswordProjectRemovalRecord> {
    let record = (await this.vault.readPasswordProjectRemovals()).find(row => row.id === operationId);
    if (!record) throw new Error('找不到密码项目移除操作。');
    if (record.status === 'cancelled') return record;
    if (record.status === 'completed') return this.finishRestores(record);
    const account = await this.account(record);
    if (record.removed.length > MDBX2_MAX_OBJECT_BATCH_MUTATIONS)
      throw new Error('单次原生事务最多移除 50 条密码，请分次编辑。');
    if (record.status === 'preparing') {
      const state = await this.vault.readState();
      const result = await this.provider.sync(account, { localItems: state.items, pendingMutations: state.mutationQueue,
        passwordProjectRemovals: state.passwordProjectRemovals, now: new Date().toISOString() });
      await this.vault.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, state.items,
        result.acknowledgedMutations, result.requestedMutations, result.adoptRemoteRemovals, [],
        { expectedAccount: account, confirmedRemovedItemIds: result.confirmedRemovedItemIds });
      const initial = await this.vault.inspectPasswordProjectRemoval(operationId);
      const prepared = await preparePasswordProjectRemovalAttachments(operationId, this.vault,
        mdbx2ProjectRemovalAttachments(this.client, account, initial.items));
      const acknowledged = { ...initial.record, retained: initial.record.retained.map(row => prepared.items.find(item => item.id === row.id)!),
        removed: initial.record.removed.map(row => prepared.items.find(item => item.id === row.id)!), proofs: prepared.proofs };
      const revision = await this.verify(acknowledged, account);
      const intent = await this.intent(acknowledged, account, revision);
      record = await this.vault.finalizePasswordProjectRemoval(operationId, prepared.items, prepared.proofs, intent);
    }
    if (record.status === 'cancelled') return record;
    if (!record.nativeDeletion) throw new Error('此恢复记录缺少原生删除请求，原密码已保留。');
    await assertPasswordProjectNativeDeletionScope(record);
    let intent = record.nativeDeletion.intent;
    await this.binding(account, intent);
    // A committed source may no longer be readable. Always resolve before verification.
    const resolution = await this.client.resolveObjectOperation(intent.vaultHandle, intent.operationScope);
    if (resolution.known && resolution.committed) {
      const completed = await this.vault.acknowledgeCommittedPasswordProjectDeletion(operationId, intent.operationScope, async (saved, pending) => {
        const request = saved.nativeDeletion!.intent;
        await this.binding(account, request);
        const status = await this.client.resolveObjectOperation(request.vaultHandle, request.operationScope);
        if (!status.known || !status.committed) throw new Error('原删除操作尚未确认提交，不能按已提交结果恢复。');
        const result = await this.submit(request);
        if (!result.alreadyCommitted || result.operationId !== status.operationId || result.commitId !== status.commitId) throw changed();
        const provider = saved.providerBindings.find(row => row.id === request.providerId)!;
        const restores = [];
        for (const reapply of pending) {
          const original = saved.removed.find(row => row.id === reapply.item.id)!;
          const source = { ...original, deletedAt: saved.nativeDeletion!.deletedAt, updatedAt: saved.nativeDeletion!.deletedAt,
            providerRefs: original.providerRefs.map(ref => ref.providerId === request.providerId ? { ...ref, revision: result.commitId } : ref) };
          restores.push(await prepareMdbx2RestoreRecord(this.client, source, provider, reapply));
        }
        return { result, restores };
      });
      return this.finishRestores(completed);
    }
    if (!resolution.committed) {
      const revision = await this.client.readWriteRevision(intent.vaultHandle);
      if (!sameRevision(revision, intent.writeRevision)) {
        record = await this.vault.replacePasswordProjectNativeDeletionIntent(operationId, intent.operationScope, async saved => {
          const old = saved.nativeDeletion!.intent;
          await this.binding(account, old);
          const status = await this.client.resolveObjectOperation(old.vaultHandle, old.operationScope);
          if (status.committed) throw new Error('原删除请求已提交，请重试以确认原回执。');
          const verified = await this.verify(saved, account);
          return this.intent(saved, account, verified);
        });
        intent = record.nativeDeletion!.intent;
      }
    }
    return this.vault.applyPasswordProjectNativeDeletion(operationId, intent.operationScope, async saved => {
      const pending = saved.nativeDeletion!.intent;
      await this.binding(account, pending);
      const status = await this.client.resolveObjectOperation(pending.vaultHandle, pending.operationScope);
      if (!status.committed) {
        const verified = await this.verify(saved, account);
        if (!sameRevision(verified, pending.writeRevision)) throw changed();
      }
      const result = await this.submit(pending);
      if (status.known && status.committed && (result.operationId !== status.operationId || result.commitId !== status.commitId)) throw changed();
      return result;
    });
  }

  private async finishRestores(record: PasswordProjectRemovalRecord): Promise<PasswordProjectRemovalRecord> {
    const restores = (await this.vault.readMdbx2Restores()).filter(row => row.status === 'prepared' && row.reapply?.deletionOperationId === record.id);
    const coordinator = new Mdbx2RestoreCoordinator(this.client, this.vault);
    for (const restore of restores) await coordinator.restore(restore.source.id);
    return record;
  }

  private async account(record: PasswordProjectRemovalRecord): Promise<ProviderAccount> {
    const external = record.providerBindings.filter(row => row.kind !== 'local');
    if (external.length !== 1 || external[0].kind !== 'mdbx2') throw new Error('此移除流程需要单个 MDBX2 密码源。');
    const account = await this.vault.getProvider(external[0].id);
    if (!account?.enabled || !sameProviderBinding(account, external[0]) || account.config.nativeVaultId !== external[0].config.nativeVaultId) throw changed();
    return account;
  }

  private async binding(account: ProviderAccount, intent: PasswordProjectNativeDeletionIntent): Promise<void> {
    const binding = await readMdbx2TransferBinding(this.client, account);
    if (binding.vaultHandle !== intent.vaultHandle || binding.vaultId !== intent.writeRevision.vaultId) throw changed();
  }

  private async intent(record: PasswordProjectRemovalRecord, account: ProviderAccount, writeRevision: Mdbx2WriteRevision): Promise<PasswordProjectNativeDeletionIntent> {
    const intent: PasswordProjectNativeDeletionIntent = { version: 1, providerId: account.id, vaultHandle: String(account.config.vaultHandle), writeRevision,
      operationScope: '', mutations: record.removed.map(row => {
        const ref = row.providerRefs.find(ref => ref.providerId === account.id);
        if (!ref?.remoteId || !ref.revision) throw changed();
        return { kind: 'delete' as const, logicalObjectId: `native:${ref.remoteId}`, expectedHeadCommitId: ref.revision };
      }).sort((a, b) => a.logicalObjectId.localeCompare(b.logicalObjectId)) };
    intent.operationScope = await passwordProjectNativeDeletionScope(record, intent);
    return intent;
  }

  private async submit(intent: PasswordProjectNativeDeletionIntent): Promise<Mdbx2ObjectBatchResult> {
    const send = () => this.client.mutateObjects(intent.vaultHandle, intent.operationScope, intent.mutations, 120_000, intent.writeRevision);
    try { return await send(); }
    catch (error) {
      const receipt = await this.client.resolveObjectOperation(intent.vaultHandle, intent.operationScope);
      if (!receipt.known || !receipt.committed) throw error;
      const replay = await send();
      if (replay.operationId !== receipt.operationId || replay.commitId !== receipt.commitId) throw changed();
      return replay;
    }
  }

  private async verify(record: PasswordProjectRemovalRecord, account: ProviderAccount): Promise<Mdbx2WriteRevision> {
    const binding = await readMdbx2TransferBinding(this.client, account);
    const revision = await this.client.readWriteRevision(binding.vaultHandle);
    if (revision.vaultId !== binding.vaultId) throw changed();
    const expected = [...record.retained, ...record.removed];
    await verifyMembers(this.client, binding.vaultHandle, account.id, expected);
    await verifyPasswordProjectRemovalAttachments(record, record.proofs || [], mdbx2ProjectRemovalAttachments(this.client, account, expected));
    if (!sameRevision(revision, await this.client.readWriteRevision(binding.vaultHandle))) throw changed();
    return revision;
  }
}

function sameRevision(left: Mdbx2WriteRevision, right: Mdbx2WriteRevision): boolean {
  return left.vaultId === right.vaultId && left.revisionSha256 === right.revisionSha256;
}

/** Scan across folders: a new group member cannot be ruled out by checking known row heads alone. */
async function verifyMembers(client: Mdbx2NativeClient, handle: string, providerId: string, expected: LoginItem[]): Promise<void> {
  const byRemote = new Map(expected.map(row => [row.providerRefs.find(ref => ref.providerId === providerId)?.remoteId, row]));
  if (byRemote.has(undefined) || byRemote.size !== expected.length) throw changed();
  const found = new Set<string>(), collections = new Set<string>(), objects = new Set<string>();
  let collectionCursor: string | undefined; const collectionCursors = new Set<string>();
  do {
    const page = await client.listCollections(handle, { pageSize: 50, cursor: collectionCursor });
    for (const collection of page.items) {
      if (collection.deleted || collections.has(collection.collectionId) || collections.size >= 10_000) throw changed();
      collections.add(collection.collectionId);
      let cursor: string | undefined; const cursors = new Set<string>();
      do {
        const entries = await client.listObjects(handle, collection.collectionId, { pageSize: 50, cursor });
        for (const summary of entries.items) {
          if (summary.deleted || objects.has(summary.objectId) || objects.size >= 50_000) throw changed();
          objects.add(summary.objectId);
          const expectedRow = byRemote.get(summary.objectId);
          if (summary.objectTypeId !== 'login') { if (expectedRow) throw changed(); continue; }
          const object = await client.revealObject(handle, summary.objectId);
          const decoded = decodeMdbx2Object(object, summary, providerId).item;
          if (!decoded || decoded.kind !== 'login' || object.deleted || object.headCommitId !== summary.headCommitId) throw changed();
          if (expectedRow) {
            const ref = expectedRow.providerRefs.find(ref => ref.providerId === providerId)!;
            if (object.objectId !== ref.remoteId || object.collectionId !== ref.remoteFolderId || object.headCommitId !== ref.revision
              || decoded.passwordGroupId !== expectedRow.passwordGroupId
              || passwordProjectRemovalContent({ ...decoded, id: expectedRow.id, createdAt: expectedRow.createdAt, favorite: expectedRow.favorite })
                !== passwordProjectRemovalContent(expectedRow)) throw changed();
            found.add(object.objectId);
          } else if (decoded.passwordGroupId === expected[0].passwordGroupId) throw changed();
        }
        cursor = entries.nextCursor;
        if (cursor && (!entries.items.length || cursors.has(cursor) || cursors.size >= 1_000)) throw changed();
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    collectionCursor = page.nextCursor;
    if (collectionCursor && (!page.items.length || collectionCursors.has(collectionCursor) || collectionCursors.size >= 200)) throw changed();
    if (collectionCursor) collectionCursors.add(collectionCursor);
  } while (collectionCursor);
  if (found.size !== expected.length) throw changed();
}
