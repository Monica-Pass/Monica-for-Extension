import { isRemoteKeePassSource } from "./keepass-source";
import type { PendingMutation, ProviderAccount, ProviderConflictInput, ProviderSourceRecord, VaultItem, VaultState } from "../../core/model";
import type { ProviderAcknowledgedMutation, ProviderRequestedMutation, ProviderSyncGuard, ProviderSyncResult } from "../../core/provider";
import { KeePassProvider } from "./keepass-provider";
import { keePassMutationIntentSha256, KeePassRemoteSessionError, KeePassRemoteSessionService } from "./keepass-remote-session";
import type { KeePassDurableMutationReceipt } from "./keepass-working-copy-store";
import { passwordGroupKey } from "../../core/password-groups";

export const KEEPASS_ITEM_SYNC_RECEIPT_ID = "item-sync-pending";
export const KEEPASS_ITEM_SYNC_BATCH_LIMIT = 100;

export interface KeePassDurableSyncVault {
  readState(activity?: boolean): Promise<Pick<VaultState, "items" | "mutationQueue">>;
  applyProviderSync(
    providerId: string,
    items: VaultItem[],
    accountPatch?: Partial<ProviderAccount>,
    conflicts?: ProviderConflictInput[],
    sourceRecords?: ProviderSourceRecord[],
    syncSnapshot?: VaultItem[],
    acknowledgedMutations?: ProviderAcknowledgedMutation[],
    requestedMutations?: ProviderRequestedMutation[],
    adoptRemoteRemovals?: boolean,
    deferredMutationIds?: string[],
    guard?: ProviderSyncGuard
  ): Promise<unknown>;
}

export type KeePassAccountConfigWriter = (account: ProviderAccount, config: Record<string, unknown>) => Promise<ProviderAccount>;

export class KeePassDurableSyncCoordinator {
  private readonly projectedWorkingCopies = new Map<string, string>();
  clearProjectionCache(): void { this.projectedWorkingCopies.clear(); }
  constructor(
    private readonly provider: KeePassProvider,
    private readonly remoteSessions: KeePassRemoteSessionService,
    private readonly vault: KeePassDurableSyncVault,
    private readonly writeAccountConfig: KeePassAccountConfigWriter
  ) {}

