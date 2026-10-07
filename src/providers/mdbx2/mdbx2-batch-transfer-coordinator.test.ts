import { readProjectCredential } from '../../core/project-credentials';
import { describe, expect, it } from "vitest";
import { createLoginItem, type ProviderAccount, type VaultItem } from "../../core/model";
import type { ProviderAdapter } from "../../core/provider";
import { SecureVaultService } from "../../security/secure-vault-service";
import { MemoryVaultSessionStore } from "../../security/vault-session";
import { MemoryVaultStorage } from "../../security/vault-storage";
import type { VaultEnvelope } from "../../security/vault-crypto";
import {
  Mdbx2BatchTransferCoordinator,
  mdbx2TransferRequestHash,
  type Mdbx2BatchTransferAttachmentBridge,
  type Mdbx2BatchTransferNativeClient,
  type Mdbx2BatchTransferProgress,
  type Mdbx2BatchTransferProviderRegistry
} from "./mdbx2-batch-transfer-coordinator";
import { Mdbx2Provider, type Mdbx2RuntimeClient } from "./mdbx2-provider";
import type {
  Mdbx2CollectionMutationResult,
  Mdbx2CollectionSummary,
  Mdbx2ObjectBatchResult,
  Mdbx2ObjectMutationInput,
  Mdbx2ObjectOperationResolution,
  Mdbx2ObjectRecord,
  Mdbx2ObjectSummary,
  Mdbx2ObjectUpsertInput,
  Mdbx2ObjectWriteResult
} from "./native-contract";

const TARGET_HANDLE = "11111111-1111-4111-8111-111111111111";
const SOURCE_HANDLE = "22222222-2222-4222-8222-222222222222";
const TARGET_COLLECTION = "33333333-3333-4333-8333-333333333333";
const SOURCE_COLLECTION = "44444444-4444-4444-8444-444444444444";
const SOURCE_OBJECT = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const OPERATION_TIME = "2026-08-06T12:00:00.000Z";

class FakeNative implements Mdbx2BatchTransferNativeClient, Mdbx2RuntimeClient {
  readonly collections = new Map<string, Mdbx2CollectionSummary[]>();
  readonly records = new Map<string, Mdbx2ObjectRecord>();
  readonly scopes: string[] = [];
  readonly batches: Mdbx2ObjectMutationInput[][] = [];
  readonly deleted: Array<{ vaultHandle: string; logicalObjectId: string }> = [];
  readonly events: string[] = [];
  private readonly committed = new Map<string, Mdbx2ObjectBatchResult>();
  loseNextBatchResponse = false;
  afterDeleteBatch?: () => void;
  private objectCounter = 0;

  constructor() {
    this.collections.set(TARGET_HANDLE, [summary(TARGET_COLLECTION, "Target")]);
    this.collections.set(SOURCE_HANDLE, [summary(SOURCE_COLLECTION, "Source")]);
  }

  async vaultStatus(vaultHandle: string) { return { vaultHandle, open: true, available: true, vaultId: `vault-${vaultHandle}` }; }

  async listCollections(vaultHandle: string) {
    return { items: (this.collections.get(vaultHandle) || []).map((item) => ({ ...item })) };
  }

  async createCollection(
    vaultHandle: string,
    operationId: string,
    collectionId: string,
    title: string,
    parentCollectionId?: string
  ): Promise<Mdbx2CollectionMutationResult> {
    const list = this.collections.get(vaultHandle) || [];
    let collection = list.find((item) => item.collectionId === collectionId);
    const alreadyCommitted = Boolean(collection);
    if (!collection) {
      collection = summary(collectionId, title, parentCollectionId);
      list.push(collection);
      this.collections.set(vaultHandle, list);
    }
    this.events.push(`collection:${title}`);
    return { operationId, commitId: collection.headCommitId, alreadyCommitted, collection: { ...collection } };
  }

  async listObjects(_vaultHandle: string, collectionId: string) {
    const items: Mdbx2ObjectSummary[] = [...this.records.values()]
      .filter((record) => record.collectionId === collectionId && !record.deleted)
      .map((record) => ({
        objectId: record.objectId,
        collectionId: record.collectionId,
        objectTypeId: record.objectTypeId,
        title: record.title,
        payloadSchemaVersion: 1,
        headCommitId: "commit-existing",
        deleted: false,
        updatedAt: OPERATION_TIME
      }));
    return { items };
  }

  async revealObject(_vaultHandle: string, objectId: string): Promise<Mdbx2ObjectRecord> {
    const record = this.records.get(objectId);
    if (!record) throw new Error("object missing");
    return { ...record };
  }

  async upsertObject(_vaultHandle: string, _operationId: string, input: Mdbx2ObjectUpsertInput): Promise<Mdbx2ObjectWriteResult> {
    const result = await this.mutateObjects(TARGET_HANDLE, "aa".repeat(32), [{ kind: "upsert", ...input }]);
    const written = result.items[0];
    if (written.kind !== "upsert" || !result.commitId || !written.collectionId || !written.objectTypeId) throw new Error("invalid fake write");
    return { commitId: result.commitId, alreadyCommitted: false, logicalObjectId: written.logicalObjectId, objectId: written.objectId, collectionId: written.collectionId, objectTypeId: written.objectTypeId };
  }

