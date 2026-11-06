# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## 构建标识（build identity）

由源码与公共资源内容哈希派生出的发布身份值，随任何源码变更立即失效；必须在提交前一并刷新，否则构建过程会把它的存储文件写脏，导致受信发布被拒。

它标识的是「这套源码的这一个状态」，不是版本号——版本号描述发布批次，构建标识描述内容本身，两者必须各自保持同步。

## 受信发布（trusted release）

从干净的已提交工作树生成、可被独立复验的正式产物包。

允许脏工作树的本地开发包不是受信发布，不能当作干净源码的发布证明；「工作树是否干净」是受信发布的准入条件而非可选检查。
