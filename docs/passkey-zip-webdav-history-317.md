# 加密 ZIP WebDAV 的 Passkey 历史计数

2026-10-05，本轮修复浏览器插件的旧 Monica Android 加密 ZIP 备份来源。使用真实隔离 Apache、实际 AES-GCM 备份、两个独立插件服务实例和独立验签，不把 KDBX 的结果套用到 ZIP。

## 已复现并修复

1. 上传成功但响应丢失：传输层重复发送同名 `If-None-Match: *` 上传，服务器返回412，实际已成功的同步被报为失败。现在PUT不自动重发；读取同一个文件，只有字节完全一致才确认成功。正常上传也需通过回读；不一致、缺失、取消均不确认。
2. 两客户端同时从41预留42：原来都上传新快照并签出42。现在发布前记录备份列表，发布后检查自己的文件仍为最新且版本一致，并检查其他快照是否新增或改变。竞争时保留双方文件和本地待同步修改，停止签名；重新读取来源后使用新计数。
3. ZIP确认后仍带旧计数上限：实际Edge中已签出42，插件的`signCountHighWaterMark`仍是41。原因是ZIP合并把待上传对象的旧上限直接作为确认结果返回。现在成功读取／确认的投影会记录已确认计数，输入对象保持不变。

文件格式和Passkey私钥载体不变；这些改动不把私钥写入明文备份。新建零计数的同步Passkey仍保持零计数。新增字节回读与发布检查也覆盖同一来源的密码、附件和其他项目写入。

## 验证范围

| 场景 | 实际结果 |
| --- | --- |
| ES256两客户端交替使用 | 42、43、44，远端重新解密为44 |
| RS256两客户端交替使用 | 42、43、44，远端重新解密为44 |
| 成功上传后的响应丢失 | 只发送1次PUT，回读确认后签出42 |
| 两客户端同时发布 | 本次调度两方都拒绝签名，各保留1笔待同步的42；全新来源读取后签出43 |
| 实际Edge两种算法 | 每种41→42，完全关闭浏览器后42→43；4次签名、身份、密钥、备注、UV及BE/BS验证通过 |
| 实际Edge远端回退 | 把远端替换为42的合成旧备份后，提示“计数发生回退”；不返回签名、不补写远端，上限仍为43。取消后由测试恢复已知43文件 |

实际Edge使用154.0.4258.53、隔离浏览器配置、真实网页提示和主密码窗口。回退提示在关闭的Shadow DOM中通过CDP读取，并检查截图。此测试不调用真实网站账号，也不等同于Android系统Credential Manager或真实生物识别验收。

最后的ZIP文件SHA256：`f7e5c4942eb28d0a91e9186cc9b88c8be0d3d9e104f343d816207222937f2688`。Edge证据为 `.tmp/passkey-zip-webdav-history-edge-317-third/`；网络与队列保留证据为 `.tmp/passkey-zip-webdav-counters-317-verified/`。共享的KDBX Edge路径另外重跑，记录在 `.tmp/passkey-zip-change-kdbx-edge-317/`。

最新全量219文件、2237项测试通过；生产构建、两个TS配置、新Edge脚本严格类型检查、安全审计190命令通过。专用10文件184项回归覆盖上传确认、取消、身份不变和计数历史。原有单元夹具从只返回201改成保存上传并支持列表／GET回读，原有数据完整性断言保留。

## 失败与边界

- `.tmp/passkey-zip-webdav-counters-317-first/` 保留重复42与丢失响应412的真实失败；后续目录不覆盖它。
- 第一次ZIP Edge用例揭示真实的上限滞后缺陷，并有先红后绿的单元回归。第二次已完成四次签名，但测试错误地期待网页立即收到拒绝；实际交互保留可重试的错误提示。最后用例检查“回退”提示、无签名，再取消原请求。
- 这套确认依赖服务器返回完整、及时的目录和文件信息；发布前后读取不是分布式锁，不能据此承诺所有WebDAV服务器、缓存、不同时钟和任意跨设备并发调度都能全局唯一分配正计数。KDBX服务器同时接受旧If-Match的问题仍单独保留。
- 本轮没有修改或运行Android应用。已有Android文件互通证据仍按原始源码／APK哈希有效；没有用本轮ZIP测试替代实际Android系统认证验收。真实OneDrive登录和Android端已知缺陷仍需继续处理。

## 复现

需启动既有隔离Apache；合成账号只从忽略目录`.tmp/interop-315-docker/services.json`读取。每次使用新输出目录，测试自动创建唯一远端目录，不覆盖原有备份。

```powershell
$env:MONICA_317_ZIP_WEBDAV_COUNTER_OUTPUT = Join-Path (Get-Location).Path '.tmp/zip-counter-new'
npx vitest run --config vitest.zip-webdav-passkey-counters.config.ts
$env:MONICA_317_WEBDAV_HISTORY_KIND = 'zip'
$env:MONICA_317_WEBDAV_HISTORY_OUTPUT = Join-Path (Get-Location).Path '.tmp/zip-edge-new'
npx playwright test tests/e2e/passkey-webdav-history.spec.ts --output=.tmp/zip-edge-new/results
```

源码、构建及证据哈希索引：`.codex-tasks/android-interop-315/raw/passkey-zip-webdav-manifest.json`。本轮启动的隔离Apache验证后停止，数据卷保留；外部启动的公共API32 AVD未改动。完整互通任务仍在进行。
