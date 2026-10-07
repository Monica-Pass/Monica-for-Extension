# Android 实际 Passkey 与 Edge／MDBX 往返

2026-10-05：Android 实际导出的 Passkey 已经过真实 Microsoft Edge、Monica 主密码验证窗口和 Native Messaging 验证。Edge 新建的 RSA Passkey 也已导回 Android 并独立验签。**完整互通仍未通过**：历史非零计数和 Android BE/BS 差异保留为缺口。

## 实际结果

| 环节 | 验证结果 |
| --- | --- |
| Android → Edge | 通过“连接 MDBX2 保险库”导入上一轮 Android 实际返回的加密文件；4枚 ES256／RS256 私钥摘要、凭据 ID、算法、用户句柄和显式 BE/BS 一致 |
| 网站登录 | 实际 `navigator.credentials.get()`、JSON options 解析、Monica 账号选择、独立主密码窗口；4枚签名均由独立 Node crypto 校验 |
| 选择与取消 | 空 allowCredentials、End 选择最后账号、Tab／Enter 确认；Escape 不返回签名，不增加使用次数 |
| RSA 注册 | 网站仅提供 RS256；实际选择默认 MDBX 保存位置；检查 COSE RSA 公钥、SPKI、credential ID、credProps 和认证标志；排除重复注册有效 |
| Native 持久化 | 实际 Native Host 写入、同步并读取全部5枚；私钥摘要、算法、计数和 BE/BS 一致；导出实际加密 MDBX |
| Edge 重启 | 同一隔离配置重启，实际“解锁并设置 → 解锁本机副本”；原有两枚 RSA 和新建 RSA 再次签名成功 |
| Edge → Android | 精确导入最终 Edge 输出；实际 `MdbxViewModel.syncVault`、Room 和受保护私钥存储；Android 签名辅助函数对5枚均成功 |
| Android → Native | 独立 Native/Node 核对5枚身份、原生 object ID、密钥摘要、用户句柄、算法、存储计数及 BE/BS；全部 Android 签名有效，包括 Edge UI 新建的 RSA |

本轮新增 **1个 Edge 端到端用例、1个 Android instrumentation 阶段、1个 Native/Vitest 用例通过**。Edge 首轮与增强后的最终轮属于同一个测试，不重复计数。最终 Edge 用例验证9次签名（包括账号选择和重启），Android 返回验证5次。原有2080单测／22个自动填充 Edge 用例为历史结果，本轮没有重新计入。

`npm run check` 的两个 TS 配置和新增 Edge 测试的严格类型检查通过。逐一核对1638个 `src/`／`dist/` 文件，全部匹配上一轮已验证构建；本轮没有修改产品源码或界面设计。实际账号选择与 RSA 保存位置截图已检查。

全工作区 `git diff --check` 报告两处既有空白问题：`Mdbx2BatchTransferDialog.vue:341` 和 `import-items.ts:282`；两文件字节均与原来源清单相同，本轮未改动。此次新增／编辑文件另做空白检查。

## 未通过项

后续修复（2026-10-05）：第一项的扩展文件来源计数已在新构建中修复。
新的实际 Edge/Native 运行验证41→42、重启后42→43，并将最新五枚凭据
导入Android、签名及独立导回核验，存储计数43保留。详见
[当前计数验证](passkey-counter-history-317.md)。以下原始结果保留为修复前证据；
Android备份标志、系统认证入口及真实UV限制仍然存在。

1. **正计数回退到0**：合成 EC 凭据的存储计数为41；实际 Edge 登录返回0，原存储值仍为41。独立计数检查明确假定 RP 已记录41，此时0不满足递增要求。真实网站是否拒绝取决于其策略；本轮未使用真实网站账户。此问题属于扩展独立文件来源的签名策略，不能用“签名数学上有效”宣称登录必然成功，也不能通过丢弃原计数解决。
2. **Android 备份标志变化**：BE=false/BS=false 应为 `0x05`，BE=true/BS=false 应为 `0x0d`；Android 认证数据辅助函数均返回 `0x1d`。Edge 按存储值分别正确返回5、13、29，Android 导回文件仍保留原值，因此差异发生在 Android 认证数据生成阶段。
3. **系统验证边界**：Android 测试调用真实 Activity 的密码学辅助方法和仓库，未运行完整 Activity 生命周期、Credential Manager 调用链或真实生物识别／PIN 验证。辅助方法的计数参数由测试明确传0，不能用于证明 Android 完整入口处理了历史计数。API32 公共虚拟机也不能代替 API34+ provider UI 验收。

