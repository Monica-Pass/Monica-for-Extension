---
title: '修改 mdbx2-host 源码后 npm run build 报 "Browser engine artifact is stale"——用 pinned 工具链重建引擎'
date: 2026-11-07
category: build-errors
module: release-tooling
problem_type: build_error
component: tooling
symptoms:
  - "npm run build 在 build-workers 阶段抛 Error: Browser engine artifact is stale; rebuild from the current sources.（scripts/verify-mdbx2-browser.mjs:11）"
  - "原样重跑 npm run build 在同一位置再次失败，报错不变"
  - "重建时报 spawnSync rustc ENOENT——Git Bash 会话的 PATH 不含 ~/.cargo/bin"
  - "重建时报 Load the Emscripten 4.0.18 environment before building MDBX.，或引擎编译错 cannot find function 'gate' in module 'crate::backup_scratch'"
root_cause: missing_tooling
resolution_type: environment_setup
severity: medium
related_components: [mdbx2-host, mdbx2-browser]
tags: [mdbx2-browser, wasm, emscripten, rust-toolchain, engine-rebuild, provenance, build-error]
---

# 修改 mdbx2-host 源码后 npm run build 报 "Browser engine artifact is stale" 失败

## Problem

在 `native/mdbx2-host/src` 下修改 Rust 代码（普通 bug 修复，未触及引擎接口）后，`npm run build` 在 build-workers 步骤失败，报 `Error: Browser engine artifact is stale; rebuild from the current sources.`（`scripts/verify-mdbx2-browser.mjs:11`）。直接重跑构建没有用——该校验每次都会用当前源码重新计算清单并与引擎包内记录的清单比对，只要源码变过就永远不通过。

## Symptoms

- `npm run build` 在 build-workers 阶段（许可证/校验环节）抛出：`Error: Browser engine artifact is stale; rebuild from the current sources.`
- 原样重跑 `npm run build`，同一位置再次失败，报错不变。
- 若本机缺少 pinned 工具链，重建过程中还会依次暴露其他报错（详见 What Didn't Work）：
  - `spawnSync rustc ENOENT`（Git Bash 环境的 `PATH` 不含 `~/.cargo/bin`）
  - `Error: Load the Emscripten 4.0.18 environment before building MDBX.`（`scripts/build-mdbx2-browser.mjs:20`）
  - 引擎编译失败：`cannot find function 'gate' in module 'crate::backup_scratch'`

## What Didn't Work

- **直接重跑 `npm run build`**：`scripts/verify-mdbx2-browser.mjs` 每次都用 `browserSourceInventory()` 现算当前源码清单，与 `native/mdbx2-browser/pkg/BROWSER-BUILD.json` 里记录的 `record.sources` 逐项比较。源码已变，清单必然不同，重跑多少次都一样。
- **以为"构建失败 = 代码问题"去排查业务代码**：宿主 Rust 改动本身是正确的，失败根源是两件事叠加——引擎产物确实因源码变更而过期（设计如此），加上本机缺少 pinned 的 Rust/Emscripten 工具链导致无法重建。
- **想绕过或放宽校验**：修改校验脚本、复用旧产物都是错误方向。仓库纪律（AGENTS.md）明确要求"不要用占位 WASM、旧产物或跳过校验绕过环境缺失"，正确做法是按发布流程重建引擎。
- **安装 `wasm32-unknown-unknown` target**：走错了目标平台。浏览器引擎的编译目标是 `wasm32-unknown-emscripten`（Emscripten 链接），不是纯 WASM target，装错了不解决问题。
- **忽略 `spawnSync rustc ENOENT`**：第一次后台构建即因 `PATH` 缺少 `~/.cargo/bin` 而失败；后续发现全量构建 build-workers 里的许可证步骤（`browserDependencyNotices`，内部 spawn `cargo +1.97.0 metadata`）是同一 PATH 卡点的第二处。只修一处不够，必须整个构建会话前置 cargo bin 路径。

## Solution

在仓库根目录（Git Bash）按顺序执行以下步骤重建引擎包，然后正常构建。官方说明见 `docs/RELEASE.md` 环境一节。

**1. 安装并验证 pinned Rust 1.97.0**（`rustup` 会自动下载该版本）：

```bash
rustup toolchain install 1.97.0
# 验证 commit-hash 以 2d8144b78 开头（对应 rustc 1.97.0 的官方 commit）
"C:/Users/wuyiy/.cargo/bin/rustc.exe" +1.97.0 -vV
```

**2. 安装 emsdk 4.0.18**：

```bash
git clone --depth 1 https://github.com/emscripten-core/emsdk.git
./emsdk install 4.0.18
./emsdk activate 4.0.18
```

**3. 在 Git Bash 会话里把 cargo bin 前置到 `PATH`**（否则 `rustc`/`cargo` 都找不到）：

```bash
export PATH="/c/Users/wuyiy/.cargo/bin:$PATH"
```

**4. 加载 Emscripten 环境并预取 Rust 依赖**（预取不限制目标平台，确保离线构建可用）：

```bash
source <emsdk路径>/emsdk_env.sh
cargo +1.97.0 fetch --locked --manifest-path native/mdbx2-browser/Cargo.toml
```

**5. 重建浏览器引擎包**：

```bash
npm run build:mdbx2-browser
```

该脚本内部执行 `cargo +1.97.0 build --target wasm32-unknown-emscripten` 并用 emcc 链接，产出约 6.5MB 的 WASM 及配套 `engine.js`。

**6. 重新执行全量构建**：

```bash
npm run build
```

这次构建会复用第 5 步的产物并全量校验。通过标志是日志中出现：

