# Android 1.0.315：KeePass / Bitwarden / Android ZIP 字段兼容记录

基线：2026-09-30 Android main 1.0.315（未发布）。本记录只覆盖拓展后端适配器与合成协议测试，不代表 Android 应用 UI、Edge 拓展页面或真实服务验收已通过。Android 源码保持原状。

## 类型 × 字段 × 后端差异

| 类型 / 字段 | KeePass 实际载体 / 变更 | Bitwarden 实际载体 / 变更 | 当前证据 |
| --- | --- | --- | --- |
| 密码 / 普通字段 | 标准 KDBX 字段；保留明确空 Password 和空自定义值、空白、原始 Long ID；多 URL 按换行写入 | Login；未编辑的加密值、null、缺省字段和 URI 扩展元数据保留 | 单元回归通过 |
| 密码 / 旧支付字段 | Card Number / Card Holder / Card Expiry / Card CVV 已补齐 | Android password system adapter 未写出这些字段；银行卡另走 Card | KDBX 单元；BW Android 写链边界 |
| GPG / API Key | `monica_gpg_type` / `monica_api_key_type` 标记恢复对应 loginType；分块字段原值保留 | 同一 Android 标记，优先于 SSH 推断；私钥仍在 password | 双端 codec 回归通过，应用 UI 往返未测 |
| 内容顺序 / 完整钱包副本 / 内容块 | 现有受保护 custom field 原串；完整删除字段组不留旧片段 | 现有 encrypted Fields 原串，重复次数、未知字段元信息保留 | 含未来大数字的副本回归通过；附件字节沿用已有二进制链 |
| 多密码 | 当前 Android KDBX 未声明 group wire carrier | 当前 Android BW 未声明 group wire carrier | 不发明字段，不依据同名自动合并；该两链路完整分组兼容未通过 |
| OTP 五类型 | 按当前 `KeePassTotpCodec` 写 otp、TimeOtp/HmacOtp；Steam 保留 encoder，Yandex/mOTP 仅扩展 URI；换类型移除旧 OTP 字段 | login.totp 内部存储 URI，显式携带 PIN；不用于公共分享 QR | 五类型 / `9007199254740993` / Long 最大值回归通过 |
| SecureItem JSON | `MonicaItemData` 使用保留原始 JSON 的字段 patch；保留嵌套未来字段和精确数值 | Card/Identity/Note 使用各自实际字段格式，不能当作 Room JSON | note 未知字段、custom 元信息回归通过 |
| 银行卡完整低频字段 | 离散 Card Number、PIN、IBAN、SWIFT/BIC 等已有字段；补充保护和空字段保留 | 新增 Android 可读字段名与旧 monica_* 别名映射；布尔字段保留 type=2 | BW 全字段回归通过 |
| 银行卡卡面 | Android `buildSecureItemFields` 对 BANK_CARD 不写 MonicaItemData，`appendBankCardFields` 未写 cardFace；拓展拒绝会丢失卡面的保存 | `Monica Card Face` JSON + 现有附件；读出已知配置，回写保留未知嵌套信息 | BW 配置回归通过；KDBX Android 写链缺口 |
| 证件 | MonicaItemData；共用完整模型映射 | 补齐 documentTitle、company、username、address3、所有 ssn/passport/license、日期/机构/国籍与卡面 | BW 选择一个主号码编辑时不清空其他号码，回归通过 |
| Note 布尔字段 / 标签 | JSON 内 secure field type 保留 | type=2 支持；不截断/修剪标签，未知标签数组与未知 markdown 值保留 | 回归通过 |
| 未知 custom type / 解密失败 | 未知 MonicaItemType 可见 readonly opaque，同时继续保存源记录；禁止编辑/转换/删除/附件改写/历史恢复 | 未来 Cipher type 可见 readonly opaque，保留旧已知本地项及独立未来投影；已知可解密字段可安全查看，未知加密字段不猜测解密；编辑/转换/删除/附件写入拒绝 | 保留、重复同步去重、恢复已知类型回归通过；完整高级详情由主任务验收 |
| Passkey + OTP + 备注 | 当前 KDBX 一个 entry 仍只投影一个主 item；passkey 字段与 OTP 受保留，混合 UI/签名验收未完成 | 现有 Login + OTP + FIDO2 子投影复用 | 既有密码/OTP/签名与 attachment tests 通过；不等于 Android UI 通过 |
| SSH / API Token / Steam | SSH 使用 Android 离散字段；JSON 未声明扩展在原始字段外无任意新 carrier；原生 api-token 不伪装 login | 现有 native/fallback SSH 与 Steam maFile 附件链复用；原生 API Token 不是 API Key | 既有单元与模拟附件协议通过；全字段应用往返未测 |

