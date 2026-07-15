# Monica 浏览器插件商业验收矩阵

审计日期：2026-07-15

当前状态：进行中。此矩阵只记录仓库当前可复核证据；最终状态必须在完整发布门禁、仓库同步和产物哈希复核后更新。

## 原始需求追踪

| 需求 | 实现证据 | 自动化证据 | 当前结论 |
| --- | --- | --- | --- |
| 管理 UI 复制复用 WebUI 代码，运行时不调用 Monica Server WebUI | `src/App.vue`、`src/components/`、`README.md` | 生产构建与管理页 E2E | 通过；扩展独立运行 |
| 点击插件图标显示自动填充 Popup | `src/popup/PopupApp.vue`、`public/manifest.json` | `tests/e2e/login.spec.ts`、`tests/e2e/dynamic-autofill.spec.ts` | 通过 |
| 保存、更新和拒绝密码提示 | `src/content/save-prompt.ts`、`src/background/index.ts` | `tests/e2e/save.spec.ts` | 通过 |
| 字段解析参考 Monica Android，支持中英文/旧字段 | `src/providers/webdav/android-backup-codec.ts`、`src/content/` | `android-backup-codec.test.ts`、`credential-capture.test.ts`、`dom.test.ts`、`wallet-dom.test.ts` | 通过 |
| WebDAV 兼容 Monica Android 数据和无损回写 | `src/providers/webdav/` | `android-backup-codec.test.ts`、`android-backup-crypto.test.ts`、`monica-webdav-provider.test.ts`、Provider E2E | 通过；未知字段/ZIP 条目保留 |
| Bitwarden 官方/自托管、个人/组织共享库 | `src/providers/bitwarden/` | Bitwarden client/crypto/organization/provider/codec 测试、Passkey E2E | 通过 |
| 登录、TOTP、跨域 frame、SPA、开放 ShadowRoot 填充 | `src/content/`、`src/background/index.ts` | `login.spec.ts`、`dynamic-autofill.spec.ts`、DOM 单测 | 通过 |
| 证件、地址、银行卡和支付方式填充 | `src/content/wallet-dom.ts`、Popup 钱包列表 | `wallet-dom.test.ts`、`tests/e2e/wallet.spec.ts` | 通过；通用 number/code 不猜测 |
| Passkey 创建、登录、计数器和 Bitwarden FIDO2 | `src/passkey/`、MAIN-world/Content Script 桥接 | `webauthn-core.test.ts`、Bitwarden codec/provider 测试、`passkey.spec.ts` | 通过 |
| 加密密码库、自动锁、改主密码、备份恢复 | `src/security/` | `secure-vault-service.test.ts`、manager lifecycle E2E、安全审计 | 通过 |
| Provider 重试、取消、冲突、诊断脱敏 | `src/providers/provider-transport.ts`、`provider-diagnostics.ts` | transport/diagnostic 单测、`provider-resilience.spec.ts` | 通过 |
| 密码源页面紧凑、锁定卡片无多余图标、图标居中 | `src/styles.css`、`src/manager.css` | `tests/e2e/visual-polish.spec.ts` | 通过 |
| 键盘、焦点、缩放、暗色、reduced-motion、Popup 可访问性 | `src/App.vue`、样式和 Popup | `tests/e2e/accessibility.spec.ts` + axe | 通过 |
| zh-CN 首发本地化、隐私、权限和商店材料 | `_locales/zh_CN`、`docs/PRIVACY.md`、`PERMISSIONS.md`、`DATA_SAFETY.md`、商店文案 | `src/release-readiness.test.ts` | 通过 |
| 可复现发布、checksum、SBOM、许可证清单 | `scripts/package-release.mjs`、`verify-release.mjs`、`docs/RELEASE.md` | `npm run package:verify` | 通过 |
| 分发许可证、方形多尺寸图标和最小权限 | `LICENSE`、`public/icons/`、`public/manifest.json` | `src/commercial-acceptance.test.ts` | 待最终门禁复核 |

## 不夸大的已知边界

- 首发完整界面语言仅为 zh-CN；网页字段识别范围不等于完整的英文界面。
- 浏览器无法遍历 closed ShadowRoot；支持普通 DOM、动态 SPA 和开放 ShadowRoot。
- Monica Android 设备绑定 Passkey 只有设备密钥引用，在浏览器中是只读元数据；浏览器本地和含可导出 PKCS#8 的 Bitwarden FIDO2 才能签名。
- WebDAV 未设置 Android 备份密码时上传普通 ZIP；真实凭据应使用 HTTPS 并启用备份加密。
- Bitwarden 当前支持身份验证器、邮箱和 YubiKey 代码 2FA；Duo/WebAuthn 交互式 2FA 不在首发范围。
- Chrome/Edge 商店账号提交、第三方法律/无障碍/渗透认证不由仓库自动化完成。

## 最终关闭条件

- `npm run release:check` 在最终提交上通过。
- `main` 工作区干净且与 `origin/main` 一致。
- 发布 ZIP 的 SHA-256、SBOM 和许可证清单由最终提交重新生成并记录。
- 本文“当前状态”更新为通过，且不存在未解释的必需功能缺口。
