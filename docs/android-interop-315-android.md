# Android 1.0.315 实际互通证据

本报告由浏览器拓展工作树运行，Android 主仓源码未由本任务修改。验收按真实执行层次区分；未运行的界面或后端不能由其它测试代替。

## 环境与源码边界

- 公共 AVD：`Monica_Issue136_API_32`，API 32，x86_64，已运行的 `emulator-5554`，ADB `D:/AndroidSDK/platform-tools/adb.exe` / 5037。未启动另一台 AVD，未清应用数据或 Keystore。
- 初始 `/data` 空闲 324 MiB，稍后为 334 MiB。多 ABI 的原有 engine test APK 安装曾报 `INSTALL_FAILED_INSUFFICIENT_STORAGE`；runner 已改成仅 x86_64，并将输出隔离到拓展 `.tmp/android-mdbx2-build`。
- 初始安装应用：`1.0.315-26093012-31`，versionCode 12。磁盘已有 `-36` APK。设备运行结果须看每次 `*-evidence.json` 的 `androidVersion`，不能将旧 APK 等同于当前 dirty 源码。
- 现场安装应用 base APK SHA-256：`d0bd2aa68fe1f343967fbc40cc9650c95434db400d55e1ef58e75ae09c3db183`。后续 runner 还保存 `installedTestApkSha256`、注入测试源逐文件哈希；`build` 保存构建的测试 APK 哈希。注入测试 APK使用当前源码编译，但调用的应用类仍来自现场安装的 `-31`。
- Android HEAD：`a19912fb3a521a930400d8a1461f81eb8f65595d`。Android 存在其它工作进行中的修改：HEAD/status 一致时，dirty diff 在不同时间仍发生变化。每次 runner 保存前后 SHA；只在同一次执行内一致时标记 `androidSourcesUnchanged=true`。
- 第一次注入构建前后 dirty diff SHA-256：`460f2e6b5f94c09c5646d44718f26e46483c0e754cbe23c90563b639235c9207`，status SHA-256：`8c25fdd79a44a65ff312373b8155ec3b14a73ec723f648faa637c9655e840064`。
- 2026-09-30 22:51（UTC+8）维护结束后重启验证：先确认设备列表及emulator/qemu进程均为空，再正常启动同一个公共AVD，本任务拥有emulator PID57196。未传维护ramdisk、未清数据或创建其它AVD；boot ID `53ffc4f6-8d2f-460e-9748-4b5c4d479472`，主应用现场变为 `1.0.315-26093012-75`，APK SHA-256 `3ea8e58ac3c01919830f7db6b91962466250018c98bb6ac38fac5da7acbc3a4d`，/data空闲6.3GiB。后续回读属于此新版APK，旧导出fixture仍来自 `-31`，两者分开记账。启动归属记录为 `emulator-resume-ownership.json`，本任务结束需停止这次自己启动的AVD。

## 已通过的独立验证

| 检查 | 实际结果 | 覆盖及限制 |
| --- | --- | --- |
| 公共 AVD 复用/清理单测 | 7 passed | 不停止公共 AVD/global ADB；仅删除 engine runner 自有 fixture 目录，已去除 `pm clear` |
| 已安装 `-31` 应用的 `PasswordContentStorageInstrumentedTest#mdbxSecureFieldsSurviveNativeReopenProjectionAndTitleEdit` | 1 passed，36.761 秒 | TOTP、笔记、卡片、证件、地址的 Android app 原生投影/改标题/重开；包含 TEXT/HIDDEN/BOOLEAN 字段。不是新版拓展闭环 |
| Bitwarden / Vaultwarden server contract | 2 passed | 两个本地有状态模拟服务；登录、个人/组织 Cipher、附件、空同步安全。未连真实公网服务 |
| KeePass Android 核心源码 JVM 往返 | 1 passed，60.05 秒 | AES-256、ChaCha20、显式拒绝 Twofish；Android KDBX → 拓展编辑/签名/导出 → Android 解析/签名/导出 → 拓展签名。附件、历史、时间、未来字段、分组、自定义数据、OTP 原生字段保留；不是 Android 设备 UI |
| Android 应用 fixture 创建/原生重开/ZIP导出 | 1 passed，141.091 秒 | 已安装 `-31` 应用实际创建20条；同标题独立项目、三密码组、10个SecureItem；同时真实复现下列Android写入缺口 |
| MDBX 原生引擎 HTTP WebDAV 分段/Blob 双向交换 | 1 passed，172.30 秒 | 公共AVD，Android 2个分段/9个Blob，拓展1个分段/6个Blob；bootstrap不可变、重启、双向附件与合成银行卡附件。该服务是真实本机HTTP端点，不是公网服务或Android应用UI |

