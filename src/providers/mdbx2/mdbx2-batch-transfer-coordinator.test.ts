import { describe, expect, it } from "vitest";
import { createLoginItem, type ProviderAccount, type VaultItem } from "../../core/model";
import type { ProviderAdapter } from "../../core/provider";
import { SecureVaultService } from "../../security/secure-vault-service";
import { MemoryVaultSessionStore } from "../../security/vault-session";
import { MemoryVaultStorage } from "../../security/vault-storage";
import {
  Mdbx2BatchTransferCoordinator,
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
  readonly deleted: Array<{ vaultHandle: string; logicalObjectId: string }> = [];
  readonly events: string[] = [];
  private readonly committed = new Map<string, Mdbx2ObjectBatchResult>();
  loseNextBatchResponse = false;
  private objectCounter = 0;

  constructor() {
    this.collections.set(TARGET_HANDLE, [summary(TARGET_COLLECTION, "Target")]);
    this.collections.set(SOURCE_HANDLE, [summary(SOURCE_COLLECTION, "Source")]);
  }

  async vaultStatus(vaultHandle: string) { return { vaultHandle, open: true, available: true }; }

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
    const previous = this.committed.get(operationScope);
    if (previous) return { ...previous, alreadyCommitted: true, items: previous.items.map((item) => ({ ...item })) };
    const items = mutations.map((mutation) => {
      if (mutation.kind === "delete") throw new Error("unexpected delete batch");
      const payload = JSON.parse(mutation.payloadJson) as Record<string, unknown>;
      const existing = [...this.records.values()].find((record) => {
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
        deleted: false
      });
      return { kind: "upsert" as const, changed: !existing, logicalObjectId: mutation.logicalObjectId, objectId, collectionId: mutation.collectionId || TARGET_COLLECTION, objectTypeId: mutation.objectTypeId };
    });
    const result: Mdbx2ObjectBatchResult = { changed: true, operationId: OPERATION_ID, commitId: `commit-${this.committed.size + 1}`, alreadyCommitted: false, items };
    this.committed.set(operationScope, result);
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
      try { return JSON.parse(candidate.payloadJson).monica_entry_id === logicalObjectId; } catch { return false; }
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
    const source = await service.upsertItem({
      ...createLoginItem({ title: "Source login", username: "alice", password: "secret" }),
      replicaGroupId: "password:source-7",
      mdbxFolderId: SOURCE_COLLECTION,
      providerRefs: [{ providerId: sourceProvider.id, remoteId: SOURCE_OBJECT, remoteFolderId: SOURCE_COLLECTION, revision: "source-commit" }]
    });
    const native = new FakeNative();
    native.addSourceRecord(source);
    const attachments: Mdbx2BatchTransferAttachmentBridge = {
      async listSourceAttachments() { return [{ attachmentId: "attachment-1", fileName: "evidence.bin", sizeBytes: 3 }]; },
      async transferAttachments() { native.events.push("attachment"); return 1; }
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
    expect(native.deleted).toEqual([{ vaultHandle: SOURCE_HANDLE, logicalObjectId: "password:source-7" }]);
    expect(native.events.indexOf("batch:1")).toBeLessThan(native.events.indexOf("attachment"));
    expect(native.events.indexOf("attachment")).toBeLessThan(native.events.indexOf("delete:password:source-7"));
    expect(await service.getItem(source.id)).toMatchObject({ providerRefs: [expect.objectContaining({ providerId: target.id })] });
    const targetRecord = [...native.records.values()].find((record) => record.collectionId === TARGET_COLLECTION && record.objectId !== SOURCE_OBJECT);
    expect(targetRecord?.payloadJson).toContain('"future_field":{"preserved":true}');
  });

  it("retains the source when the target folder already owns the replica identity", async () => {
    const { service, target } = await setupVault();
    const sourceProvider: ProviderAccount = { id: "mdbx-source", kind: "mdbx2", name: "Source", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: SOURCE_HANDLE } };
    await service.upsertProvider(sourceProvider);
    const source = await service.upsertItem({
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

async function setupVault() {
  const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  await service.setup("coordinator password");
  const target: ProviderAccount = { id: "mdbx-target", kind: "mdbx2", name: "Target", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: TARGET_HANDLE } };
  await service.upsertProvider(target);
  return { service, target };
}

function summary(collectionId: string, title: string, groupId?: string): Mdbx2CollectionSummary {
  return { collectionId, title, groupId, favorite: false, archived: false, attachmentCount: 0, headCommitId: collectionId, deleted: false, updatedAt: OPERATION_TIME };
}

function objectIdFor(value: number): string {
  return `${String(value).padStart(8, "0")}-7777-4777-8777-777777777777`;
}
