# Android 1.0.315 Native Host / MDBX 实施与验证记录

基线日期：2026-09-30。本文记录实际实现和证据，不代表完整第 11 节验收已通过；Edge 界面、Android UI、真实 WebDAV、ZIP、KeePass、Bitwarden 分别见总报告与对应后端报告。

## 版本与可复核来源

| 项目 | 固定值 |
| --- | --- |
| 拓展 Git 基线 | `11f712e5599eb439a6d108b918b620918f50d117`，本次更改未提交 |
| Android main Git 基线 | `a19912fb3a521a930400d8a1461f81eb8f65595d`，1.0.315 未发布；用户 dirty 工作树未修改 |
| Native Host | `0.1.2`，Native Messaging protocol `2` |
| 引擎 commit | `90005c8c608c952093a4522ffa507a562e2e39a4` |
| Android 运行时 overlays | read-session-lifetime、sync-delta-limits、json-precision、json-literal-keys |
| crate / hello engine version | `0.2.0`；Android 运行时名称 MDBX3 `3.0.0-alpha.1` 不等于 crate 版本 |
| 磁盘格式 | `MDBX-2`；不支持 MDBX1 自动导入 |
| Rust（Host 目录） | `1.86.0 (05f9846f8 2025-03-31)`、`x86_64-pc-windows-gnu`、LLVM 19.1.7 |
| debug Host SHA-256 | `e92a5a27dab53f4e503e9465d50e0e9b9dd2add546dc79cf251793cece724a71` |
| ENGINE-PROVENANCE.json SHA-256 | `cb8ec378821af8ce46fd86ede9246654d9dd51f7edda23c7a755b0d326e90a53` |

引擎固定源码位于 `native/mdbx2-host/vendor/mdbx`：180 个上游文件，12 个最终 overlay 文件与 Android provenance 核对一致。四份原始 patch 在 `runtime-patches`，完整归一化文件哈希在 `ENGINE-PROVENANCE.json`。保留了上游许可与公开合成 golden vault。未执行发行打包、发布或标签操作。

## 已实现的边界

