# Android Passkey 实际签名往返（2026-10-05）

后续补充：[真实 Edge 注册／登录及 Android 返回](android-edge-passkeys-317.md) 已把本记录的实际产物接入浏览器，并验证新增 RSA 的 Android 签名。本文保留最初4枚密钥的测试范围；系统 Credential Manager 和真实 Android UV 仍未覆盖。

本轮证明 EC／RSA 私钥能经过 Android 保护存储、MDBX、插件、再导回 Android 后继续签名。**完整互通仍未通过**：Android 的认证数据生成函数忽略了导入凭据的显式 BE/BS，固定返回 `0x1d`。此处测试的是实际加密和数据库实现，没有覆盖系统 Credential Manager 选择界面、浏览器调用或生物识别。

## 实际执行链

1. 以 Android HEAD `8334e6bff9d08529f5d88b911b57a9d0a2579997` 重建普通版和扩展专用 instrumentation。APK SHA-256 `a35823fb42c89b64044c04067a2aa5c8fef00f5161fe71c375d17300cd3409d5`；测试 APK `1acb80a0c3c0ffe2250a557d0f0999c81f87f17c9f3bda598765605e2d5aac20`。产品源码未修改。
2. 在公共 API32 AVD 中反射调用 `PasskeyCreateActivity.generateKeyPairForAlgorithm/createCosePublicKeyFromKeyPair`，分别生成 ES256、RS256 密钥。通过实际 `PasskeyRepository.savePasskey` 写入新建的合成 MDBX 和 Room；验证 Room 只存保护引用，私钥可经 `PasskeyPrivateKeyStore` 解出并由实际 `PasskeyAuthActivity.signWithPrivateKey` 签名。
3. 使用实际 Native Host 打开 Android 导出的加密 MDBX，经过插件 codec 得到相同凭据和私钥摘要。独立 Node crypto 验证 Android 签名；插件 `createAssertion` 也能签名，并通过独立验签。
4. 插件保留原两枚密钥并追加新建 ES256／RS256，写出实际加密 MDBX。为探测兼容性，原 EC 设 `backupEligible=false/backupState=false/signCount=41`；原 RSA 设 `true/false/0`。这仅作用于合成数据。
5. Android 实际 `MdbxViewModel.syncVault` 投影四枚密钥，保护存储引用全部有效；实际 Android 签名函数对四枚均成功。再次导出后，独立 Native 读取证明四枚的凭据身份、私钥摘要和显式备份字段仍在文件中，历史计数41仍在 Room/文件中；独立 Node 验签和插件核心签名均通过。

## 未通过的兼容性要求

| 合成凭据状态 | 应有认证标志（假定本次 UV 成功） | 实际 Android 函数输出 | 结论 |
| --- | --- | --- | --- |
| BE=false，BS=false | `0x05` | `0x1d` | Android 改变了凭据备份资格与状态 |
| BE=true，BS=false | `0x0d` | `0x1d` | Android 改变了备份状态 |
| BE=true，BS=true | `0x1d` | `0x1d` | 此组合一致 |

`signature-return-evidence.json` 明确保存 `interoperabilityComplete:false` 和两个 `compatibilityGaps`。JUnit/Vitest 通过只表示实际数据链和签名校验完成，不能把这些差异算作兼容通过。

测试直接传入零计数给认证数据辅助函数，因此本次签名中的0 **不能证明完整认证入口已经处理历史计数**。当前 `PasskeyAuthActivity` 完整入口仍在源码中设置 `newSignCount=0`；历史正计数的网站接受性、Bitwarden 提交与回退策略仍未验收。UV 标志也来自现有辅助函数，不是实际指纹、PIN或主密码验证的结果。

Android 改进至少需要：把凭据的显式 BE/BS 保留到可用的认证模型中；生成认证数据时按该凭据传入；禁止 BS=true/BE=false；按真实来源单独处理历史计数，避免直接把所有计数改成固定值。需增加系统 Credential Manager 实际调用的验证。此任务仍保持 Android 产品源码只读。

## 证据与运行边界

- 2 个 Android instrumentation 阶段、2 个 Native/Vitest 阶段通过。原始文件均在 `.tmp/android-passkey-signatures-317/`：`passkey-signatures-export/import-evidence.json`、`android-signatures.json`、`android-return-signatures.json`、`signature-prepare/return-evidence.json`、加密 MDBX 和公开预期摘要。
- 原始日志：`.codex-tasks/android-interop-315/raw/android-passkey-{build-final,export-1,import-1,native-prepare-1,native-return-1}.log`。prepare 阶段执行后增加了 return 阶段的显式备份标志差异记录；没有修改密钥生成/签名或 prepare 写入逻辑。
- 首次编译成功，但原使用任务停止了模拟器，runner 将该轮标为设备来源校验失败；保留 `android-passkey-build-1.log`，没有算作 Android 测试通过。确认设备和进程均停止后，本任务重新启动同一公共 AVD。第二次构建和两个设备阶段来源校验全部通过。
- 测试结束后，应用和测试包均恢复到启动本轮前备份的精确字节；`restored-packages.json` 记录两个 SHA-256。随后停止本任务启动的模拟器，保留配置和数据盘。未交付 APK，未提交或发布。

测试入口为 `tests/interop/android-app/src/takagi/ru/monica/credentialexchange/ExtensionPasskeySignatureInteropTest.kt` 和 `tests/interop/android317-passkey-signatures.interop.ts`。设备阶段要求 `MONICA_APP_INTEROP_TEST_SET=passkey-signatures`；Native 阶段使用 `vitest.android-passkey-signatures.config.ts` 和 `MONICA_PASSKEY_INTEROP_PHASE=prepare/return`。`MONICA_315_APP_FIXTURE` 必须明确指向本次合成产物目录。安装前后需再次核对设备占用及包身份，不能覆盖另一任务的安装。
