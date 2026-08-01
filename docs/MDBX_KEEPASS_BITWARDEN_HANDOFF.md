# Monica Extension 交接文档

> 更新时间：2026-08-01 +08:00
> 本轮开始基线：`5449ef3`
> 仓库：`C:\Users\joyins\Desktop\Monica-all\monica-extension`

## 当前范围

MDBX 已按用户要求暂停。后续会话应保持现有 MDBX 代码原样，停止新增或扩展 MDBX 实现、管理界面和测试，也不要把 MDBX 真机兼容验证列为当前阻塞项。暂停并不代表已有 MDBX 实现通过了 Android 真机双向往返验证。

当前工作集中在浏览器适用部分：KeePass、Bitwarden、WebDAV、自动填充、保存提示、钱包填充、验证码、Steam 与 Passkey。

Android 仓库保持只读。不得修改、重置、清理或提交 Android 工作区。

## 阶段状态

本轮第 6 阶段的有效范围已经完成：KeePass M3E 管理界面、Bitwarden 能力提示、Popup 窄视口修正、Passkey 同步身份修正和相关浏览器测试均已实现。

最终任务状态以本机下列 Taskmaster 文件为准。`.codex-tasks` 已被 Git 忽略，但仍是续作时的状态依据。

```text
.codex-tasks/20260726-mdbx-keepass-bitwarden/SUBTASKS.csv
.codex-tasks/20260726-mdbx-keepass-bitwarden/PROGRESS.md
.codex-tasks/20260726-mdbx-keepass-bitwarden/tasks/06-ui-docs/TODO.csv
.codex-tasks/20260726-mdbx-keepass-bitwarden/tasks/06-ui-docs/PROGRESS.md
```

## 本轮实现

### KeePass 管理界面

管理页现已支持以下操作：

1. 选择 `.kdbx` 数据库。
2. 选择可选密钥文件。
3. 使用空密码、仅密码、仅密钥文件或密码与密钥文件组合解锁。
4. 显示 KDBX 版本、加密算法、项目数量、跳过条目、警告与保护方式。
5. 同步导入及写回内存数据库。
6. 显示尚未导出的 `dirty` 状态。
7. 导出 KDBX、锁定、重新选择和移除密码源。
8. 在丢弃尚未导出的修改前要求二次确认。

界面如实显示浏览器能力范围：浏览器无法覆盖原文件，导出后需要手动替换；OneDrive 和 Google Drive 文件需要先下载；Twofish KDBX 需要先在 Monica Android 或 KeePassXC 中转换为 AES-256。

KeePass 密码、密钥文件和解锁后的数据库对象仅存在于后台会话。公开 Provider 配置只包含文件名和经过白名单验证的保护方式。

### Bitwarden Passkey 同步

Bitwarden 服务端响应会重新绑定到已有 Monica 项目 ID。同一 FIDO2 凭据在创建、使用计数更新、再次同步和仅删除子凭据的过程中保持同一 Monica ID，避免重复项目和错误并发冲突。

本地专属的 Passkey 字段继续保留，服务端修订号和私钥相关同步数据采用远端响应。删除 Passkey 子凭据不会删除父登录 Cipher。

### Popup 与 M3E 界面

Popup 在标准扩展窗口中保持 390px 宽，在 375px 等窄视口中按可用宽度收缩。管理页与 Popup 均无渐变；KeePass 对话框采用固定头部、可滚动内容和固定操作栏，移动端改为单列。

Bitwarden 页面明确标注当前支持登录、卡片、身份、笔记、TOTP 与 Passkey；Sends 和附件下载继续使用 Bitwarden 官网或 Monica Android。

## 验证记录

本轮工作树上的验证结果：

```text
npm run check
64 个 Vitest 文件，659 项测试通过
npm run test:security
6 个文件，57 项安全测试通过
Playwright
48 项端到端测试通过
npm audit --omit=dev --audit-level=high
0 个漏洞
npm run verify:supply-chain
通过
```

首次 `npm run release:check` 已完成供应链、生产依赖审计、类型检查、659 项单元测试、安全检查和 48 项 Playwright 测试。最终打包步骤因可信发布脚本要求工作树先提交而停止：

```text
Refusing to create a trusted release from a dirty tracked worktree.
```

提交候选创建后，已从干净工作树重新执行完整 `npm run release:check`。供应链、生产依赖审计、类型检查、659 项单元测试、57 项安全测试、48 项 Playwright 测试、发布包生成和发布包可重复性校验全部通过。

## 数据兼容边界

真实 Android 客户端与真实 KDBX 文件的双向往返仍需人工验证。完成前只能声明自动化的结构保留和浏览器往返测试通过，不能声明已经实现 Android 完整无损兼容。

未知字段、未来字段、附件和无法解释的条目继续按原有 Provider 规则保留。Popup 与内容脚本只能获取候选摘要或用户明确选择后的单项字段，无法读取整库、原始数据库、来源信封或私钥。

## 后续非 MDBX 项目

本轮提交完成后，可继续处理以下项目：

1. `provider-transport.ts` 的超时作用域回归。
2. YAOTP 导出二维码时包含 PIN 的问题。
3. `src/passkey/source-policy.ts` 的不可达分支。
4. mOTP 与 Yandex 行为变更记录。
5. Bitwarden 附件下载、Sends、组织库与真实服务端验证。
6. 真实 Android 与 KDBX 双向往返验证。

MDBX 保持暂停，除非用户以后明确恢复该部分。

## 提交规则

仅使用 `main`，直接提交并推送。禁止建立额外分支和拉取请求。提交信息不得包含 AI 署名、`Co-Authored-By` 或生成工具尾注。

M3E 界面继续使用 8px 卡片圆角、16px 对话框、20px 或 24px 图标和至少 44px 交互区域，保持干净紧凑并禁止渐变。
