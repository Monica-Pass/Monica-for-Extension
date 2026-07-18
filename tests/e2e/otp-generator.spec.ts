import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

test("OTP transfer and credential generator work in the M3E manager", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("otp-generator-profile"), { channel: "chromium", headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "otp generator e2e password" }))).toMatchObject({ ok: true });
    await page.reload();

    await page.getByRole("button", { name: "生成器" }).click();
    const firstPassword = await page.locator(".generator-result output").textContent();
    await page.getByRole("button", { name: "重新生成", exact: true }).first().click();
    await expect.poll(() => page.locator(".generator-result output").textContent()).not.toBe(firstPassword);
    await page.getByRole("tab", { name: "PIN" }).click();
    await page.getByLabel("PIN 长度").fill("8");
    await page.getByRole("button", { name: "重新生成", exact: true }).last().click();
    await expect(page.locator(".generator-result output")).toHaveText(/^\d{8}$/);

    await page.getByRole("button", { name: /^动态验证码/ }).click();
    await page.getByRole("button", { name: "添加验证码" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("名称 *").fill("HOTP E2E");
    await dialog.getByLabel("OTP URI").fill("otpauth://hotp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example&counter=7&digits=8");
    await dialog.getByRole("button", { name: "解析 URI" }).click();
    await expect(dialog.getByLabel("验证码类型")).toHaveValue("HOTP");
    await expect(dialog.getByLabel("计数器")).toHaveValue("7");
    await dialog.getByRole("button", { name: "生成二维码" }).click();
    await expect(dialog.getByAltText("当前验证器的 OTP 二维码")).toBeVisible();
    await dialog.getByRole("button", { name: "加密保存" }).click();
    await expect(page.getByText("HOTP E2E", { exact: true })).toBeVisible();

    const accessibility = await new AxeBuilder({ page }).include("main").analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.querySelector(".sidebar")?.getBoundingClientRect().right || 0)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("otp-manager-mobile.png"), fullPage: true });
  } finally { await context?.close(); }
});