## Android 写链缺口与最小建议

1. KDBX 银行卡卡面：`utils/KeePassKdbxService.kt:4879` 对 BANK_CARD 仅调用 `appendBankCardFields`，`:4932` 的字段列表没有 cardFace，`:6250` 附近的回读也没有配置字段。合成 `BankCardData(cardFace=...)` 经此写入再重建会失去配置引用。最小建议是 Android 先制定并同时实现读写 carrier，再补真实 Android 导出 fixture；拓展没有创建私有替代格式，保存带卡面卡片时明确失败。
2. KDBX 银行卡 BOOLEAN 自定义字段：Android writer 将 BOOLEAN 写普通字符串，reader 根据 protected flag 只恢复 HIDDEN/TEXT。最小建议是为类型定义兼容元信息并双向验证。在格式明确前，拓展拒绝将 BOOLEAN 卡片字段保存到 KDBX。
3. KDBX / Bitwarden 银行卡结构化 billingAddress：Android writer 使用 `formatForDisplay()`，新设备回读只能取得显示文本。主干需在实际协议内保留结构化原值后才能宣称完整往返。
4. KDBX 明确空密码/标签样式密码：Android `resolveEntryPassword` 仍可能回退受保护的其他字段；拓展已将存在的 Password（包括空串和 `password`）视为权威。Android 需要以此合成输入做回读复现后修正其 fallback 条件。
5. KDBX / Bitwarden 不承诺 password_group_id 原生 carrier，不能借 replica 或同标题推断分组。

## Android ZIP / 快照 WebDAV 补充

| 范围 | 实施与限制 | 证据 |
| --- | --- | --- |
| 未来目录类型、未来 loginType/otpType、损坏 JSON、非对象 itemData | 可见 readonly opaque，保留原 ZIP entry 字节，禁止编辑、删除和隐式跨库转换 | `android-315-preservation.test.ts` |
| Long ID、超大 HOTP、精确小数/指数、-0、null/空串、literal serde marker | 原始树使用无损 JSON；修改其他字段不重写数值；未知 custom field 属性及未来元素保留 | 精确字面量回归通过 |
| Passkey | 旧设备绑定 alias 在备注编辑时保留，不升级为可签名；无私钥的新完整备份拒绝；仅元数据导出必须显式 opt-in | 两种路径回归通过 |
| API Token | Android ZIP 当前没有无损 wire carrier，明确失败，不忽略也不改成 login | 失败回归通过 |
| 事务与取消 | ZIP 全部校验后才提交绑定/分类/providerRefs；HTTP 上传成功后才提交；非数组/损坏回收站拒写 | 序列化后项失败、上传失败、用户取消、错误备份密码均保留 caller |
| 删除 | 仅 deletedAt 改变也写入回收站；unknown 不可删除 | 回归通过 |
| 实际 ZIP OTP 路径 | Android 应用 ZIP 的 `totp/item_<id>.json` 与 `folders/<category>/totp/` 已识别；保留 WebDAV 原有 `authenticators/` 及原路径写回 | 真实应用 fixture 首次复现 20 项只读出 15 项；补充三条路径回归通过 |
| portable 附件归属 | 优先记录 raw.id；密码与 SecureItem ID 分开，兼容不带时间戳文件名；Long 父 ID 精确读写 | 真实 ZIP 复现 3 附件只列出 1 项；回归额外捕获同数字 ID 跨表错配，现均通过 |
| WebDAV 附件完成提交 | 补 background FINISH 分支，复用 staged encrypted ZIP adapter；校验目标/operation/完整性，失败不回执，成功后抹除暂存明文并支持重复完成及并发去重；修正 mediaType→mimeType | 九项完成流程测试及加密归档 MIME 回归通过；模拟 HTTP，不是线上服务 |
| 损坏/未来 portable manifest | 拒绝将损坏 JSON、非对象、未知版本和非数组 entries 当成空 manifest 重写；失败保持原 manifest 内容 | 四条 RED→GREEN 回归；有效 manifest 中未来 entries 保留 |

