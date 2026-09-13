# 0.1.36 官方图标统一与发布准备

保存密码的旧发布截图仍显示早期文字图标，Passkey 确认框也仍使用通用钥匙。现已统一网页提示的品牌图片来源，并重新生成全部发布截图。

## 调整范围

- 保存密码、新建 Passkey、使用 Passkey 和表单旁自动填充共享 `src/content/brand-logo.ts`，只加载原有 `public/icons/logo-256.png`。
- 保存与 Passkey 提示以 44px 等比显示图片；表单旁菜单使用 24px。保持图片原色和透明背景，不裁切、不添加滤镜。
- 创建／解锁、加载状态、管理页和 Popup 继续使用相同官方图片。Popup 作为独立标签页打开时也使用官方 favicon。
- 工具栏和扩展管理页沿用原有 16／32／48／128px 图标，未修改 PNG 内容。
- 更新五张旧发布截图，新增表单菜单、创建 Passkey 与 Passkey 登录截图。全部由临时浏览器配置和虚构数据生成。
- 补充本地凭据、密码数据库、备份和浏览器存储目录的 Git 忽略规则，并移除文档中的本机绝对路径。

## 已完成验证

- 网页提示相关单元测试：8 个文件、70 项通过。
- TypeScript、223 个字体图标、生产构建及扩展页面本地资源引用检查通过。
- `node scripts/capture-store-assets.mjs` 从实际扩展生成八张截图，检查 12 种品牌图片显示状态，包括 320px 浅／深色的保存和 Passkey 提示。
- 逐项检查图片加载完成、256px 原图、渲染尺寸、等比显示、无滤镜和无圆形裁切；已人工查看截图。
- 同一隔离浏览器中完成实际 Passkey 创建和签名登录，网页提示的操作仍正常。
- 当前代码中未发现其他使用文字标记或通用钥匙作为 Monica 应用标识的入口。项目类型、账号首字母与操作按钮仍表达各自的功能。

完整发布流程见 [发布说明](RELEASE.md)。正式 Release 的校验值由随附 `.zip.sha256` 提供，源提交记录在安装包内的 `SECURITY-EVIDENCE.json` 中。

## 更新后的截图

- [概览](../store-assets/01-vault-overview.png)
- [登录项](../store-assets/02-login-items.png)
- [密码源](../store-assets/03-password-sources.png)
- [工具栏](../store-assets/04-explicit-autofill-popup.png)
- [保存密码](../store-assets/05-save-password-prompt.png)
- [表单旁自动填充](../store-assets/06-form-autofill.png)
- [创建 Passkey](../store-assets/07-passkey-create.png)
- [Passkey 登录](../store-assets/08-passkey-sign-in.png)

此次图标修正未改变密码库模型、同步协议或浏览器权限。之前的自动填充验证见 [0.1.35 记录](VALIDATION-0.1.35.md)，Android 数据互通范围见 [0.1.33 记录](VALIDATION-0.1.33.md)。
