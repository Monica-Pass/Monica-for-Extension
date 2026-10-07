import { parseLosslessJson } from "../../core/lossless-json";
import type { Mdbx2MoveAttachmentProof, Mdbx2MoveFinalizationRecord } from "../../core/mdbx2-move-journal";
import { completeTransferComponents, mdbx2TransferDependencies } from "./mdbx2-transfer-dependencies";
import { deleteMdbx2TransferSources } from "./mdbx2-transfer-source-delete";
import { readMdbx2TransferBinding, verifyMdbx2TransferBinding, verifyMdbx2TransferTargets,
  type Mdbx2TransferVaultBinding } from "./mdbx2-transfer-verification";
import type {
  ProviderAccount,
  ProviderReference,
  ProviderSourceRecord,
  VaultItem
} from "../../core/model";
import type { ProviderAdapter } from "../../core/provider";
import { decodeMdbx2Object, encodeMdbx2Object, mdbx2LogicalObjectId } from "./mdbx2-item-codec";
import {
  MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES,
  MDBX2_MAX_OBJECT_BATCH_MUTATIONS,
  type Mdbx2CollectionSummary,
  type Mdbx2ObjectBatchResult,
  type Mdbx2ObjectDeleteResult,
  type Mdbx2ObjectMutationInput,
  type Mdbx2ObjectOperationResolution,
  type Mdbx2ObjectRecord,
  type Mdbx2ObjectSummaryPage,
  type Mdbx2ObjectWriteResult,
  type Mdbx2VaultRuntimeStatus,
  type Mdbx2AttachmentMutationResult
} from "./native-contract";
import {
  ensureMdbx2TransferCollectionPaths,
  listMdbx2TransferCollections,
  type Mdbx2TransferCollectionClient
} from "./mdbx2-transfer-collections";
import {
  assertMdbx2TransferOperationId,
  mdbx2TransferOperationScope,
  mdbx2TransferUuid
} from "./mdbx2-transfer-identity";
import {
  planMdbx2BatchTransfer,
  mdbx2PasswordHistoryTransferBlockReason,
  isMdbx2RootCollection,
  type Mdbx2BatchTransferAction,
  type Mdbx2BatchTransferPlan,
  type Mdbx2BatchTransferPlanItem,
  type Mdbx2TransferCategorySource
} from "./mdbx2-batch-transfer";
import type { Mdbx2BatchWriteEntry, Mdbx2BatchWriteResult, Mdbx2Provider } from "./mdbx2-provider";
import type { CompletedMdbx2TransferEntry } from "../../security/secure-vault-service";

const MAX_TRANSFER_ITEMS = 200;

export interface Mdbx2BatchTransferRequest {
  operationId?: string;
  operationCreatedAt?: string;
  itemIds: string[];
  targetProviderId: string;
  targetCollectionId?: string;
  preserveCategories: boolean;
  action: Mdbx2BatchTransferAction;
  confirmed?: boolean;
}

export interface Mdbx2PendingMove {
  operationId: string;
  createdAt: string;
  targetProviderId: string;
  sourceProviderIds: string[];
  titles: string[];
  itemCount: number;
  attachmentCount: number;
  request?: Mdbx2BatchTransferRequest;
}

export interface Mdbx2BatchTransferPlanItemSummary {
  sourceItemId: string;
  title: string;
  kind: VaultItem["kind"];
  effectiveAction: Mdbx2BatchTransferAction;
  sourcePath: string[];
  targetPath: string[];
  pathIncomplete: boolean;
  blockedReason?: string;
}

export interface Mdbx2BatchTransferPlanResult {
  operationId: string;
  operationCreatedAt: string;
  action: Mdbx2BatchTransferAction;
  targetProviderId: string;
  targetCollectionId?: string;
  preserveCategories: boolean;
  items: Mdbx2BatchTransferPlanItemSummary[];
  blockedCount: number;
  transferableCount: number;
  requiresMoveConfirmation: boolean;
  warnings: string[];
}

export type Mdbx2BatchTransferItemStatus = "completed" | "blocked" | "failed";

export interface Mdbx2BatchTransferItemResult {
  sourceItemId: string;
  title: string;
  kind: VaultItem["kind"];
  effectiveAction: Mdbx2BatchTransferAction;
  status: Mdbx2BatchTransferItemStatus;
  targetItemId?: string;
  error?: string;
  retryable: boolean;
}

export interface Mdbx2BatchTransferExecuteResult {
  operationId: string;
  action: Mdbx2BatchTransferAction;
  targetProviderId: string;
  items: Mdbx2BatchTransferItemResult[];
  completedCount: number;
  blockedCount: number;
  failedCount: number;
  warnings: string[];
}

export type Mdbx2BatchTransferPhase =
  | "preparing"
  | "writing"
  | "attachments"
  | "finalizing"
  | "completed"
  | "failed";

export interface Mdbx2BatchTransferProgress {
  operationId: string;
  phase: Mdbx2BatchTransferPhase;
  processed: number;
  total: number;
  completedCount: number;
  blockedCount: number;
  failedCount: number;
}

export interface Mdbx2BatchTransferStatus extends Mdbx2BatchTransferProgress {
  finished: boolean;
  updatedAt: string;
}

export type Mdbx2BatchTransferProgressListener = (progress: Mdbx2BatchTransferProgress) => void;

export interface Mdbx2BatchTransferVault {
  readMdbx2MoveFinalizations(operationId?: string): Promise<Mdbx2MoveFinalizationRecord[]>;
  stageMdbx2MoveFinalization(record: Mdbx2MoveFinalizationRecord): Promise<void>;
  prepareMdbx2MoveFinalization(record: Mdbx2MoveFinalizationRecord): Promise<void>;
  applyCompletedMdbx2Transfer(entries: CompletedMdbx2TransferEntry[], targetProviderId?: string,
    deleteSources?: (pendingMoves: readonly CompletedMdbx2TransferEntry[], providers: readonly ProviderAccount[]) => Promise<void>, finalizationId?: string): Promise<VaultItem[]>;
  listItems(): Promise<VaultItem[]>;
  getProvider(providerId: string): Promise<ProviderAccount | undefined>;
  getProviderSourceRecords(providerId: string): Promise<ProviderSourceRecord[]>;
  finalizeCompletedMdbx2Transfer(
    entry: CompletedMdbx2TransferEntry,
    targetProviderId: string,
    deleteSource?: (providers: readonly ProviderAccount[]) => Promise<void>
  ): Promise<VaultItem>;
}

export interface Mdbx2BatchTransferProviderRegistry {
  get(kind: ProviderAccount["kind"]): ProviderAdapter;
}