大整数关联 ID 原值保留，但本地模型的部分 Room 关系仍只接受安全整数。绑定编辑遇到超范围 ID 明确失败，而不是四舍五丢失。分组、银行卡/笔记完整副本、附件仍分别使用其已定义的 Android 实际载体；无损 source 保留不代表 UI 创建/编辑覆盖率已完成。

## 验证与可重复命令

- `npx vitest run src/providers/keepass src/providers/webdav src/providers/bitwarden src/background/webdav-attachment-upload.test.ts`：49 文件、685 测试通过（2026-09-30 10:54 CST）。新合成 fixture 位于各目录的 `android-315-backends.test.ts` / `android-315-preservation.test.ts`。
- Android verbatim 核心源码 isolated JVM KDBX 实际文件往返：负责应用互通的代理重跑确认通过（60.05s，1 项）。曾真实复现备注编辑改写原生 `TOTP Settings`，现只在 OTP 变化时重写，原字符串保持；这是 JVM 核心源码/文件互通，不是 Android 设备 UI。命令与 10 个源码哈希见 `.tmp/keepass-android-interop/run-*/evidence.json` 和应用互通报告。
- `$env:MONICA_BITWARDEN_INTEROP_KEEP='1'; npm run test:bitwarden-interop`：2/2 通过（最后重跑 10:20 CST）；official/Vaultwarden 为 **模拟记录协议**，并非真实线上服务。覆盖加密 cipher、组织 Collection、附件上传/下载/删除、空库保护等；证据 `.tmp/bitwarden-contract-interop/evidence.json`。
- `npm run build`：2026-09-30 10:54 CST 通过，含两个 TypeScript 配置检查、310 模块、225 icon 校验及全部拓展页面资源校验；有既存 >500kB chunk 体积提示。
- 本子任务未启动 Android AVD、未运行 Android 应用 UI、未打开 Chromium/Chrome、未发布/打标签。已在真实 Microsoft Edge 154.0.4258.37 运行拓展，独立证据见 Edge 专项报告；不要把单元/模拟协议结果当成实际应用验收。
- 第 11 节 A–F/H：此处未测；G：单元与模拟协议通过，真实 Android 应用往返 / 真实服务待主任务结果。不能据此声称 100% 互通。

## 实际核对的 Android 源码哈希（SHA-256）

| 源文件 | SHA-256 |
| --- | --- |
| utils/KeePassKdbxService.kt | `0f19058eb0e93797f273ca362816d04e8762b597d9460fc16895a286bd72a1e4` |
| keepass/KeePassTotpCodec.kt | `6cf71f6502af33019010a07a4160c437841fb34066767806fe2d8ab35b62e7a9` |
| bitwarden/service/CipherUploadProcessor.kt | `bc7745f18ee5cb35d1fc89fa3aa3f11c024dcb17ae3a1dfe1d7632012ed4bbef` |
| bitwarden/service/CipherSyncProcessor.kt | `aff4521cdea36f849f38e1a241d18368ec5339fa125b40000729a2d9020d5f19` |

模型/source snapshot 与全部 dirty diff 哈希以主任务总报告为准，不能只用 HEAD 代替工作树基线。


## 2026-10-01 实际 Docker 与 Edge 收尾

Apache WebDAV / Vaultwarden 实际服务 `run-zgyhDw` 三项通过。Edge `run-L4aBDa` 分别创建/编辑 GPG 并上传下载附件；全新独立读取三种服务均确认字段与附件 SHA-256 一致。KeePass 仍使用强 ETag 条件写入。WebDAV 附件权限只向界面传递 backupPasswordConfigured；后台仍验证真实密码。浏览器本地 ID 经已有远端路径关联 Android raw.id，避免回读产生重复项目或无法挂接附件。KeePass 远端重载仅保留同项目、同文件名且逐字节相同的附件句柄，变更/锁库使旧句柄失效。

