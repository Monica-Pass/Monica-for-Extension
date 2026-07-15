# 独立安全审计交付说明

## 状态

此交付包已准备好供独立审计方使用，但不构成审计完成证明。审计方必须在报告中记录实际检查的完整 commit SHA、工具版本和未测试范围。

## 交付内容

- 威胁模型与剩余风险：`docs/SECURITY_ARCHITECTURE.md`
- 强制审计范围与验收条件：`docs/SECURITY_AUDIT_SCOPE.md`
- 漏洞披露与 safe harbor：`SECURITY.md`
- 权限、隐私和数据申报：`docs/PERMISSIONS.md`、`docs/PRIVACY.md`、`docs/DATA_SAFETY.md`
- 可复现发布流程：`docs/RELEASE.md`
- 单元、安全与 MV3 浏览器攻击回归：`src/**/*.test.ts`、`tests/e2e/`
- 发布证据：ZIP 内的 `RELEASE-METADATA.json`、`SBOM.cdx.json`、`THIRD-PARTY-LICENSES.json`、`SECURITY-EVIDENCE.json` 以及外部 `.zip.sha256`

## 审计候选固定方式

1. 记录 `git rev-parse HEAD` 和 `git status --short`。
2. 从该 commit 的成功 CI run 下载 `monica-extension` 与 `codeql-sarif` 构件。
3. 核对 `SECURITY-EVIDENCE.json` 中的 `source.commit` 与审计 commit 一致，且 `trackedWorktreeClean` 为 `true`。
4. 核对 ZIP 外部 SHA-256、ZIP 内逐文件哈希、SBOM 和许可证 sidecar。
5. 报告和复测函必须引用同一候选或明确列出修复后的后继 commit。

## 独立复现

```bash
npm ci --ignore-scripts
npx playwright install chromium
npm run release:check
```

审计方应在独立环境重新运行，而不是仅接受项目维护者生成的日志。测试失败、跳过项和环境差异必须保留在报告中。

## 已知平台限制

- 当前仓库为私有组织仓库，未启用 GitHub Advanced Security；CodeQL 在 CI 中离线运行并保留 SARIF，但 GitHub Security 页面不接收结果。
- GitHub 原生 Secret Scanning、OpenSSF Scorecard 发布、托管 provenance、Ruleset/主分支保护受当前可见性或套餐限制。
- Actions 已限制为 GitHub 官方 Action及明确允许的 TruffleHog/OpenSSF，并由平台和仓库检查器双重要求完整 SHA。
- Dependabot 漏洞告警已启用；原生能力不可用的部分由 TruffleHog、CodeQL SARIF、生产依赖审计和确定性发布证据补充，但不能替代独立审计。
- 当前 Git commit 未形成可验证签名链；正式公开发行应由账号持有人使用受保护账号、签名 tag/发布流程和商店签名建立发行身份。

## 交付完成条件

只有独立审计报告、Critical/High 修复和独立复测全部存在后，维护者才能把 `docs/SECURITY_AUDIT_SCOPE.md` 的状态改为已审计。自动扫描或 AI 审查不得替代该条件。
