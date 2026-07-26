# Monica Extension 交接文档

> 交接时间：2026-07-26 14:25 +08:00  
> 目标：让新的 AI 会话可以从当前真实状态继续完成 MDBX 1.0、KeePass/KDBX 与 Bitwarden Android 对齐，并保持自动填充、Passkey 和 M3E UI 的质量。

## 1. 当前完成度

- **本次 Epic：0/7 个子交付完成**。当前仍停在子任务 #1（审计）；没有提交 MDBX、KeePass 或新的 Bitwarden 代码。
- 子任务 #1 的 5 个叶任务均未验收完成。三个只读审计代理都因上游模型服务返回 `502 Bad Gateway` 退出，因此不能把审计视为完成；主代理只完成了部分架构盘点。
- **扩展现有基线**已经落地并在 `main`：自动填充/保存提示、Passkey 拦截与来源策略、Steam TOTP/maFile/网络动作、WebDAV Android 备份编解码、Bitwarden 基础个人/组织库，以及 M3E 管理页/Popup 相关改进。
- 这意味着“已有浏览器核心”可继续使用，但**绝不能宣称已实现 Android 完整 MDBX/KDBX 读写兼容**；目前这两类数据主要是保留/透传能力。

## 2. 已验证的仓库状态

### 扩展仓库

路径：`C:\Users\joyins\Desktop\Monica-all\monica-extension`

- 分支：`main`
- HEAD：`e6621b161b1288db23a03a81e99d9d8d6a3238f8`（`origin/main` 同步）
- 工作树：干净
- 最近相关提交：
  - `3f1386e feat: harden autofill and passkey flows`
  - `e6621b1 fix: verify ranged node engine`
- 当前验证（本次会话重新执行）：
  - `npm run check`：通过
  - `npm test -- --reporter=dot`：43 个文件、275/275 测试通过
- 尚未在本次交接前重跑：`npm run test:security`、完整 Playwright、`npm run release:check`。不要把它们写成已通过。

### Android 规范仓库

路径：`C:\Users\joyins\Desktop\Monica-all\Monica-main`

- 当前 HEAD：`9930d8d8d3a7c2a025370ef9631670cb4be50196`
- 工作树**有用户已有未提交修改**（导出、加密、WebDAV 及相关测试等文件）。扩展实施期间不要修改、重置、清理或提交 Android 仓库。
- 任务旧文档中的 `3666e6eb` / `f22c068c` 只是历史基线，下一会话必须先核对当前 HEAD 与实际 diff，再决定 Android authority commit。

## 3. 任务真相文件（先读）

按 Taskmaster 恢复协议读取（当前工作区中的本地任务状态）：

1. `.codex-tasks/20260726-mdbx-keepass-bitwarden/EPIC.md`
2. `.codex-tasks/20260726-mdbx-keepass-bitwarden/SUBTASKS.csv`
3. `.codex-tasks/20260726-mdbx-keepass-bitwarden/PROGRESS.md`
4. `.codex-tasks/20260726-mdbx-keepass-bitwarden/tasks/01-audit/TODO.csv`

审计原始材料应放在 `tasks/01-audit/raw/`，兼容矩阵和决策应回写到该子任务目录，不能只留在聊天记录中。

## 4. 已盘点的扩展架构事实

- `ProviderKind` 当前只有 `local`、`monica-webdav`、`bitwarden`；没有 `keepass` 或 `mdbx` adapter。
- `ProviderSourceRecord.format` 当前只有 `android-entry`、`bitwarden-cipher`。
- `.kdbx` 与 MDBX 相关 Android 文件目前只能通过 Android ZIP/来源信封做原始数据保留；没有 KDBX 解锁、MDBX 表/提交 DAG 读写 UI。
- `src/lib/api.ts` 中出现的 MDBX 页面是复制 WebUI 的演示/Mock 数据，**不是** MDBX provider 接入。
- Manifest 已允许 bundled WASM（`wasm-unsafe-eval`），但尚无经过验证的 MDBX WASM bridge、SQLite/OPFS 存储层或 native messaging。
- Popup/content script 的安全边界必须继续保持：只拿候选摘要或用户明确点击后的单项字段，不能读取整个库、原始数据库、来源信封或私钥。

## 5. Android 侧必须复核的规范来源

### MDBX

- `Monica-main/Monica for Android/docs/MDBX_1_ANDROID_ACCEPTANCE.md`
- `Monica-main/mdbx/CLIENT_INTEGRATION_GUIDE.zh-CN.md`
- `Monica-main/mdbx/docs/02-storage-sync-spec.zh-CN.md`
- `Monica-main/mdbx/docs/03-security-spec.zh-CN.md`
- `Monica-main/mdbx/docs/06-sqlite-schema-v1.zh-CN.md`
- `Monica-main/Monica for Android/app/src/main/java/takagi/ru/monica/repository/MdbxVaultCrypto.kt`
- `Monica-main/Monica for Android/app/src/main/java/takagi/ru/monica/repository/MdbxVaultStore.kt`

