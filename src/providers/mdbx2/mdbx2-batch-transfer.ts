import type { VaultItem } from "../../core/model";
import { decodeKeePassPathSegments } from "../keepass/keepass-path-codec";
import { mdbx2LogicalObjectId } from "./mdbx2-item-codec";
import type { Mdbx2CollectionSummary } from "./native-contract";

export type Mdbx2BatchTransferAction = "copy" | "move";

export interface Mdbx2TransferCategorySource {
  categoryNames?: ReadonlyMap<number, string> | Record<string, string>;
  collections?: Mdbx2CollectionSummary[];
}

export interface Mdbx2BatchTransferPlanOptions extends Mdbx2TransferCategorySource {
  action: Mdbx2BatchTransferAction;
  targetCollectionId?: string;
  preserveCategories: boolean;
  now?: string;
  idFactory?: (item: VaultItem, index: number) => string;
}

export interface Mdbx2TransferPathResolution {
  segments: string[];
  complete: boolean;
}

export interface Mdbx2BatchTransferPlanItem {
  sourceItemId: string;
  effectiveAction: Mdbx2BatchTransferAction;
  sourcePath: string[];
  targetPath: string[];
  targetItem?: VaultItem;
  payloadPatch?: Record<string, unknown>;
  blockedReason?: string;
  pathIncomplete: boolean;
}

export interface Mdbx2BatchTransferPlan {
  action: Mdbx2BatchTransferAction;
  items: Mdbx2BatchTransferPlanItem[];
  blockedCount: number;
  warnings: string[];
}

const MAX_TRANSFER_ITEMS = 200;
const MAX_CATEGORY_DEPTH = 64;

/**
 * Mirrors Android's leaf-to-root MDBX folder traversal while remaining safe when a future
 * database contains a missing parent or a cycle.
 */
export function resolveMdbx2CollectionPath(
  collectionId: string | undefined,
  collections: readonly Mdbx2CollectionSummary[] = []
): Mdbx2TransferPathResolution {
  const normalizedId = collectionId?.trim();
  if (!normalizedId || normalizedId === "root") return { segments: [], complete: true };
  const byId = new Map(collections.map((collection) => [collection.collectionId, collection]));
  const seen = new Set<string>();
  const reversed: string[] = [];
  let current: string | undefined = normalizedId;
  let complete = true;
  while (current && current !== "root" && reversed.length < MAX_CATEGORY_DEPTH) {
    if (seen.has(current)) return { segments: reversed.reverse(), complete: false };
    seen.add(current);
    const collection = byId.get(current);
    if (!collection || collection.deleted) {
      complete = false;
      break;
    }
    if (isMdbx2RootCollection(collection)) {
      current = undefined;
      continue;
    }
    const title = collection.title.trim();
    if (title) reversed.push(title);
    current = collection.groupId;
  }
  if (reversed.length >= MAX_CATEGORY_DEPTH && current && current !== "root") complete = false;
  return { segments: reversed.reverse(), complete };
}

export function isMdbx2RootCollection(collection: Mdbx2CollectionSummary): boolean {
  return collection.collectionTypeId === "root"
    || (!collection.groupId && collection.title.trim().toLocaleLowerCase("en-US") === ".monica-root");
}

export function sourceCategoryPath(
  item: VaultItem,
  source: Mdbx2TransferCategorySource = {}
): Mdbx2TransferPathResolution {
  if (item.mdbxFolderId) return resolveMdbx2CollectionPath(item.mdbxFolderId, source.collections);
  if (item.keepassGroupPath) return { segments: decodeKeePassPathSegments(item.keepassGroupPath), complete: true };
  const named = item.categoryName?.trim()
    || (item.categoryId == null ? "" : categoryName(source.categoryNames, item.categoryId));
  return named ? { segments: flatCategorySegments(named), complete: true } : { segments: [], complete: true };
}

