# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## 构建标识（build identity）

由源码与公共资源内容哈希派生出的发布身份值，随任何源码变更立即失效；必须在提交前一并刷新，否则构建过程会把它的存储文件写脏，导致受信发布被拒。

它标识的是「这套源码的这一个状态」，不是版本号——版本号描述发布批次，构建标识描述内容本身，两者必须各自保持同步。

## 受信发布（trusted release）

从干净的已提交工作树生成、可被独立复验的正式产物包。

允许脏工作树的本地开发包不是受信发布，不能当作干净源码的发布证明；「工作树是否干净」是受信发布的准入条件而非可选检查。

## 内置浏览器引擎（bundled browser engine）

随扩展一起打包的 WASM 存储引擎，由钉死版本的 Rust 与 Emscripten 工具链从第一方源码构建，构建输入包含与宿主共享的源码。其构建记录绑定源码清单与工具链指纹：任何源码变更都使既有引擎产物过期，必须用钉死工具链重建后才能构建扩展。

它与构建标识同属「源码变更 → 派生产物必须刷新」家族，区别在刷新动作：构建标识是重算哈希，引擎是完整重建；两者的校验都按 fail-closed 设计，报错即环境或流程缺步骤，不应绕过。

## 锁定自动填充缓存（locked-autofill cache）

用户逐项授权后、允许在密码库锁定状态下用于自动填充的登录项子集的设备本地加密副本。

它由独立的不可导出设备密钥加密，与主库解锁凭据无关，也不能用来解锁主库。整份副本绑定创建它时的完整密码库信封摘要：主库发生任何写入后摘要即变，旧副本随之失效——读取时摘要不匹配按失败处理，不返回内容，直到下次解锁按最新状态重建。授权集合与库内容都未变化时，解锁重建会跳过重写、沿用既有副本；跳过不改变上述任何性质，因为每次解锁更换缓存密钥从来不是它的安全属性，信封摘要绑定才是。
