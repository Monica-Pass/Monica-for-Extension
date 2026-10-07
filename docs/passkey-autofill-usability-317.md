# Passkey 与自动填充可用性审查（进行中）

目标是 Android 当前 main / 1.0.317 与浏览器扩展互通。本文是 2026-10-05 的专项记录，不代表完整目标已完成。

2026-10-06 补充：[自定义字段自动填充](custom-autofill-controls-317.md)修复布尔字段类型丢失，支持复选框、多行文本和单选下拉框，保留动态控件/表单检查，并在后续字段失败时确认已经填入的 HOTP。真实 Edge 新增三条场景通过；这不替代 Android 或任意网站框架验收。

## 交互与状态路径

| 操作 | 路径与状态 | 当前证据 |
| --- | --- | --- |
| 网站创建 Passkey | MAIN bridge → content prompt → `PASSKEY_BEGIN` → 确认 → 独立主密码验证窗口 → 保存及完成回执 → 返回网页 | ES256／RS256 按网站顺序与来源能力协商；Edge 本地／KDBX 及实际 Native MDBX RSA 注册、验签、排除凭据、导出与重启通过；新增 RSA 已通过 Android 实际签名返回 |
| 锁定时发起 Passkey | 只显示网站与解锁入口 → 独立安全窗口 → 刷新账户/保存位置 → 明确确认 → 原请求完成 | Edge 主密码与模拟 Hello 分支通过；同一次请求不重复验证，取消/超时/跳转/重新锁定失效 |
| 使用导入 Passkey | 备份/数据库 codec → 可用性筛选 → 选择 → 当前文档与密钥身份复查 → 按来源处理计数 → 签名 → 回执 | 已补齐便携 RS256/PS256/Ed25519，保留 ES256；正计数修复后，本地、实际 MDBX 和 WebDAV KDBX 的 ES256/RS256 在 Edge 中完成41→42→43及重启；Android系统入口仍待验收 |
| 表单旁填充 | 聚焦字段 → 绑定 document/session/scope → 后台匹配 → 用户选择 → 再查来源/锁定/排除策略 → native setter 与 input/change | 多表单、Shadow DOM、iframe、OTP、同步替换输入框停止与重试已有 Edge 通过记录 |
| 同账号多个密码 | 完整活动项目生成标签和编号 → 网站/搜索/数量筛选 → 选择具体记录 ID → 填入该记录 | 新增真实 Edge 键盘选择、按凭据组/编号搜索、授权子集及重启通过；同名独立项目不合并 |
| 切换填充设置 | `beforeinput` → 保存偏好 → storage 通知 → 更新开关 | 原先 `saving` 禁用开关导致键盘失焦；保留焦点与 busy 状态，重复操作由已有 saving guard 拦截；Edge 原失败用例现通过 |
| 免解锁填写 | 编辑明确授权 → 加密独立副本 → 锁定后只匹配已授权账号 → 重启 → 撤销 | 真实 Edge 编辑、填写、重启和撤销通过；OTP/Passkey 仍不从免解锁副本返回 |

## 本次修复