export interface Mdbx2BatchTransferNativeClient extends Mdbx2TransferCollectionClient {
  mutateObjects(vaultHandle: string, operationScope: string, mutations: Mdbx2ObjectMutationInput[]): Promise<Mdbx2ObjectBatchResult>;
  vaultStatus(vaultHandle: string): Promise<Mdbx2VaultRuntimeStatus>;
  listObjects(
    vaultHandle: string,
    collectionId: string,
    input?: { objectTypeId?: string; deleted?: boolean; pageSize?: number; cursor?: string }
  ): Promise<Mdbx2ObjectSummaryPage>;
  revealObject(vaultHandle: string, objectId: string): Promise<Mdbx2ObjectRecord>;
  deleteObject(vaultHandle: string, operationId: string, logicalObjectId: string, expectedHeadCommitId?: string): Promise<Mdbx2ObjectDeleteResult>;
  resolveObjectOperation(vaultHandle: string, operationScope: string): Promise<Mdbx2ObjectOperationResolution>;
  listAttachments(vaultHandle: string, collectionId: string, objectId: string, input?: { pageSize?: number; cursor?: string }): Promise<{ items: readonly Mdbx2TransferAttachmentDescriptor[]; nextCursor?: string }>;
  beginAttachmentRead(vaultHandle: string, attachmentId: string): Promise<{ readHandle: string; attachmentId: string; fileName: string; mediaType?: string; sizeBytes: number; maxChunkBytes: number }>;
  readAttachmentChunk(readHandle: string, offset: number, maxBytes?: number): Promise<{ readHandle: string; attachmentId: string; fileName: string; mediaType?: string; sizeBytes: number; offset: number; nextOffset: number; dataBase64: string; eof: boolean }>;
  releaseAttachmentRead(readHandle: string): Promise<boolean>;
  beginAttachmentUpload(vaultHandle: string, input: { operationId: string; attachmentId: string; collectionId: string; objectId: string; fileName: string; mediaType?: string; mode: "create" | "replace"; sizeBytes: number; sha256?: string }): Promise<{ transferId: string; operationId: string; attachmentId: string; nextOffset: number; maxChunkBytes: number; alreadyCommitted: boolean }>;
  sendAttachmentUploadChunk(transferId: string, offset: number, bytes: Uint8Array): Promise<{ transferId: string; nextOffset: number; acceptedBytes: number; repeated: boolean }>;
  finishAttachmentUpload(transferId: string): Promise<Mdbx2AttachmentMutationResult>;
  abortAttachmentUpload(transferId: string): Promise<boolean>;
}

export interface Mdbx2TransferAttachmentDescriptor {
  attachmentId: string;
  fileName: string;
  sizeBytes: number;
  mediaType?: string;
  protected?: boolean;
}

export interface Mdbx2BatchTransferAttachmentBridge {
  captureMoveAttachmentProofs?(account: ProviderAccount, sourceItem: VaultItem, targetAccount: ProviderAccount,
    targetItem: VaultItem, operationId: string): Promise<Mdbx2MoveAttachmentProof[]>;
  verifyMoveAttachmentProofs?(targetAccount: ProviderAccount, targetItem: VaultItem, proofs: readonly Mdbx2MoveAttachmentProof[]): Promise<void>;
  listSourceAttachments(account: ProviderAccount, item: VaultItem): Promise<readonly Mdbx2TransferAttachmentDescriptor[]>;
  transferAttachments(
    account: ProviderAccount,
    sourceItem: VaultItem,
    targetAccount: ProviderAccount,
    targetItem: VaultItem,
    operationId: string
  ): Promise<number>;
}

interface PreparedTransferWork {
  planItem: Mdbx2BatchTransferPlanItem;
  sourceItem: VaultItem;
  sourceAccount: ProviderAccount;
  targetItem: VaultItem;
  targetCollectionIdForConflict?: string;
  targetEntry: Mdbx2BatchWriteEntry;
  sourceAttachments: readonly { attachmentId: string }[];
}

interface PreparedContext {
  moveBindings: Map<string, Mdbx2TransferVaultBinding>;
  components: string[][];
  operationId: string;
  operationCreatedAt: string;
  request: Mdbx2BatchTransferRequest;
  targetAccount: ProviderAccount;
  itemsById: Map<string, VaultItem>;
  accountsByItemId: Map<string, ProviderAccount>;
  plan: Mdbx2BatchTransferPlan;
  publicPlan: Mdbx2BatchTransferPlanResult;
}

export class Mdbx2BatchTransferCoordinator {
  constructor(
    private readonly vault: Mdbx2BatchTransferVault,
    private readonly registry: Mdbx2BatchTransferProviderRegistry,
    private readonly targetProvider: Mdbx2Provider,
    private readonly nativeClient: Mdbx2BatchTransferNativeClient,
    private readonly attachments?: Mdbx2BatchTransferAttachmentBridge
  ) {}

  async plan(input: Mdbx2BatchTransferRequest): Promise<Mdbx2BatchTransferPlanResult> {
    const context = await this.prepareContext(input);
    return context.publicPlan;
  }

