import type { PasskeyItem, ProviderAccount, VaultState } from "../core/model";
import { sameProviderBinding, type ProviderSyncResult } from "../core/provider";
import { assertPasskeyCounterNotRegressed, resolvePasskeyOwnership, samePasskeySigningIdentity } from "./ownership-policy";

interface AssertionVault {
  readState(): Promise<VaultState>;
  advanceFilePasskeyCounter(expected: PasskeyItem, account: ProviderAccount): Promise<PasskeyItem>;
}

/** Caller holds the provider operation queue through refresh, reservation and acknowledgement. */
export async function prepareFileAssertion(
  selected: PasskeyItem,
  vault: AssertionVault,
  synchronize: (account: ProviderAccount, signal?: AbortSignal) => Promise<Pick<ProviderSyncResult, "sourceWriteRebased"> | void>,
  assertActive: () => Promise<void>,
  signal?: AbortSignal
): Promise<PasskeyItem> {
  let state = await vault.readState();
  let current = requireCurrent(selected, state);
  const ownership = resolvePasskeyOwnership(current, state.providers);
  if (ownership.kind !== "database" && ownership.kind !== "snapshot") throw new Error("所选 Passkey 不是文件来源凭据。");
  const originalAccount = ownership.account;
  assertPasskeyCounterNotRegressed(current);
  assertPasskeyCounterNotRegressed(current, selected);
  if (current.signCount === 0) return current;

  const account = () => {
    const latest = state.providers.find(candidate => candidate.id === originalAccount.id);
    if (!latest || !latest.enabled || !sameProviderBinding(originalAccount, latest)) {
      throw new Error("Passkey 密码源已变化或停用，请重新发起登录。");
    }
    return latest;
  };
  const refresh = async () => {
    await assertActive(); signal?.throwIfAborted();
    state = await vault.readState();
    const result = await synchronize(account(), signal);
    await assertActive(); signal?.throwIfAborted();
    state = await vault.readState(); account();
    current = requireCurrent(selected, state);
    assertPasskeyCounterNotRegressed(current);
    assertPasskeyCounterNotRegressed(current, selected);
    if (state.providerConflicts.some(conflict => conflict.providerId === originalAccount.id &&
      (conflict.itemId === current.id || conflict.itemId === originalAccount.id || !conflict.local && !conflict.remote))) {
      throw new Error("此 Passkey 存在同步冲突，请解决后重试。");
    }
    if (state.mutationQueue.some(mutation => mutation.providerId === originalAccount.id && mutation.itemId === current.id)) {
      throw new Error("此 Passkey 仍有未完成的同步，请同步密码源后重试。");
    }
    return result;
  };

  // Finish any interrupted, previously authorized write and obtain current source history.
  await refresh();
  for (let attempt = 0; attempt < 3; attempt++) {
    const reserved = await vault.advanceFilePasskeyCounter(current, account());
    const result = await refresh();
    // An equal value merged from another client's successful write does not
    // reserve that number for this assertion. Allocate a new value instead.
    if (result?.sourceWriteRebased) continue;
    if (current.signCount !== reserved.signCount) {
      throw new Error("密码源尚未确认此次签名计数，请同步后重试。");
    }
    return current;
  }
  throw new Error("其他设备持续修改此 Passkey，已停止此次登录，请稍后重试。");
}

function requireCurrent(selected: PasskeyItem, state: VaultState): PasskeyItem {
  const current = state.items.find((candidate): candidate is PasskeyItem => candidate.kind === "passkey" && candidate.id === selected.id);
  if (!current || current.deletedAt || current.archivedAt || !samePasskeySigningIdentity(selected, current)) {
    throw new Error("登录期间 Passkey 已变化，请重新发起登录。");
  }
  return current;
}
