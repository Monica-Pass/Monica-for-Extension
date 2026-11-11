# Monica Extension 文档索引

`docs/` 全部 320 篇文档的分类索引。常青参考是维护与发版随时查阅的入口；编号过程记录（316–321 等阶段标记）按主题归组，保留原始决策与验证细节；历史开发记录（`RELEASE-0.1.36`–`0.1.45`）与验证记录（`VALIDATION-0.1.24`–`0.1.45`）已分别归档至 `releases/` 与 `verification/`。

> 机器可检索的解决方案库位于 `docs/solutions/`（YAML frontmatter：`module`、`tags`、`problem_type`）；共享领域词汇见仓库根 `CONCEPTS.md`。
>
> 新增 `docs/` 文档时同步登记到对应分组；分组计数与全覆盖由 `src/docs-index-coverage.test.ts` 守护。

## 常青参考（24）

维护与发版随时查阅的规范、政策与流程文档。

- [ANDROID_BACKUP_COMPATIBILITY.md](ANDROID_BACKUP_COMPATIBILITY.md) — Android WebDAV 备份格式兼容契约：功能组状态矩阵、字段保留要求与验收证据，改备份编解码时核对。
- [ARCHITECTURE.md](ARCHITECTURE.md) — 信任边界、加密信封、后台/内容脚本数据流等核心架构约定；排查填充、锁定、帧校验或加解密行为时先查此篇。
- [BITWARDEN_INTEROPERABILITY.md](BITWARDEN_INTEROPERABILITY.md) — Bitwarden/Vaultwarden 服务端合同验收差异清单；跑互操作测试或改同步协议时核对。
- [CLI-INTEGRATION.md](CLI-INTEGRATION.md) — CLI 联动开关、本机助手安装、可管理范围与会话/回执安全边界；中英对照，接入或排查 CLI 宿主时查。
- [COMMERCIAL_ACCEPTANCE.md](COMMERCIAL_ACCEPTANCE.md) — 商业需求逐条追踪矩阵：实现/自动化证据、审计快照与已知边界；验收发布候选或核对原始需求覆盖时查。
- [DATA_SAFETY.md](DATA_SAFETY.md) — Chrome/Edge 商店数据安全问卷的申报底稿：数据类别、传输共享与安全实践表述；提交商店或改数据行为后更新。
- [FIREFOX.md](FIREFOX.md) — Firefox 构建、签名与附加组件 ID、本机助手及 OneDrive 回调差异，test:firefox 验证范围。
- [KEEPASS_ANDROID_INTEROPERABILITY.md](KEEPASS_ANDROID_INTEROPERABILITY.md) — KDBX 互通以 Android Kotpass 为权威：密码套件边界、Passkey 双格式与互操作验收命令。
- [LOCALIZATION.md](LOCALIZATION.md) — 八种界面语言的支持范围、词库机制与验证命令；新增语言、改文案键或处理语言回退时查。
- [MDBX2_EXTENSION_ARCHITECTURE.md](MDBX2_EXTENSION_ARCHITECTURE.md) — MDBX2 接入架构决策：版本边界、WebDAV 对象树、Native Host 职责划分；改引擎分工或同步结构时查。
- [MDBX_KEEPASS_BITWARDEN_HANDOFF.md](MDBX_KEEPASS_BITWARDEN_HANDOFF.md) — 交接快照：MDBX2/KeePass/Bitwarden 功能组完成状态与证据索引，新接手维护时了解全局。
- [PASSKEY_COMPATIBILITY.md](PASSKEY_COMPATIBILITY.md) — Passkey 各来源计数与数据策略：本地、文件库、WebDAV 快照与 Bitwarden 的计数迁移和回退保护。
- [PASSKEY_COUNTER_REVIEW_FOLLOWUP.md](PASSKEY_COUNTER_REVIEW_FOLLOWUP.md) — 独立审查后 Passkey 计数回退的修补与验证记录；查 signCountHighWaterMark 保护时用。
- [PERFORMANCE.md](PERFORMANCE.md) — 0.1.27 性能优化测量：V8 堆/DOM/资源字节对比与实现手法；做性能回归或列表分页优化时参考。
- [PERMISSIONS.md](PERMISSIONS.md) — 逐项权限的用途与「不会做什么」承诺、主机范围与脚本说明；改 Manifest 权限或写商店/隐私声明时核对。
- [PRIVACY.md](PRIVACY.md) — 隐私政策：处理的数据类别、本地加密存储、页面访问与授权网络传输范围；商店申报和用户咨询时引用。
- [RELEASE-NEXT.md](RELEASE-NEXT.md) — 未发布改动的登记入口：指向下一版 changelog，记录当前版本与归档规则；升版切版时从这里更新。
- [RELEASE.md](RELEASE.md) — 可复现发布全流程：版本号规则、环境、release:check 门禁、Preview 与附件上传规范；发版前必读。
- [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) — 威胁模型与安全不变量：受保护资产、各组件信任级别、网站图标请求边界；评审安全改动时对照。
- [SECURITY_AUDIT_HANDOFF.md](SECURITY_AUDIT_HANDOFF.md) — 交给独立审计方的材料清单、候选固定与复现步骤及平台限制；准备或配合外部审计时用。
- [SECURITY_AUDIT_SCOPE.md](SECURITY_AUDIT_SCOPE.md) — 审计强制范围：11 项必查领域与攻击测试清单；界定审计边界或写审计任务书时查。
- [STORE_LISTING.zh-CN.md](STORE_LISTING.zh-CN.md) — Chrome/Edge 商店中文名称、简介、详细说明与截图素材清单；上架或更新商店页面时复制核对。
- [SYNC_COMPATIBILITY.md](SYNC_COMPATIBILITY.md) — 自动同步行为与四种密码源的增量边界、通知机制和锁定策略；排查同步延迟或冲突时查。
- [UI_M3E_CANVAS.md](UI_M3E_CANVAS.md) — M3E 设计规范落地说明：m3e-canvas 布局稿、组件规格与已实现的页面调整；做 UI 改动前参考。

## Android 互操作（27）

与 Monica Android 版的双向兼容、真机验收与字段往返记录。

