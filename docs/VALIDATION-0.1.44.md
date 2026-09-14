# 0.1.44 验证记录

> 本地开发阶段记录：文中的版本号未作为 GitHub Release 发布，相关改动已汇总到[正式版 0.1.37](RELEASE-0.1.37.md)。

日期：2026-09-15。交付为本地开发包，使用 `--allow-dirty` 保留当前工作区已有修改；没有执行 GitHub 上传或 Release 发布。

## 本轮范围

网站图标接入登录列表、全部项目/归档/回收站中的登录项、详情和 Popup。浏览器缓存优先，允许按域名查找缓存；未命中时，仅对默认端口的公开 HTTPS 来源尝试固定 `/favicon.ico`。收藏星标独立显示，特殊登录类型和失败请求保留默认图标。

图标缓存不进入密码库、备份或同步内容。Android 持久化格式、加密算法、WebDAV / Bitwarden 同步流程和 Passkey 策略未因本次功能改动。

## 单元与构建检查

`npx vitest run src/core/website-icon.test.ts src/lib/website-icon-cache.test.ts src/commercial-acceptance.test.ts`：44 项通过。

- 网址归一化、裸域名、国际化域名、多网址、正则规则及特殊类型。
- 去除用户信息、路径、查询和片段；排除非网页协议、IP 直接请求、本地/特殊名称、HTTP 与非默认端口。
- 浏览器缓存命中、默认图标识别、固定网站图标请求、合并并发、取消订阅、超时、负缓存与容量上限。
- 非图片和超长响应拒绝处理，以及新增 `favicon` 权限的清单约束。

`npm run build`、`node scripts/security-audit.mjs`、`npm run verify:supply-chain`、`git -c core.safecrlf=false diff --check` 通过；`npm run audit:production` 报告 0 个已知漏洞。没有新增 npm 依赖。

## 浏览器检查

26 项浏览器用例的最新结果全部通过，使用隔离 Chromium profile 和合成数据：

- `website-icons.spec.ts`：2 项。通过仅绑定本机的 HTTPS 站点实际获取图标，服务端检查请求路径、Cookie 和 Referer；验证相同来源合并、图标解码失败、收藏标识、详情复用、网址编辑更新、Popup 及锁定后的清除。另用本机 HTTP 站点验证真实 Chromium favicon 缓存及当前网站图标。
- `item-detail.spec.ts`、`login.spec.ts`、`locked-autofill.spec.ts`、`responsive-layout.spec.ts`：24 项。覆盖各类型详情、密码/TOTP/自定义字段填充、跨来源嵌入表单、免解锁授权/重启/撤销，以及 320–2560px 窗口与 200% 字体。

首次回归中，免解锁授权用例仍用旧 `.editor-dialog` 定位新 M3E 弹窗。改为既有 `dialogContent` 辅助函数后，该用例单独补跑通过。最新结果按用例合并，不把失败与重跑重复计数。

报告和合成截图：`.artifacts/favicons-44/`；回归工件：`.artifacts/i44/` 与 `.artifacts/ir44/`。HTTPS 证书与密钥是公开的测试夹具，仅在本机测试使用，不进入产品包。

本轮未重跑完整 `release:check`、Rust/Android 互操作测试、真实 Windows Hello 或真实网站 Passkey 验收。大库 CPU、内存和同步吞吐未重新测量。构建仍提示已有 JavaScript 大分块；本轮没有据图标缓存测试推断整体性能提升。

## 本地安装包

- ZIP：`release/monica-extension-0.1.44.zip`
- 解压加载目录：`release/monica-extension-unpacked`，已更新为同一版本。
- 程序文件：50 个。
- ZIP 大小：1,995,968 字节。
- 解压大小：6,808,898 字节。
- SHA-256：`bd4172db9829f0fb7f89153dcbb6b75657a1f9b037cbfcea9f06a70d31a40def`

`node scripts/package-release.mjs --allow-dirty` 和 `node scripts/verify-release.mjs --allow-dirty` 通过；清单、逐文件哈希及两次独立重新打包均一致。额外路径白名单确认只包含页面、脚本、样式、图标、字体、翻译、许可证及构建证据，不含密码库、浏览器配置、测试数据、证书密钥或截图。

安装说明：解压 ZIP 后加载扩展目录；已加载上述固定目录的用户可在扩展管理页直接重新加载，无需移除现有扩展。