  async mutateObjects(vaultHandle: string, operationScope: string, mutations: Mdbx2ObjectMutationInput[]): Promise<Mdbx2ObjectBatchResult> {
    this.scopes.push(operationScope);
    this.batches.push(mutations);
    const previous = this.committed.get(operationScope);
    if (previous) return { ...previous, alreadyCommitted: true, items: previous.items.map((item) => ({ ...item })) };
    const items = mutations.map((mutation) => {
      if (mutation.kind === "delete") {
        const objectId = mutation.logicalObjectId.slice(7), record = this.records.get(objectId);
        if (!record) throw new Error("source object missing");
        record.deleted = true;
        this.deleted.push({vaultHandle, logicalObjectId: mutation.logicalObjectId});
        this.events.push(`delete:${mutation.logicalObjectId}`);
        return {kind: "delete" as const, changed: true, logicalObjectId: mutation.logicalObjectId, objectId};
      }
      const payload = JSON.parse(mutation.payloadJson) as Record<string, unknown>;
      const existing = mutation.logicalObjectId.startsWith("native:") ? this.records.get(mutation.logicalObjectId.slice(7)) : [...this.records.values()].find((record) => {
        if (record.collectionId !== mutation.collectionId) return false;
        try { return JSON.parse(record.payloadJson).monica_entry_id === mutation.logicalObjectId; } catch { return false; }
      });
      const objectId = existing?.objectId || objectIdFor(++this.objectCounter);
      this.records.set(objectId, {
        objectId,
        collectionId: mutation.collectionId || TARGET_COLLECTION,
        objectTypeId: mutation.objectTypeId,
        title: mutation.title,
        payloadJson: JSON.stringify(payload),
        payloadSchemaVersion: 1,
        headCommitId: `commit-${this.committed.size + 1}`,
        deleted: false
      });
      return { kind: "upsert" as const, changed: !existing, logicalObjectId: mutation.logicalObjectId, objectId, collectionId: mutation.collectionId || TARGET_COLLECTION, objectTypeId: mutation.objectTypeId };
    });
    const result: Mdbx2ObjectBatchResult = { changed: true, operationId: OPERATION_ID, commitId: `commit-${this.committed.size + 1}`, alreadyCommitted: false, items };
    this.committed.set(operationScope, result);
    if (mutations.every(mutation => mutation.kind === "delete")) this.afterDeleteBatch?.();
    this.events.push(`batch:${mutations.length}`);
    if (this.loseNextBatchResponse) {
      this.loseNextBatchResponse = false;
      throw new Error("Native Host response lost");
    }
    return result;
  }

  async resolveObjectOperation(_vaultHandle: string, operationScope: string): Promise<Mdbx2ObjectOperationResolution> {
    const result = this.committed.get(operationScope);
    return result?.commitId
      ? { known: true, committed: true, operationId: result.operationId, commitId: result.commitId }
      : { known: false, committed: false };
  }

  async deleteObject(vaultHandle: string, _operationId: string, logicalObjectId: string) {
    this.deleted.push({ vaultHandle, logicalObjectId });
    this.events.push(`delete:${logicalObjectId}`);
    const record = [...this.records.values()].find((candidate) => {
      try { return logicalObjectId === `native:${candidate.objectId}` || JSON.parse(candidate.payloadJson).monica_entry_id === logicalObjectId; } catch { return false; }
    });
    if (record) record.deleted = true;
    return { changed: Boolean(record), commitId: "commit-delete", alreadyCommitted: false, logicalObjectId, objectId: record?.objectId || SOURCE_OBJECT };
  }

  async listAttachments() { return { items: [] as const }; }
  async beginAttachmentRead(): Promise<never> { throw new Error("no attachments in this fake"); }
  async readAttachmentChunk(): Promise<never> { throw new Error("no attachments in this fake"); }
  async releaseAttachmentRead() { return true; }
  async beginAttachmentUpload(): Promise<never> { throw new Error("no attachments in this fake"); }
  async sendAttachmentUploadChunk(): Promise<never> { throw new Error("no attachments in this fake"); }
  async finishAttachmentUpload(): Promise<never> { throw new Error("no attachments in this fake"); }
  async abortAttachmentUpload() { return true; }

  addSourceRecord(item: VaultItem): void {
    this.records.set(SOURCE_OBJECT, {
      objectId: SOURCE_OBJECT,
      collectionId: SOURCE_COLLECTION,
      objectTypeId: "login",
      title: item.title,
      payloadJson: JSON.stringify({
        kind: "password",
        monica_entry_id: item.replicaGroupId,
        room_id: 7,
        website: item.kind === "login" ? item.uris.join("\n") : "",
        username: item.kind === "login" ? item.username : "",
        password_plain: item.kind === "login" ? item.password : "",
        future_field: { preserved: true }
      }),
      payloadSchemaVersion: 1,
      headCommitId: item.providerRefs[0]?.revision,
      deleted: false
    });
  }
}

class EmptyRegistry implements Mdbx2BatchTransferProviderRegistry {
  get(): ProviderAdapter { throw new Error("unexpected provider adapter"); }
}

const noAttachments: Mdbx2BatchTransferAttachmentBridge = {
  async listSourceAttachments() { return []; },
  async transferAttachments() { return 0; }
};

