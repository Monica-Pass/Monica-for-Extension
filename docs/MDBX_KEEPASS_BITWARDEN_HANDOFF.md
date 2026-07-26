# Monica Extension 交接文档

> 交接时间：2026-07-27 00:05 +08:00
> 目标：让新的 AI 会话可以从当前真实状态继续完成 MDBX 1.0、KeePass/KDBX 与 Bitwarden Android 对齐，并保持自动填充、Passkey 和 M3E UI 的质量。
> 本文替换 2026-07-26 14:25 的旧版交接（那一版写于子任务 #1 期间，其「0/7 完成」等结论已过时）。

## 1. 当前完成度

**本次 Epic：5/7 个子交付完成。**

| # | 子任务 | 状态 | 产出 |
|---|---|---|---|
| 1 | 三方兼容性审计与矩阵 | DONE | `tasks/01-audit/COMPATIBILITY-MATRIX.md` + `raw/` 下 4 份报告 |
| 2 | 共享 Provider 契约与 fixtures | DONE | commit `3473158` |
| 3 | MDBX 1.0 provider | DONE | commit `1851fdf`，`tasks/03-mdbx/DECISIONS.md` |
| 4 | KeePass KDBX provider | DONE | commit `f804efa`，`tasks/04-keepass/DECISIONS.md` |
| 5 | Bitwarden 对齐补齐 | DONE | commit `da37e13`，`tasks/05-bitwarden/DECISIONS.md` |
| 6 | M3E provider UI 与文档 | **TODO ← 从这里继续** | — |
| 7 | 发布门禁与推送 main | TODO | — |

**仍然绝不能宣称「已实现 Android 完整 MDBX/KDBX/Bitwarden 读写兼容」。** 三个 provider 的**真机双向往返实测一次都没做**（兼容矩阵 §9 第 6 项，只能人工完成）。文档、UI、发布说明一律不得越过这条线。

## 2. 已验证的仓库状态

### 扩展仓库

路径：`C:\Users\joyins\Desktop\Monica-all\monica-extension`

- 分支：`main`，HEAD `da37e13`，与 `origin/main` 同步，工作树干净
- 近期提交（新→旧）：`da37e13` Bitwarden 回收站 / `f804efa` KeePass / `1851fdf` MDBX / `22b7c59` merge PR #11 / `3473158` provider 契约
- 本次会话实测通过：
  - `npm run check`（`tsc -b --pretty false`）
  - `npx vitest run` —— **64 files / 658 tests**
  - `npm run test:bitwarden` —— 5 files / 51 tests
  - `npm run build`、`node scripts/security-audit.mjs`、`npm run test:security`
- **尚未跑过**：完整 Playwright（`tests/e2e/`）、`npm run release:check`。**不要写成已通过**——这正是子任务 06/07 的验收命令。

### Android 规范仓库

路径：`C:\Users\joyins\Desktop\Monica-all\Monica-main`

- **当前 HEAD：`8f2f84007f297edff330aacf5c5b0451a83f0586`**，工作树 **clean**
- 旧交接写的 `9930d8d8` 是审计时的快照；用户本人后来提交了自己的未提交修改（`feat(backup): 本地 ZIP 导出支持可选加密`），所以工作树已经不脏了。**01/03/04 三份 DECISIONS.md 里的 `9930d8d8` 是历史记录，不必改；05 起以 `8f2f8400` 为准。**
- 全程只读的纪律不变：**不修改、不重置、不清理、不提交 Android 仓库**，也**绝不为生成 fixture 改动 Android 一个字节**（矩阵 §7 前言）。

## 3. 任务真相文件（先读）

`.codex-tasks` **在 `.gitignore` 内**，不会进版本库，但它是任务状态的唯一真相：

1. `.codex-tasks/20260726-mdbx-keepass-bitwarden/EPIC.md`
2. `.codex-tasks/20260726-mdbx-keepass-bitwarden/SUBTASKS.csv` ← 依赖顺序与验收命令
3. `.codex-tasks/20260726-mdbx-keepass-bitwarden/PROGRESS.md` ← 逐子任务 checkpoint，**最后一段是 05 的完成记录**
4. `.codex-tasks/20260726-mdbx-keepass-bitwarden/tasks/01-audit/COMPATIBILITY-MATRIX.md` ← 硬约束都在这里
5. `tasks/03-mdbx/DECISIONS.md`、`tasks/04-keepass/DECISIONS.md`、`tasks/05-bitwarden/DECISIONS.md`

