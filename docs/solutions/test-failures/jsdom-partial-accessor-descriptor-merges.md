---
title: 'jsdom 负向测试夹具静默失效：部分 accessor 描述符与原生 accessor 合并而非替换'
date: 2026-11-07
category: test-failures
module: content-scripts
problem_type: test_failure
component: testing_framework
symptoms:
  - "hostile 页面移除原生 value setter 后，fillWallet 仍返回 { ok: true, filledCount: 1 } 而非 { ok: false, filledCount: 0 }，input/change 事件照常派发"
  - "生产守卫逐行检查无漏洞：descriptor?.set 检查与 try/catch 都在，负向测试仍被整体绕过"
  - "打印覆盖后的 Object.getOwnPropertyDescriptor 发现 { get: hostileGetter, set: 原生 setter } 并存，而非预期的 setter 缺失"
root_cause: logic_error
resolution_type: test_fix
severity: low
related_components: [content-scripts]
tags: [jsdom, vitest, defineproperty, accessor-descriptor, test-fixture, hostile-page, negative-testing]
---

# jsdom 负向测试夹具静默失效：部分 accessor 描述符与原生 value setter 合并

## Problem

`src/content/wallet-dom.ts` 的 `setControlValue`（`src/content/wallet-dom.ts:208-230`）负责把钱包字段值写入表单控件并派发 `input`/`change` 事件。对照 `src/content/dom.ts` 中 `setNativeValue`（`src/content/dom.ts:187-202`）的既有防线，该函数补上了同样的守卫：先取原型上的 `value` property descriptor，`descriptor?.set` 缺失即拒绝，调用 setter 抛错也拒绝：

```ts
// src/content/wallet-dom.ts:224-226
const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
if (!descriptor?.set) return false;
try { descriptor.set.call(element, value); } catch { return false; }
```

守卫修复本身已完成且正确。本任务是为其补一条负向回归测试：模拟 hostile 页面破坏原生 `value` setter（移除 setter，或让 setter 抛错），断言 `fillWallet` 返回 `ok: false`、`filledCount: 0`，且不派发任何事件。测试初版失败——`fillWallet` 在 hostile 页面上照常成功返回 `{ ok: true, filledCount: 1 }`。生产代码守卫没有问题，问题出在测试夹具。

## Symptoms

- 期望 `fillWallet({ kind: "identity", fields: { fullName: "Hostile" } }, ...)` 返回 `{ ok: false, filledCount: 0 }` 且 `input`/`change` 事件计数为 0；实际返回 `{ ok: true, filledCount: 1 }`，事件照常派发——守卫被完全绕过。
- 逐行检查生产守卫找不出漏洞：`descriptor?.set` 检查在 dispatch 之前，`try/catch` 包住 setter 调用，两条失败路径都 `return false`。
- 在夹具里打印 `Object.getOwnPropertyDescriptor(prototype, "value")` 才看到异常现场：覆盖后的 descriptor 是 `{ get: hostileGetter, set: 原生 setter }`——hostile getter 与原生 setter 并存，而不是预期的"只剩 hostile getter、setter 缺失"。
- 现象在 vitest + jsdom 环境出现，页面 document/元素运行在独立的 vm context（realm）里，测试进程是另一个 realm，这使问题乍看像典型的跨 realm 怪象。

## What Didn't Work

- **怀疑生产守卫有洞**（optional chaining 之后仍然 dispatch、异常穿透、拒绝后照发事件等）：被探针实证排除。真正打开局面的是打印覆盖后的 descriptor——hostile get 与原生 set 并存，守卫看到的是"set 存在、调用成功"，按设计放行。守卫的行为完全符合它拿到的输入，要改的是喂给它的夹具。
- **想保留"部分描述符"形状复现真实语义**：初版夹具只写了要替换的那一半（如 getter-only 场景只写 `{ get: hostileGetter }`），期望原生 setter 随之消失。实测两条路都造不出"setter 被移除"的现场：在同 realm 的对象（纯对象、class accessor）上做部分覆盖，原生另一半照样存活；对 jsdom realm 的 `HTMLInputElement.prototype` 从测试进程做部分覆盖，同样合并。只要描述符不完整，原生 setter 就不会消失，守卫永远不会走到拒绝分支。测试之所以以失败（而不是静默误绿）暴露问题，恰恰是因为它断言的是拒绝行为——夹具失效直接体现为断言不通过。

## Solution

实际修法在 `src/content/wallet-dom.test.ts:109-125`：hostile 描述符写成**完整 accessor 两半**，两个场景各一个描述符，循环共用同一套断言：

```ts
// src/content/wallet-dom.test.ts:109-125
it("does not report success or throw when a hostile page breaks the native value setter", () => {
  // jsdom pages live in a separate vm realm: defineProperty on a cross-realm object
  // merges a partial accessor descriptor with the existing one instead of replacing it,
  // so both halves must be spelled out for the hostile override to take effect.
  for (const descriptor of [
    { configurable: true, get: () => "", set: undefined },
    { configurable: true, get: undefined, set: () => { throw new Error("hostile"); } }
  ]) {
    const dom = page('<form><input autocomplete="name"></form>');
    Object.defineProperty(dom.window.HTMLInputElement.prototype, "value", descriptor);
    let events = 0;
    dom.window.document.querySelector("input")!.addEventListener("input", () => { events += 1; });
    dom.window.document.querySelector("input")!.addEventListener("change", () => { events += 1; });
    expect(fillWallet({ kind: "identity", fields: { fullName: "Hostile" } }, dom.window.document)).toMatchObject({ ok: false, filledCount: 0 });
    expect(events).toBe(0);
  }
});
```

