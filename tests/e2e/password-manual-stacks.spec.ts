import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import type { LoginItem } from "../../src/core/model";
import { launchEdgeContext } from "./fixtures/edge";
import { chooseOption } from "./fixtures/material";

const manual = "__monica_manual_stack_group", never = "__monica_no_stack";
async function send(page: Page, message: Record<string, unknown>) {
  const result = await page.evaluate(value => chrome.runtime.sendMessage(value), message);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}
const ordinary = (row: LoginItem) => ({ ...row, updatedAt: "ignored", customFields: row.customFields.filter(field => ![manual, never].includes(field.name)) });

test("real Edge manual stacks preserve whole projects, reject stale edits, and survive restart", async ({}, info) => {
  test.setTimeout(150_000);
  const profile = info.outputPath("manual-stacks");
  const options = { locale: "zh-CN", viewport: { width: 1180, height: 960 }, args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] };
  let context = await launchEdgeContext(profile, options);
  const errors: string[] = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const root = `chrome-extension://${new URL(worker.url()).host}/`;
    let manager = await context.newPage();
    manager.on("pageerror", error => errors.push(error.message));
    await manager.goto(`${root}index.html`);
    await send(manager, { type: "VAULT_SETUP", masterPassword: "synthetic manual stack password" });
    const base = { kind: "login", username: "fixture@example.test", password: "synthetic-secret", uris: ["https://example.test/login"], notes: "private fixture note", favorite: false,
      createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z", providerRefs: [], customFields: [{ name: "ordinary", value: "retained", protected: true }] };
    await send(manager, { type: "VAULT_IMPORT_ITEMS", items: [
      { ...base, id: "personal-one", title: "个人账号", passwordGroupId: "personal", sortOrder: 0 },
      { ...base, id: "personal-two", title: "个人账号", passwordGroupId: "personal", sortOrder: 1, password: "second-secret" },
      { ...base, id: "work", title: "工作账号", username: "work@example.test" },
      { ...base, id: "invalid", title: "受保护项目", customFields: [{ name: manual, value: "protected marker", protected: true }] },
    ] });
    await manager.reload();
    await manager.locator('.nav-item').filter({ hasText: "登录项" }).click();
    const before: LoginItem[] = await send(manager, { type: "VAULT_LIST_ITEMS" });
    const dialog = () => manager.locator('.manual-stack-dialog');
    const open = async () => { await manager.getByRole("button", { name: "管理堆叠", exact: true }).click(); await expect(dialog()).toBeVisible(); };
    const select = async (id: string) => { await dialog().locator(`[data-stack-choice="${id}"] input`).check(); };
    const apply = async (count: number) => { await dialog().getByRole("button", { name: `应用到 ${count} 个项目`, exact: true }).click(); await expect(dialog()).toHaveCount(0); };
    await open();
    await expect(dialog().locator('[data-stack-choice]')).toHaveCount(3);
    await expect(dialog().locator('[data-stack-choice="invalid"] input')).toBeDisabled();
    await select("personal-one");
    await expect(dialog().getByRole("button", { name: "应用到 1 个项目", exact: true })).toBeDisabled();
    await dialog().getByRole("searchbox").fill("work@example.test");
    await select("work");
    await expect(dialog()).toContainText("已选择 2 个项目");
    await dialog().getByRole("searchbox").fill("");
    await expect(dialog().locator('[data-stack-choice="personal-one"] input')).toBeChecked();
    await dialog().getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog()).toHaveCount(0);
    expect(await send(manager, { type: "VAULT_LIST_ITEMS" })).toEqual(before);
    await open();
    await select("personal-one");
    await manager.keyboard.press("Escape");
    await expect(dialog()).toHaveCount(0);
    expect(await send(manager, { type: "VAULT_LIST_ITEMS" })).toEqual(before);
    await open();
    await select("personal-one"); await select("work");
    await manager.screenshot({ path: info.outputPath("manual-dialog-wide.png"), fullPage: true });
    await apply(2);
    await expect(manager.getByRole("combobox", { name: "显示分组", exact: true })).toHaveJSProperty("value", "manual");
    let after: LoginItem[] = await send(manager, { type: "VAULT_LIST_ITEMS" });
    const grouped = after.filter(row => row.id !== "invalid");
    const ids = grouped.map(row => row.customFields.find(field => field.name === manual)?.value);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(1);
    expect(grouped.map(ordinary)).toEqual(before.filter(row => row.id !== "invalid").map(ordinary));
    expect(after.find(row => row.id === "invalid")).toEqual(before.find(row => row.id === "invalid"));
    const stacks = () => manager.locator('[data-password-stacks] details');
    await expect(stacks()).toHaveCount(2);
    await expect(stacks().filter({ hasText: "2 个项目 · 3 条密码" })).toContainText("手动堆叠");
    for (const width of [420, 320]) {
      await manager.setViewportSize({ width, height: 960 });
      await open();
      await chooseOption(dialog().getByRole("combobox", { name: "堆叠操作", exact: true }), "never");
      await select("personal-one");
      await manager.screenshot({ path: info.outputPath(`manual-dialog-${width}.png`), fullPage: true });
      expect(await dialog().locator('dialog').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && node.scrollWidth <= node.clientWidth; })).toBe(true);
      await apply(1);
      after = await send(manager, { type: "VAULT_LIST_ITEMS" });
      expect(after.filter(row => row.passwordGroupId === "personal").every(row => row.customFields.some(field => field.name === never && field.value === "1") && !row.customFields.some(field => field.name === manual))).toBe(true);
      await expect(stacks()).toHaveCount(3);
      await open();
      await chooseOption(dialog().getByRole("combobox", { name: "堆叠操作", exact: true }), "auto");
      await select("personal-one"); await select("work");
      await apply(2);
      after = await send(manager, { type: "VAULT_LIST_ITEMS" });
      expect(after.filter(row => row.id !== "invalid").map(row => row.customFields)).toEqual(before.filter(row => row.id !== "invalid").map(row => row.customFields));
      await open(); await select("personal-one"); await select("work"); await apply(2);
      await expect(stacks()).toHaveCount(2);
      expect(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await manager.screenshot({ path: info.outputPath(`manual-result-${width}.png`), fullPage: true });
    }
    // A second manager changes a member after the dialog captured its snapshot.
    await open();
    await chooseOption(dialog().getByRole("combobox", { name: "堆叠操作", exact: true }), "never");
    await select("personal-one");
    const peer = await context.newPage(); await peer.goto(`${root}index.html`);
    after = await send(peer, { type: "VAULT_LIST_ITEMS" });
    await send(peer, { type: "VAULT_SET_PASSWORD_STACK", anchorItemIds: ["personal-one"], action: "auto", expected: Object.fromEntries(after.filter(row => row.passwordGroupId === "personal").map(row => [row.id, row.updatedAt])) });
    const concurrent = await send(peer, { type: "VAULT_LIST_ITEMS" });
    await peer.close();
    await dialog().getByRole("button", { name: "应用到 1 个项目", exact: true }).click();
    await expect(dialog().getByRole("alert")).toHaveText("项目成员或内容已变化，请重新打开堆叠设置。");
    expect(await send(manager, { type: "VAULT_LIST_ITEMS" })).toEqual(concurrent);
    await dialog().getByRole("button", { name: "取消", exact: true }).click();
    // Refresh and establish a manual stack for the encrypted browser-restart check.
    await manager.setViewportSize({ width: 1180, height: 960 });
    await manager.reload();
    await manager.locator('.nav-item').filter({ hasText: "登录项" }).click();
    await open(); await select("personal-one"); await select("work"); await apply(2);
    after = await send(manager, { type: "VAULT_LIST_ITEMS" });
    const popup = await context.newPage(); await popup.goto(`${root}popup.html`);
    const expected = Object.fromEntries(after.filter(row => row.passwordGroupId === "personal").map(row => [row.id, row.updatedAt]));
    expect(await popup.evaluate(expected => chrome.runtime.sendMessage({ type: "VAULT_SET_PASSWORD_STACK", anchorItemIds: ["personal-one"], action: "never", expected }), expected)).toMatchObject({ ok: false });
    await popup.close();
    expect(await send(manager, { type: "VAULT_LIST_ITEMS" })).toEqual(after);
    await context.close();
    context = await launchEdgeContext(profile, options);
    manager = await context.newPage(); manager.on("pageerror", error => errors.push(error.message));
    await manager.goto(`${root}index.html`);
    await send(manager, { type: "VAULT_UNLOCK", masterPassword: "synthetic manual stack password" });
    await manager.reload(); await manager.locator('.nav-item').filter({ hasText: "登录项" }).click();
    expect(await send(manager, { type: "VAULT_LIST_ITEMS" })).toEqual(after);
    await expect(stacks()).toHaveCount(2);
    await expect(manager.getByRole("combobox", { name: "显示分组", exact: true })).toHaveJSProperty("value", "manual");
    await info.attach("acceptance", { body: JSON.stringify({ browser: context.browser()?.version(), widths: [1180, 420, 320], itemCount: after.length, checks: ["real-extension", "whole-projects", "search-selection", "cancel-escape-no-write", "protected-marker-disabled", "manual-never-auto", "stale-snapshot-no-write", "popup-denied", "encrypted-restart"] }), contentType: "application/json" });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
