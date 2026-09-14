import { chooseOption, dialogContent } from "./fixtures/material";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { homeBackup, homePassword } from "./fixtures/vault-home";

test("vault opens directly into the list and retains source, favorite and type filters", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const extension = path.resolve("dist");
    context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), { channel: "chromium", headless: true, locale: "zh-CN", args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const backup = await homeBackup();
    const restore = await page.evaluate(async ({ backup, password }) => chrome.runtime.sendMessage({ type: "VAULT_RESTORE_ENCRYPTED", backup, backupPassword: password }), { backup, password: homePassword });
    expect(restore).toMatchObject({ ok: true });
    await page.reload();
    await expect(page.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible();
    await expect(page.getByText("Everyday Visa", { exact: true })).toBeVisible();
    const browse = page.getByRole("group", { name: "快捷筛选", exact: true });
    await chooseOption(browse.getByRole("combobox", { name: "当前数据库", exact: true }), "work-db");
    await expect(page.getByText("GitHub · Monica Studio", { exact: true })).toBeVisible();
    await expect(page.getByText("Proton Mail", { exact: true })).toHaveCount(0);
    await chooseOption(browse.getByRole("combobox", { name: "当前数据库", exact: true }), "local");
    await browse.getByRole("button", { name: "收藏", exact: true }).click();
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    const filters = dialogContent(page, { name: "筛选密码库" });
    await expect(filters.getByRole("group", { name: "密码源", exact: true }).getByRole("button", { name: "Monica 本地库", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(filters.getByRole("button", { name: "收藏", exact: true })).toHaveAttribute("aria-pressed", "true");
    await chooseOption(filters.getByRole("combobox", { name: "项目类型", exact: true }), "card");
    await filters.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.locator(".item-card")).toHaveCount(1);
    await expect(page.getByText("Everyday Visa", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await filters.getByRole("button", { name: "清除筛选", exact: true }).click();
    await filters.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.getByText("Proton Mail", { exact: true })).toBeVisible();
    await expect(browse.getByRole("combobox", { name: "当前数据库", exact: true })).toHaveJSProperty("value", "all");
    await expect(browse.getByRole("button", { name: "收藏", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(page.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible();
    await expect(page.getByText("Previous workspace", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Retired account", { exact: true })).toHaveCount(0);
  } finally { await context?.close(); }
});