KeePass 当前通过证据：`.tmp/keepass-android-interop/run-LzC4Es/evidence.json`。Bitwarden：`.tmp/bitwarden-contract-interop/evidence.json`。引擎WebDAV：`.tmp/mdbx2-android-interop/run-2HbCyF/evidence.json`。KeePass runner 复制当前 Android 核心源码原文并记录 10 个文件哈希，包括 `KeePassXmlContentParser.kt` 与 `KeePassKotpassXmlReader.java`；不会用 stub 代替 Android 业务编解码器。

## Android 应用层 fixture

注入源码在 `tests/interop/android-app/src/takagi/ru/monica/credentialexchange/`，不写 Android 源目录。`ExtensionAndroid315InteropTest` 复用现有 `TransferFixture`、`PasswordViewModel`、`Mdbx2Repository`、`MdbxViewModel`、附件 facade、全量 ZIP 导出与定向恢复。每次新建独立合成库，正常结束后按精确数据库归属/合成前缀清理。

fixture 覆盖两条同标题独立密码、三成员密码组、多网址/应用绑定、OTP+Passkey 元数据+恢复备注共存、全部五种 OTP（9007199254740993 HOTP counter）、Wi-Fi 企业/代理/IP、SSH/GPG/API Key、全部可用 SecureItem 类型、银行卡低频字段、完整银行卡/笔记副本、真实 PNG 卡面与文本附件、全部五类分段内容块、未知排序 token 与未来字段。

单密码编辑器也可以分配独立 `passwordGroupId`，所以“非空组标记数量=多密码成员数量”是错误测试假设。正确验证是显式三成员共享同一个标记，同标题两条独立项仍是两个项目。

应用导出的原生库、ZIP、记录与写入缺口结果位于 `.tmp/android-app-interop-315/`。`android-writer-gaps.json` 和 `android-known-field-writeback.json` 是对真实持久化结果的观察；即使夹具成功导出，也不代表其中每项兼容性为通过。

首次成功导出的 `android.mdbx` SHA-256 为 `f2bcf9d06057a9e07d44acf9294e8e05ee030057f9111affcdf37eb5acc028f8`；`android.zip` 为 `7d406aa16d19d32d22c5ab55465a5fed3c9ff8cc0141c62a0c885bf702d9863c`。该版合成1px PNG的IDAT CRC有一位错误，故仅能据此验证附件字节保留，不能据此宣称图像预览通过；fixture源码已校正CRC，必须以重新编译后的图片检查结果为准。

之后带独立 Blob 的重导出通过 1 test / 90.762 秒，PNG 原字节 SHA-256 为 `5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15`。`export-evidence.json` 保存新版所有输出哈希。此次运行期间另一个会话修改了 Android dirty 源码，故 runner 最终以非零退出并明确 `androidSourcesUnchanged=false`；测试本身通过不等于源版本一致性通过。

## MDBX 外置 Blob 与真实 Native Host

`MdbxVault.createBackup` 仅复制数据库，不复制外置 Blob 目录。第一次直接把单个 `android.mdbx` 交给 Host 后读取附件失败；不能据此宣称单文件备份完整。修正测试运输协议后，Android 输出 `android-blobs.json` 和 `android-blobs/<sha256>`，Host 通过真实认证 `sync.blob.receive` 接口接收；返程同理使用 `extension-blobs.json`，Android 使用引擎 lease/chunk/finalize API 导入，每份密文大小和 SHA-256 都验证。

