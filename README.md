# Monica for Extension

Monica 的 Chrome/Edge Manifest V3 浏览器插件。管理界面复用并独立维护 Monica WebUI 源码，运行时不依赖 Monica Server WebUI。

## 当前状态

基础可用版本已经完成：

- Vue 3 + Material 3 Expressive 管理页。
- 浏览器工具栏 Popup 和当前网站登录表单检测。
- Provider 中立的数据模型，覆盖登录、TOTP、银行卡、证件、地址、支付账号和 Passkey。
- AES-256-GCM 加密 IndexedDB 密码库。
- PBKDF2-HMAC-SHA256（600,000 次）主密码派生。
- 解锁密钥只保存于 `chrome.storage.session`，默认 15 分钟无操作锁定。
- Popup 只接收登录项摘要；点击后由后台解密单个条目并执行填充。
- Popup 可发现主页面及跨域 iframe 登录表单、选择填充目标，并填充用户名、密码和当前 TOTP。
- 登录提交、SPA 按钮和密码变更会显示隔离的保存/更新弹窗；候选密码只在后台内存保留 60 秒。
- Popup 可显式填充证件、账单地址、银行卡和支付账号；通用 `number`/`code` 字段不会被猜测。
- 旧明文原型数据会在首次创建加密密码库时迁移并删除。
- WebDAV Basic Auth、连接测试、手动同步和多连接管理。
- 兼容 Android 的普通 `.zip` 与 `MONICA_ENC_V1` 加密 `.enc.zip`。
- 登录、TOTP、银行卡、证件、地址、支付账号、笔记及 Passkey 元数据导入。
- 浏览器修改和删除会写入新的 Android 快照，未知文件和未来 JSON 字段原样保留。
- 基于远端文件、ETag 和项目 revision 的三方冲突检测；冲突时停止覆盖。
- Bitwarden US、EU 和标准路径自托管服务登录，支持 PBKDF2、Argon2id、身份验证器/邮箱/YubiKey 代码 2FA 和 Token 刷新。
- Bitwarden 个人登录、TOTP、银行卡、身份与安全笔记 Cipher 的导入、创建、更新和删除。
- 支持浏览器本地 ES256 Passkey 注册和登录，以及具有可导出 PKCS#8 密钥的 Bitwarden FIDO2 凭据。
- Bitwarden revision 冲突检测和异常空密码库防误删保护。
- 外部源修改进入加密 mutation queue；管理页显示待同步、失败次数和显式重试入口。

当前版本的登录填充、密码保存/更新、身份与支付填充、WebDAV、Bitwarden 和 Passkey 主流程均有真实 Chromium MV3 E2E 覆盖。

## 日常使用

1. 点击插件图标，按需解锁 Monica。
2. 登录页选择匹配账号，填充用户名、密码和 TOTP；跨域 iframe 可在“填充目标”中切换。
3. 提交新密码后，在页面右上角选择保存源并确认保存或更新。
4. 地址、证件或结账页面从 Popup 选择对应项目；银行卡安全码只在这次显式点击后发送。
5. 网站请求创建或使用 Passkey 时，在页面确认弹窗中继续或取消。

## WebDAV 使用

1. 在管理页打开“密码源”，填写 WebDAV 根地址、用户名和密码。
2. Android 使用加密备份时，同时填写相同的备份加密密码。
3. 先“测试连接”，再“加密保存”，最后执行“立即同步”。
4. 新建登录项时可选择该 WebDAV 源；项目会在下次同步时写入新的 Android 兼容快照。

同步不会修改旧备份文件，而是在 `Monica_Backups` 中生成新的时间戳快照。Android 本地 Passkey 备份只有设备密钥引用，因此插件只显示其元数据，不能用它签名。

## Bitwarden 使用

1. 在“密码源”点击“连接 Bitwarden”。
2. 选择 US/EU 官方地址，或填写自托管 Vault 根地址。
3. 输入邮箱和主密码；需要 2FA 时选择方式并继续验证。
4. 连接成功后执行“立即同步”。主密码不会保存；Token、Vault Key 和缓存项目只存在于 Monica 加密信封中。

当前版本支持个人 Cipher。组织共享 Cipher 需要用用户 RSA 私钥解包组织密钥，插件会明确跳过并显示警告，不会将其误报为已导入。Bitwarden FIDO2 的 base64 PKCS#8 密钥可用于登录；没有可导出密钥的引用只显示元数据。

## 开发

```bash
npm install
npm test
npm run test:security
npm run test:e2e
npm run package:release
```

构建产物位于 `dist/`，可安装 ZIP 位于 `release/`。

## 本地安装

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目的 `dist` 目录。
5. 打开扩展的“选项”页面并创建主密码。

也可以解压 `release/monica-extension-0.1.0.zip`，再将解压目录作为扩展加载。ZIP 的根目录直接包含 `manifest.json`。

## 安全边界

- 密码、Token、Provider 凭据和 Passkey 私钥不得持久化为明文。
- Content Script 不提供读取密码库的消息接口。
- 自动填充要求用户在 Popup 或页面选择器中明确操作。
- 当前 JSON 导出是用户主动触发的明文导出，必须保存在可信位置。
- Android WebDAV 的设备绑定 Passkey 只有密钥别名，浏览器中保持只读元数据，不能签名。
- Bitwarden 组织共享 Cipher 暂不支持；同步时会跳过并给出警告。

详见 [架构说明](docs/ARCHITECTURE.md)。

## 许可证

Monica 项目采用 [GNU GPL v3](https://www.gnu.org/licenses/gpl-3.0.html)（`GPL-3.0-only`）。
