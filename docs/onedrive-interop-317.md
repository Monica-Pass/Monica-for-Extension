# OneDrive 与 KDBX 接入记录

插件内 Microsoft 登录、文件选择、自动同步和重新登录恢复已经接通，并通过真实 Edge 的受控网络验收。**Microsoft 账号和真实 OneDrive 尚未验收**，需要先配置 Entra SPA 回调。Android 全面对齐目标仍未完成。

## 已实现

- `onedrive-auth.ts`：使用 Monica Android 的公开应用 ID，授权码与 PKCE S256，严格回调和 state 校验，限定响应大小，刷新令牌轮换，错误不回显服务端描述。
- `onedrive-graph-client.ts`：账号与驱动器信息、分页浏览 KDBX/文件夹、按 drive/item ID 读写。Graph bearer 不进入预授权下载地址；所有请求禁止自动跳转和 cookie。元数据、文件大小、分页次数均有限制。
- `OneDriveKeePassFileClient`：下载前后核对相同文件身份、ETag 与大小；写入携带精确强 ETag；上传响应丢失时只核对内容，不盲目重发 PUT。读取校验失败不会返回文件内容；上传校验失败保留本机工作副本。
- 现有 KDBX 远端会话与持久同步协调器支持 `onedrive` 来源，复用加密工作副本、三方合并、冲突检测与回执。后台已提供 OneDrive 工厂，恢复、自动同步、分组/附件/历史持久化和来源状态均使用远端来源判断。
- `onedrive-token-manager.ts`：并发请求共用一次刷新；令牌保存在加密密码库内；持久化失败不返回未保存的新令牌；锁库可中止刷新。
- `onedrive-session.ts`：绑定密码库会话的临时登录、文件浏览和文件客户端。临时登录最多四个、十分钟过期，不写入明文存储；已保存来源使用加密令牌。取消、锁库和旧回调不能恢复失效登录。
- `SecureVaultService.rotateOneDriveTokens`：在写锁内检查原登录身份和旧令牌，拒绝覆盖新的登录/刷新结果。较早开始的 KDBX 配置更新不会把轮换后的令牌改回旧值。公开来源摘要只显示账号名称、用户名、文件 ID 与状态。
- `sameProviderBinding` 包含 OneDrive 驱动器、文件、账号、应用和登录实例，允许同一登录中的令牌轮换。
- 管理页专属的登录、取消、浏览、连接命令；普通 popup 和网页不能调用。手动/自动锁库、密码库恢复及同密钥重新解锁的 session ID 变化均清理登录和请求。
- `OneDriveKeePassConnections` 与来源同步、KDBX 操作共用队列；提交前保存未落盘修改及回执。重新登录相同账号保留持久连接 ID、缓存密钥与原工作副本；仅验证原文件元数据。不同账号/文件要求新增来源。更换数据库凭据时拒绝覆盖未同步内容。失败只回滚自己写入的工作副本版本。
- 新的 `OneDriveKeePassDialog.vue` 对应本地 Canvas：登录/取消、文件夹/搜索/上级/刷新/选中、密码和密钥文件、默认保存位置、登录过期恢复、错误时的应用配置帮助。关闭或锁库后丢弃旧界面响应。45 条新文案已补齐七种非中文语言；图标字体已重建。
- 加密密码库保存新授权时检查会话及当前来源；旧刷新不能覆盖新授权。更换 KDBX 密码时，也不会回退期间轮换的 OAuth 令牌。成功重新登录清除旧的过期状态。

## 验证范围

OneDrive 专项 105 项测试覆盖授权、Graph 请求边界、真实 KDBX 加解密与会话恢复、EC/RSA 私钥保持、独立签名验证、冲突保留、令牌加密存储与登录会话取消。Graph/OAuth 网络使用测试替身，**不是实际 Microsoft 账号验收**。

当前全量回归：218 个测试文件、2198 项测试通过；生产构建（含两套 TypeScript 检查）通过。安全检查解析 190 个运行时命令通过。

同一最终构建的真实 Edge 验证 4 项通过（`onedrive-integrated-edge-final.log`）：OneDrive 界面登录取消/旧回调、文件夹与搜索、320px 显示、真实 KDBX 解锁、自动上传并独立解密检查、普通 popup 权限拒绝、登录过期恢复、未同步分组/回执保留、浏览器重启；另有本地、KDBX、OneDrive 三条 RSA 注册/协商/排除重复/导出/重启/签名用例。OneDrive 注册用例由实际网页调用 WebAuthn 和独立主密码验证窗口，随后独立读取远端加密 KDBX 中的私钥和 credential ID。Microsoft OAuth/Graph 均为受控替身，不是实际 Microsoft 或 Android 登录。