describe("MDBX2 batch transfer coordinator", () => {
  it.each(['copy', 'move'] as const)("blocks %s of password history before creating target folders or deleting sources", async action => {
    const { service, target } = await setupVault();
    const first = await service.upsertItem({ ...createLoginItem({ title: 'History project' }), passwordGroupId: 'history-project' });
    const history = [{ password: 'synthetic old 密码\r\n', lastUsedAt: '1970-01-01T00:00:00.000Z' }];
    const second = await service.upsertItem({ ...createLoginItem({ title: 'History member' }), passwordGroupId: 'history-project', passwordHistory: history, categoryName: 'Must not create' });
    const before = await service.readState();
    const native = new FakeNative();
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, noAttachments);
    const request = { itemIds: [first.id], targetProviderId: target.id, action, confirmed: true, preserveCategories: true, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME };
    const plan = await coordinator.plan(request);
    expect(plan.blockedCount).toBe(2);
    expect(plan.items.find(item => item.sourceItemId === second.id)?.blockedReason).toContain('密码历史');
    expect(plan.transferableCount).toBe(0);
    const result = await coordinator.execute(request);
    expect(result.blockedCount).toBe(2);
    expect(result.completedCount).toBe(0);
    expect(native.events).toEqual([]);
    expect(native.batches).toEqual([]);
    expect(native.deleted).toEqual([]);
    expect(await service.readState()).toEqual(before);
  });

  it('blocks an incomplete empty history before any target side effect', async () => {
    const { service, target } = await setupVault();
    const source = await service.upsertItem({ ...createLoginItem({ title: 'Unreadable history' }), passwordHistory: [], passwordHistoryIncomplete: true, categoryName: 'Must not create' });
    const native = new FakeNative();
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, noAttachments);
    const result = await coordinator.execute({ itemIds: [source.id], targetProviderId: target.id, action: 'copy', preserveCategories: true });
    expect(result.blockedCount).toBe(1);
    expect(result.items[0].error).toContain('密码历史');
    expect(native.events).toEqual([]);
    expect(await service.getItem(source.id)).toEqual(source);
  });

  it.each(["lost write response", "attachment interruption", "promotion persistence"])("replays frozen write intent after restart: %s", async phase => {
    const { service, target, storage } = await setupVault();
    const sourceProvider: ProviderAccount = { ...target, id: 'mdbx-source', config: { vaultHandle: SOURCE_HANDLE } };
    await service.upsertProvider(sourceProvider);
    const source = await importNativeItem(service, { ...createLoginItem({ title: 'Frozen intent', password: 'synthetic' }),
      replicaGroupId: 'password:frozen', mdbxFolderId: SOURCE_COLLECTION,
      providerRefs: [{ providerId: sourceProvider.id, remoteId: SOURCE_OBJECT, remoteFolderId: SOURCE_COLLECTION, revision: 'source-commit' }] });
    const native = new FakeNative(); native.addSourceRecord(source);
    const original = native.records.get(SOURCE_OBJECT)!;
    original.payloadJson = original.payloadJson.replace(/}$/, ',"future_integer":9223372036854775807,"future_decimal":1.000000000000000001}');
    let fail = true;
    const attachments = { ...noAttachments, async transferAttachments() {
      if (phase === 'attachment interruption' && fail) { fail = false; throw new Error('Synthetic early interruption'); }
      return 0;
    } };
    if (phase === 'lost write response') {
      native.loseNextBatchResponse = true;
      const resolve = native.resolveObjectOperation.bind(native);
      native.resolveObjectOperation = async (...args) => { if (fail) { fail = false; throw new Error('Synthetic host exit'); } return resolve(...args); };
    }
    if (phase === 'promotion persistence') service.prepareMdbx2MoveFinalization = async record => {
      if (fail) { fail = false; storage.failNext = true; }
      await SecureVaultService.prototype.prepareMdbx2MoveFinalization.call(service, record);
    };
    const request = { itemIds: [source.id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: 'move' as const, confirmed: true, preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME };
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    expect((await coordinator.execute(request)).failedCount).toBe(1);
    expect(native.deleted).toHaveLength(0);
    const [writing] = await service.readMdbx2MoveFinalizations();
    expect(writing.status).toBe('writing');
    expect(writing.writeIntent?.entries[0].originalPayloadJson).toContain('9223372036854775807');
    const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore()); await restarted.unlock('coordinator password');
    const resumed = new Mdbx2BatchTransferCoordinator(restarted, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    expect((await resumed.pendingMoves())[0].request).toBeDefined();
    const targetRecord = [...native.records.values()].find(item => item.collectionId === TARGET_COLLECTION)!;
    const revision = targetRecord.headCommitId;
    targetRecord.headCommitId = 'concurrent-target-edit';
    expect((await resumed.execute(request)).failedCount).toBe(1);
    expect(native.deleted).toHaveLength(0);
    targetRecord.headCommitId = revision;
    const result = await resumed.execute(request);
    expect(result.completedCount, JSON.stringify(result)).toBe(1);
    expect(native.deleted).toHaveLength(1);
    const writes = native.batches.filter(batch => batch[0].kind === 'upsert');
    expect(writes.length).toBeGreaterThan(1);
    for (const batch of writes) expect(batch).toEqual(writes[0]);
    expect(JSON.stringify(writes[0])).toContain('9223372036854775807');
    expect(JSON.stringify(writes[0])).toContain('1.000000000000000001');
    expect((await restarted.readMdbx2MoveFinalizations())[0].status).toBe('completed');
    const calls = native.batches.length;
    expect((await resumed.execute(request)).completedCount).toBe(1);
    expect(native.batches).toHaveLength(calls);
  });
  it.each(["preparation", "adoption"])("resumes independent components after %s failure with the original request identity", async phase => {
    const { service, target, storage } = await setupVault();
    const first = await service.upsertItem(createLoginItem({ title: "First independent" }));
    const second = await service.upsertItem(createLoginItem({ title: "Second independent" }));
    const native = new FakeNative();
    let fail = true;
    const attachments = { ...noAttachments, async listSourceAttachments(_account: ProviderAccount, item: VaultItem) {
      if (phase === "preparation" && item.id === first.id && fail) { fail = false; throw new Error("Synthetic preparation interruption"); }
      return [];
    } };
    if (phase === "adoption") service.stageMdbx2MoveFinalization = async record => {
      await SecureVaultService.prototype.stageMdbx2MoveFinalization.call(service, record);
      if (record.entries[0].expected.id === first.id && fail) { fail = false; storage.failNext = true; }
    };
    const request = { itemIds: [first.id, second.id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: "move" as const, confirmed: true, preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME };
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    const initial = await coordinator.execute(request);
    expect(initial.completedCount, JSON.stringify(initial)).toBe(1); expect(initial.failedCount).toBe(1);
    const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore()); await restarted.unlock("coordinator password");
    const resumed = new Mdbx2BatchTransferCoordinator(restarted, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    const pending = await resumed.pendingMoves();
    expect(pending).toHaveLength(phase === "adoption" ? 1 : 0);
    if (phase === "adoption") {
      expect(pending[0].request).toEqual({ ...request, itemIds: request.itemIds.slice().sort(), confirmed: undefined });
      expect(JSON.stringify(pending)).not.toContain('"password":');
    }
    const result = await resumed.execute(request);
    expect(result.completedCount).toBe(2); expect(result.failedCount).toBe(0);
    const records = await restarted.readMdbx2MoveFinalizations(OPERATION_ID);
    expect(records).toHaveLength(2);
    expect(new Set(records.map(record => record.requestHash)).size).toBe(1);
    expect(records.every(record => record.status === "completed")).toBe(true);
    expect(await resumed.pendingMoves()).toEqual([]);
    expect((await resumed.execute({ ...request, itemIds: [second.id, first.id] })).completedCount).toBe(2);
  });
  it("binds saved move intent to all destination choices while allowing selection reorder", async () => {
    const request = { itemIds: ["a", "b"], targetProviderId: "target", targetCollectionId: TARGET_COLLECTION,
      action: "move" as const, preserveCategories: true, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME };
    const hash = await mdbx2TransferRequestHash(request);
    expect(await mdbx2TransferRequestHash({ ...request, itemIds: ["b", "a"], confirmed: true })).toBe(hash);
    for (const change of [{ itemIds: ["a"] }, { targetProviderId: "other" }, { targetCollectionId: SOURCE_COLLECTION },
      { action: "copy" as const }, { preserveCategories: false }, { operationCreatedAt: "2026-08-07T00:00:00Z" }]) {
      expect(await mdbx2TransferRequestHash({ ...request, ...change })).not.toBe(hash);
    }
  });
  it.each(["unchanged", "target edited", "target deleted", "source reconnected", "target identity changed", "journal write failed", "adoption persistence failed", "attachment capture failed", "attachment verification failed"])("verifies the whole group before source deletion: %s", async change => {
    const { service, target, storage } = await setupVault();
    const sourceProvider:ProviderAccount={...target,id:'mdbx-source',name:'Source',config:{vaultHandle:SOURCE_HANDLE}};
    await service.upsertProvider(sourceProvider);
    const secondObject=objectIdFor(900);
    const items=[SOURCE_OBJECT,secondObject].map((remoteId,index)=>({...createLoginItem({title:`Group ${index}`}),passwordGroupId:'group',
      replicaGroupId:`password:group-${index}`,mdbxFolderId:SOURCE_COLLECTION,
      providerRefs:[{providerId:sourceProvider.id,remoteId,remoteFolderId:SOURCE_COLLECTION,revision:'source-commit'}]}));
    await service.applyProviderSync(sourceProvider.id,items);
    const sources=await Promise.all(items.map(item=>service.getItem(item.id)));
    const native=new FakeNative();
    if (change === "journal write failed") service.stageMdbx2MoveFinalization = async record => {
      storage.failNext = true;
      await SecureVaultService.prototype.stageMdbx2MoveFinalization.call(service, record);
    };
    if (change === "adoption persistence failed") native.afterDeleteBatch = () => { storage.failNext = true; };
    native.addSourceRecord(sources[0]!);
    const record=native.records.get(SOURCE_OBJECT)!;
    native.records.set(secondObject,{...record,objectId:secondObject,title:items[1].title,payloadJson:JSON.stringify({
      ...JSON.parse(record.payloadJson),monica_entry_id:items[1].replicaGroupId,title:items[1].title})});
    const attachments = { ...noAttachments,
      async captureMoveAttachmentProofs(_account: ProviderAccount, item: VaultItem) {
        if (change === "attachment capture failed" && item.id === items[1].id) throw new Error("Synthetic attachment capture failure");
        return [];
      },
      async verifyMoveAttachmentProofs(_account: ProviderAccount, item: VaultItem) {
        if (change === "attachment verification failed" && item.id === items[1].id) throw new Error("Synthetic attachment verification failure");
      },
      async transferAttachments(_account: ProviderAccount, item: VaultItem, _targetAccount: ProviderAccount, targetItem: VaultItem) {
      if (item.id !== items[1].id) return 0;
      const remote = native.records.get(targetItem.providerRefs[0].remoteId!)!;
      if (change === "target edited") remote.headCommitId = "concurrent-edit";
      if (change === "target deleted") remote.deleted = true;
      if (change === "source reconnected") await service.upsertProvider({ ...sourceProvider, config: { vaultHandle: TARGET_HANDLE } });
      if (change === "target identity changed") native.vaultStatus = async vaultHandle => ({ vaultHandle, open: true, available: true, vaultId: "replacement-vault" });
      return 0;
    } };
    const coordinator=new Mdbx2BatchTransferCoordinator(service,new EmptyRegistry(),new Mdbx2Provider(native),native,attachments);
    const result=await coordinator.execute({itemIds:[items[0].id],targetProviderId:target.id,targetCollectionId:TARGET_COLLECTION,
      action:'move',confirmed:true,preserveCategories:false,operationId:OPERATION_ID,operationCreatedAt:OPERATION_TIME});
    if (change === "adoption persistence failed") {
      expect(result.failedCount).toBe(2);
      expect(native.deleted).toHaveLength(2);
      const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore());
      await restarted.unlock("coordinator password");
      const journals = await restarted.readMdbx2MoveFinalizations(OPERATION_ID);
      expect(journals).toHaveLength(1);
      expect(journals[0]).toMatchObject({ status: "prepared", sourceProviderId: sourceProvider.id,
        targetProviderId: target.id, sourceVaultId: `vault-${SOURCE_HANDLE}`, targetVaultId: `vault-${TARGET_HANDLE}`, attachments: [] });
      expect(journals[0].entries.map(entry => entry.expected)).toEqual(sources);
      for (const item of sources) expect(await restarted.getItem(item!.id)).toEqual(item);
      native.afterDeleteBatch = undefined;
      const reveal = native.revealObject.bind(native);
      native.revealObject = async (handle, objectId) => {
        if (handle === SOURCE_HANDLE) throw new Error("Deleted source must not be revealed during recovery");
        return reveal(handle, objectId);
      };
      const resumed = new Mdbx2BatchTransferCoordinator(restarted, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
      const retry = { itemIds: [items[0].id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
        action: "move" as const, confirmed: true, preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME };
      await expect(resumed.execute({ ...retry, preserveCategories: true })).rejects.toThrow("不一致");
      const targetRecord = native.records.get(journals[0].entries[1].result.providerRefs[0].remoteId!)!;
      const originalRevision = targetRecord.headCommitId;
      targetRecord.headCommitId = "newer-edit";
      expect((await resumed.execute(retry)).failedCount).toBe(2);
      expect(native.deleted).toHaveLength(2);
      targetRecord.headCommitId = originalRevision;
      expect((await resumed.execute(retry)).completedCount).toBe(2);
      expect((await restarted.readMdbx2MoveFinalizations(OPERATION_ID))[0].status).toBe("completed");
      const batchCount = native.batches.length;
      expect((await resumed.execute(retry)).completedCount).toBe(2);
      expect(native.batches).toHaveLength(batchCount);
      await restarted.upsertItem({ ...(await restarted.getItem(items[0].id))!, notes: "Later edit must survive" });
      expect((await resumed.execute(retry)).failedCount).toBe(2);
      expect((await restarted.getItem(items[0].id))!.notes).toBe("Later edit must survive");
      return;
    }
    if (change !== "unchanged") {
      expect(result.failedCount).toBe(2);
      expect(result.completedCount).toBe(0);
      expect(native.deleted).toHaveLength(0);
      expect(native.batches.filter(batch => batch.some(item => item.kind === "delete"))).toHaveLength(0);
      if (change === "journal write failed") expect(native.batches).toHaveLength(0);
      for (const item of sources) expect(await service.getItem(item!.id)).toEqual(item);
      return;
    }
    expect(result.completedCount, JSON.stringify(result)).toBe(2);
    expect(native.batches.filter(batch=>batch.every(item=>item.kind==='delete'))).toHaveLength(1);
    expect(native.deleted).toHaveLength(2);
    expect(await service.readMdbx2MoveFinalizations(OPERATION_ID)).toEqual([expect.objectContaining({ status: "completed", entries: expect.any(Array) })]);
    for(const item of items) expect((await service.getItem(item.id))!.providerRefs[0].providerId).toBe(target.id);
  });

  it("adopts no copied group member when the last source changes during attachment work", async () => {
    const { service, target } = await setupVault();
    const first = await service.upsertItem({ ...createLoginItem({ title: "First" }), passwordGroupId: "shared" });
    const second = await service.upsertItem({ ...createLoginItem({ title: "Second" }), passwordGroupId: "shared" });
    const native = new FakeNative();
    const attachments = { ...noAttachments, async transferAttachments(_account: ProviderAccount, item: VaultItem) {
      if (item.id === second.id) await service.upsertItem({ ...second, notes: "Concurrent edit" });
      return 0;
    } };
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    const result = await coordinator.execute({ itemIds: [first.id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: "copy", preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME });
    expect(result.failedCount).toBe(2);
    expect(result.completedCount).toBe(0);
    expect(await service.listItems()).toHaveLength(2);
    expect(await service.getItem(first.id)).toEqual(first);
    expect(await service.getItem(second.id)).toMatchObject({ notes: "Concurrent edit" });
    // The committed target remains available for explicit retry; source data is intact.
    expect(native.records.size).toBe(2);
  });

  it("copies a linked note once with a fresh stable reference and retries without duplicates", async () => {
    const { service, target } = await setupVault();
    const base = createLoginItem({ title: "Note" });
    const note = await service.upsertItem({ id: base.id, title: base.title, notes: "", favorite: false, createdAt: base.createdAt,
      updatedAt: base.updatedAt, providerRefs: [], kind: "secure-note", content: "Full shared note", replicaGroupId: "note:original" });
    const first = await service.upsertItem({ ...createLoginItem({ title: "First" }), boundNoteEntryId: "note:original" });
    const second = await service.upsertItem({ ...createLoginItem({ title: "Second" }), boundNoteEntryId: "note:original" });
    const native = new FakeNative();
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, noAttachments);
    const request = { itemIds: [first.id, second.id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: "copy" as const, preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME };
    expect((await coordinator.plan(request)).items).toHaveLength(3);
    expect((await coordinator.execute(request)).completedCount).toBe(3);
    const records = [...native.records.values()];
    const copiedNote = records.find(record => record.objectTypeId === "note")!;
    const notePayload = JSON.parse(copiedNote.payloadJson);
    expect(notePayload.monica_entry_id).not.toBe("note:original");
    for (const record of records.filter(record => record.objectTypeId === "login")) {
      expect(JSON.parse(record.payloadJson)).toMatchObject({ bound_note_entry_id: notePayload.monica_entry_id, bound_note_room_id: null });
    }
    expect((await coordinator.execute(request)).completedCount).toBe(3);
    expect(native.records.size).toBe(3);
    expect(await service.getItem(note.id)).toEqual(note);
    expect(await service.getItem(first.id)).toEqual(first);
    expect(await service.getItem(second.id)).toEqual(second);
    const move = await coordinator.plan({ ...request, itemIds: [note.id], action: "move" });
    expect(move.blockedCount).toBe(0);
    expect(move.transferableCount).toBe(3);
  });

  it("copies a shared SSO account once and remaps both websites with idempotent retry", async () => {
    const {service,target}=await setupVault();
    const account=await service.upsertItem({...createLoginItem({title:'SSO account'}),replicaGroupId:'password:account'});
    const first=await service.upsertItem({...createLoginItem({title:'First SSO'}),loginType:'SSO',ssoRefLogicalId:'password:account'});
    const second=await service.upsertItem({...createLoginItem({title:'Second SSO'}),loginType:'SSO',ssoRefLogicalId:'password:account'});
    const native=new FakeNative();
    const coordinator=new Mdbx2BatchTransferCoordinator(service,new EmptyRegistry(),new Mdbx2Provider(native),native,noAttachments);
    const request={itemIds:[first.id,second.id],targetProviderId:target.id,targetCollectionId:TARGET_COLLECTION,action:'copy' as const,preserveCategories:false,operationId:OPERATION_ID,operationCreatedAt:OPERATION_TIME};
    expect((await coordinator.plan(request)).transferableCount).toBe(3);
    expect((await coordinator.execute(request)).completedCount).toBe(3);
    const records=[...native.records.values()];
    const copied=JSON.parse(records.find(record=>record.title==='SSO account')!.payloadJson);
    expect(copied.monica_entry_id).not.toBe('password:account');
    for(const record of records.filter(record=>record.title!=='SSO account'))expect(JSON.parse(record.payloadJson)).toMatchObject({sso_ref_logical_id:copied.monica_entry_id,sso_ref_entry_id:null});
    expect((await coordinator.execute(request)).completedCount).toBe(3);
    expect(native.records.size).toBe(3);
    expect(await service.getItem(account.id)).toEqual(account);
    expect(await service.getItem(first.id)).toEqual(first);
    expect(await service.getItem(second.id)).toEqual(second);
  });

  it("recovers an entire linked-note move after committed writes without detaching shared passwords", async () => {
    const { service, target, storage } = await setupVault();
    const base = createLoginItem({ title: "Shared note" });
    const note = await service.upsertItem({ id: base.id, title: base.title, notes: "", favorite: false, createdAt: base.createdAt,
      updatedAt: base.updatedAt, providerRefs: [], kind: "secure-note", content: "Full shared note", replicaGroupId: "note:move-original" });
    const first = await service.upsertItem({ ...createLoginItem({ title: "First", password: "first" }), boundNoteEntryId: note.replicaGroupId, passwordGroupId: "move-group" });
    const second = await service.upsertItem({ ...createLoginItem({ title: "Second", password: "second" }), boundNoteEntryId: note.replicaGroupId, passwordGroupId: "move-group" });
    const native = new FakeNative();
    let interrupt = true;
    const attachments = { ...noAttachments, async transferAttachments() {
      if (interrupt) { interrupt = false; throw new Error("Synthetic interruption after whole linked group write"); }
      return 0;
    } };
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    const request = { itemIds: [note.id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: "move" as const, confirmed: true, preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME };
    expect((await coordinator.execute(request)).failedCount).toBe(3);
    for (const item of [note, first, second]) expect(await service.getItem(item.id)).toEqual(item);
    expect(native.records.size).toBe(3);
    const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await restarted.unlock("coordinator password");
    const resumed = new Mdbx2BatchTransferCoordinator(restarted, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    expect((await resumed.execute(request)).completedCount).toBe(3);
    expect(await restarted.listItems()).toHaveLength(3);
    const actualNote = [...native.records.values()].find(record => record.objectTypeId === "note")!;
    for (const record of native.records.values()) if (record.objectTypeId === "login") {
      expect(JSON.parse(record.payloadJson)).toMatchObject({ bound_note_entry_id: JSON.parse(actualNote.payloadJson).monica_entry_id, bound_note_room_id: null });
    }
    const calls = native.batches.length;
    expect((await resumed.execute(request)).completedCount).toBe(3);
    expect(native.batches).toHaveLength(calls);
  });

  it("retains the whole group when a member fails preparation while independent work completes", async () => {
    const { service, target } = await setupVault();
    const first = await service.upsertItem({ ...createLoginItem({ title: "First" }), passwordGroupId: "shared" });
    const second = await service.upsertItem({ ...createLoginItem({ title: "Second" }), passwordGroupId: "shared" });
    const independent = await service.upsertItem(createLoginItem({ title: "Independent" }));
    const native = new FakeNative();
    const attachments = { ...noAttachments, async listSourceAttachments(_account: ProviderAccount, item: VaultItem) {
      if (item.id === second.id) throw new Error("Synthetic attachment listing failure");
      return [];
    } };
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    const result = await coordinator.execute({ itemIds: [first.id, independent.id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: "copy", preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME });
    expect(result.failedCount).toBe(2);
    expect(result.completedCount, JSON.stringify(result)).toBe(1);
    expect([...native.records.values()].map(record => record.title)).toEqual(["Independent"]);
    expect(await service.getItem(first.id)).toEqual(first);
    expect(await service.getItem(second.id)).toEqual(second);
  });

  it("does not adopt or remove any group member when a later attachment transfer fails", async () => {
    const { service, target } = await setupVault();
    const first = await service.upsertItem({ ...createLoginItem({ title: "First" }), passwordGroupId: "shared" });
    const second = await service.upsertItem({ ...createLoginItem({ title: "Second" }), passwordGroupId: "shared" });
    const native = new FakeNative();
    const attachments = { ...noAttachments, async transferAttachments(_account: ProviderAccount, item: VaultItem) {
      if (item.id === second.id) throw new Error("Synthetic attachment transfer failure");
      return 0;
    } };
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    const result = await coordinator.execute({ itemIds: [first.id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: "move", confirmed: true, preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME });
    expect(result.failedCount).toBe(2);
    expect(result.completedCount).toBe(0);
    expect(await service.getItem(first.id)).toEqual(first);
    expect(await service.getItem(second.id)).toEqual(second);
    expect(native.deleted).toEqual([]);
  });

  it("expands one selected member to its complete project and gives a copy a fresh group identity", async () => {
    const { service, target } = await setupVault();
    const group: VaultItem[] = [];
    for (let index = 0; index < 3; index++) group.push(await service.upsertItem({ ...createLoginItem({ title: "Same", password: `synthetic-${index}` }), passwordGroupId: "source-group" }));
    await service.upsertItem(createLoginItem({ title: "Same", password: "independent" }));
    const native = new FakeNative();
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, noAttachments);
    const request = { itemIds: [group[1].id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION, action: "copy" as const,
      preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME };
    const plan = await coordinator.plan(request);
    expect(plan.items.map(item => item.sourceItemId).sort()).toEqual(group.map(item => item.id).sort());
    const result = await coordinator.execute(request);
    expect(result.completedCount).toBe(3);
    const copiedGroupIds = [...native.records.values()].map(record => JSON.parse(record.payloadJson).password_group_id);
    expect(new Set(copiedGroupIds).size).toBe(1);
    expect(copiedGroupIds[0]).toBeTruthy();
    expect(copiedGroupIds[0]).not.toBe("source-group");
    expect((await service.listItems()).filter(item => item.kind === "login" && item.passwordGroupId === "source-group")).toHaveLength(3);
  });

  it("copies a complete Android credential project with rebased metadata through batch write and readback", async () => {
    const { service, target } = await setupVault();
    const sourceProject = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const rows = [];
    for (let index = 0; index < 2; index++) rows.push(await service.upsertItem({
      ...createLoginItem({ title: 'Credential copy', username: 'shared', password: `synthetic-${index}` }), passwordGroupId: sourceProject,
      customFields: [{name:'monica.content.credential',protected:true,value:JSON.stringify({version:1,projectId:sourceProject,
        groupId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',passwordId:`cccccccc-cccc-4ccc-8ccc-ccccccccccc${index}`,
        label:'Account',primary:true,groupOrder:0,passwordOrder:index}).replace(/}$/, ',"future":9007199254740993}') }]
    }));
    const native = new FakeNative();
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, noAttachments);
    const result = await coordinator.execute({ itemIds: [rows[0].id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: 'copy', preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME });
    expect(result.completedCount).toBe(2);
    const copied = (await service.listItems()).filter(item => item.kind === 'login' && item.providerRefs.some(ref => ref.providerId === target.id));
    expect(copied).toHaveLength(2);
    for (const copy of copied) {
      if (copy.kind !== 'login') throw new Error('Expected login');
      const metadata = readProjectCredential(copy.customFields)!;
      expect(metadata.projectId).toBe(copy.passwordGroupId); expect(metadata.projectId).not.toBe(sourceProject);
      expect(metadata.groupId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      expect(copy.customFields[0].value).toContain('9007199254740993'); expect(copy.customFields[0].protected).toBe(true);
      expect(copy.password).toBe(`synthetic-${metadata.passwordOrder}`);
    }
    for (const row of rows) expect(await service.getItem(row.id)).toEqual(row);
  });

  it("moves between Collections without changing native UUID or explicit password group", async () => {
    const { service, target } = await setupVault();
    const source = await importNativeItem(service, {
      ...createLoginItem({ title: "Synthetic grouped password", username: "member-2", password: "synthetic" }),
      passwordGroupId: "synthetic-group",
      passwordHistory: [{ password: 'synthetic old', lastUsedAt: '1970-01-01T00:00:00.000Z' }],
      replicaGroupId: "password:stable-identity",
      mdbxFolderId: SOURCE_COLLECTION,
      providerRefs: [{ providerId: target.id, remoteId: SOURCE_OBJECT, remoteFolderId: SOURCE_COLLECTION, revision: "source-commit" }]
    });
    const native = new FakeNative();
    native.collections.get(TARGET_HANDLE)!.push(summary(SOURCE_COLLECTION, "Source"));
    native.addSourceRecord(source);
    const original = native.records.get(SOURCE_OBJECT)!;
    original.payloadJson = JSON.stringify({ ...JSON.parse(original.payloadJson), password_group_id: "synthetic-group" });
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, noAttachments);
    const result = await coordinator.execute({
      itemIds: [source.id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: "move", confirmed: true, preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME
    });
    expect(result.completedCount).toBe(1);
    expect(native.batches[0][0]).toMatchObject({ logicalObjectId: `native:${SOURCE_OBJECT}`, expectedHeadCommitId: "source-commit" });
    expect(native.records.size).toBe(1);
    expect(native.records.get(SOURCE_OBJECT)).toMatchObject({ collectionId: TARGET_COLLECTION, deleted: false });
    expect(JSON.parse(native.records.get(SOURCE_OBJECT)!.payloadJson)).toMatchObject({ monica_entry_id: "password:stable-identity", password_group_id: "synthetic-group", future_field: { preserved: true } });
    expect(native.deleted).toEqual([]);
    expect((await service.getItem(source.id))?.providerRefs[0]).toMatchObject({ remoteId: SOURCE_OBJECT, remoteFolderId: TARGET_COLLECTION });
    expect((await service.getItem(source.id))).toMatchObject({ passwordHistory: source.kind === 'login' ? source.passwordHistory : undefined });
  });

  it("recovers a same-vault move using pre-write attachment proofs without rereading the old folder", async () => {
    const { service, target, storage } = await setupVault();
    const source = await importNativeItem(service, { ...createLoginItem({ title: 'Same vault interrupted' }),
      passwordHistory: [{ password: 'synthetic history before restart', lastUsedAt: '1970-01-01T00:00:00.000Z' }],
      replicaGroupId: 'password:same-vault', mdbxFolderId: SOURCE_COLLECTION,
      providerRefs: [{ providerId: target.id, remoteId: SOURCE_OBJECT, remoteFolderId: SOURCE_COLLECTION, revision: 'source-commit' }] });
    const native = new FakeNative(); native.addSourceRecord(source);
    native.collections.get(TARGET_HANDLE)!.push(summary(SOURCE_COLLECTION, 'Source'));
    native.loseNextBatchResponse = true;
    const resolve = native.resolveObjectOperation.bind(native); let unavailable = true, changedAttachment = false, captures = 0;
    native.resolveObjectOperation = async (...args) => { if (unavailable) { unavailable = false; throw new Error('Synthetic exit'); } return resolve(...args); };
    const attachments: Mdbx2BatchTransferAttachmentBridge = { ...noAttachments,
      async captureMoveAttachmentProofs(_account, expected) {
        captures++; expect(expected.providerRefs[0].remoteFolderId).toBe(SOURCE_COLLECTION);
        expect(native.records.get(SOURCE_OBJECT)?.collectionId).toBe(SOURCE_COLLECTION);
        return [{ itemId: source.id, attachmentId: 'same-attachment', fileName: 'proof.bin', sizeBytes: 3, sha256: 'ab'.repeat(32) }];
      },
      async verifyMoveAttachmentProofs(_account, result, proofs) {
        expect(result.providerRefs[0].remoteFolderId).toBe(TARGET_COLLECTION);
        expect(proofs[0].attachmentId).toBe('same-attachment');
        if (changedAttachment) throw new Error('Synthetic attachment replaced');
      },
      async transferAttachments() { throw new Error('Same vault must not recopy attachments'); }
    };
    const request = { itemIds: [source.id], targetProviderId: target.id, targetCollectionId: TARGET_COLLECTION,
      action: 'move' as const, confirmed: true, preserveCategories: false, operationId: OPERATION_ID, operationCreatedAt: OPERATION_TIME };
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    expect((await coordinator.execute(request)).failedCount).toBe(1);
    expect(native.records.get(SOURCE_OBJECT)?.collectionId).toBe(TARGET_COLLECTION);
    const [writing] = await service.readMdbx2MoveFinalizations();
    expect(writing).toMatchObject({ status: 'writing', attachments: [{ attachmentId: 'same-attachment' }] });
    const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore()); await restarted.unlock('coordinator password');
    const resumed = new Mdbx2BatchTransferCoordinator(restarted, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    changedAttachment = true;
    expect((await resumed.execute(request)).failedCount).toBe(1);
    expect(await restarted.getItem(source.id)).toEqual(source);
    changedAttachment = false;
    expect((await resumed.execute(request)).completedCount).toBe(1);
    expect(captures).toBe(1); expect(native.deleted).toHaveLength(0); expect(native.records.size).toBe(1);
    expect(await restarted.getItem(source.id)).toMatchObject({ passwordHistory: source.kind === 'login' ? source.passwordHistory : undefined });
    expect((await restarted.getItem(source.id))?.providerRefs[0]).toMatchObject({ remoteId: SOURCE_OBJECT, remoteFolderId: TARGET_COLLECTION });
    const calls = native.batches.length;
    expect((await resumed.execute(request)).completedCount).toBe(1);
    expect(native.batches).toHaveLength(calls);
  });

  it("creates nested target Collections and retries a committed copy without duplicates", async () => {
    const { service, target } = await setupVault();
    const source = await service.upsertItem({
      ...createLoginItem({ title: "Mail", username: "alice", password: "secret" }),
      categoryName: "Work / Cloud"
    });
    const native = new FakeNative();
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, noAttachments);
    const plan = await coordinator.plan({
      itemIds: [source.id],
      targetProviderId: target.id,
      action: "copy",
      preserveCategories: true,
      operationId: OPERATION_ID,
      operationCreatedAt: OPERATION_TIME
    });
    expect(plan.items[0].targetPath).toEqual(["Work", "Cloud"]);
    expect(plan.requiresMoveConfirmation).toBe(false);

    native.loseNextBatchResponse = true;
    const progress: Mdbx2BatchTransferProgress[] = [];
    const first = await coordinator.execute({
      itemIds: [source.id],
      targetProviderId: target.id,
      action: "copy",
      preserveCategories: true,
      operationId: plan.operationId,
      operationCreatedAt: plan.operationCreatedAt
    }, (entry) => progress.push(entry));
    expect(progress[0]).toMatchObject({ operationId: OPERATION_ID, phase: "preparing", processed: 0, total: 1 });
    expect(progress[progress.length - 1]).toMatchObject({ operationId: OPERATION_ID, phase: "completed", processed: 1, total: 1, completedCount: 1 });
    const repeated = await coordinator.execute({
      itemIds: [source.id],
      targetProviderId: target.id,
      action: "copy",
      preserveCategories: true,
      operationId: plan.operationId,
      operationCreatedAt: plan.operationCreatedAt
    });

    expect(first.completedCount).toBe(1);
    expect(repeated.completedCount).toBe(1);
    expect(native.scopes.every((scope) => /^[a-f0-9]{64}$/.test(scope))).toBe(true);
    expect((await service.listItems())).toHaveLength(2);
    expect(native.collections.get(TARGET_HANDLE)?.map((item) => item.title)).toEqual(["Target", "Work", "Cloud"]);
  });

  it("moves an MDBX2 Object only after target commit and requires confirmation", async () => {
    const { service, target } = await setupVault();
    const sourceProvider: ProviderAccount = { id: "mdbx-source", kind: "mdbx2", name: "Source", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: SOURCE_HANDLE } };
    await service.upsertProvider(sourceProvider);
    const source = await importNativeItem(service, {
      ...createLoginItem({ title: "Source login", username: "alice", password: "secret" }),
      replicaGroupId: "password:source-7",
      mdbxFolderId: SOURCE_COLLECTION,
      providerRefs: [{ providerId: sourceProvider.id, remoteId: SOURCE_OBJECT, remoteFolderId: SOURCE_COLLECTION, revision: "source-commit" }]
    });
    const native = new FakeNative();
    native.addSourceRecord(source);
    const attachments: Mdbx2BatchTransferAttachmentBridge = {
      async listSourceAttachments() { return [{ attachmentId: "attachment-1", fileName: "evidence.bin", sizeBytes: 3 }]; },
      async transferAttachments() { native.events.push("attachment"); return 1; },
      async captureMoveAttachmentProofs(_account, _source, _targetAccount, targetItem) {
        return [{ itemId: targetItem.id, attachmentId: "synthetic-target-attachment", fileName: "evidence.bin", sizeBytes: 3, sha256: "ab".repeat(32) }];
      },
      async verifyMoveAttachmentProofs() { native.events.push("verify-attachment"); }
    };
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, attachments);
    const request = {
      itemIds: [source.id],
      targetProviderId: target.id,
      targetCollectionId: TARGET_COLLECTION,
      action: "move" as const,
      preserveCategories: false,
      operationId: OPERATION_ID,
      operationCreatedAt: OPERATION_TIME
    };
    await expect(coordinator.execute(request)).rejects.toThrow("二次确认");
    const result = await coordinator.execute({ ...request, confirmed: true });

    expect(result.completedCount).toBe(1);
    expect(native.deleted).toEqual([{ vaultHandle: SOURCE_HANDLE, logicalObjectId: `native:${SOURCE_OBJECT}` }]);
    expect(native.events.indexOf("batch:1")).toBeLessThan(native.events.indexOf("attachment"));
    expect(native.events.indexOf("attachment")).toBeLessThan(native.events.indexOf(`delete:native:${SOURCE_OBJECT}`));
    expect(await service.getItem(source.id)).toMatchObject({ providerRefs: [expect.objectContaining({ providerId: target.id })] });
    const targetRecord = [...native.records.values()].find((record) => record.collectionId === TARGET_COLLECTION && record.objectId !== SOURCE_OBJECT);
    expect(targetRecord?.payloadJson).toContain('"future_field":{"preserved":true}');
  });

  it("retains the source when the target folder already owns the replica identity", async () => {
    const { service, target } = await setupVault();
    const sourceProvider: ProviderAccount = { id: "mdbx-source", kind: "mdbx2", name: "Source", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: SOURCE_HANDLE } };
    await service.upsertProvider(sourceProvider);
    const source = await importNativeItem(service, {
      ...createLoginItem({ title: "Conflicting login", password: "secret" }),
      replicaGroupId: "password:conflict",
      mdbxFolderId: SOURCE_COLLECTION,
      providerRefs: [{ providerId: sourceProvider.id, remoteId: SOURCE_OBJECT, remoteFolderId: SOURCE_COLLECTION, revision: "source-commit" }]
    });
    const native = new FakeNative();
    native.addSourceRecord(source);
    native.records.set("77777777-7777-4777-8777-777777777777", {
      objectId: "77777777-7777-4777-8777-777777777777",
      collectionId: TARGET_COLLECTION,
      objectTypeId: "login",
      title: "Existing replica",
      payloadJson: JSON.stringify({ kind: "password", monica_entry_id: "password:conflict" }),
      payloadSchemaVersion: 1,
      deleted: false
    });
    const coordinator = new Mdbx2BatchTransferCoordinator(service, new EmptyRegistry(), new Mdbx2Provider(native), native, noAttachments);
    const result = await coordinator.execute({
      itemIds: [source.id],
      targetProviderId: target.id,
      targetCollectionId: TARGET_COLLECTION,
      action: "move",
      preserveCategories: false,
      operationId: OPERATION_ID,
      operationCreatedAt: OPERATION_TIME,
      confirmed: true
    });

    expect(result.items[0]).toMatchObject({ status: "failed", retryable: false });
    expect(result.items[0].error).toContain("相同逻辑项目");
    expect(native.deleted).toEqual([]);
    expect(await service.getItem(source.id)).toMatchObject({ providerRefs: [expect.objectContaining({ providerId: sourceProvider.id })] });
  });
});

class FailableStorage extends MemoryVaultStorage {
  failNext = false;
  override async write(envelope: VaultEnvelope) {
    if (this.failNext) { this.failNext = false; throw new Error("Synthetic interrupted coordinator persistence"); }
    await super.write(envelope);
  }
}

async function setupVault() {
  const storage = new FailableStorage();
  const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup("coordinator password");
  const target: ProviderAccount = { id: "mdbx-target", kind: "mdbx2", name: "Target", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: TARGET_HANDLE } };
  await service.upsertProvider(target);
  return { service, target, storage };
}

async function importNativeItem(service: SecureVaultService, item: VaultItem): Promise<VaultItem> {
  // Remote identities originate at the provider boundary, never a UI create.
  await service.applyProviderSync(item.providerRefs[0].providerId, [item]);
  return (await service.getItem(item.id))!;
}

function summary(collectionId: string, title: string, groupId?: string): Mdbx2CollectionSummary {
  return { collectionId, title, groupId, favorite: false, archived: false, attachmentCount: 0, headCommitId: collectionId, deleted: false, updatedAt: OPERATION_TIME };
}

function objectIdFor(value: number): string {
  return `${String(value).padStart(8, "0")}-7777-4777-8777-777777777777`;
}
