# Android 1.0.317 凭据组往返

本页保存较早的八行样本证据。2026-10-04 已新增并通过富公共字段、密码/凭据组排序的十行往返，实际版本 `1.0.317-26100412-18`，见 [公共字段与排序](project-common-fields-and-order-317.md)。当前脚本已升级为十行样本；重跑使用下列新目录，保留旧八行证据。

实际应用四段往返与真实 Edge 返回检查均已通过。八条记录的项目／凭据组／密码标识、顺序、共享账号、OTP 清空状态、未知大整数和字段保护标志均按预期保留；Android 修改原项目后，复制项目保持不变。

## 范围

使用公共 `Monica_Issue136_API_32` 的普通版 `1.0.317-26100412-15`。扩展拥有专用 Android instrumentation 源码，调用应用实际的 `PasswordViewModel`、MDBX 写入、Room 回读和 ZIP 导入导出。所有记录和数据库均为合成测试数据，Android 产品源码保持只读。

1. Android 创建一个项目、两个凭据组、三个密码。元数据包含超出 JavaScript 安全整数范围的 `9007199254740993`；项目首条记录含受保护的附加字段。
2. 扩展使用真实编辑器辅助函数修改第一组的共享账号、清空 OTP、改组名、追加第三个密码，并复制为具有独立项目标识的另一个项目。写出八条记录的加密 ZIP。
3. Android 导入独立 MDBX，验证内外项目标识、凭据组、密码顺序、元数据和保护标志，再修改原项目的第一组及新增密码，保留复制项目。
4. 扩展重新读取 Android 导出，逐字段比较并再次保存、重开。最终返回样本另经真实 Edge 的 420/320px 编辑器展示、取消和浏览器重启检查。

这些是 Android 应用保存/恢复路径与扩展编辑器辅助函数的往返证据。Edge 使用运行时导入设置已校验的返回样本；不把它描述为完整的 Android 屏幕操作或浏览器 ZIP 导入界面验收。

## 复现

在扩展仓库中设置：

```powershell
$env:MONICA_APP_INTEROP_TEST_SET='project-credentials'
$env:MONICA_315_APP_FIXTURE='C:/Users/joyins/Desktop/Monica-all/monica-extension/.tmp/android-project-order-317'
$env:MONICA_MDBX2_INTEROP_SERIAL='emulator-5554'
$env:JAVA_HOME='C:/jdk-17.0.1'
node scripts/interop-315-android-app.mjs build
node scripts/interop-315-android-app.mjs install-test
node scripts/interop-315-android-app.mjs project-credentials-export
$env:MONICA_PROJECT_CREDENTIAL_STAGE='forward'
npx vitest run --config vitest.android-project-credentials.config.ts
node scripts/interop-315-android-app.mjs project-credentials-import
$env:MONICA_PROJECT_CREDENTIAL_STAGE='return'
npx vitest run --config vitest.android-project-credentials.config.ts
node scripts/interop-315-edge.mjs --project-credentials-return
```

每次应用调用记录源码状态、应用 APK、测试 APK、测试源码、设备启动标识和输入输出 SHA-256。前后两段必须使用同一应用和测试 APK，全部不变性检查通过才能接受结果。应用脚本保留带时间戳的结果；失败记录不得覆盖为通过。

## 证据

- 工作目录：`.tmp/android-project-credentials-317/`。
- 构建日志：`.codex-tasks/android-interop-315/raw/project-credentials-317-build-2.log`，10 分 22 秒通过。首轮失败是继承的测试遗漏 `PasswordEntry` 必填参数，已修正；原始失败日志 `project-credentials-317-build.log` 保留。
- 四段结果：`project-credentials-export-evidence.json`、`project-credentials-forward-codec-evidence.json`、`project-credentials-import-evidence.json`、`project-credentials-return-codec-evidence.json` 均为 `passed`。Android 两项实际应用测试分别用时 8.495 秒、11.823 秒。
- 实际 Edge `154.0.4258.53`：`.tmp/interop-315-edge/run-VJjD9p/evidence.json`。两个项目的 420/320px 编辑器、取消、浏览器重启后的八条记录以及普通锁定／弹窗／侧栏检查通过。已查看 `android-project-edited-320.png` 和 `android-project-copy-420.png`，无横向溢出；Native Messaging 临时注册已恢复，控制台错误为空。
- 扩展相关回归：四个测试文件、22 项测试通过，`raw/project-credentials-317-regression.log`。
- 互通 TypeScript 检查及两个 Edge 脚本语法检查通过，`raw/project-credentials-317-types.log`。
- 历史全量 194 个文件／1833 项测试属于接管前的产品基线，不能代替本页实际应用往返。

实际应用 APK SHA-256：`66480a8bef56a8b44cff018fb60df45d5b445cb8904b4bed153bf63d3437e2c6`。
测试 APK SHA-256：`ddf5a2ff70464fc7643e6e07a75b564c12ff9ab010d833bb333d02fd777b4309`。
Android checkout revision：`63bb37b4f92f958d59a3a3aa5225a4ad20eb05d2`，工作区含既有改动；差异哈希 `bb46c76ff6d7df9a3690cd256865a5f329e9ee1d07ed6577cc219dddd52d7ca9`。构建及设备测试期间源码、应用、测试源码与设备启动标识检查全部通过，运行测试 APK 与本次构建哈希一致。此处记录的是实际安装版本及工作区来源，不把带既有改动的工作区称作干净提交。

总互通任务仍有全类型、其他后端、失败矩阵和页面验收未完成；本页仅记录凭据组这一条链。

本轮启动的公共 AVD 已停止，配置和数据盘保留；测试浏览器已关闭，临时 Native Messaging 注册已恢复。