- JSON：Host 请求 params 使用 RawValue 与引擎无损解析器；payload 的大整数、高精度小数、Unicode、空值与 `$serde_json::private::Number` 等字面键不被当内部标记。拓展 codec 复用无损 JSON 模块。
- 身份：已有原生 UUID 通过 `native:<UUID>` 路由；历史 logical ID 映射保留。API Token 维持 `api-token:<UUID>` 路由。不存在或已删除的 native 对象不被重新创建，不能改对象类型或 `monica_entry_id`。
- 修订：object reveal 返回 head；upsert/delete/batch 支持 `expectedHeadCommitId`。当前 Host 能力门禁防止旧 Host 忽略新参数。批处理先检查全部项，再执行一次引擎事务；已提交重试先识别 durable receipt，避免重试被自身新 revision 拒绝。
- 数据安全：单项保存即使经历 worker 重启，也重读原始源对象并检查 revision，按编辑投影 patch；读取失败或 summary/record 不一致中止整次 reconcile，不能把部分列表当删除信号。
- 未知数据：未来类型/高 payload version 投影为可见 opaque 项，原始 payload 可安全只读查看；普通编辑/删除/批量传输阻止改写。Host 同样阻止这些对象的附件上传开始、提交、删除，保留附件读取能力。
- API Token：Android custom field signed Long ID 使用安全整数或十进制字符串投影，写回精确 JSON 数字；校验完整 i64 范围及重复 ID。标签、嵌套未知字段和空值保留。同步指纹区分真实大整数与字面 `rawJSON` 对象。
- Steam：仅识别实际原生类型 `steam-mafile`，不猜大小写/下划线别名。仅改标题不改变 maFile 原串或原生空值/缺省形状。Android SecureItem Steam 即使包含 maFile 元数据也仍写回原生 `totp`。
- 项目操作：同库 Collection move 保留 UUID/显式分组；选择一个组成员会展开同库显式整组，复制时分配新的共享 group ID，避免并回源项目。整组删除使用完整成员 ID/updatedAt 快照，一次加密持久化并为全部成员排队，保留原有单项删除语义。
- 手动拓展 JSON 导入：已知字段补齐 GPG/API Key/Steam、银行卡补充字段、历史、卡面、证件 title、笔记自定义字段、Passkey 高水位；optional null、原字符串和普通未来字段保留。未来 discriminator/不兼容字段形状转 opaque。未知 raw 数字不能安全进入普通 model 缓存时转只读原串；HOTP 与 API Long ID 有明确精确投影。
- SecureItem 自定义字段：实际复现并修正了只编辑 A 字段时 B 的 null/大整数被投影默认值覆写、空 label 字段丢失的问题；按成员编辑基线只补丁更改的键，未投影条目留在数组原位置，重命名保留扩展元数据。回归包含重复名称、显式删除和已完整合并的副本再次写入。
- 本地 MDBX 导出：新增 manager-only begin/read/release 会话，使用独立随机 sync binding，不修改已配置 WebDAV state。绑定 Edge documentId、provider 与 vault handle，每个异步阶段后复查解锁及待写入队列/冲突；最多 4 会话、固定 5 分钟、512 MiB/256 KiB 分块，锁定/恢复/库锁定/移除使句柄失效。任何活动/已删附件、外部 Blob 或不能证明为零的统计均拒绝，不把不完整数据库当完整备份。Edge UI 与最终全文件摘要检查由主流程单列验证。
- 本地 MDBX 自动落盘：原自动同步资格仅接受完整 WebDAV 配置，已通过提取 `mdbx2AutomaticSyncEligible` 修正为已连接的本地库或已注册的完整云端库；继续复用既有 `syncLocal`、enabled/paused、`readState(false)` 和锁定门禁，不自动解锁。
- 自动同步与编辑并发：真实 Edge 暴露了 create 确认仅补齐远端引用、不改 `updatedAt`，随后旧草稿可通过 CAS 却覆盖掉新 remoteId/revision 的竞态。单项及整组普通编辑现在从 state 采用仍选中、同 provider 的完整权威引用；新目标/新成员仅接受 providerId，不继承其他库的 remoteId/folder/revision/etag。不存在/重复 provider 拒绝；原目标尚有 pending 时拒绝切换以避免孤立队列，完成同步后可切换。独立 sync/已完成 transfer 的权威采用接口保留，未改 App。
- 原生回读与草稿版本：通过 Provider→加密 service 的确定性测试复现了写入确认后回读替换本地 `updatedAt`、新建确认遗漏内部路由造成无编辑重复写入，以及真实远端更改但原生时间相同会漏过草稿 CAS 的三个问题。已确认的相同 Object/head 回读保留本地编辑版本，API Token 标签额外比较无损内容；新 head／独立标签更改则单调推进版本，即使原生时间倒退或相同也拒绝旧草稿。create ACK 补齐未设置的 `replicaGroupId`／`mdbxFolderId`，不覆盖请求期间的显式本地路由编辑。整组保存的 CAS 条件没有放宽。

## 已运行的检查

| 检查 | 结果 | 范围说明 |
| --- | --- | --- |
| `cargo test --locked`（Host 目录） | 58 通过，0 失败，0 忽略；80.24 s | 真实 vendored 引擎、事务、身份、修订、精度、附件、重启、安全边界；不是 Android UI/Edge 证明 |
| `cargo build --locked`（Host 目录） | 通过 | 上表 debug Host |
| `cargo clippy --locked --all-targets -- -D warnings` | 通过；37.34 s | 自有 Host 与固定依赖检查 |
| `node scripts/verify-mdbx2-host.mjs` | 通过 | 来源文件/patch 哈希、能力与协议门禁 |
| `npx vitest run src/providers/mdbx2 src/core/api-token.test.ts src/security/password-group-delete.test.ts` | 21 文件、132 通过 | codec/provider/batch/native-client/组删除回归；不等于真实服务 |
| `npx vitest run src/manager` | 7 文件、41 通过 | 手动导入及相关 manager 功能 |
| `npx tsc -b --pretty false` | 通过 | 当前拓展 TS |
| `npx tsc -p tsconfig.interop.json --pretty false` | 通过 | 真实过程 runner 类型检查 |
| `npx vitest run --config vitest.android315-native.config.ts`（forward） | 1 通过，0 失败；4.53 s | Android 应用真实导出 → 实际 Host + 拓展 Provider → 配套 bootstrap/Blob；非 Edge UI |
| 附件上传前后父对象 revision 回归 | 1 通过 | 实际引擎确认附件 commit 不改变父 Object head；UI 不应把附件 commit 当父项 revision |
| 真实 Android 单文件缺 Blob 故障测试 | 1 通过；名称过滤跳过 forward 1 项 | 3 个附件全部 `attachment-integrity-failed`，20 个对象内容/身份/修订不变；独立 `native-missing-blob-evidence.json` |
| SecureItem 字段精细合并回归及 MDBX/钱包/KeePass/WebDAV | 23 文件、170 项通过 | 新增 3 个回归，先复现失败后修正；不能与前述包含关系重复相加 |
| `src/providers/mdbx2/local-file-export.test.ts` | 7 项通过 | 私有 binding、owner/provider、TTL/大小、锁定/异步授权变化、附件/Blob拒绝、分段身份与未同步队列 |
| `src/background/automatic-sync.test.ts` | 12 项通过 | 新增本地/完整与不完整云/无 vault handle 3 项，原 9 项 scheduler 回归保留 |
| 实际进程本地无附件导出 smoke | 1 项通过 | `android315-local-export.interop.ts` 使用 Android UI 合成单条源库，分块 SHA/源 hash 不变、导出重开全记录一致；非 Edge UI |
| `src/security/stale-provider-ref.test.ts` | 11 项通过 | 单项/组旧草稿、伪造/跨库refs、新成员/副本、移除provider、重复引用、CAS及未完成同步切换保护；原2项及新增边界先RED再GREEN |
| `src/providers/mdbx2/mdbx2-readback-cas.test.ts` | 4 项通过 | 初始3项均RED后GREEN；另覆盖未知字段变化的新head仍使旧草稿失效；Provider/service联动，非Edge替代 |

