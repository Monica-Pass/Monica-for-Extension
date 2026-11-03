# 参与 Monica Extension

感谢你改进 Monica。密码管理器的改动必须优先保护现有用户数据和安全边界。

## 安全问题

不要在公开 Issue、讨论、日志或测试夹具中提交真实密码、Token、私钥、WebDAV 地址或可用的漏洞利用细节。安全漏洞请通过 [GitHub Security Advisories](https://github.com/Monica-Pass/Monica-for-Extension/security/advisories/new) 私密报告，并遵循 [SECURITY.md](SECURITY.md)。

## 本地验证

使用仓库固定的 Node/npm 版本，并禁用依赖安装脚本：

```bash
npm ci --ignore-scripts
npx playwright install chromium
npm run lint
npm run release:check
```

`release:check` 在 Linux CI 上使用 Playwright 自带的 Chromium。需要已安装的 Windows Microsoft Edge（及其注册的本机助手）的验收用例在找不到 Edge 时会显示为“已跳过”并附原因；请在 Windows 上运行 `npm run test:e2e:edge`，此模式下缺少 Edge 会直接失败，不会被跳过。可用 `MONICA_E2E_EDGE_EXECUTABLE` 指定 Edge 路径。

提交内容不得依赖远程可执行代码。修改 Manifest 权限、CSP、运行时消息、密码库、Passkey、WebDAV、Bitwarden、导入解析或发布脚本时，必须同步增加对应的负向测试和安全文档。

## Lint 与源码护栏

`npm run lint` 是硬门禁，已接入 `release:check` 与 CI（`npm run lint:fix` 可自动修复子集）。除常规正确性规则外，配置将 `scripts/security-audit.mjs` 中只能对 dist 产物检查的不变量前移到源码层，新代码在提交时即被拦截，不得绕过：

- 可信发布图按 fail-closed 反向圈定：`src/**/*.ts` 默认全部禁止 `localStorage`/`sessionStorage`/`importScripts`（含 `window.localStorage`、计算属性、解构别名的成员访问形式），仅 UI 侧例外（`src/cli/**`、`src/i18n/index.ts`、`src/lib/**` 与 `*.test.ts`）明确豁免；新增顶层目录会先被拦下，需有意识归类。content 与 MAIN-world 入口禁止 `connectNative`（后台的 Native Messaging 客户端不受影响）；全部 `src/` 禁止 `eval` 与 `new Function`。dist 层的对应检查继续保留；护栏规则本身由 `scripts/lint-guardrails-audit.test.mjs` 负向自测并纳入 `test:security`，其临时 fixture 由 `scripts/lint-guardrails-sweep.mjs` 自愈清扫（`npm run lint` 前置执行）。
- `.vue` 模板禁止 `v-html`；测试代码与互操作 fixture 中显式 `any` 允许豁免，生产源码不允许。
- 少数规则按仓库实际情况收窄：控制字符正则与 m3e 原生 web components 的 `slot` 属性在 `eslint.config.mjs` 内关闭并附理由；`finally` 中清空明文凭据属于主动擦除，以源码内 `eslint-disable no-useless-assignment` 行内注释说明（非配置级豁免）。

## 供应链要求

- GitHub Actions 必须固定到完整 40 位 commit SHA。
- 依赖只能通过 `package-lock.json` 和官方 npm registry 更新；不得提交镜像 registry URL。
- 不得绕过 `npm audit`、安全测试、确定性打包或发布验证。
- 测试仅使用合成数据和 `.example.test` 域名。

建议使用 `git commit -s` 记录 Developer Certificate of Origin sign-off。合并前请确认 PR 模板中的安全清单全部得到回答。
