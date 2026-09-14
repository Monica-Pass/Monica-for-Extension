# 0.1.38 Passkey 验证记录

> 本地开发阶段记录：文中的版本号未作为 GitHub Release 发布，相关改动已汇总到[正式版 0.1.37](RELEASE-0.1.37.md)。

验证日期：2026-09-14。全部凭据、密码和数据库均为测试生成；未读取用户密码库、尝试真实账户登录或修改 Android 生产源码。

## 单元测试与构建

- 本轮完整单元测试：128 个文件、1,190 项通过。覆盖多副本真实签名、零签名计数、独立使用次数、KeePass 重开、密钥引用保留、备份标志和身份验证边界。
- KeePass 普通登录回退逻辑的最后调整后，定向复测 28 项全部通过。
- 0.1.38 构建通过，包含 TypeScript 检查及三个扩展页面的本地资源校验。新增的跨端测试也通过单独 TypeScript 检查。
- 安全审计通过：验证消息未开放给网页，验证页面不是 Web Accessible Resource；离线语言目录、权限与 CSP 检查通过，产物不含测试密码和源码映射。

## Chromium MV3 浏览器回归

最终 0.1.38 构建上，下列七个文件合计 **26 项全部通过**：

```powershell
npx playwright test tests/e2e/passkey-portability.spec.ts tests/e2e/passkey.spec.ts tests/e2e/passkey-windows-hello.spec.ts tests/e2e/keepass-webdav.spec.ts tests/e2e/keepass-webdav-runtime.spec.ts tests/e2e/login.spec.ts tests/e2e/autofill-site-policy.spec.ts --output="$env:TEMP/mr38" --max-failures=4
```

- 两个独立离线浏览器配置导入同一合成 KDBX，以 GitHub 请求形状（`userVerification: required`、空 `allowCredentials`）轮流完成四次认证；逐次用独立公钥验签，并验证 RP 哈希、来源、挑战、UV、BE/BS 和计数 0。
- 每次重新同步、导出 KDBX，私钥与凭据 ID 不变；两个客户端各自使用次数为 2。测试网页未收到主密码键盘输入，管理页伪造验证消息被拒绝。
- 错误密码不签名；关闭验证窗口、AbortSignal、锁定、导航和验证期间修改凭据均停止签名。
- 网页在内容脚本启动前发起请求仍可完成；要求 UV 的新凭据注册成功。
- 验证页在深色、320px 宽、200% 字号下无横向溢出，Axe 无严重或关键级别问题，使用 Monica 官方图标。
- 原有本地、Bitwarden、KeePass 注册和认证、排除凭据、撤销与锁定，以及 WebDAV 持久化和登录填充回归通过。
- Windows Hello 场景使用隔离的测试 Native Host；设备密钥库未配置 Hello 时仍回退至浏览器验证器。

## Android KeePass 双向互通

测试入口为 `npm run test:keepass-interop`。首次整应用 JVM 运行在 Kotlin 编译阶段超过 15 分钟，且检测到 Android 工作区有并发变动，因此没有将该次运行记作通过。随后在独立 JVM 工程中逐字复制并编译 Android 的 8 份核心源码，使用相同 Kotpass、Room 注解和 Kotlin 序列化依赖，**完整互通场景通过**。编译和测试输出均写入扩展的临时目录，8 份原始源码的 SHA-256 在测试前后保持一致。

```powershell
$env:MONICA_KEEPASS_INTEROP_KEEP = '1'
$env:MONICA_KEEPASS_INTEROP_STANDALONE = '1'
$env:MONICA_KEEPASS_INTEROP_OFFLINE = '1'
$env:MONICA_ANDROID_API_JAR = 'D:/AndroidSDK/platforms/android-35/android.jar'
npm run test:keepass-interop
```

SDK 路径需对应本机安装。离线模式需要已缓存测试依赖，联网解析时可省略 `MONICA_KEEPASS_INTEROP_OFFLINE`。

- Android 源码版本：`7b80545892a6802696c0e00fe3362c8a9656367a`，同时保存 8 份核心源文件哈希，不依赖正在编辑的 Android UI 代码。
- Android Kotpass 生成 AES-256 和 ChaCha20 数据库，插件识别带用户名、网址和备注的 Passkey。登录项、银行卡、证件、附件、历史及未知字段的既有往返保护仍通过；Twofish 保持明确拒绝。
- 另行导出使用过 Passkey 的数据库，不改变原有“未修改字段保持一致”的测试。旧副本存储计数为 4，插件签名及写回为 0，使用次数从 3 变为 4。
- Android 实际 `KeePassPasskeySyncCodec` 读回凭据，`PasskeyPrivateKeySupport` 解码原始和更新后的私钥并签名。Node 独立验证全部 4 份 Android 签名。
- Android 再将使用次数写为 5、计数保留 0，经 Kotpass 导出后由插件再次读回并签名；私钥、凭据 ID、RP 和账号句柄保持一致。
- 本次跨 Android 签名覆盖 Monica 的 BE/BS=true 便携凭据；外部凭据的非备份标志保留另有浏览器核心测试。当前 Android 认证器固定使用自身的 BE/BS 标志，不能据此声称任意外部验证器的凭据都能直接跨端迁移。

本地合成证据保存于 `.artifacts/passkey-0.1.38/android-keepass-evidence.json`，不进入程序包或 Git 提交。

## 本地安装包

`package-release.mjs --allow-dirty` 和 `verify-release.mjs --allow-dirty` 通过。验证 ZIP、原解压加载目录、文件清单、SHA-256 及两次独立打包的字节一致性。

`monica-extension-0.1.38.zip` 共 54 个文件：49 个程序／资源文件及 5 个许可证／构建说明文件；打包前按资源路径白名单检查，未包含密码库、导出备份、浏览器配置、用户截图或本地测试产物。

SHA-256：`1622a769d5483bf5382050c7af32c016e9434097c12055c1011c99d2218ec12a`。

`release/monica-extension-unpacked` 已从 0.1.37 更新为 0.1.38，旧 ZIP 保留。该包由未提交工作区生成，证据如实标记 `trackedWorktreeClean: false`；本轮未上传 GitHub。本机助手沿用 0.1.1，无需为此次 Passkey 修复重新打包。

## 验证范围

GitHub 公共登录页面用于确认请求参数；上述认证在拦截网络的合成页面上执行，没有使用真实用户 GitHub 账户。Android 互通是 JVM 测试，不代表 Android 真机 Credential Manager 或真实 Windows Hello 硬件验收。

恒定零计数预防同步副本之后的计数分叉；不能重置网站已经保存的历史非零计数。无可导出密钥的 Android 引用以及非 ES256 算法不在浏览器签名支持范围。
