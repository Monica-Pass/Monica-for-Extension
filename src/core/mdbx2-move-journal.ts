import type { VaultItem } from "./model";

export interface Mdbx2MoveAttachmentProof {
  itemId: string;
  attachmentId: string;
  fileName: string;
  mediaType?: string;
  sizeBytes: number;
  sha256: string;
}

export interface Mdbx2MoveFinalizationRecord {
  version: 1;
  id: string;
  operationId: string;
  requestHash: string;
  /** Original selection, including independent components, for restart UI recovery. */
  request?: { itemIds: string[]; targetCollectionId?: string; preserveCategories: boolean; action: "copy" | "move" };
  sourceProviderId: string;
  targetProviderId: string;
  sourceVaultId: string;
  targetVaultId: string;
  createdAt: string;
  status: "writing" | "prepared" | "completed";
  /** Saved before native mutation. Keep original JSON text to preserve large numbers. */
  writeIntent?: {
    operationScope: string;
    attachmentCount?: number;
    entries: {
      item: VaultItem;
      originalPayloadJson?: string;
      originalItem?: VaultItem;
      payloadPatchJson?: string;
    }[];
  };
  /** Undefined is a legacy journal, not proof that the move had no attachments. */
  attachments?: Mdbx2MoveAttachmentProof[];
  entries: { expected: VaultItem; result: VaultItem; action: "move" }[];
}

/** A damaged/future journal must never be silently dropped during vault migration. */
export function readMdbx2MoveJournal(value: unknown): Mdbx2MoveFinalizationRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("移动恢复记录无效，已保留原始数据。");
  const ids = new Set<string>();
  for (const record of value) {
    if (!record || record.version !== 1 || !["writing", "prepared", "completed"].includes(record.status)
      || ![record.id,record.operationId,record.sourceProviderId,record.targetProviderId,record.sourceVaultId,record.targetVaultId].every(id=>typeof id==='string' && id.length>0 && id.length<=512)
      || !/^[a-f0-9]{64}$/.test(record.requestHash) || !Number.isFinite(Date.parse(record.createdAt))
      || !Array.isArray(record.entries) || !record.entries.length || record.entries.length>50 || ids.has(record.id)) {
      throw new Error("移动恢复记录无效，已保留原始数据。");
    }
    ids.add(record.id);
    if (record.request !== undefined) {
      const request = record.request;
      if (!request || !Array.isArray(request.itemIds) || !request.itemIds.length || request.itemIds.length > 200
        || request.itemIds.some((id: unknown) => typeof id !== "string" || !id || id.length > 512)
        || new Set(request.itemIds).size !== request.itemIds.length
        || typeof request.preserveCategories !== "boolean" || !["copy", "move"].includes(request.action)
        || request.targetCollectionId !== undefined && (typeof request.targetCollectionId !== "string" || !request.targetCollectionId || request.targetCollectionId.length > 512)) {
        throw new Error("移动恢复记录无效，已保留原始数据。");
      }
    }
    const itemIds=new Set<string>();
    for (const entry of record.entries) {
      if (!entry || entry.action!=='move' || !entry.expected || !entry.result || typeof entry.expected.id!=='string'
        || !entry.expected.id || entry.result.id!==entry.expected.id || itemIds.has(entry.expected.id)
        || !Array.isArray(entry.expected.providerRefs) || !Array.isArray(entry.result.providerRefs)
        || record.status !== "writing" && !entry.result.providerRefs.some((ref:{providerId?:string;remoteId?:string})=>ref.providerId===record.targetProviderId && typeof ref.remoteId==='string' && ref.remoteId)) {
        throw new Error("移动恢复记录无效，已保留原始数据。");
      }
      itemIds.add(entry.expected.id);
    }
    if (record.status === "writing" && (!record.writeIntent || !record.request)) throw new Error("移动恢复记录无效，已保留原始数据。");
    if (record.writeIntent !== undefined) {
      const intent = record.writeIntent;
      if (!intent || !/^[a-f0-9]{64}$/.test(intent.operationScope) || !Array.isArray(intent.entries)
        || intent.attachmentCount !== undefined && (!Number.isSafeInteger(intent.attachmentCount) || intent.attachmentCount < 0 || intent.attachmentCount > 50 * 512)
        || intent.entries.length !== record.entries.length) throw new Error("移动恢复记录无效，已保留原始数据。");
      for (let index = 0; index < intent.entries.length; index++) {
        const entry = intent.entries[index];
        if (!entry?.item || entry.item.id !== record.entries[index].expected.id
          || !Array.isArray(entry.item.providerRefs)
          || entry.originalItem !== undefined && (typeof entry.originalItem?.id !== "string" || !entry.originalItem.id)
          || record.status === "writing" && JSON.stringify(entry.item) !== JSON.stringify(record.entries[index].result)) {
          throw new Error("移动恢复记录无效，已保留原始数据。");
        }
        for (const json of [entry.originalPayloadJson, entry.payloadPatchJson]) {
          if (json === undefined) continue;
          if (typeof json !== "string" || json.length > 16 * 1024 * 1024) throw new Error("移动恢复记录无效，已保留原始数据。");
          try {
            const parsed = JSON.parse(json);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          } catch { throw new Error("移动恢复记录无效，已保留原始数据。"); }
        }
      }
    }
    if (record.attachments !== undefined) {
      const attachmentIds = new Set<string>();
      if (!Array.isArray(record.attachments) || record.attachments.length > 50 * 512) throw new Error("移动恢复记录无效，已保留原始数据。");
      for (const proof of record.attachments) {
        if (!proof || !itemIds.has(proof.itemId) || typeof proof.attachmentId !== "string" || !proof.attachmentId
          || attachmentIds.has(proof.attachmentId) || typeof proof.fileName !== "string" || !proof.fileName
          || proof.mediaType !== undefined && typeof proof.mediaType !== "string"
          || !Number.isSafeInteger(proof.sizeBytes) || proof.sizeBytes < 0 || proof.sizeBytes > 64 * 1024 * 1024
          || typeof proof.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.sha256)) {
          throw new Error("移动恢复记录无效，已保留原始数据。");
        }
        attachmentIds.add(proof.attachmentId);
      }
    }
  }
  return structuredClone(value);
}
