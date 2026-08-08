# Monica Extension 交接文档

> 更新时间：2026-08-09 +08:00
>
> 仓库：`C:\Users\joyins\Desktop\Monica-all\monica-extension`

## 权威来源与约束

Monica Android 基线为 `150618b8231dd9e9e9ab342b90ed66b106e672c0`，MDBX Core 基线为 `974c517465e7b6cac0947d2d59875aa4211fa16b`。Android 与 MDBX Core 工作区保持只读。扩展仅使用 `main`，功能组验证后提交并推送，不建立额外分支或拉取请求。MDBX1 与 MDBX1-DRAFT 始终在打开前拒绝。

当前完成审计记录位于：

```text
.codex-tasks/20260809-full-objective-completion-audit/SPEC.md
.codex-tasks/20260809-full-objective-completion-audit/TODO.csv
.codex-tasks/20260809-full-objective-completion-audit/PROGRESS.md
```

## 当前状态

| 功能组 | 状态 | 当前证据 |
| --- | --- | --- |
| MDBX2 | 浏览器适用功能完成 | Android WebDAV 真实往返、19 个远端对象、双向安全项目附件、Commit、Tombstone、冲突、快照、历史、Collection、健康修复和 Host 重启通过 |
| KeePass | 浏览器适用功能完成 | Android Kotpass AES-256 与 ChaCha20 双向 KDBX、管理照片、普通附件、历史、分组、Passkey 和未知结构保留通过；Twofish 明确拒绝 |
| Bitwarden | 浏览器适用功能完成 | 官方 Bitwarden 与 Vaultwarden 合同覆盖个人库、组织库、Collection、附件、Passkey、文件夹、Send、SSH、归档、回收站和未知 Cipher 保留 |
| Windows Hello | 实现完成，真实硬件验收待可用设备 | 正常解锁先完成 Windows 验证，再读取设备密钥；Native 与加密绑定不一致时保持锁定；默认探针无系统弹窗 |
| 共享安全与发布 | 当前门禁通过 | Popup 和内容脚本隔离、M3E 响应式检查、安全审计、供应链检查和可重复打包均纳入发布命令 |

## MDBX2

扩展采用 Native Messaging 方案。Native Host 保存不透明的本地 MDBX2 工作副本，扩展负责 WebDAV 网络访问；远端结构保持 Android 当前格式：

```text
<vault>.mdbx
<vault>.mdbx.sync/streams/<device>/<generation>/segments/...
<vault>.mdbx.sync/blobs/...
```

初始 `.mdbx` 用于新设备加入，日常多设备同步使用不可变认证 segment 与加密 Blob。真实验收覆盖 Android UniFFI 创建、WebDAV 发布、浏览器 Host 应用和修改、Android 再读取、Host 重启恢复以及既有远端对象保护。`supportsMdbx1` 固定为 `false`。

## KeePass

实现包含本地文件与 WebDAV KDBX、空密码和密钥文件、KDBX3/KDBX4、AES-256、ChaCha20、登录与验证码字段、Monica 和 KeePassDX Passkey、未知字段、分组、历史、附件、回收站、持久化操作回执、ETag 三方合并及跨密码源附件复制和移动。

当前 Android Kotpass 真实夹具验证以下往返：

```text
Android 创建 KDBX
  -> 扩展预检、解锁和读取
  -> 扩展修改共有字段、照片和普通附件
  -> 扩展导出
  -> Android 重新读取并验证原生结构
```

AES-256 与 ChaCha20 通过。保护字段、OTP 参数、未知字段、CustomData、时间、历史、附件与二进制池、银行卡和证件正反面照片、嵌套分组、未来类型及 Passkey 字段保持。Twofish 在解密前返回 `cipher-unsupported`，避免伪装成密码错误。

## Bitwarden

官方 Bitwarden 与 Vaultwarden 状态化合同夹具覆盖预登录、登录、令牌、个人与组织 Cipher、文件夹、Collection 权限、登录、笔记、卡片、身份、SSH、Send、附件、Passkey、归档、回收站、空库确认、冲突和持久化恢复。

官方配置验证 Azure 附件传输和 PascalCase 完整响应；Vaultwarden 配置验证 Direct 附件传输、camelCase `OrganizationsNew` 和精简修改响应。签名对象请求不得携带 Bitwarden Bearer 令牌，下载内容需要完成认证和逐字节校验后才交给管理页。

## Windows Hello

Windows Hello 由固定清单和精确扩展来源约束的 Native Host 调用 Windows WebAuthn 平台验证器。注册和验证使用当前前台窗口作为系统模态界面的父窗口。Popup、内容脚本和网页无法调用注册、验证或撤销，也无法获得凭据 ID、断言、签名、设备密钥或私钥。

设备密钥信封保存一个经过格式校验的不透明绑定提示。正常解锁顺序为：

```text
读取绑定提示
  -> Native Host 要求 Windows Hello 验证
  -> 验证成功后读取设备密钥
  -> 解密 VaultState
  -> 复核加密绑定与提示一致
  -> 创建受自动锁定约束的浏览器会话
```

取消、超时、平台验证器不可用、Host 缺失、记录损坏以及绑定不一致均保持锁定。设备密钥模式不保存主密码，因此恢复方式是预先导出的加密整库备份。锁定页支持使用备份密码替换恢复，并清除恢复数据中的不可迁移 Hello 绑定。

默认验收不会打开系统弹窗：

```powershell
npm run test:windows-hello
```

真实硬件注册、验证和撤销需要明确设置确认短语：

```powershell
$env:MONICA_WINDOWS_HELLO_HARDWARE_ACCEPT='I_ACCEPT_WINDOWS_HELLO_PROMPTS'
npm run test:windows-hello:hardware
```

当前机器返回 `supported=true`、`available=false`，因此真实 PIN 或生物识别验收仍等待具备可用平台验证器的 Windows 用户环境。

## 安全与界面约束

KDBX、MDBX2 数据库、附件明文、密码源凭据、来源记录、同步 bundle、Blob 和 Passkey 私钥仅存在于后台或 Native Host 授权范围。Popup 与内容脚本只能获得候选摘要以及明确选择后的最少字段。

M3E 页面禁止渐变，卡片和输入框使用 8px 圆角，对话框使用 16px 圆角，图标使用 20px 或 24px，交互区域至少 44px。管理页、Popup 和对话框覆盖明暗主题、375px、200% 字体、减少动画和无横向溢出。

## 后续验收

1. 在启用 Windows Hello PIN 或生物识别的平台运行显式硬件命令，记录注册、取消、验证和撤销结果。
2. Android 或 MDBX Core 修订发生变化时重新执行三类互操作测试并更新兼容性审计。
3. 每次发布从干净 `main` 运行 `npm run release:windows`，重新记录两个 ZIP 的 SHA-256。