基础阶段的 SHA-256 清单为 `raw/onedrive-core-evidence-manifest.json`；本轮接线以 `raw/onedrive-integrated-evidence-manifest.json` 为准。之前的全仓库 whitespace 检查报告两处已有问题（`Mdbx2BatchTransferDialog.vue:341`、`import-items.ts:282`）。

EC/RSA 测试保留原 credential ID、PKCS#8、user handle、算法、counter=41、BE/BS，并在重新打开的 KDBX 中取出私钥完成独立签名校验。这没有验证实际 Android Credential Manager 登录，也没有解决此前记录的 Android BE/BS 与文件来源正计数器兼容性缺口，见 [实际 Edge / MDBX / Android 记录](android-edge-passkeys-317.md)。

本地 Canvas 源为 [onedrive-317.m3e.json](design/onedrive-317.m3e.json)，[可编辑链接与设计说明](design/onedrive-317.md)。设计四页证据在 `.tmp/onedrive-canvas-317/`，实际界面截图和测试证据在 `.tmp/onedrive-integrated-edge-final/`。真实 Edge 使用 `tests/e2e/fixtures/edge.ts`，登录前连接禁用、登录中取消、选中文件后的启用及窄屏无横向溢出均已验证。

本轮日志：`onedrive-integrated-tests-final.log`、`onedrive-integrated-build-final.log`、`onedrive-security-final.log`、`onedrive-integrated-edge-final.log`。早期失败均保留：连接单测的分组参数顺序错误、新增文案缺失、图标字体缺失（复用 `.tmp/icon-font-tools` 重建）。第一次 Edge 用例在重启后重新登录时遇到 Playwright 对已恢复扩展 worker 的网络拦截不生效，模拟授权码收到真实 Microsoft 拒绝；没有真实账号登录。后续改为在首个浏览器会话中完成重新登录，并将重启段明确限定为离线恢复，不把重启后的 Microsoft 网络当作通过。

日志位于 `.codex-tasks/android-interop-315/raw/`：`onedrive-session-owner-tests.log`、`onedrive-core-final-tests.log`、`onedrive-core-final-build.log`、`onedrive-canvas-review-final2.log`。早期 `onedrive-session-first.log` 两项失败来自测试把被 ETag 拒绝的请求算作成功写入；已分别记录请求数和实际写入数。早期构建的 Node KeyObject 类型错误已修正为直接使用生成的公钥，最终构建日志为准。Canvas 连续列表修订后的第一次导入确认超时，后续四页重新导入与渲染通过。

## 必须继续完成

后续 [Android KDBX 实际签名及回写](android-kdbx-passkeys-317.md) 已验证模拟 OneDrive 保存的真实 Edge RSA 凭据可由 Android 读入、保护存储、签名和修改备注，返回文件保留同一密钥。Android 内部投影丢失 BS=true 的差异已复现。此补充不替代以下真实 Microsoft 与系统登录验收。

[实际 WebDAV ES256 往返](android-webdav-passkeys-317.md) 也已完成插件自动上传、Android 实际下载/签名/条件回写及 Edge 自动取回/重启后登录。WebDAV 的成功不作为 Microsoft 条件写入的证据。

1. Microsoft 应用注册需配置实际扩展的 SPA 回调，再验证真实登录、刷新及个人/企业盘权限。当前路径加载的扩展回调为 `https://dhocecodmplfgimajabbfokjbpdglnik.chromiumapp.org/onedrive`；默认公共应用 ID 为 `2aaf8c2c-b817-4085-9517-586a4a113dfc`，不用客户端密钥。商店/其他扩展 ID 必须登记其自己的回调。已向用户发出配置问题，尚待回复。Android 公共应用的设备代码能力探测返回 AADSTS70002，不能当作已支持设备代码登录。
2. 使用测试数据库在真实 OneDrive 验证条件写入、并发冲突与下载地址域名；单元测试中的 ETag 服务行为不能代替 Microsoft 实测。当前文件客户端只更新已有 KDBX，不支持创建云端文件；共享快捷方式不作为可选数据库。
3. 实际扩展创建 Passkey → OneDrive/WebDAV KDBX → Android 消费/签名 → 返回扩展，并继续 Bitwarden、MDBX、密码项目、自动填充和完整生命周期矩阵。Android BE/BS、历史正计数器以及 API34+ Credential Manager/真实用户验证问题仍未关闭。

文档依据保存在 raw：`driveitem-get-content.md`、`driveitem-put-content.md`、`driveitem-createuploadsession.md`。普通 Android 的 OneDrive 能力不适用于 F-Droid；本阶段没有修改 Android 产品源码或两版发行说明。