- [android-bitwarden-current-runtime-318.md](android-bitwarden-current-runtime-318.md) — Android Bitwarden 往返失败记录：单项更新覆盖整个 Cipher
- [android-bitwarden-passkeys-317.md](android-bitwarden-passkeys-317.md) — Bitwarden Passkey 全链往返通过与凭据 ID UUID 规范化修复
- [android-bitwarden-repaired-runtime-318.md](android-bitwarden-repaired-runtime-318.md) — Android 修复版 Bitwarden 往返重跑，三场景全通过
- [android-bitwarden-upload-fix-proposal-318.md](android-bitwarden-upload-fix-proposal-318.md) — Bitwarden 上传覆盖缺陷修复提案：定位源码未改代码
- [android-current-system-318.md](android-current-system-318.md) — Android API35 系统凭据管理器真机验收：签名与备份标志通过
- [android-edge-passkeys-317.md](android-edge-passkeys-317.md) — Android 与 Edge/MDBX Passkey 互导验签，非零计数差异留缺口
- [android-folder-transfer-followup-318.md](android-folder-transfer-followup-318.md) — 文件夹传输等功能对齐进度汇总：Steam 筛选与缓存策略
- [android-full-fields-316.md](android-full-fields-316.md) — Android 全字段 ZIP 导出、插件编辑与定向恢复回读验证
- [android-interop-315-acceptance.md](android-interop-315-acceptance.md) — Android 双向兼容任务总报告：分层验收范围与增量索引
- [android-interop-315-android.md](android-interop-315-android.md) — Android 1.0.315 实机互通证据：AVD 环境与构建溯源
- [android-interop-315-backends.md](android-interop-315-backends.md) — KeePass/Bitwarden/ZIP 字段载体差异与适配记录
- [android-interop-315-current-parity.md](android-interop-315-current-parity.md) — Android 1.0.315 复测：样本导出与 Wi-Fi 写链往返证据
- [android-interop-315-edge.md](android-interop-315-edge.md) — 真实 Edge 互通验收：Native Messaging 与隔离配置证据
- [android-interop-315-gaps.md](android-interop-315-gaps.md) — 互通字段缺口登记：按读取/保留/编辑/操作列待验证差距
- [android-interop-315-native.md](android-interop-315-native.md) — Native Host 与 MDBX 适配实施验证及版本基线
- [android-kdbx-passkeys-317.md](android-kdbx-passkeys-317.md) — Edge 创建的 KDBX Passkey 在 Android 签名回写验证
- [android-kdbx-project-fix-proposal-318.md](android-kdbx-project-fix-proposal-318.md) — Android KDBX 导入丢失项目分组缺陷的修复提案
- [android-passkey-backup-flags-318.md](android-passkey-backup-flags-318.md) — Android Passkey 备份标志工作进度与冻结构建作废说明
- [android-passkey-current-runtime-318.md](android-passkey-current-runtime-318.md) — Android/Edge 的 MDBX Passkey 五密钥往返验收
- [android-passkey-fixes-317.md](android-passkey-fixes-317.md) — Android 317 凭据 ID/允许列表/取消兼容修复及验收
- [android-passkey-id-fix-proposal-317.md](android-passkey-id-fix-proposal-317.md) — Android 凭据 ID 误解码提案：b64. 前缀问题与失败证据
- [android-passkey-signatures-317.md](android-passkey-signatures-317.md) — Android Passkey 首轮签名往返：跨端私钥保留与标志缺陷
- [android-rich-project-fields-318.md](android-rich-project-fields-318.md) — 富密码项目 MDBX 跨端编辑往返逐字段零差异验收
- [android-system-backends-317.md](android-system-backends-317.md) — Android 系统认证三后端登录通过与字段差异范围澄清
- [android-system-credential-manager-317.md](android-system-credential-manager-317.md) — Android 凭据管理器实机验证：零计数通过正计数失败
- [android-webdav-passkeys-317.md](android-webdav-passkeys-317.md) — 真实 WebDAV 链路 Passkey 自动同步与 Android 回写验证
- [android-zip-note-interop.md](android-zip-note-interop.md) — Android ZIP 密码转笔记往返的实际应用层测试记录

## KeePass 与 KDBX（13）

KDBX 同步、成员移除、恢复与文本保形的过程记录。

- [keepass-local-working-copy-318.md](keepass-local-working-copy-318.md) — 本地 KDBX 加密工作副本与项目移除的实现验收
- [keepass-member-removal-317.md](keepass-member-removal-317.md) — KeePass 成员移除真实 Edge/WebDAV 验收与丢响应恢复
- [keepass-project-atomic-317.md](keepass-project-atomic-317.md) — KeePass 项目同步一致性：指纹守卫与变基冲突检测
- [keepass-project-credentials-317.md](keepass-project-credentials-317.md) — KDBX 凭据组字段恢复项目与 Android 写入导入验证
- [keepass-project-member-removal-317.md](keepass-project-member-removal-317.md) — KeePass 项目成员移除计划校验与附件移交实现
- [keepass-project-restore-317.md](keepass-project-restore-317.md) — KeePass 整项目恢复：含早删成员的单次加密提交
- [keepass-receipt-retention-319.md](keepass-receipt-retention-319.md) — KeePass 回执淘汰改过期标记，防旧操作重放
- [keepass-recovery-317.md](keepass-recovery-317.md) — KeePass 远端同步中断恢复与项目批次不拆分规则
- [keepass-source-removal-319.md](keepass-source-removal-319.md) — KeePass 源移除文件事务：软删回执与跨库移动原语
- [keepass-text-preservation.md](keepass-text-preservation.md) — KeePass 登录文本保形：空白保留与控制字符保护存储
- [keepass-transfer-file-319.md](keepass-transfer-file-319.md) — KeePass 批量传输文件事务：身份派生与持久回执
- [keepass-transfer-ui-319.md](keepass-transfer-ui-319.md) — KeePass 批量传输界面接通：目标选择与远端发布恢复
- [keepass-trash-recovery-317.md](keepass-trash-recovery-317.md) — KeePass 原生回收站保留与禁用元数据修复

## Bitwarden（25）

Cipher 同步、复制迁移、回收站与移除事务的过程记录。

