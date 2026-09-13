# 0.1.24 使用与验证记录

验证日期：2026-09-10。本次产物为未提交工作树的本地开发包，发布证据如实记录该状态。

## 本次更新

- Nothing 黑白界面、点阵品牌与图标，字体和许可文件随扩展离线提供。默认跟随系统，支持手动浅色、深色。
- 简体中文与英文界面，管理页、工具栏弹窗与网页提示同步语言；账号名称、密码、笔记和来源数据保持原样。
- 普通登录项支持“允许免解锁填写”。勾选并保存后，锁定时可在匹配网站点击填写用户名和密码，浏览器重启后仍有效。验证码、Passkey、详情与复制密码仍需解锁。
- 收紧异步填写和锁定之间的校验，旧账号列表响应不会在锁定后重新显示；修复弹窗解锁后丢失原页面目标的问题。
- 升级 KeePass XML 依赖到 `@xmldom/xmldom 0.8.15`，修复已公开的解析和序列化安全问题。

免解锁副本使用独立设备密钥加密，依赖当前浏览器配置与操作系统保护。关闭标记、删除或归档账号会撤销填写权限。标记不写入 Android、KeePass 或 Bitwarden 记录，恢复整库备份后需要重新开启。

## 已执行验证

| 验证范围 | 结果 |
| --- | --- |
| Vitest 单元测试 | 115 个测试文件，1062 项通过 |
| Chromium MV3 端到端测试 | 102 项通过 |
| Native Host 单元测试 | 48 项通过 |
| Bitwarden / Vaultwarden 服务契约 | 2 项通过，包含有效 ES256 私钥和附件往返 |
| Android KeePass 双向互通 | AES-256、ChaCha20 通过，保留未知字段、历史、附件、证件/银行卡照片和 Passkey 字段 |
| Android MDBX2 互通用例 | Android、Native Host 与 WebDAV 间的认证段、Blob、附件和重启恢复通过 |
| 真实工具栏弹窗 | 400 × 510px；200% 字体下图标和内容边界检查通过，全局搜索和复制回退通过 |
| 界面布局 | 中英文、浅深色、375 / 768 / 1280 / 1440px 窗口及 200% 字体；编辑器与密码源对话框可操作 |
| 生产依赖审计 | 0 个已报告漏洞 |
| 构建、工具链、锁文件与产物安全检查 | 通过 |
| 扩展和 Windows Native Host 包 | 文件、哈希、解压内容及两次独立打包的一致性验证通过 |

Android 对照版本为 `0ffa53dd23997b90448de4357c1a331e71874f26`。互通验证使用隔离测试数据，Android 工作树未改动。浏览器测试使用隔离配置，未修改日常浏览器中的账号数据。

端到端覆盖注册/使用/取消 Passkey、Bitwarden FIDO2、自动保存和更新密码、动态与两步表单、跨域 iframe、站点/字段排除、锁定填写与撤销、备份恢复、钱包、OTP、Steam、密码源、归档与回收站。外部服务使用受控测试服务器，不能代替所有真实网站和服务端版本的验收。

## 安装和升级

新安装：在 Chrome 或 Edge 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，加载 `release/monica-extension-unpacked`。

已有安装：保持原来的加载目录，更新文件后点击“重新加载”；`dist` 和 `release/monica-extension-unpacked` 均已更新。更换绝对目录可能改变开发者模式扩展 ID，原有本地存储不会自动迁移到新 ID。

ZIP 为 `release/monica-extension-0.1.24.zip`，旁边附有 SHA-256 文件、依赖清单和构建证据。

MDBX2 和 Monica Windows Hello 需要 Windows 连接组件：解压 `release/monica-mdbx2-host-windows-x64-0.1.0.zip`，在解压目录按浏览器运行以下命令，再完全退出并重开浏览器。扩展 ID 可从扩展管理页复制。

```powershell
.\install-host.ps1 -ChromeExtensionId <Chrome扩展ID>
# Edge 使用：
.\install-host.ps1 -EdgeExtensionId <Edge扩展ID>
```

组件只注册传入的精确扩展 ID。详细说明见 [Native Host 文档](../native/mdbx2-host/README.md)。本次未在日常浏览器中运行安装或重新注册操作。

## 验证边界

- Android 设备绑定 Passkey 如果只有密钥别名，只保留元数据，无法在浏览器签名；带可导出私钥的受支持 Passkey 可用于登录。
- 当前 Windows 环境返回 `platform-authenticator-unavailable`。已通过无弹窗状态/损坏绑定检查和浏览器模拟验证，真实 Windows Hello 指纹或 PIN 验收尚未完成。
- KeePass Twofish 返回明确的不支持提示，不会擅自转换数据库。
- 自动化无障碍检查通过，但没有执行独立第三方或所有屏幕阅读器审计。

预览图使用合成账号，位于 `store-assets/` 和 `.artifacts/nothing-preview/`。
