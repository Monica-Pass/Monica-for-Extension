# 密码项目：单条保存与分组详情

本轮补齐单条项目的完整成员检查，以及当前 Android 凭据组在浏览器中的详情导航与计数。整体 Android 对齐任务仍未完成，凭据移除和共享附件转移仍是独立待办。

## 保存与删除边界

- 本地、MDBX、Monica WebDAV、Bitwarden 的显式项目，即使只有一条密码，也走完整项目保存接口。项目 ID、凭据 ID、密码 ID、未知大整数和字段保护属性保持原样。
- 编辑期间同步进来的新成员会使旧草稿保存失败。完整修订快照中曾有的成员即使已经被另外拆分，也不能在保存时默默遗漏。
- 存储失败不会改变加密库或同步队列。单条项目删除使用完整快照，确认期间增加成员则拒绝旧确认；普通未分组记录继续使用原有删除流程。
- KeePass 的分组写入仍须完成实际 Android 新库导入验证。这里没有放宽该后端的限制，也没有实现部分成员删除。

## 界面

- 详情按凭据组名称和密码顺序展示导航。同一组多条密码共用用户名时，仍可用“密码 1 / 2 / 3”准确选择原记录。
- 显示凭据组数与密码条数，列表不再将密码条数写成账号数。活动项目侧栏按项目计数。
- 当前行有选中色、勾选图标及 `aria-current`；导航不显示密码。键盘切换后保留焦点，原有详情重建机制仍会收起已显示的秘密。
- 凭据导航限制高度并支持滚动，组标题保持可见；320px 下保留 48px 以上点击目标。记录原始内容、各行附件归属、未知字段和保护标志不重写。
- 无法完整解释的旧版、混合、未来或冲突元数据，保留按原始密码记录切换的入口，不根据用户名或标题推断分组。

本地 [可编辑 M3E Canvas 草图](design/project-detail-317.md) 的 `credentialdetail317` 已渲染检查。设计记录保存在 `docs/design/android-interop-315.m3e.json`，不依赖浏览器缓存。

## 验证

单条项目最初 8 项回归全部失败，原始日志 `raw/project-singleton-red.log` 保留。修复后的相关 43 项测试通过；新增单条删除边界后，最终全量 **197 文件 / 1864 测试通过**，日志 `raw/project-detail-full-final.log`。生产构建及两个 TypeScript 配置检查通过 `raw/project-detail-build-final.log`。

Edge 用例包含合成单条项目的保存、同步成员变更、过期草稿失败、取消、重开与保存；详情用例读取已验真的实际 Android `1.0.317-26100412-18` 返回 ZIP，SHA-256 `5ffcc8e6bb600cfb144a78de4d3edc4aa932deb7b8b20fc6a9f8641bdc05f265`。两项目共十条密码的每条导航、显示值、未知字段、取消和重启后数据均独立检查。该文件来自先前实际应用往返；本轮没有重新运行 Android 应用，也不扩大为 Android 屏幕操作验收。

最终 Edge **154.0.4258.53** 验收通过：`.tmp/interop-315-edge/run-5O6e5x/evidence.json`，日志 `raw/project-detail-edge-final.log`。十二条记录显示为三个项目；原 Android 两项目各显示五条密码。320/420px 截图已检查，十条实际返回记录与两条合成记录重启后保持一致，控制台错误为空，临时 Native Messaging 注册已恢复。未启动 AVD 或 Docker，测试浏览器已退出；本地 Canvas 继续复用。

重放命令：

```powershell
$env:MONICA_315_APP_FIXTURE = (Resolve-Path .tmp/android-project-order-317).Path
node scripts/interop-315-edge.mjs --project-singleton --project-credentials-return --project-detail
```

失败记录保留：前两次单条 UI 运行是测试按钮名称和读取投影预期错误；详情首轮使用原生 `button` 选择器，实际组件为带 button role 的自定义元素。随后真实复现焦点跳到关闭按钮，根因为 `out-in` 动画在 `nextTick` 后尚未创建新详情；已将焦点恢复放到现有 `after-enter` 生命周期。功能检查通过后另发现焦点环不能直接使用带冒号/斜杠的 Android ID，改用项目现有 DOM ID 编码，并增加控制台零错误断言。

部分成员移除、移除后共享内容/附件转移、全部后端故障恢复和归档/回收站项目计数仍待补齐，不能据本轮通过宣称完全互通。