- [bitwarden-batch-transfer-319.md](bitwarden-batch-transfer-319.md) — 批量复制进 Bitwarden 的目的地选择、断点续传与保全边界
- [bitwarden-cipher-copy-319.md](bitwarden-cipher-copy-319.md) — 整 Cipher 复制准备：逐条新密钥重加密与可恢复日志
- [bitwarden-copy-lifecycle-318.md](bitwarden-copy-lifecycle-318.md) — 修复回执丢文件夹名误判本地编辑，取消后副本生命周期
- [bitwarden-keep-both-319.md](bitwarden-keep-both-319.md) — 移动中断新增「保留双方完成复制」选项及 v4 回执
- [bitwarden-keepass-move-319.md](bitwarden-keepass-move-319.md) — KeePass 整库移动入 Bitwarden：文件事务与原件进回收站
- [bitwarden-keepass-source-319.md](bitwarden-keepass-source-319.md) — KeePass 来源复制前置核验：字段、历史与附件对拍
- [bitwarden-local-move-319.md](bitwarden-local-move-319.md) — 本地记录移动入 Bitwarden：v2 回执与同事务删除收养
- [bitwarden-local-portable-319.md](bitwarden-local-portable-319.md) — 本地 Passkey 复制等价校验：私钥本地签名自证
- [bitwarden-mdbx-attachment-copy-318.md](bitwarden-mdbx-attachment-copy-318.md) — 附件跨库复制：认证下载、SHA-256 回读与移动封锁
- [bitwarden-mdbx-move-319.md](bitwarden-mdbx-move-319.md) — MDBX 移入 Bitwarden：v3 回执与原生删除事务恢复
- [bitwarden-mdbx-source-319.md](bitwarden-mdbx-source-319.md) — MDBX 来源复制核验：库修订、根目录清单与成员闭包
- [bitwarden-passkey-adoption-318.md](bitwarden-passkey-adoption-318.md) — 项目移除收尾迁移 Passkey 本地引用并过重启恢复
- [bitwarden-passkey-preservation-318.md](bitwarden-passkey-preservation-318.md) — Passkey 保留准备：副本计划、复制事务与恢复日志
- [bitwarden-passkey-recovery-319.md](bitwarden-passkey-recovery-319.md) — 修复 Passkey 移植性与创建响应丢失的恢复冲突
- [bitwarden-preparation-recovery-318.md](bitwarden-preparation-recovery-318.md) — 准备期本地编辑触发停止与只读核对恢复出口
- [bitwarden-project-batch-318.md](bitwarden-project-batch-318.md) — 修复同步上限拆散项目：按项目标识整批处理
- [bitwarden-project-credentials-317.md](bitwarden-project-credentials-317.md) — 对齐 Android 项目元数据约定并支持整组保存
- [bitwarden-project-local-recovery-318.md](bitwarden-project-local-recovery-318.md) — 冻结摘要剔除使用统计，本地编辑转冲突恢复
- [bitwarden-project-removal-adoption-318.md](bitwarden-project-removal-adoption-318.md) — 移除协调器成功链路：附件复制与一次加密保存
- [bitwarden-project-removal-restoration-318.md](bitwarden-project-removal-restoration-318.md) — 远端补偿后本地收尾：采用服务器现状留冲突
- [bitwarden-project-removal-runtime-318.md](bitwarden-project-removal-runtime-318.md) — 移除协调器接入运行时：命令、队列与缓存失效
- [bitwarden-project-removal-transaction-318.md](bitwarden-project-removal-transaction-318.md) — 逐项删除加密日志与补偿恢复的事务层实施
- [bitwarden-project-removal-verification-318.md](bitwarden-project-removal-verification-318.md) — 删除前远端核验器：重读成员范围与附件校验
- [bitwarden-trash-recovery-318.md](bitwarden-trash-recovery-318.md) — 修复回收站并发修改：删除后实读内容再确认回执
- [bitwarden-webdav-source-319.md](bitwarden-webdav-source-319.md) — 旧 Monica WebDAV 备份复制入 Bitwarden 校验

## MDBX 引擎（20）

内置 MDBX 引擎、持久层、原生内容与备份恢复的记录。

- [mdbx-backup-crash-317.md](mdbx-backup-crash-317.md) — 完整备份崩溃恢复：导出目录租约与孤儿清理实测
- [mdbx-browser-application-320.md](mdbx-browser-application-320.md) — 内置引擎接入正式构建：建库导入导出免装助手
- [mdbx-browser-durable-engine-319.md](mdbx-browser-durable-engine-319.md) — 浏览器引擎持久层：块存储与严格事务提交实现
- [mdbx-browser-engine-feasibility-319.md](mdbx-browser-engine-feasibility-319.md) — 可行性实验证明引擎可在扩展 Worker 内运行
- [mdbx-browser-offscreen-320.md](mdbx-browser-offscreen-320.md) — 离屏 Worker 属主控制：端口鉴权、租约与心跳
- [mdbx-browser-routing-320.md](mdbx-browser-routing-320.md) — 浏览器/本机助手后端路由：句柄索引定归属
- [mdbx-browser-webdav-recovery-320.md](mdbx-browser-webdav-recovery-320.md) — 内置引擎双浏览器档 WebDAV 同步中断恢复实测
- [mdbx-complete-backup-317.md](mdbx-complete-backup-317.md) — 完整备份格式与还原：ZIP 内嵌库和密文校验
- [mdbx-complete-backup-edge-317.md](mdbx-complete-backup-edge-317.md) — 真实 Edge 完整备份导出导入重启往返验收
- [mdbx-content-attachments-320.md](mdbx-content-attachments-320.md) — 原生附件目录读取：随修订绑定与分块传输
- [mdbx-content-metadata-320.md](mdbx-content-metadata-320.md) — 原生元数据读取：标签关系按修订分页校验
- [mdbx-content-write-320.md](mdbx-content-write-320.md) — 原生内容写入边界：修订守卫的分块写与中止
- [mdbx-source-deletion-revision-319.md](mdbx-source-deletion-revision-319.md) — 跨库移动删除前置：持久化写修订防附件漏变
- [mdbx2-group-restore-317.md](mdbx2-group-restore-317.md) — 整组原子恢复：原生批事务、协调器与界面
- [mdbx2-mixed-project-restore-317.md](mdbx2-mixed-project-restore-317.md) — 混合成员整组恢复：墓碑、未发布与脏成员同批
- [mdbx2-password-encoding-317.md](mdbx2-password-encoding-317.md) — 按 Android 约定写密码明文标记防误修复
- [mdbx2-project-removal-recovery-317.md](mdbx2-project-removal-recovery-317.md) — 删除协调器：幸存者同步、附件复制与中断恢复
- [mdbx2-project-removal-revision-317.md](mdbx2-project-removal-revision-317.md) — 删除批次修订守卫：写修订摘要堵附件缺口
- [mdbx2-queued-redelete-restore-317.md](mdbx2-queued-redelete-restore-317.md) — 已确认墓碑被重删排队后仍可立即恢复
- [mdbx2-trash-restore-317.md](mdbx2-trash-restore-317.md) — 回收站单项恢复：先原生复原再清本地墓碑

