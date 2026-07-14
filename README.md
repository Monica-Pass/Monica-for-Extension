# Monica for Extension

Monica 的 Chrome/Edge Manifest V3 浏览器插件。管理界面复用并独立维护 Monica WebUI 源码，运行时不依赖 Monica Server WebUI。

## 当前状态

安全基础、Monica Android WebDAV 和 Bitwarden 基础阶段已经完成：

- Vue 3 + Material 3 Expressive 管理页。
- 浏览器工具栏 Popup 和当前网站登录表单检测。
- Provider 中立的数据模型，覆盖登录、TOTP、银行卡、证件、地址、支付账号和 Passkey。
- AES-256-GCM 加密 IndexedDB 密码库。
- PBKDF2-HMAC-SHA256（600,000 次）主密码派生。
- 解锁密钥只保存于 `chrome.storage.session`，默认 15 分钟无操作锁定。
- Popup 只接收登录项摘要；点击后由后台解密单个条目并执行填充。
- Popup 可发现主页面及跨域 iframe 登录表单、选择填充目标，并填充用户名、密码和当前 TOTP。
- 旧明文原型数据会在首次创建加密密码库时迁移并删除。
- WebDAV Basic Auth、连接测试、手动同步和多连接管理。
- 兼容 Android 的普通 `.zip` 与 `MONICA_ENC_V1` 加密 `.enc.zip`。
- 登录、TOTP、银行卡、证件、地址、支付账号、笔记及 Passkey 元数据导入。
- 浏览器修改和删除会写入新的 Android 快照，未知文件和未来 JSON 字段原样保留。
- 基于远端文件、ETag 和项目 revision 的三方冲突检测；冲突时停止覆盖。
- Bitwarden US、EU 和标准路径自托管服务登录，支持 PBKDF2、Argon2id、身份验证器/邮箱/YubiKey 代码 2FA 和 Token 刷新。
- Bitwarden 个人登录、TOTP、银行卡、身份与安全笔记 Cipher 的导入、创建、更新和删除。
- Bitwarden FIDO2 元数据及密钥材料导入，为 Passkey 阶段提供加密数据基础。
- Bitwarden revision 冲突检测和异常空密码库防误删保护。

正在实施：页面自动填充选择器、保存密码弹窗、身份/支付填充和可用 Passkey。

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

当前阶段支持个人 Cipher。组织共享 Cipher 需要用用户 RSA 私钥解包组织密钥，插件会明确跳过并显示警告，不会将其误报为已导入。Bitwarden Passkey 的实际创建与签名将在 Passkey 阶段启用。

## 开发

```bash
npm install
npm test
npm run build
npm run test:e2e -- --grep login
```

构建产物位于 `dist/`。

## 本地安装

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目的 `dist` 目录。
5. 打开扩展的“选项”页面并创建主密码。

## 安全边界

- 密码、Token、Provider 凭据和 Passkey 私钥不得持久化为明文。
- Content Script 不提供读取密码库的消息接口。
- 自动填充要求用户在 Popup 或页面选择器中明确操作。
- 当前 JSON 导出是用户主动触发的明文导出，必须保存在可信位置。

详见 [架构说明](docs/ARCHITECTURE.md)。

## 许可证

Monica 项目采用 GNU GPL v3。完整许可证文件会随首个发布版本提供。
