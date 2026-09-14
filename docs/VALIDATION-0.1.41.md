# 0.1.41 UI 验证

> 本地开发阶段记录：文中的版本号未作为 GitHub Release 发布，相关改动已汇总到[正式版 0.1.37](RELEASE-0.1.37.md)。

日期：2026-09-14。本轮在 0.1.40 工作区基础上调整 UI，验证只使用合成账户、项目、同步服务和新建的临时浏览器配置。

## 浏览器操作与布局

本轮覆盖 **49 个不同 Chromium MV3 场景**：

```powershell
npx playwright test tests/e2e/responsive-layout.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/visual-polish.spec.ts tests/e2e/manager.spec.ts tests/e2e/vault-navigation.spec.ts tests/e2e/api-token.spec.ts tests/e2e/automatic-sync.spec.ts --output="$env:TEMP/monica-m3e-e2e"
```

首轮 47 项通过。另两项分别是旧测试要求每个新建选项都采用相同 8px 圆角，以及 375px / 200% 字体下登录行比高度预算多约 2px。前者改为验证全部 11 个类型在宽屏可见，后者减少了行内留白。数据库筛选测试同时改为从新增入口操作，验证它与筛选弹窗的状态双向一致。最终针对这些变化复跑 3 项，全部通过：

```powershell
npx playwright test tests/e2e/visual-polish.spec.ts tests/e2e/vault-navigation.spec.ts --grep="provider page is compact|compact login list actions|vault opens directly" --output="$env:TEMP/monica-m3e-final"
```

覆盖内容：

- 320px–2560px 窗口、短窗口、100% / 200% 字体，详情和编辑器的控件可见、正文滚动与底部操作。
- 键盘焦点进入、Tab 循环、Escape 关闭、焦点返回及进入动画不抢夺正在输入的焦点。
- 明暗主题、减少动态效果、管理页与 Popup 的 axe 严重问题检查。
- 新建、编辑、导入、删除、主密码更换、加密备份恢复与取消。
- API 密钥编辑、敏感字段隐藏及不得作为登录密钥被搜索或填充。
- 切换数据库、收藏和项目类型的组合筛选，清除筛选，普通列表排除归档与回收站。
- 模拟手机通知后列表、打开的详情和 Popup 自动更新；只获取变化 Cipher，保留编辑草稿，阻止过时保存，正常保存自动上传。
- 通知重连、令牌刷新、MV3 worker 重启、关闭自动同步与锁库。

本轮没有重跑整个 Rust / 协议测试集合。同步与 Passkey 的既有深度验证记录保留在 [0.1.40 验证记录](VALIDATION-0.1.40.md)，不将之前的测试结果统计为本轮重新执行。

## Canvas 与生产资源

- `docs/design/monica-vault.m3e.json`：五个页面、48 个组件组，实际在上游 m3e-canvas 网站导入并渲染成功，无页面脚本异常。
- 生产构建的密码库浅色、深色、窄屏，以及详情、新建、编辑页面已使用合成数据截图检查。
- `npm run build`：TypeScript、223 个图标的字体校验、三个扩展页面与本地资源验证通过。没有添加远程字体、React / Next.js 运行时或 Canvas 编辑器。
- `node scripts/security-audit.mjs` 与 `git diff --check` 通过。构建仍报告既有的大 chunk 提示。
- `npm run verify:supply-chain` 通过：固定 Node/npm、245 个锁定包、五份工作流及 MDBX2 Host 来源检查。

本地图片与浏览器测试配置位于被忽略的临时目录，Canvas 工程仅包含虚构示例，不会进入扩展程序包。

## 本地产品包

打包和校验使用现有白名单与构建清单，只收录 `dist` 程序资源及许可、构建证据。工作区原有未提交改动被保留，因此本地构建如实标记 `trackedWorktreeClean: false`。本轮没有提交或上传 GitHub。

```powershell
node scripts/package-release.mjs --allow-dirty
node scripts/verify-release.mjs --allow-dirty
```

- 安装包：`release/monica-extension-0.1.41.zip`。
- 大小：2,041,868 字节，比 0.1.40 的 2,040,381 字节增加 1,487 字节，约 1.5 KB。
- SHA-256：`bcc4b8ca2aa6722173317b0257a8a814acf97c3075e81e6a54c7e9e522756061`。
- 54 个程序资源及许可／构建说明文件；不含用户数据、Canvas 工程、截图或测试配置。
- 校验通过：文件白名单、资产清单、全部哈希、两个独立打包产物字节一致。
- `release/monica-extension-unpacked` 已更新为 0.1.41，旧 ZIP 保留；本机助手继续使用已有版本。
