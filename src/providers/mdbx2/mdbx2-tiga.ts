import type {
  Mdbx2TigaAuditLevel,
  Mdbx2TigaBrowserLimitation,
  Mdbx2TigaCompliance,
  Mdbx2TigaDeviceAssurance,
  Mdbx2TigaProfile,
  Mdbx2TigaUnlockMethod,
  Mdbx2VaultTigaPosture
} from "./native-contract";

export type Mdbx2TigaTone = "healthy" | "attention" | "danger";

export interface Mdbx2TigaPresentation {
  tone: Mdbx2TigaTone;
  icon: "verified_user" | "warning" | "gpp_bad";
  headline: string;
  supporting: string;
}

const PROFILE_LABELS: Record<Mdbx2TigaProfile, string> = {
  sky: "Sky",
  multi: "Multi",
  power: "Power"
};

const COMPLIANCE_LABELS: Record<Mdbx2TigaCompliance, string> = {
  compliant: "策略合规",
  exception: "使用策略例外",
  "remediation-required": "需要策略修复"
};

const UNLOCK_METHOD_LABELS: Record<Mdbx2TigaUnlockMethod, string> = {
  pin: "PIN",
  password: "密码",
  "security-key": "安全密钥",
  "password-security-key": "密码 + 安全密钥"
};

const DEVICE_ASSURANCE_LABELS: Record<Mdbx2TigaDeviceAssurance, string> = {
  unknown: "未要求设备保障",
  standard: "标准设备保障",
  "trusted-hardware": "可信硬件保障"
};

const AUDIT_LEVEL_LABELS: Record<Mdbx2TigaAuditLevel, string> = {
  "security-changes": "安全配置变更",
  "sensitive-operations": "敏感操作",
  "all-decisions": "所有安全决策"
};

const LIMITATION_COPY: Record<Mdbx2TigaBrowserLimitation, { label: string; description: string; icon: string }> = {
  "device-assurance-insufficient": {
    label: "设备保障不足",
    description: "浏览器 Native Host 只能声明标准保障，无法等同可信硬件环境。",
    icon: "devices"
  },
  "secure-clipboard-unavailable": {
    label: "没有安全剪贴板",
    description: "浏览器无法提供与系统安全剪贴板等价的隔离与自动清除保证。",
    icon: "content_paste_off"
  },
  "screen-capture-protection-unavailable": {
    label: "没有截屏防护",
    description: "扩展无法阻止浏览器或操作系统截取当前管理页内容。",
    icon: "screenshot_monitor"
  }
};

const DURATION_FORMATTER = new Intl.NumberFormat("zh-CN");

export function presentMdbx2Tiga(posture: Mdbx2VaultTigaPosture): Mdbx2TigaPresentation {
  const profile = mdbx2TigaProfileLabel(posture.profile);
  if (posture.compliance === "remediation-required") {
    return {
      tone: "danger",
      icon: "gpp_bad",
      headline: `${profile} 策略需要修复`,
      supporting: "检测到旧策略弱化状态；扩展只显示态势，不会静默修改或降低策略。"
    };
  }
  if (!posture.unlock.satisfiesPolicy) {
    return {
      tone: "danger",
      icon: "gpp_bad",
      headline: `当前解锁配置不满足 ${profile}`,
      supporting: "请在支持 MDBX2 安全管理的设备上补齐解锁方式；浏览器不会伪造合规状态。"
    };
  }
  if (posture.compliance === "exception") {
    return {
      tone: "attention",
      icon: "warning",
      headline: `${profile} 当前使用策略例外`,
      supporting: "例外标识和原因不会进入管理页；请在受支持的安全管理端复核。"
    };
  }
  if (posture.browser.limitations.length) {
    return {
      tone: "attention",
      icon: "warning",
      headline: `${profile} 已启用，浏览器环境有 ${posture.browser.limitations.length} 项限制`,
      supporting: "这些是环境能力差异，不代表扩展已获得或绕过 Tiga 授权。"
    };
  }
  return {
    tone: "healthy",
    icon: "verified_user",
    headline: `${profile} 安全态势正常`,
    supporting: "解锁配置满足当前模式，浏览器环境没有额外的已知能力缺口。"
  };
}

export function mdbx2TigaProfileLabel(profile: Mdbx2TigaProfile): string {
  return PROFILE_LABELS[profile];
}

export function mdbx2TigaComplianceLabel(compliance: Mdbx2TigaCompliance): string {
  return COMPLIANCE_LABELS[compliance];
}

export function mdbx2TigaUnlockMethodLabel(method: Mdbx2TigaUnlockMethod): string {
  return UNLOCK_METHOD_LABELS[method];
}

export function mdbx2TigaDeviceAssuranceLabel(assurance: Mdbx2TigaDeviceAssurance): string {
  return DEVICE_ASSURANCE_LABELS[assurance];
}

export function mdbx2TigaAuditLevelLabel(level: Mdbx2TigaAuditLevel): string {
  return AUDIT_LEVEL_LABELS[level];
}

export function mdbx2TigaBrowserLimitation(limitation: Mdbx2TigaBrowserLimitation): { label: string; description: string; icon: string } {
  return LIMITATION_COPY[limitation];
}

export function formatMdbx2TigaDuration(seconds: number): string {
  if (seconds === 0) return "0 秒";
  if (seconds % 3600 === 0) return `${DURATION_FORMATTER.format(seconds / 3600)} 小时`;
  if (seconds % 60 === 0) return `${DURATION_FORMATTER.format(seconds / 60)} 分钟`;
  return `${DURATION_FORMATTER.format(seconds)} 秒`;
}

export function mdbx2TigaBooleanLabel(value: boolean, enabled: string, disabled: string): string {
  return value ? enabled : disabled;
}