最新同次 scoped 合并回归（MDBX、API Token、整组删除、manager）为 28 文件、173 项通过；上表分项有包含关系，不应相加作为全仓总数。

后续扩大检查 `npx vitest run src/providers src/security/password-group-delete.test.ts src/manager src/core/password-content.test.ts` 为 88 文件、925 项通过。新增本地自动同步之后定向 3 文件/22 项通过，`npx tsc -b --pretty false` 与 interop TS 再次通过；仅无损合并和新本地导出相关 broad run 不能等同全部浏览器验收。

providerRefs 竞态修正后 `npx vitest run src/security src/passkey src/background/automatic-sync.test.ts` 20 文件/181 项通过；最后增加未完成队列的换目标保护后定向 3 文件/18 项通过，TypeScript 再次通过。旧 WebDAV 冲突测试改用 `applyProviderSync` 建立已同步远端 fixture，原断言不变；新建 UI 项不能再用输入 remoteId 伪造已同步身份。真实 Edge 修正回归由浏览器 agent 后续报告，不能把本节单元结果当浏览器通过。

回读 CAS 修正后，`npx vitest run src/providers/mdbx2 src/security src/passkey src/background/automatic-sync.test.ts` 为 **41 文件／310 项通过**（18.42 s）；`npx tsc -b --pretty false` 与 scoped `git diff --check` 通过。API 标签原生 head 不变时编辑版本仍变化，下一次未变化回读则保持版本。首次扩大检查发现三个旧 batch-transfer fixture 也经 UI create 伪造 remoteId，已改用 provider adoption 建立已同步状态，所有原始传输断言保留。已交给真实 Edge 五内容块二次保存验收，不先行记作浏览器通过。

TDD 流程先复现了 Steam 未编辑字段重写、SecureItem Steam 被错误识别、API 指纹 raw-number 混淆、组选择不展开、组复制身份复用、附件只读旁路和手动导入丢字段，再加入修正。未运行覆盖率统计，不能声称达成 80% 覆盖率。

## Android 应用 fixture / Native Host 实进程往返

可重复 runner：`tests/interop/android315-native-process.interop.ts`，独立配置 `vitest.android315-native.config.ts`。必须显式指定真实 Android fixture 目录，缺文件时显示 skip，不创建模拟替代数据、不启动 AVD。

```powershell
$env:MONICA_315_APP_FIXTURE='C:/Users/joyins/Desktop/Monica-all/monica-extension/.tmp/android-app-interop-315'
$env:MONICA_315_NATIVE_PHASE='forward'
npx vitest run --config vitest.android315-native.config.ts
# Android 读取 extension.mdbx + extension-blobs 后输出 android-return，再运行：
$env:MONICA_315_NATIVE_PHASE='return'
npx vitest run --config vitest.android315-native.config.ts
```

