import { createSHA256 } from "hash-wasm";
import type { PendingMutation, ProviderAccount, ProviderMutationReceipt, VaultItem, VaultState } from "../../core/model";
import type { ProviderAcknowledgedMutation, ProviderSyncResult } from "../../core/provider";
import type { BitwardenProvider } from "./bitwarden-provider";

export const BITWARDEN_ITEM_SYNC_BATCH_LIMIT = 100;

export interface BitwardenDurableSyncVault {
  readState(): Promise<Pick<VaultState, "items" | "mutationQueue" | "providerMutationReceipts">>;
  prepareProviderMutationReceipts(receipts: ProviderMutationReceipt[]): Promise<void>;
  markProviderMutationReceiptsAttempted(providerId: string, mutationIds: string[]): Promise<void>;
  commitProviderMutationReceipts(providerId: string, acknowledgements: ProviderAcknowledgedMutation[]): Promise<void>;
  clearProviderMutationReceipts(providerId: string, mutationIds: string[]): Promise<void>;
  applyProviderSync(
    providerId: string,
    items: VaultItem[],
    accountPatch?: Partial<ProviderAccount>,
    conflicts?: ProviderSyncResult["conflicts"],
    sourceRecords?: ProviderSyncResult["sourceRecords"],
    syncSnapshot?: VaultItem[],
    acknowledgedMutations?: ProviderAcknowledgedMutation[],
    requestedMutations?: ProviderSyncResult["requestedMutations"]
  ): Promise<unknown>;
}

/**
 * Fingerprints only the item content Bitwarden can compare after decrypting a
 * Cipher. Volatile local identity, provider routing and timestamps are omitted
 * so a response received after a Service Worker restart can be recognized
 * without persisting plaintext in the durable receipt.
 */
export async function bitwardenMutationFingerprint(item: VaultItem): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  hasher.update(stableJson(bitwardenComparablePayload(item)));
  return hasher.digest("hex");
}

export function bitwardenComparablePayload(item: VaultItem): Record<string, unknown> {
  if (item.kind === "passkey") {
    return stableValue({
      kind: item.kind,
      credentialId: item.credentialId,
      rpId: item.rpId,
      rpName: item.rpName || item.title,
      userHandle: item.userHandle,
      userName: item.userName,
      userDisplayName: item.userDisplayName,
      algorithm: item.algorithm,
      keyAlgorithm: item.keyAlgorithm || (item.algorithm === -7 ? "ECDSA" : undefined),
      privateKeyPkcs8: item.privateKeyPkcs8,
      signCount: Math.max(0, Math.floor(item.signCount)),
      discoverable: item.discoverable
    }) as Record<string, unknown>;
  }
  const payload = item as unknown as Record<string, unknown>;
  return stableValue(payload, new Set([
    "id",
    "providerRefs",
    "createdAt",
    "updatedAt",
    "deletedAt",
    "bitwardenCustomFieldsVersion"
  ])) as Record<string, unknown>;
}

export class BitwardenDurableSyncCoordinator {
  constructor(
    private readonly provider: BitwardenProvider,
    private readonly vault: BitwardenDurableSyncVault
  ) {}

