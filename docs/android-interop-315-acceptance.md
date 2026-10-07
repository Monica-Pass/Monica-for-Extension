# Android 当前 main（1.0.317）双向兼容：实施与分层验收

当前目标已按用户要求更新为 Android main 的 `1.0.317`。下方原始矩阵与版本表保留 2026-09-30 至 2026-10-01 的历史验收范围，不代表当前版本已全面互通，也不把后续新增的证据回填成旧版本通过。

2026-10-04 的最新密码项目证据见 [当前字段审计](password-field-audit-316.md)、[Android 凭据组实际往返](project-credentials-317-interop.md)、[共享字段及排序](project-common-fields-and-order-317.md) 和 [Bitwarden 项目分组](bitwarden-project-credentials-317.md)。当前扩展完整回归为 195 个文件、1845 项测试通过；全目标仍未完成。Android 应用、真实浏览器、远端服务和源码推断的证据继续分开记录。

日期：2026-09-30 至 2026-10-01。本轮修改在 `monica-extension` 当前工作树实施，未发布、打标签或改 Android 主仓库。本文持续按实际证据更新；**不能据此宣称 100% 互通**。

## 已实现的范围

- 无损 JSON、Android Long HOTP counter、GPG/API Key/API Token 区分；模型/导入/MDBX/ZIP/KDBX/Bitwarden 已增加相应适配与保护。
- 仅用同库显式 group ID 分组；创建/编辑/删除本地原子提交，批量传输展开全组，同标题独立密码不合并。
- 真实 `monica.content.order`、五类重复内容块及完整钱包副本：创建、详情、编辑、排序、卡面与附件。内部字段不混进普通自定义字段表单。
- 完整副本附件通过已有分块上传接口添加为独立 `wallet-UUID` 文件，回读验证大小/SHA-256 后才加入副本草稿。取消草稿不删除已明确上传的独立附件，界面提前告知；不是跨远端的原子附件事务。
- 未来类型/版本及不兼容形状可见只读；原始内容默认隐藏、纯文本完整查看；修改/转换/删除/附件写入均有数据层保护。
- Passkey 绑定提供五个已知元数据字段的查看与编辑，与 OTP、恢复备注共存；**绑定元数据不是签名凭据，设备绑定私钥没有被声称迁出**。
- UI 沿用原生 M3E 组件，先做可编辑 Canvas；实际 Edge popup/side panel/全页、Native Messaging、锁定/重启均单独验收。
- 本地 MDBX 显式同步及自动同步资格接入既有落盘队列。最新实现支持完整备份：外部附件随同一快照打包为 ZIP，插件可直接恢复数据库和附件，取消/锁定释放导出会话。本机核心往返已通过；新路径的 Edge/Android 统一验收待完成，详见 `mdbx-complete-backup-317.md`。历史无附件导出证据仍按原版本保留。
- 修复自动同步 ACK 与打开中编辑草稿的竞态：保存使用当前权威远端引用；无内容变化的回读保持本地版本，实际远端变化令旧草稿失效，create ACK 补齐 routing 防止无编辑重复写入。保留真正 CAS 冲突保护。
- 银行卡副本的账单地址按 Android `BillingAddress` 六字段编辑和展示，未来字段、大整数、null/缺省不因未编辑而改写。依用户最新要求，不新增验证器任意自定义字段功能。

基线缺口表：[类型 × 字段 × 后端](android-interop-315-gaps.md)。后续实际 fixture 还找出并修复了 ZIP `totp/` 路径漏读、无时间后缀密码文件附件漏关联、密码/安全项目数值 ID 撞号导致附件错归属、WebDAV 附件 FINISH 分支及 MIME 字段遗漏。不得将这些真实缺陷隐藏为“原测试已覆盖”。

## 版本及证据边界

