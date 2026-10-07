import type { ProviderAccount, VaultItem } from "../../core/model";
import type { Mdbx2NativeClient } from "./native-client";
import { MDBX2_MAX_OBJECT_BATCH_MUTATIONS, type Mdbx2ObjectBatchResult, type Mdbx2ObjectMutationInput } from "./native-contract";
import { assertMdbx2TransferOperationId, mdbx2TransferOperationScope } from "./mdbx2-transfer-identity";

type DeleteClient = Pick<Mdbx2NativeClient, "mutateObjects" | "resolveObjectOperation">;

/** One source vault transaction, with a stable receipt for response-loss recovery.
 * Call only after target content/attachments and every local source snapshot are validated.
 */
export async function deleteMdbx2TransferSources(client: DeleteClient, source: ProviderAccount,
  items: readonly VaultItem[], operationId: string, targetProviderId: string): Promise<Mdbx2ObjectBatchResult> {
  assertMdbx2TransferOperationId(operationId);
  const handle = source.config.vaultHandle;
  if (source.kind !== "mdbx2" || !source.enabled || typeof handle !== "string" || !handle || source.id === targetProviderId) {
    throw new Error("来源 MDBX2 删除目标无效，未删除项目。");
  }
  if (!items.length || items.length > MDBX2_MAX_OBJECT_BATCH_MUTATIONS) throw new Error("MDBX2 Object 批量数量无效。");
  const mutations: Mdbx2ObjectMutationInput[] = items.map((item): Mdbx2ObjectMutationInput => {
    const references = item.providerRefs.filter(ref => ref.providerId !== "local");
    const ref = references[0];
    if (references.length !== 1 || ref.providerId !== source.id || !ref.remoteId || !ref.revision || item.deletedAt) {
      throw new Error("来源 MDBX2 缺少原生身份或版本，已保留来源。");
    }
    return { kind: "delete", logicalObjectId: `native:${ref.remoteId}`, expectedHeadCommitId: ref.revision };
  }).sort((left, right) => left.logicalObjectId.localeCompare(right.logicalObjectId));
  if (new Set(mutations.map(item => item.logicalObjectId)).size !== mutations.length) throw new Error("MDBX2 批量传输结果包含重复项目 ID。");
  const scope = await mdbx2TransferOperationScope({ version: 1, purpose: "source-group-delete", operationId,
    sourceProviderId: source.id, targetProviderId, mutations });
  let result: Mdbx2ObjectBatchResult;
  try { result = await client.mutateObjects(handle, scope, mutations); }
  catch (error) {
    const receipt = await client.resolveObjectOperation(handle, scope).catch(() => undefined);
    if (!receipt?.known || !receipt.committed) throw error;
    result = await client.mutateObjects(handle, scope, mutations);
    if (result.operationId !== receipt.operationId || result.commitId !== receipt.commitId) throw new Error("来源 MDBX2 删除响应与项目不一致。");
  }
  if (!result.commitId || result.items.length !== mutations.length || result.items.some((item, index) =>
    item.kind !== "delete" || item.logicalObjectId !== mutations[index].logicalObjectId || `native:${item.objectId}` !== item.logicalObjectId)) {
    throw new Error("来源 MDBX2 删除响应与项目不一致。");
  }
  return result;
}
