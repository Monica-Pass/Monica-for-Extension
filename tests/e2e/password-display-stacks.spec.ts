import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { launchEdgeContext } from "./fixtures/edge";
import { chooseOption } from "./fixtures/material";

async function send(page: Page, message: Record<string, unknown>) {
  const result = await page.evaluate(value => chrome.runtime.sendMessage(value), message);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

test("real Edge password display stacks preserve projects, save covers and preferences, and reject popup mutations", async ({}, info) => {
  test.setTimeout(150_000);
  const profile = info.outputPath("stacks");
  const options = { locale: "zh-CN", viewport: { width: 1180, height: 960 }, args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] };
  let context = await launchEdgeContext(profile, options);
  const errors: string[] = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const root = `chrome-extension://${new URL(worker.url()).host}/`;
    let manager = await context.newPage();
    manager.on("pageerror", error => errors.push(error.message));
    await manager.goto(`${root}index.html`);
    await send(manager, { type: "VAULT_SETUP", masterPassword: "synthetic stack password" });
    const base = { kind: "login", username: "fixture@example.test", password: "synthetic-secret", uris: ["https://example.test/login"], notes: "private fixture note", favorite: false,
      createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z", providerRefs: [], customFields: [] };
    const rows = [{ ...base, id: "personal-one", title: "个人账号", passwordGroupId: "personal", sortOrder: 0, isGroupCover: true },
      { ...base, id: "personal-two", title: "个人账号", passwordGroupId: "personal", sortOrder: 1, password: "synthetic-other-password" },
      { ...base, id: "work", title: "工作账号", username: "work@example.test" },
      { ...base, id: "subdomain", title: "另一网站", uris: ["https://accounts.example.test"] }];
    await send(manager, { type: "VAULT_IMPORT_ITEMS", items: rows });
    await manager.reload();
    await manager.locator('.nav-item').filter({ hasText: "登录项" }).click();
    await expect(manager.locator('.credential-table tbody tr')).toHaveCount(3);
    await chooseOption(manager.getByRole("combobox", { name: "显示分组", exact: true }), "website");
    const stacks = manager.locator('[data-password-stacks] details');
    const websiteStack = stacks.filter({ has: manager.locator('summary strong').filter({ hasText: /^example\.test$/ }) });
    await expect(stacks).toHaveCount(2);
    await websiteStack.locator('summary').click();
    await expect(websiteStack.locator('[data-stack-project]')).toHaveCount(2);
    await expect(websiteStack).toContainText("2 个项目 · 3 条密码");
    const before = await send(manager, { type: "VAULT_LIST_ITEMS" });
    await manager.getByRole("button", { name: "将 工作账号 设为封面", exact: true }).click();
    await expect(manager.getByRole("button", { name: "取消 工作账号 的封面", exact: true })).toBeVisible();
    let after = await send(manager, { type: "VAULT_LIST_ITEMS" });
    expect(after.find((item: any) => item.id === "work").isGroupCover).toBe(true);
    expect(after.find((item: any) => item.id === "personal-one").isGroupCover).toBe(false);
    for (const original of before) {
      const current = after.find((item: any) => item.id === original.id);
      expect({ ...current, updatedAt: original.updatedAt, isGroupCover: original.isGroupCover }).toEqual({ ...original, isGroupCover: original.isGroupCover });
    }
    await manager.locator('[data-stack-project="personal-one"] m3e-list-action').click();
    await expect(manager.locator('[data-project-navigation]')).toBeVisible();
    await expect(manager.locator('[data-project-navigation] [data-password-member-id]')).toHaveCount(2);
    await manager.getByRole("button", { name: "关闭详情", exact: true }).click();
    await chooseOption(manager.getByRole("combobox", { name: "网站匹配", exact: true }), "relaxed");
    await expect(stacks).toHaveCount(1);
    await chooseOption(manager.getByRole("combobox", { name: "网站匹配", exact: true }), "strict");
    await expect(stacks).toHaveCount(2);
    await manager.getByRole('searchbox').fill('work@example.test');
    await expect(stacks).toHaveCount(1);
    await expect(stacks.first().locator('[data-stack-project]')).toHaveCount(1);
    await manager.getByRole('searchbox').fill('');
    await expect(stacks).toHaveCount(2);
    if (await websiteStack.getAttribute('open') === null) await websiteStack.locator('summary').click();
    await manager.screenshot({ path: info.outputPath('stacks-wide.png'), fullPage: true });
    for (const width of [420, 320]) {
      await manager.setViewportSize({ width, height: 960 });
      await expect(manager.getByRole("button", { name: "取消 工作账号 的封面", exact: true })).toBeVisible();
      await manager.getByRole("button", { name: "取消 工作账号 的封面", exact: true }).click();
      await manager.getByRole("button", { name: "将 工作账号 设为封面", exact: true }).click();
      await expect(manager.getByRole("button", { name: "取消 工作账号 的封面", exact: true })).toBeVisible();
      expect(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Capture a complete narrow page without full-page screenshots relocating sticky controls.
      await manager.setViewportSize({ width, height: 1280 });
      await manager.locator('.page-heading h1').click();
      await manager.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => manager.evaluate(() => scrollY)).toBe(0);
      await manager.screenshot({ path: info.outputPath(`stacks-${width}.png`), fullPage: true });
    }
    after = await send(manager, { type: "VAULT_LIST_ITEMS" });
    const popup = await context.newPage();
    await popup.goto(`${root}popup.html`);
    expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SET_PASSWORD_COVER", anchorItemId: "work", enabled: false, expected: {} }))).toMatchObject({ ok: false });
    await popup.close();
    await context.close();
    context = await launchEdgeContext(profile, options);
    manager = await context.newPage();
    manager.on("pageerror", error => errors.push(error.message));
    await manager.goto(`${root}index.html`);
    await send(manager, { type: "VAULT_UNLOCK", masterPassword: "synthetic stack password" });
    await manager.reload();
    await manager.locator('.nav-item').filter({ hasText: "登录项" }).click();
    await expect(manager.getByRole("combobox", { name: "显示分组", exact: true })).toHaveJSProperty("value", "website");
    const reopened = await send(manager, { type: "VAULT_LIST_ITEMS" });
    expect(reopened).toEqual(after);
    expect(await send(manager, { type: "VAULT_HOME_GET" })).toMatchObject({ passwordStackMode: "website", passwordWebsiteMatch: "strict" });
    await info.attach("acceptance", { body: JSON.stringify({ browser: context.browser()?.version(), widths: [1180, 420, 320], itemCount: after.length, checks: ["real-extension", "project-preservation", "cover-selection", "strict-relaxed-display", "search", "popup-denial", "encrypted-restart"] }), contentType: "application/json" });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
