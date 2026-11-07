# 可复现发布流程

Firefox 桌面版使用独立的 `build:firefox` / `package:firefox`，输出 `dist-firefox/` 和本地未签名 XPI；不纳入下述 Chromium ZIP 直接分发流程。最低版本、临时加载、Mozilla 签名与 OneDrive 应用回调配置见 [Firefox 说明](FIREFOX.md)。

## 环境

扩展从 `1.0.101` 起采用 `1.0.<递增修订号>`，当前版本为 `1.0.104`，常规下一版为 `1.0.105`。浏览器清单、`package.json`、`package-lock.json` 根版本必须相同，GitHub 正式发布标签使用 `v1.0.104` 形式。更新检测按三段数字比较，查询该仓库的最新正式 Release；不把预发布标签、草稿或旧版本视为可更新版本。`0.1.x` 已发布记录保持原样。此处记录命名规则，不代表已创建标签或发布。

- Node.js 22
- 使用仓库中的 `package-lock.json` 执行 `npm ci`
- 干净的 Git 工作区和受支持的 Chromium E2E 环境
- 内置 MDBX 包：Rust 1.97.0（提交 `2d8144b7880597b6e6d3dfd63a9a9efae3f533d3`）及 Emscripten 4.0.18；Native Host 继续使用其原来的 Rust 1.86.0。先加载本地 SDK 环境，运行 `cargo +1.97.0 fetch --locked --manifest-path native/mdbx2-browser/Cargo.toml` 和 `npm run build:mdbx2-browser`。预取不限制目标平台，确保离线构建同时拥有宿主平台构建脚本所需依赖。随后普通 `npm run build` 复用并验证产物，不重复编译 Rust。CI 已加入对应源码构建步骤。

## 完整门禁

```bash
npm ci
npm run release:check
```

`release:check` 依次通过官方 npm registry 审计生产依赖，再执行单元测试、TypeScript/生产构建、安全测试与审计、Chromium MV3 E2E、正式打包和独立发布验证。

供应链预检还要求 `.npmrc` 默认禁用依赖生命周期脚本、固定官方 npm registry，并验证 lockfile 中每个 registry 包都有官方来源 URL 和 SHA-512 integrity。

## 发布产物

### 自动更新的 Preview