Android 应用 ZIP 类型恢复错误与 KDBX Android 卡面/BOOLEAN/结构化地址限制未被这些服务通过结果消除；前文未测的 Android UI 和公网项仍未测。

## 2026-10-01 SSO 稳定关联字段保留

插件现在读写 KeePass 的 MonicaSsoRefLogicalId 和 Bitwarden 的加密 monica_sso_ref_logical_id。无关编辑保留关联标识，明确解除时删除旧值，不制造 Android Room 数字编号；系统字段不会重复显示为用户自定义字段。测试覆盖加密 Cipher 读写、解除后不复活，以及加密 KDBX 到完整项目模型的读取。

证据：sso-backend-tests-2.log（81 项）、sso-backend-all.log（1591 项）、sso-backend-build.log、追加的 sso-kdbx-projection.log（29 项）。范围仅为插件后端适配与加密文件验证；尚未证明跨来源账号重映射、实际服务往返或 Android 解析。不能据此宣称 SSO 双端完全互通。

SSO 关联身份补充：插件的 KeePass 关联使用条目 UUID，Bitwarden 使用远端 Cipher ID，避免把本地连接 ID 写入新关联。仍限制同一密码源范围，并拒绝重复身份；原有完整项目 ID 关联在当前范围内继续解析。加密 KDBX 保存／重新打开与加密 Cipher 配对测试已验证更换连接后指向同一账号，不等同于 Android 或实际服务验收。完整回归1596项通过。

实际服务验证补充：独立 Apache WebDAV KDBX 与 Vaultwarden SSO 两项通过（.tmp/sso-real-services/run-93mePG/evidence.json）。覆盖新建关联、换连接回读、无关编辑、解除关联和目标账号内容保留。Vaultwarden 新建保留本地 ID 的路径已修复，使用响应确认的 Cipher ID；此派生元数据不参与持久化恢复内容指纹。1597项回归及构建通过。测试服务已停止；Android 解析及浏览器关联选择操作仍须单独验证。

实际 Edge 操作补充：run-OJ01SG 的 KeePass／Vaultwarden 账号选择、新建关联、详情显示、取消修改及保存解除均通过。独立连接回读2/2确认远端最终解除与目标账号未变（sso-edge-readback.log）。修复新建 KeePass 数据库范围缺失：公开配置只补充非敏感 databaseId，密码和密钥继续隐藏。完整172文件1601测试通过；Android 稳定关联解析仍未实现。

旧 SSO 迁移修复：Bitwarden 有效数字引用在明确选择稳定账号或解除关联后删除，无关重命名继续保留原编号。加密回归与实际 Vaultwarden42→稳定关联→重连→解除均通过（run-ayqAus，sso-legacy-services.log）；1603项回归通过。损坏／未知形态字段不作为有效数字引用静默删除。

KeePass 旧 SSO 别名补充：SsoRefEntryId／MonicaSsoRefId 的有效编号不再作为自定义字段重复写入；明确解除后从加密 KDBX 中删除。无关编辑保留旧字段名称和保护状态，无法解析的受保护大整数原值继续保留。字段补丁及 Provider 加密导出重开测试通过，完整回归1609项通过；Android 端稳定关联能力仍待完成。

ZIP 关联笔记补充：boundNoteEntryId 的稳定标识现已读写，保留原形态；重命名、跨导入来源重开、明确解除以及新建关联的真实 ZIP 编解码测试通过。原数值编号在无关编辑时保留，明确选择／解除时按现有规则清除。Android 密码模型仍使用 boundNoteId，不能把插件新增标识的 ZIP 保留当成 Android 恢复兼容证明。

ZIP 数字笔记关联补充：导入时按唯一的活动笔记 ID 恢复关联，不使用标题匹配，也不覆盖显式稳定标识或 null。明确选择笔记时，现在写入目标笔记在同一 ZIP 中实际使用的数字 ID（包括新建笔记）；替代上文“明确选择时清除数字编号”的旧行为。解除仍清除两种引用。无关编辑保持原记录；重复编号、失效目标不会被猜测匹配。130项相关测试、1618项完整回归通过。Android BackupRestoreApplier 的数字映射实现已核对，但本轮尚未执行 Android 应用恢复／重导出验证。

