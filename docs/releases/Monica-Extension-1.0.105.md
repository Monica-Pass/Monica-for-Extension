# Monica for Extension 1.0.105 · Sengoku Nadeko

标签 / Tag `v1.0.105` · 相较版本 / Changes since [1.0.104](Monica-Extension-1.0.104.md)

## 中文

- **本地密码库**改为逐条加密存储。以后编辑一条登录记录，通常只需写入变动部分。
- **Bitwarden** 检查到远端没有变化时，可跳过整库复制。只有一条记录更新时，扩展也减少了合并和保存所需的工作。如果写入本地失败，下次同步会重新读取远端变更。
- **KeePass** 同步已打开的 KDBX 时会复用未变条目的比较结果，遇到字段引用才建立索引。在 Monica 中收藏或归档条目，也不会再因此改写 KDBX 原生条目。编辑后保存远端 KDBX 仍需写入整个文件。
- **弹窗与搜索**先显示当前网站的账号。搜索全部登录项时，每页返回 20 条摘要，可组合输入标题、用户名、网站或凭据标签中的关键词，也能忽略重音差异。编辑器、附件管理和 KeePass 历史在打开时加载，大列表支持输入页码直接跳转。
- **Android 备份与 WebDAV** 支持 Android 增强 V2 加密 ZIP。导入会自动识别 V1/V2，导出默认 V1，也可设置文件密码选择 V2。通过 WebDAV 修改 V2 备份时会沿用 V2。分块读取附件可复用已下载的数据，大文件传输也有更充足的时间完成。
- **首次使用与设置**将「创建密码库」「打开已有的密码库」「恢复插件备份」集中在首次使用页，已有库直接进入解锁页。设置页版本号旁新增内部代号 **Sengoku Nadeko（千石抚子）**。密码内容块、通行密钥绑定、GPG 字段及附件提示等文案也补齐了翻译。
- **备份与传输修复。** WebDAV 批量备份时会为同批条目分配不同的 Android 数字 ID，避免同路径记录互相覆盖。内置 MDBX 引擎升级了 ZIP 组件，仍能与旧版互读完整备份。同步或导出前同步失败时，管理页会显示原因。
- **Steam** 市场出售自动确认改用交易类型判断。导入加密 maFile 时，密码输入框会遮挡输入内容。
- **从源码构建**时，`npm run build` 会先在临时目录完成编译和校验，再更新浏览器已加载的 `dist` 目录。编译失败时仍保留上一份可用构建。

**大库实测。** 在本机 Edge 的合成库中，两轮测试里，编辑 5,000 条登录中的一条，交给本地数据库写入的数据量均从约 5.4 MB 降到 8.2 KB。另一次对照中，5,000 条 Bitwarden 登录里同步一条变更的中位耗时从 196 ms 降至 145 ms，2,000 条已打开的 KeePass 记录在无待写修改时同步从 198 ms 降至 168 ms。这些数字比较开发期间的实现，Bitwarden 使用模拟服务器响应，计时不含首次迁移或冷解锁。[测试条件与结果](../verification/record-vault-20261118.md)

## English

- **Local vault.** The extension now encrypts and stores records individually. Editing one login usually writes only the changed data.
- **Bitwarden.** When the server reports no changes, the extension can skip copying the vault. Syncing one changed login also takes less work to merge and save. If a local write fails, the next sync fetches the remote changes again.
- **KeePass.** Syncing an open KDBX reuses comparisons for unchanged entries and builds an index only when a field reference needs it. Marking an entry as a favorite or archiving it in Monica no longer rewrites the native entry. Saving edits to a remote KDBX still writes the complete file.
- **Popup and search.** Accounts for the current site appear first. All-login search returns 20 summaries per page and matches words across titles, usernames, websites and credential labels, including matches without accents. Editors, attachment management and KeePass history load when opened. Long lists let you jump directly to a page number.
- **Android backups and WebDAV.** Import detects both V1 and Android’s enhanced V2 encrypted ZIP format. Export defaults to V1 and offers V2 with a file password. WebDAV preserves V2 when saving changes, reuses downloaded data across attachment chunks and allows more time for large transfers.
- **First run and settings.** A new start page groups Create vault, Open existing vault and Restore extension backup. Returning users go straight to unlock. Settings show the internal codename **Sengoku Nadeko** beside the version. More interface text is translated, including password content blocks, passkey bindings, GPG fields and attachment prompts.
- **Backup and transfer fixes.** WebDAV assigns distinct Android numeric IDs within each backup batch to prevent collisions from overwriting entries. The built-in MDBX engine uses an updated ZIP library and can exchange full backups with earlier versions. The manager shows errors when sync or pre-export sync fails.
- **Steam.** Market sale auto-confirmation now checks the transaction type. The password field masks input when importing an encrypted maFile.
- **Building from source.** The standard `npm run build` command compiles and verifies the extension in a temporary folder before updating the `dist` folder loaded by the browser. A compilation failure leaves the previous build in place.

**Large-vault measurements.** In two local Edge runs with 5,000 synthetic logins, editing one login reduced the data submitted to the database from about 5.4 MB to 8.2 KB. In a separate comparison, median sync time fell from 196 ms to 145 ms for one changed Bitwarden login among 5,000, and from 198 ms to 168 ms for an open KeePass vault of 2,000 entries with no pending edits. These comparisons cover development builds with simulated Bitwarden responses and exclude first migration and cold unlock. [Test conditions and results](../verification/record-vault-20261118.md)