真实 Host forward 已通过 1/1：20 条应用导出记录完整读取，逐项标题编辑后未编辑 payload 无损、过期 revision 拒绝，新增1条密码，锁定/Host进程重启/错密码拒绝/正确密码重开、独立 bootstrap+Blob 重开以及所有附件字节通过。证据为 `native-forward-evidence.json`；这不是 Edge UI 验收，也不是 MDBX 单文件完整备份验收。

## 真实 ZIP 新发现（RED 证据保留）

- 目标库全量 ZIP 使用 `totp/item_<id>.json`，拓展只认识 `authenticators/`，20条中5个OTP不可见且无warning。失败证据 `zip-codec-totp-path-failure.json`；修复后20条都可解码。此目标库导出与其它 WebDAV 文件夹导出的路径不同，不能以其中一条代替所有后端。
- 目标库登录文件名为 `passwords/password_<id>.json`，旧附件查找仅识别带时间后缀的文件名，导致两份登录 wallet 附件虽在ZIP里却不可列出。实际manifest与record IDs在 `zip-codec-evidence.json`，不可把“保留字节”当成“可打开附件”。

两个实际缺口修复后，`android315-zip.interop.ts` 通过 1/1：20条记录、独立同标题项目与三密码组、64位HOTP、完整卡片/笔记副本、未知排序token、3个可读取且SHA-256一致的附件；逐个归档成员比对确认标题之外的字段、原目录、原ID、附件manifest及全部二进制成员不变。输出 `extension.zip` SHA-256 为 `6632a96abb875f975815ce1591ee86452e5af2fda5142a5d14cdbc60fe534ca0`，证据 `zip-codec-evidence.json`。

Android 第一次定向 ZIP 恢复通过 1/1（103.542 秒），`imported=20`，但解码中间结果 `secureItems=12`，与归档的10个SecureItem不一致；本轮已新增详细类型/ID报告及完整字段、附件后验断言，不能把首轮“密码数一致”的通过当成全字段恢复通过。运行时仍为 `-31`。

### Android ZIP 类型降级：构建类与设备均已复现

直接在 JVM 调用本轮隔离构建生成的真实 `SecureItemRestoreTypeResolver.class`，不修改或重写 Android 实现，6种显式类型中4通过、2失败：`BILLING_ADDRESS → DOCUMENT`，`PAYMENT_ACCOUNT → BANK_CARD`。探针为 `tests/interop/android-app/probes/SecureTypeProbe.java`，证据 `secure-type-probe-evidence.json`。类 SHA-256 为 `0348350c8f1762bb1e84fbb3f5dc7936d05885ce6442d57682d5df0c5975d368`，对应当前源码 SHA-256 为 `bd3a79e8b2cab1941455ab20b688be7f00cde86650279834637574ca79ef38e0`。这属于当前 Android 构建类的真实逻辑证据，不等同于设备上 `-31` 的新增测试通过。

原因是 `parseTypeAlias` 未列账单地址和支付账号，随后根据 `country/company/postalCode` 或 `iban/routingNumber` 推断成旧类型。`WebDavHelper.restoreCardWalletItemFromJson` 使用了这个结果；后面的后备补充按“是否存在该类型”判断，因此错类后再次重复加入。2026-09-30 23:08（UTC+8）在实际安装的 `-75` 上取得 `extension-zip-decoded.json`，确认ID282账单地址被读成DOCUMENT且出现两次，ID281支付账号被读成BANK_CARD且出现两次。加强后的ZIP测试在解码后断言10项、实际12项而失败（1 test / 3.64秒）；未进入定向恢复写入阶段。实际归档没有CSV成员，CSV去重分支不能解释这份fixture。此失败阻塞完整ZIP恢复验收，不能只按密码条数宣布通过。

最小 Android 建议（未实施）：优先接受所有明确合法的 `ItemType`；只在类型缺失或明确旧别名场景下推断。后备补充按来源文件/稳定记录身份去重，而非“当前列表中不存在某类型”。新增两类的ZIP解码、原类型保持、导入后条数、完整itemData与附件绑定回归。

