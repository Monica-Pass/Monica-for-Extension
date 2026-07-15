# Chrome/Edge 商店文案（zh-CN）

## 基本信息

- 名称：`Monica 密码管理器`
- 简短说明：`独立运行的加密密码库，支持显式自动填充、Monica Android WebDAV、Bitwarden 与 Passkey。`
- 类别：生产力工具
- 首发完整界面语言：简体中文（zh-CN）

## 详细说明

Monica 密码管理器是一款独立运行的 Manifest V3 浏览器插件，用于管理登录密码、TOTP、身份、地址、银行卡、支付账号和 Passkey。管理界面复用 Monica WebUI 的本地代码，但不连接或依赖 Monica Server WebUI。

主要功能：

- 使用主密码保护的 AES-256-GCM 本地加密密码库。
- 从工具栏 Popup 选择匹配项后填充用户名、密码、TOTP、证件、地址和支付信息。
- 在登录、注册或修改密码后显示保存/更新提示，由用户确认保存位置。
- 兼容 Monica Android WebDAV 普通/加密备份，并尽量无损保留未知字段和文件。
- 连接 Bitwarden US、EU 或标准自托管服务，支持个人与有权限的组织共享项目。
- 创建和使用浏览器本地 ES256 Passkey，并支持可导出密钥的 Bitwarden FIDO2 凭据。
- 支持加密整库备份、主密码更换、同步冲突处理和用户主动导出的脱敏诊断。

安全边界：

- 完整密码库和 Provider 凭据不会发送给 Content Script。
- 敏感填充必须由用户点击确认，不会在页面加载时自动泄露。
- 解锁密钥只保存在当前浏览器会话的受限扩展存储中，并自动锁定。
- 插件不含广告、遥测或远程代码。

可选网络功能会连接用户选择的服务：WebDAV 使用 Basic Auth；Bitwarden 使用其认证和同步 API。WebDAV 未配置备份密码时上传普通 ZIP，建议使用 HTTPS 并启用 Android 备份加密。详情请阅读隐私政策和权限说明。

## 商店素材清单

- 128×128 插件图标：`public/icons/icon-128.png`；透明安全边距已纳入图标画布。
- 至少 3 张管理页截图：概览、密码源、设置与备份。
- 至少 2 张 Popup/页面交互截图：匹配填充、保存或 Passkey 确认。
- 截图不得包含真实密码、Token、邮箱、服务器地址、证件或支付信息。
- 隐私政策公开 URL：发布后的 `docs/PRIVACY.md` GitHub 页面。
- 支持 URL：`https://github.com/Monica-Pass/Monica-for-Extension/issues`

## 审核备注

广泛的 HTTP/HTTPS 主机权限用于密码管理器在用户访问的网站及跨域 frame 中检测、保存和填充字段，同时允许连接用户配置的 WebDAV/Bitwarden 主机。页面脚本只获得用户明确选择的单项填充载荷；完整密码库始终留在受信任扩展后台。
