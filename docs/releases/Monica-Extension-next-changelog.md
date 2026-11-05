# Monica Extension 下一版 / Next release

> 未发布 / Unreleased；版本号待定 / Version pending

## 中文

- 补齐界面翻译：密码内容块与完整副本、Passkey 绑定元数据、GPG 字段、卡面选项、附件预览与上传、新建菜单说明等此前在所有语言下都显示中文；日语、韩语、德语、西班牙语、俄语和越南语中原先仍为英文的 284 条文案也已翻译。
- 修正文案拼接：英文“Master password (optional)”和列表中的“Login · Favorite”恢复正确空格；内置本地库在列表和详情中按界面语言显示名称；只读详情的网站分组不再标注“可选”。
- 内置浏览器 MDBX 引擎改用 zip 9.0.5，消除 GitHub 对 zip 2.4.2 报告的严重、高危和中危告警；完整备份 ZIP 格式不变，已与 zip 2.4.2 互相读取验证。可选 Windows 本机助手仍使用 zip 2.4.2，因为其 Rust 1.86.0 工具链需与已审查的核心版本一致。
- API 密钥新增自定义字段时，如已有 64 位字符串字段标识，不再生成无效标识导致无法保存。
- 开发与发布检查：`npm run check` 改用 vue-tsc，单文件组件的脚本与模板纳入类型检查；修复每次运行都失败的 MonicaDocs 通知工作流和每周全历史密钥扫描（逐条复核的误报按精确路径排除，并由 `verify:workflows` 限制排除范围）；开发依赖 minimatch 覆盖为 11.0.4，`npm audit` 不再报告 ESLint 工具链的 moderate 告警。

## English

- Completed interface translations. Password content blocks and complete copies, Passkey binding metadata, GPG fields, card face options, attachment preview and upload, and create-menu descriptions previously showed Chinese in every language. 284 messages that Japanese, Korean, German, Spanish, Russian and Vietnamese still showed in English are now translated.
- Fixed text concatenation: "Master password (optional)" and "Login · Favorite" have their spaces back, the built-in local vault name follows the interface language in lists and details, and the read-only website section is no longer labeled optional.
- The bundled browser MDBX engine now uses zip 9.0.5, which resolves the critical, high and medium GitHub advisories reported for zip 2.4.2. The complete-backup ZIP format is unchanged and was cross-read with zip 2.4.2. The optional Windows helper keeps zip 2.4.2 because its Rust 1.86.0 toolchain must match the reviewed core release.
- Adding a custom field to an API key that already has 64-bit string field IDs no longer creates an invalid ID that blocks saving.
- Development and release checks: `npm run check` now uses vue-tsc, so single-file component scripts and templates are type-checked. Fixed the MonicaDocs notification workflow, which failed on every run, and the weekly full-history secret scan; reviewed false positives are excluded by exact path and `verify:workflows` keeps the exclusions narrow. The development dependency minimatch is overridden to 11.0.4, so `npm audit` no longer reports the moderate ESLint toolchain advisory.