Host 另有实际缺 Blob 故障检查通过：只导入单个数据库、不传3份 Blob，三次附件读取均明确失败，20个对象 payload/ID/revision 不变；`native-missing-blob-evidence.json`。Android故障预检首次中正确拒绝错误密码/截断归档并传播取消，但最后比较数据库文件字节时因首次打开的SQLite journal元信息初始化而失败；改为对独立拷贝比较逻辑对象并保持原始备份字节不变后重跑。

### 维护结束后的实测结果（接收端 `-75`）

固定安装测试APK快照 `30b2ec1c5cefffd20e715e244c711ce7b683d78c38ff60ac1acd8cb49275c651`；主APK为本报告环境节的 `3ea8e58a…`。四次设备运行均记录相同boot ID、Android源码/测试源前后哈希一致；最新 `*-evidence.json` 包含时间戳和完整输出哈希。

测试包首轮构建10m12s成功，但期间另一个任务修改了Android的 `ApiKeyEntryFields.kt` / `ApiKeyFlowTest.kt` 等文件，完整源码一致性标志为false；本任务也在测试编译前修正了ZIP测试的本地密文解码断言，测试源前后哈希因此不同。实际测试使用的APK已先复制为固定的 `test-75-snapshot.apk` 并校验上述SHA。随后独立第二次构建10m39s也成功，期间Android源码再次变化，来源一致性仍为false；第二份APK未安装、未用于上述四次设备运行。两次构建日志和带时间戳证据保留，不把构建成功当成当前dirty源码精确一致性通过。

| 阶段 | 实际结果 | 范围 |
| --- | --- | --- |
| `edge-ui` | 1 passed / 18.106秒 | Edge实际编辑导出的单条库→Android实际详情→实际编辑用户名→保存→详情截图→导出 |
| `import` | 1 passed / 7.161秒 | 20条Android来源项加1条Host新建密码，共21原生记录→`-75`投影为11密码/10安全项→编辑一条notes→重开与导出3个Blob |
| `zip` | 1 failed / 3.64秒 | 明确复现账单地址/支付账号错类并重复，10→12；未进行恢复写入 |
| `failures` | 1 passed / 4.259秒 | 错MDBX密码、错ZIP密码、截断归档、解密后读取前取消；既有密码/库行、原ZIP/原生文件字节与探针原生对象不变 |

`android-failure-readback.json`列出4个故障情形。取消仅覆盖恢复应用前的decode/preflight阶段，不证明已提交事务过程中的取消回滚。

原生回程文件 `android-return.mdbx` SHA-256为 `bb3cf700adcc49a9cfb8bee3453fad977e5de335ad00b89638830aeac7f091b0`，配套Blob的3个密文SHA与forward相同。最终Host严格回读已交Native专项执行；初始严格比对发现被编辑记录的本地Room ID由59524变59648，尚须枚举完整差异，不能任意忽略后宣布全payload不变。

## 第11节应用层细项矩阵

`通过（业务）`仅指应用 ViewModel/repository → 原生 → Host codec；不是 UI。读取、保留、编辑、业务操作分别列示，未测不能外推。