决策必须回写到对应子任务目录，不能只留在聊天记录里。

## 4. 已落地的三个 provider（06 要给它们做 UI）

### MDBX（`src/providers/mdbx/`）

- sql.js WASM 经 `chrome.runtime.getURL()` 加载，**未加入 `web_accessible_resources`**
- `entry_type` 写 `"login"`（不是 `"password"`，后者不在 Android 导入过滤集合内）
- 遇到不认识的 `critical_extensions` → **只读降级**，不静默写坏
- runtime 消息：`MDBX_OPEN` / `MDBX_STATUS` / `MDBX_EXPORT_FILE` / `MDBX_LOCK`

### KeePass（`src/providers/keepass/`）

- kdbxweb 2.1.1 + `@xmldom/xmldom` **打包进 Service Worker**（实测推翻了矩阵里「必须放扩展页面」的结论）
- `crypto` 别名到 `scripts/stubs/node-crypto.js`，每个导出**抛错而不降级**
- kdbxweb 的 `new Function('return this')()` 在**构建期改写**为 `globalThis`；改写前先断言片段存在，换版本即构建失败
- **Twofish 显式识别**并给出「请在 Android 或 KeePassXC 转成 AES-256」的文案
- 字段删除是**双闸门**（overlay 判定 + Monica 角色），未知字段永不被删
- runtime 消息：`KEEPASS_OPEN` / `KEEPASS_STATUS` / `KEEPASS_EXPORT_FILE` / `KEEPASS_LOCK`

### Bitwarden（`src/providers/bitwarden/`）

- 删除走 `PUT /ciphers/{id}/delete`（服务端回收站），**`deleteCipher()` 已整个移除**——`DELETE /ciphers/{id}` 是不可逆清除，不留可被误用的动词
- 复活：本地存活 + 远端在回收站 → 先 `PUT .../restore` 再写
- **刻意偏离 Android**：Android 的 trash 按钮打的是永久删除、permanent-delete 按钮打的是服务端不存在的路由。照抄 = 复制数据丢失
- `steam://<base64>` TOTP payload 已可解析（Android 写 Steam Guard 用这个格式，此前扩展完全读不了）
- 编码走 `{...preservedRaw}` 起手 + 差异化覆写，`reprompt` / `attachments` / `passwordHistory` / `sshKey` / 未知字段全部逐字节保留

**八个 runtime 消息类型全部 `assertExtensionPage(sender)`，且刻意都不在 `WEB_PAGE_REQUEST_TYPES` 里。不要放开。**

## 5. 子任务 06 的具体待办（下一步就干这个）

`SUBTASKS.csv` 第 6 行，验收命令：

```
npx playwright test tests/e2e/provider-resilience.spec.ts tests/e2e/accessibility.spec.ts
```

### 要做什么

MDBX 与 KeePass 的**文件选择、密钥文件、解锁、保护等级展示、导出提示全部没有前端**。`vaultClient.openMdbx` / `openKeePass` / `*Status` / `export*File` / `lock*` 八个方法都已接线，**但一个调用方都没有**。

### 必须如实告知、不得用 UI 话术掩盖的三条边界

1. **浏览器不能持有本地文件的可写句柄。** 所有改动只在内存里，用户必须**导出并自行覆盖原文件**。`dirty` 状态要有明确提示。这是与 Android 的能力不对等（`keepass-android-audit.md` 主代理复核 §3 原话：「这是**必须如实告知的浏览器边界**，不是可以靠 UI 掩盖的实现细节」）。
2. **OneDrive / Google Drive 文件源不可实现。** 权限集被 `scripts/security-audit.mjs:12` 钉死为 `["alarms","cookies","storage","webNavigation"]`，没有 `chrome.identity` 就没有 OAuth。UI 要写清楚，不要留一个点不动的入口。
3. **Twofish 加密的 KDBX 打不开**，以及 **Bitwarden 的 Sends / 附件下载 v1 不做**，都要在界面上标注去 Android 或官网使用。

### UI 规范（用户不可变要求）

