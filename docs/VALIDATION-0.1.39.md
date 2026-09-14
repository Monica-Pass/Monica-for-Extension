# 0.1.39 Passkey 来源策略验证

> 本地开发阶段记录：文中的版本号未作为 GitHub Release 发布，相关改动已汇总到[正式版 0.1.37](RELEASE-0.1.37.md)。

验证日期：2026-09-14。全部凭据、服务器响应、浏览器配置及数据库均为合成夹具；没有读取用户密码库或使用真实网站账户。

## 策略与单元测试

完整 `npm test`：**130 个文件、1,215 项通过**。新增断言覆盖：

- 按真实 provider 绑定区分本地／快照／文件库／Bitwarden，拒绝冲突或失效的绑定；手动快照导入清除旧绑定并保留明确的备份标志。
- 零计数 Bitwarden 登录无需网络、不写 Cipher、不进入修改队列。历史正计数从远端 9000 更新为 9001，远端确认后才生成可独立验签的结果。
- 两个模拟客户端交替推进计数，父登录、同组其他 FIDO2 凭据和未知字段保留；其他项目的排队修改不被清空。
- 服务器失败、版本冲突、响应丢失、取消或凭据变更时不授权签名；响应丢失后先核对持久回执，不重复提交旧计数。
- 使用统计与内容变更分开；与远端内容修改同时发生时保留本机统计，不误报冲突。KDBX 不新增历史，MDBX2 不新增提交；旧版包含统计的指纹基线可直接比较。

两客户端交替测试进行了多次加密读写，超时设为 15 秒，避免与 Android JVM 编译同时运行时受到原 5 秒限制。最终完整单测单独运行通过。

`npm run build`、TypeScript 检查、扩展页面资源检查、安全审计及供应链检查通过。13 条新错误提示已补齐全部 7 个非中文离线语言目录；中文使用原文。权限和 CSP 维持既有边界。

## Chromium MV3

最终 0.1.39 程序产物覆盖下列 **31 个场景**：

```powershell
npx playwright test tests/e2e/passkey-bitwarden-counter.spec.ts tests/e2e/passkey-portability.spec.ts tests/e2e/passkey.spec.ts tests/e2e/passkey-windows-hello.spec.ts tests/e2e/keepass-webdav.spec.ts tests/e2e/keepass-webdav-runtime.spec.ts tests/e2e/login.spec.ts tests/e2e/autofill-site-policy.spec.ts --output="$env:TEMP/monica-final-39" --max-failures=3
```

首次 28 项通过；另外 3 项使用旧版“登录必上传”的预期，或没有模拟历史非零计数所需的服务器更新接口。更新对应测试后，以下两个文件 **10 项全部通过**，其余 21 项的程序与测试保持不变：

```powershell
npx playwright test tests/e2e/passkey.spec.ts tests/e2e/keepass-webdav.spec.ts --output="$env:TEMP/monica-passkey-regression-39" --max-failures=3
```

覆盖真实 MV3 消息边界、MAIN/content 请求桥、Bitwarden 离线零计数、远端正计数、缺失凭据刷新、服务器失败与取消、UV 主密码／模拟 Windows Hello、锁定与导航撤销、KDBX 离线双副本、WebDAV 冲突、后台重启恢复及普通登录填充。失败时网页不收到签名；同步失败提示保留在 Monica 确认框，允许用户取消或重试。

## Android 实际核心源码互通

以下独立 JVM 测试在 60 秒内完成。它逐字复制、编译 Android 的 8 份真实核心源码，不编译或修改 Android 应用生产代码：

```powershell
$env:MONICA_KEEPASS_INTEROP_KEEP = '1'
$env:MONICA_KEEPASS_INTEROP_STANDALONE = '1'
$env:MONICA_KEEPASS_INTEROP_OFFLINE = '1'
$env:MONICA_ANDROID_API_JAR = 'D:/AndroidSDK/platforms/android-35/android.jar'
npm run test:keepass-interop
```

- Android revision：`7b80545892a6802696c0e00fe3362c8a9656367a`；8 份源文件测试前后哈希一致。
- AES-256／ChaCha20 KDBX 往返通过；私钥、credential ID、字段、历史、附件及未知数据保留；Twofish 仍明确拒绝。
- 插件按文件库策略使用零签名计数；Android 真实私钥解析与 KDBX codec 读回后再次签名，4 份 Android 签名由 Node 独立验签。
- 测试另外显式写入计数／统计作为序列化样本；生产登录流程本身不因此更新 KDBX 文件，另由浏览器字节一致性断言验证。

证据保存在被忽略的 `.artifacts/passkey-0.1.39/android-keepass-evidence.json`，SHA-256 为 `5cace7e1d23d8d17691f620e5203d9a8d72d70648161b9c7137703de5e2f5f5a`。

## 本地安装包

`package-release.mjs --allow-dirty` 与 `verify-release.mjs --allow-dirty` 通过；ZIP、清单、文件哈希及两次独立打包字节一致。

- 文件：`release/monica-extension-0.1.39.zip`。
- SHA-256：`3b4a49faabe4cf2aa5d6e7a4b1798254e6b9bbb4f31dc8cb5a20ff360c298f9f`。
- 共 54 个文件：49 个程序资源及 5 个许可证／构建说明文件。程序包白名单验证通过，不包含用户密码库、导出备份、截图或浏览器配置。
- `release/monica-extension-unpacked` 已更新到 0.1.39，保留之前的 ZIP。本轮仅本地打包，没有上传 GitHub；本机助手沿用 0.1.1。
- 当前工作区包含未提交的既有 UI/API 密钥工作和本轮修复，产物如实标记 `trackedWorktreeClean: false`。

## 范围与限制

2026-09-14 独立审查后另有源码修补：保留历史计数、阻止远端回退，并用 1 秒容差模型验证并发限制。原 ZIP、哈希和本页此前测试记录保持原义，不能用来证明后续源码已重新打包。后续验证见 [审查后修补记录](PASSKEY_COUNTER_REVIEW_FOLLOWUP.md)。

Bitwarden 官方计数规则的固定源码引用及三类来源区别见 [兼容策略](PASSKEY_COMPATIBILITY.md)。本轮没有进行真实 Bitwarden 服务、真实网站账户、Android 真机 Credential Manager 或 Windows Hello 硬件验收。Android 现有认证代码仍统一归零，历史非零 Bitwarden 分支需要单独对齐；不能将本轮插件验证视为该 Android 路径已经修复。

已经在网站保存的非零计数，不能靠归零或固定不动可靠地迁移。需要零计数的历史独立副本可能必须在网站重新注册。MDBX1 仍需先升级，浏览器签名仍限 ES256。