固定预发布入口为 [Development Preview](https://github.com/Monica-Pass/Monica-for-Extension/releases/tag/preview)。每次上游 `main` 推送都会执行 CI；也可在 GitHub Actions 手动运行 `CI`（选择 `main`）。Linux 完整发布门禁与 Windows Edge / MDBX Host 验证均通过后，`publish-preview` 下载同一次运行的产物，复核 SHA-256、干净工作树证据及源提交，再更新 `preview` 标签和预发布附件。

公开附件仅含 Chromium 扩展 ZIP、Windows x64 MDBX Host ZIP 及各自校验文件。文件名追加 `preview-<提交前12位>-<运行编号>-<重试编号>`，ZIP 内版本和源证据保留原构建内容；普通扩展更新检测继续使用最新正式版。Firefox 未签名 XPI 继续留在 CI artifact 中，安装限制见 Firefox 说明。

发布步骤串行执行，发布前再次核对 `main`，防止较旧运行覆盖新提交。新包全部上传成功后才更新发布说明并清理旧附件；构建或校验失败时继续保留上一次成功的 Preview。首次创建使用草稿，完整上传后公开。PR、分支和 fork 构建均不会写入 Preview。

GitHub Release 的公开下载附件只上传插件 ZIP 与对应 `.zip.sha256`。不要使用 `release/*` 通配符上传到 Release；三个独立 JSON 继续留在本地／CI 审计产物中，并已逐字节嵌入 ZIP，无需重复占用公开下载列表。GitHub 自动生成的两个 Source code 下载项保留。若另行发布可选本机助手，同样只上传它的安装 ZIP 和校验文件。

Windows 完整发行包还需包含 Wi-Fi 设置页可下载的可选通信安装 ZIP。Linux CI 的通用扩展产物不附带此 Windows 文件；制作完整包时使用已验证的 CI 核心文件，并将同次 Windows CI 的 Host 二进制通过 `MONICA_WIFI_HOST_EXECUTABLE` 传给现有 `build-nearby-setup.mjs`。随后重新执行标准打包、独立包验证、安全审计和实际下载入口检查，记录最终 ZIP 哈希及与 CI 文件的差异。CI 原始 ZIP 的来源证明只覆盖原 ZIP，不能当作补充后完整 ZIP 的签名。最近一次（1.0.104）的具体记录见[发布验证](verification/release-1.0.104.md)。

普通用户只需下载插件 ZIP。此规则自 0.1.39 起执行；2026-10-14 经用户确认已移除该版三个重复 JSON 附件，ZIP、校验文件及发布标签保持不变。后续创建 Release 时显式列出两个文件，例如：

```bash
gh release upload vX.Y.Z release/monica-extension-X.Y.Z.zip release/monica-extension-X.Y.Z.zip.sha256
```

对版本 `X.Y.Z`，`release/` 中生成：

- `monica-extension-X.Y.Z.zip`：可提交 Chrome/Edge 商店的 MV3 扩展。
- `monica-extension-X.Y.Z.zip.sha256`：ZIP 的 SHA-256 校验值。
- `monica-extension-X.Y.Z.sbom.cdx.json`：CycloneDX 1.5 SBOM。
- `monica-extension-X.Y.Z.third-party-licenses.json`：生产依赖版本、完整性值和许可证清单。
- `monica-extension-X.Y.Z.security-evidence.json`：源 commit、干净工作树、工具链和嵌入证据哈希。
- `monica-extension-unpacked/`：每次打包前完整清理并重新生成的开发者模式加载目录，内容与 ZIP 条目逐字节一致。

ZIP 内额外包含：

- `RELEASE-METADATA.json`：版本、固定时间、lockfile 哈希和每个归档文件的大小/SHA-256。
- `SBOM.cdx.json`：与外部 SBOM 字节一致。
- `THIRD-PARTY-LICENSES.json`：与外部许可证清单字节一致。
- `SECURITY-EVIDENCE.json`：与外部安全证据字节一致，并绑定源 commit 与 lockfile/SBOM 哈希。
- `LICENSE`：项目的 GNU GPL v3 完整许可证文本。

ZIP 自身的哈希不能嵌入 ZIP（会形成循环依赖），因此由并列的 `.zip.sha256` 文件提供。

## 确定性约束

- `dist/` 路径按稳定字典序加入归档。
- 所有 ZIP 条目的 DOS 时间固定为 1980-01-01 00:00:00；ZIP 格式本身不保存时区。
- 元数据、SBOM、许可证清单和安全证据按稳定顺序生成，不包含当前时间、绝对路径或机器信息。
- `package:verify` 在两个独立临时目录中重新打包，并要求 ZIP、checksum、SBOM、许可证清单和安全证据逐字节相同，同时与 `release/` 中的正式产物相同。
- `package:verify` 同时核对已解压目录的文件清单和内容，防止旧 HTML、旧哈希资源或多次构建文件混合。

## 手工校验

```bash
npm run package:release
npm run package:verify
```

发布前还应确认版本号、商店文案、隐私政策、截图脱敏和 Git tag/Release 指向同一已验证提交。商店账号提交和签名由账号持有人完成，不在本仓库自动化范围内。

## 本地开发包

需要在提交前加载和检查当前改动时，可使用：

```bash
npm run build
node scripts/package-release.mjs --allow-dirty
node scripts/verify-release.mjs --allow-dirty
```

此模式仍校验 ZIP、解压目录、文件哈希和两次独立打包的一致性；`SECURITY-EVIDENCE.json` 如实记录未提交工作树，产物只作为本地开发包。默认正式发布门禁仍要求干净工作树。