  async pendingMoves(): Promise<Mdbx2PendingMove[]> {
    const records = await this.vault.readMdbx2MoveFinalizations();
    const groups = new Map<string, Mdbx2MoveFinalizationRecord[]>();
    for (const record of records) {
      if (record.status === "completed") continue;
      groups.set(record.operationId, [...(groups.get(record.operationId) || []), record]);
    }
    const pending: Mdbx2PendingMove[] = [];
    for (const [operationId, group] of groups) {
      const first = group[0];
      const request = first.request ? { ...first.request, operationId, operationCreatedAt: first.createdAt, targetProviderId: first.targetProviderId } : undefined;
      const hash = request ? await mdbx2TransferRequestHash(request) : undefined;
      pending.push({ operationId, createdAt: first.createdAt, targetProviderId: first.targetProviderId,
        sourceProviderIds: [...new Set(group.map(record => record.sourceProviderId))],
        titles: group.flatMap(record => record.entries.map(entry => entry.expected.title)),
        itemCount: group.reduce((sum, record) => sum + record.entries.length, 0),
        attachmentCount: group.reduce((sum, record) => sum + (record.attachments?.length ?? record.writeIntent?.attachmentCount ?? 0), 0),
        ...(request && group.every(record => (record.attachments || record.status === "writing" && record.writeIntent) && record.requestHash === hash) ? { request } : {}) });
    }
    return pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async execute(
    input: Mdbx2BatchTransferRequest,
    onProgress?: Mdbx2BatchTransferProgressListener
  ): Promise<Mdbx2BatchTransferExecuteResult> {
    const records = input.operationId ? await this.vault.readMdbx2MoveFinalizations(input.operationId) : [];
    if (!records.length) return this.executeRemaining(input, onProgress);
    const intent = { ...input, operationCreatedAt: normalizedOperationTime(input.operationCreatedAt || records[0].createdAt) };
    const requestHash = await mdbx2TransferRequestHash(intent);
    if (records.some(record => record.requestHash !== requestHash)) throw new Error("移动操作与已保存的恢复记录不一致。");
    if (input.confirmed !== true) throw new Error("MDBX2 移动操作需要二次确认。");
    const recovered: Mdbx2BatchTransferItemResult[] = [];
    const handled = new Set<string>();
    for (const record of records) {
      if (record.entries.some(entry => handled.has(entry.expected.id))) throw new Error("移动恢复记录无效，已保留原始数据。");
      record.entries.forEach(entry => handled.add(entry.expected.id));
    }
    for (const record of records) {
      try {
        await this.resumeFinalization(record);
        for (const entry of record.entries) recovered.push({ sourceItemId: entry.expected.id, title: entry.expected.title,
          kind: entry.expected.kind, effectiveAction: "move", status: "completed", targetItemId: entry.result.id, retryable: false });
      } catch (error) {
        for (const entry of record.entries) recovered.push(itemFailure(entry.expected, "move", error));
      }
    }
    const remainingIds = input.itemIds.filter(id => !handled.has(id));
    const remaining = remainingIds.length ? await this.executeRemaining({ ...intent, itemIds: remainingIds }, onProgress, intent) : undefined;
    const items = [...recovered, ...(remaining?.items || [])];
    const result: Mdbx2BatchTransferExecuteResult = { operationId: input.operationId!, action: input.action,
      targetProviderId: input.targetProviderId, items, completedCount: items.filter(item => item.status === "completed").length,
      failedCount: items.filter(item => item.status === "failed").length, blockedCount: items.filter(item => item.status === "blocked").length,
      warnings: remaining?.warnings || [] };
    reportTransferProgress(onProgress, result.operationId, "completed", new Map(items.map(item => [item.sourceItemId, item])), items.length);
    return result;
  }

  private async resumeFinalization(record: Mdbx2MoveFinalizationRecord): Promise<void> {
    if (record.status === "writing") record = await this.resumeWriteIntent(record);
    if (!record.attachments) throw new Error("移动恢复记录无效，已保留原始数据。");
    await this.vault.applyCompletedMdbx2Transfer(record.entries, record.targetProviderId, async (pending, providers) => {
      const target = providers.find(account => account.id === record.targetProviderId);
      if (!target) throw new Error("移动期间密码库连接已变化，来源项目已保留。");
      const targetBinding = await readMdbx2TransferBinding(this.nativeClient, target);
      if (targetBinding.vaultId !== record.targetVaultId) throw new Error("移动期间密码库连接已变化，来源项目已保留。");
      const source = providers.find(account => account.id === record.sourceProviderId);
      if (record.sourceProviderId === "local") {
        if (record.sourceVaultId !== "local") throw new Error("移动恢复记录无效，已保留原始数据。");
      } else {
        if (!source) throw new Error("移动期间密码库连接已变化，来源项目已保留。");
        const sourceBinding = await readMdbx2TransferBinding(this.nativeClient, source);
        if (sourceBinding.vaultId !== record.sourceVaultId) throw new Error("移动期间密码库连接已变化，来源项目已保留。");
      }
      await verifyMdbx2TransferTargets(this.nativeClient, targetBinding, pending.map(entry => entry.result));
      for (const entry of pending) {
        const proofs = record.attachments!.filter(proof => proof.itemId === entry.result.id);
        if (this.attachments?.verifyMoveAttachmentProofs) await this.attachments.verifyMoveAttachmentProofs(target, entry.result, proofs);
        else {
          const ref = entry.result.providerRefs.find(ref => ref.providerId === target.id)!;
          const actual = await this.nativeClient.listAttachments(targetBinding.vaultHandle, ref.remoteFolderId!, ref.remoteId!);
          if (proofs.length || actual.items.length || actual.nextCursor) throw new Error("移动附件校验失败，来源项目已保留。");
        }
      }
      if (source && record.sourceProviderId !== "local" && source.id !== target.id) await deleteMdbx2TransferSources(this.nativeClient, source, pending.map(entry => entry.expected), record.operationId, target.id);
    }, record.id);
  }

  private async resumeWriteIntent(record: Mdbx2MoveFinalizationRecord): Promise<Mdbx2MoveFinalizationRecord> {
    if (!record.writeIntent) throw new Error("移动恢复记录无效，已保留原始数据。");
    const sameVault = record.sourceProviderId === record.targetProviderId;
    if (sameVault && (!record.attachments || record.sourceVaultId !== record.targetVaultId)) throw new Error("移动恢复记录无效，已保留原始数据。");
    const target = await this.vault.getProvider(record.targetProviderId);
    const source: ProviderAccount | undefined = record.sourceProviderId === "local"
      ? { id: "local", kind: "local", name: "Monica", enabled: true, isDefaultSaveTarget: false, config: {} }
      : await this.vault.getProvider(record.sourceProviderId);
    if (!target || !source) throw new Error("移动期间密码库连接已变化，来源项目已保留。");
    const binding = await readMdbx2TransferBinding(this.nativeClient, target);
    if (binding.vaultId !== record.targetVaultId || (source.kind === "local" ? record.sourceVaultId !== "local"
      : (await readMdbx2TransferBinding(this.nativeClient, source)).vaultId !== record.sourceVaultId)) {
      throw new Error("移动期间密码库连接已变化，来源项目已保留。");
    }
    const current = new Map((await this.vault.listItems()).map(item => [item.id, item]));
    for (const entry of record.entries) {
      const historyIssue = mdbx2PasswordHistoryTransferBlockReason(entry.expected, entry.action, target.id);
      if (historyIssue) throw new Error(historyIssue);
      if (JSON.stringify(current.get(entry.expected.id)) !== JSON.stringify(entry.expected)) throw new Error(`项目「${entry.expected.title || entry.expected.id}」在传输期间发生变化，请重新读取后重试。`);
    }
    if (source.kind === "mdbx2" && !sameVault) {
      const sourceBinding = await readMdbx2TransferBinding(this.nativeClient, source);
      await verifyMdbx2TransferTargets(this.nativeClient, sourceBinding, record.entries.map(entry => entry.expected));
    }
    const entries: Mdbx2BatchWriteEntry[] = record.writeIntent.entries.map(entry => ({ item: entry.item, originalItem: entry.originalItem,
      originalPayload: entry.originalPayloadJson === undefined ? undefined : parseLosslessJson(entry.originalPayloadJson) as Record<string, unknown>,
      payloadPatch: entry.payloadPatchJson === undefined ? undefined : parseLosslessJson(entry.payloadPatchJson) as Record<string, unknown> }));
    const scope = await mdbx2TransferOperationScope({ version: 1, operationId: record.operationId, targetProviderId: target.id,
      entries: entries.map(entry => ({ itemId: entry.item.id, mutation: encodePreparedEntry(entry) })) });
    if (scope !== record.writeIntent.operationScope) throw new Error("移动操作与已保存的恢复记录不一致。");
    if (sameVault) for (let index = 0; index < entries.length; index++) {
      const ref = referenceFor(record.entries[index].expected, source.id), mutation = encodePreparedEntry(entries[index]);
      if (!ref?.remoteId || !ref.revision || mutation.expectedHeadCommitId !== ref.revision
        || ![`native:${ref.remoteId}`, `api-token:${ref.remoteId}`].includes(mutation.logicalObjectId)) throw new Error("移动恢复记录无效，已保留原始数据。");
    }
    const written = await this.writeBatchWithRecovery(target, scope, entries);
    // A replayed receipt may refer to a target edited after the interrupted write.
    await verifyMdbx2TransferTargets(this.nativeClient, binding, written.items);
    const proofs: Mdbx2MoveAttachmentProof[] = sameVault ? record.attachments! : [];
    for (let index = 0; index < record.entries.length; index++) {
      const expected = record.entries[index].expected, result = written.items[index];
      const operationId = await mdbx2TransferUuid(record.operationId, `attachment-transfer:${expected.id}`);
      if (sameVault) {
        const saved = proofs.filter(proof => proof.itemId === result.id);
        if (this.attachments?.verifyMoveAttachmentProofs) await this.attachments.verifyMoveAttachmentProofs(target, result, saved);
        else {
          const ref = referenceFor(result, target.id)!;
          const actual = await this.nativeClient.listAttachments(binding.vaultHandle, ref.remoteFolderId!, ref.remoteId!);
          if (saved.length || actual.items.length || actual.nextCursor) throw new Error("移动附件校验失败，来源项目已保留。");
        }
      } else if (this.attachments) {
        await this.attachments.transferAttachments(source, expected, target, result, operationId);
        if (this.attachments.captureMoveAttachmentProofs && this.attachments.verifyMoveAttachmentProofs) {
          proofs.push(...await this.attachments.captureMoveAttachmentProofs(source, expected, target, result, operationId));
        } else if ((await this.attachments.listSourceAttachments(source, expected)).length) throw new Error("移动附件校验失败，来源项目已保留。");
      } else if (source.kind === "mdbx2") {
        const ref = referenceFor(expected, source.id)!;
        const actual = await this.nativeClient.listAttachments(vaultHandleOf(source), ref.remoteFolderId!, ref.remoteId!);
        if (actual.items.length || actual.nextCursor) throw new Error("来源附件读取能力尚未接入，来源项目已保留。");
      }
    }
    const prepared: Mdbx2MoveFinalizationRecord = { ...record, status: "prepared", attachments: proofs,
      entries: record.entries.map((entry, index) => ({ ...entry, result: written.items[index] })) };
    await this.vault.prepareMdbx2MoveFinalization(prepared);
    return prepared;
  }

  private async executeRemaining(input: Mdbx2BatchTransferRequest, onProgress?: Mdbx2BatchTransferProgressListener,
    originalIntent: Mdbx2BatchTransferRequest = input): Promise<Mdbx2BatchTransferExecuteResult> {
    const context = await this.prepareContext(input);
    if (context.publicPlan.requiresMoveConfirmation && input.confirmed !== true) {
      throw new Error("MDBX2 移动操作需要二次确认。");
    }

    const results = new Map<string, Mdbx2BatchTransferItemResult>();
    for (const item of context.plan.items) {
      if (item.blockedReason) {
        results.set(item.sourceItemId, {
          sourceItemId: item.sourceItemId,
          title: context.itemsById.get(item.sourceItemId)?.title || item.sourceItemId,
          kind: context.itemsById.get(item.sourceItemId)?.kind || "secure-note",
          effectiveAction: item.effectiveAction,
          status: "blocked",
          error: item.blockedReason,
          retryable: false
        });
      }
    }
    reportTransferProgress(onProgress, context.operationId, "preparing", results, context.plan.items.length);

    const work: PreparedTransferWork[] = [];
    for (const planItem of context.plan.items) {
      if (planItem.blockedReason) continue;
      try {
        work.push(await this.prepareWork(context, planItem));
      } catch (error) {
        const source = context.itemsById.get(planItem.sourceItemId)!;
        results.set(source.id, itemFailure(source, planItem.effectiveAction, error));
        reportTransferProgress(onProgress, context.operationId, "preparing", results, context.plan.items.length);
      }
    }

    const writeable = await this.rejectReplicaConflicts(context, work, results);
    reportTransferProgress(onProgress, context.operationId, "preparing", results, context.plan.items.length);
    const groups: PreparedTransferWork[][] = [];
    for (const component of completeTransferComponents(context.components, writeable, entry => entry.sourceItem.id)) {
      if (component.complete) groups.push(component.entries);
      else for (const entry of component.entries) results.set(entry.sourceItem.id, itemFailure(entry.sourceItem, entry.planItem.effectiveAction,
        new Error("关联项目未能完整准备，整组保留在来源库。")));
    }
    const chunks = partitionWork(groups, results);
    for (const chunk of chunks) {
      reportTransferProgress(onProgress, context.operationId, "writing", results, context.plan.items.length);
      const encoded = chunk.map((entry) => entry.targetEntry);
      const operationScope = await mdbx2TransferOperationScope({
        version: 1,
        operationId: context.operationId,
        targetProviderId: context.request.targetProviderId,
        entries: encoded.map((entry) => ({
          itemId: entry.item.id,
          mutation: encodePreparedEntry(entry)
        }))
      });
      if (isRecoverableMoveGroup(chunk)) {
        try {
          const source = chunk[0].sourceAccount;
          const ids = chunk.map(entry => entry.sourceItem.id).sort();
          const record: Mdbx2MoveFinalizationRecord = {
            version: 1, id: await mdbx2TransferUuid(context.operationId, `move-finalization:${JSON.stringify(ids)}`),
            operationId: context.operationId, createdAt: context.operationCreatedAt, status: "writing",
            requestHash: await mdbx2TransferRequestHash({ ...originalIntent, operationId: context.operationId, operationCreatedAt: context.operationCreatedAt }),
            request: { itemIds: [...new Set(originalIntent.itemIds)].sort(), targetCollectionId: normalizedCollectionId(originalIntent.targetCollectionId),
              preserveCategories: originalIntent.preserveCategories, action: originalIntent.action },
            sourceProviderId: source.id, targetProviderId: context.targetAccount.id,
            sourceVaultId: source.kind === "local" ? "local" : context.moveBindings.get(source.id)!.vaultId,
            targetVaultId: context.moveBindings.get(context.targetAccount.id)!.vaultId,
            writeIntent: { operationScope, attachmentCount: chunk.reduce((sum, entry) => sum + entry.sourceAttachments.length, 0),
              entries: encoded.map(entry => ({ item: entry.item, originalItem: entry.originalItem,
              originalPayloadJson: entry.originalPayload === undefined ? undefined : JSON.stringify(entry.originalPayload),
              payloadPatchJson: entry.payloadPatch === undefined ? undefined : JSON.stringify(entry.payloadPatch) })) },
            entries: chunk.map(entry => ({ expected: entry.sourceItem, result: entry.targetItem, action: "move" }))
          };
          if (source.id === context.targetAccount.id) {
            record.attachments = [];
            for (const entry of chunk) {
              if (this.attachments?.captureMoveAttachmentProofs && this.attachments.verifyMoveAttachmentProofs) {
                record.attachments.push(...await this.attachments.captureMoveAttachmentProofs(source, entry.sourceItem, source,
                  entry.sourceItem, await mdbx2TransferUuid(context.operationId, `attachment-transfer:${entry.sourceItem.id}`)));
              } else {
                const ref = referenceFor(entry.sourceItem, source.id)!;
                const actual = await this.nativeClient.listAttachments(vaultHandleOf(source), ref.remoteFolderId!, ref.remoteId!);
                if (entry.sourceAttachments.length || actual.items.length || actual.nextCursor) throw new Error("移动附件校验失败，来源项目已保留。");
              }
            }
          }
          await this.vault.stageMdbx2MoveFinalization(record);
          await this.resumeFinalization(record);
          for (const entry of chunk) results.set(entry.sourceItem.id, { sourceItemId: entry.sourceItem.id, title: entry.sourceItem.title,
            kind: entry.sourceItem.kind, effectiveAction: "move", status: "completed", targetItemId: entry.targetItem.id, retryable: false });
        } catch (error) {
          for (const entry of chunk) results.set(entry.sourceItem.id, itemFailure(entry.sourceItem, "move", error));
        }
        continue;
      }
      let written: Mdbx2BatchWriteResult;
      try {
        written = await this.writeBatchWithRecovery(context.targetAccount, operationScope, encoded);
      } catch (error) {
        for (const entry of chunk) results.set(entry.sourceItem.id, itemFailure(entry.sourceItem, entry.planItem.effectiveAction, error));
        reportTransferProgress(onProgress, context.operationId, "writing", results, context.plan.items.length);
        continue;
      }

      // Complete all attachment work before any related source can be removed.
      const attachmentFailures = new Map<string, unknown>();
      const attachmentProofs = new Map<string, Mdbx2MoveAttachmentProof[]>();
      for (let index = 0; index < chunk.length; index += 1) {
        const entry = chunk[index];
        const targetItem = written.items[index];
        try {
          reportTransferProgress(onProgress, context.operationId, "attachments", results, context.plan.items.length);
          if (this.attachments) {
            await this.attachments.transferAttachments(
              entry.sourceAccount,
              entry.sourceItem,
              context.targetAccount,
              targetItem,
              await mdbx2TransferUuid(context.operationId, `attachment-transfer:${entry.sourceItem.id}`)
            );
          } else if (entry.sourceAttachments.length > 0) {
            throw new Error("来源附件读取能力尚未接入，来源项目已保留。");
          }
          if (entry.planItem.effectiveAction === "move" && entry.sourceAccount.id !== context.targetAccount.id) {
            if (this.attachments?.captureMoveAttachmentProofs && this.attachments.verifyMoveAttachmentProofs) {
              attachmentProofs.set(entry.sourceItem.id, await this.attachments.captureMoveAttachmentProofs(entry.sourceAccount,
                entry.sourceItem, context.targetAccount, targetItem, await mdbx2TransferUuid(context.operationId, `attachment-transfer:${entry.sourceItem.id}`)));
            } else if (entry.sourceAttachments.length) {
              throw new Error("移动附件校验失败，来源项目已保留。");
            } else attachmentProofs.set(entry.sourceItem.id, []);
          }

        } catch (error) { attachmentFailures.set(entry.sourceItem.id, error); }
      }
      for (const component of context.components) {
        const failedId = component.find(id => attachmentFailures.has(id));
        if (failedId) for (const id of component) attachmentFailures.set(id, attachmentFailures.get(failedId));
      }
      // Adopt dependency groups together. MDBX sources support a single atomic
      // deletion; local and same-vault moves require no external source delete.
      const chunkById = new Map(chunk.map((entry, index) => [entry.sourceItem.id, { entry, target: written.items[index] }]));
      for (const component of context.components) {
        const group = component.map(id => chunkById.get(id));
        if (group.some(item => !item)) continue;
        const complete = group.map(item => item!);
        const sourceAccount = complete[0].entry.sourceAccount;
        const groupAction = complete[0].entry.planItem.effectiveAction;
        if (complete.some(item => item.entry.planItem.effectiveAction !== groupAction)) continue;
        if (groupAction === "move" && (complete.some(item => item.entry.sourceAccount.id !== sourceAccount.id)
          || !["mdbx2", "local"].includes(sourceAccount.kind))) continue;
        if (component.some(id => attachmentFailures.has(id))) continue;
        try {
          const completedEntries = complete.map(({entry, target}) => ({ expected: entry.sourceItem, result: target, action: groupAction }));
          // A cross-vault target write leaves the original source unchanged. Save
          // its complete finalization intent before the first destructive step.
          // Same-vault moves need a separate journal before the target write itself.
          let finalizationId: string | undefined;
          if (groupAction === "move" && sourceAccount.id !== context.targetAccount.id) {
            finalizationId = await mdbx2TransferUuid(context.operationId, `move-finalization:${JSON.stringify(component.slice().sort())}`);
            const record: Mdbx2MoveFinalizationRecord = {
              version: 1, id: finalizationId, operationId: context.operationId,
              requestHash: await mdbx2TransferRequestHash({ ...originalIntent, operationId: context.operationId, operationCreatedAt: context.operationCreatedAt }),
              request: { itemIds: [...new Set(originalIntent.itemIds)].sort(), targetCollectionId: normalizedCollectionId(originalIntent.targetCollectionId),
                preserveCategories: originalIntent.preserveCategories, action: originalIntent.action },
              sourceProviderId: sourceAccount.id, targetProviderId: context.targetAccount.id,
              sourceVaultId: sourceAccount.kind === "local" ? "local" : context.moveBindings.get(sourceAccount.id)!.vaultId,
              targetVaultId: context.moveBindings.get(context.targetAccount.id)!.vaultId,
              createdAt: context.operationCreatedAt, status: "prepared",
              attachments: complete.flatMap(({ entry }) => attachmentProofs.get(entry.sourceItem.id) || []),
              entries: completedEntries.map(entry => ({ ...entry, action: "move" }))
            };
            await this.vault.stageMdbx2MoveFinalization(record);
          }
          await this.vault.applyCompletedMdbx2Transfer(completedEntries,
            context.request.targetProviderId, groupAction === "move"
              ? async (pending, providers) => {
                await this.verifyMoveFinalization(context, sourceAccount, pending.map(item => item.result), providers);
                for (const item of pending) {
                  const proofs = attachmentProofs.get(item.expected.id);
                  if (proofs && this.attachments?.verifyMoveAttachmentProofs) await this.attachments.verifyMoveAttachmentProofs(context.targetAccount, item.result, proofs);
                }
                if (sourceAccount.kind === "mdbx2" && sourceAccount.id !== context.targetAccount.id) {
                  await deleteMdbx2TransferSources(this.nativeClient, sourceAccount, pending.map(item => item.expected), context.operationId, context.targetAccount.id);
                }
              }
              : undefined, finalizationId);
          for (const {entry, target} of complete) results.set(entry.sourceItem.id, {
            sourceItemId: entry.sourceItem.id, title: entry.sourceItem.title, kind: entry.sourceItem.kind,
            effectiveAction: groupAction, status: "completed", targetItemId: target.id, retryable: false
          });
        } catch (error) {
          for (const {entry} of complete) results.set(entry.sourceItem.id, itemFailure(entry.sourceItem, groupAction, error));
        }
      }
      for (let index = 0; index < chunk.length; index += 1) {
        const entry = chunk[index], targetItem = written.items[index];
        if (results.has(entry.sourceItem.id)) continue;
        if (attachmentFailures.has(entry.sourceItem.id)) {
          results.set(entry.sourceItem.id, itemFailure(entry.sourceItem, entry.planItem.effectiveAction, attachmentFailures.get(entry.sourceItem.id)));
          continue;
        }
        try {
          const completed: CompletedMdbx2TransferEntry = {
            expected: entry.sourceItem,
            result: targetItem,
            action: entry.planItem.effectiveAction
          };
          const deleteSource = shouldDeleteSource(entry.sourceAccount, context.targetAccount, entry.planItem.effectiveAction)
            ? async (providers: readonly ProviderAccount[]) => {
              await this.verifyMoveFinalization(context, entry.sourceAccount, [targetItem], providers);
              await this.deleteSource(context.operationId, entry.sourceAccount, entry.sourceItem);
            }
            : undefined;
          reportTransferProgress(onProgress, context.operationId, "finalizing", results, context.plan.items.length);
          await this.vault.finalizeCompletedMdbx2Transfer(completed, context.request.targetProviderId, deleteSource);
          results.set(entry.sourceItem.id, {
            sourceItemId: entry.sourceItem.id,
            title: entry.sourceItem.title,
            kind: entry.sourceItem.kind,
            effectiveAction: entry.planItem.effectiveAction,
            status: "completed",
            targetItemId: targetItem.id,
            retryable: false
          });
        } catch (error) {
          results.set(entry.sourceItem.id, itemFailure(entry.sourceItem, entry.planItem.effectiveAction, error));
        }
        reportTransferProgress(onProgress, context.operationId, "finalizing", results, context.plan.items.length);
      }
    }

    const items = context.plan.items.map((planItem) => results.get(planItem.sourceItemId) || itemFailure(
      context.itemsById.get(planItem.sourceItemId)!,
      planItem.effectiveAction,
      new Error("MDBX2 批量传输未产生结果。")
    ));
    const result = {
      operationId: context.operationId,
      action: context.request.action,
      targetProviderId: context.request.targetProviderId,
      items,
      completedCount: items.filter((item) => item.status === "completed").length,
      blockedCount: items.filter((item) => item.status === "blocked").length,
      failedCount: items.filter((item) => item.status === "failed").length,
      warnings: context.publicPlan.warnings
    };
    reportTransferProgress(onProgress, context.operationId, "completed", new Map(items.map((item) => [item.sourceItemId, item])), items.length);
    return result;
  }

  private async prepareContext(input: Mdbx2BatchTransferRequest): Promise<PreparedContext> {
    if (!Array.isArray(input.itemIds) || !input.itemIds.length || input.itemIds.length > MAX_TRANSFER_ITEMS) throw new Error("MDBX2 批量传输项目数量无效。");
    const operationId = assertMdbx2TransferOperationId(input.operationId || crypto.randomUUID());
    const operationCreatedAt = normalizedOperationTime(input.operationCreatedAt);
    const targetCollectionId = normalizedCollectionId(input.targetCollectionId);
    const targetAccount = await this.vault.getProvider(input.targetProviderId);
    if (!targetAccount || targetAccount.kind !== "mdbx2" || !targetAccount.enabled) throw new Error("目标 MDBX2 密码源不存在或已禁用。");
    const vaultHandle = vaultHandleOf(targetAccount);
    const status = await this.nativeClient.vaultStatus(vaultHandle);
    if (!status.open || !status.available) throw new Error("目标 MDBX2 本机工作副本尚未解锁。");

    const allItems = await this.vault.listItems();
    const itemsById = new Map(allItems.map((item) => [item.id, item]));
    if (input.itemIds.some(id => !itemsById.has(id))) throw new Error("所选项目已变化，请刷新管理页后重试。");
    const { selectedIds, components } = mdbx2TransferDependencies(input.itemIds, allItems, input.action);
    if (selectedIds.length > MAX_TRANSFER_ITEMS) throw new Error("展开完整多密码项目后超过单次传输上限，请减少选择的项目。");
    const selectedItems = selectedIds.map(id => itemsById.get(id)!);
    const sourceAccounts = new Map<string, ProviderAccount>();
    for (const item of selectedItems) {
      const account = await this.sourceAccount(item, input.targetProviderId);
      sourceAccounts.set(item.id, account);
    }

    const sourceCollections: Mdbx2CollectionSummary[] = [];
    const mdbxAccounts = [...new Map([...sourceAccounts.values()].filter((account) => account.kind === "mdbx2").map((account) => [account.id, account])).values()];
    for (const account of mdbxAccounts) {
      sourceCollections.push(...await listMdbx2TransferCollections(this.nativeClient, vaultHandleOf(account), false));
    }

    const targetIds = new Map<string, string>();
    for (const item of selectedItems) {
      if (item.kind === "passkey" || input.action === "move") targetIds.set(item.id, item.id);
      else targetIds.set(item.id, await mdbx2TransferUuid(operationId, `item:${input.targetProviderId}:${item.id}`));
    }
    const plan = planMdbx2BatchTransfer(selectedItems, {
      action: input.action,
      targetProviderId: targetAccount.id,
      targetCollectionId,
      preserveCategories: input.preserveCategories,
      collections: sourceCollections,
      now: operationCreatedAt,
      idFactory: (item) => targetIds.get(item.id)!
    });
    for (const component of components) {
      const related = plan.items.filter(item => component.includes(item.sourceItemId));
      if (!related.some(item => item.blockedReason)) continue;
      for (const item of related) if (!item.blockedReason) {
        item.blockedReason = "关联项目无法完整传输，整组保留在来源库。";
        item.targetItem = undefined;
        item.payloadPatch = undefined;
      }
    }
    plan.blockedCount = plan.items.filter(item => item.blockedReason).length;
    const publicPlan: Mdbx2BatchTransferPlanResult = {
      operationId,
      operationCreatedAt,
      action: input.action,
      targetProviderId: input.targetProviderId,
      targetCollectionId,
      preserveCategories: input.preserveCategories,
      items: plan.items.map((item) => {
        const source = itemsById.get(item.sourceItemId)!;
        return {
          sourceItemId: source.id,
          title: source.title,
          kind: source.kind,
          effectiveAction: item.effectiveAction,
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
          pathIncomplete: item.pathIncomplete,
          blockedReason: item.blockedReason
        };
      }),
      blockedCount: plan.blockedCount,
      transferableCount: plan.items.filter((item) => !item.blockedReason).length,
      requiresMoveConfirmation: plan.items.some((item) => !item.blockedReason && item.effectiveAction === "move"),
      warnings: plan.warnings
    };
    const moveBindings = new Map<string, Mdbx2TransferVaultBinding>();
    if (publicPlan.requiresMoveConfirmation) {
      for (const account of [targetAccount, ...mdbxAccounts]) {
        if (!moveBindings.has(account.id)) moveBindings.set(account.id, await readMdbx2TransferBinding(this.nativeClient, account));
      }
    }
    return { moveBindings, components, operationId, operationCreatedAt, request: { ...input, operationId, operationCreatedAt, targetCollectionId }, targetAccount, itemsById, accountsByItemId: sourceAccounts, plan, publicPlan };
  }

  private async verifyMoveFinalization(context: PreparedContext, source: ProviderAccount, targets: VaultItem[], providers: readonly ProviderAccount[]): Promise<void> {
    const targetBinding = context.moveBindings.get(context.targetAccount.id);
    if (!targetBinding) throw new Error("目标项目缺少已验证的提交信息，来源项目已保留。");
    for (const id of new Set([context.targetAccount.id, ...(source.kind === "mdbx2" ? [source.id] : [])])) {
      const binding = context.moveBindings.get(id)!;
      await verifyMdbx2TransferBinding(this.nativeClient, providers.find(account => account.id === id), binding);
    }
    await verifyMdbx2TransferTargets(this.nativeClient, targetBinding, targets);
  }

  private async sourceAccount(item: VaultItem, targetProviderId: string): Promise<ProviderAccount> {
    const references = item.providerRefs.filter((reference) => reference.providerId !== "local");
    if (!references.length) return { id: "local", kind: "local", name: "Monica 本地库", enabled: true, isDefaultSaveTarget: true, config: {} };
    if (references.length !== 1) throw new Error(`项目「${item.title || item.id}」绑定了多个密码源，无法判断移动来源。`);
    const account = await this.vault.getProvider(references[0].providerId);
    if (!account || !account.enabled) throw new Error(`项目「${item.title || item.id}」的来源密码源不可用。`);
    if (account.id === targetProviderId && account.kind !== "mdbx2") throw new Error("目标密码源必须是 MDBX2。");
    return account;
  }

  private async prepareWork(context: PreparedContext, planItem: Mdbx2BatchTransferPlanItem): Promise<PreparedTransferWork> {
    const sourceItem = context.itemsById.get(planItem.sourceItemId)!;
    const sourceAccount = context.accountsByItemId.get(sourceItem.id)!;
    const targetItem = structuredClone(planItem.targetItem!) as VaultItem;
    const pathKey = JSON.stringify(planItem.targetPath);
    const ensured = await ensureMdbx2TransferCollectionPaths(this.nativeClient, {
      operationId: context.operationId,
      targetProviderId: context.request.targetProviderId,
      vaultHandle: vaultHandleOf(context.targetAccount),
      baseCollectionId: context.request.targetCollectionId,
      paths: [planItem.targetPath]
    });
    targetItem.mdbxFolderId = ensured.collectionIdByPath.get(pathKey) || context.request.targetCollectionId;
    const targetCollectionIdForConflict = targetItem.mdbxFolderId || (planItem.effectiveAction === "move"
      ? await this.targetRootCollectionId(context.targetAccount)
      : undefined);

    const original = await this.originalMdbxPayload(sourceAccount, sourceItem);
    if (planItem.effectiveAction === "move" && sourceAccount.id === context.targetAccount.id) {
      targetItem.providerRefs = sourceItem.providerRefs;
    }
    const sourceAttachments = this.attachments
      ? await this.attachments.listSourceAttachments(sourceAccount, sourceItem)
      : [];
    const targetEntry: Mdbx2BatchWriteEntry = {
      item: targetItem,
      originalPayload: original?.payload,
      originalItem: original?.item,
      payloadPatch: planItem.effectiveAction === "copy" && targetItem.kind !== "api-token"
        ? { ...planItem.payloadPatch, monica_entry_id: mdbx2LogicalObjectId(targetItem) }
        : planItem.payloadPatch
    };
    const encoded = encodePreparedEntry(targetEntry);
    if (!encoded) throw new Error("此项目类型无法编码为 Android MDBX2 Object。");
    if (new TextEncoder().encode(JSON.stringify(encoded)).byteLength > MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES) {
      throw new Error("项目内容超过 MDBX2 批量写入上限。");
    }
    return { planItem, sourceItem, sourceAccount, targetItem, targetCollectionIdForConflict, targetEntry, sourceAttachments };
  }

  private async rejectReplicaConflicts(
    context: PreparedContext,
    work: PreparedTransferWork[],
    results: Map<string, Mdbx2BatchTransferItemResult>
  ): Promise<PreparedTransferWork[]> {
    const accepted: PreparedTransferWork[] = [];
    for (const entry of work) {
      if (entry.planItem.effectiveAction === "copy") {
        accepted.push(entry);
        continue;
      }
      const logicalId = mdbx2LogicalObjectId(entry.targetItem);
      const sourceReference = referenceFor(entry.sourceItem, entry.sourceAccount.id);
      const existing = await findLogicalObject(
        this.nativeClient,
        vaultHandleOf(context.targetAccount),
        entry.targetCollectionIdForConflict || "",
        logicalId
      );
      if (existing && !(entry.sourceAccount.id === context.request.targetProviderId && existing.objectId === sourceReference?.remoteId)) {
        results.set(entry.sourceItem.id, itemFailure(entry.sourceItem, entry.planItem.effectiveAction, new Error("目标文件夹已存在相同逻辑项目。"), false));
        continue;
      }
      accepted.push(entry);
    }
    return accepted;
  }

  private async originalMdbxPayload(account: ProviderAccount, item: VaultItem): Promise<{ payload: Record<string, unknown>; item: VaultItem } | undefined> {
    if (account.kind !== "mdbx2") return undefined;
    const reference = referenceFor(item, account.id);
    if (!reference?.remoteId) throw new Error("来源 MDBX2 项目缺少远端 Object 标识。");
    const record = await this.nativeClient.revealObject(vaultHandleOf(account), reference.remoteId);
    if (record.deleted || record.objectId !== reference.remoteId) throw new Error("来源 MDBX2 Object 已删除或响应目标不一致。");
    let payload: Record<string, unknown>;
    try {
      payload = parseLosslessJson(record.payloadJson) as Record<string, unknown>;
    } catch {
      throw new Error("来源 MDBX2 Object 载荷不是有效 JSON，已保留来源。");
    }
    if (!reference.revision || record.headCommitId && record.headCommitId !== reference.revision) throw new Error("来源 MDBX2 项目版本已变化，请刷新后重试。");
    const decoded = decodeMdbx2Object(record, { headCommitId: record.headCommitId || reference.revision, updatedAt: item.updatedAt }, account.id);
    if (!decoded.item || decoded.item.kind === "opaque") throw new Error("来源 MDBX2 类型或版本仅可安全查看，已保留来源。");
    return { payload, item: decoded.item };
  }

  private async writeBatchWithRecovery(
    targetAccount: ProviderAccount,
    operationScope: string,
    entries: readonly Mdbx2BatchWriteEntry[]
  ): Promise<Mdbx2BatchWriteResult> {
    try {
      return await this.targetProvider.createPreparedBatch(targetAccount, operationScope, entries);
    } catch (firstError) {
      const status = await this.nativeClient.resolveObjectOperation(vaultHandleOf(targetAccount), operationScope).catch(() => undefined);
      if (!status?.known || !status.committed) throw firstError;
      return this.targetProvider.createPreparedBatch(targetAccount, operationScope, entries);
    }
  }

  private async targetRootCollectionId(account: ProviderAccount): Promise<string> {
    const roots = (await listMdbx2TransferCollections(this.nativeClient, vaultHandleOf(account), false))
      .filter(isMdbx2RootCollection);
    if (roots.length !== 1) throw new Error("目标 MDBX2 根文件夹无法唯一识别，已阻止移动。");
    return roots[0].collectionId;
  }

  private async deleteSource(operationId: string, account: ProviderAccount, item: VaultItem): Promise<void> {
    if (account.kind === "local") return;
    if (account.kind === "mdbx2") {
      const operation = await mdbx2TransferUuid(operationId, `source-delete:${account.id}:${item.id}`);
      const reference = referenceFor(item, account.id);
      if (!reference?.remoteId || !reference.revision) throw new Error("来源 MDBX2 缺少原生身份或版本，已保留来源。");
      const logicalId = `native:${reference.remoteId}`;
      const result = await this.nativeClient.deleteObject(vaultHandleOf(account), operation, logicalId, reference.revision);
      if (result.logicalObjectId !== logicalId || result.objectId !== reference.remoteId) throw new Error("来源 MDBX2 删除响应与项目不一致。");
      return;
    }
    await this.registry.get(account.kind).remove(account, item);
  }
}

/** Confirmation is transient; all content and destination choices belong to the intent. */
export async function mdbx2TransferRequestHash(request: Mdbx2BatchTransferRequest): Promise<string> {
  return mdbx2TransferOperationScope({
    version: 1, operationId: request.operationId, operationCreatedAt: request.operationCreatedAt,
    itemIds: [...new Set(request.itemIds)].sort(), targetProviderId: request.targetProviderId,
    targetCollectionId: normalizedCollectionId(request.targetCollectionId),
    preserveCategories: request.preserveCategories, action: request.action
  });
}

function encodePreparedEntry(entry: Mdbx2BatchWriteEntry): Mdbx2ObjectMutationInput {
  const encoded = encodeMdbx2Object(entry.item, entry.originalPayload, entry.originalItem);
  if (!encoded) throw new Error(`项目「${entry.item.title || entry.item.id}」无法写入 MDBX2。`);
  if (entry.payloadPatch) {
    const payload = parseLosslessJson(encoded.payloadJson) as Record<string, unknown>;
    encoded.payloadJson = JSON.stringify({ ...payload, ...entry.payloadPatch });
  }
  return { kind: "upsert", ...encoded };
}

function isRecoverableMoveGroup(group: readonly PreparedTransferWork[]): boolean {
  const source = group[0].sourceAccount;
  return ["local", "mdbx2"].includes(source.kind) && group.every(entry => entry.planItem.effectiveAction === "move"
    && entry.sourceAccount.id === source.id);
}

function partitionWork(groups: readonly PreparedTransferWork[][], results: Map<string, Mdbx2BatchTransferItemResult>): PreparedTransferWork[][] {
  const chunks: PreparedTransferWork[][] = [];
  let current: PreparedTransferWork[] = [];
  let currentBytes = 0;
  for (const group of groups) {
    const bytes = group.reduce((sum, entry) => sum + new TextEncoder().encode(JSON.stringify(encodePreparedEntry(entry.targetEntry))).byteLength, 0);
    if (group.length > MDBX2_MAX_OBJECT_BATCH_MUTATIONS || bytes > MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES) {
      for (const entry of group) results.set(entry.sourceItem.id, itemFailure(entry.sourceItem, entry.planItem.effectiveAction,
        new Error("关联项目合计超过单次写入上限，整组保留在来源库。"), false));
      continue;
    }
    if (isRecoverableMoveGroup(group)) {
      if (current.length) { chunks.push(current); current = []; currentBytes = 0; }
      chunks.push(group);
      continue;
    }
    if (current.length && (current.length + group.length > MDBX2_MAX_OBJECT_BATCH_MUTATIONS || currentBytes + bytes > MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(...group);
    currentBytes += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function findLogicalObject(
  client: Mdbx2BatchTransferNativeClient,
  vaultHandle: string,
  collectionId: string,
  logicalId: string
): Promise<{ objectId: string; record: Mdbx2ObjectRecord } | undefined> {
  if (!collectionId) return Promise.resolve(undefined);
  return findLogicalObjectPaged(client, vaultHandle, collectionId, logicalId);
}

async function findLogicalObjectPaged(
  client: Mdbx2BatchTransferNativeClient,
  vaultHandle: string,
  collectionId: string,
  logicalId: string
): Promise<{ objectId: string; record: Mdbx2ObjectRecord } | undefined> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.listObjects(vaultHandle, collectionId, { deleted: false, pageSize: 200, cursor });
    for (const summary of page.items) {
      const record = await client.revealObject(vaultHandle, summary.objectId);
      if (record.objectTypeId === "api-token" && logicalId === `api-token:${record.objectId}`) return { objectId: summary.objectId, record };
      let payload: Record<string, unknown>;
      try { payload = parseLosslessJson(record.payloadJson) as Record<string, unknown>; } catch { continue; }
      if (payload.monica_entry_id === logicalId) return { objectId: summary.objectId, record };
    }
    if (!page.nextCursor) return undefined;
    if (!page.items.length || seen.has(page.nextCursor)) throw new Error("MDBX2 Object 分页游标没有前进。");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

function vaultHandleOf(account: ProviderAccount): string {
  const handle = typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : "";
  if (!handle) throw new Error(`MDBX2 密码源「${account.name}」缺少本机工作副本句柄。`);
  return handle;
}

function referenceFor(item: VaultItem, providerId: string): ProviderReference | undefined {
  return item.providerRefs.find((reference) => reference.providerId === providerId);
}

function shouldDeleteSource(source: ProviderAccount, target: ProviderAccount, action: Mdbx2BatchTransferAction): boolean {
  return action === "move" && !(source.id === target.id && source.kind === "mdbx2");
}

function itemFailure(item: VaultItem, action: Mdbx2BatchTransferAction, error: unknown, retryable = true): Mdbx2BatchTransferItemResult {
  return {
    sourceItemId: item.id,
    title: item.title,
    kind: item.kind,
    effectiveAction: action,
    status: "failed",
    error: error instanceof Error ? error.message : "MDBX2 批量传输失败。",
    retryable
  };
}

function reportTransferProgress(
  listener: Mdbx2BatchTransferProgressListener | undefined,
  operationId: string,
  phase: Mdbx2BatchTransferPhase,
  results: ReadonlyMap<string, Mdbx2BatchTransferItemResult>,
  total: number
): void {
  if (!listener) return;
  const values = [...results.values()];
  try {
    listener({
      operationId,
      phase,
      processed: values.length,
      total,
      completedCount: values.filter((item) => item.status === "completed").length,
      blockedCount: values.filter((item) => item.status === "blocked").length,
      failedCount: values.filter((item) => item.status === "failed").length
    });
  } catch {
    // Progress reporting must never change the outcome of an authenticated transfer.
  }
}

function normalizedOperationTime(value: string | undefined): string {
  const timestamp = value || new Date().toISOString();
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) throw new Error("MDBX2 批量传输时间无效。");
  return timestamp;
}

function normalizedCollectionId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized !== "root" ? normalized : undefined;
}
