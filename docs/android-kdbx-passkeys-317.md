# Edge 创建的 KDBX Passkey 在 Android 上签名及回写

2026-10-05 验证：真实 Edge 创建的 RSA Passkey 经插件 OneDrive 数据源写入加密 KDBX 后，Android 能读取同一凭据、保护存储其私钥、生成可独立验证的签名，并修改备注后回写相同 KDBX 条目。Microsoft OAuth/Graph 使用模拟服务；这不构成真实 OneDrive 或 Android Credential Manager 登录验收。

## 执行与结果

1. `tests/e2e/passkey-registration-algorithms.spec.ts` 的 OneDrive 用例在实际 Edge 中注册 RSA、登录、排除重复注册、重启后登录，并保存模拟云端收到的实际加密 KDBX。产物目录为 `.tmp/kdbx-passkey-edge-input/`。准备脚本核对了上一轮完整构建清单中全部 1651 个 `src/dist` 文件。
2. Android HEAD `8334e6bff9d08529f5d88b911b57a9d0a2579997` 构建成功。应用 APK SHA-256 为 `0cd8d9eae6e8f7e08737b4b9d7b57922eb8f85d9b0254489f912516cdf3f2ca0`，测试包为 `98702fb1fe6f86844f59d5dbd3c2792d3eac887bf1e424a57010b62319959140`。产品源码未修改。
3. 公共 API32 AVD 上 `importSignEditAndReturnKeePassKeys` 通过：实际 `KeePassKdbxService.readPasskeyEntries`、`PasskeyRepository.syncKeePassPasskeys`、Room 保护引用、`PasskeyAuthActivity` 加密辅助函数和 `KeePassKdbxService.updatePasskey` 均已执行。只操作新建的合成数据源，结束后清理该数据源和凭据。
4. 独立 Node/KDBX 读取返回文件：条目 UUID、凭据 ID、RSA 私钥摘要、用户句柄、名称、算法、零计数、文件中的 BE/BS 均一致；备注已变为 `Android KDBX signature return`。以原 Edge 公钥验证 Android 签名成功。

输入 KDBX SHA-256：`9be8e7dcfc084c7c6037208432a179b1c7fef9d212104f8c28ef38178b9aea86`。
返回 KDBX SHA-256：`2e646fc6963050851a76a95d6981b50e8f0ae7fbe089975730b46f35e275a94b`。

## 已复现差异与限制

KDBX 的 BS=true 保留在文件中，但 Android 的 `KeePassPasskeySyncCodec.Payload.toPasskeyEntry` 固定设置 `isBackedUp=false`，新建的 Room 投影因此为 false。`KeePassDxPasskeyCodec` 使用此字段表示 BS，但内部同步 payload 没有保存它。这是投影差异；本次签名的辅助函数固定输出 BE/BS=true，因此本枚凭据的签名标志恰好一致，不能据此说明投影已修复。

`kdbx-return-evidence.json` 明确记录这一差异及 `interoperabilityComplete:false`。本轮是一枚真实注册的 RSA 凭据，不能替代 EC、历史正计数、显式 BE/BS=false、系统 Credential Manager、真实 PIN/生物识别、真实 Microsoft 或 WebDAV 上传的验证。历史 MDBX 用例中的计数及标志差异仍未解决。

## 证据与环境

- `.tmp/android-kdbx-passkeys-317/` 包含输入来源证明、构建及设备来源、Android 签名、返回文件、独立验证和安装包恢复记录。
- 日志：`.codex-tasks/android-interop-315/raw/kdbx-passkey-edge-input.log`、`android-kdbx-passkeys-build.log`、`android-kdbx-passkeys-device.log`、`android-kdbx-passkeys-return.log`、`kdbx-passkey-check.log`。
- 1 个实际 Edge 用例、1 个 Android instrumentation 用例、1 个独立返回用例及两套 TypeScript 检查通过。本轮产品代码未改变，没有重新计入上一轮 2198 个单元测试。
- 公共虚拟机由其他任务启动，保持运行。本任务结束设备测试后恢复普通版及测试包的原 SHA-256：`1c731442002c4ad678786573a6980e62098dd1bbd89d794707233321259b742f` / `02bab91b8027c213feae397570d5f11c7a3c191af5345bd5784b87cfbe5c5d11`。未清空应用数据，未交付安装包。
