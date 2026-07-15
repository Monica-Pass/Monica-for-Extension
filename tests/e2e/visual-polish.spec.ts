import { chromium, expect, test, type BrowserContext, type Locator } from "@playwright/test";
import path from "node:path";

test("auth card omits the decorative avatar", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("auth-polish-profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    await expect(page.locator(".login-card h1")).toHaveText("创建加密密码库");
    await expect(page.locator(".avatar-icon")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("auth-card.png"), fullPage: true });
  } finally { await context?.close(); }
});

test("provider page is compact and decorated icon glyphs are centered", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("provider-polish-profile"), { channel: "chromium", headless: true, viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "visual polish master password" }))).toMatchObject({ ok: true });
    await page.reload();

    await page.getByRole("button", { name: "密码源" }).click();
    await expect(page.locator(".provider-connect-grid .connect-source")).toHaveCount(2);
    await expect(page.locator(".provider-config-card")).toHaveCount(0);
    await expect(page.locator(".provider-list .source-card")).toHaveCount(1);
    expect((await page.locator(".provider-list .source-card").first().boundingBox())!.width).toBeLessThanOrEqual(400);
    await expectCentered(page.locator(".source-icon").first(), page.locator(".source-icon m3e-icon").first());
    await expectCentered(page.locator(".connect-icon").first(), page.locator(".connect-icon m3e-icon").first());

    await page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).click();
    await expect(page.getByRole("dialog", { name: "连接 Monica Android WebDAV" })).toBeVisible();
    await expect(page.getByLabel("WebDAV 地址 *")).toBeVisible();
    await page.getByRole("button", { name: "关闭 WebDAV 设置" }).click();
    await expect(page.getByRole("dialog", { name: "连接 Monica Android WebDAV" })).toHaveCount(0);

    await page.getByRole("button", { name: "概览" }).click();
    await expectCentered(page.locator(".feature-icon"), page.locator(".feature-icon m3e-icon"));
    await page.getByRole("button", { name: "密码源" }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath("provider-page.png"), fullPage: true });
  } finally { await context?.close(); }
});

async function expectCentered(container: Locator, glyph: Locator): Promise<void> {
  const [outer, inner] = await Promise.all([container.boundingBox(), glyph.boundingBox()]);
  expect(outer).not.toBeNull();
  expect(inner).not.toBeNull();
  const outerCenter = { x: outer!.x + outer!.width / 2, y: outer!.y + outer!.height / 2 };
  const innerCenter = { x: inner!.x + inner!.width / 2, y: inner!.y + inner!.height / 2 };
  expect(Math.abs(outerCenter.x - innerCenter.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(outerCenter.y - innerCenter.y)).toBeLessThanOrEqual(1);
}
