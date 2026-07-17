# 浏览器权限说明

Monica 的单一用途是安全管理并按用户明确操作保存、同步和填充密码、身份、支付信息与 Passkey。以下权限均服务于该用途。

| 权限 | 使用目的 | 不会做什么 |
| --- | --- | --- |
| `webNavigation` | 枚举当前标签页的主页面和跨域 frame，使用户能选择正确的登录/支付 frame，并在后台重新核验 frame URL。 | 不跟踪用户跨站导航轨迹。 |
| `storage` | 使用 `chrome.storage.session` 临时保存解锁会话密钥；读取并删除旧原型的 `chrome.storage.local` 数据以完成一次性安全迁移。 | 不使用同步存储上传密码库。 |
| `alarms` | 每分钟检查解锁会话是否到期，并在锁定后清除待保存密码、Passkey 请求及 Provider 同步。 | 不用于后台遥测或定时上传。 |
| `cookies` | 仅在用户明确刷新或处理 Steam 登录/交易确认时，临时设置 Steam Mobile Confirmation 所需 Cookie；请求结束后恢复用户原有 Cookie。 | 不读取、上传或修改其他网站 Cookie，也不会长期保留 Steam 会话 Cookie。 |

## 主机权限

| 权限 | 使用目的 |
| --- | --- |
| `http://*/*` | 在用户访问的 HTTP 网页/frame 中检测字段、显示保存/Passkey 确认 UI，并支持用户明确配置的 HTTP WebDAV 或本地 Bitwarden 开发服务。HTTP 不提供传输机密性，不建议用于真实凭据。 |
| `https://*/*` | 在 HTTPS 网页/frame 中检测和填充字段，并连接用户选择的 WebDAV、Bitwarden US/EU 或自托管服务。 |

广泛的 HTTP/HTTPS 主机范围是密码管理器跨网站工作的必要条件。插件不会因为拥有主机权限就把完整密码库注入网页；Content Script 只能扫描字段、提交候选并接收用户单次选择后的填充载荷。

Popup 与后台会使用 `chrome.tabs.query/get/sendMessage` 访问当前 HTTP/HTTPS tab，但这些 API 调用本身不要求 `tabs` 权限；匹配的主机权限已提供当前页面 URL/标题访问。因此 Manifest 不申请冗余的 `tabs` 或 `activeTab` 权限。

## Manifest V3 脚本

- 隔离世界 `content.js` 在所有 HTTP/HTTPS frame 中扫描字段、执行明确填充以及显示保存/Passkey 确认 UI。
- MAIN world `main-world.js` 在 document-start 安装 WebAuthn/开放 ShadowRoot 桥接。它不包含密码库、Provider 凭据或 Passkey 私钥。
- 唯一的 web-accessible resource 是 `icons/logo-256.png`，只用于网页内 Monica 保存提示显示品牌图；它不包含代码或用户数据。
- 所有运行时代码随扩展打包；Content Security Policy 禁止远程脚本和任意对象加载。

更详细的数据流见 [隐私政策](PRIVACY.md) 和 [架构说明](ARCHITECTURE.md)。
