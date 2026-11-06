# Monica 浏览器扩展维护指南

本文件供维护者和编码代理使用，只保留长期维护约定。任务流水、构建耗时、历史测试计数和本机配置另存；当前版本从构建配置读取。

## 项目入口

- 先读 [贡献指南](CONTRIBUTING.md)；发布前读 [发布流程](docs/RELEASE.md)，安全问题遵循 [安全政策](SECURITY.md)。文档中的历史版本示例不替代实际配置。
- 技术栈为 Vue 3、TypeScript、Vite 和 Manifest V3。`src/manager/`、`src/popup/`、`src/components/` 管理界面；`src/background/`、`src/runtime/` 处理后台和消息；`src/content/` 处理网页交互；`src/security/`、`src/providers/`、`src/passkey/` 管理安全与密码源。
- 单元测试与源码相邻，真实浏览器测试在 `tests/e2e/`。`native/mdbx2-browser/` 是内置浏览器引擎，`native/mdbx2-host/` 是可选本机助手，两者工具链分别固定，不能互相代替。
- Chrome/Edge 输出为 `dist/`；Firefox 使用独立构建，输出为 `dist-firefox/`，兼容性及签名要求见 [Firefox 说明](docs/FIREFOX.md)。

## 环境与验证

Node 版本见 `.nvmrc`，npm 版本和允许范围见 `package.json` 的 `packageManager`、`engines`。在仓库根目录执行：

```bash
npm ci --ignore-scripts
npm run verify:toolchain
npm run lint
npm run check
npm test
```

首次完整构建前，按 [发布流程](docs/RELEASE.md)及 `.github/workflows/ci.yml` 准备固定版本的 Rust、Emscripten 和浏览器引擎，执行 `npm run build:mdbx2-browser`。然后运行 `npm run build`；不要用占位 WASM、旧产物或跳过校验绕过环境缺失。

- 按改动运行相关单元和浏览器回归。真实扩展行为使用隔离浏览器配置及合成数据验证，不操作日常浏览器的密码库和登录状态。
- Chromium E2E：先执行 `npx playwright install chromium`，再执行 `npm run test:e2e`；Windows Edge 验收使用 `npm run test:e2e:edge`，缺少 Edge 不算通过。
- 安全边界修改补充负向测试并运行 `npm run test:security`；发布执行完整 `npm run release:check`。Windows 本机助手及 Firefox 另按各自流程验证，不能由 Chromium 结果代替。
- 纯文档修改只需核对链接、命令和 `git diff --check`，无需运行完整构建。报告如实区分通过、失败、复测、跳过及未验证范围。

## 版本号必须同步

- 新功能和修复默认记录在 [下一版说明](docs/RELEASE-NEXT.md)所指向的未发布 changelog；明确切换开发版本或准备发布时再升版。纯文档维护无需增加应用版本。
- 沿用 `1.0.<递增修订号>` 的三段数字格式。升版必须同时修改以下四处值：
  - `package.json` 的 `version`；
  - `package-lock.json` 顶层 `version`；
  - `package-lock.json` 中 `packages[""].version`；
  - `public/manifest.json` 的 `version`。
- 不只修改 `dist/manifest.json`，不只修改 `package.json`。完成后执行 `npm run build`，其 `scripts/build-identity.mjs` 会检查四处一致并生成构建标识；不手工编造 `src/runtime/build-id.json`。
- 切版时同步未发布说明；正式发布时同步 README、`docs/RELEASE.md` 中的当前版本说明及 `docs/releases/` 的版本归档。保留已发布说明、标签和历史记录，不用新内容回写旧版。
- 正式标签使用 `vX.Y.Z`，与清单版本和已验证提交对应。可选本机助手有独立版本，涉及助手协议或打包时核对其配置，不强行与扩展版本相等。

## 安全与兼容

- 保留现有加密、KDF、会话锁定、来源校验和冲突保护。解密失败不能触发静默清库、重置或覆盖；异步结果在锁定、取消、切源后重新校验授权。
- 网页及 content/MAIN-world 消息属于不可信输入。后台核验消息发送者、origin、tab/frame、权限与用户操作，不向网页暴露完整密码库，不绕过 Passkey 的 RP、来源和用户验证。
- 不引入远程可执行代码，不绕过 CSP、Manifest 权限或源码 lint 护栏。修改权限、运行时消息、密码库、Passkey、同步、解析或发布脚本时，按贡献指南补充对应负向测试和安全文档。
- 保留跨端 UUID、未知字段、受保护字段、附件及修订语义；同步冲突或异常空结果不能自动覆盖、批量删除原数据。相关约定见 [同步兼容性](docs/SYNC_COMPATIBILITY.md)和 [Passkey 兼容性](docs/PASSKEY_COMPATIBILITY.md)。
- 依赖使用官方 npm registry 和 lockfile；GitHub Actions 固定完整 commit SHA，保留供应链、安全审计及可复现打包检查。真实密码、Token、私钥、服务器地址和用户库不得进入仓库或测试输出。

## 界面与多语言

- 复用现有 Material 3 Expressive 组件、主题、图标和短动效。设计改动先用本地 M3E Canvas 草图明确页面与操作，再检查真实扩展页面；保留键盘操作、窄屏、大字号、深浅主题和减少动态效果支持。
- 文案沿用 `src/i18n/`、`public/locales/` 和 `public/_locales/` 的现有机制，补齐当前支持的全部语言，保留参数，不翻译用户数据；细节见 [本地化指南](docs/LOCALIZATION.md)。
- 设计草图、截图及浏览器配置只留本地，遵循 `.gitignore`，不强制加入 `docs/design/`，不在提交文档中引用无法随仓库访问的本地图片。

## 提交与发布范围

- 开始前核对 Git 状态；按文件明确暂存，保留其他任务改动。提交前检查差异及 `git diff --check`，不夹带构建产物、私有数据或临时文件。
- 提交、推送、发布分别按用户授权执行。上游 `main` 推送会触发 CI，并可能更新 Development Preview；推送前检查工作流，不把推送视为没有发布副作用。
- 正式包按现有脚本生成与校验；用户下载附件只上传明确指定的 ZIP 和对应校验文件，不用通配符上传整个产物目录。Firefox 签名和商店提交遵循相应账号流程。
- 可公开的验证摘要放在 `docs/verification/`，原始日志和机器信息留在本地任务目录；不要向本文件追加每次任务的结果和“当前状态”。
