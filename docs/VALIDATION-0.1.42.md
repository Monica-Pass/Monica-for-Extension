# 0.1.42 UI 验证

> 本地开发阶段记录：文中的版本号未作为 GitHub Release 发布，相关改动已汇总到[正式版 0.1.37](RELEASE-0.1.37.md)。

日期：2026-09-14 至 2026-09-15。在 0.1.41 工作区基础上调整 M3 Expressive 界面；所有测试使用合成记录、模拟同步服务和新建临时浏览器配置，没有读取真实密码库。

## 浏览器交互与布局

本轮覆盖 **65 个不同的 Chromium MV3 场景**，发现的问题已修复并复测通过：

| 范围 | 场景数 | 结果 |
| --- | ---: | --- |
| 响应式、无障碍、视觉、管理操作、密码库导航、API 密钥、自动同步、拆分菜单 | 55 | 通过，包含修复后的定向复测 |
| Passkey 独立验证页与可移植凭据 | 7 | 通过 |
| 语言切换、英文窄屏与 200% 字体 | 3 | 通过 |

初次 UI 整组执行 54 项，其中 51 项通过，3 项暴露了卡片内外圆角不同，以及拆分按钮的图标随文字放大后超出固定图标槽的问题。统一卡片 shape token，并设置上游实际使用的 split-button 图标 token 后，相关检查通过。

增加无 Popover API 的回退场景，并复跑菜单和视觉共 21 项：19 项通过，另外发现旧测试仍假定新安装默认 Nothing，以及窄屏下筛选按钮被压缩。默认值断言已按 Monica 默认配色更新；工具栏让普通操作保留内容宽度并换行。最后定向复测这 2 项，均通过。没有放宽图标、圆角、溢出或焦点检查。

主要覆盖：

- 当前页面的左侧新建动作、右侧全部 11 种手动创建类型、跨类型创建和保存、无手动 Passkey 入口。
- 菜单的 ArrowUp / ArrowDown、Home / End、Escape、外部关闭、导航关闭和选择后焦点恢复。
- 320px 窗口、200% 字体、打开后缩小窗口；全部类型可以滚动访问，两个按钮的点击区域互不覆盖。
- 移除 Popover API 后，键盘和鼠标都能通过完整选择器进入其他类型编辑器。此项是功能缺失模拟，不等于在 Chrome 109 实机验证。
- 关闭原生表单下拉时保留编辑草稿；选择 Wi-Fi 类型后草稿与专用字段仍正确。
- 外观对话框的 Tab 循环、关闭后焦点恢复、保存 Nothing 偏好及刷新后恢复；新安装默认 Monica。
- 详情与编辑器的固定头尾、正文滚动、窄屏布局、文字放大、明暗主题和减少动态效果。
- 新建、编辑、导入、删除、主密码更换与加密备份恢复；API 密钥保持敏感字段遮罩和专用类型边界。
- 模拟移动端通知后的列表、详情和 Popup 更新；单 Cipher 增量、保留草稿、阻止过时保存、正常保存上传、重连、令牌刷新、worker 重启和锁库。
- Passkey 验证页主密码错误、两个离线客户端的签名验证、取消 / 关闭 / 锁库 / 导航 / 凭据变化时拒绝继续，以及注册和页面提前请求。
- 英文与中文切换后用户记录不被翻译；英文浅色和深色窄屏在 200% 字体下保持操作完整。

本轮执行的浏览器命令：

```powershell
npx playwright test tests/e2e/m3e-interactions.spec.ts tests/e2e/responsive-layout.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/visual-polish.spec.ts tests/e2e/manager.spec.ts tests/e2e/vault-navigation.spec.ts tests/e2e/api-token.spec.ts tests/e2e/automatic-sync.spec.ts --output="$env:TEMP/monica-m3e-42-full"
npx playwright test tests/e2e/m3e-interactions.spec.ts tests/e2e/visual-polish.spec.ts --output="$env:TEMP/m3e42-fix"
npx playwright test tests/e2e/visual-polish.spec.ts tests/e2e/passkey-portability.spec.ts --grep="manager sections remain readable|mobile manager actions|GitHub-shaped|Passkey verification|early page" --output="$env:TEMP/m3e42-verify"
npx playwright test tests/e2e/localization.spec.ts --output="$env:TEMP/m3e42-locales"
```

## 构建、资源与设计稿

- `npx vitest run src/commercial-acceptance.test.ts src/i18n/runtime.test.ts`：34 项通过。
- `npm run build`：TypeScript、225 个图标覆盖与字体哈希、三个扩展页面及本地资源检查通过。构建仍有既有的大 chunk 提示。
- 移除 Doto、Space Grotesk、Space Mono 的字体文件和不再使用的许可文件。系统字体不需要远程请求；Material Symbols 字体为 23,948 字节，保留填充轴。
- 新增两条菜单文案已补齐英文和六份独立语言目录。
- Canvas 项目为六页、62 个组件组，默认 teal；已在上游在线编辑器实际导入和渲染，无脚本异常。`splitButton` 的原型动作限制在设计说明中列出。
- 生产构建的浅色、深色、Nothing 配色、详情、编辑、拆分菜单、外观设置、Popup 和窄屏 API 编辑器已用合成数据截图检查。
- `node scripts/security-audit.mjs`：通过，产物没有测试密钥或 source map。
- `npm run verify:supply-chain`：通过，包括固定 Node/npm、245 个锁定包、五份工作流及 MDBX2 Host 来源检查。
- `npm run audit:production`：0 个已报告漏洞。
- `git -c core.safecrlf=false diff --check`：通过。

与本轮开始的源码备份逐文件比较，变化集中在 UI、主题、创建类型目录和界面测试。没有修改序列化、加密、Android 类型映射、同步提供方或 Passkey 协议实现。Passkey 验证页只改了 CSS；没有注册或替换本机 Windows Hello Host。本轮未重跑全部 Rust、互操作或硬件测试，原有深度验证见 [0.1.40 记录](VALIDATION-0.1.40.md)。

## 本地安装包

```powershell
node scripts/package-release.mjs --allow-dirty
node scripts/verify-release.mjs --allow-dirty
```

- 文件：`release/monica-extension-0.1.42.zip`。
- 大小：1,943,140 字节，比 0.1.41 减少 98,728 字节，约 4.8%。
- SHA-256：`b8f88b897a6fc3e5557aa03c2a5af3909816e39ca5400c1fb45997bfe62c2965`。
- 包内 50 个文件，仅含程序资源、许可与构建清单；不含用户数据、浏览器配置、测试工件、截图或 Canvas 工程。
- 白名单、资产清单、全部哈希及两个独立打包产物的字节一致性检查通过。
- `release/monica-extension-unpacked` 已更新至 0.1.42，原有 ZIP 保留。
- 保留工作区已有未提交修改，构建证据如实记录 `trackedWorktreeClean: false`。本轮没有提交或上传 GitHub。