Bitwarden 密码自定义图标补充：插件现在使用加密 Cipher 字段 monica_custom_icon_type、monica_custom_icon_value、monica_custom_icon_updated_at 保存图标，含原生 SSH Cipher。新建、换连接回读、重命名、替换和恢复默认经过真实隔离 Vaultwarden 验证（.tmp/icon-real-services/run-3HNqQZ/evidence.json），密码内容未变。链接字段、未知字段类型与无法安全表示的时间戳保留原值。这些是插件扩展元数据，尚未被当前 Android Bitwarden 映射读取；不计为双端图标互通。KeePass 原生图片池仍待接入。

KeePass 原生图标数据链路：插件读取条目 customIcon UUID 对应的图像字节；编辑保留原 UUID 和历史引用，跨数据库写入图像并复用相同字节的图标池项，恢复默认只清除当前条目引用。KDBX 4.1 的现有名称／时间保留，旧格式没有这些元数据。当前 Android 核心源码与 Kotpass 的 AES／ChaCha20 文件往返通过（run-n745HP），含图标 UUID 和原始字节。此阶段尚未接入插件原生图标预览／选择、品牌及 Emoji 栅格化、跨库名称／时间迁移，也未验证 Android 应用实际显示。
本阶段完整回归1627项通过，最终图标专项与构建通过；首次完整回归的旧迁移超时及测试语法类型检查失败已保留并分别复测修正。

KeePass 图标界面补充：本地 Canvas nativeicons315 已保存并检查。插件可预览 PNG／JPEG／WebP 原生图标，在 KeePass 编辑器中从图片选择；品牌与 Emoji 保存时转为128px PNG写入原生图标池。失败和取消不覆盖已有图标，320px下的Emoji按钮保留48px宽度。实际Edge操作、四份导出KDBX独立解密回读、1634项回归和构建通过；尚未验证新图片在Android应用里的实际显示，也未提供完整图标池管理或跨库图标名称／时间迁移。
最终验证：Edge run-1VoG9i 的图标操作与锁定／重启通过；真实未导出提示由测试明确确认。四份最终导出文件独立解密回读通过（native-icon-ui-readback-final.log）。临时 Native Messaging 注册已恢复。

## Android-side empty metadata application gap

Current source inspection: `CipherSyncProcessor.kt` ordinary update at lines504–514 (also server-deleted branch lines441–451) and `BitwardenSyncService.kt` lines709–719 use `remoteValue.ifBlank { existingValue }` for application/contact/address/passkey metadata. Thus an existing Android Room item with email `old@example.test` retains it after a complete remote Cipher update removes both `monica_email` and `email`. Fresh imports can differ from updates. No Android runtime result is claimed for this case; the source contradicts full clearing interoperability.

Reproduction to retain for application acceptance: create a synthetic login with all10supported metadata fields; synchronize to Android; clear one street field while retaining city/country in the extension; synchronize Android; then clear all metadata and synchronize again. Assert empty fields stay empty through Android re-export and browser reconnect, while password/user fields remain unchanged. The extension side now passes real Vaultwarden equivalent steps in `run-E5We5d`.

Android change proposal (not applied): make recognized metadata deletion authoritative only when the complete readable remote field snapshot and prior adapter/metadata initialization prove a normal synchronization. Preserve unknown/linked/unreadable field shapes and the existing fallback for truly legacy or incomplete snapshots. Apply the same rule to all regular/deleted/restoration update paths; do not fix just fresh insertion or globally remove every `ifBlank`. Add per-field/alias removal and legacy/incomplete snapshot regressions before Android app/real service roundtrip acceptance. Android remains read-only under this task's SPEC.

Bitwarden 附加字段保留补充：无关编辑现在保留已识别别名的拼写、重复值和字段附加属性；明确修改时更新相应重复项，清空时移除所有支持的别名。隐藏城市／州省／邮编／国家会使兼容组合地址继承隐藏属性。真实Vaultwarden回读验证了重复隐藏城市、组合地址隐藏及清空不复活（run-3pr9lv）；完整1656项回归通过。Android现有记录上的ifBlank回退仍是独立缺口，没有修改Android源码。