| 对象 | 实际版本 / 记录 |
| --- | --- |
| 拓展基线 | 0.1.37，Git `11f712e5599eb439a6d108b918b620918f50d117`，本次变更未提交 |
| Android 源码基线 | 本地 main 1.0.315 未发布，Git `a19912fb3a521a930400d8a1461f81eb8f65595d`，dirty 树保留；其他会话期间有修改 |
| Android 实际设备 APK | 初始导出 `-31`，SHA-256 `d0bd2aa68fe1f343967fbc40cc9650c95434db400d55e1ef58e75ae09c3db183`；维护后四项测试为 `1.0.315-26093012-75`，SHA-256 `3ea8e58ac3c01919830f7db6b91962466250018c98bb6ac38fac5da7acbc3a4d`。之后其他任务更新到 `-76`，不得将旧结果归属新 APK |
| 公共 AVD | `Monica_Issue136_API_32`，`emulator-5554`，ADB 5037；最初复用，维护结束且无设备后启动同一 AVD，无清数据/新建 AVD。关闭前必须确认共享测试释放 |
| Microsoft Edge | `154.0.4258.37`，明确 msedge channel / Edge executable；`chrome-extension://` 是 Edge 的拓展 URL 协议，不表示运行了 Chrome |
| Native Host | 0.1.2，protocol 2；实际 engine commit `90005c8c608c952093a4522ffa507a562e2e39a4` + 四个 Android overlays；详见 [Native 报告](android-interop-315-native.md) |
| Node / npm | 22.14.0 / 10.9.2 |

初始字段声明核验和完整 dirty 文件哈希保存在 `.codex-tasks/android-interop-315/raw/baseline.json`；最终快照另存 `final-baseline.json`（最终验证时生成）。每次 Android 应用测试另有设备 APK、测试 APK、测试源和前后 dirty 哈希，不能只用 HEAD 代替实际源码。

## 第 11 节 A–H 矩阵

“通过”只适用于本行明列的 fixture/层级；“部分”不能计作整行验收通过。R=可读，P=未编辑字段/字节无损，E=已知字段编辑，O=业务操作。

| 规范行 | 实际执行与能力 | 状态 | 尚未证明 / 阻塞 |
| --- | --- | --- | --- |
| A Android UI 创建 → Edge 详情 | Android 业务链20条/3 Blob；真实 Compose UI 单条产物→Edge UI读取/编辑→Native落盘→界面导出（run-xEoEh9）→Android -75真实详情/编辑/导出通过 | 单条后续链通过；全类型部分 | 原始创建JUnit最后标题多节点断言失败，产物安全恢复；最终 Edge 重开另列，不能将全类型 UI 标通过 |
| B Edge UI 创建 → Android 重开/详情 | Host/provider 新建合成登录及导出真实库；Edge UI 功能集另测 | 部分 | 全部类型由 Edge UI 创建后 Android 真实详情未完成 |
| C 双向单字段编辑 → 重开 | 20条Android记录经拓展标题编辑，20次stale拒绝；Android接收21条并编辑一条notes后返回，Host逐字段核对，3 Blob明文hash一致，20未编辑payload/revision不变 | 部分 / 严格比较1失败 | 被编辑条目除notes外room_id 59524→59648，稳定monica_entry_id/native ID不变；严格测试未忽略。Android另已复现丢future字段；全字段UI编辑未测 |
| D 双端关闭重启/锁定/缓存 | Host 进程重启、错密码、锁定、bootstrap+Blob 独立进程重开；真实 Edge 整浏览器重启、锁定拒读和错密码均通过 | 部分 | Android 杀进程/重启后全部类型与缓存重建未完成；FFI 未暴露原生 created_at，首次投影/缓存重建的 UI 创建时间不保证准确 |
| E WebDAV bootstrap/segments/Blob | 真实本机 HTTP WebDAV 端点 + Android/Host 原生引擎双向：Android 2 segments/9 Blob、浏览器 1 segment/6 Blob | 通过（引擎/本机 HTTP 范围） | 不等于公网服务或完整 Android 同步 UI；重复/乱序/中断/全部冲突矩阵未全部通过 |
| F Android 全量 ZIP → 拓展 → Android 恢复 | Android ZIP20条/显式组/两同标题独立/五OTP/wallet/order/3附件：拓展读取编辑写回通过；Android -75解码实际执行 | 失败（Android解码） | BILLING_ADDRESS→DOCUMENT、PAYMENT_ACCOUNT→BANK_CARD且各重复，SecureItem 10→12，写入前停止。完整恢复未通过 |
| G KeePass 往返 | 复制当前 Android 核心源码的 isolated JVM + 实际 KDBX AES/ChaCha20、历史、OTP原串、附件；1 项通过 | 通过（源码 JVM / 文件范围） | 不是 Android 设备 UI；Android KDBX 卡面、布尔字段和结构化地址写链仍有边界 |
| G Bitwarden / Vaultwarden | 两种模拟协议服务2项通过；新增独立Docker Vaultwarden 1.37.3真实注册/认证、GPG/API_KEY、精确HOTP、future字段与附件回读通过 | 通过（模拟与本地实际服务范围） | 真实Edge服务UI复核另列；不是官方Bitwarden云，也不是Android应用UI往返 |
| H 删除/回收站/归档/收藏/移动/层级 | 显式组原子保存/删除、传输展开/复制换组、同库 Collection 稳定身份和 stale 拒绝均有回归 | 部分 | 全部 Android↔Edge UI 生命周期未测；无历史 logical ID 的跨库 native UUID 保持未验收 |

