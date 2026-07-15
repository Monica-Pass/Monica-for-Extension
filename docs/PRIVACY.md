# Monica 浏览器插件隐私政策

生效日期：2026-07-15

Monica 浏览器插件是一款独立运行的密码、身份、支付信息和 Passkey 管理工具。插件不依赖 Monica Server WebUI，也不由 Monica-Pass 运营同步服务器。除用户主动配置的 WebDAV 或 Bitwarden 服务外，插件不会把密码库发送给 Monica-Pass 或其他由本项目控制的服务器。

## 处理的数据

插件仅为用户请求的密码管理功能处理以下数据：

- 登录信息：网站地址、标题、用户名、密码、TOTP 密钥和当前验证码。
- 身份与支付信息：姓名、证件号码、地址、银行卡信息和支付账号。
- Passkey：依赖方 ID、用户标识、公钥、私钥和签名计数器。
- Provider 信息：WebDAV 地址、用户名、密码、备份密码；Bitwarden 地址、邮箱、Token、Vault Key、组织密钥和同步修订信息。
- 页面上下文：当前标签页 URL、标题、frame URL，以及表单字段是否存在。插件不建立浏览历史记录。
- 运行诊断：Provider 类型、操作、时间、耗时、结果码、重试次数、冲突/警告计数和经过脱敏的错误摘要。

## 本地存储和保留

- 密码库使用 AES-256-GCM 加密后存入扩展专属 IndexedDB `monica-extension-secure-vault`。Provider 凭据、Token、缓存项目和可导出的 Passkey 私钥都位于该加密信封内。
- 主密码不会保存。派生后的当前解锁密钥只保存在受限为可信扩展上下文的 `chrome.storage.session` 中，并按自动锁定策略清除。
- 主题和配色偏好保存在扩展页面的 `localStorage`，不包含密码库内容。
- 捕获到的新密码/更新候选只在后台内存中保留最多 60 秒，用户拒绝、超时、锁定或后台终止后清除。
- 待处理 Passkey 请求只在后台内存中保留最多 120 秒。
- 本地 Provider 诊断位于加密密码库内；插件不自动上传诊断。
- 卸载扩展会由浏览器删除其扩展存储。用户也可以删除密码库项目、Provider 或整个扩展数据；已同步到第三方服务的数据需在相应服务中另行删除。

## 页面访问与自动填充

插件在 HTTP/HTTPS 页面和 frame 中检测登录、验证码、证件、地址及支付字段，并监听页面提交以提供保存/更新提示。Content Script 不能列出完整密码库，也不能读取 Provider 凭据。Popup 只接收匹配摘要；只有用户点击某个项目后，后台才解密该项目并把本次所需字段发送到用户选择的页面/frame。

敏感数据不会因页面加载或字段检测自动填入。网页脚本最终可以读取已经填入其表单的值，这是自动填充功能的固有结果，因此用户应只在信任的网站上确认填充。

## 用户授权的网络传输

插件不进行广告、分析、遥测或崩溃报告网络传输。以下传输只在用户配置并操作对应 Provider 后发生：

### WebDAV

- 使用用户填写的服务器地址，并通过 HTTPS 或用户明确填写的 HTTP 地址发送 WebDAV 请求。
- 每次请求使用 WebDAV Basic Auth 发送用户名和密码；在 HTTP 地址上使用 Basic Auth 不具备传输加密，强烈建议只使用 HTTPS。
- 插件会列出、下载和上传 `Monica_Backups` 中的 Android 兼容快照。
- 配置“Android 备份加密密码”后，上传内容使用 `MONICA_ENC_V1` 加密；未配置时上传的是普通 ZIP，服务器可读取其中的密码库内容。

### Bitwarden

- 向用户选择的 Bitwarden US、EU 或自托管服务发送邮箱、密码派生的登录凭据、两步验证码、Token 刷新请求以及加密 Cipher 的读取/创建/更新/删除请求。
- Bitwarden 主密码只在本次登录中用于本地密钥派生，不持久化；访问/刷新 Token、Vault Key 和解密后的缓存随后只存入 Monica 的本地加密信封。
- 官方/远程 Bitwarden 地址要求 HTTPS；仅 localhost/127.0.0.1 开发地址允许 HTTP。

Provider 运营方会按其自身隐私政策处理收到的数据。本项目不会出售、出租或为广告目的共享这些数据。

## Passkey 主世界桥接

为兼容 WebAuthn，插件在 HTTP/HTTPS 页面 document-start 阶段运行 MAIN-world 桥接，代理页面的 `navigator.credentials.create/get` 请求，并通过同源 `window.postMessage` 与隔离 Content Script 通信。桥接仅传递当前 Passkey 请求和结果；私钥生成、存储与签名在可信后台完成，私钥不会发送给网页或 Content Script。

## 导出文件

- “导出 JSON”是用户主动下载的明文密码库副本，可能包含密码、TOTP、证件、支付信息和 Passkey 材料。用户必须自行安全保存和删除。
- “导出加密整库备份”保留经过认证的加密信封，需要创建备份时的主密码才能恢复。
- “导出脱敏诊断”只在用户点击后下载到本地；它会移除 URL、邮箱、认证头、Token 和敏感键值，但用户仍应在分享前复核内容。

## 儿童、出售与自动化决策

本插件不是面向儿童的服务，不出售个人数据，不进行跨站广告画像、信用评估或自动化高影响决策。

## 变更与联系

政策变更会随代码版本在本仓库中发布。隐私问题可通过 [GitHub Issues](https://github.com/Monica-Pass/Monica-for-Extension/issues) 提出；安全漏洞请使用仓库的私密安全报告渠道，不要公开披露秘密或漏洞细节。