| 类型/关键字段 | Android业务创建/重开 | Host读取/标题编辑/保留 | 实际ZIP读取 | A/B完整双端UI |
| --- | --- | --- | --- | --- |
| 普通密码、多网址、应用绑定、前导零 | 通过 | 通过 | 通过 | 未完成 |
| 两条同标题独立项目 | 通过，保持2个项目 | 通过，ID独立 | 通过 | 未完成 |
| 三成员显式密码组 | 通过 | 通过，组字段保留 | 通过 | 追加/移除/移动UI未测 |
| OTP+Passkey元数据+恢复备注同条 | 通过 | 通过，非签名验收 | 通过 | 未完成 |
| TOTP/HOTP/Steam/Yandex/mOTP | 通过 | 通过 | totp路径修正后可读 | 未完成 |
| HOTP 9007199254740993 | 通过 | 通过，精度保留 | 通过 | 递增业务未测 |
| 银行卡低频字段/卡面 | 通过 | 通过，附件原字节验证 | 字段与独立卡面可读 | 图像打开UI未测 |
| 笔记正文/外层notes/Markdown/标签 | 通过 | 通过 | 通过 | 未完成 |
| DOCUMENT/BILLING_ADDRESS/PAYMENT_ACCOUNT | 原生投影通过 | 通过，类型不降级 | 拓展可读；Android ZIP恢复两类错类/重复失败 | 未完成 |
| 完整卡片/笔记副本、排序、future token | 通过 | 通过，原串/数组全部保留 | 字段与3附件原字节通过 | 未完成 |
| 5类可重复内容块/分片/Unicode | 通过 | 通过，完整自定义字段保留 | 字段原值可读 | 编辑/渲染UI未测 |
| Wi-Fi企业/代理/IP | Android写入缺失 | 无法凭空恢复 | 源缺失 | 阻塞 |
| 旧SSO/自定义图标 | Android写入缺失 | 无法凭空恢复 | 源缺失 | 阻塞 |
| SSH/GPG/API Key模板 | 通过 | 通过，类型/字段保留 | 通过 | 密钥业务/全部UI未测 |
| 独立API Token/Steam maFile/真正Passkey | 此应用夹具未包含 | 不由本夹具证明 | 不由本夹具证明 | 未测 |
| 未知类型/高版本 | 此应用夹具未包含 | 由其它Host测试单列 | 此实际源未包含 | 未测 |
| 嵌套未来字段/大数字/null | Android普通编辑会丢未来字段 | Host标题编辑已通过现有原值 | 内容字段字符串通过 | Android端阻塞 |

| 规范闭环 | 当前本报告证据 | 不能推定 |
| --- | --- | --- |
| A Android UI创建→Edge读取 | 单密码实际创建/Edge读取编辑已执行；原始JUnit最终标题多节点断言失败，保留历史限制 | 不用业务fixture代替UI；未完成全部类型 |
| B Edge UI创建→Android详情 | 未完成 | Host provider新增不等于EdgeUI |
| C 双向单字段编辑 | 单条Edge→Android UI编辑通过；21条原生Android return已输出，Host严格全字段差异核对中 | 所有字段业务修改未测；本地Room ID重绑定不能静默忽略 |
| D 双端锁定/重启/缓存 | Host进程重启已通过 | Android进程重启/清缓存与Edge锁定需独立证据 |
| E WebDAV bootstrap/segments/Blob | 本机真实HTTP端点引擎往返通过 | 非公网服务、非Android应用同步UI |
| F 全量ZIP→拓展→Android恢复 | 拓展20项/3附件通过；Android加强验收失败，账单地址/支付账号错类并重复 | 首轮计数不证明完整字段/重复项语义；没有全量恢复通过结论 |
| G KeePass/Bitwarden | 当前Android核心源码JVM KeePass通过；Bitwarden/Vaultwarden本地模拟2通过 | 真服务/设备UI未测 |
| H 删除/回收站/归档/移动/层级 | 此应用闭环未执行 | 不由标题编辑测试代替 |

本轮首次UI ANR留下的独立空合成库 `credential-transfer-d2726331-6c56-404c-955e-832ad98422d2` 已通过专用测试精确删除，`ui-cleanup.json` 记录只删除1库；没有用户数据，空合成库可重新生成。两份更早的合成库没有触碰。

### 单条真实 UI 闭环进度与共享 AVD 中断

Android 原始 UI 测试第三次已通过实际编辑器保存、写出 `android-ui.mdbx`、进入详情；最后因标题同时存在于两个节点而断言失败。已将断言改成 `onAllNodesWithText(...).onFirst()`，但不能倒推原次JUnit通过。通过只读恢复获取的这份同一ID/分组fixture已被 Edge 实际加载、详情读取、编辑用户名并点击同步，Native REVEAL确认后经实际UI导出为 `edge-ui-return.mdbx`。原始本地 `android-ui.mdbx` 未被重跑覆盖。

