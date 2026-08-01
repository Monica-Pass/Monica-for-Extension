import { formatMdbx2HistoryTime } from "./mdbx2-history";
import type { Mdbx2ManagedSnapshotSummary, Mdbx2SnapshotStructureNode } from "./native-contract";

export interface Mdbx2SnapshotPresentation {
  title: string;
  supportingText: string;
  kindLabel: string;
  completenessLabel: string;
  sizeLabel: string;
  integrityLabel: string;
  timeLabel: string;
  icon: string;
  generatedName: boolean;
  canRestore: boolean;
}

export interface Mdbx2SnapshotNodePresentation {
  title: string;
  supportingText: string;
  typeLabel: string;
  statusLabel: string;
  statusIcon: string;
}

export function presentMdbx2Snapshot(item: Mdbx2ManagedSnapshotSummary): Mdbx2SnapshotPresentation {
  const kindLabel = item.kind === "manual" ? "手动" : "自动";
  const generatedName = generatedSnapshotName(item.name);
  const completenessLabel = item.isFull ? "完整快照" : "增量快照";
  const sizeLabel = formatMdbx2SnapshotBytes(item.payloadBytes);
  const integrityLabel = item.integrityOk ? "完整性正常" : "完整性失败";
  return {
    title: generatedName ? `${kindLabel}快照` : item.name.trim() || `${kindLabel}快照`,
    supportingText: `${kindLabel} · ${completenessLabel} · ${sizeLabel} · ${integrityLabel}`,
    kindLabel,
    completenessLabel,
    sizeLabel,
    integrityLabel,
    timeLabel: formatMdbx2HistoryTime(item.createdAt),
    icon: item.integrityOk ? item.kind === "manual" ? "backup" : "schedule" : "gpp_bad",
    generatedName,
    canRestore: item.integrityOk
  };
}

export function presentMdbx2SnapshotNode(node: Mdbx2SnapshotStructureNode): Mdbx2SnapshotNodePresentation {
  const typeLabel = node.nodeType === "folder" ? "文件夹" : "条目";
  const statusLabel = snapshotNodeStatusLabel(node.status);
  const title = node.name.trim() || typeLabel;
  const path = node.path.trim();
  const details = [path && path !== title ? path : "", typeLabel, node.childCount ? `${node.childCount} 个子项` : ""].filter(Boolean);
  return {
    title,
    supportingText: details.join(" · "),
    typeLabel,
    statusLabel,
    statusIcon: snapshotNodeStatusIcon(node.status)
  };
}

export function formatMdbx2SnapshotBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${unit}`;
}

function generatedSnapshotName(value: string): boolean {
  return /^Snapshot \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim());
}

function snapshotNodeStatusLabel(status: Mdbx2SnapshotStructureNode["status"]): string {
  switch (status) {
    case "added": return "新增";
    case "removed": return "移除";
    case "modified": return "修改";
    default: return "未变化";
  }
}

function snapshotNodeStatusIcon(status: Mdbx2SnapshotStructureNode["status"]): string {
  switch (status) {
    case "added": return "add_circle";
    case "removed": return "remove_circle";
    case "modified": return "edit";
    default: return "check_circle";
  }
}
