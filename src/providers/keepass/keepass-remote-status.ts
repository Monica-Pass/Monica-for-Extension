import type { KeePassRemoteManagerError, KeePassRemoteManagerErrorCode } from "./keepass-remote-session";

export type KeePassRemoteRecoveryAction = "retry" | "reconnect" | "none";

export interface KeePassRemoteErrorPresentation {
  icon: string;
  title: string;
  message: string;
  action: KeePassRemoteRecoveryAction;
  actionLabel?: string;
}

const RETRYABLE_CODES = new Set<KeePassRemoteManagerErrorCode>([
  "timeout",
  "network",
  "rate-limited",
  "server",
  "remote-write-verification-failed",
  "revision-stale"
]);

const RECONNECT_CODES = new Set<KeePassRemoteManagerErrorCode>([
  "authentication",
  "permission",
  "not-found",
  "remote-working-copy-missing",
  "remote-credential-missing",
  "remote-key-file-invalid",
  "remote-cache-key-missing",
  "remote-receipt-invalid",
  "remote-path-invalid",
  "remote-file-missing",
  "remote-metadata-invalid",
  "remote-etag-required",
  "remote-download-too-large",
  "remote-upload-too-large",
  "record-invalid"
]);

export function presentKeePassRemoteError(error: KeePassRemoteManagerError | undefined): KeePassRemoteErrorPresentation | undefined {
  if (!error || error.code === "cancelled") return undefined;
  if (error.code === "remote-rebase-conflict" || error.code === "conflict") {
    return {
      icon: "merge_type",
      title: "字段或结构冲突",
      message: "相同字段或数据库结构在本机和远端都发生了变化，远端文件未被覆盖。",
      action: "retry",
      actionLabel: "重新检查冲突"
    };
  }
  if (error.code === "authentication") {
    return {
      icon: "password",
      title: "WebDAV 身份验证失败",
      message: "服务器拒绝了当前用户名或密码，请重新配置凭据。",
      action: "reconnect",
      actionLabel: "重新配置"
    };
  }
  if (error.code === "permission") {
    return {
      icon: "lock",
      title: "WebDAV 权限不足",
      message: "当前账号缺少读取或写入此 KDBX 文件的权限。",
      action: "reconnect",
      actionLabel: "检查配置"
    };
  }
  if (RECONNECT_CODES.has(error.code)) {
    return {
      icon: "link_off",
      title: "需要重新连接 KeePass",
      message: "本机工作副本、远端基线或解锁凭据不可用，请重新检查 WebDAV 与 KDBX 设置。",
      action: "reconnect",
      actionLabel: "重新连接"
    };
  }
  if (RETRYABLE_CODES.has(error.code) || error.retryable) {
    return {
      icon: "sync_problem",
      title: "远端同步暂时失败",
      message: "网络、服务器或写入确认暂时不可用，本机加密工作副本仍然保留。",
      action: "retry",
      actionLabel: "重试同步"
    };
  }
  return {
    icon: "error",
    title: "KeePass 远端操作失败",
    message: "本机工作副本保持原状，可重试同步或重新检查连接设置。",
    action: "retry",
    actionLabel: "重试同步"
  };
}