## Bitwarden SSH fallback metadata clearing

Previous goal turn made verified progress on password metadata. This turn reproduces13SSH failures then fixes all7fallback field clears, comment-only and empty SSH projections, malformed/unsafe key sizes, unsupported shapes, hidden protection and unchanged duplicate values. Initialized model clears remove supported reserved fields and stale custom duplicates; pre-adapter models retain remote metadata. Unknown numeric/raw fields remain untouched and are excluded from supported projection/encoder matching. Type5 native wire representation remains unchanged; local-only metadata handling remains separate.

Evidence: raw/bw-ssh-metadata-red.log (13 failures); green initial52codec tests; full178files1671tests and build pass raw/bw-ssh-metadata-all.log / bw-ssh-metadata-build.log, terminal25441 exit0. Actual isolated Vaultwarden .tmp/ssh-metadata-real-services/run-NvD85i/evidence.json confirms fallback create/reconnect/rename, all7sequential clears and final full clear plus raw remote field absence. raw/bw-ssh-metadata-services.log passed; final interop TypeScript check passed. Docker helper stopped services; no AVD started. Android source remains untouched: BitwardenSyncService.kt:720 still retains old sshKeyData on blank remote. Android application clear and broad password/backend/portrait parity remain unverified/incomplete. Goal active.

## KeePass password metadata aliases

The extension now handles13app/contact/address/legacy-card properties consistently across recognized KeePass aliases. Unrelated renames preserve original spelling, distinct duplicate-alias values and ProtectedValue state; explicit edits update all aliases and inherit hidden protection; explicit clears remove every recognized occurrence. Supported aliases no longer also appear as editable custom fields, preventing stale duplicate resurrection. Unrecognized fields are retained.

Evidence:14reproduced failures raw/kp-password-metadata-red.log;27KeePass test files/387tests passed raw/kp-password-metadata-targeted.log. Includes actual encrypted KDBX3and4save/reopen through the vault reader and entry writer, checking alias deletion, password, UUID, unknown fields and historical values. This is extension KDBX evidence, not Android application acceptance. Full regression/build currently running terminal47521.

Current Android utils/KeePassKdbxService.kt buildEntryFields/appendPasswordCompatibilityFields (around4530/4601) and analyzePasswordEntry (5803) have no passkeyBindings mapping; the keepass directory also has none. PasswordEntry.passkeyBindings existing in Room/ZIP/MDBX/Bitwarden does not prove KeePass transports it. Do not confuse standalone KeePass Passkey key-material support with password-to-Passkey bindings. Full cross-backend transport remains an Android-side design/integration gap; Android sources remain untouched.

Final validation:179files1687tests and build passed (terminal47521 exit0). Follow-up audit reproduced3protected application-alias values being promoted to a missing password (raw/kp-metadata-secret-red.log); password fallback now excludes the recognized metadata aliases. Final27KeePass files390tests passed raw/kp-password-metadata-final.log. Final build passed raw/kp-password-metadata-final-build.log (terminal15618 exit0). This last one-line fallback guard has focused coverage; the1687full-suite result predates that guard. No Docker/AVD or test process remains. Goal incomplete.

## KeePass SSH field preservation

This turn reproduced12SSH codec failures then preserves original field spelling/value/protection on unrelated edits, retains malformed/unsafe/negative key-size raw fields without projecting them, and reads format-only SSH payloads. Explicit field edits retain hidden protection; clearing removes supported fields and stale reserved custom-field duplicates. Plain imported private keys still become protected when written. Unknown-size raw content remains preserved on clear; this is intentional, not reported as a supported numeric field.

Evidence:raw/kp-ssh-metadata-red.log (12fail), green50codec tests, targeted28files405tests including encrypted KDBX3/4save/reopen of protected comment/format and malformed size. Final180files1705tests and build pass raw/kp-ssh-metadata-all.log / kp-ssh-metadata-build.log; terminal62298 exit0. Android utils/KeePassKdbxService.kt current SSH fields at4561–4583 and5881–5889 inspected read-only. This is extension codec and encrypted-file validation, not Android application acceptance. Existing Kotlin fixture has no SSH-specific field assertions; do not cite it as coverage for this change. No services or AVD started. Malformed entire sshKeyData input and future JSON metadata across KeePass remain audit targets. Goal active/incomplete.

