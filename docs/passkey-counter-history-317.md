# Passkey 历史计数修复进度

## 已完成：本地导入副本

本地导入的凭据带有正计数时，插件现在先在加密密码库中持久化递增值，再生成签名。零计数凭据保持为零。取消请求可能跳过一个已保存的数字，不会重复使用该数字；写入失败不授权签名。比较并交换同时检查凭据、绑定、当前计数及修改时间。使用次数仍独立保存。

这个入口只接受实际归属为本地的凭据，不根据 `sourceMode` 字符串猜测归属。MDBX、KDBX、WebDAV 和 Bitwarden 绑定不能借此跳过来源同步。计数上限、已知回退和并发重复申请都有回归测试。

实际 Edge 中，合成导入的 ES256 和 RS256 凭据分别完成 `41 → 42`，关闭并重新启动同一隔离浏览器后完成 `42 → 43`。每次均操作网页提示和真实主密码验证窗口，独立检查凭据 ID、用户句柄、RP 哈希、UV/BE/BS、签名及持久化结果。四次签名均通过。此测试证明本地副本行为，不代表真实网站账户或 Android 系统计数入口已验收。

验证结果：

- 3 个针对性测试文件、52 项测试通过。
- 全量 218 个文件、2211 项测试通过。
- 生产构建、两个 TS 配置和新增 Edge 测试的严格类型检查通过。
- 安全审计通过，仍为 190 个运行时命令；内部计数方法未作为消息接口暴露。
- 1 个真实 Edge 用例通过，包含两种算法及浏览器重启。

日志：`.codex-tasks/android-interop-315/raw/passkey-local-counter-*`。
Edge 结果：`.tmp/passkey-local-history-final/`。
源码、构建及证据摘要：`raw/passkey-local-counter-manifest.json`。

## 已实现并分层验证：文件来源

绑定 MDBX/KDBX/旧 WebDAV 快照的运行时分支现已调用文件来源计数流程。它在密码源操作队列内刷新最新状态，验证身份、历史及冲突，通过加密队列保存递增值，再同步并检查该条修改已经确认且计数一致，最后才返回可签名的凭据。取消会传递给实际同步请求；写入失败保留待同步记录，重试先恢复该记录。零计数仍可离线使用。

现有同步会处理用户此前已经排队的来源修改；被测计数仍有待同步操作时不能签名。局部存储计数并不等于跨设备全局分配。离线旧副本不能保证比另一端刚使用的计数更大；不同后端的并发冲突保证仍取决于各自协议。

- 通用计数流程连同本地／Bitwarden 回归：3 文件、59 项通过。
- 全量回归：219 文件、2225 项通过；生产构建、两个 TS 配置及安全审计通过。
- 真实 Native Host/MDBX 与本地加密 KDBX：ES256、RS256 均从41递增到42，关闭后独立重新打开仍为42，密钥、标识、备注和备份标志一致，签名有效。
- WebDAV/OneDrive KDBX：真实持久工作副本、加密回执及同步组件配合模拟条件文件接口，分别完成两枚密钥的写入；直接读取模拟远端保存的加密文件并独立验签通过。此项不是实际 HTTP 或 Microsoft 登录证据。
- 实际 Edge/Native Messaging：读取之前真实 Android 导出的四枚凭据，正计数凭据从41到42，浏览器重启后到43；另在 UI 创建一枚 RSA 并验证。共10次签名、原生计数回读及导出通过。以前的41→0失败证据保留为修复前记录。
- 最新 Edge 导出的五枚凭据又经过实际 Android 导入、Room保护密钥存储、辅助签名和导出。独立 Native 回读验证密钥、ID、计数43、备份字段和五次签名，结果通过；Android认证入口策略仍未验证。

文件适配器结果在 `.tmp/passkey-file-counters-317-final/`；Edge结果在 `.tmp/passkey-file-counter-native-edge/`；Android结果在 `.tmp/android-file-counter-passkeys-317/`。本轮复用未修改的Android应用并重建测试包，安装前后核对APK、源码和输入／输出哈希；原应用及测试包恢复后再次核对一致，保留外部任务启动的公共AVD。

本地 KDBX 验收包括显式导出加密文件，不能声称插件已写入用户选择的原文件。旧WebDAV加密ZIP来源现有单独的真实HTTP、双客户端、Edge重启和回退拒绝验证，见 [ZIP计数与同步确认](passkey-zip-webdav-history-317.md)；远端KDBX真实HTTP结果见下一节。真实OneDrive登录仍受SPA回调配置约束。