## Passkey、密码项目与迁移（20）

Passkey 策略、密码项目结构与跨库迁移的过程记录。

- [passkey-autofill-usability-317.md](passkey-autofill-usability-317.md) — Passkey 与自动填充交互路径的阶段性审查
- [passkey-capability-318.md](passkey-capability-318.md) — 统一 Passkey 能力分级展示与 Android 刷新保护
- [passkey-counter-history-317.md](passkey-counter-history-317.md) — 本地导入正计数先持久化再签名的修复验证
- [passkey-zip-webdav-history-317.md](passkey-zip-webdav-history-317.md) — 加密 ZIP 来源计数修复：重发、竞争与高水位
- [password-display-stacks-317.md](password-display-stacks-317.md) — 密码列表智能分组显示与封面标记规则
- [password-field-audit-316.md](password-field-audit-316.md) — Android 密码字段模型差距审计与跟进
- [password-history-317.md](password-history-317.md) — 密码历史实现：同事务留痕与掩码删除校验
- [password-history-live-317.md](password-history-live-317.md) — 密码历史实测：真实服务器、Edge 与 Android 往返
- [password-history-native-317.md](password-history-native-317.md) — 原生边界：阻断无法保留历史的跨库迁移
- [password-manual-stacks-317.md](password-manual-stacks-317.md) — 手动堆叠管理：创建、永不堆叠与恢复自动
- [password-project-removal-317.md](password-project-removal-317.md) — 成员移除能力汇总：事务与 MDBX2 协调进展
- [password-project-removal-android-return-317.md](password-project-removal-android-return-317.md) — 移除结果经 Android 与独立读取器回归核对
- [password-project-removal-runtime-317.md](password-project-removal-runtime-317.md) — 成员移除运行时命令：启动、查看、续跑取消
- [password-project-removal-ui-317.md](password-project-removal-ui-317.md) — 成员移除编辑器：二次确认与待办操作面板
- [password-project-restore-ui-317.md](password-project-restore-ui-317.md) — 回收站整组恢复界面设计与真实 Edge 验收
- [password-project-singleton-and-detail-317.md](password-project-singleton-and-detail-317.md) — 单条项目完整成员校验与分组详情导航
- [password-project-unsent-delete-317.md](password-project-unsent-delete-317.md) — 撤销未同步整组删除：一次加密写全量恢复
- [project-common-fields-and-order-317.md](project-common-fields-and-order-317.md) — 公共字段变更同步各凭据组与键盘排序
- [project-credentials-317-interop.md](project-credentials-317-interop.md) — 凭据组四段往返：标识、顺序与受保护字段保留
- [project-removal-source-routing-318.md](project-removal-source-routing-318.md) — 修复移除面板解锁入口按来源跳错设置页

## Nearby / Wi-Fi 同步（22）

附近设备同步的传输协议、采纳、恢复与界面集成记录。

- [nearby-android-metadata-gap-320.md](nearby-android-metadata-gap-320.md) — Android Wi-Fi 元数据附件缺口：快照丢失资产字节的源码检查
- [nearby-folder-trash-320.md](nearby-folder-trash-320.md) — 保留式文件夹删除进 MDBX 引擎：新命令与事务回滚
- [nearby-hierarchy-320.md](nearby-hierarchy-320.md) — Wi-Fi 原生层级调度：依赖排序与投影标记防误判
- [nearby-local-adoption-320.md](nearby-local-adoption-320.md) — 附近同步内容映射与加密本地采纳的内部基础实现
- [nearby-local-coordinator-320.md](nearby-local-coordinator-320.md) — 附近同步本地会话协调器：配对信任与回执连接
- [nearby-local-metadata-320.md](nearby-local-metadata-320.md) — 附近同步文件夹/根元数据本地化与墓碑恢复规则
- [nearby-local-origins-320.md](nearby-local-origins-320.md) — 附近同步本地来源档案加密保留与不可变合并实现
- [nearby-lossless-transport-319.md](nearby-lossless-transport-319.md) — 附近传输 JSON 无损修复：Chromium 与 serde 序列化缺陷
- [nearby-manager-owner-320.md](nearby-manager-owner-320.md) — 附近同步生产管理器所有权：单页租约与有界 API
- [nearby-metadata-assets-320.md](nearby-metadata-assets-320.md) — Wi-Fi 原生标签与文件夹/根附件字节采纳检查点
- [nearby-native-adoption-320.md](nearby-native-adoption-320.md) — 附近同步原生对象采纳：修订守卫写事务计划
- [nearby-native-catalog-320.md](nearby-native-catalog-320.md) — 附近同步原生源目录捕获与元数据规划内部基础
- [nearby-native-profiles-320.md](nearby-native-profiles-320.md) — 原生集合档案完整读取：授权校验与字节限额边界
- [nearby-native-transport-319.md](nearby-native-transport-319.md) — 附近设备传输边界：引入 Android 加密协议与因果副本
- [nearby-preferences-320.md](nearby-preferences-320.md) — 附近同步加密身份与对端偏好：信任不可静默替换
- [nearby-production-ui-320.md](nearby-production-ui-320.md) — Wi-Fi 同步接入管理页与断点意图恢复的集成验证
- [nearby-profile-sync-320.md](nearby-profile-sync-320.md) — 便携集合档案经 Android 元数据投影与原生恢复
- [nearby-profile-write-320.md](nearby-profile-write-320.md) — 原生集合档案原子写命令与能力检查边界实现
- [nearby-recovery-320.md](nearby-recovery-320.md) — Wi-Fi 接收恢复：多步日志区分冲突并支持离线续传
- [nearby-trash-android-320.md](nearby-trash-android-320.md) — Wi-Fi 保留回收站披露恢复与 Android 互通验证
- [nearby-wifi-sync-321.md](nearby-wifi-sync-321.md) — Wi-Fi 同步用户页集成与双端监听根因修复记录
- [nearby-write-anchor-320.md](nearby-write-anchor-320.md) — 可续写原生修订锚：断点续写防覆盖他端编辑

