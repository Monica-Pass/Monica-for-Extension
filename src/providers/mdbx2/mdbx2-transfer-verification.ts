import type { ProviderAccount, VaultItem } from "../../core/model";
import type { Mdbx2ObjectRecord, Mdbx2VaultRuntimeStatus } from "./native-contract";

export interface Mdbx2TransferVaultBinding {
  providerId: string;
  vaultHandle: string;
  vaultId: string;
}

interface VerificationClient {
  vaultStatus(handle: string): Promise<Mdbx2VaultRuntimeStatus>;
  revealObject(handle: string, objectId: string): Promise<Mdbx2ObjectRecord>;
}

/** Capture authenticated identity, including for accounts saved by older clients. */
export async function readMdbx2TransferBinding(client: Pick<VerificationClient, "vaultStatus">,
  account: ProviderAccount): Promise<Mdbx2TransferVaultBinding> {
  const handle = account.config.vaultHandle;
  if (account.kind !== "mdbx2" || !account.enabled || typeof handle !== "string" || !handle) {
    throw new Error("移动所需的密码库不可用，请重新连接后重试。");
  }
  const status = await client.vaultStatus(handle);
  if (status.vaultHandle !== handle || !status.open || !status.available || !status.vaultId
    || account.config.nativeVaultId !== undefined && account.config.nativeVaultId !== status.vaultId) {
    throw new Error("无法确认移动所需的密码库身份，请更新本机助手并重新连接密码库。");
  }
  return { providerId: account.id, vaultHandle: handle, vaultId: status.vaultId };
}

/** Re-read provider configuration as well as native state immediately before finalization. */
export async function verifyMdbx2TransferBinding(client: Pick<VerificationClient, "vaultStatus">,
  account: ProviderAccount | undefined, expected: Mdbx2TransferVaultBinding): Promise<void> {
  if (!account || account.id !== expected.providerId) throw new Error("移动期间密码库连接已变化，来源项目已保留。");
  const actual = await readMdbx2TransferBinding(client, account);
  if (actual.vaultHandle !== expected.vaultHandle || actual.vaultId !== expected.vaultId) {
    throw new Error("移动期间密码库连接已变化，来源项目已保留。");
  }
}

/** A committed write receipt alone does not prove the destination still exists. */
export async function verifyMdbx2TransferTargets(client: Pick<VerificationClient, "revealObject">,
  binding: Mdbx2TransferVaultBinding, targets: readonly VaultItem[]): Promise<void> {
  for (const target of targets) {
    const refs = target.providerRefs.filter(ref => ref.providerId === binding.providerId);
    const ref = refs[0];
    if (refs.length !== 1 || !ref.remoteId || !ref.remoteFolderId || !ref.revision) {
      throw new Error("目标项目缺少已验证的提交信息，来源项目已保留。");
    }
    const actual = await client.revealObject(binding.vaultHandle, ref.remoteId);
    if (actual.deleted || actual.objectId !== ref.remoteId || actual.collectionId !== ref.remoteFolderId
      || actual.headCommitId !== ref.revision) {
      throw new Error("目标项目在移动完成前已变化，来源项目已保留。");
    }
  }
}
