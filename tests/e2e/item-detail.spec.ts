import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

test("list rows open a masked M3E detail page for every item kind", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("item-detail-profile"), { channel: "chromium", headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "item detail e2e password" }))).toMatchObject({ ok: true });
    await page.reload();

    const now = new Date().toISOString();
    const common = { favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [] };
    const importPath = testInfo.outputPath("item-detail-import.json");
    await writeFile(importPath, JSON.stringify({ version: 1, items: [
      { ...common, id: "detail-login", kind: "login", title: "Detail Login", username: "joy", password: "detail-secret", uris: ["https://example.com"], uriRules: [{ uri: "https://example.com", matchType: "domain" }], customFields: [{ name: "Tenant", value: "acme", protected: false }] },
      { ...common, id: "detail-card", kind: "card", title: "Detail Card", cardholderName: "Joy Lin", number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", securityCode: "123", brand: "Visa", customFields: [{ name: "virtual", value: "true", fieldType: "BOOLEAN", protected: false }] },
      { ...common, id: "detail-identity", kind: "identity", title: "Detail Passport", documentType: "PASSPORT", documentNumber: "P99887766", fullName: "Joy Lin" },
      { ...common, id: "detail-note", kind: "secure-note", title: "Detail Note", content: "# Recovery steps", tags: ["工作", "恢复"], isMarkdown: true },
      { ...common, id: "detail-totp", kind: "totp", title: "Detail OTP", secret: "JBSWY3DPEHPK3PXP", issuer: "Example", accountName: "joy@example.com" }
    ] }), "utf8");
    await page.locator("button.nav-item").filter({ hasText: "设置与备份" }).click();
    await page.locator("label.file-action").filter({ hasText: "导入明文 JSON" }).locator('input[type="file"]').setInputFiles(importPath);
    await expect(page.getByText(/已加密导入 5 个密码库项目/)).toBeVisible();

    await page.locator("button.nav-item").filter({ hasText: "登录项" }).click();
    await page.locator("tr.row-clickable").filter({ hasText: "Detail Login" }).click();
    const detail = page.getByRole("dialog", { name: /Detail Login/ });
    await expect(detail).toBeVisible();
    await expect(detail.getByText("joy", { exact: true })).toBeVisible();
    await expect(page.getByText("detail-secret", { exact: true })).toHaveCount(0);
    await detail.getByRole("button", { name: "显示密码" }).click();
    await expect(detail.getByText("detail-secret", { exact: true })).toBeVisible();
    await expect(detail.getByText("Tenant", { exact: true })).toBeVisible();
    await expect(detail.getByText("example.com")).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    await detail.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByRole("dialog", { name: /编辑登录项/ })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /Detail Login/ })).toHaveCount(0);
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("dialog", { name: /编辑登录项/ })).toHaveCount(0);
    await page.getByRole("button", { name: "编辑登录项" }).click();
    await expect(page.getByRole("dialog", { name: /编辑登录项/ })).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("dialog", { name: /Detail Login/ })).toHaveCount(0);

    await page.locator("button.nav-item").filter({ hasText: "钱包与身份" }).click();
    await page.locator(".item-card").filter({ hasText: "Detail Card" }).click();
    const cardDetail = page.getByRole("dialog", { name: /Detail Card/ });
    await expect(cardDetail.getByText(/•••• 1111/)).toBeVisible();
    await expect(page.getByText("4111111111111111", { exact: true })).toHaveCount(0);
    await cardDetail.getByRole("button", { name: "显示卡号" }).click();
    await expect(cardDetail.getByText("4111111111111111", { exact: true })).toBeVisible();
    await cardDetail.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(cardDetail).toHaveCount(0);

    await page.locator("button.nav-item").filter({ hasText: "安全笔记" }).click();
    await page.locator(".item-card").filter({ hasText: "Detail Note" }).click();
    const noteDetail = page.getByRole("dialog", { name: /Detail Note/ });
    await expect(noteDetail.getByText("# Recovery steps")).toBeVisible();
    await expect(noteDetail.getByText("工作", { exact: true })).toBeVisible();
    await noteDetail.getByRole("button", { name: "关闭", exact: true }).click();

    await page.locator("button.nav-item").filter({ hasText: "动态验证码" }).click();
    await page.locator(".item-card").filter({ hasText: "Detail OTP" }).click();
    const otpDetail = page.getByRole("dialog", { name: /Detail OTP/ });
    await expect(page.getByText("JBSWY3DPEHPK3PXP", { exact: true })).toHaveCount(0);
    await otpDetail.getByRole("button", { name: "显示密钥" }).click();
    await expect(otpDetail.getByText("JBSWY3DPEHPK3PXP", { exact: true })).toBeVisible();
    await otpDetail.getByRole("button", { name: "关闭", exact: true }).click();

    await page.locator("button.nav-item").filter({ hasText: "登录项" }).click();
    
    await page.locator("tr.row-clickable").filter({ hasText: "Detail Login" }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole("dialog", { name: /Detail Login/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("item-detail-mobile.png"), fullPage: true });
  } finally { await context?.close(); }
});
