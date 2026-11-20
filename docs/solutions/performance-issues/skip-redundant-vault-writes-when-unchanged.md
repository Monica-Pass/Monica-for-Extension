---
title: "扩展 reload 后零改动写盘：locked-autofill 缓存与同步失败路径的安全去噪"
date: 2026-11-20
category: performance-issues
module: security
problem_type: performance_issue
component: service_layer
symptoms:
  - "浏览器 reload 扩展后重新解锁，无任何用户改动也产生 IndexedDB 写入：locked-autofill 缓存库每次解锁被整体重写，并生成全新 AES key 与 IV"
  - "自动同步失败时整库 persist 反复发生（attempts、lastError、诊断追加并把 updatedAt 推进为当前时间），断网退避下持续写盘"
  - "诊断环形缓冲（100 条上限）被完全相同的失败记录快速刷穿，有效审计信息被挤出"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [background-sync]
tags: [locked-autofill, vault-writes, write-amplification, sync-failure, dedupe, envelope-digest, idempotent-write, security-equivalence, indexeddb, developer-experience]
---

# 扩展 reload 后零改动写盘：locked-autofill 缓存与同步失败路径的安全去噪

## Problem

开发者在浏览器里 reload 扩展（MV3 service worker 冷启动）后重新解锁 vault，即使没有任何用户改动也会触发持久化写入，造成写放大与多余磁盘/远端 diff。修复分两处：locked-autofill 缓存的"内容未变则跳写"（`src/security/locked-autofill.ts`），与自动同步失败路径的去噪（`src/security/secure-vault-service.ts`、`src/background/provider-sync-runtime.ts`）。改动记录于未发布 changelog（`docs/releases/Monica-Extension-next-changelog.md`），分支 `fix/skip-unchanged-vault-writes`（截至本文写作未合入 upstream）。

## Symptoms

- 每次解锁无条件重写 `monica-extension-locked-autofill` IndexedDB 库：即使授权条目、快照内容与 vault envelope 都没变，也生成新 AES key + 新 IV 整写一遍
- 同步失败的零改动写盘：`markProviderSyncFailure` 对空队列源也 persist 整库；`upsertProvider` 重复写入相同的 `lastError`；相同诊断反复追加并推进 `updatedAt`
- 断网场景下自动同步按退避节奏（新任务 `dueAt = now + 500` 起步，`src/background/automatic-sync.ts:43`）反复失败，上述写入随之循环发生
- 单测中用写计数 storage 观测：重复相同失败下写计数持续增长

## What Didn't Work

- **假设"unlock 重写整个主 envelope"**——不成立。v2 且 KDF 达标的库解锁只写 `chrome.storage.session`，不写 vault storage；真正的无条件写是 locked-autofill 缓存（`secure-vault-service.ts:265` 调用 `refreshLockedAutofill`，定义于 `secure-vault-service.ts:4059`）与同步失败路径。先定位"哪些写在零改动时发生"再动手，是本次的关键一步。
- **提议在 `LockedAutofillRecord` 里存明文快照哈希做廉价比较**——否决。为同一条记录里已持有 key 的攻击者新增可离线猜测的字段，纯扩大攻击面；改用解密后比较（decrypt-and-compare），不新增任何记录字段。
- **提议"授权 id 集合相同即跳写"**——不充分。快照包含密码、URI 规则、屏蔽策略（`lockedAutofillSnapshot` 投影），id 不变而内容变的调用会漏写；比较必须覆盖完整快照内容。
- **提议"纯诊断写入不推进 state.updatedAt"**——否决。检索确认没有生产代码把 `VaultState.updatedAt` 当水位或显示值；省写的正确形态是"整条跳过 persist"，单独压 updatedAt 无收益，反而制造"head 恒等但状态变了"的微妙分析面。
- **提议 `import.meta.env.DEV` 门控自动同步**——否决。该问题的复现工作流加载的是 `npm run build` 产物（DEV 恒为 false），门控对真实场景无效；本机已有持久开关 `monica.sync.preferences.v1`（`src/providers/sync-preferences.ts:1`）。

## Solution

