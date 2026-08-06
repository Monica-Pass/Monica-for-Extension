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
    project: "文件夹",
    entry: "条目",
    attachment: "附件",
    "object-relation": "对象关系",
    "object-label": "标签",
    "object-label-assignment": "标签绑定",
    other: "对象"
  } as const)[objectType];
}

export function presentMdbx2HealthRepairAutomatic(item: Mdbx2HealthRepairAutomaticSummary): Mdbx2HealthRepairPresentation {
  const objectLabel = mdbx2HealthRepairObjectTypeLabel(item.objectType);
  if (item.kind === "missing-tombstone") {
    return {
      icon: "healing",
      title: `补齐${objectLabel}删除标记`,
      supporting: `为 ${item.itemCount.toLocaleString("zh-CN")} 个已删除的${objectLabel}补齐缺失的同步删除标记。`
    };
  }
  return {
    icon: "filter_1",
    title: `归一重复${objectLabel}删除标记`,
    supporting: `将 ${item.itemCount.toLocaleString("zh-CN")} 个${objectLabel}的 ${item.tombstoneCount.toLocaleString("zh-CN")} 个同步删除标记归一为每项一个。`
  };
}

export function presentMdbx2HealthRepairConflict(item: Mdbx2HealthRepairConflict): Mdbx2HealthRepairPresentation {
  const objectLabel = mdbx2HealthRepairObjectTypeLabel(item.objectType);
  return {
    icon: "rule_settings",
    title: `${objectLabel}内容与删除状态冲突`,
    supporting: `这个${objectLabel}同时保留内容和 ${item.tombstoneCount.toLocaleString("zh-CN")} 个删除标记，需要选择最终状态。`
  };
}
