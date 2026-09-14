# 0.1.40 自动同步验证

> 本地开发阶段记录：文中的版本号未作为 GitHub Release 发布，相关改动已汇总到[正式版 0.1.37](RELEASE-0.1.37.md)。

日期：2026-09-14。所有账户、密码、令牌、数据库、HTTP / WebSocket 服务和浏览器配置均为本轮创建的合成夹具。没有读取用户真实密码库，也没有使用真实 Bitwarden 云账户。

## 单元与协议回归

最终 `npm test`：**134 个文件、1,268 项全部通过**。

- 20 条 Bitwarden 合成记录中只修改 1 条时，仅 1 次单 Cipher GET、1 次 Cipher 解密、1 次来源指纹计算，其余 19 条保留。
- 无变化 revision 不下载全库；下载期间新发生的修改留给下一次校对；新文件夹、源身份变化、worker 重启或锁定后重新获取完整上下文。
- 经过认证 API 确认的删除才自动应用；乱序删除、异常空库、同步期间编辑、回执恢复及历史 Passkey 高水位继续受保护。
- 调度合并通知并限定并发、分批上传、尊重 Retry-After；重连可绕过普通网络退避，锁定可移除单个源，失败账户不阻塞其他账户。
- KDBX 的 ETag 未变时不下载、不重新投影、不写密码库；变更时读取新文件后投影。Android 备份快照同样避免未变化下载，包括已经同步的回收站条目；待上传删除不会被 ETag 快路跳过。
- 自动读写和使用统计不延长自动锁定时间；原子编辑基线校验保留草稿；后台响应不能写回已替换的服务器配置。

## Chromium MV3

最终 0.1.40 构建覆盖以下 **23 个场景**：

```powershell
npx playwright test tests/e2e/automatic-sync.spec.ts tests/e2e/automatic-webdav-sync.spec.ts tests/e2e/passkey-bitwarden-counter.spec.ts tests/e2e/keepass-webdav.spec.ts tests/e2e/locked-autofill.spec.ts tests/e2e/runtime-upgrade.spec.ts --output="$env:TEMP/monica-sync-40"
```

集合中 22 项通过。Popup 同步本身已通过，但测试把 Popup 打开为普通标签页，点击填写前需要恢复网站为活动标签，以符合现有填写授权。修正这一测试设置后单独复跑通过，生产程序未因此更改：

```powershell
npx playwright test tests/e2e/automatic-sync.spec.ts --grep="open popup" --output="$env:TEMP/monica-sync-40-popup"
```

覆盖内容：

- 本机 HTTP + 真实 SignalR WebSocket / MessagePack 模拟手机修改，列表和打开的详情自动更新，只请求发生变化的 Cipher，其他记录不丢失。
- Popup 在打开时接收新标题、用户名和密码；实际网页填写使用新值，返回管理页后自动补刷隐藏期间的变化。
- 编辑草稿遇到手机修改时保留并阻止过时保存；正常保存自动上传，无需点击同步。
- 401 刷新 token、通知断线、漏通知、worker 停止重启、关闭开关、锁库、重新解锁及旧版后台升级恢复。
- 真实本机 WebDAV 服务上的 KDBX：定时 ETag 检查、手机文件更新自动下载、浏览器编辑自动条件上传、单库锁定及恢复，其他条目保留。
- 关闭自动同步后的 KeePass 显式恢复与持久待处理状态、远端结构冲突不覆盖、KDBX Passkey 保存和使用。
- Bitwarden 零计数离线使用、历史正计数服务器确认、同步占用期间等待、取消、失败、缺失凭据刷新及历史计数回退拦截。
- 免解锁填写授权、锁定后的敏感数据边界和旧后台版本恢复，不因自动刷新绕过现有保护。

本轮较早的 Passkey 双离线客户端 / UV 场景另外 7 项通过；上面的 23 项仅统计最终 0.1.40 产品构建验证集合，不将较早构建混算进去。

## 构建与安全

- `npm run build`：TypeScript、图标字体、离线资源与扩展页面验证通过。
- `npm run verify:supply-chain`：Node/npm 版本、245 个锁定 npm 包的来源和完整性、5 份工作流及原有 MDBX2 Host 固定版本检查通过。
- `npm run audit:production`：0 个已报告漏洞。
- `node scripts/security-audit.mjs`：通过。SignalR 的 `"importScripts" in self` 是只读平台探测，审计只豁免构建中这一精确表达式，继续禁止调用、属性别名及动态加载代码；没有放宽 CSP 或扩展权限。
- `git diff --check`：通过。

UI 及新增运行时错误文案已补齐全部 7 个非中文离线目录；中文使用原文。设置开关沿用 Nothing 设计与现有减少动态效果设置。构建仍有已有大 chunk 提示；通知处理位于后台，不将通知依赖加入网页内容脚本。

## 本地产品包

以下命令通过内容白名单、文件哈希、资产清单和两次独立打包字节一致校验：

```powershell
node scripts/package-release.mjs --allow-dirty
node scripts/verify-release.mjs --allow-dirty
```

- 安装包：`release/monica-extension-0.1.40.zip`。
- SHA-256：`42fb667f5feda26288ad2751cd032099458adfac7d6787bf5db1795d1ced0030`。
- 54 个程序资源及许可／构建说明文件，不含用户密码库、导出备份、截图、测试浏览器配置或测试服务数据。
- `release/monica-extension-unpacked` 已更新为 0.1.40，旧 ZIP 保留。本机助手仍沿用 0.1.1。
- 这是本地开发构建，继承工作区中尚未提交的既有 UI、API 密钥和 Passkey 改动，构建证据如实标记 `trackedWorktreeClean: false`。本轮未提交或上传 GitHub。

协议与手机上传条件见 [同步兼容说明](SYNC_COMPATIBILITY.md)。本轮未进行真实云账户、Android 真机网络或 Windows Hello 硬件验收，不承诺网络不可达、浏览器关闭或手机尚未上传时仍即时同步。
