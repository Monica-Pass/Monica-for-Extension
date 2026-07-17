# Monica 浏览器插件商业验收矩阵

审计日期：2026-07-15

当前状态：通过。当前 `main` 的每个发布候选必须由 `SECURITY-EVIDENCE.json` 绑定完整 commit；所有原始必需功能均有代码、测试、文档或明确浏览器边界证据。

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
| 分发许可证、方形多尺寸图标和最小权限 | `LICENSE`、`public/icons/`、`public/manifest.json` | `src/commercial-acceptance.test.ts` | 通过；GPL 随 ZIP 分发，3 个命名权限 |
| 脱敏 Chrome/Edge 商店截图 | `store-assets/`、`scripts/capture-store-assets.mjs` | 1280×800 PNG 尺寸与素材清单断言 | 通过；5 张合成数据截图已人工复核 |

## 当前审计快照

- 官方 npm registry 生产依赖审计：0 个已知漏洞。
- 生产 lockfile/SBOM 和许可证清单由当前 lockfile 重新生成并由 `package:verify` 核对；Vite 构建工具仅列为 devDependencies。
- 最终完整功能门禁：全量 Vitest、聚焦安全测试/静态审计和 Chromium MV3 E2E 全部通过；精确用例数量以对应候选 commit 的 CI 日志为准，避免静态文档随新增回归测试失真。
- 当前 ZIP SHA-256 不在静态文档中固化；以对应 commit 的 `.zip.sha256`、`RELEASE-METADATA.json` 和 `SECURITY-EVIDENCE.json` 为准。
- 商店素材：5 张 1280×800 PNG，仅含 `.example.test`、测试卡号和明确标注的合成数据。

## 不夸大的已知边界

- 首发完整界面语言仅为 zh-CN；网页字段识别范围不等于完整的英文界面。
- 浏览器无法遍历 closed ShadowRoot；支持普通 DOM、动态 SPA 和开放 ShadowRoot。
- Monica Android 设备绑定 Passkey 只有设备密钥引用，在浏览器中是只读元数据；浏览器本地和含可导出 PKCS#8 的 Bitwarden FIDO2 才能签名。
- 新建 WebDAV 密码源强制 HTTPS（回环开发地址除外）；Android 备份加密密码可选且不限制长度，留空时无损读写普通 ZIP，填写后使用 `MONICA_ENC_V1` 加密快照。
- Bitwarden 当前支持身份验证器、邮箱和 YubiKey 代码 2FA；Duo/WebAuthn 交互式 2FA 不在首发范围。
- Chrome/Edge 商店账号提交、第三方法律/无障碍/渗透认证不由仓库自动化完成。

## 最终关闭条件

- [x] `npm run release:check` 在由安全证据记录的干净候选 commit 上通过。
- [x] 候选 commit 已推送到 `origin/main`，并由最新 CI/CodeQL/Secret Scan 重新验证。
- [x] 发布 ZIP 的 SHA-256、SBOM 和许可证清单已重新生成并验证两次打包字节一致。
- [x] 本文“当前状态”已更新为通过，且不存在未解释的必需功能缺口。
- [ ] 商店账号持有人完成 Chrome/Edge 后台提交；这是仓库外发布操作，不影响代码商业验收结论。

## 验收结论

Monica for Extension 已满足本次约定的基础商业浏览器插件范围：独立 WebUI 管理页、显式自动填充/保存、Android WebDAV、Bitwarden、身份与支付填充、Passkey、安全密码库、可访问性、商店披露和可复现发布均有直接证据。仓库不宣称已完成商店运营方审核或第三方认证。
