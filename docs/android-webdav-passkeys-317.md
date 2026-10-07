# 实际 WebDAV / Edge / Android Passkey 往返

2026-10-05：真实 Edge 创建的 ES256 Passkey 已经由插件自动上传到本地隔离 Apache WebDAV，Android 下载、保护存储、签名、修改备注并条件回写后，Edge 自动取回并再次登录，重启后登录也成功。签名均使用原注册公钥独立验证。没有修改 Android 产品源码。

## 已验证链路

1. `tests/e2e/passkey-webdav-android.spec.ts` 的 prepare 阶段在独立目录创建空 KDBX，以扩展运行时连接为默认保存来源。真实网页调用 WebAuthn 创建 ES256，核对 COSE/SPKI、credential ID、用户句柄、算法和认证标志；没有直接向库注入待测私钥。
2. 不调用手动同步，等待插件自动上传。独立 HTTP 下载并解密，核对私钥摘要及元数据。注册后登录、浏览器重启后登录均通过；最终文件与 Android 输入逐字节相同。
3. Android `WebDavKeePassFileSource` 对真实 Apache 执行 stat/read。下载内容的 SHA-256 必须与 Edge 产物一致，然后交给实际 `KeePassKdbxService`、`PasskeyRepository`、Room 保护私钥和 `PasskeyAuthActivity` 的加密辅助函数。备注修改后通过实际 WebDAV 文件源条件写入，并重新下载核对完整文件。
4. 使用旧版本号再次写回原始文件被 `KeePassSourceChangedException` 拒绝；拒绝后远端仍是 Android 新文件。这证明已有陈旧版本的拒绝，不覆盖 stat 与 PUT 之间发生竞争的全部并发矩阵。
5. 独立 Node 读取 Android 返回 KDBX，核对 UUID、credential ID、PKCS#8 摘要、用户名/句柄、算法、零计数和 BE/BS；用 Edge 原公钥验证 Android 签名。
6. return 阶段使用全新 Edge 配置连接同一真实 WebDAV，等待自动同步投影。备注及凭据一致，再次登录和重启后登录均通过，共四次浏览器认证签名和一次 Android 辅助函数签名。

## 边界与已知差异

Android 内部 KDBX payload 仍将 `isBackedUp` 固定为 false，虽然文件中的 BS=true 保留，详见 [KDBX RSA 实测](android-kdbx-passkeys-317.md)。两份返回证据均为 `interoperabilityComplete:false`。这里没有系统 Credential Manager、真实 PIN/生物识别或 Android 浏览器参与；辅助函数签名不等于完整 Android 登录。

这是新注册、零计数、BE/BS=true 的 ES256 凭据。不能外推为历史正计数、显式 false 标志、所有 WebDAV 服务或真实 OneDrive/Bitwarden 都通过。Android 回写后即时 stat 返回弱 ETag，后续 Edge 仍能正常读取；陈旧写入已在 Android 的版本预检查处拒绝，没有将其描述成服务器并发 PUT 竞争测试。

## 来源与原始记录

- Android HEAD：`8334e6bff9d08529f5d88b911b57a9d0a2579997`，普通版 `1.0.317-26100512-36`。应用 APK SHA-256：`3f6ceed197e71317fb2cf41e84cd7c1f62a18b3ab44040613dffba208127d7f1`；测试包：`33bf256946a22a53ba57ec5024532be80b20c8e9c5d25565a67793ee92dd90b4`。
- 输入 KDBX：`6fe4caef01e4e931bfbda40076b259133dda4cfe05b7f8ffe67a1b2621d74148`；Android 返回：`a87347b7174cfce896e933ae4e4c608a252ddcf43dec19cc8b262604e147a23c`。
- `.tmp/android-webdav-passkeys-317/` 保存加密文件、公开密钥预期、输入来源、构建/设备来源、签名、真实传输及 Edge prepare/return 证据。仅合成的 WebDAV 凭据保存在忽略目录，通过 stdin 写入 Android 应用私有目录并于测试后删除。
- 原始日志在 `.codex-tasks/android-interop-315/raw/`：`webdav-passkey-edge-prepare-2.log`、`android-webdav-passkeys-build.log`、`android-webdav-passkeys-device.log`、`android-webdav-passkeys-return.log`、`webdav-passkey-edge-return-2.log`、`webdav-passkey-check.log`、`webdav-passkey-e2e-types.log`。
- 初次 prepare 因测试脚本的 KDBX CJS/ESM 入口错误失败；首次 return 在异步自动投影完成前直接读取空列表失败。修正测试入口及等待条件后通过，旧日志/trace 保留。没有通过手动同步掩盖自动同步验证。
- 第一次安装检查遇到公共 AVD instrumentation 忙或服务暂不可用，在任何安装前拒绝。重新确认可用且无 instrumentation 后运行成功。原普通版/测试包按 SHA-256 恢复，公共 AVD 由其他任务启动，保持运行；未清空应用数据、未交付 APK。

扩展产品与此前 OneDrive 完整构建一致，1651 个 `src/dist` 文件已核对。本阶段为两个 Edge 阶段、一个 Android instrumentation、一个独立返回验证；两套 TypeScript 和新 E2E 严格类型检查通过，没有重复计入上一轮全量单元测试。
