import { formatMdbx2HistoryTime, mdbx2HistoryObjectTypeLabel } from "./mdbx2-history";
import type { Mdbx2ConflictResolutionChoice, Mdbx2ConflictSummary } from "./native-contract";

export interface Mdbx2ConflictPresentation {
  title: string;
  supportingText: string;
  objectLabel: string;
  fieldLabels: string[];
  timeLabel: string;
  icon: string;
}

export function presentMdbx2Conflict(item: Mdbx2ConflictSummary): Mdbx2ConflictPresentation {
  const objectLabel = mdbx2HistoryObjectTypeLabel(item.objectType, item.contentType);
  const fieldLabels = [...new Set(item.conflictingFields.map(conflictFieldLabel))];
  const title = item.displayTitle?.trim() || `${objectLabel}冲突`;
  const preview = fieldLabels.slice(0, 3).join("、");
  return {
    title,
    supportingText: preview
      ? `冲突字段：${preview}${fieldLabels.length > 3 ? ` 等 ${fieldLabels.length} 项` : ""}`
      : "此对象在多个设备上被同时修改",
    objectLabel,
    fieldLabels,
    timeLabel: formatMdbx2HistoryTime(item.createdAt),
    icon: "call_merge"
  };
}

export function mdbx2ConflictChoiceLabel(choice: Mdbx2ConflictResolutionChoice): string {
  return choice === "local-wins" ? "保留本机版本" : "采用传入版本";
}

export function mdbx2ConflictChoiceDescription(choice: Mdbx2ConflictResolutionChoice): string {
  return choice === "local-wins"
    ? "将保留当前浏览器中的版本，并把这次选择作为新的同步变更发布；传入设备的并发修改不会应用到此对象。"
    : "将采用其他设备传入的版本，并把这次选择作为新的同步变更发布；当前浏览器中的并发修改会被替换。";
}

function conflictFieldLabel(field: string): string {
  const normalized = field.trim().toLocaleLowerCase();
  const parts = normalized.split(/[./]/);
  const leaf = parts[parts.length - 1] || normalized;
  switch (leaf) {
    case "title":
    case "title_ct": return "标题";
    case "payload":
    case "payload_ct": return "内容";
    case "project_id":
    case "collection":
    case "collection_id": return "位置";
    case "deleted": return "删除状态";
    case "entry_type":
    case "object_type": return "类型";
    case "content_hash": return "附件内容";
    case "file_name":
    case "file_name_ct": return "文件名";
    case "media_type":
    case "media_type_ct": return "文件类型";
    case "group_id": return "分组";
    case "favorite": return "收藏状态";
    case "archived": return "归档状态";
    case "tags":
    case "tag_ids": return "标签";
    default: return field.trim() ? `其他字段（${field.trim()}）` : "其他字段";
  }
}