## 其他功能专题（22）

自动填充、设置、导入导出、WebDAV 等独立功能主题记录。

- [api-address-parity.md](api-address-parity.md) — API地址字段对齐：按原文保存、原位更新，不再强制URL校验
- [archive-lifecycle-317.md](archive-lifecycle-317.md) — 归档改为按选中ID与版本校验的原子变更，并保留KeePass归档状态
- [custom-autofill-controls-317.md](custom-autofill-controls-317.md) — 自动填充支持带类型自定义字段：复选框、多行文本与单选下拉规则
- [document-field-parity-318.md](document-field-parity-318.md) — 证件详情补全地址等字段，自定义字段编辑保留重复名与未知属性
- [edge-android-note-roundtrip.md](edge-android-note-roundtrip.md) — 用真实Edge导出的加密ZIP在Android往返验收密码与关联笔记
- [editor-content-318.md](editor-content-318.md) — 编辑页补充内容统一为摘要加独立编辑层，覆盖各类项目
- [github-passkey-performance-2026-10-09.md](github-passkey-performance-2026-10-09.md) — 修复GitHub Passkey失败与交互延迟：响应适配、提示冲突与缓存
- [gpg-field-preservation.md](gpg-field-preservation.md) — GPG字段改为原位更新，公钥块与编码在无关修改时保持不变
- [handoff-android-interop-315-20261001.md](handoff-android-interop-315-20261001.md) — Android互通任务的阶段交接：进度、入口与未完成目标说明
- [hotp-usage-consistency-317.md](hotp-usage-consistency-317.md) — HOTP使用确认只推进计数器，复制与网页填写路径一致且幂等
- [import-export-20261023.md](import-export-20261023.md) — 独立导入导出页面：预览确认后新增副本，支持ZIP/KDBX等格式
- [local-transfer-transaction-318.md](local-transfer-transaction-318.md) — 本地库传输加密事务：依赖展开与回执重放实现
- [local-transfer-ui-318.md](local-transfer-ui-318.md) — 本地传输界面与加密附件接入运行时及限额边界
- [onedrive-interop-317.md](onedrive-interop-317.md) — OneDrive登录、文件选择与KDBX同步实现记录及待验收范围
- [rounded-controls-and-wallet-editor-318.md](rounded-controls-and-wallet-editor-318.md) — 填充输入框改四角圆润外形，钱包编辑器支持分区排序与嵌套编辑
- [runtime-generator-recovery-319.md](runtime-generator-recovery-319.md) — 运行时连接失败的有界重试恢复，及生成器滑杆数值绑定修复
- [security-review-2026-10-10.md](security-review-2026-10-10.md) — 代码安全审查：设备密钥隔离、诊断泄露修复与依赖更新
- [settings-arrangement-318.md](settings-arrangement-318.md) — 设置页改为三组紧凑布局，常用项直接操作，少数进二级页
- [settings-pages-318.md](settings-pages-318.md) — 历史方案：设置十个入口统一列表项并全部进入二级页面
- [steam-bitwarden-attachment-fix-318.md](steam-bitwarden-attachment-fix-318.md) — Bitwarden Steam附件修复：兼容新旧附件加密格式并允许重试
- [wallet-section-order-318.md](wallet-section-order-318.md) — 钱包编辑分区顺序字段随编解码持久化，跨后端保留不丢
- [webdav-note-ui.md](webdav-note-ui.md) — 密码编辑器支持关联Monica WebDAV笔记，选择器带摘要与解除

## 设计与布局稿（43）

docs/design/ 的 M3E 布局草图与设计证据。

