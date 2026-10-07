# 浏览器创建的 Bitwarden Passkey 与 Android 往返

2026-10-05，凭据认证往返通过，存在已记录的字段缺陷。真实 Edge → 隔离 Vaultwarden → Android 保护存储/签名/备注上传 → 第二个空保险库重建 → 全新 Edge 配置及重启登录均通过。Android 备注会被追加说明与元数据，不能声称字段无损或完整互通。

## 产品修复

新建且直接保存到 Bitwarden 的 Passkey 使用 UUID 对应的 16 字节凭据 ID，WebAuthn 与本地项目保留其 Base64URL 表示，Bitwarden 编码器写出相同字节的 UUID 表示。其他来源的新建行为和旧凭据字节不变。

Bitwarden Provider 创建与更新确认按归一化后的字节标识匹配，不再把 UUID/Base64URL 的文本差异误判为无法映射创建响应。回归覆盖创建、更新、仅删除 Passkey 子条目，确认只发送一次创建请求、没有重复本地凭据。

当前扩展验证：218 文件／2,202 单测通过，生产构建及 TypeScript 检查通过，安全检查覆盖 190 个运行时命令。日志为 `raw/bitwarden-uuid-normalization-{full-tests,build,security,targeted}.log`，源码/构建清单为 `raw/bitwarden-uuid-build-source-manifest.json`。这里的 `raw/` 指 `.codex-tasks/android-interop-315/raw/`。

## 最终实际往返证据

- 输入来自实际 Edge 注册，网站提供 `[-257,-7]`，Bitwarden 保存位置协商 ES256。注册、首次登录与浏览器重启登录通过，确认本地 ID 为 Base64URL、远端表示为相同字节的 UUID，只保留一个远端凭据和稳定本地项目 ID。
- Android 当前 HEAD `8334e6bff9d08529f5d88b911b57a9d0a2579997`，应用 APK SHA-256 `61c8c0c0955e31146957105f19c55e8a6a669f8670485960cda0d0eca13c576d`，测试 APK `535a74e0ce1cb8f25dce4f0f8ef907b122b6cef8fd8629aebfef5427da9dba86`。产品源码未修改。
- 实际 `CipherSyncProcessor` 导入、Room 保护私钥、认证辅助函数签名、Repository 备注编辑和 `BitwardenSyncService.uploadModifiedEntries` 上传通过。上传成功1项、失败0项；第二个空合成保险库重新下载，产生不同本地行 ID，仍保留相同 WebAuthn ID、用户句柄、私钥摘要并能签名。
- 全新 Edge 配置下载 Android 返回值并登录，重启后再登录，两次均以原注册公钥验签。连同准备阶段共4次浏览器签名、2次 Android 辅助函数签名通过独立校验。
- 最终日志：`raw/bitwarden-uuid-notes-gap-edge-prepare-serial.log`、`raw/android-bitwarden-uuid-notes-gap-build.log`、`raw/android-bitwarden-uuid-notes-gap-device.log`、`raw/bitwarden-uuid-notes-gap-edge-return.log`、`raw/bitwarden-uuid-final-check.log`。证据目录 `.tmp/android-bitwarden-uuid-passkeys-317/`，汇总校验脚本 `raw/record-bitwarden-passkey-evidence.mjs`。
- 最后一次并行构建期间的 Edge 提示框超时保留为 `raw/bitwarden-uuid-notes-gap-edge-prepare.log`；构建结束后串行重跑通过，未提高超时或修改产品代码。
- 原应用与测试包已按原 SHA-256 恢复：`1c731442002c4ad678786573a6980e62098dd1bbd89d794707233321259b742f` / `02bab91b8027c213feae397570d5f11c7a3c191af5345bd5784b87cfbe5c5d11`。未清空应用数据，未交付安装包。

## 保留的失败

1. 旧 32 字节真实注册凭据的 Android 导入失败：`b64.` 被当作 Base64 内容，导致凭据字节改变。证据 `.tmp/android-bitwarden-passkeys-317/`。这项缺陷仍影响已有及跨来源迁移的凭据，扩展不会通过更换凭据 ID 掩盖它。
2. 第一轮 UUID 浏览器测试在重启后失败，新增 Provider 回归复现创建确认不匹配，随后修复。
3. 第一轮 UUID Android 夹具只移除了 Passkey、仍保留父 Login。重新下载受父条目状态影响，不能代表空状态导入；已改用另一个空合成保险库，保留 `attempt1-parent-projection-retained/`。
4. 空保险库重新导入后，Android 备注包含自动追加的说明。`PasskeyMapper.buildPasskeyNotes` 添加说明与元数据，读取又只截取 `---` 前的内容；用户文本仍被改变。严格备注断言失败证据保留在 `attempt2-android-note-mutation/`。后续凭据可用性测试会明确记录 `notesPreserved:false`，不会把这项字段缺陷标成通过。

## 验证边界

测试仅使用隔离 Vaultwarden 合成账号；Android 产品源码只读，扩展拥有 instrumentation 测试源码。公共 API32 AVD 能验证实际同步服务、Room、保护存储和密码学辅助函数，不能验证 API34+ Credential Manager 或真实生物识别/PIN。第三方正式 Bitwarden 服务、历史正计数和其他 BE/BS 组合不由本用例覆盖。

Android 修复范围确认与[最小候选提案](android-passkey-id-fix-proposal-317.md)待用户答复。真实 Microsoft 登录还需要配置允许的 OAuth 重定向地址；本次 Vaultwarden 结果不证明 OneDrive 已完成。