runner 使用真实 Host EXE 的 Native Messaging 帧协议及独立 LOCALAPPDATA 子进程环境，不修改系统环境或用户 Host 工作区。forward 核对 Android app 导出 payload、通过拓展 Provider 逐项仅改标题、拒绝过期 revision、新建合成登录、锁定和进程重启/错密码/重开、附件明文字节哈希、引擎 bootstrap 与独立 Host 重读；return 核对 Android 后续编辑与其余字段。

初次实际运行失败已复现：仅传 `android.mdbx` 时 `attachment-integrity-failed`，尚未写任何条目。原因是当前引擎 `BackupService::create_portable_copy_from_connection` 只复制数据库，而 Android `upsertAttachment` 使用 external Blob；单文件没有配套 Blob。没有绕过完整性检查。后续 runner 使用 Android 实际导出的 Blob manifest/密文字节，通过现有 `sync.blob.receive` 和 `sync.blob.read` 传递并校验 SHA-256。它证明的是“bootstrap + 配套 Blob”的文件传输，不是“单个 MDBX 文件含全部附件”，也不是已通过真实 WebDAV。

最新 forward 已通过：20 条实际 Android 项目（10 login、5 OTP、card/note/document/address/payment 各 1）全部经拓展 Provider 改标题，payload 其余字段保持一致，逐项拒绝旧 revision；另新建 1 条拓展登录。两份 68-byte PNG 与一份 48-byte 笔记附件均完整读取，锁定、进程重启、错误密码拒绝后重开、独立 Host 对输出 bootstrap+Blob 重读均一致。上述 20 条不包含独立 Passkey、API Token 或原生 Steam maFile，不能扩展结论。

Android 应用 `-75` 回程文件已通过真实 Host 读取，并逐项汇总全部差异：21 条的 native object ID、Collection、类型、payload version、标题、删除状态均一致；3 份附件的身份、长度和明文 SHA-256 均与 forward 一致。20 条未编辑记录的 payload 与 head revision 完全不变。唯一编辑记录如下：

| 字段 | 拓展输出 | Android 回程 |
| --- | --- | --- |
| Object ID | `43f76396-2546-3fbd-a76a-0a6982283b1f` | 不变 |
| `monica_entry_id` | `password:59524` | 不变 |
| `notes` | 合成恢复备注 | 按要求追加 `\nAndroid roundtrip edit` |
| `room_id` | `59524` | `59648` |
| head revision | `cacdb82d-7736-49f4-96df-b518fba30462` | `b7dbf7d4-a935-4442-8128-67a762deb7b9` |

该本机 Room ID 重绑定符合实施规范中“Room ID 与稳定对象身份分别管理”的边界，但不是逐字不变。严格 runner 的“除备注外所有 payload 相同”断言仍保持 **1 失败、1 按 return phase 跳过**（缺 Blob 故障用例仅 forward 运行）；没有忽略 `room_id`、未把结果冒充全量无损通过。全部逐字段及 revision 对照落盘于 `native-return-evidence.json.returnComparison`，实际 Host 披露记录为 `native-return-records.json`。本次仅使用已交付文件，未启动或操作 Android 设备，源 MDBX hash 未变。

| 实际文件/内容 | SHA-256 |
| --- | --- |
| Android 输入 MDBX | `52f0bc2b701bcbad52fc484243b507fbc9bfd058147074c6a58b50b7fc7b4800` |
| 拓展输出 bootstrap MDBX | `ad9adb1ecb5d345a1d311c8f06a62e8237fd1cf0340530e177a50a9781073566` |
| Android 回程 MDBX | `bb3cf700adcc49a9cfb8bee3453fad977e5de335ad00b89638830aeac7f091b0` |
| 回程 Host 披露记录 JSON | `1936c974dd70646a699423a25b98e233ad351ae86bf3f7fce79471fd898f9515` |
| PNG 明文（两份独立附件） | `5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15` |
| 笔记附件明文 | `67b83d22c8cffd6f9651ad3ef01a01a9ec1a93d0ad0e86b3d993d1d8831310de` |

证据目录包含 `native-forward-evidence.json`、`native-return-evidence.json`（相应阶段运行后生成）、Android app 报告、records 与 Blob manifest。首版 PNG CRC 问题已在最新 fixture 修正；字节测试仍不等于 UI 图片预览测试。实际 Android 安装版本为 `1.0.315-26093012-31`；导出期间外部会话改变 Android dirty 源码哈希，`export-evidence.json` 明确记为 `androidSourcesUnchanged:false`，不能宣称运行 APK 与此刻源码完全一致。最终状态以总报告和最新 evidence 为准。