- 同账号多个密码显示“密码 2 · 工作账户”等标识。弹窗与网页菜单把标识放到独立行，避免长账号挤掉编号；弹窗搜索包含组标签和本地化编号。使用现有八语言词条。新草图保留于 [本地 M3E 多密码设计](design/credential-autofill-317.md)。
- 编号从完整活动项目计算，然后才筛选网站、搜索、数量上限和免解锁授权。项目以显式成员关系及来源/数据库限定范围，同名账号、同网站和元数据本身都不建立项目关系。有效凭据组采用组/密码交换顺序，无效或旧元数据采用已有稳定顺序，不写回原始字段。
- 免解锁缓存只追加获准记录的非秘密显示投影，仍加密并绑定当前主库版本；不保留其他成员的标签/ID或原始凭据字段。旧缓存缺少投影时正常读取，下次解锁刷新。重启和撤销测试验证获准“密码 2”不会变成“密码 1”。
- 注册支持 ES256／RS256，选择网站偏好列表内当前保存位置支持的第一个算法；RSA 使用 2048 位密钥、指数 65537、SHA-256，公钥返回标准 RSA COSE。Bitwarden 只允许 ES256，只有 RSA 时回到可用的本地等来源。新建 KDBX 使用 Android 对应的 `KEEPASS_COMPAT`。
- 修复 Edge `PublicKeyCredential.parseCreationOptionsFromJSON()` 自动补充 `enforceCredentialProtectionPolicy:false` 后被误判为不支持的问题；只忽略这一无效默认值，实际保护要求或未知扩展仍交给原生验证器。
- 锁定请求保持同一 candidate、网站、document 和原始过期时间。主密码／Hello 只在扩展安全窗口验证，验证后先返回账户/保存位置选择。验证结果绑定每次解锁更新的随机 session ID；普通活动不会更改 ID，重新锁定、解锁、主密码变更或恢复不会继承旧验证。旧版 session 没有 ID 时不采用解锁验证快捷路径。
- 解锁的异步密钥派生／Hello 返回前重新检查请求是否取消；取消不释放签名。独立安全窗口支持错误主密码重试、取消和五次失败上限。定时检查不会把仍在等待解锁的有效请求误取消；显式锁定仍取消它们。
- 保留本地 [M3E 解锁草图](design/passkey-unlock-317.md)。320px 下解锁说明换行，操作目标至少 48px。
- Android ZIP/MDBX2 便携密钥读取原先只接受 ES256。加密边界内现保留与 COSE 匹配的 RSA、Ed25519 私钥，支持 ES256、RS256、PS256、Ed25519 assertion。RSA PKCS#8 标识密钥家族，PS256 使用 SHA-256、MGF1-SHA-256 与 32 字节盐。未知算法和不匹配密钥不能返回签名。
- assertion 从所选凭据传入实际 COSE 算法，ES256 签名保持 DER 编码；RSA/Ed25519 保持原生签名编码。已有计数、BE/BS、验证身份与来源策略不变。
- 便携密钥仍仅通过允许便携密钥的加密备份路径导入/导出；Android 设备保护引用仍是不可签名的元数据。Bitwarden 的标准 FIDO2 编码仍限定 ES256，本次没有声称该后端支持其他算法。
- 修复自动填充设置保存时的键盘焦点丢失。
- 复现并修复同步 DOM 替换导致的错误成功：填写用户名时网站替换密码框，旧代码继续写入已经离开页面的节点。现逐步复查字段连接状态、作用域、属性、表单 action/method、只读状态与实际值；变化时停止后续填写，显示重新选择输入框的提示。真实 Edge 验证第一次停止且旧/新密码框都未获密码，重新选择后可成功填写。
- 内部 `monica.content.*`、GPG/API 元数据沿用编辑器的内部字段分类，在后台发送到内容脚本前过滤；DOM 层再次排除。普通自定义字段仍可填写，内部数据原样留在加密项目中。原来的内部载体匹配填写已通过失败用例复现。
- 修复 Node/Playwright 读取真实 KDBX 文件时 `kdbxweb` CJS 导出对象不一致的问题；浏览器仍使用同一 XML 解析与保护值规则。

## 验证边界