Bitwarden 已有独立的正计数刷新／确认流程，原有全部测试继续通过。其明确保存的历史上限表示已确认远端计数；排队中的递增值可以更高。本轮曾尝试把两者取最大值，10 项现有 Bitwarden 回归揭示这会把尚待提交的计数误判为远端回退；该尝试及对应错误假设测试已撤回，失败日志保留。没有把这个假设计为产品缺陷修复。

Android 的 `b64.` ID、追加备注、BE/BS 和 API34+ Credential Manager 实际入口仍待处理；现有 Android 源码只读范围确认尚未回复。真实 OneDrive 登录仍等待公共客户端 SPA 回调配置。整体互通目标未完成。

## 真实 Apache WebDAV：计数冲突、丢失响应和 Edge 重启

2026-10-05 新增四个真实 HTTP 场景。两个独立密码库、KDBX 会话和持久同步协调器访问同一个合成加密文件，网络故障只在 fetch 边界注入。每次签名独立验证，最终文件重新下载、解密并核对计数与凭据身份。

| 场景 | 修复后的结果 |
| --- | --- |
| 两客户端交替使用 | 返回42、43、44，远端为44 |
| 首次上传同时放行 | Apache接受两个相同If-Match的PUT；一方因字节回读不符被阻止签名，另一方返回42 |
| B预留42后，等A已签出42再上传 | B得到412，合并后重新分配，最终A返回42、B返回43 |
| 服务器成功写入但客户端丢失响应 | 读取远端精确字节确认成功，只发送一次PUT，返回42 |

修复前，旧计数冲突场景两方都签出了42：KDBX合并相同字段值并不代表第二个客户端拥有这个数字。同步结果现在返回是否发生远端合并；签名前最多重新预留三次，持续竞争时停止本次登录。另一个失败来自传输层将PUT标为可自动重试，默认策略会在核对远端前重发；现已取消PUT盲目重试，由已有字节核对流程处理不确定结果。

第一轮失败保存在 `.tmp/passkey-real-webdav-counters-317-first/`；第二轮重复42的失败保存在 `...-second/`；修复后四项通过在 `...-third/`。保留服务器确实返回两个204的观察，**不将WebDAV的If-Match视为已证明原子分配的机制**。同一瞬间不同上传的所有调度、其他客户端和离线副本仍可能超出目前的并发保证。被观察到的字节回读拒绝只证明这个具体调度安全。

实际Edge154.0.4258.53再独立验证两个合成导入的历史凭据：ES256和RS256均41→42，完全关闭、重启同一隔离配置后42→43。操作真实网页Passkey提示及主密码窗口，四次签名、ID、用户句柄、RP、UV、BE/BS和每次远端加密文件回读均通过。结果在 `.tmp/passkey-webdav-history-edge-317-second/`，最终文件SHA256为 `91639517585ddfb9a4778083f8cf2fe7fb71583f8139a25e2dc2d5f3dedc315b`。这是合成导入凭据的当前Edge/WebDAV证据，不替代已有扩展注册→Android返回测试，也不新增Android系统入口或Microsoft登录结论。

验证：针对性3文件34项通过；全量219文件2227项通过；生产构建、两个TS配置、新Edge用例严格类型检查和安全审计190命令通过。首次全量运行有一项Bitwarden加密测试5秒超时，遗留异步任务干扰下一项统计；单独10项重跑与降低至2个worker的完整运行均通过，未修改Bitwarden产品或放宽断言。首次构建发现新增网络测试上传字节的TS类型问题，已改为显式拷贝；首次Edge夹具遇到Node CJS命名空间差异，改用现有双环境KDBX夹具和直接独立文件读取。所有初次失败日志保留。

复现命令（需已启动隔离Apache，配置只保存在忽略目录的合成账号文件中）：

```powershell
$env:MONICA_317_REAL_WEBDAV_COUNTER_OUTPUT = Join-Path (Get-Location).Path '.tmp/passkey-real-webdav-counters-new'
npx vitest run --config vitest.webdav-passkey-counters.config.ts
$env:MONICA_317_WEBDAV_HISTORY_OUTPUT = Join-Path (Get-Location).Path '.tmp/passkey-webdav-history-edge-new'
npx playwright test tests/e2e/passkey-webdav-history.spec.ts --output=.tmp/passkey-webdav-history-edge-new/results
```

本节源码、构建、测试和证据摘要位于 `raw/passkey-webdav-counter-manifest.json`。Android源码和公共AVD未修改；只启动了此前停止的隔离Apache，验证后停止该容器并保留数据卷。后续旧ZIP备份的真实计数同步和缺陷修复记录在 [独立报告](passkey-zip-webdav-history-317.md)。更完整的竞争保护和真实OneDrive仍需继续。
