# Android Passkey 标识兼容修复提案

状态：用户已于 2026-10-06 授权修复 Android。凭据 ID、允许列表、取消、认证标题和备注兼容修复已写入普通版与 F-Droid，正在验证；当前实现及验收见 [修复记录](android-passkey-fixes-317.md)。下面保留原始提案和失败证据。

## 可重复的问题

真实 Edge 注册的 32 字节凭据通过实际 Vaultwarden 同步后，Android 的 `PasskeyCredentialIdCodec.decodeFlexible` 将 `b64.` 前缀当成 Base64 内容，导致网站已注册的凭据 ID 改变。原始失败保存在 `.tmp/android-bitwarden-passkeys-317/`，日志为 `.codex-tasks/android-interop-315/raw/android-bitwarden-passkeys-device.log`。

样例（只含合成凭据的公开标识）：

- 网站注册 ID：`sPRk4p1Z8GKaHlkk_iwpSRZ5B9HeqPZNWg5optdhDfI`
- Bitwarden 格式：`b64.sPRk4p1Z8GKaHlkk_iwpSRZ5B9HeqPZNWg5optdhDfI`
- Android 错误结果：`b64sPRk4p1Z8GKaHlkk_iwpSRZ5B9HeqPZNWg5optdhDfA`

扩展新建的 Bitwarden 凭据已改为可无损表示成 UUID 的 16 字节 ID。但既有 32 字节凭据，以及从 MDBX/KDBX 转入 Bitwarden 的凭据，不能改 ID；更换 ID 会使网站保存的注册失效。因此仍需要 Android 修复。

## 拟修改内容

单文件候选补丁：`.codex-tasks/android-interop-315/raw/android-passkey-id-codec-proposed.patch`，针对 Android `app/src/main/java/takagi/ru/monica/passkey/PasskeyCredentialIdCodec.kt`。

1. 识别 Bitwarden `b64.` 标签，验证其内容后再解码，保留原始凭据字节。
2. 16 字节 ID 继续输出 UUID；其他有效字节 ID 写入 Bitwarden 时增加 `b64.` 标签。
3. 保留无法识别的旧文本，不通过宽松解码悄悄改写。不会批量重写已有凭据，也无法从错误 ID 唯一反推出原始值。

## 接受标准

- UUID、Base64URL、带标签的 16/32 字节 ID 往返后原始字节完全相同，非法标签内容不会被解释成有效凭据。
- 复用真实 Edge 注册 → Vaultwarden → Android 保护存储/签名/备注上传 → 空保险库重建 → Edge 登录与重启链路，独立校验公钥签名、凭据 ID 和私钥摘要。
- 补充 Android 回归测试，运行普通版与 F-Droid 相关构建/测试，记录到各自 1.0.317 未发布说明。本补丁与 OneDrive 无关。
- 其他 Android 差异（计数、BE/BS、Credential Manager 的实际认证）仍逐项验证，不因这个补丁通过而声称全部互通。

范围确认依据：现有 `SPEC.md` 规定 “Android sources remain untouched; report Android gaps with reproduction and minimal suggestions.” 若允许修改 Android，仅处理影响本次互通和自动填充验收的必要缺陷及其测试/发行说明，保留其他任务的修改。

## 同次验证新发现的备注差异

UUID 凭据实际完成 Android 导入、签名、上传，并在第二个空保险库重建成功后，严格备注断言失败：`Android Bitwarden signature return` 被追加了两行说明。失败证据为 `.tmp/android-bitwarden-uuid-passkeys-317/attempt2-android-note-mutation/` 与 `raw/android-bitwarden-uuid-fresh-vault-device.log`。

已定位 Android `PasskeyMapper.buildPasskeyNotes` 的追加写入，以及 `CipherSyncProcessor.extractPasskeyUserNotes` 的读取转换。后续修复需同时保证普通备注、包含 `---` 的正文、空备注清除及多次同步不增添文本；应保留历史 marker-only 凭据的读取兼容。此问题不由上面的凭据 ID 补丁处理，也尚未应用 Android 修改。
