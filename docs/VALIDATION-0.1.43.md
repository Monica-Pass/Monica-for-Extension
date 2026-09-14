# 0.1.43 M3E 组件迁移验证

> 本地开发阶段记录：文中的版本号未作为 GitHub Release 发布，相关改动已汇总到[正式版 0.1.37](RELEASE-0.1.37.md)。

验证日期：2026-09-15。环境为 Windows、Node.js 22.14.0、npm 10.9.2 和 Playwright Chromium。`package.json`、锁文件、构建产物及扩展清单均为 0.1.43，`@m3e/web` 固定为 2.6.1。

这是本地开发包，尚未提交或上传 GitHub。工作区中此前的修改完整保留；发布证据如实记录 `trackedWorktreeClean: false`。

## 实现范围

使用 M3E 项目的真实 Web Components，包括 filled 表单、选择器、复选框、单选项、开关、滑块、列表操作、展开区域、菜单和主要编辑弹窗。`@m3e/web` 并非 Google 官方 Material Web；原生 `input` / `textarea` 是该库文档规定的表单内容，由 `m3e-form-field` 负责标签和状态呈现。

相对本轮保存的 0.1.42 源码快照，40 个变化的 `src` 文件均属于 Vue 界面、样式、界面入口、翻译或组件适配。加密、密码库序列化、同步提供方和 Passkey 协议源码没有在本轮迁移中改动。

## 浏览器回归

按功能分组运行，修复后重跑受影响场景。保存的 JSON 报告按测试文件和场景名去重后，共 **73 项，最新结果全部通过**；这不是一次完整的 `release:check`。

| 范围 | 数量 | 验证内容 |
| --- | ---: | --- |
| M3E 交互 | 10 | 拆分按钮跟随页面、跨类型创建、菜单键盘操作、无 Popover 回退、选择器 Escape、减少动态效果、滑块和单选持久化、设置失败重试、外观焦点循环、折叠后保留草稿 |
| 响应布局 | 16 | 320～2560px 页面、200% 文字、抽屉焦点、短窗口编辑器及 Popup；字段滚动时保存按钮仍可达 |
| 视觉与尺寸 | 15 | 图标、密码源入口、长文字、紧凑登录行、主要对话框、MDBX2 冲突/快照管理、横向溢出与滚动 |
| 编辑与来源流程 | 31 | API 密钥、钱包、Wi-Fi/SSH/条码、详情、TOTP/HOTP、Android 旧绑定、自动填充排除项、附件、KeePass 分组、MDBX2 文件夹/恢复/清理、手动 WebDAV 冲突/取消/脱敏诊断 |
| 大列表 | 1 | 123 条合成登录项的分页、搜索、删除后页码收敛、8 种语言下分页布局、Popup 匹配与填写、锁定后清空界面 |

本轮此前还通过多语言完整流程（7 项）、本地化（3 项）、无障碍（4 项）、Bitwarden 通知与重连、WebDAV 自动更新、Bitwarden 文件夹/组织/安全发送及 KeePass 历史回归。自动同步使用模拟远端变更验证列表、详情与 Popup 更新；没有连接用户真实服务器。

所有浏览器测试使用合成记录和独立的临时 Chromium 配置。手动 WebDAV 冲突测试关闭自动调度，避免另一次同步替换其待确认冲突；自动同步由独立场景验证。过期冲突确认的拒绝机制保留。

关键修复包括：

- 下拉选择器的 Escape 只关闭下拉；语言切换同时更新当前标签和展开菜单。
- 弹窗仅处理自身的关闭事件，子展开区域关闭不会误取消编辑；取消验证器绑定后仍可继续填写内嵌密钥。
- 外观单选项、设置开关、生成器滑块和 KeePass 父分组选择适应大字号；紧凑登录摘要省略显示，完整内容可通过详情或标题提示查看，项目名称保留在可访问标签中。
- 分页选项按组件契约使用字符串值，保持管理页与 Popup 的页码选择一致。

## 构建与检查

- `npm run build` 通过：TypeScript、225 个本地图标、3 个扩展页面及资源引用检查通过。
- `commercial-acceptance.test.ts`、`generator-preferences.test.ts`、`i18n/runtime.test.ts` 共 **43 项单元测试通过**。
- `npm run verify:supply-chain` 通过，锁文件注册表来源、工具链、工作流与 Host 来源检查通过。
- `npm run audit:production`：0 个已知漏洞。
- `node scripts/security-audit.mjs` 通过，产物没有测试秘密或 source map。
- `git -c core.safecrlf=false diff --check` 通过。

构建仍会提示部分 JavaScript 分块大于 500 kB。大列表回归验证功能与分页边界，本轮没有重新进行 CPU、内存或帧率基准；不能据此承诺所有设备性能相同。

本轮没有重跑完整 Rust/Android 互操作测试，也没有执行真实 Windows Hello、硬件密钥或真实网站 Passkey 验收。相关底层源码未在本次 UI 迁移中改动。

## 本地安装包

文件：`release/monica-extension-0.1.43.zip`

- 版本：0.1.43
- ZIP 大小：1,992,907 字节（约 1.90 MiB）
- 解压大小：6,801,171 字节
- 文件数量：50
- SHA-256：`b93af540c42fc5cb7debb485e69236b975a6594e27efe2ff7a63dd038527d7f6`
- 解压加载目录：`release/monica-extension-unpacked`，已更新为同一版本。

执行 `node scripts/package-release.mjs --allow-dirty` 和 `node scripts/verify-release.mjs --allow-dirty` 均通过。清单、逐文件大小及 SHA-256、页面资源引用、许可证和依赖证据一致；两次独立重新打包与交付 ZIP 字节完全一致。

额外按路径白名单核验 50 个文件，仅包含扩展页面、JavaScript/CSS、官方应用图标、本地图标字体、翻译、许可证和构建证据。包内没有密码库、KDBX/MDBX 数据、浏览器配置、测试数据或截图。

本地验证报告和合成截图保留在忽略目录 `.artifacts/m3e-43/`，没有放入安装包。
