# Monica for Extension 1.0.104

2026-11-04 · 标签 / Tag: `v1.0.104` · Windows x64 可选助手 / Optional helper: `0.1.6`

## 中文

### 更新内容

- 修复 Bitwarden 同一记录的 TOTP 在验证码页重复显示两次：列表和数量只计一次，保留原登录项、验证码数据、编辑和填充能力；不同来源或参数不同的验证器仍分别显示。
- 完善插件内更新流程：检查后可直接下载有效的官方新版 ZIP，显示构建标识和扩展 ID，提供原目录覆盖步骤、扩展管理页入口和确认后重新加载。更新仍需手动替换文件，并非全自动安装。仅提供更高正式版本的直接 ZIP 下载，避免同版本开发版被较旧代码覆盖。
- 在“设置与备份 → 解锁与保护”中自定义自动锁定时间，支持 1～1440 分钟，默认 15 分钟。保存后立即更新当前会话时限；设置随密码库加密保留。时间按密码库内的有效操作计算，普通网页活动不会延长解锁时间。
- 对齐 Android 1.0.324 的附近同步协议：已配对设备可协商增量记录、独立补传缺失附件与加密断点续传；旧端保留完整加密传输。接收删除先审阅，重连重新认证，实际保存后才确认成功。使用这些能力需同步更新可选 Windows 助手至 0.1.6。
- 支持粘贴 Android 热点邀请，并显示系统手动连接步骤；临时凭据在取消、锁定、离开页面或超时后清除。普通 MDBX 继续使用内置浏览器引擎。
- 整理后台同步、附件传输和 Bitwarden Send 的模块职责，统一内部请求授权和互斥执行，补齐取消、重试和会话失效回归。合入社区贡献的 ESLint 10 检查及源码安全规则，作为发布检查的一部分。
- 更新流程补齐全部八种界面语言，并改善窄屏、大字号下的长文本和按钮换行。

### 安装与更新

下载 `monica-extension-1.0.104.zip`，解压至固定目录，在 Chrome/Edge 扩展管理页开启开发者模式并加载包含 `manifest.json` 的目录。

已有安装请完整覆盖浏览器当前加载的原目录，不要额外套一层文件夹，也不要先卸载扩展或清除浏览器数据。保存未完成的编辑后重新加载扩展，再刷新已打开的网页。仅覆盖磁盘文件可能仍保留运行中的旧后台。

重新加载后需要用原 **Monica 主密码**解锁，这与重新登录 **Bitwarden 账号**不同。隔离测试中原密码库密文和 Bitwarden 连接配置均保留；服务端凭据失效仍可能要求认证，原反馈账号反复登录的具体原因尚未确认。

Wi-Fi 同步等本机能力使用**可选** Windows x64 助手 `monica-mdbx2-host-windows-x64-0.1.6.zip`，安装方法见包内 README。普通 MDBX 的新建、导入、读取、编辑和保存无需外部组件；旧 Native Host 工作副本保留原后端。每个 ZIP 均附带 SHA-256 校验文件。

支持 Chrome/Edge 128+。Firefox 未签名构建保留在 CI artifact，永久安装需 Mozilla 签名，详见 [Firefox 说明](https://github.com/Monica-Pass/Monica-for-Extension/blob/v1.0.104/docs/FIREFOX.md)。本次公开附件不含未签名 XPI。

现有 Rust ZIP 依赖告警尚未通过升级消除；当前调用未使用相关的 AES 解密、通用解压或流式解压路径，具体适用范围见 [ZIP 依赖审查](https://github.com/Monica-Pass/Monica-for-Extension/blob/v1.0.104/docs/verification/zip-advisory-scope-20261104.md)。

### 维护说明

目前我的主要开发精力仍放在 **Android 版**，浏览器插件的维护与功能跟进可能有所延迟。欢迎大家通过 [Issue](https://github.com/Monica-Pass/Monica-for-Extension/issues) 反馈问题、提出建议，也欢迎提交 [PR](https://github.com/Monica-Pass/Monica-for-Extension/pulls) 一起改进。感谢大家的理解和参与！

## English

### Changes

- Fixed duplicate TOTP tiles and counts for the same Bitwarden record, preserving login items, OTP data, editing and autofill. Authenticators from different sources or with different parameters remain separate.
- Improved the update page with direct downloads for valid official newer-version ZIPs, build and extension IDs, original-directory replacement instructions, an extension-management shortcut and reload confirmation. File replacement remains manual; this is not automatic installation. Direct downloads require a higher stable version to avoid replacing a same-version development build with older code.
- Customize the automatic lock time in Settings and backups → Unlock and protection, from 1 to 1440 minutes (default: 15). Saving updates the active session deadline immediately, and the setting remains encrypted with the vault. The timer follows valid vault activity; ordinary website browsing does not extend it.
- Aligned nearby synchronization with Android 1.0.324: paired devices can negotiate incremental records, transfer missing attachments separately and resume encrypted transfers. Older peers retain full encrypted transfer. Incoming deletions require review, reconnects authenticate again, and success is acknowledged after changes are applied. Update the optional Windows helper to 0.1.6 to use these capabilities.
- Android hotspot invitations show manual system connection instructions. Temporary credentials clear on cancellation, locking, leaving the page or expiry. Ordinary MDBX operations continue to use the bundled browser engine.
- Refactored background synchronization, attachment transfer and Bitwarden Send responsibilities; unified internal request authorization and exclusive execution, with cancellation, retry and stale-session regressions. Integrated the community-contributed ESLint 10 checks and source security rules into release validation.
- Translated the update flow into all eight supported interface languages and improved long-text and button wrapping on narrow screens with large fonts.

### Installation and updates

Extract `monica-extension-1.0.104.zip` to a permanent directory and load the folder containing `manifest.json` in Chrome/Edge developer mode.

For an existing installation, replace all files in the directory currently loaded by the browser without adding an extra nesting level. Keep the extension installed and preserve browser data. Save unfinished edits, reload the extension and refresh open websites. Replacing disk files alone can leave the old background code running.

Reloading requires unlocking with the existing **Monica master password**, which is separate from signing into a **Bitwarden account**. Isolated tests preserved the original encrypted vault and Bitwarden connection settings; expired server credentials can still require authentication. The cause of the reporter's repeated Bitwarden login remains unconfirmed.

Wi-Fi synchronization and other native capabilities use the **optional** Windows x64 helper `monica-mdbx2-host-windows-x64-0.1.6.zip`; follow its included README. Ordinary MDBX creation, import, reads, editing and saves require no external component. Existing Native Host working copies retain their backend. Each ZIP has a SHA-256 sidecar.

Chrome/Edge 128+ are supported. The unsigned Firefox build remains a CI artifact; permanent installation requires Mozilla signing. See [Firefox instructions](https://github.com/Monica-Pass/Monica-for-Extension/blob/v1.0.104/docs/FIREFOX.md). No unsigned XPI is attached to this release.

Existing Rust ZIP dependency advisories remain open. Current callers do not use the affected AES decryption, general-purpose extraction or streaming extraction paths. See the [ZIP applicability review](https://github.com/Monica-Pass/Monica-for-Extension/blob/v1.0.104/docs/verification/zip-advisory-scope-20261104.md) for the scope and limits of that assessment.

### Maintenance note

My main development focus is still the **Android version**, so maintenance and feature updates for the browser extension may take longer. Please report bugs and suggestions through [Issues](https://github.com/Monica-Pass/Monica-for-Extension/issues), and [PRs](https://github.com/Monica-Pass/Monica-for-Extension/pulls) are welcome. Thank you for your understanding and contributions!