新 `edge-ui` 测试 APK SHA-256 为 `c680f1c6db44effaaecabf3859a69d94078dccfd29bdb1463e1e3d9ea2a65d02`。首次运行卡在JUnit之前：AMS保留不存在的PID16925为Starting/ActiveInstrumentation。本任务只终止准确核对的本次ADB客户端PID76464，未停止公共AVD/global ADB或其它应用。第二次运行输出JUnit START后，ADB以255退出，未返回PASS/FAIL；证据 `edge-ui-2026-09-30T03-02-54.333Z-evidence.json`。随后设备由online变offline，transport ID12变13，现场模拟器进程参数出现其它工作区任务的 `unified-template-editor-315/maintenance-ramdisk.img`，uptime为77秒。本任务未发起该重启；为避免并发维护冲突，已停止提交instrumentation并请求协调使用窗口。该结果记为**环境中断、UI回程未完成**，不是兼容性通过或确定的UI缺陷。

runner现新增已有ActiveInstrumentation/ActivityManager不可用时拒绝提交、前后boot ID比对、非零退出也保留带时间戳的原始日志。公共AVD保持不清数据；不会用重启、清数据或终止别的包“修复”测试环境。

维护结束后 `edge-ui` 已按上表通过。`android-edge-ui-return.mdbx` SHA-256 `0a797ef268b74a97448f1cd282f53cbb309ac0bada95330c73d1b9d7d81a6c57`；JSON确认逻辑entry ID仍为 `password:59530`、组ID仍为 `0dd38d33-be5c-4909-ae8a-cd5e326e1258`、用户名为 `edge-ui-return-用户 · Android UI return`。截图 `android-edge-ui-return.png` 已目视核查：用户名清晰展示、密码仍遮挡。现场保留了1.5字体缩放、840×2100覆盖分辨率、420dpi；未擅自恢复或修改用户显示设置。最终Edge只读重开由Edge专项验证。

本次原始创建复核使用新增 `ui-recheck` 别名，若运行成功只将设备产物拉取为 `recheck-android-ui.*`，不覆盖原始本地链路fixture。首次复核提交被runner安全拒绝：另一个任务正在同一AVD上 `--user 10` 执行API Key/内容块测试，本任务没有终止它或同时提交UI测试。

23:14只读检查时该批instrumentation已退出、当前用户回到0，主应用却已被对方更新到 `-76`。上述四次测试仍归属起始记录的 `-75`，不得追认成 `-76` 验证。后续runner已新增显式`--user 0`、UI当前用户检查和前后主APK/testAPK哈希核对；原始四次证据未事后补造不存在的APK-after数据。虚拟机仍由本任务PID57196持有，因其它任务临时复用，关闭前需确认它们已释放。

## 已复现的 Android 写入阻塞及最小建议

| 实际操作 | 观察结果 | Android侧最小修改建议（未实施） |
| --- | --- | --- |
| `PasswordViewModel.savePasswordsAcrossTargets` 保存含企业认证/代理/IP的 Wi-Fi，然后 `Mdbx2Repository.readStoredEntries` | `wifi_metadata` 不存在 | 在现有 `passwordMutation` 写入完整 Wi-Fi JSON字符串；同步补回读投影，保留其中未知字段。不能让拓展编造缺失数据 |
| 保存 SIMPLE_ICON 图标与更新时间 | native payload没有图标字段 | 增补现有图标类型/值/更新时间的写入与回读；上传图标本机路径须转换为受验证附件引用，不能直接跨端拷贝路径 |
| 保存旧 SSO 提供商与账号引用 | native payload没有提供商与引用 | 提供商需写入；账号引用采用稳定原生身份并保留旧Room引用兼容映射，不能把本机自增ID作为跨设备身份 |
| 原生添加 `future_315={large:9007199254740993,precise:1.234567890123456789012345,null:null,nested:[false,""]}`，再用普通Android编辑器改标题 | `futureFieldPresentBefore=true`、`futureFieldPresentAfter=false`、`entryIdStable=true` | 普通upsert从当前原生payload及revision生成字段patch，复用精确JSON解析，保留未知顶层/嵌套成员和数组扩展。更高payload版本或无法证明无损时禁止保存；不要仅用Room重建整个payload |