  async synchronize(account: ProviderAccount, signal?: AbortSignal): Promise<ProviderSyncResult> {
    if (account.kind !== "bitwarden") throw new Error("所选密码源不是 Bitwarden。");
    signal?.throwIfAborted();

    let state = await this.vault.readState();
    const allPending = state.mutationQueue
      .filter((mutation) => mutation.providerId === account.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const allPendingById = new Map(allPending.map((mutation) => [mutation.id, mutation]));
    const pending = allPending.slice(0, BITWARDEN_ITEM_SYNC_BATCH_LIMIT);
    const snapshot = structuredClone(state.items);
    const providerReceipts = state.providerMutationReceipts
      .filter((receipt) => receipt.providerId === account.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.mutationId.localeCompare(right.mutationId));

    const orphanAttempted = providerReceipts.find((receipt) => receipt.stage === "attempted" && !allPendingById.has(receipt.mutationId));
    if (orphanAttempted) throw new Error("Bitwarden 持久同步存在没有排队操作的未知远端写入，已停止同步。");
    // A prepared receipt never reached the network, while a committed receipt
    // with no surviving queue entry means only cleanup was interrupted.
    const staleSafeReceipts = providerReceipts.filter((receipt) => receipt.stage !== "attempted" && !allPendingById.has(receipt.mutationId));
    if (staleSafeReceipts.length) {
      await this.vault.clearProviderMutationReceipts(account.id, staleSafeReceipts.map((receipt) => receipt.mutationId));
      state = await this.vault.readState();
    }

    const currentReceipts = state.providerMutationReceipts
      .filter((receipt) => receipt.providerId === account.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.mutationId.localeCompare(right.mutationId));
    const receiptByMutationId = new Map(currentReceipts.map((receipt) => [receipt.mutationId, receipt]));
    const snapshotById = new Map(snapshot.map((item) => [item.id, item]));
    const newReceipts: ProviderMutationReceipt[] = [];
    const refreshedPreparedIds: string[] = [];
    const now = new Date().toISOString();
    for (const mutation of pending) {
      const item = snapshotById.get(mutation.itemId);
      if (!item) throw new Error("Bitwarden 持久同步批次引用的项目不存在。");
      const existing = receiptByMutationId.get(mutation.id);
      const intentFingerprint = await bitwardenMutationFingerprint(item);
      if (existing) {
        if (existing.itemId !== mutation.itemId || existing.operation !== mutation.operation) {
          throw new Error("Bitwarden 持久同步回执与排队操作不一致。");
        }
        if (existing.stage !== "prepared" || existing.intentFingerprint === intentFingerprint) continue;
        refreshedPreparedIds.push(existing.mutationId);
      }
      newReceipts.push({
        version: 1,
        providerId: account.id,
        mutationId: mutation.id,
        itemId: mutation.itemId,
        operation: mutation.operation,
        stage: "prepared",
        intentFingerprint,
        remoteId: item.providerRefs.find((reference) => reference.providerId === account.id)?.remoteId,
        baseRevision: item.providerRefs.find((reference) => reference.providerId === account.id)?.revision,
        attemptCount: 0,
        createdAt: mutation.createdAt,
        updatedAt: now
      });
    }
    if (refreshedPreparedIds.length) await this.vault.clearProviderMutationReceipts(account.id, refreshedPreparedIds);
    if (newReceipts.length) {
      await this.vault.prepareProviderMutationReceipts(newReceipts);
      state = await this.vault.readState();
    }

    const currentByMutationId = new Map(state.providerMutationReceipts
      .filter((receipt) => receipt.providerId === account.id)
      .map((receipt) => [receipt.mutationId, receipt]));
    const receipts = pending.map((mutation) => currentByMutationId.get(mutation.id)).filter((receipt): receipt is ProviderMutationReceipt => Boolean(receipt));
    if (receipts.length !== pending.length) throw new Error("Bitwarden 持久同步批次缺少加密回执。");
    const committed = receipts
      .filter((receipt): receipt is ProviderMutationReceipt & { stage: "committed"; remoteId: string } => receipt.stage === "committed" && Boolean(receipt.remoteId))
      .map((receipt) => ({
        mutationId: receipt.mutationId,
        itemId: receipt.itemId,
        operation: receipt.operation,
        remoteId: receipt.remoteId
      } satisfies ProviderAcknowledgedMutation));
    const activePending = pending.filter((mutation) => !committed.some((acknowledgement) => acknowledgement.mutationId === mutation.id));

    const result = await this.provider.sync(account, {
      signal,
      now: new Date().toISOString(),
      localItems: structuredClone(snapshot),
      pendingMutations: structuredClone(activePending),
      acknowledgedMutations: committed,
      mutationReceipts: structuredClone(receipts),
      markMutationsAttempted: (mutationIds) => this.vault.markProviderMutationReceiptsAttempted(account.id, mutationIds)
    });

    const acknowledgements = uniqueAcknowledgements([...committed, ...(result.acknowledgedMutations || [])]);
    if (acknowledgements.length) await this.vault.commitProviderMutationReceipts(account.id, acknowledgements);
    await this.vault.applyProviderSync(
      account.id,
      result.items,
      result.accountPatch,
      result.conflicts,
      result.sourceRecords,
      snapshot,
      acknowledgements,
      result.requestedMutations
    );
    if (acknowledgements.length) await this.vault.clearProviderMutationReceipts(account.id, acknowledgements.map((acknowledgement) => acknowledgement.mutationId));

    if (allPending.length > BITWARDEN_ITEM_SYNC_BATCH_LIMIT) {
      result.warnings = [...result.warnings, `本轮按持久同步上限处理了 ${BITWARDEN_ITEM_SYNC_BATCH_LIMIT} 条 Bitwarden 修改，其余修改将在下次同步继续。`];
    }
    return result;
  }
}

function uniqueAcknowledgements(input: ProviderAcknowledgedMutation[]): ProviderAcknowledgedMutation[] {
  const result: ProviderAcknowledgedMutation[] = [];
  const seen = new Set<string>();
  for (const acknowledgement of input) {
    if (seen.has(acknowledgement.mutationId)) continue;
    seen.add(acknowledgement.mutationId);
    result.push(acknowledgement);
  }
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown, omit = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record)
    .filter((key) => !omit.has(key) && record[key] !== undefined)
    .sort()
    .map((key) => [key, stableValue(record[key])]));
}
