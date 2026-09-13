# 0.1.33 Android 风格概览与跨端兼容验证

日期：2026-09-13。验证只使用合成数据、独立浏览器配置和隔离 Android 互操作环境。

## 页面调整

- 参考 Android 的概览层次：顶部选择数据库，桌面用两列排列卡叠、收藏、类型与文件夹，窄屏按模块顺序显示。移除重复介绍，类型与文件夹使用分组列表，归档／回收站收敛为紧凑入口。
- 各模块支持展开／收起并保存状态。数据库默认收起，需要处理的同步数量仍显示在标题旁；隐藏模块和折叠模块互不覆盖。收藏夹兼容既有的独立展开偏好。
- 全部数据库范围下保留账号／文件夹的来源标识，单库浏览减少重复来源标签。同名文件夹继续按来源及原始 ID 区分；默认范围、记住上次选择和指定数据库均保留。
- 自定义首页和选卡使用原生模态对话框。内容滚动，保存／取消固定可见，退出后回到触发按钮；恢复默认、推荐和清空操作移至各自内容区。保存失败继续保留草稿。
- 保留 Nothing 的本地字体、深浅主题、平面表面与至少 44px 的按钮目标。本轮新增四条文案，各非中文词库共 2,858 个键。

## 同步修复与兼容范围

复现并修复了 WebDAV 验证器关联回退：插件编辑 `LoginItem.boundTotpItemId`，Android 用 `TotpItem.boundPasswordId` 表示反向关联。此前新建、更换和解除关联没有完整转换成 Android 记录，重新同步后会丢失新关系或恢复旧关系。现在在序列化前校验关系，更新相关验证器及其修改时间，再按原格式写回。

旧记录缺少插件绑定字段时仍保留 Android 反向查找；明确解除用空字符串记录在扩展现有字段中，JSON 导入与加密存储保留该区别。编辑旧 Android 记录时，选择器显示实际关联的验证器。明确指定但已不存在的验证器不会错误回退到另一条旧关联。

加密快照回归验证了绑定、更换、解除及下一次同步，核对返回状态、调用者数据不被修改、HOTP 计数器和未知字段。新增登录项与验证器同时导出也能恢复关联。缺失／已删除／跨库目标、重复 Android 登录项 ID、一个验证器关联多个登录项等无法完整表达的关系，在写入前明确报错。

| 范围 | 本轮证据 | 实际限制 |
| --- | --- | --- |
| Android WebDAV ZIP 与加密快照 | 当前 Android 各条目形态、收藏、已有和新修改的验证码关联、HOTP、分类、附件、历史、未知字段及冲突／ETag 检查通过 | 使用 `Monica_Backups` 时间戳快照；另一端需要读取／恢复相应快照，不是逐条实时推送 |
| MDBX2 | 实际 Android → 扩展 Native Host → Android → 扩展往返通过；验证认证对象、外部 Blob、卡片附件和同步段 | 使用两端兼容的 MDBX2 格式与同一远端；不等于浏览器本地库自动与 Android 本地库合并 |
| KeePass | 实际 Android Kotpass AES-256、ChaCha20 文件往返通过；保留受保护字段、OTP、自定义字段、历史、附件、卡片／证件照片、Passkey 字段和嵌套分组 | Twofish 仍明确不支持；设备保护的 Passkey 引用不能因此变成便携签名私钥 |
| 首页显示配置 | `monica_config/page_adjustment_settings.json` 在修改收藏、消费 HOTP 和修改关联后的导出中按原字节保留 | Android 与插件的模块、数据库、固定卡片标识不同，首页布局按设备分别保存；不会把扩展 ID 强行写入 Android 设置 |

Android 参考源码位于 `Monica-main/Monica for Android`，包括 `VaultOverviewConfig.kt`、`VaultOverviewScreen.kt`、`VaultOverviewContent.kt`、`VaultOverviewCards.kt` 与 `WebDavHelper.kt`。KeePass 互操作记录的 Android 修订为 `a85d353425953ef70ba656001aa20ca3f4a94b56`。MDBX2 证据包含 2 个 Android 同步段、1 个浏览器同步段、9 个 Android Blob 和 6 个浏览器 Blob。