/**
 * Produces the detached record that the MDBX2 codec can write. Copy follows Android's new-row
 * semantics; move retains the Monica identity and replica group so an MDBX-to-MDBX move remains a
 * collection relocation rather than a second logical Object.
 */
export function normalizeMdbx2TransferItem(
  item: VaultItem,
  options: Pick<Mdbx2BatchTransferPlanOptions, "action" | "targetCollectionId" | "now"> & { targetItemId?: string }
): VaultItem {
  const now = options.now || new Date().toISOString();
  const copy = options.action === "copy";
  const normalized = structuredClone(item) as VaultItem;
  normalized.id = copy ? options.targetItemId || crypto.randomUUID() : item.id;
  normalized.createdAt = copy ? now : item.createdAt;
  normalized.updatedAt = now;
  normalized.deletedAt = undefined;
  normalized.sortOrder = copy ? 0 : item.sortOrder;
  normalized.categoryId = undefined;
  normalized.categoryName = undefined;
  normalized.mdbxDatabaseId = undefined;
  normalized.mdbxFolderId = options.targetCollectionId;
  normalized.keepassDatabaseId = undefined;
  normalized.keepassGroupPath = undefined;
  normalized.keepassEntryUuid = undefined;
  normalized.keepassGroupUuid = undefined;
  normalized.providerRefs = [];
  if (copy) normalized.replicaGroupId = undefined;

  if (normalized.kind === "login") {
    normalized.boundTotpItemId = undefined;
    normalized.boundNoteId = undefined;
    normalized.ssoRefEntryId = undefined;
  } else if (normalized.kind === "totp" || normalized.kind === "passkey") {
    normalized.boundPasswordId = undefined;
  }
  return normalized;
}

export function planMdbx2BatchTransfer(
  items: readonly VaultItem[],
  options: Mdbx2BatchTransferPlanOptions
): Mdbx2BatchTransferPlan {
  if (!items.length) throw new Error("请选择至少一个要传输的项目。");
  if (items.length > MAX_TRANSFER_ITEMS) throw new Error(`单次 MDBX2 批量传输最多支持 ${MAX_TRANSFER_ITEMS} 个项目。`);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("MDBX2 批量传输项目包含重复 ID。");

  const warnings: string[] = [];
  const selectedById = new Map(items.map((item) => [item.id, item]));
  const boundLoginsByTotpId = new Map<string, VaultItem[]>();
  for (const item of items) {
    if (item.kind !== "login" || !item.boundTotpItemId) continue;
    const current = boundLoginsByTotpId.get(item.boundTotpItemId) || [];
    current.push(item);
    boundLoginsByTotpId.set(item.boundTotpItemId, current);
  }

  const targetItems = new Map<string, VaultItem>();
  items.forEach((item, index) => {
    const effectiveAction = effectiveTransferAction(item, options.action);
    const targetItem = normalizeMdbx2TransferItem(item, {
      action: effectiveAction,
      targetCollectionId: options.targetCollectionId,
      now: options.now,
      targetItemId: effectiveAction === "copy" ? options.idFactory?.(item, index) : undefined
    });
    targetItems.set(item.id, targetItem);
  });

  for (const item of items) {
    if (item.kind !== "login" || !item.boundTotpItemId) continue;
    const linkedTarget = targetItems.get(item.boundTotpItemId);
    const targetLogin = targetItems.get(item.id);
    if (linkedTarget?.kind === "totp" && targetLogin?.kind === "login") {
      targetLogin.boundTotpItemId = linkedTarget.id;
    }
  }

  const planned = items.map((item): Mdbx2BatchTransferPlanItem => {
    const path = sourceCategoryPath(item, options);
    const effectiveAction = effectiveTransferAction(item, options.action);
    const blockedReason = transferBlockReason(item, selectedById, boundLoginsByTotpId);
    if (path.segments.length && !path.complete) warnings.push(`项目「${item.title || item.id}」的来源分类层级不完整，已保留可解析部分。`);
    if (blockedReason) warnings.push(`项目「${item.title || item.id}」未传输：${blockedReason}`);
    if (!blockedReason && item.kind === "passkey" && options.action === "copy") {
      warnings.push(`Passkey「${item.title || item.id}」不能创建第二份凭据，将按移动处理。`);
    }
    const targetPath = options.preserveCategories ? path.segments : [];
    const targetItem = blockedReason ? undefined : targetItems.get(item.id);
    const boundLogin = item.kind === "totp" ? boundLoginsByTotpId.get(item.id)?.[0] : undefined;
    const boundLoginTarget = boundLogin ? targetItems.get(boundLogin.id) : undefined;
    return {
      sourceItemId: item.id,
      effectiveAction,
      sourcePath: path.segments,
      targetPath,
      pathIncomplete: !path.complete,
      blockedReason,
      targetItem,
      payloadPatch: targetItem
        ? transferPayloadPatch(targetItem, boundLoginTarget ? mdbx2LogicalObjectId(boundLoginTarget) : undefined, effectiveAction)
        : undefined
    };
  });
  return {
    action: options.action,
    items: planned,
    blockedCount: planned.filter((item) => item.blockedReason).length,
    warnings: [...new Set(warnings)]
  };
}

