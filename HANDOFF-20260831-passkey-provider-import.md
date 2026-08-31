# Monica Extension 交接文档：Provider Passkey 导入

## 当前完成状态

本阶段目标已完成并提交到 `main`：

- 提交：`2fb03d9 fix(passkey): preserve legacy Android imports`（包含前序 `49bb5e4`、`92c9e59`）
- 远端：`origin/main` 已同步
- worktree：干净
- 发布包：`release/monica-extension-0.1.23.zip`
- 包 SHA-256：`5113fe86bab92026ee32c61171a5ca09950064f809e6b25f5fc48d3cf50505cb`

## 本阶段实现

1. Bitwarden FIDO2/Passkey 导入支持官方字段 `KeyType`、`KeyAlgorithm`、`KeyCurve`、`KeyValue`，兼容大小写和自部署服务端的明文标量字段。
2. `KeyValue` 支持 Bitwarden 官方无填充 Base64URL PKCS#8；导入前验证 PKCS#8 算法和 EC 曲线，只有 ES256/P-256 会携带可用私钥，P-384 等曲线仅保留为不可用记录。
3. 写回 Bitwarden 时生成 `b64.<credential-id>`（UUID 保持 UUID）、`public-key`、`ECDSA`、`P-256` 和 Base64URL `KeyValue`。
4. 非法、P-384、未知算法和仅 Android 元数据记录仍可查看，但不会被标记为可登录。
5. Bitwarden 父级 Login Cipher 保留，同时每个 FIDO2 credential 暴露为独立 `kind: passkey` 子项。
6. WebDAV 与 Bitwarden 对同一 credential ID 的记录按 provider 所有权分别保留，不互相覆盖。
7. 新增真实验证：加密 Android WebDAV portable Passkey 私钥实际签名；远端 Bitwarden Cipher 导入后在真实页面完成 WebAuthn 登录。
8. 兼容 Android 旧版顶层 `passkeys/*.json` 备份路径；Bitwarden 合并时统一 UUID、`b64.` 和 Base64URL credential ID，避免同一凭据重复或漏合并。

## 关键文件

- `src/passkey/source-policy.ts`：Passkey 可用性、ID 规范化、Bitwarden `b64.` ID 编解码。
- `src/passkey/private-key-portability.ts`：portable PKCS#8/算法校验。
- `src/providers/bitwarden/bitwarden-cipher-codec.ts`：Bitwarden FIDO2 解码和写回。
- `src/providers/bitwarden/bitwarden-provider.ts`：父 Cipher/子 Passkey 同步和冲突处理。
- `src/providers/webdav/android-backup-codec.test.ts`：Android backup portable key 签名与往返测试。
- `tests/e2e/passkey.spec.ts`：创建、导入、认证、锁定、删除及 Bitwarden Provider E2E。

## 验证结果

- `npm test`：112 个测试文件，1032 项通过。
- `npm run test:security`：82 项通过，构建和安全审计通过。
- `npm run audit:production`：0 个生产依赖漏洞。
- Passkey 专项 E2E：7 项通过（导入、实际认证、锁定、取消、计数器和删除）。完整 `npm run test:e2e` 在本机环境超过 4 分钟未结束，需下一会话单独复跑。
- `npm run package:release && npm run package:verify`：通过，包内容与独立生成结果字节一致。

任务过程记录在 `.codex-tasks/20260831-passkey-provider-import/`，其中 `TODO.csv` 和 `PROGRESS.md` 已闭环。根目录临时 TODO CSV 已删除，避免提交临时文件。

## 下一会话建议

优先继续以下工作：

1. 使用真实 Monica Android 和自部署 Bitwarden 脱敏导出样本做条目级双向往返，特别检查 Steam 特殊字段/附件、笔记、验证器和 Passkey 的混合 Cipher。
2. 用多个 Bitwarden 账户和组织库做登录、令牌刷新、空库保护、Collection/Folder 路由及并发 ETag 场景测试。
3. 检查 Popup 自动填充候选项对 imported Passkey 的来源/不可用原因提示，确保私钥仍只在后台解密。
4. 继续 MDBX2 浏览器客户端工作；不要恢复 MDBX1 支持，也不要修改 Android 工作区。
5. 每个功能组在 `main` 独立 commit，遵守不建分支、不创建 PR 的约定。当前最新代码提交为 `2fb03d9`，文档更新提交随后追加，均已推送 `origin/main`。

下一会话建议先读取：

- 本文件
- `.codex-tasks/20260831-passkey-provider-import/PROGRESS.md`
- `.codex-tasks/20260831-passkey-provider-import/TODO.csv`
- `git show 92c9e59 --stat`

推荐技能：`taskmaster`、`todo-list-csv`、`security-review`、`verification-loop`；涉及界面时再使用 `frontend-design` 或 `ui-ux-pro-max`。
