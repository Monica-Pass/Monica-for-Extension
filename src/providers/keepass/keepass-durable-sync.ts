import type { PendingMutation, ProviderAccount, ProviderConflictInput, ProviderSourceRecord, VaultItem, VaultState } from "../../core/model";
import type { ProviderAcknowledgedMutation, ProviderSyncResult } from "../../core/provider";
import { KeePassProvider } from "./keepass-provider";
import { keePassMutationIntentSha256, KeePassRemoteSessionError, KeePassRemoteSessionService } from "./keepass-remote-session";
import type { KeePassDurableMutationReceipt } from "./keepass-working-copy-store";

export const KEEPASS_ITEM_SYNC_RECEIPT_ID = "item-sync-pending";
export const KEEPASS_ITEM_SYNC_BATCH_LIMIT = 100;

export interface KeePassDurableSyncVault {
  readState(): Promise<Pick<VaultState, "items" | "mutationQueue">>;
  applyProviderSync(
    providerId: string,
    items: VaultItem[],
    accountPatch?: Partial<ProviderAccount>,
    conflicts?: ProviderConflictInput[],
    sourceRecords?: ProviderSourceRecord[],
    syncSnapshot?: VaultItem[]
  ): Promise<unknown>;
}

export type KeePassAccountConfigWriter = (account: ProviderAccount, config: Record<string, unknown>) => Promise<ProviderAccount>;

export class KeePassDurableSyncCoordinator {
  constructor(
    private readonly provider: KeePassProvider,
    private readonly remoteSessions: KeePassRemoteSessionService,
    private readonly vault: KeePassDurableSyncVault,
    private readonly writeAccountConfig: KeePassAccountConfigWriter
  ) {}

  async synchronize(account: ProviderAccount, signal?: AbortSignal): Promise<ProviderSyncResult> {
    if (account.kind !== "keepass" || account.config.sourceMode !== "webdav") {
      throw new KeePassRemoteSessionError("remote-provider-invalid", "所选密码源不是远端 KeePass 数据库。");
    }
    await this.recoverPending(account, signal);
    signal?.throwIfAborted();
    const state = await this.vault.readState();
    const snapshot = state.items;
    const allPending = state.mutationQueue
      .filter((mutation) => mutation.providerId === account.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const pending = allPending.slice(0, KEEPASS_ITEM_SYNC_BATCH_LIMIT);
    const now = new Date().toISOString();
    const result = await this.provider.sync(account, {
      signal,
      now,
      localItems: structuredClone(snapshot),
      pendingMutations: structuredClone(pending)
    });

    const journal = pending.length ? await createItemSyncReceipt(account, pending, snapshot, result, now) : undefined;
    if (journal) {
      const persisted = await this.remoteSessions.persistWorkingCopy(account, journal);
      if (persisted) await this.writeAccountConfig(account, persisted.accountConfig);
    }
    await this.vault.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, snapshot);
    if (journal) await this.remoteSessions.deleteDurableReceipt(account, KEEPASS_ITEM_SYNC_RECEIPT_ID);
    if (allPending.length > KEEPASS_ITEM_SYNC_BATCH_LIMIT) {
      result.warnings = [...result.warnings, `本轮按 Monica Android 上限处理了 ${KEEPASS_ITEM_SYNC_BATCH_LIMIT} 条 KeePass 修改，其余修改将在下次同步继续。`];
    }
    return result;
  }