- [android-interop-315.md](design/android-interop-315.md) — Android互通八页M3E Canvas草图：分组、详情、编辑与银行卡等
- [bitwarden-removal-318.md](design/bitwarden-removal-318.md) — Bitwarden移除流程草图：核对继续、重新登录与取消各只做一事
- [complete-backup-317.md](design/complete-backup-317.md) — 完整备份与恢复的设计草图，附Android侧导入限制说明
- [complete-backup-layout-317.md](design/complete-backup-layout-317.md) — 紧凑备份恢复布局草图：滚动区内控件自然高度且不重叠
- [credential-autofill-317.md](design/credential-autofill-317.md) — 多密码自动填充草图：按同账号凭据顺序编号，不合并同名项目
- [custom-icons-315.md](design/custom-icons-315.md) — 项目图标设计：图标库、Emoji与上传替换流程遵循Android
- [document-fields-318.md](design/document-fields-318.md) — 证件字段草图：地址独立成组，秘密默认隐藏并保留复制
- [editor-content-318.md](design/editor-content-318.md) — 编辑页补充内容草图：摘要入口加独立编辑层，沿用Android面板
- [flat-lists-20261017.md](design/flat-lists-20261017.md) — 平铺紧凑列表草图：取消跨项目堆叠，缩小卡片垂直留白
- [folder-transfer-318.md](design/folder-transfer-318.md) — 文件夹筛选与传输草图：目标选择、受限项与窄屏弹窗布局
- [keepass-project-restore-317.md](design/keepass-project-restore-317.md) — KeePass整项目恢复确认草图：分组计数与旧删除范围说明
- [keepass-recovery-317.md](design/keepass-recovery-317.md) — 恢复副本管理草图：按日期选择，未完成操作禁止删除
- [keepass-removal-317.md](design/keepass-removal-317.md) — KeePass成员移除草图：复用移除审查行，写操作无歧义取消
- [keepass-resolution-317.md](design/keepass-resolution-317.md) — KeePass项目冲突解决草图：逐项显式选择，不预选破坏项
- [keepass-transfer-319.md](design/keepass-transfer-319.md) — KeePass批量传输草图：目标加入KeePass，未完成传输可恢复
- [local-keepass-318.md](design/local-keepass-318.md) — 本地KDBX项目操作草图：锁定保留加密副本，导出由用户保存
- [native-icons-315.md](design/native-icons-315.md) — KeePass项目图标草图：图片转PNG，品牌与Emoji转原生图标
- [navigation-315.md](design/navigation-315.md) — 竖屏常用导航草图：窄宽用80px底栏，更多保留完整导航
- [nearby-320.md](design/nearby-320.md) — Wi-Fi同步草图：紧凑列表、配对邀请与Passkey限制确认
- [nearby-pairing-320.md](design/nearby-pairing-320.md) — Wi-Fi配对与结果草图：二维码或链接配对，完成需对端确认
- [nearby-recovery-320.md](design/nearby-recovery-320.md) — Wi-Fi接收恢复草图：确认前紧凑审查，冲突保留加密输入
- [onedrive-317.md](design/onedrive-317.md) — OneDrive连接草图：登录、浏览、选择与解锁分步呈现
- [passkey-status-318.md](design/passkey-status-318.md) — Passkey使用状态草图：列表文字状态，详情说明跨端限制
- [passkey-unlock-317.md](design/passkey-unlock-317.md) — Passkey解锁草图：安全窗口验证后选账户，网页不收主密码
- [password-history-317.md](design/password-history-317.md) — 密码历史草图：默认折叠掩码、最新在前，删除仅限单条历史
- [password-manual-stacks-317.md](design/password-manual-stacks-317.md) — 手动密码显示堆叠的设计证据草图，应用渲染另行验证
- [password-stacks-317.md](design/password-stacks-317.md) — 密码显示堆叠与掩护传输的设计证据草图，渲染另行验证
- [portrait-315.md](design/portrait-315.md) — Android竖屏页面草图：窄宽时新建/编辑/详情用全屏容器
- [project-credentials-316.md](design/project-credentials-316.md) — 凭据组编辑器草图：一用户名多密码共享OTP的分组表单
- [project-detail-317.md](design/project-detail-317.md) — 密码项目详情草图：分组标签与编号密码行，导航不露秘密
- [project-operations-317.md](design/project-operations-317.md) — 密码项目操作草图：排序、移除草稿化并须显式范围确认
- [project-removal-ui-317.md](design/project-removal-ui-317.md) — 密码成员移除UI草图：标记可撤销，保留至少一条密码
- [project-restore-ui-317.md](design/project-restore-ui-317.md) — 密码项目恢复UI草图：按删除时间戳与来源限定恢复范围
- [rounded-controls-318.md](design/rounded-controls-318.md) — 圆润控件草图：四角24px填充容器，搜索保持胶囊外形
- [settings-arrangement-318.md](design/settings-arrangement-318.md) — 设置分组草图：三组连续行，常用项直接开关与选择
- [settings-pages-318.md](design/settings-pages-318.md) — 统一设置草图：入口同一列表项，全部进入带返回栏二级页
- [sidebar-cleanup-20261017.md](design/sidebar-cleanup-20261017.md) — 侧栏清理草图：移除时间线与独立API密钥导航入口
- [source-status-315.md](design/source-status-315.md) — 密码来源状态草图：连接、离线、云端保存三状态分层显示
- [ssh-editor-316.md](design/ssh-editor-316.md) — SSH编辑器窄宽草图：320px单列边距统一，桌面保留两列
- [sso-315.md](design/sso-315.md) — SSO关联账号草图：选择与解除关联，流程复用至KeePass等
- [wallet-fields-320.md](design/wallet-fields-320.md) — 独立个人资料字段草图：地址等可选字段入补充内容区
- [wallet-order-318.md](design/wallet-order-318.md) — 钱包内容顺序草图：分区上移下移排序，沿用Android键名
- [webdav-note-picker.md](design/webdav-note-picker.md) — WebDAV关联笔记选择器草图：两行摘要选项与解除入口

## 架构与开发说明（4）

架构文档与开发阶段说明。

- [background-runtime.md](architecture/background-runtime.md) — 后台运行时各模块职责与所有权划分表，含命令路由和发送方策略
- [legacy-server-api-reference.md](architecture/legacy-server-api-reference.md) — 归档旧mock管理界面的Monica Server路由规划（38条历史参考）
- [RELEASE-navigation-20260914.md](development/RELEASE-navigation-20260914.md) — 0.1.37导航与编辑改版说明：直开全部项目、新增API密钥类型
- [VALIDATION-navigation-20260914.md](development/VALIDATION-navigation-20260914.md) — 0.1.37密码库导航与编辑改版的本地开发验证记录

## 发布与阶段记录（21）

docs/releases/ 的发行说明、changelog 与历史阶段记录。

- [Monica-Extension-0.1.38-changelog.md](releases/Monica-Extension-0.1.38-changelog.md) — 0.1.38 预览版累计改动记录
- [Monica-Extension-0.1.38.md](releases/Monica-Extension-0.1.38.md) — 0.1.38 Preview 发行说明（同版本另有本地阶段记录与发布验证）
- [Monica-Extension-0.1.39.md](releases/Monica-Extension-0.1.39.md) — 0.1.39 Preview 发行说明（同版本另有本地阶段记录与发布验证）
- [Monica-Extension-0.1.46.md](releases/Monica-Extension-0.1.46.md) — 0.1.46 Beta 发行说明（仅 Chrome）
- [Monica-Extension-0.1.47.md](releases/Monica-Extension-0.1.47.md) — 0.1.47 preview-beta 发行说明
- [Monica-Extension-0.1.48.md](releases/Monica-Extension-0.1.48.md) — 0.1.48 preview-beta 发行说明
- [Monica-Extension-1.0.101.md](releases/Monica-Extension-1.0.101.md) — 1.0.101 首个正式版发行说明
- [Monica-Extension-1.0.102.md](releases/Monica-Extension-1.0.102.md) — 1.0.102 正式版发行说明
- [Monica-Extension-1.0.103.md](releases/Monica-Extension-1.0.103.md) — 1.0.103 正式版发行说明
- [Monica-Extension-1.0.104.md](releases/Monica-Extension-1.0.104.md) — 1.0.104 正式版发行说明
- [Monica-Extension-next-changelog.md](releases/Monica-Extension-next-changelog.md) — 下一版未发布改动记录（changelog）
- [RELEASE-0.1.36.md](releases/RELEASE-0.1.36.md) — 0.1.36 发行说明：概览、自动填充、多语言
- [RELEASE-0.1.37.md](releases/RELEASE-0.1.37.md) — 0.1.37 公开预览版发行说明
- [RELEASE-0.1.38.md](releases/RELEASE-0.1.38.md) — 0.1.38 本地开发阶段记录：Passkey 登录与跨端修复（同版本另有 Preview 发行说明与发布验证）
- [RELEASE-0.1.39.md](releases/RELEASE-0.1.39.md) — 0.1.39 本地开发阶段记录：按来源处理 Passkey 计数（同版本另有 Preview 发行说明与发布验证）
- [RELEASE-0.1.40.md](releases/RELEASE-0.1.40.md) — 0.1.40 本地开发阶段记录：自动与增量同步
- [RELEASE-0.1.41.md](releases/RELEASE-0.1.41.md) — 0.1.41 本地开发阶段记录：密码库界面整理
- [RELEASE-0.1.42.md](releases/RELEASE-0.1.42.md) — 0.1.42 本地开发阶段记录：M3 Expressive 主题
- [RELEASE-0.1.43.md](releases/RELEASE-0.1.43.md) — 0.1.43 本地开发阶段记录：M3E 表单与交互
- [RELEASE-0.1.44.md](releases/RELEASE-0.1.44.md) — 0.1.44 本地开发阶段记录：登录项网站图标
- [RELEASE-0.1.45.md](releases/RELEASE-0.1.45.md) — 0.1.45 本地开发阶段记录：弹窗账号列表

