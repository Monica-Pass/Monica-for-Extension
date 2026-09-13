# 0.1.34 原始品牌图标修正

管理页左上角、创建／解锁页、加载状态和 Popup 统一使用项目原有的彩色锁与钥匙图标 `public/icons/logo-256.png`，替换文字绘制的 `m.`。图标等比显示，不增加圆形裁切、滤镜或阴影；相邻 Monica 字样保留 Nothing 字体。

`scripts/generate-icons.mjs` 改为从原始图标缩放生成四种工具栏尺寸，不再用字体重绘，也不会覆盖 256px 原图。可用 `npm run generate:icons -- --output-dir <目录>` 在独立目录检查输出。本次安装包继续使用原有五份 PNG，均与 0.1.33 中的字节一致。

## 本次验证

- `npm run build`：类型检查、221 个图标字体检查、生产构建及页面资源引用检查通过。
- 原图生成脚本在独立的 `.artifacts/brand-0.1.34/generated` 目录运行成功，人工检查生成结果。
- `node scripts/security-audit.mjs` 通过。
- 从最终解压包启动隔离 Chromium，使用合成密码库检查 25 种显示状态：创建页、两种主题的概览、1440px／320px 解锁页、Popup，以及八种语言的 320×360／200% 字号 Popup。
- 检查图片成功加载、原始文件路径、尺寸、等比缩放、无裁切／滤镜／额外边框、页面无横向溢出，以及 Popup 标题与管理按钮无重叠。未出现页面脚本错误。
- 两项已有浏览器回归通过：窄屏导航关闭／焦点／桌面尺寸切换；短 Popup 中的免解锁填写及解锁表单操作。
- 实际工具栏 Popup 探针通过，包括 200% 字号、离线语言、搜索和复制回退。
- ZIP 文件清单、哈希、解压内容与 `dist` 一致，两次独立打包字节一致。
- 与 0.1.33 对比，manifest 仅版本字段变化。原始 PNG 逐字节相同。

本次没有调整数据库模型、加密或同步逻辑；上一版的 Android 互通及完整功能验证见 [0.1.33 验证记录](VALIDATION-0.1.33.md)。

## 交付

- [0.1.34 ZIP](../release/monica-extension-0.1.34.zip)
- [解压目录](../release/monica-extension-unpacked)
- [浅色概览](../.artifacts/brand-0.1.34/home-light.png) · [深色概览](../.artifacts/brand-0.1.34/home-dark.png)
- [显示检查与原图哈希](../.artifacts/brand-0.1.34/checks.json)
- [预览生成脚本](../.artifacts/brand-0.1.34/capture.mjs)

ZIP SHA-256：`d0403a1263af69212510500d6380e0023956f793bd25d210a7706786a33cd52a`

安装时更新到原先加载的绝对目录，在 Chrome／Edge 扩展管理页重新加载 Monica，再关闭并重新打开旧管理页。
