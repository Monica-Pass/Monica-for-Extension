# Monica Extension 开发记录 / Development changelog

> 1.0.105 开发期间的改动记录 / Changes recorded during 1.0.105 development

## 中文

- 减少大库同步时的重复复制和比较。Bitwarden 增量同步只复制合并所需的本地数据。KeePass 按需建立字段引用索引，内容指纹完全一致时跳过重复解析指纹。原有 Bitwarden 账号和 KDBX 文件可继续使用。

- Bitwarden 无变化检查通过会话、来源及本地状态核验后避免复制全库；自动同步调度只读取账号与队列路由。批次内复用不可导出的加密密钥，保留 MAC 校验与原加密/KDF；支持的浏览器使用原生 Base64，旧浏览器保留兼容路径。同步入库失败会撤销远端缓存，避免重试误报无变化。扩展本地库升级后按记录加密，单条修改和同步回执在同一事务提交；迁移先读回核对，原主密码与旧加密备份继续可用。

- 本地加载 `dist` 时，标准构建先在临时目录编译和验证，成功后逐文件更新并最后替换清单；构建失败保留旧包，替换失败尝试回滚，避免构建先清空已加载目录的风险。尚未证明这能覆盖浏览器移除扩展注册的所有原因。

- 设置页版本号旁显示内部代号“Sengoku Nadeko”（千石抚子），检查更新入口和版本详情保持一致。

- 将首次使用的“创建密码库 / 打开已有的密码库 / 恢复插件备份”移至独立入口页，选择后才显示对应表单；日常解锁不显示这些入口。返回会清空已输入的密码，创建、导入或恢复期间暂时禁用返回。

- 弹窗全部登录项改为后台分页搜索，每次只传递20条摘要；支持跨标题、账号、网站和公开凭据标签的多词查找及重音归一化，快速改词和锁定后丢弃旧结果。归档/删除、密码组序号、网站排除和最终填写授权规则保留。通用条目编辑器、MDBX源管理、附件管理及KeePass历史按需加载，减少管理页初次加载资源。

- 优化大库操作：Bitwarden 普通同步诊断与同步结果在同一加密事务保存，避免额外重写整库；入库失败或入库前取消不记录成功，原有写入恢复回执和冲突保护保留。弹窗优先显示当前网站登录项，随后补齐其他结果，锁定或切换后拒绝迟到结果；复制密码只读取所选条目，空卡包查询不复制全库。超过 20 页时采用数字页码跳转，避免创建大量页码组件，保留任意页跳转、键盘和大字号操作。

- 兼容 Android 增强 V2 加密 ZIP（PBKDF2-HMAC-SHA256 600,000 次）：导入自动识别 V1/V2，导出可选 V2 并要求文件密码，默认继续使用 V1。WebDAV 读取 V2 后，记录、附件和历史修改生成的新快照保持 V2；未知版本、异常参数、错误密码与文件篡改拒绝处理。补齐八种界面语言的格式选项和提示。
- WebDAV 附件按会话缓存分块读取，避免每个分块都重复下载解密；锁定、取消、移除密码源或到期后拒绝迟到结果并清零缓存。单附件缓存上限 64 MiB、总上限 128 MiB，连续 5 分钟未读取主动清除。
- 补齐界面翻译：密码内容块与完整副本、Passkey 绑定元数据、GPG 字段、卡面选项、附件预览与上传、新建菜单说明等此前在所有语言下都显示中文；日语、韩语、德语、西班牙语、俄语和越南语中原先仍为英文的 284 条文案也已翻译。
- 修正文案拼接：英文“Master password (optional)”和列表中的“Login · Favorite”恢复正确空格；内置本地库在列表和详情中按界面语言显示名称；只读详情的网站分组不再标注“可选”。
- 内置浏览器 MDBX 引擎改用 zip 9.0.5，消除 GitHub 对 zip 2.4.2 报告的严重、高危和中危告警；完整备份 ZIP 格式不变，已与 zip 2.4.2 互相读取验证。可选 Windows 本机助手仍使用 zip 2.4.2，因为其 Rust 1.86.0 工具链需与已审查的核心版本一致。
- API 密钥新增自定义字段时，如已有 64 位字符串字段标识，不再生成无效标识导致无法保存。
- 开发与发布检查：`npm run check` 改用 vue-tsc，单文件组件的脚本与模板纳入类型检查；修复每次运行都失败的 MonicaDocs 通知工作流和每周全历史密钥扫描（逐条复核的误报按精确路径排除，并由 `verify:workflows` 限制排除范围）；开发依赖 minimatch 覆盖为 11.0.4，`npm audit` 不再报告 ESLint 工具链的 moderate 告警。
- 减少无变化时的重复写盘：解锁时若锁定自动填充缓存的内容与密码库摘要都未变，跳过重写；缓存损坏或内容变化仍自动重建，摘要绑定与最小化字段投影不变。自动同步重复失败不再改写密码源记录、不追加完全相同的诊断；队列中有待写修改时的重试计数、恢复回执与成功诊断同事务提交的语义保持不变。重新加载扩展并解锁后，无改动的本地库不再产生额外写入，重复同步失败不再刷穿诊断环形缓冲。