具体入口为 Android `repository/Mdbx2Repository.kt::passwordMutation` 与 `upsertMutations` 的 `UpdateEntry(payloadJson=mutation.payloadJson)`。本任务没有修改这些源码。上表按实际安装的 `-31` 运行结果记录；当前源码具有对应写入形状，但不能因此把设备结果替换成另一个APK版本的结果。

## 尚未通过或待完成

| 检查 | 当前状态 | 处理 |
| --- | --- | --- |
| Android Compose 创建→原生→详情 | 首次失败，输入 ANR | `ui.log` / `ui-evidence.json`；未宣称 UI 通过。首次创建的独立合成库可能留作定向清理；不能用清应用数据处理 |
| 原生 engine WebDAV 的最初安装 | 原有多 ABI APK 安装空间不足；已恢复通过 | 仅 x86_64、独立输出目录后重跑通过；保持公共 AVD 数据盘 |
| KeePass 默认 app JVM runner | Windows `classes.jar` 被其它进程占用 | 使用独立 JVM 并复制真实源码，最终该链路已通过；不将 app 构建失败算作协议失败 |
| Android UI 创建全部类型 / 拓展 UI 创建→Android 详情全部类型 | 未完成 | 须逐项检查真实界面，不能以原生记录存在代替 |
| 单条 Edge UI编辑→Android UI回读/编辑→Edge重开 | Android UI回程已通过；Edge最后重开单列 | 保留原单条fixture与分组ID，不能据此外推全部类型 |
| Android ZIP的账单地址/支付账号类型 | 构建类2/6失败；`-75`设备解码1测试失败 | 设备已取得错类与重复ID清单，不修改Android主仓；最小建议见上文 |
| 真公网 WebDAV / Bitwarden / Vaultwarden | 未测试 | 没有本任务提供的独立服务与凭据；未猜测或读取用户账号 |
| Passkey 设备绑定不可导出密钥迁移 | 不可承诺 | 现有 JVM 通过仅验证合成可导出的密钥，不代表硬件密钥可迁移 |

## 可重复命令

运行前确认 AVD 名称和实际序号，不能复制旧序号后盲跑。

```powershell
$env:MONICA_MDBX2_INTEROP_SERIAL = 'emulator-5554'
$env:MONICA_MDBX2_INTEROP_AVD = 'Monica_Issue136_API_32'
$env:MONICA_MDBX2_INTEROP_ADB_SERVER_PORT = '5037'
$env:MONICA_MDBX2_INTEROP_KEEP = '1'
node scripts/interop-315-android-app.mjs build
node scripts/interop-315-android-app.mjs install-test
node scripts/interop-315-android-app.mjs export
node scripts/interop-315-android-app.mjs import
node scripts/interop-315-android-app.mjs zip
node scripts/interop-315-android-app.mjs ui
node scripts/interop-315-android-app.mjs edge-ui
node scripts/interop-315-android-app.mjs failures
$env:MONICA_315_APP_FIXTURE = 'C:/Users/joyins/Desktop/Monica-all/monica-extension/.tmp/android-app-interop-315'
npx vitest run --config vitest.android-interop.config.ts tests/interop/android315-zip.interop.ts
# Read-only Android built-class diagnostic; exit 2 currently means two declared types downgrade.
& tests/interop/android-app/probes/secure-type-probe.ps1 -GradleCache 'D:/GradleRepository' -JavaDirectory 'C:/jdk-17.0.1'
npx vitest run --config vitest.android-interop.config.ts tests/interop/mdbx2-android-webdav.interop.ts
$env:MONICA_KEEPASS_INTEROP_STANDALONE = '1'
$env:MONICA_ANDROID_API_JAR = 'D:/AndroidSDK/platforms/android-35/android.jar'
$env:MONICA_KEEPASS_INTEROP_KEEP = '1'
npm run test:keepass-interop
$env:MONICA_BITWARDEN_INTEROP_KEEP = '1'
npm run test:bitwarden-interop
```

`import` / `zip` 需要同目录已有拓展实际产生的 `extension.mdbx` / `extension.zip`。所有密码和测试记录仅为合成 fixture。当前报告不宣称 100% 双向互通。