  private async recoverPending(account: ProviderAccount, signal?: AbortSignal): Promise<void> {
    const receipt = await this.remoteSessions.readAnyDurableReceipt(account, KEEPASS_ITEM_SYNC_RECEIPT_ID);
    if (!receipt) return;
    if (receipt.kind !== "item-sync" || receipt.result.type !== "item-sync") {
      throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 项目同步回执类型无效。");
    }
    signal?.throwIfAborted();
    const state = await this.vault.readState();
    const snapshot = restoreSyncSnapshot(state.items, receipt.result.snapshotItems);
    const acknowledged: ProviderAcknowledgedMutation[] = receipt.result.mutations
      .filter((mutation) => mutation.committed)
      .map((mutation) => ({
        mutationId: mutation.mutationId,
        itemId: mutation.itemId,
        operation: mutation.operation,
        remoteId: mutation.remoteId!
      }));
    const recovered = await this.provider.sync(account, {
      signal,
      now: receipt.result.syncedAt,
      localItems: structuredClone(snapshot),
      pendingMutations: [],
      acknowledgedMutations: acknowledged
    });
    recovered.conflicts = structuredClone(receipt.result.conflicts);
    recovered.accountPatch = recovered.conflicts.length
      ? { lastError: `发现 ${recovered.conflicts.length} 个 KeePass 同步冲突。` }
      : { lastSyncAt: receipt.result.syncedAt, lastError: undefined };
    await this.vault.applyProviderSync(account.id, recovered.items, recovered.accountPatch, recovered.conflicts, recovered.sourceRecords, snapshot);
    await this.remoteSessions.deleteDurableReceipt(account, KEEPASS_ITEM_SYNC_RECEIPT_ID);
  }
}

async function createItemSyncReceipt(
  account: ProviderAccount,
  pending: PendingMutation[],
  snapshot: VaultItem[],
  result: ProviderSyncResult,
  syncedAt: string
): Promise<KeePassDurableMutationReceipt | undefined> {
  const conflictsByItem = new Map(result.conflicts.map((conflict) => [conflict.itemId, conflict]));
  if ([...conflictsByItem.keys()].some((itemId) => !pending.some((mutation) => mutation.itemId === itemId))) {
    throw new Error("KeePass 同步返回了当前批次之外的冲突。");
  }
  const snapshotById = new Map(snapshot.map((item) => [item.id, item]));
  const resultById = new Map(result.items.map((item) => [item.id, item]));
  const mutations = pending.map((mutation) => {
    const before = snapshotById.get(mutation.itemId);
    if (!before) throw new Error("KeePass 同步批次引用的项目不存在。");
    const committed = !conflictsByItem.has(mutation.itemId);
    const remoteId = mutation.operation === "delete"
      ? before.providerRefs.find((reference) => reference.providerId === account.id)?.remoteId
      : resultById.get(mutation.itemId)?.providerRefs.find((reference) => reference.providerId === account.id)?.remoteId;
    if (committed && !remoteId) throw new Error("KeePass 已提交项目同步缺少远端条目标识。");
    return {
      mutationId: mutation.id,
      itemId: mutation.itemId,
      operation: mutation.operation,
      createdAt: mutation.createdAt,
      attempts: mutation.attempts,
      lastError: mutation.lastError,
      committed,
      remoteId
    };
  });
  if (!mutations.some((mutation) => mutation.committed)) return undefined;
  const snapshotItems = pending.map((mutation) => structuredClone(snapshotById.get(mutation.itemId)!));
  const intentSha256 = await keePassMutationIntentSha256({
    mutations: pending.map((mutation) => ({
      id: mutation.id,
      itemId: mutation.itemId,
      operation: mutation.operation,
      createdAt: mutation.createdAt,
      attempts: mutation.attempts,
      lastError: mutation.lastError
    })),
    snapshotItems
  });
  return {
    providerId: account.id,
    operationId: KEEPASS_ITEM_SYNC_RECEIPT_ID,
    kind: "item-sync",
    intentSha256,
    completedAt: syncedAt,
    result: {
      type: "item-sync",
      mutations,
      snapshotItems,
      conflicts: structuredClone(result.conflicts),
      syncedAt
    }
  };
}

function restoreSyncSnapshot(current: VaultItem[], stored: VaultItem[]): VaultItem[] {
  const storedById = new Map(stored.map((item) => [item.id, structuredClone(item)]));
  const restored = current.map((item) => storedById.get(item.id) || item);
  const currentIds = new Set(current.map((item) => item.id));
  for (const item of stored) if (!currentIds.has(item.id)) restored.push(structuredClone(item));
  return restored;
}
