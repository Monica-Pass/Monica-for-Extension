# Monica for Extension

Monica 的 Chrome/Edge Manifest V3 浏览器插件。管理界面复用并独立维护 Monica WebUI 源码，运行时不依赖 Monica Server WebUI。

## 当前状态

第一阶段已经完成：

- Vue 3 + Material 3 Expressive 管理页。
- 浏览器工具栏 Popup 和当前网站登录表单检测。
- Provider 中立的数据模型，覆盖登录、TOTP、银行卡、证件、地址、支付账号和 Passkey。
- AES-256-GCM 加密 IndexedDB 密码库。
- PBKDF2-HMAC-SHA256（600,000 次）主密码派生。
- 解锁密钥只保存于 `chrome.storage.session`，默认 15 分钟无操作锁定。
- Popup 只接收登录项摘要；点击后由后台解密单个条目并执行填充。
- 旧明文原型数据会在首次创建加密密码库时迁移并删除。

正在实施：Monica Android WebDAV、Bitwarden、保存密码弹窗、身份/支付填充和 Passkey。

## 开发

```bash
npm install
npm test
npm run build
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
