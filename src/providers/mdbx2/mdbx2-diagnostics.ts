import { tr, locale } from "../../i18n";
import type {
  Mdbx2VaultHealthCategory,
  Mdbx2VaultHealthIssueKind,
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

export type Mdbx2HealthGuidanceAction = "recheck" | "collections" | "snapshots" | "history" | "attachments";

export interface Mdbx2HealthGuidancePresentation {
  kind: Mdbx2VaultHealthIssueKind;
  severity: Mdbx2VaultHealthSeverity;
  count: number;
  icon: string;
  title: string;
  summary: string;
  impact: string;
  steps: readonly string[];
  action: Mdbx2HealthGuidanceAction;
  actionLabel: string;
  actionIcon: string;
}

interface Mdbx2HealthGuidanceDefinition {
  icon: string;
  title: string;
  summary: string;
  impact: string;
  steps: readonly string[];
  action: Mdbx2HealthGuidanceAction;
  actionLabel: string;
  actionIcon: string;
}

const CATEGORY_LABELS: Record<Mdbx2VaultHealthCategory, string> = {
  get integrity() { return tr('数据库完整性'); },
  get "vault-header-integrity"() { return tr('保险库头认证'); },
  get "incremental-integrity-root"() { return tr('增量完整性根'); },
  get "commit-chain"() { return tr('提交链'); },
  get "commit-integrity"() { return tr('提交认证'); },
  get "attachment-chunks"() { return tr('附件分片'); },
  get snapshots() { return tr('快照'); },
  get orphans() { return tr('悬空记录'); },
  get "collection-profiles"() { return tr('文件夹配置'); },
  get tombstones() { return tr('删除标记'); },
  get "tombstone-acknowledgements"() { return tr('删除确认'); },
  get "purge-receipts"() { return tr('清理回执'); },
  get "stale-heads"() { return tr('设备与分支 Head'); },
  get other() { return tr('其他兼容性信号'); }
};

const SEVERITY_LABELS: Record<Mdbx2VaultHealthSeverity, string> = {
  get info() { return tr('提示'); },
  get warning() { return tr('警告'); },
  get error() { return tr('错误'); },
  get critical() { return tr('严重'); }
};

const GUIDANCE: Record<Mdbx2VaultHealthIssueKind, Mdbx2HealthGuidanceDefinition> = {
  "basic-integrity": {
    icon: "gpp_bad",
    get title() { return tr('数据库基础结构异常'); },
    get summary() { return tr('数据库内部结构未通过基础校验，可能来自中断写入、受损副本或异常复制。'); },
    get impact() { return tr('继续写入可能扩大受影响范围，部分内容也可能无法读取。'); },
    get steps() { return [tr('先保留当前文件副本或导出完整备份。'), tr('关闭其他正在使用该数据库的设备或应用实例后重新检查。'), tr('异常持续存在时从正常快照恢复，或迁移仍可读取的内容。')]; },
    action: "snapshots",
    get actionLabel() { return tr('查看数据库快照'); },
    actionIcon: "restore"
  },
  "header-verification-pending": {
    icon: "lock_clock",
    get title() { return tr('等待完成安全校验'); },
    get summary() { return tr('数据库已经打开，但仍需在密钥可用的解锁状态下完成头部认证。'); },
    get impact() { return tr('这通常不代表数据损坏，但当前健康检查尚未完整。'); },
    get steps() { return [tr('保持 Monica 与此 MDBX2 保险库处于解锁状态。'), tr('等待当前操作完成后重新检查。'), tr('多次解锁后仍失败时再按身份校验失败处理。')]; },
    action: "recheck",
    get actionLabel() { return tr('重新检查'); },
    actionIcon: "refresh"
  },
  "header-authentication-failed": {
    icon: "security_update_warning",
    get title() { return tr('数据库身份校验失败'); },
    get summary() { return tr('数据库头部认证信息与当前内容不一致。'); },
    get impact() { return tr('文件可能来自不完整复制、错误凭据或受损副本，继续写入具有较高风险。'); },
    get steps() { return [tr('保留当前文件副本并暂停其他设备继续写入。'), tr('核对打开数据库时使用的凭据和文件来源。'), tr('优先从已验证的快照或完整备份恢复。')]; },
    action: "snapshots",
    get actionLabel() { return tr('查看数据库快照'); },
    actionIcon: "restore"
  },
  "integrity-root-pending": {
    icon: "hourglass_top",
    get title() { return tr('完整性索引尚未完成'); },
    get summary() { return tr('用于快速验证内容的完整性索引正在建立，或需要解锁后继续验证。'); },
    get impact() { return tr('数据库通常仍可使用，但当前健康结论尚不完整。'); },
    get steps() { return [tr('保持保险库解锁并等待当前操作完成。'), tr('避免多个应用实例同时打开同一本机工作副本。'), tr('随后重新检查完整性状态。')]; },
    action: "recheck",
    get actionLabel() { return tr('重新检查'); },
    actionIcon: "refresh"
  },
  "integrity-root-stale": {
    icon: "rule_settings",
    get title() { return tr('完整性索引需要重建'); },
    get summary() { return tr('完整性索引与当前数据库内容已经不同步。'); },
    get impact() { return tr('快速校验结果暂时不可信，可能伴随中断写入或异常并发访问。'); },
    get steps() { return [tr('先创建完整快照或导出备份。'), tr('关闭其他实例后重新打开并解锁数据库。'), tr('重新检查后仍异常时从正常快照恢复。')]; },
    action: "snapshots",
    get actionLabel() { return tr('查看数据库快照'); },
    actionIcon: "restore"
  },
  "commit-reference-missing": {
    icon: "account_tree",
    get title() { return tr('历史记录引用不完整'); },
    get summary() { return tr('某个提交或分支指向了当前文件中不存在的历史节点。'); },
    get impact() { return tr('历史比较、增量同步或恢复旧版本时可能出现缺口。'); },
    get steps() { return [tr('让所有仍使用该数据库的设备依次完成同步。'), tr('在提交历史中确认最近可用的操作。'), tr('缺口持续存在时从缺口之前的正常快照恢复。')]; },
    action: "history",
    get actionLabel() { return tr('查看提交历史'); },
    actionIcon: "history"
  },
  "commit-authentication-pending": {
    icon: "pending_actions",
    get title() { return tr('历史记录等待解锁验证'); },
    get summary() { return tr('提交记录需要在密钥可用时完成真实性校验。'); },
    get impact() { return tr('当前仅缺少验证条件，尚未确认内容损坏。'); },
    get steps() { return [tr('完成 Monica 与保险库解锁。'), tr('保持数据库打开并重新检查。'), tr('验证完成前不要依据该提交执行恢复。')]; },
    action: "recheck",
    get actionLabel() { return tr('重新检查'); },
    actionIcon: "refresh"
  },
  "commit-authentication-failed": {
    icon: "history_toggle_off",
    get title() { return tr('历史记录校验失败'); },
    get summary() { return tr('某个提交的认证标记与记录内容不一致。'); },
    get impact() { return tr('对应历史节点可能受损，基于它比较或恢复可能得到错误结果。'); },
    get steps() { return [tr('先创建当前数据库的完整备份。'), tr('在提交历史中定位异常前后的正常操作。'), tr('使用正常快照恢复，或迁移当前仍可读取的内容。')]; },
    action: "history",
    get actionLabel() { return tr('查看提交历史'); },
    actionIcon: "history"
  },
  "attachment-structure": {
    icon: "attachment",
    get title() { return tr('附件分片不完整'); },
    get summary() { return tr('附件记录的分片数量或顺序与实际加密存储不一致。'); },
    get impact() { return tr('受影响附件可能无法打开、导出或同步完整。'); },
    get steps() { return [tr('先导出仍可正常打开的重要附件。'), tr('完成一次远端同步后重新检查附件统计。'), tr('异常持续存在时从含有完整附件的备份恢复。')]; },
    action: "attachments",
    get actionLabel() { return tr('查看附件统计'); },
    actionIcon: "attachment"
  },
  "snapshot-invalid": {
    icon: "restore_page",
    get title() { return tr('快照校验失败'); },
    get summary() { return tr('某个快照的摘要、认证信息或内容结构未通过校验。'); },
    get impact() { return tr('该快照不适合作为恢复来源，当前数据库内容未必受到影响。'); },
    get steps() { return [tr('不要使用异常快照执行恢复。'), tr('创建新的完整快照并确认其状态。'), tr('需要恢复时选择另一份已通过校验的快照。')]; },
    action: "snapshots",
    get actionLabel() { return tr('查看数据库快照'); },
    actionIcon: "restore"
  },
  "orphan-record": {
    icon: "folder_off",
    get title() { return tr('内容缺少所属文件夹'); },
    get summary() { return tr('部分条目或附件引用了当前数据库中不存在的文件夹。'); },
    get impact() { return tr('相关内容可能无法在正常列表显示，移动与同步也可能失败。'); },
    get steps() { return [tr('先让所有设备完成同步并重新检查。'), tr('将仍可访问的内容移动到有效文件夹。'), tr('内容无法访问时从最近的正常快照恢复。')]; },
    action: "collections",
    get actionLabel() { return tr('查看文件夹'); },
    actionIcon: "folder_open"
  },
  "collection-profile": {
    icon: "folder_managed",
    get title() { return tr('文件夹规则与内容不一致'); },
    get summary() { return tr('某个文件夹缺少有效配置，或包含该规则不允许的内容类型。'); },
    get impact() { return tr('相关内容可能显示在错误位置，或无法按预期编辑和同步。'); },
    get steps() { return [tr('完成同步后重新检查文件夹状态。'), tr('将内容移动到正确文件夹或受保护的根目录。'), tr('无效文件夹应先备份内容，再重新建立。')]; },
    action: "collections",
    get actionLabel() { return tr('查看文件夹'); },
    actionIcon: "folder_open"
  },
  "tombstone-duplicate": {
    icon: "delete_sweep",
    get title() { return tr('删除记录重复'); },
    get summary() { return tr('同一对象保留了多个删除标记，当前删除状态无法唯一确认。'); },
    get impact() { return tr('相关内容在同步、恢复或永久删除时可能产生冲突。'); },
    get steps() { return [tr('先创建完整快照或导出备份。'), tr('让所有设备完成同步后重新检查。'), tr('异常持续存在时从正常快照恢复或迁移可用内容。')]; },
    action: "snapshots",
    get actionLabel() { return tr('查看数据库快照'); },
    actionIcon: "restore"
  },
  "tombstone-missing": {
    icon: "delete_forever",
    get title() { return tr('删除记录缺失'); },
    get summary() { return tr('内容已标记为删除，但缺少对应的删除历史。'); },
    get impact() { return tr('其他设备可能无法识别此次删除，内容可能重新出现或产生冲突。'); },
    get steps() { return [tr('先创建完整快照或导出备份。'), tr('让所有设备完成同步并重新检查。'), tr('仍然异常时从删除操作之前的正常快照恢复。')]; },
    action: "snapshots",
    get actionLabel() { return tr('查看数据库快照'); },
    actionIcon: "restore"
  },
  "tombstone-stale": {
    icon: "delete_history",
    get title() { return tr('有效内容残留删除标记'); },
    get summary() { return tr('当前仍在使用的内容同时保留了删除标记。'); },
    get impact() { return tr('后续同步可能再次把有效内容视为已删除。'); },
    get steps() { return [tr('立即备份仍可访问的相关内容。'), tr('暂停其他设备编辑并完成一次同步。'), tr('异常持续存在时从正常快照恢复或复制内容到新库。')]; },
    action: "snapshots",
    get actionLabel() { return tr('查看数据库快照'); },
    actionIcon: "restore"
  },
  "tombstone-acknowledgement": {
    icon: "devices_other",
    get title() { return tr('设备删除确认记录异常'); },
    get summary() { return tr('某台设备对删除记录的确认无法通过历史关系校验。'); },
    get impact() { return tr('跨设备同步可能重复处理删除，或长期保留待清理记录。'); },
    get steps() { return [tr('确保相关设备都完成同步并退出数据库。'), tr('在当前设备重新同步并检查历史。'), tr('异常持续存在时保留备份并从正常快照恢复。')]; },
    action: "history",
    get actionLabel() { return tr('查看提交历史'); },
    actionIcon: "history"
  },
  "purge-record": {
    icon: "delete_forever",
    get title() { return tr('永久删除证明异常'); },
    get summary() { return tr('永久删除记录与对象或删除标记未保持一致。'); },
    get impact() { return tr('永久删除状态可能无法在所有设备上得到一致确认。'); },
    get steps() { return [tr('完成所有设备的同步并重新检查。'), tr('保留当前数据库与完整备份。'), tr('持续异常时从永久删除之前的正常快照恢复。')]; },
    action: "history",
    get actionLabel() { return tr('查看提交历史'); },
    actionIcon: "history"
  },
  "device-reference": {
    icon: "sync_problem",
    get title() { return tr('设备同步位置异常'); },
    get summary() { return tr('某台设备记录的最新提交位置缺失、落后或归属异常。'); },
    get impact() { return tr('跨设备同步可能遗漏更新，历史也可能显示错误位置。'); },
    get steps() { return [tr('让所有仍在使用的设备依次完成同步。'), tr('在提交历史中确认最新有效操作。'), tr('仍异常时从共同的正常快照重新建立同步。')]; },
    action: "history",
    get actionLabel() { return tr('查看提交历史'); },
    actionIcon: "history"
  },
  "inactive-device": {
    icon: "devices",
    get title() { return tr('存在长期未活动设备'); },
    get summary() { return tr('数据库保留了一台较长时间未参与同步的设备记录。'); },
    get impact() { return tr('这通常只是状态提示，不代表数据库内容损坏。'); },
    get steps() { return [tr('确认该设备是否仍在使用此数据库。'), tr('仍在使用时让它完成一次同步。'), tr('设备已经停用时可暂时保留记录，后续维护时再处理。')]; },
    action: "history",
    get actionLabel() { return tr('查看提交历史'); },
    actionIcon: "history"
  },
  unknown: {
    icon: "help",
    get title() { return tr('发现未识别的数据库异常'); },
    get summary() { return tr('当前版本尚未为该底层检查提供专门说明。'); },
    get impact() { return tr('影响范围无法仅凭脱敏摘要确认。'); },
    get steps() { return [tr('先创建完整快照或导出备份。'), tr('关闭其他设备或应用实例后重新检查。'), tr('异常持续存在时保留数据库副本并更新 Monica 与 Native Host。')]; },
    action: "recheck",
    get actionLabel() { return tr('重新检查'); },
    actionIcon: "refresh"
  }
};

const COUNT_FORMATTER = { format: (value: number) => new Intl.NumberFormat(locale.value).format(value) };

export function presentMdbx2Health(health: Mdbx2VaultHealthSummary): Mdbx2HealthPresentation {
  if (health.criticalCount || health.errorCount) {
    return {
      tone: "danger",
      icon: "gpp_bad",
      headline: tr('发现 {0} 项高优先级问题', { 0: health.errorCount + health.criticalCount }),
      supporting: tr('诊断是只读的；先保留本机副本，再按下方分类确认恢复风险。')
    };
  }
  if (health.issueCount) {
    return {
      tone: "attention",
      icon: "warning",
      headline: tr('发现 {0} 项需要关注的诊断信号', { 0: health.issueCount }),
      supporting: tr('当前没有阻止读取的错误；这些提示仍值得在其他设备同步前复核。')
    };
  }
  return {
    tone: "healthy",
    icon: "verified_user",
    headline: tr('健康检查通过'),
    supporting: tr('未发现完整性、提交链、附件、快照或结构异常。')
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
  return parts.length ? parts.join(" · ") : tr('未发现诊断问题');
}

export function presentMdbx2HealthGuidance(health: Mdbx2VaultHealthSummary): Mdbx2HealthGuidancePresentation[] {
  return health.issueKinds
    .map((issue) => {
      const definition = GUIDANCE[issue.kind];
      return {
        kind: issue.kind,
        severity: issue.highestSeverity,
        count: issue.count,
        ...definition,
        title: issue.count > 1 ? tr('{0}（{1} 项）', { 0: definition.title, 1: COUNT_FORMATTER.format(issue.count) }) : definition.title
      };
    })
    .sort((left, right) => {
      const severity = healthSeverityRank(right.severity) - healthSeverityRank(left.severity);
      if (severity) return severity;
      return left.title.localeCompare(right.title, locale.value);
    });
}

export function formatMdbx2DiagnosticTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat(locale.value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(unixSeconds * 1000));
}

function healthSeverityRank(severity: Mdbx2VaultHealthSeverity): number {
  return severity === "critical" ? 3 : severity === "error" ? 2 : severity === "warning" ? 1 : 0;
}
