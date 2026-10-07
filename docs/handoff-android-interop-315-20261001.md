# Monica Android ↔ 浏览器扩展交接（2026-10-01）

用户最新要求：先收尾一个阶段，写交接文档，由另一个 AI 继续。当前停在“跨库／同库移动的持久化恢复，以及同库附件归属修复”阶段。**整体 Android 对齐目标尚未完成，不要标记 goal complete。**

## 接手入口

- 工作区：`C:/Users/joyins/Desktop/Monica-all`，实际修改项目：`monica-extension`。PowerShell，Windows，本地工具可执行。已有大量未提交和未跟踪文件，必须保留，不能 reset/clean 或重建覆盖。
- 总目标：浏览器扩展成为 Android 对应版，所有密码字段与内容可双向互通，创建／详情／编辑／分组／附件／后端操作完整，并落实 M3E 设计与真实 UI 验证。
- 先读项目规则及任务规格：[SPEC](C:/Users/joyins/Desktop/Monica-all/monica-extension/.codex-tasks/android-interop-315/SPEC.md)、[TODO](C:/Users/joyins/Desktop/Monica-all/monica-extension/.codex-tasks/android-interop-315/TODO.csv)。历史过程和精确证据索引见 [PROGRESS](C:/Users/joyins/Desktop/Monica-all/monica-extension/.codex-tasks/android-interop-315/PROGRESS.md)，优先从末尾往前读。
- 当前 goal 应保持未完成；不要把绿测等同于全字段、全后端或 Android 页面验收。上一阶段是实际进展，不是阻塞状态。

## 刚收尾的阶段

1. 加密保险库内保存移动日志：`writing → prepared → completed`。写入前冻结原始请求、源快照、目标写入内容、原始 JSON 文本与操作 scope；大整数／高精度数字通过 `parseLosslessJson` 保留。来源删除和本地接纳之间的失败也可恢复。
2. 跨库移动：目标提交后丢响应／回执、附件中断、阶段保存失败，以及来源删除后本地保存失败，均有测试。真实 Native 使用两个库、附件、Host 重启和磁盘加密 envelope 验证；真实 Edge 已验证从备份恢复的 writing 记录、解锁、确认、取消、键盘焦点与窄屏。
3. 同库移动：写入前保存附件摘要，恢复不再查询旧文件夹，原 UUID 和原生 CAS 条件保留，不发送来源删除。
4. 真实测试发现固定引擎的 `EntryRepo::move_to_project` 只移动对象，未同步附件的 `project_id`。现在在同一事务内移动活动的条目附件，保留附件 ID、内容哈希、Blob 引用；记录附件版本、合并提交父节点。项目级附件不移动。回滚和幂等已测。
5. `supportsAtomicObjectAttachmentMove` 能力已加入 Host hello、TS 解析与 Native client。原生对象写入指定 Collection 时，旧 Host 在写入前被拦截并提示更新（包含批量）；英文和六种离线语言已补齐。此检查较保守：指定 Collection 的原生编辑也要求新版 Host。

核心实现入口：

- `src/core/mdbx2-move-journal.ts`
- `src/security/secure-vault-service.ts`：stage、prepare、applyCompletedMdbx2Transfer
- `src/providers/mdbx2/mdbx2-batch-transfer-coordinator.ts`：resumeWriteIntent、resumeFinalization、partitionWork
- `src/providers/mdbx2/mdbx2-transfer-attachments.ts`
- `src/components/Mdbx2PendingMoves.vue`
- `native/mdbx2-host/vendor/mdbx/crates/mdbx-storage/src/repo/{entry,attachment,operation_coordinator}.rs`

## 引擎来源必须保持诚实

Android 主工程没有修改。扩展 Host 使用原固定 commit 加四个 Android 覆盖补丁，再加 **单独的扩展侧补丁**：

- [补丁](C:/Users/joyins/Desktop/Monica-all/monica-extension/native/mdbx2-host/runtime-patches/extension-entry-attachment-move.patch)
- [来源记录](C:/Users/joyins/Desktop/Monica-all/monica-extension/native/mdbx2-host/ENGINE-PROVENANCE.json)
- [Host 文档](C:/Users/joyins/Desktop/Monica-all/monica-extension/native/mdbx2-host/README.md)

`provenance.files` 仍是 Android 原始基线；`extension_overlays` 单独记录补丁哈希、base_files 和最终 files。验证器按覆盖链校验，不再声称当前三个文件与 Android 相同。反向应用补丁已重建三份精确 Android 基线哈希。不要重跑旧 vendor 拷贝流程把扩展修复覆盖掉，也不要随意改基线哈希让校验变绿。

需要再改补丁时，原始文件副本在 `.tmp/same-vault-overlay-base/`；生成器 `.tmp/create-attachment-overlay.mjs`，重建检查 `.tmp/verify-attachment-overlay.mjs`。先审查它们再运行，不能把已修改文件当作新 Android 基线。

## 本阶段证据

以下路径均相对 `monica-extension`：