## 验证记录（76）

docs/verification/ 的功能验证、排查与发布就绪检查。

- [android-backup-v2-20261111.md](verification/android-backup-v2-20261111.md) — Android V2 ZIP/WebDAV兼容：双向加解密、真实Edge与大字号、安全回归及保留的失败记录
- [VALIDATION-0.1.24.md](verification/VALIDATION-0.1.24.md) — 0.1.24 使用与验证记录（本地开发包）
- [VALIDATION-0.1.25.md](verification/VALIDATION-0.1.25.md) — 0.1.25 多尺寸适配与验证记录
- [VALIDATION-0.1.26.md](verification/VALIDATION-0.1.26.md) — 0.1.26 多语言支持与验证记录
- [VALIDATION-0.1.27.md](verification/VALIDATION-0.1.27.md) — 0.1.27 性能优化与验证记录
- [VALIDATION-0.1.28.md](verification/VALIDATION-0.1.28.md) — 0.1.28 更新后解锁修复与验证记录
- [VALIDATION-0.1.29.md](verification/VALIDATION-0.1.29.md) — 0.1.29 登录项验证码显示与验证记录
- [VALIDATION-0.1.30.md](verification/VALIDATION-0.1.30.md) — 0.1.30 Nothing 详情布局验证记录
- [VALIDATION-0.1.31.md](verification/VALIDATION-0.1.31.md) — 0.1.31 Nothing 模块化概览验证记录
- [VALIDATION-0.1.32.md](verification/VALIDATION-0.1.32.md) — 0.1.32 首页易用性优化验证记录
- [VALIDATION-0.1.33.md](verification/VALIDATION-0.1.33.md) — 0.1.33 Android 风格概览跨端兼容验证
- [VALIDATION-0.1.34.md](verification/VALIDATION-0.1.34.md) — 0.1.34 原始品牌图标修正验证记录
- [VALIDATION-0.1.35.md](verification/VALIDATION-0.1.35.md) — 0.1.35 表单旁自动填充验证记录
- [VALIDATION-0.1.36.md](verification/VALIDATION-0.1.36.md) — 0.1.36 官方图标统一与发布验证
- [VALIDATION-0.1.37.md](verification/VALIDATION-0.1.37.md) — 0.1.37 公开预览版发布验证
- [VALIDATION-0.1.38.md](verification/VALIDATION-0.1.38.md) — 0.1.38 本地开发阶段记录：Passkey 验证
- [VALIDATION-0.1.39.md](verification/VALIDATION-0.1.39.md) — 0.1.39 本地开发阶段记录：Passkey 来源策略
- [VALIDATION-0.1.40.md](verification/VALIDATION-0.1.40.md) — 0.1.40 本地开发阶段记录：自动同步验证
- [VALIDATION-0.1.41.md](verification/VALIDATION-0.1.41.md) — 0.1.41 本地开发阶段记录：界面整理验证
- [VALIDATION-0.1.42.md](verification/VALIDATION-0.1.42.md) — 0.1.42 本地开发阶段记录：M3E 界面验证
- [VALIDATION-0.1.43.md](verification/VALIDATION-0.1.43.md) — 0.1.43 本地开发阶段记录：M3E 组件迁移
- [VALIDATION-0.1.44.md](verification/VALIDATION-0.1.44.md) — 0.1.44 本地开发阶段验证记录
- [VALIDATION-0.1.45.md](verification/VALIDATION-0.1.45.md) — 0.1.45 本地开发阶段验证记录
- [android321-extension-20261021.md](verification/android321-extension-20261021.md) — 扩展与 Android 1.0.321 对齐验证
- [auto-lock-diagnosis-20261104.md](verification/auto-lock-diagnosis-20261104.md) — 频繁解锁提示问题的调查记录
- [auto-lock-settings-20261101.md](verification/auto-lock-settings-20261101.md) — 自定义自动锁定时长的验证
- [background-modularization-20261101.md](verification/background-modularization-20261101.md) — 后台脚本完全模块化重构验证
- [background-runtime-refactor-20261101.md](verification/background-runtime-refactor-20261101.md) — 后台运行时重构首批验证
- [bitwarden-device-login-20261030.md](verification/bitwarden-device-login-20261030.md) — Bitwarden 设备验证登录与服务器选择排查
- [bitwarden-email-login-followup-20261031.md](verification/bitwarden-email-login-followup-20261031.md) — Bitwarden 邮箱验证登录后续修复验证
- [bitwarden-login-400-20261029.md](verification/bitwarden-login-400-20261029.md) — Bitwarden 登录 HTTP 400 排查记录
- [bitwarden-totp-duplicates-20261104.md](verification/bitwarden-totp-duplicates-20261104.md) — Bitwarden 验证码重复显示修复验证
- [card-artwork-20261021.md](verification/card-artwork-20261021.md) — 卡面附件读取失败修复验证
- [cli-integration-20261021.md](verification/cli-integration-20261021.md) — CLI 图形管理联动功能验证
- [cli-opt-in-20261021.md](verification/cli-opt-in-20261021.md) — CLI 联动默认关闭行为验证
- [editor-groups-20261021.md](verification/editor-groups-20261021.md) — 新建页编辑器分组重构验证
- [extension-hardening-20261021.md](verification/extension-hardening-20261021.md) — 安全审查后扩展加固验证
- [extension-integration-security-20261031.md](verification/extension-integration-security-20261031.md) — 集成变更安全后续审查记录
- [extension-release-readiness-20261031.md](verification/extension-release-readiness-20261031.md) — 1.0.103 发布前就绪检查记录
- [firefox-20261021.md](verification/firefox-20261021.md) — Firefox 桌面版兼容性验证
- [first-run-import-followup-20261031.md](verification/first-run-import-followup-20261031.md) — 首次运行导入与认证集成后续验证
- [github-update-20261021.md](verification/github-update-20261021.md) — GitHub 更新检测与版本规则验证
- [hide-payment-20261021.md](verification/hide-payment-20261021.md) — 隐藏支付项创建入口验证
- [inline-autofill-latency-20261021.md](verification/inline-autofill-latency-20261021.md) — 网页账号选择到密码填入延迟优化验证
- [item-selection-20261021.md](verification/item-selection-20261021.md) — 项目多选交互验收记录
- [navigation-close-20261021.md](verification/navigation-close-20261021.md) — 导航抽屉关闭按钮修复验证
- [nearby-android324-20261101.md](verification/nearby-android324-20261101.md) — 附近同步对齐 Android 1.0.324 协议验证
- [nearby-hotspot-20261029.md](verification/nearby-hotspot-20261029.md) — 手机热点局域网设备发现验证
- [nearby-incremental-deletions-20261020.md](verification/nearby-incremental-deletions-20261020.md) — 附近同步增量发送与删除确认验证
- [nearby-sync-stress-20261021.md](verification/nearby-sync-stress-20261021.md) — Android 与 Edge 附近同步压力验证
- [passkey-native-20261021.md](verification/passkey-native-20261021.md) — Passkey 登录切换系统验证器验证
- [pr-issue-integration-20261031.md](verification/pr-issue-integration-20261031.md) — 社区 PR #18/#20/#21 本地集成验证
- [pr13-integration-2026-10-17.md](verification/pr13-integration-2026-10-17.md) — PR 13 集成与 Wi-Fi 结果验证
- [preview-ci-20261101.md](verification/preview-ci-20261101.md) — 自动 Preview 发布门禁修复验证
- [provider-settings-20261021.md](verification/provider-settings-20261021.md) — 密码源分组列表与开关布局验证
- [release-0.1.38.md](verification/release-0.1.38.md) — 0.1.38 阶段发布验证（同版本另有 Preview 发行说明与本地阶段记录）
- [release-0.1.39.md](verification/release-0.1.39.md) — 0.1.39 Preview 发布验证（同版本另有 Preview 发行说明与本地阶段记录）
- [release-0.1.46.md](verification/release-0.1.46.md) — 0.1.46 Chrome 测试版发布验证
- [release-0.1.47.md](verification/release-0.1.47.md) — 0.1.47 preview-beta 发布验证
- [release-0.1.48.md](verification/release-0.1.48.md) — 0.1.48 preview-beta 发布验证
- [release-1.0.101.md](verification/release-1.0.101.md) — 1.0.101 首个正式版发布验证
- [release-1.0.102.md](verification/release-1.0.102.md) — 1.0.102 正式版发布验证
- [release-1.0.103.md](verification/release-1.0.103.md) — 1.0.103 正式版发布验证
- [release-1.0.104.md](verification/release-1.0.104.md) — 1.0.104 正式版发布验证
- [selection-bottom-20261021.md](verification/selection-bottom-20261021.md) — 底部多选操作栏布局验证
- [sidebar-passkey-20261021.md](verification/sidebar-passkey-20261021.md) — CLI 独立导航与 Passkey 验证窗口验证
- [test-cache-cleanup-20261014.md](verification/test-cache-cleanup-20261014.md) — 扩展测试缓存清理验证记录
- [unified-filters-20261021.md](verification/unified-filters-20261021.md) — 顶部统一筛选交互验证
- [unpacked-cold-start-20261021.md](verification/unpacked-cold-start-20261021.md) — 解压扩展重启掉加载问题排查
- [unpacked-update-flow-20261104.md](verification/unpacked-update-flow-20261104.md) — 解压扩展更新流程与数据保留调查
- [unused-mock-ui-20261101.md](verification/unused-mock-ui-20261101.md) — 旧 mock 界面清理验证（issue #26）
- [wallet-create-20261021.md](verification/wallet-create-20261021.md) — 新建分类与卡包入口验证
- [wallet-fields-320-2026-10-16.md](verification/wallet-fields-320-2026-10-16.md) — Android 1.0.320 档案字段受限扩展验收
- [wifi-recovery-continuation-2026-10-16.md](verification/wifi-recovery-continuation-2026-10-16.md) — Wi-Fi 中断接收恢复续作验证
- [wifi-stage-closeout-2026-10-16.md](verification/wifi-stage-closeout-2026-10-16.md) — Wi-Fi 同步阶段收尾冻结记录
- [zip-advisory-scope-20261104.md](verification/zip-advisory-scope-20261104.md) — zip 依赖安全通告范围评估

