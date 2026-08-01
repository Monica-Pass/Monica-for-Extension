import type { Mdbx2CommitChangeSummary, Mdbx2CommitDiffItem, Mdbx2CommitHistoryItem } from "./native-contract";

export type Mdbx2HistoryAction = "created" | "updated" | "moved" | "copied" | "deleted" | "restored" | "merged" | "system";

export interface Mdbx2HistoryActionCounts {
  created: number;
  updated: number;
  moved: number;
  copied: number;
  deleted: number;
  restored: number;
  total: number;
}

export interface Mdbx2HistoryPresentation {
  title: string;
  supportingText: string;
  action: Mdbx2HistoryAction;
  counts: Mdbx2HistoryActionCounts;
  objectCount: number;
  isSystemCommit: boolean;
  canInspect: boolean;
  icon: string;
}

export interface Mdbx2DiffPresentation {
  title: string;
  supportingText: string;
  action: Exclude<Mdbx2HistoryAction, "copied" | "merged" | "system">;
  icon: string;
  displayTitle: string;
}

export function presentMdbx2History(item: Mdbx2CommitHistoryItem): Mdbx2HistoryPresentation {
  const changes = distinctChanges(item.changes);
  const counts = actionCounts(changes);
  const objectCount = changes.length;
  const isSystemCommit = systemCommit(item);
  const action: Mdbx2HistoryAction = isSystemCommit
    ? "system"
    : item.commitKind.toLocaleLowerCase() === "merge" || item.parentIds.length > 1
      ? "merged"
      : onlyAction(counts, "deleted")
        ? "deleted"
        : onlyAction(counts, "restored")
          ? "restored"
          : onlyAction(counts, "moved")
            ? "moved"
            : onlyAction(counts, "copied")
              ? "copied"
              : onlyAction(counts, "created")
                ? "created"
                : "updated";
  const systemDescription = isSystemCommit ? systemCommitDescription(item) : undefined;
  const supportingText = systemDescription || countSummary(counts) || item.message || "数据库内容已更新";
  return {
    title: operationTitle(item, action, objectCount, changes),
    supportingText,
    action,
    counts,
    objectCount,
    isSystemCommit,
    canInspect: changes.length > 0,
    icon: historyActionIcon(action)
  };
}

export function presentMdbx2Diff(item: Mdbx2CommitDiffItem): Mdbx2DiffPresentation {
  const action = diffAction(item);
  const objectLabel = mdbx2HistoryObjectTypeLabel(item.objectType, item.contentType);
  const displayTitle = item.currentTitle?.trim() || item.previousTitle?.trim() || objectLabel;
  const details: string[] = [];
  if (item.previousTitle !== item.currentTitle) details.push("标题已修改");
  if (item.payloadChanged) details.push("内容已修改");
  if (item.changedFields.some(isCollectionField)) details.push("位置已修改");
  if (item.previousDeleted !== item.currentDeleted) details.push(item.currentDeleted ? "已移入回收站" : "已恢复");
  const unknownCount = item.changedFields.filter((field) => !knownDiffField(field)).length;
  if (unknownCount) details.push(`另有 ${unknownCount} 个字段变化`);
  return {
    title: `${diffActionLabel(action)}${objectLabel}`,
    supportingText: details.join(" · ") || "对象元数据已更新",
    action,
    icon: historyActionIcon(action),
    displayTitle
  };
}

export function mdbx2HistoryObjectTypeLabel(objectType: string, contentType?: string): string {
  switch (contentType?.trim().toLocaleLowerCase()) {
    case "login":
    case "password": return "密码";
    case "note": return "笔记";
    case "totp": return "验证器";
    case "card": return "卡片";
    case "document-ref":
    case "document": return "证件";
    case "billing-address": return "地址";
    case "payment-account": return "支付账户";
    case "passkey": return "通行密钥";
    case "steam-mafile": return "Steam 账号";
  }
  switch (objectType.trim().toLocaleLowerCase()) {
    case "entry": return "条目";
    case "project":
    case "folder": return "文件夹";
    case "attachment": return "附件";
    case "passkey": return "通行密钥";
    case "object-relation": return "关联";
    case "object-label":
    case "object-label-assignment": return "标签";
    case "vault-meta": return "数据库设置";
    case "key-epoch": return "数据库密钥";
    case "snapshot": return "快照";
    case "branch": return "同步分支";
    default: return "对象";
  }
}

export function formatMdbx2HistoryTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.replace("T", " ").replace(/Z$/, "").slice(0, 16) : date.toLocaleString();
}

