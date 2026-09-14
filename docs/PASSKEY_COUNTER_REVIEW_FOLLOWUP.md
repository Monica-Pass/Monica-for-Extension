# Passkey 计数独立审查后的修补

2026-09-14。修补对象是插件源码与本地 `dist`；没有修改 Android 生产代码、读取真实密码库或上传 GitHub。此前的 0.1.39 ZIP 和 `release/monica-extension-unpacked` 尚未重新打包，不能用旧产物验证本页修补。

独立审查的关键结论成立：正常 Monica 自建凭据从注册起一直使用 0，应保持现有行为；历史正计数不能因同步、使用或冲突处理被当成原生零计数。Bitwarden 的同步接口也不是全局唯一计数分配器。

## 已修补的路径

- 在加密本地库保留 `signCountHighWaterMark`，记录已观察到的最高计数；自己的待提交递增与已确认历史分开保存。
- 下载到较低计数时保留历史并记录冲突，阻止受影响 Cipher 的待写入修改，也保留父登录、其他 Passkey 和未处理队列。
- 冲突、延迟处理的本地修改也要记住本轮观察到的更大计数；之后选择“保留本地”不能把旧计数写回远端。
- 选择“采用远端”可以采用内容，但不能擦掉历史。编辑、同 ID 导入、仅更新历史的合并和重新解锁均保留历史。同一项目换成另一条凭据时不混用历史。
- 后台的零计数快捷入口、Bitwarden 认证准备和最终提交给网页之前都检查回退。不能仅靠 `signCount === 0` 绕过保护。
- 正常零计数凭据继续离线可用，不因登录上传 Cipher。使用次数和时间仍只作为本机统计。
- 历史标记不进入 Bitwarden Cipher，不参与 MDBX2/KDBX 内容指纹，不因更新标记创建文件历史或数据库提交。
- 旧凭据仍可显式删除；计数保护不会要求保留一个已决定删除的凭据。

## 验证

最终相关单元回归：**54 个文件、683 项通过**。

```powershell
npm.cmd test -- src/passkey src/security src/providers/bitwarden src/providers/keepass src/providers/mdbx2/mdbx2-provider.test.ts src/providers/mdbx2/mdbx2-item-codec.test.ts
npm.cmd run build
node scripts/security-audit.mjs
```

类型检查、生产构建、扩展页面资源检查和安全审计通过。审计确认构建没有夹带合成夹具秘密或 source map。代码差异检查通过。

浏览器共 **22 个场景验证完成**。最终整组运行 21 项通过；新增“采用远端零值后离线重试”因测试误读管理页已脱敏的冲突摘要而失败。按 `ProviderConflictSummary` 的真实结构修正测试后，该项独立重跑通过，生产代码没有因此改变。整组命令与定向重跑命令如下：

```powershell
node node_modules/@playwright/test/cli.js test tests/e2e/passkey-bitwarden-counter.spec.ts tests/e2e/passkey-portability.spec.ts tests/e2e/passkey.spec.ts --output="$env:TEMP/monica-counter-review-final" --max-failures=3
node node_modules/@playwright/test/cli.js test tests/e2e/passkey-bitwarden-counter.spec.ts --grep regression-resolved --output="$env:TEMP/monica-counter-resolved" --max-failures=1
```

覆盖零计数离线、正计数先提交后签名、远端归零/下降、采用远端零值后离线重试、失败/取消、UV、锁定/导航撤销、本地创建与使用、KDBX 离线副本和单凭据删除。失败场景通过 CDP 检查关闭的 Shadow DOM 中实际出现错误，避免测试在认证结果出来之前就取消而误报通过。

最初使用较长的工作区测试目录时，3 项在初始化 IndexedDB 阶段失败，未进入 Passkey 流程；改为较短的临时目录后，零计数探针和当时的 21 项浏览器场景通过。最终又加入了采用远端零值后的快捷入口回归。

## 仍然存在的边界

已从公开源重新核对官方 server 固定提交 `6ba6612fbd83a9bb1004a830062501346af2a57d` 的 `ValidateCipherLastKnownRevisionDate`：只在时间差大于 1 秒时拒绝，不是严格旧版本等值比较。

两个隔离客户端同持 5，同时提交时：严格原子等值比较的对照模型允许一个 6、拒绝另一个；模拟官方 1 秒容差的模型允许两个 6。测试保留这个反例，不把它写成“并发问题已解决”。这不是实际 Bitwarden/Vaultwarden 部署的并发验收。即使服务器严格分配计数，也无法控制两个 assertion 到达网站的先后顺序。

本地、独立全量快照和文件库对历史正计数当前仍采用签名 0；保留历史并不能重置网站记录，也不保证旧凭据可用。Android 的协议 BE/BS 元数据往返仍需专项验证。本轮保持正常 Monica 凭据既有的零计数、离线和备份标志行为。

本轮没有 Android 真机 Credential Manager、真实网站账号、真实服务、Windows Hello 硬件或 BE=false 经 Android 往返验收。签名独立验过与合成浏览器流程通过，不等于真实站点一定接受。详情见 [跨客户端策略](PASSKEY_COMPATIBILITY.md)。