## 解决方案库（3）

docs/solutions/ 带结构化 frontmatter 的可检索解决方案。

- [refresh-build-id-json-after-source-changes.md](solutions/build-errors/refresh-build-id-json-after-source-changes.md) — 方案：源码变更后刷新 build-id.json 修复 CI 打包拒绝
- [rebuild-mdbx2-browser-engine-after-host-src-changes.md](solutions/build-errors/rebuild-mdbx2-browser-engine-after-host-src-changes.md) — 方案：宿主源码变更后用 pinned 工具链重建浏览器引擎，修复 provenance stale 构建失败
- [jsdom-partial-accessor-descriptor-merges.md](solutions/test-failures/jsdom-partial-accessor-descriptor-merges.md) — 方案：jsdom 负向测试夹具中部分 accessor 描述符合并导致的静默失效

## 非文档资产

`docs/` 下与文档相伴的数据资产，不参与上文的文档计数。

- `docs/design/*.m3e.json` — 各阶段 m3e-canvas 设计布局稿（历史草图，实际界面以 `src/` 实现为准）
- [brand-icons-provenance.json](brand-icons-provenance.json) — Android 内置品牌图标导入的来源与许可记录
- [import-export-20261023-results.json](import-export-20261023-results.json) — 独立导入导出页的验收结果数据
- [nearby-android324-20261101.json](verification/nearby-android324-20261101.json) — 附近同步对齐 Android 1.0.324 的验证数据