当前已知但要再次以代码为准的事实：Android 使用 `mdbx:v1:` 字段密文前缀、PBKDF2-HMAC-SHA256 与 AES-256-GCM；Sky/Multi/Power 的 PBKDF2 次数分别为 90,000/210,000/360,000；支持密码、key file、密码+key file、device key。文档中推荐的 Argon2id/XChaCha 不能直接替换当前实际格式。

完整 MDBX 不能只操作当前表；必须考虑 projects、entries、attachments、object versions、commit DAG、tombstones、device/branch heads、snapshots、conflicts、key epochs、unlock methods 与 project tags。若浏览器没有经过测试的等价 bridge，只能提供明确标注的导入/保留或只读能力。

### KeePass

必须从 Android `app/build.gradle` 和实际 provider 代码确认 KDBX 库及版本，再核对 KDF、压缩、protected stream、key file、groups、recycle bin、history、custom fields、binary attachments、TOTP/Passkey codec、pending change/remote rebase，以及 WebDAV/OneDrive/Google Drive 文件源。简单 XML 导入不能称为 KDBX 对齐。

### Bitwarden

现有扩展已有官方/自托管登录、PBKDF2/Argon2id、代码型 2FA、token refresh、个人/组织 cipher、folders/collections、登录/卡片/身份/笔记/TOTP/FIDO2、revision/冲突/空库保护。待 Android 对照审计的高风险差距包括 attachments、Sends、trash restore、historical repair、offline secret cache、mutation queue/retry/status、folder sync rules、secure-note 图片及更完整的未知字段保留。

## 6. 下一会话的精确执行顺序

1. 不修改 Android：先保存 `git status --short` 和 `git diff --stat`，读取当前 HEAD 的 MDBX/KeePass/Bitwarden 代码；若需稳定比较，使用 `git show` 或临时只读副本。
2. 完成 `tasks/01-audit`：把三方报告写入 `raw/`，建立功能/字段/加密/浏览器能力矩阵，明确“完整读写、只读、原样保留、不可实现”四种状态，并更新旧 authority SHA。
3. 先实现共享 Provider contract 与 fixtures（新 `ProviderKind`、source envelope、内容指纹/版本/ETag、加密凭据、大小/生命周期限制、迁移与未知字段策略），通过子任务 #2 的测试后再做 provider。
4. MDBX：先验证 Rust/WASM/许可证/OPFS 方案；没有可复现 bridge 时实现安全的原始文件保留与清晰能力提示，不得伪造完整写回。
5. KeePass：确认库许可与浏览器兼容后，按 KDBX 版本/KDF/附件/历史逐步实现，加入错误凭据、key file、未知字段和字节级 round-trip fixtures。
6. Bitwarden：按 Android 差距逐项补齐，尤其是附件、回收站、Sends、离线 mutation queue 与 revision 冲突；每项都加单测和安全边界测试。
7. 最后做 M3E provider UI/诊断/可访问性：无渐变、8px 卡片、16px 对话框、20/24px 图标、44px 交互区；Popup 只显示候选摘要，点击后才请求单项解密。自动填充和 Passkey 弹窗要覆盖普通页面、SPA、iframe、Shadow DOM、动态表单、多账号与失败态。
8. 按 `SUBTASKS.csv` 依赖顺序验证；每个功能组在 `main` 独立 commit 后直接 push。禁止新分支、PR、混入 Android 修改。

## 7. 恢复时可直接执行的命令

```powershell
Set-Location 'C:\Users\joyins\Desktop\Monica-all\monica-extension'
Get-Content -Raw '.codex-tasks\20260726-mdbx-keepass-bitwarden\EPIC.md'
Get-Content -Raw '.codex-tasks\20260726-mdbx-keepass-bitwarden\SUBTASKS.csv'
Get-Content -Raw '.codex-tasks\20260726-mdbx-keepass-bitwarden\PROGRESS.md'
git status --short --branch
npm run check
npm test
```

如 `rg` 在当前 Windows 沙盒返回“拒绝访问”，使用 `Get-ChildItem -Recurse` + `Select-String` 代替；不要因此修改工具链或仓库权限。

## 8. 用户不可变要求

- 中文沟通；WebUI 是复制到扩展目录复用代码，不运行时依赖 Monica Server。
- Chrome/Edge MV3；只用 `main`，直接 commit/push，不建分支、不提 PR。
- Android 数据兼容优先：未知字段、未来类型、未修改 ZIP/数据库条目必须无损保留；修改一个字段不能静默改变其他字段和值类型。
- 主密码可以留空，但界面必须明确显示设备密钥保护等级；设置主密码时继续使用 Android/现有约定，不可擅自换格式。
- M3E、干净紧凑、禁止渐变；自动填充、保存提示、证件/支付填充和 Passkey 弹窗必须合理好用且不泄露整库。

**交接结论：** 下一会话从“审计合并与共享 Provider 契约”开始，不要直接声称 MDBX/KeePass 已接入，也不要清理 Android 工作树。