两个结果文件均保存 `interoperabilityComplete:false`。上述缺口和硬件 UV、Conditional UI／silent／iframe 的浏览器移交仍未关闭。Android 产品源码在本任务中保持只读。

## 来源与环境

- Android HEAD：`8334e6bff9d08529f5d88b911b57a9d0a2579997`，应用与测试源码再次匹配上一轮构建。复用实际应用 SHA-256 `a35823fb42c89b64044c04067a2aa5c8fef00f5161fe71c375d17300cd3409d5` 和测试 APK `1acb80a0c3c0ffe2250a557d0f0999c81f87f17c9f3bda598765605e2d5aac20`。
- Edge 输入 SHA-256：`7515845df12267a2e6743dd181771070808b7578ebe63b9a7a4c9ee3338089e5`。最终 Edge 输出及 Android 原样返回 SHA-256：`1b0a02b31ecdfd712f695ea7bc046e005b43d8f2045fa25a51059cbb3282e255`。
- Edge 使用 `tests/e2e/fixtures/edge.ts` 指定已安装 Microsoft Edge，独立短配置目录，headful；Native Host 继承进程限定的隔离 `LOCALAPPDATA`。没有模拟 Native 通信。仅合成 RP 页面由 Playwright 提供。
- 临时 Native 注册表项采用原值备份、并发修改检查、精确恢复；最终恢复成功，无页面异常。独立 Native Host 也已退出。
- 初始 AVD 已停止，本任务启动公共 `Monica_Issue136_API_32`（PID103128）。冷启动后普通版与测试包出现“安装记录存在、APK 路径缺失”，PackageManager 也报告 missing scanned package。安装检查在任何安装之前失败，随后用上一轮已校验的完整备份恢复 APK，再核对字节后安装本次测试包；未清除应用数据。早期辅助脚本的参数绑定／数组条件错误也在只读检查阶段修正。
- 测试结束后恢复原普通版／测试 APK，执行写入刷新并真实重启，两个哈希再次匹配基线。最后停止本任务启动的 AVD，保留配置及数据盘。初次 APK 缺失的具体原因未确定；本轮重启后的校验不能证明以后的冷启动一定不会复发。

## 证据与复跑

最终 Edge 目录：`.tmp/passkey-android-native-final/passkey-android-native-act-4ca71-ugh-Native-Host-and-restart/`，包括 `evidence.json`、`edge-passkeys.mdbx`、公开的 `edge-passkeys-expected.json` 和截图。Android 返回：`.tmp/android-edge-passkeys-317/`，包括来源证明、精确文件输入、`passkey-signatures-import-evidence.json`、`edge-return-evidence.json`、APK 恢复及重启验证记录。

日志：`.codex-tasks/android-interop-315/raw/passkey-android-native-{first,final}.log`、`passkey-edge-android-{import,return}.log`、`passkey-android-native-ts.log`、`passkey-android-native-e2e-ts.log`。来源和产物摘要：同目录 `edge-passkey-evidence-manifest.json`。

Edge 测试指定 `MONICA_317_PASSKEY_ANDROID_FIXTURE` 为上一轮实际 Android 产物目录，运行 `playwright test tests/e2e/passkey-android-native.spec.ts`。Android 沿用 `passkey-signatures` 专用测试集与 `passkey-signatures-import` 阶段，`MONICA_315_APP_FIXTURE` 使用新的隔离目录；输入 `extension-passkeys.mdbx` 必须是最终 Edge 输出的精确副本。独立返回测试通过 `vitest.android-edge-passkeys.config.ts` 运行，显式指定 `MONICA_317_PASSKEY_ANDROID_RETURN` 和 `MONICA_317_PASSKEY_EDGE_RESULT`。缺少输入时跳过，不能把跳过算作验收。
