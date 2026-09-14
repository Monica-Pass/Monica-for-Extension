# 0.1.45 验证记录

> 本地开发阶段记录：文中的版本号未作为 GitHub Release 发布，相关改动已汇总到[正式版 0.1.37](RELEASE-0.1.37.md)。

日期：2026-09-15。本次交付为本地开发包，使用 `--allow-dirty` 保留工作区已有改动，没有上传 GitHub 或发布 Release。

## 改动范围

Popup 登录项改用共享行组件和 M3E 列表，图标、标题/用户名与复制操作横向排列。不可填充时使用静态列表内容，复制按钮独立于填充按钮。Passkey 状态与钱包项目也采用同一套列表布局。

移除旧胶囊按钮及重复卡片样式，处理长文字挤压图标、搜索输入框重复焦点描边和暗色 Nothing 配色残留的固定绿色。工具栏首次打开即使用 600px 内容高度；独立页面继续按可用窗口高度滚动。

没有新增依赖、权限、字体或图标服务；本轮没有修改密码库格式、Android 数据兼容、同步协议或 Passkey 签名计数逻辑。

## 自动化与浏览器验证

- `npm run build` 通过：TypeScript、225 个打包图标校验、生产构建、Worker 构建和扩展页面资源检查。
- `npx vitest run src/core/website-icon.test.ts src/lib/website-icon-cache.test.ts src/commercial-acceptance.test.ts`：44 项通过。
- 30 项不同浏览器用例的最新结果全部通过，来自 `login.spec.ts`、`locked-autofill.spec.ts`、`wallet.spec.ts`、`responsive-layout.spec.ts`、`performance.spec.ts` 和 `website-icons.spec.ts`。覆盖登录/TOTP/嵌入表单填充、免解锁授权边界、钱包填充、Passkey 状态展示、123 条合成账号的搜索与分页，以及 320–2560px 窗口和 200% 字体。
- 首次浏览器回归中，大库用例有一处仍查找旧 `strong` 标签而超时；更新为当前标题定位后，11 项受影响的 Popup 用例补跑全部通过。最后的配色调整又补跑了 2 项图标/布局用例。统计按用例取最新结果，不重复计数。
- `scripts/action-popup-probe.mjs` 在独立 Chromium profile 中完成无界面检查，并在实际工具栏窗口中复核：CSS 尺寸 390×600px，鼠标和键盘复制不触发填充，匹配项仍可正常填写，不支持填充的浏览器页面只提供静态信息和复制。检查了长文字、收藏/验证码标记、44px 操作区域和 200% 字体下的六种额外语言。
- 实际查看了普通列表、长标题、不可填充页面、Monica/Nothing 深浅配色及放大字体截图。
- `npm run verify:supply-chain`、`node scripts/security-audit.mjs` 和 `git -c core.safecrlf=false diff --check` 通过；`npm run audit:production` 报告 0 个已知漏洞。

初次报告：`.artifacts/pr45-report.json`；专项补跑：`.artifacts/pf45-report.json`；最终配色检查：`.artifacts/pc45-report.json`。合成截图分别位于对应目录，实际工具栏截图及便于查看的预览位于 `.artifacts/pl45/`。

本轮未重新执行完整 `release:check`、Rust/Android 互操作、真实 Windows Hello 或真实网站 Passkey 验收。构建仍有既有的大 JavaScript 分块提示；没有根据本次布局检查推断整体 CPU、内存或同步吞吐提升。

## 本地安装包

- ZIP：`release/monica-extension-0.1.45.zip`
- 固定加载目录：`release/monica-extension-unpacked`，已更新为同一版本。
- 程序文件：50 个。
- ZIP 大小：1,997,586 字节。
- 解压大小：6,809,029 字节。
- SHA-256：`ab85fa21e1295b57626ea03982718994be1e5ec43a0ad4abb2e7e699f608e70a`

`node scripts/package-release.mjs --allow-dirty` 与 `node scripts/verify-release.mjs --allow-dirty` 通过；逐文件哈希、清单及两次独立重新打包均一致。检查 ZIP 的全部 50 个路径，只包含程序、图标、字体、翻译、许可证及构建证据，没有密码库、浏览器配置、测试夹具、证书密钥或截图。

已从上述固定目录加载扩展时，在扩展管理页点击“重新加载”即可；使用 ZIP 时解压后加载目录。无需移除现有扩展。