这两个实际 Android 互操作测试在本轮完成；之后未修改相应 KeePass／MDBX2 编解码或 Native Host。WebDAV 关联修复由单元测试和加密提供方往返测试验证，没有另外执行 Android 界面的手工 WebDAV 恢复流程。布局调整未修改数据库格式、加密参数或原有同步协议，也未新增 Rust／Native Host 接口。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 全量单元测试 | 122 个文件、1,150 项通过 |
| 首页／OTP／导入／WebDAV 专项 | 10 个文件、107 项通过，保留 Vitest 原始 JSON 报告 |
| 浏览器回归 | 21 个文件、117 个不同用例的最终结果通过；包含概览、编辑／详情、旧 Android 绑定解除、自动填充、Passkey、钱包、数据库冲突和备份恢复 |
| 小屏与无障碍 | 八语言、深浅主题、320px、200% 字号、键盘操作及 Axe 严重／关键问题检查通过；原有页面回归覆盖 320–2560px |
| 大库 | 2,000 条附加数据的概览有界渲染、查找、文件夹和完整列表分页通过；既有大库浏览器用例通过 |
| 实际工具栏 Popup | `chrome.action.openPopup()`、200% 字号、六种附加离线语言、搜索与复制回退通过 |
| 构建 | TypeScript、221 个图标、Vite、Worker 和本地资源引用检查通过 |
| 安全与依赖 | 安全审计、工具链、锁文件、工作流和 Native Host 固定版本校验通过；生产依赖审计 0 个漏洞 |
| 权限与包体 | Manifest 相对 0.1.32 仅版本号改变，生产 SBOM 组件相同；ZIP、解压目录、dist 及两次独立打包校验通过 |

首次 117 项浏览器合并运行中 114 项通过，3 项失败来自测试准备或旧布局假设：测试使用不存在的固定本地源 ID／不合适的选择器、仍寻找旧“添加登录项”入口、以及仍要求每个类型按钮单独圆角。相应测试改用实际源 ID、当前入口和分组容器断言后通过专项复跑；两种主题的八语言概览用例也完成最终截图复核。原始失败报告保留，没有将它改写为一次全绿运行。最终逐项汇总见 [浏览器结果汇总](../.artifacts/home-0.1.33/e2e-summary.json)。

证据：

- [全量单测输出摘要](../.artifacts/home-0.1.33/unit-summary.json) · [专项单测原始报告](../.artifacts/home-0.1.33/home-webdav-unit-results.json)
- [浏览器原始合并运行](../.artifacts/home-0.1.33/e2e-results.json) · [登录用例复跑](../.artifacts/home-0.1.33/e2e-corrected-fixtures.json) · [视觉用例复跑](../.artifacts/home-0.1.33/e2e-visual-review.json)
- [MDBX2 Android 测试](../.artifacts/home-0.1.33/mdbx2-android-results.json) · [对象／Blob 证据](../.artifacts/home-0.1.33/android-mdbx2-evidence.json)
- [KeePass Android 测试](../.artifacts/home-0.1.33/keepass-android-results.json) · [密码算法／字段证据](../.artifacts/home-0.1.33/android-keepass-evidence.json)
- [版本、权限及安装包核对](../.artifacts/home-0.1.33/release-checks.json) · [截图索引](../.artifacts/home-0.1.33/README.md)

本轮没有重跑全部 E2E、Native Host 硬件验收或所有第三方服务器。保留原有大体积代码块构建提示。格式整理后再次完成生产构建，浏览器回归与出包之间没有功能修改。安装包从既有脏工作区使用 `--allow-dirty` 生成，是本地开发包，不是签名或公开发布版本。

## 交付与更新

- 安装包：[`release/monica-extension-0.1.33.zip`](../release/monica-extension-0.1.33.zip)，1,963,267 字节，50 个文件。
- SHA-256：`4074bdc0074c3e84039bf74e651f7089bb3e3eb406d4a6b40b0a41a85720998e`。
- 可加载目录：`release/monica-extension-unpacked`；开发构建：`dist`，均为 0.1.33。旧 0.1.32 ZIP 与预览保留。
- 打包：`node scripts/package-release.mjs --allow-dirty`；校验：`node scripts/verify-release.mjs --allow-dirty`。

已有安装请沿用原绝对加载路径更新，在 Chrome／Edge 扩展管理页点击 Monica 的“重新加载”，关闭旧管理页并重新打开。若原来加载的就是本项目 `dist` 或上述解压目录，直接重新加载即可。沿用路径可以保持开发者模式扩展身份及已有本地数据。

两端使用同一个 WebDAV 位置／MDBX2 数据库／KeePass 文件和对应密码，再按该来源的同步流程操作；顶部数据库选择只改变展示范围，不会搬动、合并或自动复制记录。