要点：

- getter-only 场景写 `{ get: hostileGetter, set: undefined }`；抛错 setter 场景写 `{ get: undefined, set: () => { throw new Error("hostile"); } }`。两半都显式写出，`Object.defineProperty` 才会把 accessor 整体替换成 hostile 形状，`getOwnPropertyDescriptor` 也才会如实报告 setter 缺失或抛错。
- 每轮循环用 `page(...)` 新建独立 JSDOM 实例（该夹具同时 stub 控件的 `getBoundingClientRect` 以通过可见性检查，见 `src/content/wallet-dom.test.ts:5-11`），两个场景各自作用于全新 realm 的原生原型，互不污染。
- 断言强度原样保留：`ok: false`、`filledCount: 0`、事件计数 0，一个都没放宽；并加注释说明描述符合并怪癖的原因。
- 探针验证闭环：修复后两个 hostile 场景的 descriptor 均如实反映（`set: undefined`，或 `set` 一调用即抛 `Error("hostile")`），守卫拒绝填写、事件为 0；`npx vitest run src/content/wallet-dom.test.ts` 24/24 通过。

## Why This Works

合并行为是 ECMAScript 规范（`ValidateAndApplyPropertyDescriptor`）规定的：对**已存在的 accessor 属性**应用**部分 accessor 描述符**时，描述符里缺省的那一半保留现值——即新描述符与现有 accessor "合并"，而不是整体替换。这与引擎、realm 都无关。用临时探针在 Node 24 + 仓库自带 jsdom（vitest 4 环境）上实测，三种形态行为完全一致：

| 覆盖目标 | 部分描述符 | 覆盖后 `getOwnPropertyDescriptor` 的观察 |
| --- | --- | --- |
| 同 realm class accessor（`A.prototype` 上的 get/set 对） | `{ get: hostile }` | `set` 存活（合并）；`a.v = 5` 仍调用原生 setter |
| 同 realm 纯对象 | `{ set: 抛错 }` | `get` 存活（合并）；赋值即抛错 |
| 跨 realm jsdom `HTMLInputElement.prototype`（从测试进程） | `{ get: hostile }` | `set` 存活（合并）；赋值经原生 setter 正常写入 |

这就是初版夹具失败的全过程：partial `{ get: hostileGetter }` 与原生 accessor 合并 → 守卫取到的 descriptor 是 `{ get: hostileGetter, set: 原生 setter }` → `descriptor?.set` 存在、调用成功 → 按设计放行并派发事件 → `fillWallet` 返回 `ok: true`。守卫在真实浏览器里正确、在这个夹具里"看似失效"，差异不在守卫，而在夹具交给它的 descriptor 形状。

修复后为什么有效：`{ get: hostileGetter, set: undefined }` 与 `{ get: undefined, set: throwing }` 是完整 accessor 描述符，两半都显式给出，defineProperty 按整体替换处理，`getOwnPropertyDescriptor` 如实报告 `set: undefined` 或抛错的 `set`——守卫的 `!descriptor?.set` 分支与 `try/catch` 分别命中，两个场景都走到 `return false`，事件为 0。这也与生产威胁模型一致：真实浏览器中的 hostile 页面要移除原生 setter，同样只能写完整描述符（`set: undefined`）或 `delete` 后重定义；部分描述符在任何引擎里都只是合并。jsdom 页面对象运行在独立 vm context 的"跨 realm"位置是排查时最自然的怀疑对象，但探针证明 realm 不是合并的原因——描述符的完整性才是；realm 边界另有一类真实差异（`instanceof`、函数身份、Error 类型跨 realm 失效），属于另一类坑，与本例无关。

## Prevention

- **模拟"accessor 一半被移除/被替换"时，一律写完整 accessor 两半**，哪怕目标是"只有一半"：`{ get: hostile, set: undefined }` 或 `{ get: undefined, set: hostile }`。部分 accessor 描述符按规范必然与现有 accessor 合并，原生一半会静默存活；也可以 `delete` 属性后 `defineProperty` 整体重造。这条规则与 realm 无关，同 realm、跨 realm 都适用。
- **对"防御性守卫"类负向测试，先探针后断言**：先加一条断言确认夹具真的改变了被测对象的可观察行为（例如先断言 `Object.getOwnPropertyDescriptor(prototype, "value")!.set === undefined`，或先证明对控件赋值确实抛错），再断言守卫的反应。否则夹具可能静默失效，测试永远测不到目标路径，还长期以"通过"状态提供虚假信心；本例中正是"打印覆盖后的 descriptor"这一步定位了根因。
- **守卫 / monkey-patch 类测试莫名通过或失败时，先打印 `getOwnPropertyDescriptor`，再归因**：一次探针即可区分"描述符合并 / 整体替换 / 描述符形状写错"，不要先改生产代码。jsdom 的 realm 边界（页面对象在独立 vm context）是这类测试真实存在的混淆源，值得保留在怀疑清单上，但结论要等探针确认，而不是凭"跨 realm"直觉直接下结论。

## Related Issues

- 实例来源：`src/content/wallet-dom.test.ts:109-125`（hostile-setter 负向用例及其注释）、被测守卫 `src/content/wallet-dom.ts:208-230`、同构参照 `src/content/dom.ts:187-202`。
- 仓库负向测试强制约定：`CONTRIBUTING.md`（修改权限/消息/密码库等须补对应负向测试）——本文的夹具写法是该要求在 hostile 页面场景的具体方法论。
- 威胁模型背景：`docs/SECURITY_ARCHITECTURE.md` 把 Web page/Main-world bridge 标为 Hostile page boundary，解释了为什么需要这类负向测试。