## Current Android core SSH KDBX roundtrip

User AGENTS replacement establishes1.0.316; verified ordinary Android app/build.gradle baseVersionName1.0.316/versionCode12 and updated SPEC's obsolete current-version claim while retaining historical315task ID. Android sources remain untouched under task scope.

Added standalone SSH fixture entry and6item assertion to existing extension-owned Android/Kotlin fixture. Copied current Android data/model/SshKeyModels.kt verbatim into isolated JVM source set with hash verification. Kotlin/Kotpass generates encrypted fields; extension Provider imports, renames, edits public key/comment, clears key size, then clears all supported fields into separate files. Kotlin verifies hidden fields/unknown data and absence after clear; actual SshKeyDataCodec decodes/encodes an edited record and a returned comment, followed by encrypted Android re-export and extension reimport. Field extraction/rewrite glue is test code following KeePassKdbxService, not execution of that full Android service/application.

Passed AES256/ChaCha20 .tmp/keepass-android-interop/run-rkxnw8/evidence.json; Android revision0ddbaf3d671d653ee8b0e256a75ff26745002ffc and SshKeyModels SHA50c3b7d5705b2968615386a0089a3da4c4ed5c92824f7f403ee3632721366d80. raw/kp-ssh-android.log, terminal63894 exit0. Existing Passkey signing, icons, attachments and raw-preservation assertions also passed. First TypeScript check caught lock() signature mismatch before running; corrected, final interop typecheck passed. Final extension build kp-ssh-android-build.log passed (terminal1513 exit0). No AVD/Docker started; no running task process.

Explicit Android gap now executed as an assertion: SshKeyDataCodec.encode(SshKeyData(comment=comment only,format=PEM)) returns empty because isEmpty checks only algorithm/public/private/fingerprint. Metadata-only SSH therefore remains unsupported in current Android codec; extension preservation does not prove Android acceptance. Actual Android app/UI SSH restore and future JSON metadata through the KeePass service remain open. Goal active/incomplete.

## Reject lossy SSH input before writes

Rechecked current Android PasswordEntry and native/Bitwarden mappings; stable SSO/icon backend gaps remain. New11red cases demonstrate malformed entire SSH JSON, nonobject payloads, wrong known scalar types, fractional/negative/unsafe/string key sizes could be serialized as omitted/empty fields. Added shared assertWritableSshKeyData before KeePass field patch creation and Bitwarden cipher encoding. Missing/blank is still explicit clear, unknown JSON properties are not rejected by this validator. This guard does not implement unknown-property transport.

KeePass writer tests assert failed create/update leaves fields/history/groups untouched. Bitwarden Type1and5codec tests reject without a destructive output; provider create/update tests prove no HTTP call or category creation happens before rejection. Extra2red blank cases fixed initialized Bitwarden fallback clear semantics. Added7locale messages. Logs ssh-invalid-input-red.log, ssh-blank-input-red.log, ssh-invalid-provider-red.log retain failures.

Full182files1718tests and build passed ssh-invalid-input-all/build.log terminal3923exit0. Then provider-before-folder guards added; final50backend files681tests plus build passed ssh-invalid-input-final.log / ssh-invalid-input-final-build.log terminal73980exit0. Full-suite result predates only that provider guard, which has focused no-network coverage. No Docker/AVD started. Android sources unchanged. Future SSH metadata through unsupported backends, Android metadata-only behavior and full field/UI matrix remain open; goal active/incomplete.

## KeePass exact login text

KeePass login projection no longer trims SSH, contact/card metadata, SSO provider,
SSID/Wi-Fi JSON or legacy standard aliases. The writer protects strings containing
XML-sensitive controls so new files preserve tabs and CRLF. 29 new regressions,
443 KeePass tests, 1749 full tests and build passed. Android core/Kotpass
`run-hFTDx3` and actual Edge `run-f0Pd7Y` verify original text, edits, copying and
export/reopen; see [details and remaining loader boundary](keepass-text-preservation.md).
This is not full Android application acceptance or unknown SSH JSON transport.

## Verified Android ZIP note roundtrip