- **多密码选择修复最终验证**：`raw/credential-autofill-full-final.log` 的 **212 文件／2080 单测通过**；构建与两个 TS 配置通过 `raw/credential-autofill-build-final.log`；`raw/credential-autofill-security-final.log` 确认 186 个运行时命令、7 个管理页专用项目命令。首次构建的两处测试类型错误修正后通过，保留 `build-1.log`。
- **实际 Edge 154.0.4258.53，22 项相关自动填充流程通过**：`raw/credential-autofill-edge-final.log`，产物 `.tmp/credential-autofill-edge-final`。其中新增 2 项验证同账号不同密码的选择、网站匹配子集不重新编号、搜索组标签与编号、独立项目、仅授权第二条记录、锁定重启及撤销。旧构建的两个可复现失败见 `raw/credential-autofill-edge-red.log`，候选项确实没有区分标识。首次单测红灯是新模块尚未实现，不能当作浏览器故障的复现证据。
- 八语言明暗主题用例随后加入新密码标识并通过，`raw/credential-autofill-locales-visible.log` / `.tmp/credential-autofill-locales-visible`；这是上述22项中同一用例的增强复验，不增加测试数量。截图前把对应候选滚入菜单可视范围，实际检查德文编号和320px弹窗/锁定界面。此次没有重新执行 Passkey 仪式测试；之前52个不同 Edge 测试与本次2个新增共54个不同测试，历史结果各自绑定其当时源码。
- 本轮新建 `raw/credential-autofill-source-hashes.json`，保留先前清单。M3E 三张草图已在本地实际渲染并修正窄屏编号被截断问题；Canvas 的标准两行组件优先显示编号，原生插件用独立第三行保留账号与标识。Android 参考 HEAD `da61cec4221d3595b521d8c39ea90751fa56c834`；本轮未启动/停止模拟器，未运行 Android 应用或硬件签名测试。
- `tests/e2e/fixtures/edge.ts` 显式启动 Microsoft Edge，检查 `Edg/` 并保存版本及隔离 profile。使用短目录防止 Windows IndexedDB 路径超限；同一测试重启复用，下一次运行重新隔离。没有使用用户浏览器配置。新增 Hello 测试只临时创建此前不存在的 Edge Hello Native Messaging 注册，结束后移除并确认不存在；实际传输连接合成 Rust Host，不触碰已有的 Host 注册。
- RSA／解锁阶段：211 文件／2067 单测通过 `raw/passkey-unlock-full-final.log`。之前两次综合运行中两个主密码轮换用例触发 5 秒限时；独立55项通过，最终全部串行通过，未提高测试限时或改变密码学参数。生产构建和安全检查见 `raw/passkey-unlock-build-final.log`、`raw/passkey-unlock-security-final.log`。
- RSA／解锁阶段真实 Edge **51 项全部通过**：`raw/passkey-unlock-edge-final.log`。包括本地／KDBX RSA 协商、排除重复注册、重启签名；Bitwarden 的 ES256 协商与 RSA-only 来源过滤；锁定后主密码／模拟 Hello 解锁；过期、取消、跳转、显式再次锁定；独立 RP 验签和旧计数回退保护。
- 原生接管的成功证据来自 HTTP localhost 的 Edge CDP 虚拟验证器：无 Hello 的设备密钥库返回原生注册成功且扩展未保存凭据。HTTPS 测试域名的 TLS 错误仍只用于证明请求交给原生，不能用于证明真实网站或硬件认证成功。
- 后续自动填充修复：`raw/autofill-field-mutation-red.log` 和 `raw/autofill-field-mutation-edge-red.log` 保留未修复时失败。修复后 **22 项受影响 Edge 流程通过** `raw/autofill-field-mutation-edge-final.log`，其中21项为上述51项的回归，1项为新增同步替换/重试/内部字段保护；合计52个不同测试，不能相加为73项。该最终构建见 `raw/autofill-field-mutation-build-final.log`，两个 TS 配置与安全检查通过。
- 最终代码 **211 文件／2072 单测全部通过**：`raw/autofill-field-mutation-full-final.log`，串行执行。最终源码、构建、测试与草图哈希记录为 `raw/passkey-unlock-autofill-source-hashes.json`。未修改 Android 产品源码；本轮未运行 Android 设备测试。
- 首轮 44 项：13 通过、31 失败，主要是长路径导致 IndexedDB 不能打开。保留 `raw/passkey-autofill-edge-baseline.log`。
- 修正目录后的基线 44 项：40 通过、4 失败。保留 `raw/passkey-autofill-edge-baseline-2.log`。4 项分别为键盘失焦、旧编辑器名称、独立计数测试受自动同步影响、KDBX Node 导出对象问题。
- 中间修复验证 30 项：21 通过、9 失败。新增四算法导入/主密码验证/独立验签/重启，以及焦点和免解锁流程通过；其余出现提示框超时，不能忽略。`raw/passkey-autofill-edge-fixes-1.log`。
- 全量最终单测 210 文件 / 2058 项通过：`raw/passkey-autofill-full-final.log`。前一轮保留了未补齐语言目录及并行资源竞争下的超时；修正七种语言并限制四个 worker 后通过，未提高测试超时。
- 生产构建与两个 TS 配置通过：`raw/passkey-autofill-build-final.log`。协议安全静态检查见 `raw/passkey-autofill-security-final.log`。
- 最终 Edge 45 个不同测试全部通过：`raw/passkey-autofill-edge-final.log` 的 36 项，以及 `raw/passkey-edge-counter-final.log` 的 9 项。先前提示框超时保留在中间日志；最终复验未同时运行全量单测。Edge 版本为 154.0.4258.53。320px 深色自动填充菜单和错误主密码验证窗口截图已实际检查。
- 加强后的多账户用例另行通过 `raw/passkey-edge-account-selection-final.log`：空 allowCredentials 下用 End 选择最后一个账户，实际返回该 credential ID；Escape 取消不返回签名、不改变使用次数。该项是上述用例的增强复验，不重复计入不同测试数。
- 新增 Edge 测试使用合成密钥、真实加密备份 codec、模拟 WebDAV HTTP 响应、真实扩展后台和主密码窗口，以及独立 Node crypto 验签。不是 Android 真机、Windows Hello 硬件或真实网站账户的证据。