## English

- Reduced copying and comparisons during large-vault syncs. Bitwarden incremental sync copies only the local data needed for merging. KeePass builds its field reference index on demand and skips re-parsing matching entry fingerprints. Existing Bitwarden accounts and KDBX files continue to work.

- Clean Bitwarden revision checks avoid full-vault copies after validating the session, source and local state; automatic scheduling reads only account configuration and queue routing. Operation keys reuse non-exportable WebCrypto imports with MAC checks and the existing encryption/KDF. Supported browsers use native Base64 with a legacy fallback. Failed sync adoption invalidates the remote baseline so retries cannot report an uncommitted revision as unchanged. Authenticated migration moves the local IndexedDB vault to encrypted records. Changed rows and sync receipts commit atomically, with the same unlock credentials and portable backup format.

- Standard local builds now compile and validate in staging before replacing files in `dist`, publishing the manifest last. Failed compilation preserves the previous build and replacement failures attempt rollback, avoiding the empty-directory window. This does not establish the cause of every browser installation disappearing.

- Settings now show the internal codename “Sengoku Nadeko” beside the version, consistently in the update entry and version details.

- Moved first-run Create vault, Open existing vault and Restore plugin backup choices to a separate entry page. Each choice opens its own form, while daily unlock omits these entries. Going back clears entered passwords and is unavailable while creating, importing or restoring a vault.

- Popup all-login search now filters and pages in the background, returning only 20 summaries per request. Search supports multiple terms across titles, usernames, websites and public credential labels, including accent normalization; superseded and locked responses are discarded. Archived/deleted exclusions, credential numbering, site policies and final fill authorization remain intact. The general item editor, MDBX source manager, attachment manager and KeePass history load on demand to reduce initial manager resources.

- Improved large-vault operations: ordinary Bitwarden sync diagnostics share the encrypted sync-result transaction instead of rewriting the vault again. Failed or cancelled adoption cannot record success; durable mutation receipts and conflict checks remain intact. The popup shows current-site logins before loading supplementary results, rejecting late responses after locking or changing context. Password copying reads only the selected item, and empty wallet queries avoid a full-vault copy. Lists with more than 20 pages use numeric page jumps to bound pagination components while preserving arbitrary page access, keyboard input and large text.

- Added Android enhanced V2 encrypted ZIP compatibility (PBKDF2-HMAC-SHA256, 600,000 iterations). Imports detect V1/V2 automatically; exports offer password-required V2 and keep V1 as the default. WebDAV preserves V2 when publishing record, attachment and history changes from a V2 snapshot. Unknown versions, unsupported parameters, incorrect passwords and tampered files are rejected. Format options and messages cover all eight interface languages.
- WebDAV attachment reads cache bytes per session instead of downloading and decrypting the entire file for each chunk. Locking, cancellation, provider removal and expiry invalidate late results and zero cached bytes. Caching is limited to 64 MiB per attachment and 128 MiB in total, with automatic clearing after five idle minutes.
- Completed interface translations. Password content blocks and complete copies, Passkey binding metadata, GPG fields, card face options, attachment preview and upload, and create-menu descriptions previously showed Chinese in every language. 284 messages that Japanese, Korean, German, Spanish, Russian and Vietnamese still showed in English are now translated.
- Fixed text concatenation: "Master password (optional)" and "Login · Favorite" have their spaces back, the built-in local vault name follows the interface language in lists and details, and the read-only website section is no longer labeled optional.
- The bundled browser MDBX engine now uses zip 9.0.5, which resolves the critical, high and medium GitHub advisories reported for zip 2.4.2. The complete-backup ZIP format is unchanged and was cross-read with zip 2.4.2. The optional Windows helper keeps zip 2.4.2 because its Rust 1.86.0 toolchain must match the reviewed core release.
- Adding a custom field to an API key that already has 64-bit string field IDs no longer creates an invalid ID that blocks saving.
- Development and release checks: `npm run check` now uses vue-tsc, so single-file component scripts and templates are type-checked. Fixed the MonicaDocs notification workflow, which failed on every run, and the weekly full-history secret scan; reviewed false positives are excluded by exact path and `verify:workflows` keeps the exclusions narrow. The development dependency minimatch is overridden to 11.0.4, so `npm audit` no longer reports the moderate ESLint toolchain advisory.
- Fewer redundant writes when nothing changed. Unlocking skips rewriting the locked-autofill cache when its content and the vault envelope digest are both unchanged; damaged or changed caches are rebuilt as before, preserving the digest binding and the minimized field projection. Repeated automatic-sync failures no longer rewrite the provider record or append identical diagnostics, while retry counters for queued mutations, recovery receipts, and the shared transaction for successful sync diagnostics keep their semantics. Reloading the extension and unlocking an unchanged vault no longer produces extra writes, and repeated failures no longer flood the diagnostic ring buffer.
