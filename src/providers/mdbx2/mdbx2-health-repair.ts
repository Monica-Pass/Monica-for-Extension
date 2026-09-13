import { tr, locale } from "../../i18n";
import type {
  Mdbx2HealthRepairAutomaticSummary,
  Mdbx2HealthRepairConflict,
  Mdbx2HealthRepairObjectType
} from "./native-contract";

export interface Mdbx2HealthRepairPresentation {
  icon: string;
  title: string;
  supporting: string;
}

export function mdbx2HealthRepairObjectTypeLabel(objectType: Mdbx2HealthRepairObjectType): string {
  return ({
    project: tr('文件夹'),
    entry: tr('条目'),
    attachment: tr('附件'),
    "object-relation": tr('对象关系'),
    "object-label": tr('标签'),
    "object-label-assignment": tr('标签绑定'),
    other: tr('对象')
  } as const)[objectType];
}

export function presentMdbx2HealthRepairAutomatic(item: Mdbx2HealthRepairAutomaticSummary): Mdbx2HealthRepairPresentation {
  const objectLabel = mdbx2HealthRepairObjectTypeLabel(item.objectType);
  if (item.kind === "missing-tombstone") {
    return {
      icon: "healing",
      title: tr('补齐{0}删除标记', { 0: objectLabel }),
      supporting: tr('为 {0} 个已删除的{1}补齐缺失的同步删除标记。', { 0: item.itemCount.toLocaleString(locale.value), 1: objectLabel })
    };
  }
  return {
    icon: "filter_1",
    title: tr('归一重复{0}删除标记', { 0: objectLabel }),
    supporting: tr('将 {0} 个{1}的 {2} 个同步删除标记归一为每项一个。', { 0: item.itemCount.toLocaleString(locale.value), 1: objectLabel, 2: item.tombstoneCount.toLocaleString(locale.value) })
  };
}

export function presentMdbx2HealthRepairConflict(item: Mdbx2HealthRepairConflict): Mdbx2HealthRepairPresentation {
  const objectLabel = mdbx2HealthRepairObjectTypeLabel(item.objectType);
  return {
    icon: "rule_settings",
    title: tr('{0}内容与删除状态冲突', { 0: objectLabel }),
    supporting: tr('这个{0}同时保留内容和 {1} 个删除标记，需要选择最终状态。', { 0: objectLabel, 1: item.tombstoneCount.toLocaleString(locale.value) })
  };
}