```text
Bundled MDBX source inventory, toolchain and artifacts verified.
Verified 4 extension pages: ...
```

如果第 5 步报 `cannot find function 'gate' in module 'crate::backup_scratch'`，见下方 Why This Works 的 stub 镜像机制：宿主 `backup_scratch` 中新增的 `pub(crate)` 符号必须同步镜像到 `native/mdbx2-browser/src/backup_scratch.rs` 的最小 stub 里（本例中 `gate` 已用 `/tmp` 占位文件实现 no-op 语义补齐，worker 本就独占串行，无需真实跨进程锁）。

## Why This Works

这不是故障，而是刻意的供应链 provenance 设计在正常工作，关键有三层：

**1. 源码清单覆盖宿主目录。** `scripts/verify-mdbx2-browser.mjs` 把 `BROWSER-BUILD.json` 里记录的 `record.sources` 与 `scripts/mdbx2-browser-provenance.mjs` 的 `browserSourceInventory()` 现算结果做全等比较。后者覆盖 `native/mdbx2-browser` 全部文件，**并且包含 `native/mdbx2-host/src` 全部文件**和 `native/mdbx2-host/ENGINE-PROVENANCE.json`（见该脚本第 19-23 行）。所以任何宿主 Rust 改动——哪怕与引擎毫无接口关系——都会让引擎包清单失配，校验按设计报 stale。

**2. 宿主源码确实被引擎编译。** 这不是过度的保守校验：`native/mdbx2-browser/src/main.rs` 通过 `#[path = "../../mdbx2-host/src/cloud_sync.rs"]`（以及 `runtime.rs`、`local_export.rs`、`windows_hello.rs`）直接把宿主源文件引入 browser crate 编译。宿主代码变了，引擎 WASM 的输入就真的变了，必须重新编译才可信。代价是 browser crate 对共享源码里每个被引用的 `pub(crate)` 符号都要能编译，而它用的是刻意最小化的 stub（`native/mdbx2-browser/src/backup_scratch.rs`：单 worker 环境无跨进程文件锁，`scavenge` 是 no-op）——宿主侧新增符号时 stub 必须镜像，否则编译报 `cannot find function ... in module 'crate::backup_scratch'`。

**3. 工具链被钉死保证可复现。** `BROWSER-BUILD.json` 同时记录 `record.rustCommit === '2d8144b7880597b6e6d3dfd63a9a9efae3f533d3'`（即 rustc 1.97.0；本机默认的 1.97.1 commit 是 `8bab26f4…`，不匹配）与 `record.emscripten === '4.0.18'`（`scripts/verify-mdbx2-browser.mjs:10`）。`scripts/build-mdbx2-browser.mjs` 在 emcc 版本不符时直接抛 `Load the Emscripten 4.0.18 environment before building MDBX.`。用错误工具链编出来的产物即使源码一致也无法通过校验，因此装对 pinned 版本是重建的前提，而不是可选优化。

## Prevention

- **建立正确预期**：任何 `native/mdbx2-host/src` 变更之后，`npm run build` 必然先报 stale——这是 provenance 校验在干活，不是代码出错。正确响应是重建引擎，而不是怀疑自己的修改或试图绕过校验。
- **本机常备 pinned 工具链**：rustup 的 1.97.0 和 emsdk 的 4.0.18 装好后保留（不要清理），每次构建会话开始时前置 cargo bin 路径：
  ```bash
  export PATH="/c/Users/wuyiy/.cargo/bin:$PATH"
  ```
- **新增宿主 `pub(crate)` 符号时检查 stub 镜像**：browser crate 的 `src/` 下只有 `main.rs`、`nearby.rs`、`backup_scratch.rs` 三个文件；凡是经 `#[path = "../../mdbx2-host/src/..."]` 共享引入的源码引用了新符号，就要在对应 stub（如 `native/mdbx2-browser/src/backup_scratch.rs`）里补一个语义等价的 no-op 版本，让 engine 构建能编译。真实锁语义在宿主侧保留，stub 侧用注释说明为何 no-op 是安全的（worker 独占串行）。
- **构建前快速自检链**，按顺序执行，任何一步失败先修环境再继续：
  ```bash
  emcc -dumpversion          # 必须输出 4.0.18
  rustc +1.97.0 -vV          # commit-hash 以 2d8144b78 开头
  npm run build:mdbx2-browser
  npm run build              # 通过标志见 Solution 第 6 步
  ```
- **不要混淆另一套"源码变更后产物过期"机制**：`src/runtime/build-id.json` 每次构建都会按源码内容哈希重新生成，属于构建标识机制，与本问题的引擎 provenance 校验无关；仓库已有文档 `docs/solutions/build-errors/refresh-build-id-json-after-source-changes.md` 专门说明前者。

## Related Issues

- [源码变更后忘记刷新 build-id.json 导致 CI 受信打包拒绝](refresh-build-id-json-after-source-changes.md)——同属"源码变更导致派生产物过期"家族，但作用对象（构建标识 vs 引擎 WASM）和刷新机制（重算哈希 vs 完整重建）不同。
- 引擎重建的官方环境要求与离线预取说明：`docs/RELEASE.md`（环境一节）。
- 为什么必须钉死 rustc 1.97.0 + `wasm32-unknown-emscripten`：`docs/mdbx-browser-engine-feasibility-319.md`（旧版 rustc 的 Emscripten 预编译标准库与 SDK ABI 不兼容的根因记录）。
- provenance 校验机制与可复现构建说明：`docs/mdbx-browser-durable-engine-319.md`。
- `npm run build` 校验触发点与 CI pinned 源码构建步骤：`docs/mdbx-browser-application-320.md`。