## 必备 fixture 的覆盖与缺口

| 类型 / 特性 | 实际 Android 应用 fixture | 拓展测试 / 边界 |
| --- | --- | --- |
| 同标题独立密码 / 显式三账号 / 多 URL / 应用关联 | 有；组3、独立2计数确认 | 不按标题合并；组创建/删除/传输有测试 |
| 五 OTP / HOTP Long / PIN | 有 | 数字精确及 PIN 内部保存；公开分享默认不带 PIN |
| OTP + Passkey绑定 + 恢复备注 | 有（绑定元数据） | 原生有序 UI 共存；真正签名和绑定元数据分开 |
| 银行卡全部低频字段 / 卡面 / 附件 | 有，独立银行卡及完整副本 | 共享codec完整映射、字节校验、已知卡面结构编辑 |
| 完整笔记副本 / 图片与文本附件 / 顺序 | 有 | 新版 wallet envelope/data/assets 与未知 token 保留；不是只复制摘要 |
| NOTE / DOCUMENT / BILLING_ADDRESS / PAYMENT_ACCOUNT | 有 | 类型不降 login，外层 notes 与内容独立 |
| SSH / GPG / API Key / 五类重复内容块 / QR | 有 | 严格分段/hash，完整表单及 QR 模板；合成密钥不是实际密码学业务验证 |
| Wi-Fi 企业/代理/IP | 当前 APK `1.0.315-26100112-09` 实际写出并往返保留完整元数据 | canonical/legacy 字段映射与结构化网络表单已补齐，真实 Edge 创建/编辑/切换配置通过；新表单的 Android UI 回读另待验收，见[当前复测](android-interop-315-current-parity.md) |
| 自定义图标、旧 SSO | 当前 APK 复测仍未写出相关字段 | `android-app-parity-20261001/android-writer-gaps.json`，不计通过 |
| 独立原生 API Token / steam-mafile / Passkey | 此 20 条业务 fixture 未包含 | 另有 codec/Host/原有协议测试，不计全类型应用 UI 通过 |
| 未来类型/高版本/未知数字/空值 | codec/Host 合成覆盖；Android普通编辑丢 future 字段已复现 | unknown 安全只读，合法已知表单字段正常可编辑 |

## 故障验收

| 故障 | 当前实际证据 | 状态 |
| --- | --- | --- |
| 错密码、锁定读、浏览器/Host 重启 | 真实 Edge 与 Host 拒绝并保留库 | 通过（对应层） |
| 缺外部 Blob | 独立 Host：3 附件读拒绝，20 对象 payload/身份/revision 不变 | 通过，`native-missing-blob-evidence.json` |
| 过期 revision | 实际20次拒绝；批量/组成员变更回归无写入 | 通过（Host/provider） |
| 附件分段错/重名/重复cursor/错hash/取消 | `attachment-reader.test.ts`，无不完整明文暴露，释放句柄 | 单元通过；真实故障 UI 单列 |
| 损坏/截断 ZIP、错备份密码、取消恢复 | Android -75实际4种预检故障通过，既有库行/密码/原生对象和原备份字节不变；解密后应用前取消 | 通过（预检）；提交过程中取消回滚未测 |
| HTTP离线/401/429/507、乱序、冲突 | 已有同步回归，尚未形成所有新字段真实应用矩阵 | 未全部验收 |
| 不可导出 Passkey、旧本机密文、超限payload | 数据层拒绝 / 保留测试 | 不推定所有应用 UI 通过 |

## 结果与复跑入口