Final .tmp/android-zip-note-20261002-final passes all4legs: actual Android export, extension edit/reconnect, actual Android targeted MDBX import/reopen/re-export, extension reimport/reconnect. Four passwords and three notes cover unrelated rename/keep, replacement by a different same-title note, explicit unlink, and newly created note/password. Actual IDs remap435->437,434->436,1790909874942755->438; unlink remains null. Exact linked-note content/tags/Markdown and password values retained. This is application repository/ZIP/MDBX/Room evidence, not Android screen or browser UI acceptance.

Installed app1.0.316-26100212-08 SHA256b81b51fbb7ceca50f101905621c19d50abe23721188b4ee950c3d8867dce4e3c; final test APK876ced5ca3bc2766624f6d95ab716f46df56c5390a415e45549eb98492e5f920. Android source revision0ddbaf3d671d653ee8b0e256a75ff26745002ffc; app/test/source/boot invariants pass. Build2 completed6m35s, session99163exit0; final install/export session97395exit0, import/return commands exit0. Raw zip-note-final-{install,export,forward,import,return}.log; prior assertion failure retained in zip-note-import-red.log and initial run directory. TypeScript and12targeted note regressions passed; no new product code in this turn, no full-suite rerun. docs/android-zip-note-interop.md contains reproducible commands and evidence boundaries.

Public AVD started by this task was stopped after verifying no active instrumentation. No Docker/Edge services or test sessions remain. Android sources/installed application untouched. Next meaningful work: WebDAV bound-note picker is still gated to local/MDBX in LoginEditorFields.vue; enable only after matching source scope and safe destination writer checks, update/inspect local Canvas and verify real Edge/API roundtrip. Other Android restore destinations/full fields/unknown preservation/M3E screens remain open. Goal active/incomplete,15of23existing task rows DONE;18 remains IN_PROGRESS for full-password scope.

## WebDAV bound-note UI and portrait refinement

Previous goal turn was verified progress: actual Android ZIP note4leg roundtrip. Current turn enabled monica-webdav note selection in LoginEditorFields.vue, retaining same-source validation at save. Added bounded selected-note excerpt, two-line M3E options and explicit unresolved-numeric-reference placeholder. Same-title records remain selected by unique identity. Local Canvas webdavnote316 and webdavnotechoices316 were updated/rendered/inspected before corresponding UI changes; final narrow screenshots inspected.

Actual Edge final run-KHmXvB passed create/replace/cancel/unlink/new-note binding, nested detail/Escape, picker Escape, reload/sync, cross-source exclusion, resolved blank option label and420/320section/two-line geometry. Eight ordinary lifecycle/native checks also passed; native registry restored. Source manifest saved beside evidence. Fresh independent Apache provider readback run-JgkBzk verified8records, both linked contents, explicit null unlink, original link and new-note link; edge-note-return.zip SHA685f7404db56d38092c7f76afea71bb089b84de6f3ae659cd94c104d83243a65 retained for actual Android follow-up. Seed was byte-verified actual Android archive from prior .tmp/android-zip-note-20261002-final.

Initial run-mBGhzJ exposed ambiguous dialog test selection, corrected by target heading. Intermediate run-7n0QTh passed functionality but screenshot showed same-title descriptions clipped; two-line refinement run-Enirek passed. Final label assertion first used unreflected value attribute (run-p7JDsn failed), corrected to inspect actual custom-element property, including fixing the cross-source assertion to avoid a vacuous pass. Final run-KHmXvB and remote-readback pass; all failures retained.133tests/9files pass raw/webdav-note-regression.log; final build pass raw/webdav-note-build-final.log, terminal35520exit0. Final Edge/readback command terminal12327exit0. No backend/product codec changes or full-suite rerun in this turn.

Docker helper stopped both isolated services; no AVD started, no live test session remains. Canvas stays reused. docs/webdav-note-ui.md records commands/evidence; docs/android-zip-note-interop.md updated to remove obsolete WebDAV picker gate. Goal active/incomplete,15/23rows done. Next: actual Android import of the exact8record Edge archive (current7record ZIP harness must be extended without changing Android application sources), remaining password/backend fields and broad M3E screens. Do not count prior codec-only Android roundtrip as proof for the new UI artifact.