### 同库移动附件回读（2026-10-01，进行中）

最终补丁的真实 Edge 恢复已通过（run-oQEK3y）。新增 `android315-moved-attachment-return.interop.ts` 从已关闭的 Edge 保险库生成 Android 输入，拒绝存在 WAL 的数据库，逐个校验加密 Blob；准备阶段已验证移动后的文件夹、附件 UUID、名称、媒体类型、大小及实际解密字节 SHA256。输出 `.tmp/android-moved-attachment-20261001`。

Android instrumentation 新增 AttachmentFacade 在密码编辑前、重开后的附件读取和相等断言。回传阶段还需由 Native 独立读取附件字节并核对两次 Android 投影，尚未运行完成。当前设备实际版本为 `1.0.316-26100112-01`、APK SHA256 `15d2a36aab9fbcfc8a555a146338484e2bb49e313112c800a9b3fcfc4ff39d30`，不能归为旧 1.0.315 APK 证据。首次新测试包构建成功，但 Android 工作区同期发生变化，来源检查失败；原始报告的 status 字段曾在 finally 之前写为 passed，须以 androidSourcesUnchanged=false 和非零退出码判失败。脚本已修复为先合并来源检查再保存状态。

复现时设置 `MONICA_315_APP_FIXTURE` 为独立输出目录、`MONICA_315_MOVE_EDGE_FILE` 为关闭后的合成 Edge vault.mdbx、`MONICA_315_MOVE_LOCATION` 为对应 same-vault-attachment-location.json。先以默认 prepare 阶段运行新增 Vitest 文件，再执行 Android build/install-test/import，最后设置 `MONICA_315_MOVE_PHASE=return` 重跑该文件。不得从附件元数据存在推断附件可读取，也不将 repository/ViewModel 证据当作屏幕 UI 验收。

### 同库移动附件回读已通过

最终 import-evidence.json 的 source/test/APK/device 一致性检查全部为 true。Android AttachmentFacade 编辑前和重新打开后读取附件，独立 Native 回传再核对附件 UUID、目标文件夹、文件名、媒体类型、大小和实际字节 SHA256，均通过。证据 `.tmp/android-moved-attachment-20261001/moved-attachment-return-evidence.json`、`extension-native-readback.json`；日志 `raw/moved-attachment-import-final.log`、`raw/moved-attachment-return.log`。实际最终 APK SHA256 `e35047d81272deabc64cec0bb6761715e570bf8fd99951c50b2c995c5a2c18f1`；不得混用上文中间阶段 APK 指纹。公共 AVD 在确认没有其他测试后已关闭并保留数据。此项证明附件移动后的 repository/ViewModel 往返，不等于所有字段和屏幕 UI 已验收。

### 关联笔记整组移动：Android 回读通过

真实 Edge `run-EYTP5E` 恢复后的两个密码、共享笔记、三个附件已通过 Android 导入/编辑/重开和独立 Native 回读。两个 Android Room 绑定均指向同一个笔记行；稳定笔记 ID、密码分组、目标文件夹、全部原生 UUID 保留，笔记 item_data 完全一致。三个附件包括笔记附件，UUID/归属/名称/媒体类型/大小和实际解密字节全部一致。证据 `.tmp/android-linked-move-20261001/note-return-evidence.json`、`note-attachment-return-evidence.json`。Android 屏幕 UI 尚未据此验收。

### 当前版本完整样本：严格往返仍有差异

新样本 `.tmp/android-full-current-20261001` 的实际 Android 导出、Native 全类型读取/编辑、缺失 Blob 拒绝读取且不修改记录、Android 再导入/编辑均通过。严格回传比较仍失败：一个密码记录的 `/payload/room_id` 从59717变为59732；这是 Android 重建本地行后的投影差异，保留失败，不将其伪称精确逐字段相等。该比较的其他字段、原生 UUID、元数据和附件断言通过。图标及 SSO 字段仍未由 Android writer 写入，普通编辑仍删除未知 future_315 字段，见 android-writer-gaps.json 和 android-known-field-writeback.json。上述结果不支持宣称完全双向互通。