## 尚未关闭的可用性差距

新增真实 Bitwarden 路径验证见 [Edge／Android／Vaultwarden 往返](android-bitwarden-passkeys-317.md)：新建 ES256 UUID 凭据的4次浏览器签名、2次 Android 辅助签名、空保险库重建及浏览器重启通过。修复了扩展 UUID/Base64URL 创建确认不匹配；旧 `b64.` 凭据仍被 Android 错解码，Android 还会追加备注说明。认证能力通过不代表这两项字段问题已修复。

1. 锁定后主密码与模拟 Hello 的连续流程已有 Edge 证据；真实 Windows Hello 指纹／人脸硬件验证仍未完成。未设置密码库或设备密钥库未配置 Hello 时，仍按能力交给原生验证器。
2. Conditional UI、silent、跨框架 WebAuthn、非支持扩展参数和外部验证器请求仍交给浏览器；不能宣称这些调用已由 Monica 覆盖。TLS 错误下原生调用失败仅证明离开 Monica，不证明原生验证器成功。
3. MDBX2 实际运行时 RSA 注册／重启以及 Android 对该密钥的保护存储／签名返回现已验证：[Android 与 Edge 实际往返](android-edge-passkeys-317.md)。修复前41→0的失败证据保留；修复后的实际 Edge/MDBX 已完成41→42→43，Android返回文件保留43。真实 WebDAV KDBX的ES256/RS256也通过相同递增及浏览器重启。其他设备同时使用旧副本的全局计数分配、Android系统Credential Manager入口仍未验证。
4. Android 生成/保护存储/MDBX/插件/导回签名现有 [实际 EC／RSA 往返证据](android-passkey-signatures-317.md)：2 个 Android 阶段和2个 Native阶段通过，四枚返回密钥独立验签成功。但 Android 认证数据辅助函数把显式 false BE/BS 变为 true，已实际复现并标为未通过；完整认证入口的历史非零计数、硬件密钥、系统 Credential Manager 与真实 UV 仍未验收。
5. 多凭据候选现在能区分组标签和编号，但 Android 当前 `AutofillPickerActivityV2.kt` 按本地 Room ID 为同项目/账号排序，插件按可交换的组/密码顺序排序编号。Room ID 不跨端稳定，因此不能声称两端显示编号绝对相同；真实成员选择依赖各端记录身份。同步替换输入框已有停止/重试证据，不代表所有网站框架均已覆盖。

本地导入副本和绑定文件来源的正计数已修复，真实 Edge/MDBX 登录及重启验证了41→42→43，最新文件的实际Android回读也保留43。真实Apache WebDAV的交替写入、同时写入、旧计数冲突和丢失上传响应四个场景，以及Edge两算法重启通过；已修复冲突合并后重复签出同一正计数和丢失响应后的盲目重发。Apache同时接受两次相同If-Match的现象仍限制全局并发保证；真实OneDrive与Android系统认证计数策略继续保留为未完成。见 [历史计数修复进度](passkey-counter-history-317.md)。

完整任务仍记录于 `.codex-tasks/android-interop-315/`。混合四成员恢复的 Android 返回现已单独通过，见 [恢复互通证据](mdbx2-mixed-project-restore-317.md)；其余未完成项继续保留。

旧WebDAV加密ZIP的计数路径已独立验证并修复重复42、丢失上传响应与确认上限滞后问题。真实HTTP四场景、实际Edge的ES256/RS256重启及远端42回退拒绝均有专门证据，见 [ZIP历史计数与发布确认](passkey-zip-webdav-history-317.md)。这些结果不替代Android系统入口或任意WebDAV服务器的全局并发保证。
# 2026-10-05 actual Android system follow-up

See [Android Credential Manager device evidence](android-system-credential-manager-317.md). Actual native system picker, production master-password authentication and independent RSA/ES256 verification now pass for two zero-counter MDBX imports. Actual positive-history43→0/backup-flag and unknown allow-list failures are confirmed, and the activity's Cancel action opens a password dialog. This adds real system evidence; earlier helper-only results retain their original scope. Full parity is still incomplete.
