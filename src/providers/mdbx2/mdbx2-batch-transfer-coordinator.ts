import type {
  ProviderAccount,
  ProviderReference,
  ProviderSourceRecord,
  VaultItem
} from "../../core/model";
import type { ProviderAdapter } from "../../core/provider";
import { encodeMdbx2Object, mdbx2LogicalObjectId } from "./mdbx2-item-codec";
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
  listItems(): Promise<VaultItem[]>;
  getProvider(providerId: string): Promise<ProviderAccount | undefined>;
  getProviderSourceRecords(providerId: string): Promise<ProviderSourceRecord[]>;
  finalizeCompletedMdbx2Transfer(
    entry: CompletedMdbx2TransferEntry,
    targetProviderId: string,
    deleteSource?: () => Promise<void>
  ): Promise<VaultItem>;
}

export interface Mdbx2BatchTransferProviderRegistry {
  get(kind: ProviderAccount["kind"]): ProviderAdapter;
}

export interface Mdbx2BatchTransferNativeClient extends Mdbx2TransferCollectionClient {
  vaultStatus(vaultHandle: string): Promise<Mdbx2VaultRuntimeStatus>;
  listObjects(
    vaultHandle: string,
    collectionId: string,
    input?: { objectTypeId?: string; deleted?: boolean; pageSize?: number; cursor?: string }
  ): Promise<Mdbx2ObjectSummaryPage>;
  revealObject(vaultHandle: string, objectId: string): Promise<Mdbx2ObjectRecord>;
  deleteObject(vaultHandle: string, operationId: string, logicalObjectId: string): Promise<Mdbx2ObjectDeleteResult>;
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

  async execute(
    input: Mdbx2BatchTransferRequest,
    onProgress?: Mdbx2BatchTransferProgressListener
  ): Promise<Mdbx2BatchTransferExecuteResult> {
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
    const chunks = partitionWork(writeable);
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
      let written: Mdbx2BatchWriteResult;
      try {
        written = await this.writeBatchWithRecovery(context.targetAccount, operationScope, encoded);
      } catch (error) {
        for (const entry of chunk) results.set(entry.sourceItem.id, itemFailure(entry.sourceItem, entry.planItem.effectiveAction, error));
        reportTransferProgress(onProgress, context.operationId, "writing", results, context.plan.items.length);
        continue;
      }

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

          const completed: CompletedMdbx2TransferEntry = {
            expected: entry.sourceItem,
            result: targetItem,
            action: entry.planItem.effectiveAction
          };
          const deleteSource = shouldDeleteSource(entry.sourceAccount, context.targetAccount, entry.planItem.effectiveAction)
            ? () => this.deleteSource(context.operationId, entry.sourceAccount, entry.sourceItem)
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
    const selected = [...new Set(input.itemIds)].map((id) => itemsById.get(id));
    if (selected.some((item) => !item)) throw new Error("所选项目已变化，请刷新管理页后重试。");
    const selectedItems = selected as VaultItem[];
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
      targetCollectionId,
      preserveCategories: input.preserveCategories,
      collections: sourceCollections,
      now: operationCreatedAt,
      idFactory: (item) => targetIds.get(item.id)!
    });
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
    return { operationId, operationCreatedAt, request: { ...input, operationId, operationCreatedAt, targetCollectionId }, targetAccount, itemsById, accountsByItemId: sourceAccounts, plan, publicPlan };
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
    const sourceAttachments = this.attachments
      ? await this.attachments.listSourceAttachments(sourceAccount, sourceItem)
      : [];
    const targetEntry: Mdbx2BatchWriteEntry = {
      item: targetItem,
      originalPayload: original?.payload,
      originalItem: original?.item,
      payloadPatch: planItem.payloadPatch
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
      payload = JSON.parse(record.payloadJson) as Record<string, unknown>;
    } catch {
      throw new Error("来源 MDBX2 Object 载荷不是有效 JSON，已保留来源。");
    }
    const logicalId = typeof payload.monica_entry_id === "string" ? payload.monica_entry_id : "";
    if (!logicalId || logicalId !== mdbx2LogicalObjectId(item)) throw new Error("来源 MDBX2 Object 逻辑 ID 不一致，已阻止传输。");
    return { payload, item };
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
      const result = await this.nativeClient.deleteObject(vaultHandleOf(account), operation, mdbx2LogicalObjectId(item));
      if (result.logicalObjectId !== mdbx2LogicalObjectId(item)) throw new Error("来源 MDBX2 删除响应与项目不一致。");
      return;
    }
    await this.registry.get(account.kind).remove(account, item);
  }
}

function encodePreparedEntry(entry: Mdbx2BatchWriteEntry): Mdbx2ObjectMutationInput {
  const encoded = encodeMdbx2Object(entry.item, entry.originalPayload, entry.originalItem);
  if (!encoded) throw new Error(`项目「${entry.item.title || entry.item.id}」无法写入 MDBX2。`);
  if (entry.payloadPatch) {
    const payload = JSON.parse(encoded.payloadJson) as Record<string, unknown>;
    encoded.payloadJson = JSON.stringify({ ...payload, ...entry.payloadPatch });
  }
  return { kind: "upsert", ...encoded };
}

function partitionWork(work: readonly PreparedTransferWork[]): PreparedTransferWork[][] {
  const chunks: PreparedTransferWork[][] = [];
  let current: PreparedTransferWork[] = [];
  let currentBytes = 0;
  for (const entry of work) {
    const bytes = new TextEncoder().encode(JSON.stringify(encodePreparedEntry(entry.targetEntry))).byteLength;
    if (current.length && (current.length >= MDBX2_MAX_OBJECT_BATCH_MUTATIONS || currentBytes + bytes > MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
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
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(record.payloadJson) as Record<string, unknown>; } catch { continue; }
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
