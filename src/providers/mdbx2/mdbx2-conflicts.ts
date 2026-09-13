import { tr } from "../../i18n";
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
  const title = item.displayTitle?.trim() || tr('{0}冲突', { 0: objectLabel });
  const preview = fieldLabels.slice(0, 3).join("、");
  return {
    title,
    supportingText: preview
      ? tr('冲突字段：{0}{1}', { 0: preview, 1: fieldLabels.length > 3 ? tr(' 等 {0} 项', { 0: fieldLabels.length }) : "" })
      : tr('此对象在多个设备上被同时修改'),
    objectLabel,
    fieldLabels,
    timeLabel: formatMdbx2HistoryTime(item.createdAt),
    icon: "call_merge"
  };
}

export function mdbx2ConflictChoiceLabel(choice: Mdbx2ConflictResolutionChoice): string {
  return choice === "local-wins" ? tr('保留本机版本') : tr('采用传入版本');
}

export function mdbx2ConflictChoiceDescription(choice: Mdbx2ConflictResolutionChoice): string {
  return choice === "local-wins"
    ? tr('将保留当前浏览器中的版本，并把这次选择作为新的同步变更发布；传入设备的并发修改不会应用到此对象。')
    : tr('将采用其他设备传入的版本，并把这次选择作为新的同步变更发布；当前浏览器中的并发修改会被替换。');
}

function conflictFieldLabel(field: string): string {
  const normalized = field.trim().toLocaleLowerCase();
  const parts = normalized.split(/[./]/);
  const leaf = parts[parts.length - 1] || normalized;
  switch (leaf) {
    case "title":
    case "title_ct": return tr('标题');
    case "payload":
    case "payload_ct": return tr('内容');
    case "project_id":
    case "collection":
    case "collection_id": return tr('位置');
    case "deleted": return tr('删除状态');
    case "entry_type":
    case "object_type": return tr('类型');
    case "content_hash": return tr('附件内容');
    case "file_name":
    case "file_name_ct": return tr('文件名');
    case "media_type":
    case "media_type_ct": return tr('文件类型');
    case "group_id": return tr('分组');
    case "favorite": return tr('收藏状态');
    case "archived": return tr('归档状态');
    case "tags":
    case "tag_ids": return tr('标签');
    default: return field.trim() ? tr('其他字段（{0}）', { 0: field.trim() }) : tr('其他字段');
  }
}
