import type { PasskeyItem, ProviderAccount, ProviderReference } from "../core/model";
import { normalizeCredentialId, passkeyRpIdsEqual } from "./source-policy";

export type PasskeyOwnership =
  | { kind: "local" }
  | { kind: "snapshot" | "database" | "bitwarden"; account: ProviderAccount; reference: ProviderReference };

/** sourceMode describes key material, not a live synchronization relationship. */
export function resolvePasskeyOwnership(item: PasskeyItem, providers: ProviderAccount[]): PasskeyOwnership {
  const bindings = item.providerRefs.flatMap(reference => {
    const account = providers.find(candidate => candidate.id === reference.providerId);
    if (!account) throw new Error("Passkey 的密码源绑定已失效，请重新导入或同步。");
    return account.kind === "local" ? [] : [{ account, reference }];
  });
  if (!bindings.length) return { kind: "local" };
  if (bindings.length !== 1) throw new Error("Passkey 同时绑定了多个密码源，请分别保存后选择对应副本。");
  const { account, reference } = bindings[0];
  if (account.kind === "bitwarden") return { kind: "bitwarden", account, reference };
  if (account.kind === "monica-webdav") return { kind: "snapshot", account, reference };
  return { kind: "database", account, reference };
}

export function assertPasskeyCounter(counter: number): void {
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) {
    throw new Error("Passkey 签名计数无效，请重新同步密码源。");
  }
}

/** Zero-count credentials stay zero; observed positive history must advance. */
export function nextPasskeyCounter(counter: number): number {
  assertPasskeyCounter(counter);
  if (counter === 0xffffffff) throw new Error("Passkey 签名计数已达上限，请在网站重新注册此凭据。");
  return counter === 0 ? 0 : counter + 1;
}

export const nextBitwardenPasskeyCounter = nextPasskeyCounter;

export function passkeyCounterHighWaterMark(item: PasskeyItem): number {
  assertPasskeyCounter(item.signCount);
  const highest = item.signCountHighWaterMark ?? item.signCount;
  assertPasskeyCounter(highest);
  // A queued increment has not yet been acknowledged by its provider. Its
  // explicit watermark still describes the last confirmed remote count.
  return highest;
}

export function assertPasskeyCounterNotRegressed(item: PasskeyItem, known: PasskeyItem = item): void {
  assertPasskeyCounter(item.signCount);
  if (item.signCount < passkeyCounterHighWaterMark(known)) {
    throw new Error("Passkey 签名计数发生回退，已停止此次登录；请检查其他客户端或恢复可信的同步数据。");
  }
}

/** A source refresh or conflict resolution cannot erase this installation's history. */
export function preservePasskeyCounterHistory(local: PasskeyItem, incoming: PasskeyItem): PasskeyItem {
  if (!samePasskeyCredential(local, incoming)) return incoming;
  const highest = Math.max(passkeyCounterHighWaterMark(local), passkeyCounterHighWaterMark(incoming));
  return highest > 0 ? { ...incoming, signCountHighWaterMark: highest } : incoming;
}

export function samePasskeyCredential(left: PasskeyItem, right: PasskeyItem): boolean {
  return normalizeCredentialId(left.credentialId) === normalizeCredentialId(right.credentialId)
    && passkeyRpIdsEqual(left.rpId, right.rpId)
    && left.privateKeyPkcs8 === right.privateKeyPkcs8
    && left.algorithm === right.algorithm
    && left.userHandle === right.userHandle;
}

export function samePasskeySigningIdentity(left: PasskeyItem, right: PasskeyItem): boolean {
  return left.id === right.id
    && samePasskeyCredential(left, right)
    && left.userVerificationRequired === right.userVerificationRequired
    && (left.backupEligible !== false) === (right.backupEligible !== false)
    && (left.backupState !== false) === (right.backupState !== false)
    && JSON.stringify(left.providerRefs.map(reference => [reference.providerId, reference.remoteId || ""]).sort())
      === JSON.stringify(right.providerRefs.map(reference => [reference.providerId, reference.remoteId || ""]).sort());
}

/** Statistics belong to this installation and do not constitute a provider edit. */
export function preserveLocalPasskeyUsage(local: PasskeyItem, incoming: PasskeyItem): PasskeyItem {
  if (normalizeCredentialId(local.credentialId) !== normalizeCredentialId(incoming.credentialId)) return incoming;
  return { ...preservePasskeyCounterHistory(local, incoming), useCount: local.useCount ?? incoming.useCount, lastUsedAt: local.lastUsedAt ?? incoming.lastUsedAt };
}

/** Older file-provider baselines included usage. Compare them without forcing a rewrite. */
export function passkeyContentFingerprint(value: string): string {
  try {
    const payload = JSON.parse(value) as Record<string, unknown>;
    if (payload?.kind !== "passkey") return value;
    delete payload.useCount;
    delete payload.lastUsedAt;
    delete payload.signCountHighWaterMark;
    return JSON.stringify(payload);
  } catch { return value; }
}
