import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

test("generator preferences persist across remounts and reloads", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("generator-preferences-profile"), { channel: "chromium", headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "generator preferences e2e password" }))).toMatchObject({ ok: true });
    await page.reload();

    await page.getByRole("button", { name: "生成器" }).click();
    await page.getByLabel("大写字母", { exact: true }).uncheck();
    await page.getByLabel("小写字母", { exact: true }).uncheck();
    await page.getByLabel("符号", { exact: true }).uncheck();
    await page.getByLabel("数字最少数量").fill("20");
    await page.getByRole("button", { name: "重新生成", exact: true }).first().click();
    await expect(page.locator(".generator-result output")).toHaveText(/^\d{20}$/);

    await page.getByRole("tab", { name: "PIN" }).click();
    await page.getByLabel("PIN 长度").fill("9");
    await page.getByRole("button", { name: "重新生成", exact: true }).last().click();
    await expect(page.locator(".generator-result output")).toHaveText(/^\d{9}$/);

    await page.getByRole("tab", { name: "单词" }).click();
    await page.getByLabel("附加数字", { exact: true }).uncheck();
    await page.getByLabel("首字母大写", { exact: true }).check();
    await page.getByLabel("自定义分隔符").fill("-");
    await page.getByRole("button", { name: "重新生成", exact: true }).last().click();
    await expect(page.locator(".generator-result output")).toHaveText(/^[A-Za-z-]+$/);

    await page.getByRole("button", { name: "登录项" }).click();
    await page.getByRole("button", { name: "生成器" }).click();
    await page.getByRole("tab", { name: "密码" }).click();
    await expect(page.getByLabel("大写字母", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("数字最少数量")).toHaveValue("20");
    await page.getByRole("button", { name: "重新生成", exact: true }).first().click();
    await expect(page.locator(".generator-result output")).toHaveText(/^\d{20}$/);

    await page.reload();
    await page.getByRole("button", { name: "生成器" }).click();
    await page.getByRole("tab", { name: "密码" }).click();
    await expect(page.getByLabel("大写字母", { exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: "重新生成", exact: true }).first().click();
    await expect(page.locator(".generator-result output")).toHaveText(/^\d{20}$/);
    await page.getByRole("tab", { name: "PIN" }).click();
    await expect(page.getByLabel("PIN 长度")).toHaveValue("9");
    await page.getByRole("tab", { name: "单词" }).click();
    await expect(page.getByLabel("附加数字", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("首字母大写", { exact: true })).toBeChecked();
    await expect(page.getByLabel("自定义分隔符")).toHaveValue("-");
    await page.getByRole("button", { name: "重新生成", exact: true }).last().click();
    await expect(page.locator(".generator-result output")).toHaveText(/^[A-Za-z-]+$/);

    await page.getByRole("tab", { name: "SSH 密钥" }).click();
    await page.getByRole("button", { name: "重新生成", exact: true }).last().click();
    await expect(page.getByLabel("公钥内容")).toHaveValue(/^ssh-ed25519 /);
    await expect(page.locator(".generator-ssh-facts code")).toHaveText(/^SHA256:[A-Za-z0-9+/]{43}$/);
    await page.getByRole("button", { name: "显示私钥" }).click();
    await expect(page.getByLabel("私钥内容")).toHaveValue(/-----BEGIN OPENSSH PRIVATE KEY-----/);
    await page.getByLabel("SSH 算法").selectOption("RSA");
    await page.getByLabel("RSA 位数").selectOption("2048");
    await page.getByRole("button", { name: "重新生成", exact: true }).last().click();
    await expect(page.getByLabel("公钥内容")).toHaveValue(/^ssh-rsa /);

    await page.reload();
    await page.getByRole("button", { name: "生成器" }).click();
    await expect(page.getByRole("tab", { name: "SSH 密钥" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("SSH 算法")).toHaveValue("RSA");
    await expect(page.getByLabel("RSA 位数")).toHaveValue("2048");
    await expect(page.getByLabel("公钥内容")).toHaveValue(/^ssh-rsa /);

    const accessibility = await new AxeBuilder({ page }).include(".generator-panel").analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("generator-preferences-mobile.png"), fullPage: true });
  } finally { await context?.close(); }
});
