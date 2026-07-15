# Monica for Extension

Monica 的 Chrome/Edge Manifest V3 浏览器插件。管理界面复用并独立维护 Monica WebUI 源码，运行时不依赖 Monica Server WebUI。

## 当前状态

基础可用版本已经完成：

- Vue 3 + Material 3 Expressive 管理页。
- 浏览器工具栏 Popup 和当前网站登录表单检测。
- Provider 中立的数据模型，覆盖登录、TOTP、银行卡、证件、地址、支付账号和 Passkey。
- AES-256-GCM 加密 IndexedDB 密码库。
- Argon2id v1.3（64 MiB、3 次、32-byte 随机 salt）主密码派生；旧 PBKDF2 密码库在成功解锁后自动原子迁移。
- 解锁密钥只保存于 `chrome.storage.session`，默认 15 分钟无操作锁定。
- 支持验证当前密码后更改主密码；完整密码库使用新盐重新派生并加密。
- 支持带版本标识的加密整库备份与原子恢复，包含项目、密码源和设置；恢复失败不会改写现有密码库。
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
- Bitwarden 个人及组织共享的登录、TOTP、银行卡、身份与安全笔记 Cipher 导入；个人 Cipher 可创建，个人和有权限的组织 Cipher 可更新、删除。
- 支持浏览器本地 ES256 Passkey 注册和登录；Bitwarden 可作为新 Passkey 的默认保存目标，并同步 FIDO2 创建、签名计数器与单凭据删除。
- Bitwarden revision 冲突检测和异常空密码库防误删保护。
- 外部源修改进入加密 mutation queue；管理页显示待同步、失败次数和显式重试入口。
- 本地写操作串行提交，IndexedDB 只有在事务完成后才报告成功，避免并发保存相互覆盖。

当前版本的登录填充、密码保存/更新、身份与支付填充、WebDAV、Bitwarden 和 Passkey 主流程均有真实 Chromium MV3 E2E 覆盖。

首发受支持的界面语言为 **zh-CN（简体中文）**；Manifest 商店文案已使用 Chrome `_locales` 管理。字段识别支持部分中英文网页，但不把字段兼容误称为完整英文界面。详见 [本地化支持范围](docs/LOCALIZATION.md)。

发布与商店材料：

- [隐私政策](docs/PRIVACY.md)
- [权限说明](docs/PERMISSIONS.md)
- [数据安全申报底稿](docs/DATA_SAFETY.md)
- [zh-CN 商店文案](docs/STORE_LISTING.zh-CN.md)
- [安全漏洞报告政策](SECURITY.md)
- [独立安全审计交付说明](docs/SECURITY_AUDIT_HANDOFF.md)
- [可复现发布流程](docs/RELEASE.md)
- [参与贡献](CONTRIBUTING.md)

## 日常使用

1. 点击插件图标，按需解锁 Monica。
2. 登录页选择匹配账号，填充用户名、密码和 TOTP；跨域 iframe 可在“填充目标”中切换。
3. 提交新密码后，在页面右上角选择保存源并确认保存或更新。
4. 地址、证件或结账页面从 Popup 选择对应项目；银行卡安全码只在这次显式点击后发送。
5. 网站请求创建或使用 Passkey 时，在页面确认弹窗中核对网站、账户和保存目标，再继续或取消。
6. 在“设置与备份”中定期下载加密整库备份；恢复后使用备份创建时的主密码。

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
4. 如需把网站新建的 Passkey 保存到 Bitwarden，请勾选“设为新项目的默认保存目标”；创建、使用或删除后执行“立即同步”。
5. 主密码不会保存；Token、Vault Key、FIDO2 私钥和缓存项目只存在于 Monica 加密信封中。

当前版本会从同步资料中解密用户 RSA 私钥，并分别解包可访问组织的对称密钥；共享 Cipher 按组织/集合归属读取，更新时保留 `organizationId` 和 `collectionIds`。缺失或损坏的组织密钥只会跳过对应共享项并保留本地缓存，不会影响个人库。新建项目目前仍创建为个人 Cipher，集合成员管理继续由 Bitwarden 官方客户端负责。Bitwarden FIDO2 的 base64 PKCS#8 密钥可用于登录；计数器更新和单凭据删除会合并回父登录 Cipher，不会删除父登录或其他 Passkey。没有可导出密钥的引用只显示元数据。

## 开发

```bash
npm install
npm test
npm run test:security
npm run test:e2e
npm run package:release
npm run package:verify
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
- 加密整库备份保留原 AES-GCM 信封；替换现有库前同时验证备份主密码和当前主密码。
- Android WebDAV 的设备绑定 Passkey 只有密钥别名，浏览器中保持只读元数据，不能签名。
- Bitwarden 组织密钥无法解包时，相关共享 Cipher 会保持本地缓存并给出警告，不会以空结果覆盖。

详见 [架构说明](docs/ARCHITECTURE.md)。

## 许可证

Monica 项目采用 [GNU GPL v3](LICENSE)（`GPL-3.0-only`）。
