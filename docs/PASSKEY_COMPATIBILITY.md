# Passkey 跨客户端策略

正式版 0.1.37 按项目的真实 `providerRefs` 与密码源类型选择策略。`sourceMode` 表达私钥来源，不能证明当前存在同步关系。本版包含 2026-09-14 独立审查后的历史回退保护；此前标为 0.1.39 的本地开发包没有包含该保护，其文档保留为阶段验证记录。

正常的 Monica 自建零计数凭据继续沿用已有签名行为、离线能力和 BE/BS，不因为历史凭据问题而统一递增、强制联网或要求重新注册。

| 来源 | 签名计数 | 数据与统计 |
| --- | --- | --- |
| 本地／全量恢复后的独立副本 | 使用 0，不自行推进导入的旧计数 | 手动导入创建新的本地项目 ID，清除旧数据库与远端绑定；凭据 ID、私钥和明确的 BE/BS 标志保持不变。无私钥仅显示引用 |
| WebDAV 文件数据库：MDBX2／KDBX | 使用 0，不通过文件同步争抢计数 | 原数据库对象 ID、KDBX entry UUID、私钥及未知字段继续保留。使用次数／时间只在本机更新，不创建 MDBX2 commit、不写 KDBX 历史、不触发整库上传 |
| Bitwarden | 没有已知正数历史的 0 保持 0；历史正数先刷新，再 +1，确认服务器提交后签名；已知回退停止签名 | 写入标准 `login.fido2Credentials[].counter`，保留父登录与同组其他凭据。零计数使用只更新本机统计 |

旧 MDBX1 密码源仍明确停用，需要先由 Android／桌面端升级至 MDBX2；本版不新增 MDBX1 写入支持。`monica-webdav` 的 ZIP／加密 ZIP 是 Android 全量快照格式，不是 Android 活跃数据库的实时同步，因此也采用独立副本的签名策略。插件自己的加密整库备份原本就包含密码源设置，恢复时仍保留这些明确配置的同步关系；不会把整个保险库的密码源设置无条件删除。

## 为什么不能把非零计数固定住

WebAuthn 对从注册起始终为 0 的凭据表示“不实现签名计数”。但若网站已保存 5，下次再收到 5 或 0，检查计数的网站仍可能拒绝。客户端无法重置网站的记录。需要迁移为零计数的旧凭据，应在该网站重新注册；仅复制密钥、改本机数字或设置 BE/BS 都不是可靠的迁移。

Bitwarden 的官方来源固定在提交 [`e40ce6f08ebf963db3561464e77b4defe05247e8`](https://github.com/bitwarden/clients/blob/e40ce6f08ebf963db3561464e77b4defe05247e8/libs/common/src/platform/services/fido2/fido2-authenticator.service.ts)：

- 258–267 行：没有候选或候选包含正计数时 `fullSync(false)` 后重新查找。
- 319–332 行：正计数递增并 `updateWithServer`；零计数不因此上传 Cipher。
- 503 行：新建凭据计数为 0。

扩展对历史正计数写入附带 `lastKnownRevisionDate`，使用现有加密同步回执确认写入。服务器拒绝、版本冲突、响应丢失、锁定、取消或页面变更时不会交付未确认签名。只处理所选 Cipher 的待同步修改；其他项目继续保留在队列。网络失败后可能留下一个待恢复的计数更新，下一次先核对远端结果；允许跳过一个已提交计数，不重复返回旧结果。

当前源码在加密本地库中保存 `signCountHighWaterMark`，保留同一凭据已观察到的最高计数。自己的待提交 +1 与已观察值分开记录；成功确认后再推进历史。首次下载、后续合并、编辑、同 ID 导入、冲突选择远端和重新解锁均保留这段历史。该字段不进入 Bitwarden Cipher，也不参与 MDBX2/KDBX 的内容指纹。

冲突或待处理编辑中观察到的更大远端计数同样会保存；之后“保留本地版本”不能回写旧计数。后台零计数快捷入口和交付网页前也检查历史，避免仅在同步函数中保护而被其他入口绕过。修补与验证详见 [审查后记录](PASSKEY_COUNTER_REVIEW_FOLLOWUP.md)。

若本机已知 8，而远端返回 0 或 2，同步保留历史、记录冲突，并阻止该 Cipher 的待写入修改；认证不签出 0 或 3。采用远端版本可以采用其内容，但不能抹掉计数历史、把旧凭据伪装成原生零计数。远端恢复到不低于已知历史后可继续同步。明确删除旧凭据的操作不受计数推进保护阻拦。历史记录只覆盖本机实际保留的证据，无法找回在安装前或其他客户端上已被擦除的历史。

另外核对了官方 server 固定提交 [`6ba6612fbd83a9bb1004a830062501346af2a57d`](https://github.com/bitwarden/server/blob/6ba6612fbd83a9bb1004a830062501346af2a57d/src/Core/Vault/Services/Implementations/CipherService.cs#L900-L912)：`lastKnownRevisionDate` 的检查允许 1 秒时间差，并不是严格的旧版本等值比较。模拟这一容差时，两个设备可以都确认写入并签出相同的 6；严格比较的对照模型才会拒绝其中一个请求。成功 PUT 不证明已经取得全局唯一计数。该固定版本也不代表所有 Bitwarden/Vaultwarden 部署。

即便存储层提供严格原子比较，也无法保证两个设备的 assertion 按生成顺序到达网站。新凭据保持零计数是默认路径；历史正计数遵守官方分支，不承诺彻底消除跨设备计数异常。本地／独立快照／文件库对旧正计数当前仍签 0，这项策略不能重置网站记录，不能据此宣称所有旧导入凭据都兼容。

## Android 实际实现与边界

本地 Android 源码中的 `PasskeyOwnership.kt` 也按 KeePass、MDBX、Bitwarden 真实绑定区分归属。`PasskeyBackupPortabilityPolicy.kt` 仅允许通过加密全量备份导出便携密钥，恢复为 `NONE` 或 `REFERENCE`；`WebDavHelper.restorePasskeyFromJson()` 不恢复旧 Bitwarden／数据库绑定。

独立审查时，`PasskeyAuthActivity.kt` 全局输出并通过 DAO 存储 0，包括历史非零的 Bitwarden 项目；该 DAO 调用本身不会把 SYNCED 项目排队上传。原先已在 PENDING/FAILED 队列中，或之后又编辑而入队的项目，才可能通过 `PasskeyMapper.kt` 将本地的 0 写回远端。因此不能说“每次登录立即把远端清零”，也不能宣称 Android 旧凭据已经遵循官方历史分支。本轮没有修改 Android 生产代码。

BE 是注册时的协议属性，BS 表示备份状态。插件保留明确标志，并继续保持现有正常 Monica 凭据的默认行为；这不等于外部凭据的未知标志已经得到验证。Android 当前未单独建模协议 BE/BS，经过 Android JSON codec 往返时，未建模的字段不保证保留。BE=false 的外部凭据仍需专项互操作验证。

Android 真机 Credential Manager、真实网站账户、真实 Bitwarden/Vaultwarden 并发及 BE/BS 跨 Android 往返不包含在本轮合成测试中。

本机统计不作为跨设备累计总数。它们不会触发上传；用户真正编辑或导出项目时，原有可移植字段和历史统计仍可随内容保留。详情见 [0.1.39 验证记录](VALIDATION-0.1.39.md)。
