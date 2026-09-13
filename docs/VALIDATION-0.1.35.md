# 0.1.35 表单旁自动填充

聚焦网页中的账号、当前密码或验证码输入框时，在输入框旁显示当前网站匹配的登录项。菜单跟随滚动和窗口尺寸变化，底部空间不足时向上展开；支持鼠标选择、上下方向键、Enter 填写和 Esc 关闭。输入内容、离开字段、移除表单、切换标签页或锁定密码库后，菜单会关闭。

“设置与备份 → 表单旁自动填充”默认开启。关闭后立即影响已打开的网页，工具栏填写仍可使用。开关可用 Space／Enter 操作，保存期间保留键盘焦点并防止重复提交。

## 行为与数据边界

- 复用现有网站匹配、表单识别、排除规则与填写授权检查，账号选择只填写对应表单。
- 验证码选择仅填写验证码，不覆盖手动输入的账号或密码。
- 密码库锁定时只展示用户明确授权“免解锁填写”的账号；其他登录项通过“解锁 Monica”打开扩展管理页。
- 菜单采用封闭 Shadow DOM，仅显示登录项摘要，不把密码、验证码密钥或验证码放进菜单 DOM。实际填写需要可信用户选择，且重新校验输入框、页面、文档、frame、来源和一次性会话。
- 不显示新密码、只读、隐藏或屏幕外字段的建议；不在不安全的普通 HTTP 页面弹出。
- 每次最多渲染 20 个匹配项，菜单最高 360px；关闭后释放定位观察器。
- 沿用 Nothing 配色与扁平表面，保留 Monica 原有彩色锁与钥匙图标，支持八种语言及浅／深色显示。
- 开关保存在本机 `chrome.storage.local["monica.autofill.inline.enabled"]`，不写入密码库或提供方数据。本版未修改 Android 数据模型、加密格式或同步格式；原有互通验证见 [0.1.33 记录](VALIDATION-0.1.33.md)。

## 验证范围与结果

- 安全、自动填充、内容脚本、运行时与匹配相关单元测试：22 个文件、223 项通过。
- 新增定位和生命周期的针对性测试通过；最终相关单元复测为 4 个文件、41 项通过。各轮有重叠，不合计为独立测试总数。
- `tests/e2e/inline-autofill.spec.ts` 的 10 个新功能场景全部通过，覆盖选择与表单范围、定位与关闭、开关持久化、锁定授权、验证码、排除项、动态 Shadow DOM、跨域 frame、伪造事件、多语言窄屏、大列表及不适用字段。
- 同轮已有回归场景共 15 项通过，涉及动态表单、字段／网站排除规则、免解锁填写与安全边界。最初新菜单向上定位有 2px 偏差，已计入边框高度修正，并通过完整新功能场景复测。
- 最终开关键盘焦点修复后，对设置开关场景追加复测通过，包含连续 Space／Enter 切换、焦点保留、持久化和关闭菜单后的工具栏填写。一次 Chromium 管理页初始导航在测试夹具阶段超时，使用新的短临时目录复测通过；未放宽断言。
- 从最终解压包启动隔离 Chromium，使用合成账号检查 34 种设置布局：两种主题的桌面布局，以及八种语言、两种主题、320px 宽、100%／200% 字号的组合。无横向溢出，开关与文案不重叠，点击目标至少 44px；已检查实际截图。
- 同一最终安装包中验证键盘切换设置和两种主题下的实际表单填写，未出现页面脚本错误。
- 实际工具栏 Popup 探针通过，含 200% 字号、离线语言、搜索和复制回退。
- `npm run build` 通过，包括 TypeScript、223 个图标字体及来源校验、生产构建、扩展页面资源引用检查。Vite 仍报告现有大包体积提示。
- 安全产物审计与锁文件校验通过，未增加安装依赖。
- ZIP 清单、内容、哈希与解压目录一致，两次独立打包字节一致。
- 与 0.1.34 比较，manifest 仅版本字段改变；五份原始 PNG 与旧包、源码、最终 ZIP 和解压目录逐字节相同。

本次执行上述针对性验证，未重跑整个历史测试集或 Android 互通测试。所有浏览器检查均使用隔离配置和虚构数据。

## 复现入口

```powershell
npx vitest run src/security src/autofill src/content src/runtime src/core/matching.test.ts src/core/login-otp.test.ts --maxWorkers=2
npx vitest run src/content/inline-autofill.test.ts src/content/inline-position.test.ts src/autofill/inline-preferences.test.ts src/i18n/runtime.test.ts
npm run build
npx playwright test tests/e2e/inline-autofill.spec.ts --output="$env:TEMP/mi35-inline-final"
node scripts/action-popup-probe.mjs --headless
node scripts/security-audit.mjs
node scripts/verify-lockfile.mjs
node scripts/package-release.mjs --allow-dirty
node scripts/verify-release.mjs --allow-dirty
node .artifacts/inline-autofill-0.1.35/capture.mjs
```

安装包来自当前本地工作区，沿用现有 `--allow-dirty` 开发包流程，未创建提交。

## 交付

- [0.1.35 ZIP](../release/monica-extension-0.1.35.zip)
- [解压目录](../release/monica-extension-unpacked)
- [浅色菜单预览](../.artifacts/inline-autofill-0.1.35/inline-light.png) · [深色菜单预览](../.artifacts/inline-autofill-0.1.35/inline-dark.png)
- [设置开关](../.artifacts/inline-autofill-0.1.35/settings-light.png) · [窄屏／200% 字号](../.artifacts/inline-autofill-0.1.35/settings-dark-zh-CN-320-200.png)
- [最终安装包布局检查与原图哈希](../.artifacts/inline-autofill-0.1.35/checks.json)
- [预览与检查脚本](../.artifacts/inline-autofill-0.1.35/capture.mjs)

ZIP SHA-256：`47451607200a543a8c4d1c843fa941277853740ba4839c62531207a1dc47594c`

更新到原先加载扩展的目录，在 Chrome／Edge 扩展管理页重新加载 Monica，然后重新打开管理页并刷新登录网页，以加载新的内容脚本。