- **locked-autofill 跳写**（`src/security/locked-autofill.ts`）：`prepare()` 先读现有记录。授权为空时，记录已为 null 直接返回、非 null 才 `write(null)` 删除（`locked-autofill.ts:86`）；授权非空时，仅当现有记录 `envelopeDigest` 与当前摘要一致、且 `matchesSnapshot`（`locked-autofill.ts:112`）用记录内 key 解密出的明文与新投影序列化字节级相等才跳写（`locked-autofill.ts:95`）；任何不匹配、解密或解析异常都落入原重写路径（新 key + 新 IV），顺带自愈损坏记录。
- **同步失败去噪**：`markProviderSyncFailure` 在该源队列为空时直接 return，不 persist（`secure-vault-service.ts:3916`）；队列非空时 attempts 递增与 `min(5, ...)` 封顶逐次持久化的语义不变（`secure-vault-service.ts:3917`）。`recordProviderDiagnostic` 与诊断缓冲尾条按 (providerRef, operation, outcome, code, message) 全等时整条跳过（`secure-vault-service.ts:1595`）。失败处理里 `latest.lastError` 与新错误相同则跳过 `upsertProvider`（`src/background/provider-sync-runtime.ts:178`）。

## Why This Works

**locked-autofill 的安全等价性**（本学习最值得留存的推理）：

1. 该缓存声明的安全属性是"envelope 摘要绑定 + 独立不可导出设备 key"，围栏在 `read()` 的摘要校验：摘要不匹配即 fail-closed 返回 null（`locked-autofill.ts:69`）。"每次解锁换新 key"不是声明的属性——key 与密文存放在同一条 IndexedDB 记录里，能读旧密文就能读旧 key，轮换不提供额外保密性。
2. 跳写不加密任何新内容，不存在 GCM 同 key 同 IV 加密**不同**明文的重用风险；保留旧密文与重写一份相同明文的新密文安全等价。
3. 解锁路径不写 vault storage，因此解锁时刻摘要必然未变，跳写不会延长旧密文的可用窗口；任何真实写（KDF 升级、records 迁移、编辑、同步采纳）都改变 envelope → 摘要变化 → 跳写条件天然不成立，persist 路径的 `refreshLockedAutofill` 调用（`secure-vault-service.ts:4111`、`:4121`）不会误跳。
4. 字节级比较的键序依赖成立：存储侧是 `JSON.stringify(快照)` 的原始字符串（从未被 parse 重建），比较侧是同一确定性投影函数新构造对象的 stringify，两侧构造路径相同。
5. 比较用解密后明文而非新增持久字段，记录结构零变化。

**同步侧的"语义必需"清单**（这些写不许去噪）：

- 队列非空时的 attempts：调度器以 `outcome.morePending` 继续排程（`src/background/automatic-sync.ts:11`、`:129`），队列路由经 `readProviderSyncSchedule` 投影携带 `lastError`（`secure-vault-service.ts:666-669`）；MDBX2 撤销删除守卫依赖 `attempts > 0`（`secure-vault-service.ts:2759`）；UI 展示 `maxAttempts`（`src/background/provider-command-runtime.ts:85`）。
- 回执三阶段（prepared/attempted/committed）屏障、成功诊断与同步投影同事务提交、`unchanged` 空结果不采纳为空远端库——全部未动。
- `lastError` 相同跳写对"跨写入者等值"同样正确：判断依据是"要写入的值已在库里"，与谁上次写的无关。

## Prevention

- 动 vault 写路径前列两张清单：①哪些写在**零用户改动**时也会发生；②每个被写字段的真实读取方是谁。两张清单齐了才能判定哪些写可跳、哪些是语义必需。本次正是靠清单一找到了真根因（缓存与失败路径，而非 unlock 本身），靠清单二否决了压 updatedAt 的提议。
- 跳写判据要比较"将要持久化的形态"（redact 后对 redact 后、stringify 对 stringify），不要为省一次解密而在记录里新增可离线猜测的比较字段。
- 负向测试集模板（见 `src/security/locked-autofill.test.ts` 的 "prepare write policy" 组）：id 相同内容不同必重写；缓存损坏必重写（自愈而非跳写）；摘要不匹配必重写；空缓存+空授权零写；撤销授权仍写 null 删除；跳写后锁定态 `read` 仍能解出。
- 遗留已知项：v1 records 迁移失败循环（`migrationDeferred` 每次解锁重置，持续失败时每次解锁重试全量迁移重写）是单次写放大最大的一项，但它是存量库升入 v2 增量写的唯一通道，不能简单压制；如需处置属独立设计决策。
- 模式先例互链：[refresh-build-id-json-after-source-changes](../build-errors/refresh-build-id-json-after-source-changes.md)——同属"内容未变则不写持久化产物"家族，那边是构建期 tracked 派生文件的条件写回，这边是运行时 vault 持久化；本批修复提交时同步刷新 `src/runtime/build-id.json`，正是该文档 Prevention 规则的执行实例。
