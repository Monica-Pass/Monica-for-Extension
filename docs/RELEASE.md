# 可复现发布流程

## 环境

- Node.js 22
- 使用仓库中的 `package-lock.json` 执行 `npm ci`
- 干净的 Git 工作区和受支持的 Chromium E2E 环境

## 完整门禁

```bash
npm ci
npm run release:check
```

`release:check` 依次执行单元测试、TypeScript/生产构建、安全测试与审计、Chromium MV3 E2E、正式打包和独立发布验证。

## 发布产物

对版本 `X.Y.Z`，`release/` 中生成：

- `monica-extension-X.Y.Z.zip`：可提交 Chrome/Edge 商店的 MV3 扩展。
- `monica-extension-X.Y.Z.zip.sha256`：ZIP 的 SHA-256 校验值。
- `monica-extension-X.Y.Z.sbom.cdx.json`：CycloneDX 1.5 SBOM。
- `monica-extension-X.Y.Z.third-party-licenses.json`：生产依赖版本、完整性值和许可证清单。

ZIP 内额外包含：

- `RELEASE-METADATA.json`：版本、固定时间、lockfile 哈希和每个归档文件的大小/SHA-256。
- `SBOM.cdx.json`：与外部 SBOM 字节一致。
- `THIRD-PARTY-LICENSES.json`：与外部许可证清单字节一致。
- `LICENSE`：项目的 GNU GPL v3 完整许可证文本。

ZIP 自身的哈希不能嵌入 ZIP（会形成循环依赖），因此由并列的 `.zip.sha256` 文件提供。

## 确定性约束

- `dist/` 路径按稳定字典序加入归档。
- 所有 ZIP 条目的 DOS 时间固定为 1980-01-01 00:00:00；ZIP 格式本身不保存时区。
- 元数据、SBOM 和许可证清单按稳定顺序生成，不包含当前时间、绝对路径或机器信息。
- `package:verify` 在两个独立临时目录中重新打包，并要求 ZIP、checksum、SBOM 和许可证清单逐字节相同，同时与 `release/` 中的正式产物相同。

## 手工校验

```bash
npm run package:release
npm run package:verify
```

发布前还应确认版本号、商店文案、隐私政策、截图脱敏和 Git tag/Release 指向同一已验证提交。商店账号提交和签名由账号持有人完成，不在本仓库自动化范围内。
