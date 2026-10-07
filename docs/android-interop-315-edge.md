# Android 1.0.315 互通：真实 Microsoft Edge 验收

本报告仅记录真实 Edge 拓展 UI、Native Messaging 与隔离合成数据。没有使用 Vite 页面、默认 Chromium 或 Chrome 代替拓展验收。Android 应用、真实远端服务及第 11 节总矩阵由总报告单独记录。

## 环境与隔离

- Microsoft Edge **154.0.4258.37**，明确 `channel: msedge` 与 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`。
- 拓展 **0.1.37**，真实 unpacked `dist`，action popup、SIDE_PANEL runtime context、全页 manager。
- Native Host **0.1.2**，本轮 smoke executable SHA-256 `e92a5a27dab53f4e503e9465d50e0e9b9dd2add546dc79cf251793cece724a71`。
- 每轮独立 `.tmp/interop-315-edge/run-*/edge-profile`，进程局部 `LOCALAPPDATA=run/host-appdata`；不打开用户浏览器 profile 或 Host 密码库。
- 仅临时注册 HKCU Microsoft Edge Native Messaging，保存完整原值类型/存在性并在 finally 恢复，验证恢复相等。原文件与合成 profile 保留作复现。
- 每轮 evidence 记录实际 UA、版本、dist manifest hash、Host hash、source HEAD/dirty diff hash及截图。最终以具体 run 为准。

## 已完成基础验收

证据 `.tmp/interop-315-edge/run-VLNSdb/evidence.json`：8/8 通过，注册表恢复成功。

| 项目 | 结果 |
| --- | --- |
| 真实 unpacked worker 与全页加载 | 通过 |
| 实际 UI 创建并解锁本地密码库 | 通过 |
| 真实 `connectNative` host.hello 与 background Host 状态 | 通过 |
| 实际 UI 锁定，锁定后读取拒绝 | 通过 |
| 真实 action popup，200% 根字号横向溢出检查 | 通过 |
| popup 点击打开真实 SIDE_PANEL，侧栏 UI 解锁，200% 字号 | 通过 |
| 关闭并重启独立 Edge profile，保持锁定 | 通过 |
| 错误密码拒绝，正确密码重新解锁 | 通过 |

此轮仅生命周期/握手，不推断数据矩阵通过。截图 01–09 位于同目录。

## 已通过功能验收

`.tmp/interop-315-edge/run-7ssBps/evidence.json`：**10 项功能＋9 项生命周期通过**，注册表恢复成功。

| 真实 UI / Native 范围 | 已核对结果 |
| --- | --- |
| Android 合成 MDBX 导入 | 实际文件选择、密码与 Host 导入；不是模拟 runtime 写入 |
| 两条独立同标题密码 | 两个 stable ID，没有自动分组 |
| 明确分组 | 两成员共享 group ID，OTP、Passkey 绑定元数据、恢复备注共存 |
| GPG / API Key | 新建、详情、编辑后类型与字段保存 |
| 五类内容块 | API_KEY、API_TOKEN、GPG_KEY、SSH_KEY、QR_CODE；分片 SHA、编辑、内容排序、template QR |
| 完整银行卡/笔记副本 | 低频卡片字段、PIN/前导零、完整笔记文本/标签/备注；真实完整副本详情 |
| Native 卡面附件 | UI 上传生成的 72-byte PNG、引用入副本、实际预览解码 2×2、下载 SHA/字节相等 |
| 取消编辑 | 全字段快照未变 |
| 实际 Native 持久化 | UI 同步后 REVEAL 核对 title/head/username/password/group；非仅 cache 保存 |
| 锁定与 Edge 重启 | popup、真实 SIDE_PANEL、200% 字号、错误密码拒绝、重启字段 hash 一致 |

卡面 PNG SHA-256：`77a53bb81fcebd3d0c37d9eb523ad227e465598259c4a230b589a89bbcc89b3d`。已查看 `features-08-full-card-copy-detail.png` 与 `features-09-native-cardface-preview.png` 的实际渲染；2×2 小色点为合成图尺寸，不推断复杂真实卡面视觉质量。单文件 MDBX 导入没有带入原 Android 外置 Blobs，本轮附件结论仅为新 UI 上传附件。

### 实际 Android UI 创建项目 → Edge UI 修改导出

`.tmp/interop-315-edge/run-xEoEh9/evidence.json` 与同目录 `android-ui-return-evidence.json`：通过。实际 Android UI 单条 fixture → Edge UI 导入/详情/修改 username → UI 同步 → Native REVEAL → UI 导出 `edge-ui-return.mdbx`。password/group/title 原值保持。

- 输入 SHA-256：`ec41592e1ac4d297859731e0f18c7724c99085fd7001cd7d82efbea8e3cf5029`。
- 输出 SHA-256：`9f271727e677fe332c4bdc7b5d426a77d9db4d0690c61ed2363c0c726da995ce`。
- 回传 username：`edge-ui-return-用户`；Android 重开/编辑及最终 Edge 重开另记，不从此半程结果推断。
- 此 run 末尾通用 smoke-only limitation 是当时 runner 文案，specific `androidUiReturn` 证据才描述实际覆盖；后续 runner 已修正文案。

## 历史验收迭代（保留失败/未完成记录）

### 新增独立安全验收

- `run-xkYS63`：未来类型真实 JSON UI 导入至隔离 local，1 项功能＋9 项生命周期通过，其他功能明确跳过；不是 Native future-type E2E。嵌套超大整数、Long 最大、-0、null、空串、未来 schema 全部原文本严格一致（SHA-256 `43b765c8bf4ee26104692be8f367df582739c6fc530ac9e82bab9c3b4340f209`）。列表可见且无编辑/删除，原文默认隐藏，详情显式完整查看并可重新隐藏；重启 hash 保持。已实看 `features-11-future-explicit-reveal.png`。
- `run-r7wTgA` 与 `run-Lx6x2N`：整组删除先取消，所有成员 payload hash 不变；确认后 UI 同步，实际 Native 两 tombstone 且 head 更新；两条独立同标题密码仍保留。后者新增 PREPAID 卡类型与 Markdown note UI 验收通过。
- 上述两个全功能 run 整体仍为 **failed**，不能当全通过：已定位并修复 runner 把随机 group 首条当 primary、文件输入 exact accessible name 的选择器问题。另 `run-Lx6x2N` 真实发现 automatic sync 后 GPG UI 草稿保存的 providerRef 缺 remoteId/revision，未通过 Native readback；正由主任务修复并另跑，不掩盖失败。

- `run-8BG2Wu`：独立同标题项目、GPG/API Key 创建编辑、重启持久化通过；两项失败为 runner 对 M3E supporting text 的 exact-text 选择器不匹配，已修。依赖项跳过，不算产品功能通过。
- `run-S4GtTS`：实际 UI 导入 Android 合成 MDBX、独立同标题项目、明确分组＋OTP＋Passkey 元数据＋恢复备注、GPG/API Key 编辑通过。5 类内容块创建、改 Key、排序、二维码均到达实际截图，但诊断时主动关闭浏览器导致后续关闭详情/副本步骤未完成。不能把此 run 当完整通过，也尚未证明新增项目已从本地队列写入 Native MDBX。
- 此轮发现真实控制台缺陷：含冒号的 Android stable ID 被 focus-ring 直接拼入 CSS selector，抛 SyntaxError；已修为 CSS-safe UI ID，后续通过。
- 此轮发现本地 MDBX UI 缺少未配置 WebDAV 时的写入/同步入口；已补入口，`run-7ssBps` 补做 Native 回读通过。
- `run-9u1VSP`：新弹窗 M3E “保存到”选项初始化与选择发生竞态；runner 改为等待组件 `updateComplete` 与 slotted options 更新后真实点击，没有 DOM 强制赋值；`run-7ssBps` 通过。
- 设备绑定 Passkey 只验元数据，明确显示“绑定元数据，不创建签名凭据”；没有声称设备私钥迁移。
- 单个 Android `.mdbx` fixture 不包含外部 Blob，新旧附件覆盖必须区分。后续新卡面测试生成 CRC 正确 PNG，要求真实上传、SHA-256 回读、实际图片解码和下载字节一致。

## 命令

```powershell
node scripts/interop-315-edge.mjs
$env:MONICA_315_MDBX_FIXTURE='C:/Users/joyins/Desktop/Monica-all/monica-extension/.tmp/android-app-interop-315/android.mdbx'
node scripts/interop-315-edge.mjs --features
$env:MONICA_315_ANDROID_UI_FIXTURE='C:/Users/joyins/Desktop/Monica-all/monica-extension/.tmp/android-app-interop-315/android-ui.mdbx'
node scripts/interop-315-edge.mjs --android-ui-return
```

脚本所有项目创建/编辑走 UI，只用只读 runtime message 检查已保存内容。结果逐项 passed/failed/skipped，未测项不记通过。未来类型只读安全查看、整组删除取消/确认及完整 Native 字段比对在后续独立运行补充，不覆盖已有通过证据。


## 2026-10-01 最终复核

`run-D4Rqv9`：12 项完整功能、9 项生命周期通过。`run-L4aBDa`：6 类新建表单 × 桌面/420px，字段无横向越界、保存入口可见、取消后记录不变；3 类真实服务 UI 和9项生命周期通过。Native 注册均恢复。详情已对照 Android 连续分组，GPG/API Key 新建标题显示实际类型，自定义字段计数不再包含内部载体。服务独立读取 3/3 通过，见同目录 `real-services-independent-readback.json`。

真实服务命令：设置 `MONICA_315_REAL_EDGE_FIXTURES` 指向实际服务测试生成的 `edge-fixtures.json` 后运行 `node scripts/interop-315-edge.mjs --layout --real-services`。以输出目录中的 `real-services-ui-return.json` 作为 `MONICA_315_REAL_EDGE_VERIFY`，运行 `npx vitest run --config vitest.real-services315.config.ts tests/interop/real-services315-verify.interop.ts`。

## Portrait KeePass source status

Previous goal turn made verified KeePass metadata progress. This turn returns to portrait M3E UI using frontend-design and current Android DatabaseManagementComponents.kt references (24dp panel,64dp rows,40dp icons). Added editable local Canvas sourcestatus315; final single-page rendering inspected before implementing status rows and again before the information disclosure. Three definition-list rows show connection/offline/cloud-save status, including non-success fallback for missing remote state. Existing encryption/count/protection summary and technical capability explanation move into keyboard-operable Database information disclosure for remote KeePass; local file summary and recovery/conflict alerts remain available. Added7locale strings and regenerated bundled icon subset with pinned project requirements in isolated .tmp/source-status-font-env.

Canvas first2imports failed because the new bottomNav lacked required fields; fixed actual schema (and corners), raw/canvas-source-status-3/4.log pass and canvas-sourcestatus315.png inspected. Original failures retained. Font default Python lacked Brotli; bundled Python lacked fontTools; isolated venv requirement install and generation succeeded (source-status-icons-3.log). Final build source-status-build-3.log passed.

Actual Edge with isolated real Apache KDBX fixture run-D2xjhR: initial run-3xRmcj identified excessive always-visible technical summary height; disclosure revision run-QLrLrv passed, final run-T0gJhi passed1280/420/320 geometry, no overflow, native definition values, keyboard disclosure, lock/restorable/unlock flow and normal9lifecycle checks. Screenshots source-status-420.png and320.png inspected; synchronization/group actions visible. Raw source-status-edge-3.log. NativeMessaging registration restored by runner; Docker helper stopped both services; no AVD started. No full regression rerun for this display-only change; TypeScript/build and real UI checks passed. Remaining source-card width/insets and broader portrait workflows, field/backend matrix and actual Android full return remain open. Goal active/incomplete.

## Source card width and portrait action targets

Previous turn completed source-status UI. Reused the already-rendered sourcestatus315 Canvas symmetrical card layout. Actual Edge measurement reproduced the double-padding defect: left20px/right60px at1280px (source-insets-red.log,run-0ZHUB1). Existing global slot width subtracted the card's padding a second time. Scoped source-card content width to100%, matching the existing login-card correction, without changing other card families.

Portrait source actions now have48px minimum visible/click targets. First test exposed44px despite low-specificity CSS (source-insets-edge/edge-2.log); fixed actual #root specificity plus --app-control-height and icon host/container dimensions. Final build source-insets-build-2.log and real Edge run-pvBJrg/source-insets-edge-3.log pass1280/420/320 balanced insets, no horizontal overflow, all source action target dimensions, keyboard disclosure, actual Apache-backed lock/restore, and9lifecycle checks. Final320/420screenshots inspected. No UI-only unit tests added. NativeMessaging restored by runner; Docker stopped, no AVD started. Broad Android field/backend/portrait objective remains active/incomplete.
