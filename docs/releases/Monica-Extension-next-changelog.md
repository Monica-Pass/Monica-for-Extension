# Monica Extension 下一版 / Next release

> 未发布 / Unreleased；版本号待定 / Version pending

## 中文

- 在“设置与备份 → 解锁与保护”中自定义自动锁定时间，支持 1～1440 分钟，默认 15 分钟。保存后立即更新当前会话时限；设置随密码库加密保留，锁定或重启后仍生效。
- 整理后台同步、附件传输与 Bitwarden Send 的模块职责，将任务状态、上传会话和清理逻辑集中管理，便于后续维护。
- 统一外部请求与内部附件写入的授权和互斥执行，补齐命令覆盖审计及取消、重试和会话失效回归。保持现有加密格式、登录和数据库后端选择。
- 对齐 Android 1.0.324 的附近同步协议：已配对设备可协商增量记录、独立补传缺失附件与加密断点续传，旧端保留完整加密传输。接收删除先审阅，重连重新认证，实际保存后才确认成功。
- 支持粘贴 Android 热点邀请，并显示系统手动连接步骤；临时凭据在取消、锁定、离开页面或超时后清除。Wi-Fi 同步仍使用可选本机通信组件，浏览器 MDBX 引擎保持内置。

## English

- Customize the automatic lock time in Settings and backups → Unlock and protection, from 1 to 1440 minutes (default: 15). Saving updates the active session deadline immediately; the setting stays encrypted with the vault and survives locking or restarting.
- Refactored background synchronization, attachment transfer and Bitwarden Send into modules that own their task state, upload sessions and cleanup.
- Unified authorization and exclusive execution for external requests and internal attachment writes; strengthened command coverage auditing and cancellation, retry and stale-session regressions. Existing encryption formats, login behavior and database backend selection remain unchanged.
- Aligned nearby synchronization with Android 1.0.324: paired devices can negotiate incremental records, independently missing attachments and encrypted resume while older peers retain full encrypted transfer. Incoming deletions require review, reconnects authenticate again, and successful receipts follow actual application.
- Android hotspot invitations now show manual system connection instructions. Temporary credentials clear on cancellation, lock, leaving the page or expiry. Wi-Fi synchronization still uses the optional native helper; the browser MDBX engine remains built in.
