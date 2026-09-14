import type { PasskeyItem, ProviderAccount, VaultState } from "../core/model";
import type { ProviderSyncResult } from "../core/provider";
import { assertPasskeyCounterNotRegressed, resolvePasskeyOwnership, samePasskeySigningIdentity } from "./ownership-policy";

interface AssertionVault {
  readState(): Promise<VaultState>;
  advanceBitwardenPasskeyCounter(expected: PasskeyItem): Promise<PasskeyItem>;
}

interface BitwardenAssertionSync {
  synchronize(account: ProviderAccount, signal?: AbortSignal, options?: { readOnly?: boolean; itemIds?: string[] }): Promise<ProviderSyncResult>;
}

/** Caller holds the provider lock for the entire refresh/commit operation. */
export async function prepareBitwardenAssertion(
  selected: PasskeyItem,
  vault: AssertionVault,
  sync: BitwardenAssertionSync,
  assertActive: () => Promise<void>,
  signal?: AbortSignal
): Promise<PasskeyItem> {
  let state = await vault.readState();
  let current = requireCurrentPasskey(selected, state);
  const ownership = resolvePasskeyOwnership(current, state.providers);
  if (ownership.kind !== "bitwarden") throw new Error("所选 Passkey 不是 Bitwarden 凭据。");
  assertPasskeyCounterNotRegressed(current);
  assertPasskeyCounterNotRegressed(current, selected);
  // This is the official zero-counter path: no Cipher mutation and no network dependency.
  if (current.signCount === 0) return current;
  if (!ownership.account.enabled) throw new Error("此 Bitwarden 密码源已停用，无法更新签名计数。");

  const providerId = ownership.account.id;
  const requireSameAccount = (candidate: ProviderAccount | undefined) => {
    if (!candidate || candidate.kind !== "bitwarden" || !candidate.enabled
      || candidate.config.vaultUrl !== ownership.account.config.vaultUrl || candidate.config.email !== ownership.account.config.email) {
      throw new Error("Bitwarden 密码源已变化，请重新发起登录。");
    }
    return candidate;
  };
  const refresh = async (options: { readOnly?: boolean; itemIds?: string[] }) => {
    await assertActive();
    signal?.throwIfAborted();
    const latest = requireSameAccount((await vault.readState()).providers.find(account => account.id === providerId));
    await sync.synchronize(latest, signal, options);
    await assertActive();
    signal?.throwIfAborted();
    state = await vault.readState();
    requireSameAccount(state.providers.find(account => account.id === providerId));
    current = requireCurrentPasskey(selected, state);
    assertPasskeyCounterNotRegressed(current);
    assertPasskeyCounterNotRegressed(current, selected);
    assertNoCipherConflict(current, providerId, state);
  };

  // Recover a previous interrupted write, or flush an already-authorized edit of this
  // Cipher. Unrelated queued items remain untouched during authentication.
  let pendingIds = pendingCipherItemIds(current, providerId, state);
  await refresh(pendingIds.length ? { itemIds: pendingIds } : { readOnly: true });
  pendingIds = pendingCipherItemIds(current, providerId, state);
  if (pendingIds.length) throw new Error("此 Passkey 仍有未完成的同步，请先同步 Bitwarden 后重试。");
  const staged = await vault.advanceBitwardenPasskeyCounter(current);
  await refresh({ itemIds: [staged.id] });
  if (pendingCipherItemIds(current, providerId, state).length || current.signCount !== staged.signCount) {
    throw new Error("Bitwarden 尚未确认签名计数，已停止此次登录，请同步后重试。");
  }
  // The caller may now sign. An error, cancellation, conflict, or uncertain server
  // write above never produces an assertion; skipping a committed count is safe.
  return current;
}

function requireCurrentPasskey(selected: PasskeyItem, state: VaultState): PasskeyItem {
  const current = state.items.find((item): item is PasskeyItem => item.id === selected.id && item.kind === "passkey");
  if (!current || current.deletedAt || current.archivedAt || !samePasskeySigningIdentity(selected, current)) {
    throw new Error("登录期间 Passkey 已变化，请重新发起登录。");
  }
  return current;
}

function cipherItemIds(item: PasskeyItem, providerId: string, state: VaultState): Set<string> {
  const remoteId = item.providerRefs.find(reference => reference.providerId === providerId)?.remoteId;
  if (!remoteId) throw new Error("Bitwarden Passkey 尚未完成同步。");
  const cipherId = remoteId.split("#")[0];
  return new Set(state.items.filter(candidate => candidate.providerRefs.some(reference => reference.providerId === providerId && reference.remoteId?.split("#")[0] === cipherId)).map(candidate => candidate.id));
}

function pendingCipherItemIds(item: PasskeyItem, providerId: string, state: VaultState): string[] {
  const ids = cipherItemIds(item, providerId, state);
  return state.mutationQueue.filter(mutation => mutation.providerId === providerId && ids.has(mutation.itemId)).map(mutation => mutation.itemId);
}

function assertNoCipherConflict(item: PasskeyItem, providerId: string, state: VaultState): void {
  const ids = cipherItemIds(item, providerId, state);
  if (state.providerConflicts.some(conflict => conflict.providerId === providerId && (ids.has(conflict.itemId) || conflict.itemId === providerId || !conflict.local && !conflict.remote))) {
    throw new Error("此 Passkey 存在 Bitwarden 同步冲突，请解决后重试。");
  }
}