function distinctChanges(changes: Mdbx2CommitChangeSummary[]): Mdbx2CommitChangeSummary[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.objectType}\u0000${change.objectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function actionCounts(changes: Mdbx2CommitChangeSummary[]): Mdbx2HistoryActionCounts {
  const counts: Mdbx2HistoryActionCounts = { created: 0, updated: 0, moved: 0, copied: 0, deleted: 0, restored: 0, total: 0 };
  for (const change of changes) {
    counts[changeAction(change)]++;
    counts.total++;
  }
  return counts;
}

function changeAction(change: Mdbx2CommitChangeSummary): keyof Omit<Mdbx2HistoryActionCounts, "total"> {
  switch (change.action.trim().toLocaleLowerCase()) {
    case "create":
    case "created":
    case "add":
    case "added": return "created";
    case "move":
    case "moved": return "moved";
    case "copy":
    case "copied": return "copied";
    case "delete":
    case "deleted":
    case "remove":
    case "removed": return "deleted";
    case "restore":
    case "restored":
    case "revert":
    case "reverted": return "restored";
    default: return "updated";
  }
}

function onlyAction(counts: Mdbx2HistoryActionCounts, action: keyof Omit<Mdbx2HistoryActionCounts, "total">): boolean {
  return counts.total > 0 && counts[action] === counts.total;
}

function countSummary(counts: Mdbx2HistoryActionCounts): string {
  return [
    counts.created ? `新增 ${counts.created}` : "",
    counts.updated ? `修改 ${counts.updated}` : "",
    counts.moved ? `移动 ${counts.moved}` : "",
    counts.copied ? `复制 ${counts.copied}` : "",
    counts.deleted ? `删除 ${counts.deleted}` : "",
    counts.restored ? `恢复 ${counts.restored}` : ""
  ].filter(Boolean).join(" · ");
}

function operationTitle(item: Mdbx2CommitHistoryItem, action: Mdbx2HistoryAction, objectCount: number, changes: Mdbx2CommitChangeSummary[]): string {
  const operation = item.operationKind?.trim().toLocaleLowerCase();
  switch (operation) {
    case "monica-initialize": return "初始化数据库";
    case "monica-create-folder": return "新建文件夹";
    case "monica-rename-folder": return "重命名文件夹";
    case "monica-move-folder": return "移动文件夹";
    case "monica-delete-folder": return "删除文件夹";
    case "monica-restore-folder": return "恢复文件夹";
    case "monica-migration-folders": return "导入文件夹";
    case "monica-project-tags": return "更新文件夹标签";
    case "revert-commit": return "恢复历史版本";
  }
  if (operation?.includes("attachment-create")) return actionTitle("created", objectCount, changes, "附件");
  if (operation?.includes("attachment-replace")) return "更新附件内容";
  if (operation?.includes("snapshot")) return "更新数据库快照";
  if (operation?.includes("key") && operation.includes("rotat")) return "轮换数据库密钥";
  return actionTitle(action, objectCount, changes);
}

function actionTitle(action: Mdbx2HistoryAction, objectCount: number, changes: Mdbx2CommitChangeSummary[], forcedType?: string): string {
  if (action === "merged") return "合并了数据库变更";
  if (action === "system") return "数据库系统事件";
  const labels = [...new Set(changes.map((change) => mdbx2HistoryObjectTypeLabel(change.objectType)))];
  const objectLabel = forcedType || (labels.length === 1 ? labels[0] : "项目");
  const quantity = objectCount > 0 ? `${objectCount} 个${objectLabel}` : objectLabel;
  return `${diffActionLabel(action)}${quantity}`;
}

function systemCommit(item: Mdbx2CommitHistoryItem): boolean {
  const operation = item.operationKind?.trim().toLocaleLowerCase() || "";
  const scope = item.changeScope.trim().toLocaleLowerCase();
  const kind = item.commitKind.trim().toLocaleLowerCase();
  return operation === "monica-initialize" || operation.startsWith("snapshot-") || operation.startsWith("branch-") ||
    operation.includes("key-rotation") || operation.includes("security-policy") ||
    ["vault-meta", "key-epoch", "snapshot", "branch"].includes(scope) || ["snapshot", "key-rotation"].includes(kind);
}

function systemCommitDescription(item: Mdbx2CommitHistoryItem): string {
  if (item.operationKind?.toLocaleLowerCase() === "monica-initialize") return "建立数据库根目录和初始结构";
  if (item.commitKind.toLocaleLowerCase() === "key-rotation" || item.changeScope.toLocaleLowerCase() === "key-epoch") return "更新数据库加密密钥或解锁材料";
  if (item.commitKind.toLocaleLowerCase() === "snapshot" || item.changeScope.toLocaleLowerCase() === "snapshot") return "记录或整理数据库快照";
  if (item.changeScope.toLocaleLowerCase() === "branch") return "更新数据库同步分支状态";
  if (item.changeScope.toLocaleLowerCase() === "vault-meta") return "更新数据库设置或安全元数据";
  return item.message || "此提交记录的是数据库级事件，不包含普通条目变更";
}

function diffAction(item: Mdbx2CommitDiffItem): Mdbx2DiffPresentation["action"] {
  if (item.previousDeleted === undefined && !item.currentDeleted) return "created";
  if (item.previousDeleted === true && !item.currentDeleted) return "restored";
  if (item.currentDeleted) return "deleted";
  if (item.changedFields.some(isCollectionField)) return "moved";
  return "updated";
}

function diffActionLabel(action: Mdbx2HistoryAction): string {
  switch (action) {
    case "created": return "添加了";
    case "updated": return "更新了";
    case "moved": return "移动了";
    case "copied": return "复制了";
    case "deleted": return "删除了";
    case "restored": return "恢复了";
    case "merged": return "合并了";
    case "system": return "记录了";
  }
}

function historyActionIcon(action: Mdbx2HistoryAction): string {
  switch (action) {
    case "created": return "add";
    case "moved": return "drive_file_move";
    case "copied": return "content_copy";
    case "deleted": return "delete";
    case "restored": return "restore";
    case "merged": return "merge";
    case "system": return "settings_backup_restore";
    default: return "history";
  }
}

function isCollectionField(field: string): boolean {
  const normalized = field.trim().toLocaleLowerCase();
  return normalized === "collection" || normalized === "collection_id" || normalized === "project_id";
}

function knownDiffField(field: string): boolean {
  const normalized = field.trim().toLocaleLowerCase();
  return normalized === "title" || normalized === "payload" || normalized === "deleted" || isCollectionField(normalized);
}