| 检查 | 结果／位置 |
|---|---|
| 扩展全量测试 | 167 文件，1573 测试通过；`.codex-tasks/android-interop-315/raw/attachment-phase-all-tests.log` |
| 扩展构建／类型／资源 | 通过；`raw/attachment-phase-build.log`（同上 raw 根目录）；现有 bundle-size 提示仍在 |
| 新核心事务测试 | 通过；`raw/move-attachment-core-test.log`；覆盖回滚、同一 commit、版本、父节点、项目级附件和幂等 |
| Host 全量测试 | 58 项通过，82.33 秒；`raw/attachment-phase-host-tests.log` |
| 真实 Native 最终往返 | 通过；`raw/attachment-phase-native.log` |
| 同库证据 | `.tmp/attachment-phase-final-20261001/same-vault-resume-evidence.json` |
| 跨库证据 | 同目录 `move-resume-evidence.json` |
| 补丁验证 | `node scripts/verify-mdbx2-host.mjs` 通过；反向补丁重建原始哈希通过 |
| 真实 Edge 早期恢复 | `.tmp/interop-315-edge/run-5sIgNT/evidence.json`，`raw/move-prewrite-edge.log`；当时跨库 writing UI 已通过 |

Edge 证据是在新增核心补丁和新 capability 前取得，**不是最终补丁的 Edge 同库验收**。最终补丁有真实 Native 证据，但 Android 当前 APK 的同库移动回读仍须做。真实 Native 测试是合成库，不是用户库，也不是完整 Android 屏幕验收。

旧失败日志不要删除：`move-samevault-native*.log` 与 `.tmp/move-samevault-native-20261001-diagnostic/same-vault-attachment-location.json` 记录修复前的真实缺陷。当前失败已由最终通过证据替代。

## 下一位 AI 的行动顺序

1. 读最新 PROGRESS/TODO 并核对工作树、进程状态；不要重复做已完成的排查。
2. 优先补本阶段最终 Edge 同库恢复和 Android 应用回读：当前实际 Native fixture 已有同库阶段，但 Edge recovery runner 默认解锁两个不同库，同库应按去重后的 provider 数处理。若导出同库中断现场，必须在后续恢复前另存锁定 Host 工作副本，避免后续操作改变 fixture。
3. 继续完整关联组移动：多密码＋稳定关联笔记的组恢复、附件与原生原子删除验证仍需补齐。**linked-note move guard 尚未移除**，只有直接真实证据充分后才能解除，不能以单密码测试推导。
4. 按 TODO 的 16／18／19／20／21／23 等未完成项补全 Android 密码字段、当前 APK 屏幕流程、全部类型及 ZIP／KDBX／Vaultwarden／WebDAV 的双向与失败矩阵。旧矩阵有 PARTIAL，不能视为完成。
5. 最后逐项审计总目标，再决定是否完成。必要的最新版本与源码差异以本地当前 Android main 为准，不要只引用旧截图或旧 APK。

已有钱包卡面与 M3E 页面、字段映射和稳定笔记关系的历史工作不要重做，具体实现／证据从 TODO 对应行追踪。整体差异表：`docs/android-interop-315-gaps.md`。

## 常用命令

在 `monica-extension` 下运行：

```powershell
npx vitest run --maxWorkers=4
npm run build
node scripts/verify-mdbx2-host.mjs
cargo build --locked --manifest-path native/mdbx2-host/Cargo.toml
cargo test --locked --manifest-path native/mdbx2-host/Cargo.toml
cargo test --locked --manifest-path native/mdbx2-host/vendor/mdbx/Cargo.toml -p mdbx-storage entry_move_relocates_attachments_in_one_replayable_commit_and_rolls_back_failures
```

真实 Native 场景：

```powershell
$env:MONICA_315_PROOF_SOURCE='C:/Users/joyins/Desktop/Monica-all/monica-extension/.tmp/android-app-parity-20261001/android.mdbx'
$env:MONICA_315_PROOF_TARGET='C:/Users/joyins/Desktop/Monica-all/monica-extension/.tmp/android-app-interop-315/android-ui.mdbx'
$env:MONICA_315_PROOF_OUTPUT='C:/Users/joyins/Desktop/Monica-all/monica-extension/.tmp/next-ai-attachment-check'
npx vitest run --config vitest.android315-native.config.ts tests/interop/android315-attachment-proof.interop.ts
```

上述文件只作合成输入，runner 创建独立 Host 目录。不要换成用户实际密码库。默认 Vitest 全量不包含 `*.interop.ts`，不能用它代替真实 Native 验证。默认过高并发曾造成 5 秒超时，保留超时限制而用 `--maxWorkers=4` 后全量通过。

## 环境、授权和工具边界

- 不提交、发布、打标签或交付 APK，除非用户再授权。本阶段未做这些操作。
- Android main 保持不改；如需 Android 侧修复，记录复现和建议，不能默默修改规格。
- UI 设计必须先用本地 M3E Canvas：根目录 `.tools/start-m3e-canvas.ps1`，`http://127.0.0.1:5186/`。草图及本地链接：`docs/design/android-interop-315.m3e.json`、`docs/design/android-interop-315.md`。不访问线上站点。
- Android 只复用公共 AVD `Monica_Issue136_API_32`，先检查是否运行；不要清数据。本阶段未启动 AVD。
- 真实扩展测试用 Edge，独立测试 profile；runner 临时改 Native Messaging 注册并恢复。不要改用户 profile 或长期注册。
- 未获明确授权不启动子代理、不向其他聊天发消息。本次只交付文档，没有创建新聊天。
- 建议技能：继续按需使用 `taskmaster` 跟踪现有任务；涉及设计时用 `frontend-design` 并服从本地 M3E 约束；棘手回归可用 `diagnose`。避免重新初始化任务表或复制现有文档内容。

交接时本阶段启动的构建、测试、Native 进程均已结束，未留下本阶段启动的 AVD 或浏览器。已有本地 Canvas 服务是此前复用的服务，不要因为交接随意停止它。没有将整体 goal 标记为完成；用户要求在这个阶段交接，当前 AI 不再扩展新工作。