M3E、干净紧凑、**禁止渐变**；8px 卡片圆角、16px 对话框、20/24px 图标、44px 交互区。
主密码可以留空，**但界面必须明确显示设备密钥保护等级**。

### 安全边界

Popup / content script 只能拿**候选摘要**或**用户明确点击后的单项字段**，不能读取整个库、原始数据库、来源信封或私钥。`MdbxSessionSummary` / `KeePassSessionSummary` 已有断言测试保证不含 `epochKey` / `database` / `entriesByUuid`，别在 UI 层绕过它。

## 6. 子任务 07

`npm run release:check`。此前从未跑过完整 Playwright 与 release gate，**要预留时间处理第一次跑出来的失败**。

## 7. 硬约束速查（违反即返工）

- 权限集恒为 `["alarms","cookies","storage","webNavigation"]`；`web_accessible_resources` 只有 `icons/logo-256.png` + `use_dynamic_url: true`；`.wasm` 一律 `chrome.runtime.getURL()`
- 发布 CSP `script-src 'self' 'wasm-unsafe-eval'`：三个受信产物（`background.js` / `content.js` / `main-world.js`）中出现 `new Function` / `eval(` / `importScripts` 一律构建失败（`security-audit.mjs:30-34` 常驻检查）
- **tsconfig target 是 `ES2020`**：没有 `new Error(msg, { cause })`，没有 `Array.prototype.at`
- 项目 **GPL-3.0-only**，引入依赖要过许可证
- **没有 ESLint**，`npm run check` 就是唯一 lint 门禁
- 只用 `main`，直接 commit/push，**不建分支、不提 PR**
- **commit 不要任何 AI 署名 / Co-Authored-By / Generated with 尾注**
- Bash 工具是 `/usr/bin/bash` 不是 PowerShell；`rg` 若报「拒绝访问」，用 Grep 工具或 `Get-ChildItem -Recurse` + `Select-String`，**不要改工具链或仓库权限**

## 8. 已知遗留（不是 06/07 的范围，但要记着）

- 三个 provider 的**真机往返实测**（矩阵 §9 第 6 项）——只能人工做，做完之前不许宣称完整兼容
- Bitwarden：附件下载/上传、Sends、离线 mutation 队列、SSH Key 编辑入口
- KeePass：附件（binaries）只透传，无增删入口
- 审计 §7 三项需真实 Bitwarden 服务端验证：`PUT /ciphers/{id}` 不回传 `attachments`/`passwordHistory` 时服务端是否保留；Vaultwarden 行为是否一致；组织库 + collection 权限下的写入
- PR #11 合并后发现但未处理的 4 个问题：`provider-transport.ts` 的超时作用域回归、`totp.ts:109-112` + `VaultItemEditor.vue` `exportOtpQr()` 会把 YAOTP PIN 写进导出的二维码、`src/passkey/source-policy.ts` 有一个不可达分支、mOTP/YANDEX 行为变更缺记录

## 9. 用户不可变要求（原文保留）

- 中文沟通；WebUI 是复制到扩展目录复用代码，不运行时依赖 Monica Server。
- Chrome/Edge MV3；只用 `main`，直接 commit/push，不建分支、不提 PR。
- Android 数据兼容优先：未知字段、未来类型、未修改 ZIP/数据库条目必须无损保留；修改一个字段不能静默改变其他字段和值类型。
- 主密码可以留空，但界面必须明确显示设备密钥保护等级；设置主密码时继续使用 Android/现有约定，不可擅自换格式。
- M3E、干净紧凑、禁止渐变；自动填充、保存提示、证件/支付填充和 Passkey 弹窗必须合理好用且不泄露整库。

## 10. 恢复时可直接执行

```powershell
Set-Location 'C:\Users\joyins\Desktop\Monica-all\monica-extension'
Get-Content -Raw '.codex-tasks\20260726-mdbx-keepass-bitwarden\SUBTASKS.csv'
Get-Content -Raw '.codex-tasks\20260726-mdbx-keepass-bitwarden\PROGRESS.md'
git status --short --branch
npm run check
npx vitest run
```

**交接结论：** 从子任务 #6（M3E provider UI 与文档）开始。三个 provider 的后端与测试都已在 `main`，缺的是前端与如实的能力说明。不要清理 Android 工作树，不要宣称完整兼容。
