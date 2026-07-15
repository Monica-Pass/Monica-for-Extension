# 参与 Monica Extension

感谢你改进 Monica。密码管理器的改动必须优先保护现有用户数据和安全边界。

## 安全问题

不要在公开 Issue、讨论、日志或测试夹具中提交真实密码、Token、私钥、WebDAV 地址或可用的漏洞利用细节。安全漏洞请通过 [GitHub Security Advisories](https://github.com/Monica-Pass/Monica-for-Extension/security/advisories/new) 私密报告，并遵循 [SECURITY.md](SECURITY.md)。

## 本地验证

使用仓库固定的 Node/npm 版本，并禁用依赖安装脚本：

```bash
npm ci --ignore-scripts
npx playwright install chromium
npm run release:check
```

提交内容不得依赖远程可执行代码。修改 Manifest 权限、CSP、运行时消息、密码库、Passkey、WebDAV、Bitwarden、导入解析或发布脚本时，必须同步增加对应的负向测试和安全文档。

## 供应链要求

- GitHub Actions 必须固定到完整 40 位 commit SHA。
- 依赖只能通过 `package-lock.json` 和官方 npm registry 更新；不得提交镜像 registry URL。
- 不得绕过 `npm audit`、安全测试、确定性打包或发布验证。
- 测试仅使用合成数据和 `.example.test` 域名。

建议使用 `git commit -s` 记录 Developer Certificate of Origin sign-off。合并前请确认 PR 模板中的安全清单全部得到回答。