新增 `native-local-export-evidence.json` 记录实际 `android-ui.mdbx` 的独立进程导出 smoke：输入与输出 SHA-256 同为 `ec41592e1ac4d297859731e0f18c7724c99085fd7001cd7d82efbea8e3cf5029`，1 条 Object 的 ID/type/payload/revision 重开一致。本测试没有修改该源或覆盖 `extension.mdbx`/Blob；只证明无附件文件导出 API 可用，Compose UI 完整断言与 Edge 真正点击下载另见对应证据。

## 未完成/必须单列的限制

- Android UI ↔ Edge popup/side panel/全页、实际 Native Messaging、真实 WebDAV 分段/Blob、ZIP 全量恢复、KeePass/Bitwarden 服务验收不能由上述单元测试替代。
- 跨库 move 对没有历史 logical ID 的原生对象，目标创建协议尚不能证明保持同一 native UUID；同库 Collection move 与跨库 move 不混报。
- 当前固定 FFI 的 Object record/summary 只暴露 `updated_at`，没有 `created_at`。首次导入以修改时间投影本地创建时间，之后保留缓存中的创建时间；底层 update 不重置原生创建时间，但缓存重建后的 UI 精确创建时间未实现，需上游补只读元数据接口。
- Host revision 检查位于串行 Host 请求、私有工作副本的一次引擎事务之前；未验证两个 Host 进程同时打开同一持久工作副本的跨进程 CAS 竞争。
- Passkey 元数据编辑不等于签名或私钥可迁移。设备引用与不可导出私钥仍按现有能力边界处理。
- Android 实际普通密码写入缺 Wi-Fi metadata/自定义图标/旧 SSO provider/ref 等字段及未来字段写回结果由 Android app evidence 单列；未擅自修改 Android 主仓库。
- 未测故障矩阵不得计为通过；此报告没有“100% 互通”的结论。

## 关联笔记整组移动（2026-10-01）

已接入关联笔记的移动；唯一稳定绑定检查仍保留。真实 Native 的两个密码、一个共享笔记、三个附件，跨库写入响应丢失和源删除后保存失败均能在 Host/加密本地存储重启后恢复；同库移动同样恢复，UUID、绑定和附件字节保持一致。真实 Edge `run-EYTP5E` 验证整组恢复、明确确认、取消、键盘、420px 布局和 Native Messaging，截图已检查。证据 `.tmp/linked-move-native-20261001/linked-move-evidence.json`。Android 整组关系回读仍待验证，不以单条附件往返替代。167个文件1574项测试及构建通过。

## 离线品牌图标资源

项目图标库复用 Android 已打包的 Stratum Auth app v1.4.0 `icons` / `extraicons`，GPL-3.0。包含837个逻辑图标、1078张明暗PNG，来源和逐文件SHA256见 [brand-icons-provenance.json](brand-icons-provenance.json)。资源随扩展离线提供，图标选择不会向第三方发送账号信息。Android 参考说明位于 Monica-main/Monica for Android/README_ZH.md 的图标资源条目，上游 https://github.com/stratumauth/app/tree/v1.4.0 。可用 scripts/import-android-brand-icons.mjs 从现有 Android 素材重建。

### SSO metadata follow-up (2026-10-01)

Extension Native codec now reads/writes `sso_provider` and `sso_ref_entry_id`, reads legacy camelCase aliases, and preserves unchanged source shapes. Explicit null prevents a legacy ID from reappearing after unlink. Actual isolated Native Host test verifies create/read and change/unlink through two restarts (`.tmp/sso-native-20261001/evidence.json`). Full 1580 unit tests and build passed. This does not resolve Android writer omissions or cross-database reference remapping: `ssoRefEntryId` is a local Android Room ID, not a portable identity. Those remain incomplete.

Stable SSO groundwork: extension now preserves `ssoRefLogicalId` / native `sso_ref_logical_id` independently of the numeric Room reference. Scope/uniqueness/cycle checks are implemented, but not yet wired to the picker or dependency transfer. Android support for this new stable field is not claimed. Until transfer remapping is implemented, stable SSO links retain their source through a transfer guard. Native persistence proof: `.tmp/sso-logical-native-20261001`; unit/build: `sso-links-all.log`, `sso-links-build.log`.