  async synchronize(account: ProviderAccount, signal?: AbortSignal, options: { checkOnly?: boolean } = {}): Promise<ProviderSyncResult> {
    if (account.kind !== "keepass" || !isRemoteKeePassSource(account.config.sourceMode)) {
      throw new KeePassRemoteSessionError("remote-provider-invalid", "所选密码源不是远端 KeePass 数据库。");
    }
    await this.recoverPending(account, signal);
    signal?.throwIfAborted();
    const state = await this.vault.readState(false);
    const snapshot = state.items;
    const allPending = state.mutationQueue
      .filter((mutation) => mutation.providerId === account.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const pending = selectItemSyncBatch(allPending, snapshot);
    const processedIds = new Set(pending.map(mutation => mutation.id));
    const deferredMutationIds = allPending.filter(mutation => !processedIds.has(mutation.id)).map(mutation => mutation.id);
    const now = new Date().toISOString();
    // With no queued edits, compare the remote validator before projecting all
    // entries again. A cold worker still refreshes the local projection once.
    const checked = options.checkOnly && !allPending.length ? await this.remoteSessions.publishWorkingCopy(account, signal) : undefined;
    signal?.throwIfAborted();
    if (checked) {
      await this.writeAccountConfig(account, checked.accountConfig);
      if (checked.status === "unchanged" && this.projectedWorkingCopies.get(account.id) === checked.workingSha256) {
        return { items: snapshot, conflicts: [], warnings: [], unchanged: true };
      }
    }
    let result = await this.provider.sync(account, {
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
    const published = checked || await this.remoteSessions.publishWorkingCopy(account, signal);
    if (published) {
      await this.writeAccountConfig(account, published.accountConfig);
      if (!checked && (published.status === "rebased" || published.status === "remote-refreshed")) {
        result = await this.provider.refreshFromSession(account, result.items, now);
      }
    }
    signal?.throwIfAborted();
    const acknowledgements = journal ? receiptAcknowledgements(journal, (await this.vault.readState(false)).mutationQueue) : [];
    await this.vault.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, snapshot,
      acknowledgements, [], false, deferredMutationIds, { expectedAccount: account });
    if (published && !result.conflicts.length) this.projectedWorkingCopies.set(account.id, published.workingSha256);
    if (journal) await this.remoteSessions.deleteDurableReceipt(account, KEEPASS_ITEM_SYNC_RECEIPT_ID);
    if (deferredMutationIds.length) {
      result.warnings = [...result.warnings, `本轮处理了 ${pending.length} 条 KeePass 修改，其余修改将在下次同步继续；同一密码项目的修改会一起处理。`];
    }
    return published?.status === "rebased" ? { ...result, sourceWriteRebased: true } : result;
  }

  private async recoverPending(account: ProviderAccount, signal?: AbortSignal): Promise<void> {
    const receipt = await this.remoteSessions.readAnyDurableReceipt(account, KEEPASS_ITEM_SYNC_RECEIPT_ID);
    if (!receipt) return;
    if (receipt.kind !== "item-sync" || receipt.result.type !== "item-sync") {
      throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 项目同步回执类型无效。");
    }
    signal?.throwIfAborted();
    const state = await this.vault.readState(false);
    const published = await this.remoteSessions.publishWorkingCopy(account, signal);
    if (!published) throw new KeePassRemoteSessionError("remote-working-copy-missing", "KeePass 远端工作副本无法发布。");
    await this.writeAccountConfig(account, published.accountConfig);
    // Other cached records retain their Monica IDs. Only committed receipt rows
    // receive a new remote identity; a failed row cannot inherit another commit.
    const committed = receipt.result.mutations.filter(mutation => mutation.committed);
    const identities = acknowledgedIdentityItems(state.items, committed, account.id);
    const refreshed = await this.provider.refreshFromSession(account, identities, receipt.result.syncedAt);
    const originalById = new Map(receipt.result.snapshotItems.map(item => [item.id, item]));
    const snapshot = state.items.map(item => originalById.get(item.id) || item);
    const committedIds = new Set(committed.map(mutation => mutation.itemId));
    const deferred = state.mutationQueue.filter(mutation => mutation.providerId === account.id && !committedIds.has(mutation.itemId));
    const deferredIds = new Set(deferred.map(mutation => mutation.itemId));
    const currentById = new Map(state.items.map(item => [item.id, item]));
    const incomingIds = new Set(refreshed.items.map(item => item.id));
    // Recovery acknowledges one old batch; it must not roll back or clear newer
    // queued work outside it, including locally created rows absent from KDBX.
    const items = refreshed.items.map(item => deferredIds.has(item.id) ? currentById.get(item.id)! : item);
    items.push(...state.items.filter(item => deferredIds.has(item.id) && !incomingIds.has(item.id)));
    const acknowledgements = receiptAcknowledgements(receipt, state.mutationQueue);
    signal?.throwIfAborted();
    await this.vault.applyProviderSync(account.id, items, refreshed.accountPatch, receipt.result.conflicts, refreshed.sourceRecords, snapshot,
      acknowledgements, [], false, deferred.map(mutation => mutation.id), { expectedAccount: account });
    await this.remoteSessions.deleteDurableReceipt(account, KEEPASS_ITEM_SYNC_RECEIPT_ID);
  }
}

/** Keep an explicit project's pending edits in one publication. The queue is
 * already ordered; do not let later independent work starve a deferred group. */
function selectItemSyncBatch(pending: PendingMutation[], items: VaultItem[]): PendingMutation[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const units = new Map<string, PendingMutation[]>();
  for (const mutation of pending) {
    const item = byId.get(mutation.itemId);
    const key = item?.kind === 'login' ? passwordGroupKey(item) : `item:${mutation.itemId}`;
    const unit = units.get(key) || [];
    unit.push(mutation); units.set(key, unit);
  }
  const selected: PendingMutation[] = [];
  for (const unit of units.values()) {
    if (unit.length > KEEPASS_ITEM_SYNC_BATCH_LIMIT) {
      throw new KeePassRemoteSessionError('remote-project-batch-limit', '单个 KeePass 密码项目待同步的修改超过 100 条，无法安全拆分；本地修改已保留。');
    }
    if (selected.length + unit.length > KEEPASS_ITEM_SYNC_BATCH_LIMIT) break;
    selected.push(...unit);
  }
  return selected;
}

/** A receipt confirms the earlier intent; current queue operations can already
 * represent a follow-up edit/delete and must remain queued against that ID. */
function receiptAcknowledgements(receipt: KeePassDurableMutationReceipt, pending: PendingMutation[]): ProviderAcknowledgedMutation[] {
  if (receipt.result.type !== 'item-sync') throw new Error('KeePass 项目同步回执类型无效。');
  return receipt.result.mutations.flatMap(committed => {
    if (!committed.committed || !committed.remoteId) return [];
    const current = pending.find(mutation => mutation.providerId === receipt.providerId && mutation.id === committed.mutationId && mutation.itemId === committed.itemId);
    return current ? [{ mutationId: current.id, itemId: current.itemId, operation: current.operation, remoteId: committed.remoteId,
      ...(current.operation !== committed.operation || current.keepassRestore !== committed.keepassRestore ? { followUp: true } : {}) }] : [];
  });
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
      ...(mutation.keepassRestore ? { keepassRestore: true as const } : {}),
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
      lastError: mutation.lastError,
      ...(mutation.keepassRestore ? { keepassRestore: true as const } : {})
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

function acknowledgedIdentityItems(
  snapshotItems: VaultItem[],
  mutations: Array<{ itemId: string; operation: "create" | "update" | "delete"; remoteId?: string }>,
  providerId: string
): VaultItem[] {
  const mutationByItem = new Map(mutations.map((mutation) => [mutation.itemId, mutation]));
  return snapshotItems.map((item) => {
    const mutation = mutationByItem.get(item.id);
    if (!mutation?.remoteId) return item;
    return {
      ...item,
      providerRefs: [
        ...item.providerRefs.filter((reference) => reference.providerId !== providerId),
        { providerId, remoteId: mutation.remoteId }
      ]
    };
  });
}
