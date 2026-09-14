# 自动同步与 Android 兼容

适用版本：正式版 0.1.37（汇总原 0.1.40 本地开发阶段的同步改动）。最后核对：2026-09-14。

## 用户可见行为

“设置与备份 → 自动同步”默认开启，只影响当前浏览器，不写入 Android 的数据库或首页设置。手机把修改上传到双方连接的共同服务器后，插件自动读取，管理页的列表、已打开的详情和 Popup 会刷新。本机编辑保存到加密库后，会合并短时间内的操作并安排上传。

正在编辑的草稿不会被后台刷新覆盖。保存时若同一条目已经变化，保留草稿并提示重新打开最新条目；不会静默覆盖手机的新内容。不同密码源分别调度，最多两个源同时同步，每个源的同步串行执行。失败重试带退避并遵守服务器的 Retry-After，重新联网后可立即恢复普通网络失败的同步。

锁定 Monica 后停止通知连接和自动同步。单独锁定 KeePass 或 MDBX2 数据库时，该源也会暂停，后台重启不会解除这个暂停；用户重新打开数据库后恢复。后台同步与列表刷新不延长无操作锁定时间。关闭自动同步后保留手动同步。

## 四种来源

| 来源 | 手机修改后的接收方式 | 增量边界 |
| --- | --- | --- |
| Bitwarden / 标准 Vaultwarden | 官方 SignalR WebSocket + MessagePack 通知；从认证 API 读取对应 Cipher | 正常单条通知仅下载并解密该 Cipher。首次打开、重连、账户上下文变化或修订补偿仍需 `/sync` |
| MDBX2 + WebDAV | 可见页面每 15 秒、后台约每分钟调用已有云同步协调器 | 沿用 Android 同一 Rust 引擎的不可变分段、检查点和 blob 协议。不是重复上传整个数据库 |
| KDBX + WebDAV | 同一检查周期，先检查远端 ETag | 未变化不下载、不重新投影。变化后传输完整 KDBX，并按原三方合并及 ETag 条件写入处理冲突；不支持网络上的逐条文件增量 |
| Monica Android ZIP / 加密 ZIP 快照 | 检查最新快照名称与 ETag，存在新快照才下载 | 仍是整包备份。手机必须先发布新快照，插件本地修改也写入新快照；不能称为条目增量或 Android 自动恢复 |

手机本地库的全量恢复副本没有共享同步身份。把同一个备份恢复到两端，不会因此自动建立同步；需要两端明确连接同一个 Bitwarden 账户或 WebDAV 数据库位置。

Android `WebDavHelper` 当前普通改动备份默认有 **2 分钟静默期、15 分钟最小上传间隔**。这段时间数据还未到服务器，插件无法提前读取。Bitwarden 本地修改桥接到前台同步控制器或即时 WorkManager；MDBX2、KDBX 也需手机侧完成自己的上传。

15 秒是页面可见时的检查间隔，不是全链路延迟保证。Chrome/Edge 的后台暂停、浏览器关闭、锁库、网络、服务器和手机上传调度都会影响接收时间。最低支持 Chrome 109；Chrome 116 及之后的 WebSocket 心跳可保持通知 worker 活跃，旧版本由每分钟 alarm 兜底唤醒。

## Bitwarden 的实现与恢复

- US 使用 `https://notifications.bitwarden.com/hub`；EU 使用 `https://notifications.bitwarden.eu/hub`；标准自托管使用 `<vault>/notifications/hub`。协议依赖固定为官方使用的 SignalR 10.0.0。
- 通知只用于唤起读取，不直接导入通知载荷。过滤其他用户与本机 context；Cipher 变化通过 `GET /api/ciphers/{id}/details` 验证，删除也先重新 GET，防止乱序删除通知误删已经恢复的条目。
- 增量覆盖在完整远端内存基线上，绝不把局部结果当成全库。保留完整父 Cipher、其他 FIDO2 凭据和未知字段。只有变化的 Cipher 需要重新解密与计算来源指纹。
- 通知可用时每 5 分钟核对账户 revision；通知不可用时约每分钟检查。每 15 分钟强制完整上下文核对；修订不变不下载全库。revision 在完整下载前读取，下载期间的新变更不会被错误确认。
- 首次解锁、worker 重启、重新连接、密钥或服务器变化都重建基线。缓存只在解锁期间存在，最多 4 个账户，每个不超过 20,000 条 Cipher / 16 MiB JSON；超过上限安全退回完整读取。
- 有待写修改或持久回执时先完整读取，继续使用原有加密队列、回执恢复、版本冲突及异常空库保护。单次最多处理 100 项，剩余批次继续安排。
- 新文件夹、组织密钥及其他全库通知会先刷新上下文。单 Cipher 更新后不擅自提高全库 revision 水位；下一次校对仍可能完整读取，这是漏通知恢复的保守边界。

历史非零 Bitwarden Passkey 仍先同步、递增并确认服务器写入后签名；后台同步占用源时等待并支持取消。零计数凭据保留离线路径，只更新本机使用统计。非零计数并发限制及高水位保护见 [Passkey 审查后修补记录](PASSKEY_COUNTER_REVIEW_FOLLOWUP.md)，自动同步不能把服务端的版本容差变成严格 CAS。

## 数据与安全边界

自动同步开关在本机 `chrome.storage.local`，单库暂停在 `chrome.storage.session`。解密缓存仅在 worker 内存；令牌和远端凭据保存在原有加密密码库中。通知库禁用传输日志，避免 WebSocket URL 的 token 被记录。页面端口只广播 `vault-changed`，不广播条目或密钥；发送者限制为扩展自身管理页和 Popup。

后台合并前校验密码源身份，拒绝把旧服务器请求的结果应用到已改配置的新来源。确认删除也不能抹掉读取期间产生的本机编辑。取消、断线、存储失败及冲突继续保留待处理数据；没有以清空队列来换取“同步成功”。

## 核对来源

Bitwarden 固定参考提交：`e40ce6f08ebf963db3561464e77b4defe05247e8`。本轮实际读取该提交的远端官方文件核对协议和 API：

- [SignalR 连接](https://github.com/bitwarden/clients/blob/e40ce6f08ebf963db3561464e77b4defe05247e8/libs/common/src/platform/server-notifications/internal/signalr-connection.service.ts)
- [API service](https://github.com/bitwarden/clients/blob/e40ce6f08ebf963db3561464e77b4defe05247e8/libs/common/src/services/api.service.ts)
- [官方通知分发](https://github.com/bitwarden/clients/blob/e40ce6f08ebf963db3561464e77b4defe05247e8/libs/common/src/platform/server-notifications/internal/default-server-notifications.service.ts)

本地 Android 源码核对：`BitwardenMutationSyncBridge.kt`、`BitwardenSyncWorker.kt`、`Mdbx2RemoteSyncCoordinator.kt`、`RemoteKeePassSyncService.kt`、`KeePassRemoteUploadWorker.kt` 和 `WebDavHelper.kt`。本轮没有修改 Android 生产代码或改变跨端数据格式。

合成数据验证与安装包记录见 [0.1.40 验证](VALIDATION-0.1.40.md)。这些结果不代表已使用真实 Bitwarden 云账户或 Android 真机进行联网验收。
