# Monica for Extension 0.1.37 Preview

## 中文

本版是供公开试用和反馈问题的预览版，接续 0.1.36。包含此前本地开发的界面、密码项目、自动填充与同步改进；跨端对齐仍在进行，不代表全部后端、网站和 Android 流程已经验证。

- 管理页、工具栏与窄屏布局统一为 Material 3 Expressive，支持八种离线语言。
- 密码项目支持多个凭据组、共享账号与 OTP、排序、更多 Android 扩展字段、附件和项目操作。新增密码历史界面与可用后端的历史映射。
- 改进密码、OTP、自定义字段自动填充，以及 Passkey 注册、选择、用户验证、密钥格式兼容和同步后的使用流程。
- 改进 MDBX、KDBX、WebDAV 和 Bitwarden 的字段保留、同步队列、删除恢复及冲突处理。远端 KDBX 项目冲突可以逐项目选择版本，并导出独立密码加密的恢复文件。
- Windows 本机助手更新到 0.1.2。管理页不再等待 Windows Hello 能力查询完成才显示密码库。
- 更新 Vue 与 source-map-js，修复发布前依赖审计发现的问题。

**已知边界**：部分新增界面与自动化回归尚未收尾；极窄屏 200% 字号的部分 OTP 内容可能显示不完整，新增字段的翻译也仍在补全。直接 OneDrive 登录界面已接入，但真实 Microsoft 账号登录、刷新和完整 Android 往返尚未验收，可能还需要注册对应扩展 ID 的回调。MDBX / KDBX 的本机密码历史尚不能完整同步到新客户端；需要保留该历史时使用 Monica ZIP 备份。Android 导入凭据的备份标志、外部正计数 Passkey、部分项目生命周期与自动填充网站组合仍待扩大验证。不要把本预览版的可用路径理解为全部跨端能力均已完成。

下载 `monica-extension-0.1.37.zip`，解压后在 Edge / Chrome 的扩展管理页启用开发者模式并加载解压目录。MDBX 与 Windows Hello 相关能力另需 `monica-mdbx2-host-windows-x64-0.1.2.zip`，按包内 README 安装。每个 ZIP 均附 SHA-256。

升级前保留可用备份。已有开发者模式安装请更新原加载目录并点击“重新加载”，不要为升级移除原扩展；不同扩展身份不会自动共享浏览器中的本地密码库。本次发布为 GitHub 下载包，不代表 Chrome / Edge 商店已更新。

[反馈 Bug](https://github.com/Monica-Pass/Monica-for-Extension/issues/new?template=bug.yml)：请提供插件/助手版本、浏览器与系统、密码源、涉及的 Android 版本、复现步骤及预期/实际结果。使用虚构数据复现，勿上传真实密码、私钥或密码库。安全问题按 [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md) 私下报告。

## English

This public preview follows 0.1.36 and makes the accumulated UI, password-project, autofill, and synchronization work available for testing. Android parity is still in progress; this release does not claim verification of every backend, site, or Android workflow.

- Material 3 Expressive manager, toolbar, and narrow layouts with eight offline languages.
- Multi-credential password projects, shared account and OTP fields, ordering, richer Android fields, attachments, project operations, and password-history support on compatible backends.
- Improvements to password, OTP, and custom-field autofill, plus Passkey registration, selection, user verification, key compatibility, and use after synchronization.
- Better field preservation, queued synchronization, deletion recovery, and conflicts for MDBX, KDBX, WebDAV, and Bitwarden. Remote KDBX project conflicts support explicit version choices and separately password-encrypted recovery exports.
- Windows native helper 0.1.2. Native Windows Hello status discovery no longer blocks the vault interface.
- Updated Vue and source-map-js to address dependency audit findings.

**Known limits:** some new UI flows and automated regressions remain unfinished. At very narrow widths with 200% text, some OTP content may not fit; translations for new fields are also incomplete. direct OneDrive sign-in is implemented but real Microsoft sign-in, refresh, and complete Android roundtrips are not accepted yet; the extension-specific redirect may require registration. Local MDBX/KDBX password-history overlays do not fully synchronize to fresh clients; use Monica ZIP backup when this history must be retained. Imported Android Passkey backup flags, external positive-counter credentials, some project lifecycles, and broader site autofill coverage remain under verification.

Extract `monica-extension-0.1.37.zip` and load it from the Edge/Chrome extensions page in developer mode. MDBX and Windows Hello features require the separately supplied `monica-mdbx2-host-windows-x64-0.1.2.zip`; follow its README. SHA-256 files accompany both archives.

Keep a usable backup before upgrading. For an existing unpacked installation, update its original directory and reload the same extension rather than removing it. Different extension identities do not share browser-local vault data automatically. This is a GitHub download release, not a Chrome/Edge store update.

[Report a bug](https://github.com/Monica-Pass/Monica-for-Extension/issues/new?template=bug.yml) with extension/helper versions, browser/OS, backend, Android version when relevant, and reproduction steps. Use synthetic data; never attach real passwords, keys, or vaults. Report security issues privately as described in [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md).
