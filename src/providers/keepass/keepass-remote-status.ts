import { tr } from "../../i18n";
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

export function presentKeePassRemoteError(error: KeePassRemoteManagerError | undefined, sourceMode?: unknown): KeePassRemoteErrorPresentation | undefined {
  if (!error || error.code === "cancelled") return undefined;
  if (error.code === "remote-rebase-conflict" || error.code === "conflict") {
    return {
      icon: "merge_type",
      title: tr('字段或结构冲突'),
      message: tr('相同字段或数据库结构在本机和远端都发生了变化，远端文件未被覆盖。'),
      action: "retry",
      actionLabel: tr('重新检查冲突')
    };
  }
  if (error.code === "authentication") {
    return {
      icon: "password",
      title: sourceMode === 'onedrive' ? tr('OneDrive 登录已过期') : tr('WebDAV 身份验证失败'),
      message: sourceMode === 'onedrive' ? tr('请使用原 Microsoft 账号重新登录，本机未同步修改会保留。') : tr('服务器拒绝了当前用户名或密码，请重新配置凭据。'),
      action: "reconnect",
      actionLabel: sourceMode === 'onedrive' ? tr('重新登录') : tr('重新配置')
    };
  }
  if (error.code === "permission") {
    return {
      icon: "lock",
      title: sourceMode === 'onedrive' ? tr('OneDrive 权限不足') : tr('WebDAV 权限不足'),
      message: tr('当前账号缺少读取或写入此 KDBX 文件的权限。'),
      action: "reconnect",
      actionLabel: tr('检查配置')
    };
  }
  if (RECONNECT_CODES.has(error.code)) {
    return {
      icon: "link_off",
      title: tr('需要重新连接 KeePass'),
      message: sourceMode === 'onedrive' ? tr('请检查 OneDrive 账号、所选文件和数据库密码。本机修改会保留。') : tr('本机工作副本、远端基线或解锁凭据不可用，请重新检查 WebDAV 与 KDBX 设置。'),
      action: "reconnect",
      actionLabel: tr('重新连接')
    };
  }
  if (RETRYABLE_CODES.has(error.code) || error.retryable) {
    return {
      icon: "sync_problem",
      title: tr('远端同步暂时失败'),
      message: tr('网络、服务器或写入确认暂时不可用，本机加密工作副本仍然保留。'),
      action: "retry",
      actionLabel: tr('重试同步')
    };
  }
  return {
    icon: "error",
    title: tr('KeePass 远端操作失败'),
    message: tr('本机工作副本保持原状，可重试同步或重新检查连接设置。'),
    action: "retry",
    actionLabel: tr('重试同步')
  };
}
