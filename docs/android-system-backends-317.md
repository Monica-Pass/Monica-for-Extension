# Android 系统 Passkey：KDBX、WebDAV、Bitwarden

2026-10-06 范围澄清：下文是历史验收记录，不能把所有字段差异等同于产品缺陷。`PasskeyEntry.isBackedUp` 的既有定义是 WebDAV 备份记账，不是 WebAuthn BE/BS；因此它与原始 `backupState` 不同，本身不能证明协议元数据丢失。协议响应中硬编码 BE/BS 与原注册元数据的兼容性需独立核查。零签名计数是刻意保留的多端设计，不在本次修改范围；认证入口改用账号名属于显示/隐私改进，管理页原有备注优先设计保留。ID 错解码、未知非空允许列表返回其他凭据、取消跳转密码框、同步改写备注则有各自可复现证据。

2026-10-06：三条实际系统登录路径均通过，字段与界面检查仍有失败。Android 产品源码未修改，完整互通尚未完成。

| 来源 | 凭据 | 系统认证结果 |
| --- | --- | --- |
| 精确原始 Edge KDBX 导出 | RSA / RS256 | PASS |
| 原始 Edge KDBX 经真实 Apache WebDAV 下载 | EC / ES256 | PASS |
| 原始 Edge UUID 凭据经真实 Vaultwarden 下载 | EC / ES256 | PASS |

三枚凭据均经过 Android 系统 Credential Manager → 系统选择器 → Monica 实际主密码输入框 → 独立原生 RP 返回值。独立 Node crypto 验证原注册公钥、凭据 ID、用户句柄、随机挑战、RP ID、签名、UV/UP、BE/BS、零计数，以及 RP 实际签名证书来源。

导入使用生产 `WebDavKeePassFileSource`、`KeePassKdbxService`、`PasskeyRepository` 和 `CipherSyncProcessor`。测试只初始化空的合成安装，不调用签名辅助函数。导入 instrumentation 正常结束并锁定 SessionManager，之后还停止应用，再进行真实认证。因此本轮有 `OK (1 test)` 的导入结果，以及三次独立的系统认证结果。

认证前后的实际 Room/SQLite 数据库和 WAL 按设备 SHA256 验证、只读打开并通过 integrity_check。三条记录与后端绑定保持原样，每条 `useCount` 增加一次；RSA 原先 useCount 为1，完成后为2，其他两条0→1。Bitwarden 内部 UUID 与 WebAuthn Base64URL 保持同一组字节。

## 仍未通过

- **备份状态投影丢失**：原始 Edge 凭据的 backupState 都是 true，Android 导入后的 `is_backed_up` 都为 false，认证后仍为 false。系统响应的 flags29 与这些原始凭据匹配，但这不证明 Android 按存储元数据生成标志；此前 false 标志被硬编码改为 true 的失败仍成立。
- **备注出现在认证前界面**：实际 Bitwarden 系统选择器和 Monica 主密码验证前页面显示完整存储备注（含此前 Android 自动追加的说明），替代用户名／显示名。XML 与 Room 正文精确对应，实际截图也出现裁切。原因是 `PasskeyEntry.displayTitle()` 优先返回 notes，服务把它作为 CredentialEntry 用户名，Activity 也用它作为账号标题。建议认证入口使用独立的账号显示函数，以 userDisplayName/userName 识别账号，避免把备注用于认证前标题。
- Android 历史正计数回退、未知非空 allowCredentials 仍返回其他凭据、取消按钮行为、旧 `b64.` 凭据 ID 和备注改写缺陷仍未修复。本轮没有重复运行这些已知失败。
- OneDrive 实际 Microsoft 登录与同步仍待 SPA redirect 配置。本轮不覆盖真实网站账户、浏览器来源/DAL、硬件生物识别、官方 Bitwarden 服务或完整后台自动同步生命周期；WebDAV 测试覆盖实际文件传输后导入和系统使用。

凭据验签命令退出0；单独的字段／界面审计退出1，保留 `interoperabilityComplete:false`。不能把3次成功登录计作全部字段或全部后端通过。

## 来源、复跑与清理

- Android HEAD：`8334e6bff9d08529f5d88b911b57a9d0a2579997`，构建前后 tracked source 无变化。新应用 APK SHA256：`4b3b1a59c2e9b4d6e1a0da8111e481f43a6ab168f7c6a08355d6bc849586b028`；测试 APK：`fe32a549be6d8ad36e4dd6775e1fe3d5cc7e5f172f68e11f46daca14b9241c82`。
- 复用现有 `Pixel_Fold_API_35`、`emulator-5560`。三包初始均不存在；安装字节、凭据服务配置和输入法设置有完整日志。测试后恢复设置、移除仅本次安装的三包并停止本次启动的 AVD。原配置／数据盘保留，公共 API32 未启动。
- 复用先前两个已停止的隔离 Docker 容器，测试后按原始容器 ID 和启动时间核对并停止；不删除卷。WebDAV 使用新合成目录，保留旧导回文件。
- 证据目录：`.tmp/android-cm-backends-317/`。`input-provenance.json` 绑定历史 Edge 原始文件，`ready.json` 记录保护存储，`system-acceptance.json` 为3次验签，`metadata-ui-review.json` 记录失败，`before-backends/` 与 `after-backends/` 为实际数据库，`restored.json` 和 `environment-restored.json` 记录环境恢复。
- 设置 `MONICA_CM_BACKENDS=1` 使用既有 `interop-317-android-cm-{device,ui,verify,rp-build}.mjs` 的隔离分支。输入准备为 `interop-317-android-cm-backends-prepare.ts`，字段／界面审计为 `interop-317-android-cm-backends-review.mjs`。构建选 `MONICA_APP_INTEROP_TEST_SET=system-backends`，`MONICA_APP_INTEROP_BUILD_ROOT` 支持独立目录。
- 首轮忘记设置 BUILD_OFFLINE，在设备检查阶段失败、无设备写入；2GB 构建因 JVM heap space 失败；4GB 构建成功。元数据审计首轮使用不可迭代的 XML NodeList，改为 Array.from 后真实审计失败仍保留。日志均在 `.codex-tasks/android-interop-315/raw/android-cm-backends-*.log`。
- 之前缓存清理移除了编译 API jar，因此本轮需要全量构建。构建器现在把经过哈希验证的 API jar 保存到证据目录，后续清理中间目录后仍能复用 APK 仅编译测试；旧 APK／历史证据没有覆盖。
- 收尾清理新增缓存972,743,039字节（约0.97GB），88个受保护文件哈希均未改变。API jar 和所有 APK／证据保留；这是此前约12GB清理之外的本轮新增缓存。详见 `cache-cleanup.json`。
- 构建完成后，Android 工作区出现了另一批 MDBX 修改，包括 PasskeyRepository 的 Room 镜像写入保护；本任务未编辑这些文件。此次结果严格绑定上述已安装 APK，不自动覆盖随后变化的 Android 工作区。最终清单另存当前差异摘要，下一次复用构建需要重新检查来源。

本轮最终清单为 `.codex-tasks/android-interop-315/raw/android-cm-backends-manifest.json`，分别绑定源文件、测试提交中的 Android 源文件、已安装 APK、截图、数据库、原始输入和恢复／清理记录。此前各轮历史清单未重新生成。

本轮没有扩展产品代码或设计变更。新增脚本严格 TS、Node 语法、Android 应用／测试／RP 构建通过；未重复运行此前的完整扩展单测或自动填充用例。
