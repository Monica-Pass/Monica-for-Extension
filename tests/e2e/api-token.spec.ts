import { dialogContent, dialogSurface } from "./fixtures/material";
import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

async function start(testInfo: TestInfo) {
  const extension = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), { channel: "chromium", headless: true, locale: "zh-CN", colorScheme: "dark", viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "Synthetic API editor master password" }))).toMatchObject({ ok: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible();
  return { context, page };
}

async function openApiEditor(page: Page) {
  await page.getByRole("button", { name: "选择新建类型", exact: true }).click();
  const menu = page.getByRole("menu", { name: "选择新建类型", exact: true });
  await menu.getByRole("menuitem", { name: "API 密钥", exact: true }).click();
  await expect(page.getByRole("heading", { name: "添加 API 密钥", exact: true })).toBeVisible();
  await expect(menu).toBeHidden();
}

test("API keys can be created, edited and unlocked without becoming searchable login secrets", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const started = await start(testInfo); context = started.context; const page = started.page;
    await expect(page.getByRole("navigation").getByRole("button", { name: "概览", exact: true })).toHaveCount(0);
    await openApiEditor(page);
    await page.getByLabel("名称 *", { exact: true }).fill("Workspace API");
    await page.getByLabel("服务商 *", { exact: true }).fill("github");
    await page.getByLabel("API 密钥 *", { exact: true }).fill("synthetic-browser-api-token");
    await expect(page.getByLabel("API 密钥 *", { exact: true })).toHaveAttribute("type", "password");
    await page.getByLabel("API 地址（可选）").fill("https://api.github.com/");
    await page.locator(".material-editor-dialog [slot=\"header\"]").filter({ hasText: "自定义字段" }).click();
    await page.getByRole("button", { name: "添加字段", exact: true }).click();
    await page.getByLabel("自定义字段 1 名称", { exact: true }).fill("scope");
    await page.getByLabel("自定义字段 1 值", { exact: true }).fill("synthetic-hidden-scope");
    await expect(page.getByLabel("自定义字段 1 值", { exact: true })).toHaveAttribute("type", "password");
    await page.getByLabel("备注", { exact: true }).fill("Build automation");
    await page.getByLabel("收藏并优先显示").check();
    await page.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(dialogContent(page)).toHaveCount(0);
    await expect(page.getByText("Workspace API", { exact: true })).toBeVisible();
    await expect(page.getByText("synthetic-browser-api-token", { exact: true })).toHaveCount(0);
    await page.getByLabel("搜索密码库").fill("synthetic-browser-api-token");
    await expect(page.getByText("Workspace API", { exact: true })).toHaveCount(0);
    await page.getByLabel("搜索密码库").fill("");
    await page.getByRole("button", { name: "编辑API 密钥", exact: true }).click();
    await expect(page.getByLabel("API 密钥 *", { exact: true })).toHaveValue("synthetic-browser-api-token");
    await expect(page.getByLabel("自定义字段 1 值", { exact: true })).toHaveValue("synthetic-hidden-scope");
    await page.getByLabel("名称 *", { exact: true }).fill("Workspace API Updated");
    await page.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(dialogContent(page)).toHaveCount(0);
    await page.getByRole("button", { name: "立即锁定", exact: true }).click();
    await page.getByLabel("主密码", { exact: true }).fill("Synthetic API editor master password");
    await page.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(page.getByText("Workspace API Updated", { exact: true })).toBeVisible();
    const result = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
    expect(result).toMatchObject({ ok: true, data: [{ kind: "api-token", provider: "github", token: "synthetic-browser-api-token", favorite: true, notes: "Build automation", customFields: [{ name: "scope", protected: true }] }] });
  } finally { await context?.close(); }
});

test("new editors stay usable at 320px with enlarged text and respect reduced motion", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const started = await start(testInfo); context = started.context; const page = started.page;
    await openApiEditor(page);
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 320, height: 820 });
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      const dialog = dialogContent(page);
      expect(await dialogSurface(dialog).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const save = page.getByRole("button", { name: "加密保存", exact: true });
      await expect(save).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`api-${colorScheme}-320-200.png`), animations: "disabled" });
    }
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialogContent(page)).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApiEditor(page);
    expect(await dialogSurface(dialogContent(page)).evaluate(node => getComputedStyle(node).transitionDuration)).toBe("0s");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialogContent(page)).toHaveCount(0);
  } finally { await context?.close(); }
});

test("finishing an opening animation never moves focus away from the field being edited", async ({}, testInfo) => {
  const { context, page } = await start(testInfo);
  try {
    await page.addStyleTag({ content: ".dialog-enter-active { transition-duration: 600ms !important; }" });
    await openApiEditor(page);
    const provider = page.getByLabel("服务商 *", { exact: true });
    await provider.fill("github");
    await expect(page.locator(".dialog-enter-active")).toHaveCount(0);
    await expect(provider).toBeFocused();
    await page.keyboard.type("-work");
    await expect(provider).toHaveValue("github-work");
    await expect(page.getByLabel("名称 *", { exact: true })).toHaveValue("");
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }));
    await expect(dialogContent(page)).toHaveCount(0);
    await expect(page.getByLabel("主密码", { exact: true })).toBeVisible();
  } finally { await context.close(); }
});
