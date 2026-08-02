import type {
  Mdbx2VaultHealthCategory,
  Mdbx2VaultHealthSeverity,
  Mdbx2VaultHealthSummary
} from "./native-contract";

export type Mdbx2DiagnosticTone = "healthy" | "attention" | "danger";

export interface Mdbx2HealthPresentation {
  tone: Mdbx2DiagnosticTone;
  icon: "verified_user" | "warning" | "gpp_bad";
  headline: string;
  supporting: string;
}

const CATEGORY_LABELS: Record<Mdbx2VaultHealthCategory, string> = {
  integrity: "数据库完整性",
  "vault-header-integrity": "保险库头认证",
  "incremental-integrity-root": "增量完整性根",
  "commit-chain": "提交链",
  "commit-integrity": "提交认证",
  "attachment-chunks": "附件分片",
  snapshots: "快照",
  orphans: "悬空记录",
  "collection-profiles": "文件夹配置",
  tombstones: "删除标记",
  "tombstone-acknowledgements": "删除确认",
  "purge-receipts": "清理回执",
  "stale-heads": "设备与分支 Head",
  other: "其他兼容性信号"
};

const SEVERITY_LABELS: Record<Mdbx2VaultHealthSeverity, string> = {
  info: "提示",
  warning: "警告",
  error: "错误",
  critical: "严重"
};

const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN");

export function presentMdbx2Health(health: Mdbx2VaultHealthSummary): Mdbx2HealthPresentation {
  if (health.criticalCount || health.errorCount) {
    return {
      tone: "danger",
      icon: "gpp_bad",
      headline: `发现 ${health.errorCount + health.criticalCount} 项高优先级问题`,
      supporting: "诊断是只读的；先保留本机副本，再按下方分类确认恢复风险。"
    };
  }
  if (health.issueCount) {
    return {
      tone: "attention",
      icon: "warning",
      headline: `发现 ${health.issueCount} 项需要关注的诊断信号`,
      supporting: "当前没有阻止读取的错误；这些提示仍值得在其他设备同步前复核。"
    };
  }
  return {
    tone: "healthy",
    icon: "verified_user",
    headline: "健康检查通过",
    supporting: "未发现完整性、提交链、附件、快照或结构异常。"
  };
}

export function mdbx2HealthCategoryLabel(category: Mdbx2VaultHealthCategory): string {
  return CATEGORY_LABELS[category];
}

export function mdbx2HealthSeverityLabel(severity: Mdbx2VaultHealthSeverity): string {
  return SEVERITY_LABELS[severity];
}

export function mdbx2HealthSeverityIcon(severity: Mdbx2VaultHealthSeverity): "info" | "warning" | "error" {
  return severity === "critical" || severity === "error" ? "error" : severity;
}

export function formatMdbx2DiagnosticCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

export function summarizeMdbx2HealthCounts(health: Mdbx2VaultHealthSummary): string {
  const parts = (["info", "warning", "error", "critical"] as const)
    .map((severity) => ({ severity, count: health[`${severity}Count`] }))
    .filter(({ count }) => count > 0)
    .map(({ severity, count }) => `${SEVERITY_LABELS[severity]} ${COUNT_FORMATTER.format(count)}`);
  return parts.length ? parts.join(" · ") : "未发现诊断问题";
}

export function formatMdbx2DiagnosticTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(unixSeconds * 1000));
}
