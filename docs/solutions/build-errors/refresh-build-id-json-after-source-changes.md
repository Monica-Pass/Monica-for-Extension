---
title: 源码变更后忘记刷新 build-id.json 导致 CI 受信打包拒绝
date: 2026-11-06
category: build-errors
module: release-tooling
problem_type: build_error
component: development_workflow
symptoms:
  - validate job 在 npm run release:check 后段失败，抛 "Refusing to create a trusted release from a dirty tracked worktree."（scripts/package-release.mjs:28）；mdbx2-host-windows job 不运行 release:check，其失败点是 npm run package:mdbx2-host 抛出的另一条拒绝（scripts/package-mdbx2-host.mjs:17）
  - 本地任意源码改动后执行 npm run build，git status --porcelain 即出现 " M src/runtime/build-id.json"，diff 只有一行 buildId
  - 失败发生在 release:check 后段（约第 11 步），此前约 20 分钟的 lint、测试与构建全部白跑
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: medium
tags: [build-id, build-identity, dirty-worktree, release-check, tracked-derived-file, ci-packaging]
---

# 源码变更后忘记刷新 build-id.json 导致 CI 受信打包拒绝

## Problem

对 Monica 扩展的任何源码改动（非升版的普通重构也一样）提交后，CI 在受信打包步骤失败：`validate` job 死在 `npm run release:check` 后段的 `package:release`（`.github/workflows/ci.yml:42`），`mdbx2-host-windows` job 死在自己的 `npm run package:mdbx2-host`（`.github/workflows/ci.yml:102`）——构建过程重写了 tracked 文件 `src/runtime/build-id.json` 使工作树变脏，两个受信打包脚本按 fail-closed 策略拒绝继续。

## Symptoms

- 错误信息为 `Refusing to create a trusted release from a dirty tracked worktree.`（`scripts/package-release.mjs:28`）；MDBX2 Host 侧是措辞不同的另一条拒绝 `Refusing to package MDBX2 Host from a dirty tracked worktree.`（`scripts/package-mdbx2-host.mjs:17`），由 `mdbx2-host-windows` job 的 `npm run package:mdbx2-host`（`.github/workflows/ci.yml:102`）触发——该 job 不运行 `release:check`
- 本地复现路径：源码改动后执行 `npm run build`，`git status --porcelain --untracked-files=no` 立即出现 ` M src/runtime/build-id.json`，diff 仅一行 buildId 变化
- CI 失败点在 `.github/workflows/ci.yml:42` 的 `npm run release:check`，位于 lint、单元测试、构建之后，代价是整轮管线时间

## What Didn't Work

- **误判为 fork 首次贡献的工作流审批门**：`gh api actions/runs?head_sha=<head>` 返回 0 次运行、检查面板为空，看似 GitHub 挂起了 fork 的 workflow。被证据推翻——同账号的 fork PR #27、#21 均已合并，11-03 的 `pull_request` 事件运行正常（该批运行的头 SHA 即 #27）。此诊断只解释了「零运行」，与脏树失败无关（零运行的真实原因是 PR 创建时 `pull_request` 事件丢失，close + reopen 重发事件后即愈）
- **误判为 CRLF / autocrlf 混入**：怀疑新文件 blob 混入 CR 行导致 Linux runner 上规范化差异。复验排除了该方向：基线文件（如 `src/core/model.ts`）的 blob 为纯 LF（CR 计数 0），且 `scripts/build-identity.mjs:28-31` 对文本文件做 CRLF→LF 归一化、`:37-41` 刻意保留结账行尾——行尾差异不可能让 CI 侧变脏
- **未定位写脏者就重推**：盲目重推或空提交重试只会再失败一次，浪费一轮 CI
- 一步定位的有效做法：本地按 CI 顺序复现——`npm run build` 后立即 `git status`，输出直接点名写脏的文件，无需猜

## Solution

```bash
node scripts/build-identity.mjs   # 刷新 src/runtime/build-id.json
git add src/runtime/build-id.json
git commit -m "chore: refresh build identity after <改动概述>"
```

推送后 CI 全绿。该修复以上游 PR #28 的附加提交形式进入 main（修复时点刷新的 buildId 为 `074a600042d705e05514`，该值随源码演进会变、不应视为长期不变；连跑两次脚本值不变，幂等已确认）。

## Why This Works

`src/runtime/build-id.json` 是 tracked 文件，但内容是派生的：`scripts/build-identity.mjs:17-24` 遍历 `src/` 与 `public/`（排除该文件自身和 `.test.`/`.spec.` 文件）外加 `package.json`、`package-lock.json`、`vite.config.ts`、`scripts/build-workers.mjs`，逐文件计算 SHA-256 并取前 20 位十六进制作为 buildId（`scripts/build-identity.mjs:25-34`）。源码一变，哈希就变。

`npm run build` 会执行该脚本，算出的值与文件不同就写回（`scripts/build-identity.mjs:40-42`）——CI 上正是这次写入把 tracked 工作树弄脏。随后 `scripts/package-release.mjs:27` 用 `git status --porcelain --untracked-files=no` 判定树是否干净，tracked 文件被改即抛错拒绝（`scripts/package-release.mjs:28`）。

提交刷新后的值就是稳定终态：哈希对文本文件做 CRLF→LF 归一化（行尾无关，`scripts/build-identity.mjs:28-31`）、不使用 git 元数据，所以 CI 重算必然得到同一个值，树保持干净。

## Prevention

- **规则**：任何 `src/` 或 `public/` 变更（纯重构、非升版也一样）提交前，运行 `node scripts/build-identity.mjs` 并一并提交；上游 main 上的 "chore: refresh build identity" 类提交即该惯例的体现
- **本地预检**：`git status --porcelain` 出现 ` M src/runtime/build-id.json` 即信号，补跑脚本后再提交
- **本地无法完整运行 release:check 时**（如 npm 版本超出 `engines.npm` 钉死范围被工具链闸门拒绝），至少执行 `npm run build` 后查一次 git status，可在进入 20 分钟 CI 之前发现
- **尚未闭环的机制缺口**（移除本文档前应先完成这些修复）：① 拒绝信息未点名最可能的原因，应提示运行 `node scripts/build-identity.mjs`；② 校验位于 release:check 后段，应前移为轻量的早期步骤；③ `AGENTS.md:71` 仅在「版本号必须同步」节提到 build-identity.mjs，普通源码变更场景无覆盖；`docs/RELEASE.md:11` 把干净工作树写成环境前提、`:29`/`:51` 将其作为发布证据，却未说明源码变更后靠刷新 build-id.json 满足它；`CONTRIBUTING.md` 则完全未提及 build-identity 与干净工作树

## Related Issues

- 上游 PR #28（已合并）的附加提交即本次修复
- 文档库首篇，无相关 learning 可交叉引用