function effectiveTransferAction(item: VaultItem, requested: Mdbx2BatchTransferAction): Mdbx2BatchTransferAction {
  return item.kind === "passkey" ? "move" : requested;
}

function transferBlockReason(
  item: VaultItem,
  selectedById: ReadonlyMap<string, VaultItem>,
  boundLoginsByTotpId: ReadonlyMap<string, VaultItem[]>
): string | undefined {
  if (item.deletedAt) return "已删除项目必须先从回收站恢复。";
  if (item.kind === "login" && item.boundNoteId != null) return "绑定笔记缺少可迁移的逻辑 ID，需先解除绑定。";
  if (item.kind === "login" && item.boundTotpItemId) {
    const linked = selectedById.get(item.boundTotpItemId);
    if (linked?.kind !== "totp") return "绑定验证码需要与登录项一起传输。";
    if (boundLoginsByTotpId.get(item.boundTotpItemId)?.length !== 1) return "同一验证码绑定了多个登录项，需先修复绑定关系。";
  }
  if (item.kind === "totp" && item.boundPasswordId != null) {
    const boundLogins = boundLoginsByTotpId.get(item.id) || [];
    if (boundLogins.length !== 1) return "绑定登录项需要与验证码一起传输。";
  }
  if (item.kind === "passkey") {
    if (item.boundPasswordId != null) return "绑定登录项需要与 Passkey 一起传输。";
    if (item.sourceMode === "android-metadata-only" || !item.privateKeyPkcs8) return "此 Passkey 只有元数据，没有可写入 MDBX2 的私钥。";
  }
  return undefined;
}

function transferPayloadPatch(
  item: VaultItem,
  boundLoginLogicalId: string | undefined,
  effectiveAction: Mdbx2BatchTransferAction
): Record<string, unknown> {
  const common: Record<string, unknown> = {
    bitwarden_mode: false,
    keepass_mode: false
  };
  if (effectiveAction === "copy") common.room_id = null;
  if (item.kind === "login") {
    return { ...common, bound_note_room_id: null, bound_note_entry_id: null };
  }
  if (item.kind === "passkey") return common;
  return {
    ...common,
    bound_password_entry_id: item.kind === "totp" ? boundLoginLogicalId || null : null
  };
}

function flatCategorySegments(name: string): string[] {
  return name.split(/\s*\/\s*/u).map((segment) => segment.trim()).filter(Boolean);
}

function categoryName(
  names: ReadonlyMap<number, string> | Record<string, string> | undefined,
  categoryId: number
): string {
  if (!names) return "";
  const map = names as ReadonlyMap<number, string>;
  const value = typeof map.get === "function"
    ? map.get(categoryId)
    : (names as Record<string, string>)[String(categoryId)];
  return typeof value === "string" ? value.trim() : "";
}