- `npm test` 最终全量：159 文件、1491 测试通过（2026-10-01 11:31），日志 `raw/final-vitest-5.log`。`npm run build`（包含两个 TypeScript 检查）通过，日志 `raw/final-build-10.log`；安全审计与 Host 来源核验通过。仅有既有大 bundle 提示。
- Host：58 Rust 测试通过；后续定向外部附件 revision 断言通过。不是把新增的定向重复执行再加到总数。
- 真实 Edge 基础：`.tmp/interop-315-edge/run-VLNSdb/evidence.json`，9张截图；Native Messaging 临时注册已恢复。功能扩展运行另存独立目录，不覆盖基础证据。
- Android/ZIP/Native 共享 fixture：`.tmp/android-app-interop-315/`；首次失败和修复后记录均保留。详见 [Android 报告](android-interop-315-android.md)、[各后端报告](android-interop-315-backends.md)。
- Canvas：[打开草图与设计说明](design/android-interop-315.md)，使用本地 `http://127.0.0.1:5186/#docz=…`；十一页可编辑源及全部单页 Edge 预览渲染已检查，含安全导出及六字段账单地址。证据 `.codex-tasks/android-interop-315/raw/canvas-local-evidence.json` 与 `canvas-*.png`；不依赖缓存作为唯一记录。

安全复跑命令见各专项报告及 `tests/interop/README.md`。必须先核对现有公共 AVD，再显式设置 serial/AVD；不得使用旧 runner 的 Pixel_Fold 默认值。所有服务目录、库、浏览器 profile 和 Native Host 状态均为独立合成环境。

## 需要 Android 侧决定的最小修正（本轮未改）

1. 当前源码已补齐 Wi-Fi `wifi_metadata` 写入；复测当前 APK 完整回读，并分别确认图标、旧 SSO 字段。旧版缺失报告不能视为当前版本结论。
2. 普通 Android 密码编辑从当前 payload + revision 生成保留未知成员的精确 patch，不能从 Room 投影重建整个 payload。重现见 `android-known-field-writeback.json`。
3. KDBX 卡面/BOOLEAN/结构化地址需要 Android 先建立实际双向载体；拓展在未证明无损时拒绝损坏性保存，不私创兼容协议。
4. FFI object summary/record 暴露原生创建时间，供首次导入与缓存重建准确展示；底层存储创建时间本身未被拓展修改。
5. `SecureItemRestoreTypeResolver` 优先接受全部合法显式类型，仅缺省/旧别名才推断；后备补充按源身份去重。`extension-zip-decoded.json` 已在 -75 证实账单地址和支付账号错类并重复，恢复写入前拒绝。

用户已授权并搭建独立本地 Docker 服务；该范围不要求提供公网凭据。公网/官方云和未覆盖的全类型应用 UI 仍标未测。所有用户库、Android dirty 工作树与公共 AVD 数据盘保留；未交付 APK 或提供下载链接。


## 2026-10-01 收尾与新增布局验证

- 真实 Edge 功能：`run-D4Rqv9`，12 项功能与 9 项生命周期通过；涵盖新建、编辑、内容排序、完整副本、卡面附件、Native 回读、未知字段保护与组删除。
- `run-L4aBDa`：六类新建表单桌面/420px 验证通过；真实 Docker WebDAV ZIP、KeePass、Vaultwarden 三种服务均通过 UI 创建 GPG、编辑备注、上传/下载附件、同步与重启。独立服务读取验证 3/3 通过，见同目录 `real-services-independent-readback.json`。两次测试均确认 Native Messaging 注册恢复。
- 实际服务底层：`run-zgyhDw` 三项通过，独立 verifier 单独一项通过（包含三种服务）。不合并模拟测试与实际服务的覆盖范围。
- 本轮修正 WebDAV 附件界面误用已脱敏密码、浏览器创建记录回读的本地身份/Android 原始 ID 关联、KeePass 同步重载使未变化附件标识失效。新增两项针对性回归；原始失败 run-onm7uV、run-qyrhSd、run-hyRufN 保留。
- 设计参照 Android 本地 Canvas 与实际页面源码，未修改 Android 源码；此轮没有启动 AVD。Android 单条四段链的最终 Edge 重开此前在 `run-LTj775` 通过；完整类型矩阵、Android ZIP 错类/重复与未知字段丢失仍按上表保留为部分/失败。

本轮扩展实现及验证完成，整体互通仍为部分验收：不能将上述通过推定为所有类型的 Android 双向 UI、全部故障与官方云覆盖。

最终快照补充：Android 工作树 HEAD 已是 `2117395ffbd47f32b8970cd0028f3ba15979566d`，与前述应用测试基线不同。本报告的 Android 错类、未知字段与 room_id 结果只归属于记录的 APK/源码快照；本轮未对新的 Android HEAD 重新执行全部应用测试，不能据旧失败断言新 main 仍未修复，也不能将其自动标通过。
