# Android 1.0.317 密码项目公共字段与排序

扩展已补齐公共字段保存和凭据排序。这里记录具体通过的验证；全功能互通仍未完成。

## 修改

- 修改一个凭据的项目名称、备注、网站、联系方式、地址、银行卡资料、关联应用、图标或关联笔记时，显式变化同步到项目内各凭据组。未编辑的不同值保持原样；冲突在写入前被拒绝。
- 追加密码使用相同公共字段清单，包含原先遗漏的图标与关联笔记。新增记录分配新标识，不复制其他密码的远端身份、历史或附件。
- 组内密码支持键盘排序。主凭据组保留在前，附加凭据组参与笔记、银行卡和密钥内容的统一排序，支持拖动与键盘。
- 排序只修改顺序元数据，保留密码标识、原始数值、字段保护标志和内容归属。各行保存项目排序；从另一条密码进入项目时也保持位置。取消整个编辑不写入。

设计使用本地 [M3E Canvas](http://127.0.0.1:5186/)。可编辑草图链接在 [project-operations-317.md](design/project-operations-317.md)，源文件为 `docs/design/android-interop-315.m3e.json`。删除确认页仍是后续设计，不代表删除功能已实现。

## 验证

- 全量：194 文件、1840 测试通过，`raw/project-common-order-full-final.log`。
- 最终生产构建通过，`raw/project-final-build.log`；互通类型检查 `raw/project-order-check-final.log` 通过。
- 实际 Edge 154.0.4258.53：`.tmp/interop-315-edge/run-4bj4Hz/evidence.json` 验证图标继承与排序；最终加入可见的排序错误提示后，编辑器验收 `.tmp/interop-315-edge/run-dDfbeq/evidence.json` 再次通过。覆盖 1280/420/320px、取消与浏览器重启；排序和附加凭据组 320px 渲染已检查；临时 Native Messaging 注册恢复，控制台错误为空。
- 图标/笔记继承缺陷先由 `raw/project-new-common-fields-red.log` 复现，修复后 25 项相关回归通过，`raw/project-common-order-regression.log`。Edge 检查新密码保留原项目 Emoji 图标。关联笔记的新增继承在本轮是存储模型回归证据，不扩充为实际 Android 链接验收。

## Android 实际应用链

历史八行链 `.tmp/android-project-credentials-317` 已通过，详情见 [project-credentials-317-interop.md](project-credentials-317-interop.md)。它不代替本轮新增字段与排序验证。

富字段链 `.tmp/android-project-common-fields-317` 的应用导出、扩展修改和 Android 回导已运行；最终验收因 Android checkout 在构建与导入之间改变而拒绝。失败日志与指纹保留，未放宽验收。

新链 `.tmp/android-project-order-317` 已通过：两项目、三凭据组、十条记录，同时验证公共字段、密码排序、内容排序、新增与复制。前两轮构建任务自身成功，但源码/安装包在构建期间被另一个 Android 任务修改，来源检查拒绝；第三轮在稳定基线下构建与来源检查均通过（5分39秒）。原始失败保留。

实际普通版 `1.0.317-26100412-18`，APK SHA-256 `353e6154981d593c58ff8306449192a189a7428b8fb81d451a02945a7b9680d0`；专用测试 APK SHA-256 `71c971eba8ee96fc0f3f47dfc4c7ab320555632db383e7a3b8c51be9fa5110a5`。构建、安装、导出、导入阶段的源码/安装包/测试源/设备启动检查通过；源码 revision `63bb37b4f92f958d59a3a3aa5225a4ad20eb05d2`，含既有改动，diff SHA-256 `0505006cada84878c8d02e069d73e1bd8847a90fbf5b1cfc4a15fe155c2ec756`。

Android 回传 ZIP SHA-256 `5ffcc8e6bb600cfb144a78de4d3edc4aa932deb7b8b20fc6a9f8641bdc05f265`。最终扩展检查逐字段比较所有十条记录：保留 CRLF/TAB/汉字/空白、显式空邮箱、银行卡前导零及 CVV、地址、关联应用和网站；Android 只修改原项目的第一组，复制项目不变。最终 Edge `.tmp/interop-315-edge/run-tPegHT/evidence.json` 验证这份精确返回数据：两项目、三个凭据组、十条密码，420/320px 编辑器、取消、浏览器重启通过；截图已检查，注册恢复、控制台错误为空。

## 后续

本轮启动的公共 AVD 在确认其他 Android 任务已结束、无 instrumentation 后停止；保留配置与数据盘。测试浏览器退出，临时 Native Messaging 注册恢复。

凭据删除与单条转换仍需完整成员快照、原子墓碑和删除内容拥有者时的安全转移。其他密码内容、Bitwarden 分组、KeePass 行为、可用 Passkey 私钥以及全部后端/失败路径仍有独立待办，不声称完全对齐。
