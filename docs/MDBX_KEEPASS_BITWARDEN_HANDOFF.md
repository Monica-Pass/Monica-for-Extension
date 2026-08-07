# Monica Extension 交接文档

> 更新时间：2026-08-07 +08:00
>
> 扩展基线：`main == origin/main == 144b575`，其后的 KeePass Android 互操作验收正在最终发布阶段
>
> 仓库：`C:\Users\joyins\Desktop\Monica-all\monica-extension`

## 权威来源与约束

Monica Android 当前基线为 `924324ad11ff77703c29407790c5b713fe2a69f9`，MDBX Core 基线为 `974c517465e7b6cac0947d2d59875aa4211fa16b`。Android 与 MDBX Core 工作区只读，现有未提交内容归用户所有，扩展开发期间禁止修改、清理、暂存或提交这些仓库。

扩展仅使用 `main`，功能组完成验证后提交并推送，不建立额外分支或拉取请求。MDBX1 与 MDBX1-DRAFT永久拒绝，浏览器端从 MDBX2 开始支持。

任务状态以以下 Taskmaster 文件为准：

```text
.codex-tasks/20260802-mdbx2-keepass-bitwarden-parity/SUBTASKS.csv
.codex-tasks/20260802-mdbx2-keepass-bitwarden-parity/PROGRESS.md
.codex-tasks/20260802-mdbx2-keepass-bitwarden-parity/tasks/03-keepass/TODO.csv
```

## 当前状态

| 功能组 | 状态 | 当前证据 |
|---|---|---|
| MDBX2 | 浏览器适用功能完成 | Native Host、本地 vault、Android WebDAV 增量对象、Blob、Commit、Tombstone、冲突、健康修复和真实 Android 往返通过 |
| KeePass | 17/18 | Android Kotpass AES 与 ChaCha20 双向 KDBX 验收通过；等待最终干净发布、提交和推送 |
| Bitwarden | 待实施 | 现有实现需要依据 Android 当前工作区与 Bitwarden 服务端契约重新审查 |
| Windows Hello | 待实施 | 需要在 Provider 功能完成后增加操作系统身份验证边界和密码恢复机制 |
| 共享安全与发布 | 待实施 | 依赖 KeePass、Bitwarden、Windows Hello 完成 |

## MDBX2

扩展采用 Native Messaging 方案。Native Host 保存不透明的本地 MDBX2 工作副本，扩展负责 WebDAV 网络访问；远端格式保持 Android 当前结构：

```text
<vault>.mdbx
<vault>.mdbx.sync/streams/<device>/<generation>/segments/...
<vault>.mdbx.sync/blobs/...
```

初始 `.mdbx` 仅作为可移植启动文件，日常多设备同步使用不可变认证 segment 与加密 Blob，避免按最后修改时间覆盖整个数据库。Host 明确报告 `supportsMdbx1: false`，MDBX1 在打开前被拒绝。

真实验收已经完成 Android UniFFI → WebDAV → 浏览器 Native Host → Android → 重启 Host 的双向交换，并验证启动文件和已有不可变对象保持字节一致。详细架构见 [MDBX2_EXTENSION_ARCHITECTURE.md](./MDBX2_EXTENSION_ARCHITECTURE.md)。

## KeePass

当前实现包含本地文件与 WebDAV KDBX、空密码和密钥文件组合、KDBX3/KDBX4、AES-256 与 ChaCha20、登录与验证码字段、Monica 和 KeePassDX Passkey 字段、未知字段、分组、历史、附件、回收站、持久化操作回执、ETag 三方合并及 KeePass 与 MDBX2 附件复制和移动。

Android 互操作验收由当前 Android Kotpass 生成真实 KDBX4：

```text
Android Kotpass 创建 KDBX
  -> 扩展预检并解锁
  -> 扩展读取项目、历史和附件
  -> 扩展修改共有登录字段并导出
  -> Android Kotpass 重新读取并验证原生结构
```

AES-256 与 ChaCha20 已通过。验收覆盖保护字段、OTP 参数、未知插件字段、数据库/分组/条目 CustomData、时间、历史、附件与二进制池、嵌套分组、未来未知类型以及 Monica 与 KeePassDX Passkey 字段。Android 仓库测试前后状态保持一致。

Twofish 由 Android 生成真实样本后，在扩展外层 KDBX 头部检查阶段以 `cipher-unsupported` 拒绝，并显示转换为 AES-256 的处理方式。`kdbxweb` 当前没有经过审计的 Twofish 实现，因此不能把失败伪装成密码错误。详细记录见 [KEEPASS_ANDROID_INTEROPERABILITY.md](./KEEPASS_ANDROID_INTEROPERABILITY.md)。

## Bitwarden

下一功能组需要重新审查 Android 当前工作区。Android 现有未提交内容包含 `BitwardenSyncService.kt`、`CipherSyncProcessor.kt`、`BitwardenPasswordCustomFieldAdapter.kt` 与 `BitwardenPasswordCustomFieldSyncState.kt`，这些文件只读但属于当前规范来源。

验收范围包括身份验证与令牌刷新、个人库和组织库、文件夹与集合、登录、笔记、卡片、身份、附件、Passkey、回收站、空库保护、冲突与增量同步。Bitwarden 服务端契约在 Android 注释与实际接口不一致时优先。

## Windows Hello

Windows Hello 需要作为本机解锁能力释放前的身份验证边界，取消、超时、不可用硬件和 Native Host 异常均应保持锁定。系统验证不能替代静态数据加密，主密码恢复方式必须持续可用。

适合当前 MV3 架构的实现是由受固定版本和安装清单保护的 Native Host 调用 Windows WebAuthn 或系统凭据接口，返回一次性、短时、绑定当前 vault 会话的成功证明。Popup、内容脚本和普通网页不能调用该能力，也不能获得操作系统密钥材料。

## 安全与界面约束

KDBX、MDBX2 数据库、附件明文、Provider 凭据、来源记录、同步 bundle、Blob 和 Passkey 私钥仅存在于后台或 Native Host 授权范围。Popup 与内容脚本只能获得候选摘要以及用户明确选择后的最少字段。

M3E 页面禁止渐变，卡片和输入框使用 8px 圆角，对话框使用 16px 圆角，图标使用 20px 或 24px，交互区域至少 44px。管理页、Popup、对话框需要覆盖明暗主题、375px、200% 字体、减少动画和无横向溢出。

## 下一步

1. 完成 KeePass 第 18 项：运行完整 Windows 发布门禁，从干净提交生成并重复验证扩展与 Native Host 包，然后推送 `main`。
2. 审查 Android 当前 Bitwarden 修改和扩展现有实现，更新功能矩阵并实施缺失能力。
3. 完成 Bitwarden 后实施 Windows Hello 解锁验证。
4. 执行共享安全、M3E、迁移、MV3 生命周期和可重复发布检查。
