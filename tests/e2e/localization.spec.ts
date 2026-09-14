import { chooseOption } from "./fixtures/material";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

const extensionPath = path.resolve("dist");

test("browser language initializes the UI, system appearance follows changes, and language sync preserves vault data", async ({}, testInfo) => {
  const context = await chromium.launchPersistentContext(testInfo.outputPath("language-profile"), {
    channel: "chromium", headless: true, locale: "en-US", colorScheme: "light",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    await expect(manager.getByRole("heading", { name: "Create encrypted vault" })).toBeVisible();
    await expect(manager.locator(".language-picker")).toHaveCount(0);
    await expect(manager.locator("html")).toHaveAttribute("lang", "en");
    await expect(manager.locator("html")).toHaveAttribute("data-palette", "monica");
    await expect(manager.locator("html")).toHaveAttribute("data-theme", "light");
    await manager.emulateMedia({ colorScheme: "dark" });
    await expect(manager.locator("html")).toHaveAttribute("data-theme", "dark");
    await manager.getByLabel("Master password", { exact: true }).fill("localized vault master password");
    await manager.getByLabel("Confirm master password", { exact: true }).fill("localized vault master password");
    await manager.getByRole("button", { name: "Create and unlock", exact: true }).click();
    await expect(manager.getByRole("heading", { name: "All items", exact: true })).toBeVisible();
    await expect(manager.locator(".language-picker")).toHaveCount(0);
    const now = new Date().toISOString();
    expect(await manager.evaluate((item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
      id: "localized-note", kind: "secure-note", title: "我的中文笔记", content: "不要翻译我的数据 <>&", notes: "原始备注",
      favorite: false, createdAt: now, updatedAt: now, providerRefs: [], customFields: []
    })).toMatchObject({ ok: true });
    await manager.reload();
    await manager.locator(".sidebar").getByRole("button", { name: /^Secure Note/ }).click();
    await expect(manager.getByText("我的中文笔记", { exact: true })).toBeVisible();

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator("html")).toHaveAttribute("lang", "en");
    await expect(popup.locator(".language-picker")).toHaveCount(0);
    await manager.getByRole("navigation").getByRole("button", { name: "Settings and backups", exact: true }).click();
    await expect(manager.locator(".sidebar").getByRole("combobox")).toHaveCount(0);
    await chooseOption(manager.locator(".settings-page").getByLabel("Interface language", { exact: true }), "zh-CN");
    await expect(popup.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(manager.locator(".settings-page").getByLabel("界面语言", { exact: true })).toHaveJSProperty("value", "zh-CN");
    await expect(popup.getByRole("button", { name: "管理密码库", exact: true })).toBeVisible();
    await chooseOption(manager.locator(".settings-page").getByLabel("界面语言", { exact: true }), "en");
    await expect(manager.locator("html")).toHaveAttribute("lang", "en");
    await expect(popup.locator("html")).toHaveAttribute("lang", "en");
    await expect(manager.locator(".settings-page").getByLabel("Interface language", { exact: true })).toHaveJSProperty("value", "en");
    await manager.getByRole("navigation").getByRole("button", { name: /^Secure Note/ }).click();
    await expect(manager.getByText("我的中文笔记", { exact: true })).toBeVisible();
    const vault = await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
    expect(vault).toMatchObject({ ok: true, data: [expect.objectContaining({ title: "我的中文笔记", content: "不要翻译我的数据 <>&", notes: "原始备注" })] });
    await manager.reload();
    await manager.getByRole("navigation").getByRole("button", { name: "Settings and backups", exact: true }).click();
    await expect(manager.locator(".settings-page").getByLabel("Interface language", { exact: true })).toHaveJSProperty("value", "en");
    expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
    await expect(manager.getByRole("heading", { name: "Unlock Monica", exact: true })).toBeVisible();
    await expect(manager.locator("html")).toHaveAttribute("lang", "en");
    await expect(manager.locator(".language-picker")).toHaveCount(0);
    await expect(popup.locator(".language-picker")).toHaveCount(0);
    await manager.screenshot({ path: testInfo.outputPath("unlock-settings-language.png"), animations: "disabled" });
  } finally { await context.close(); }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`English pages and controls fit a narrow window at 200% text in ${colorScheme} mode`, async ({}, testInfo) => {
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(testInfo.outputPath("english-layout-profile"), {
        channel: "chromium", headless: true, locale: "en-US", colorScheme, reducedMotion: "reduce",
        viewport: { width: 375, height: 1000 },
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
      });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).host;
      const manager = await context.newPage();
      await manager.goto(`chrome-extension://${extensionId}/index.html`);
      expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "English layout master password" }))).toMatchObject({ ok: true });
      await manager.reload();
      await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      const sections = ["All items", "API key", "Login", "Wallet and identity", "Secure Note", "Verification codes", "Steam", "Passkey", "Secure Send", "Archive", "Recycle Bin", "Sources", "Settings and backups", "Generator"];
      const issues: Array<{ section: string; label: string }> = [];
      for (const section of sections) {
        await manager.getByRole("button", { name: "Open navigation", exact: true }).click();
        await manager.getByRole("button", { name: new RegExp(`^${section}`) }).first().click();
        if (section === "Settings and backups") {
          await manager.locator(".settings-disclosure").evaluateAll((elements) => elements.forEach((element) => { (element as HTMLDetailsElement).open = true; }));
        }
        const current = await manager.locator("#main-content").evaluate((root) => {
          const problems: string[] = [];
          if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) problems.push("Page scrolls horizontally");
          for (const element of root.querySelectorAll<HTMLElement>("m3e-button, input, select, textarea")) {
            const box = element.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0 || getComputedStyle(element).visibility === "hidden") continue;
            if (box.right > document.documentElement.clientWidth + 1 || box.left < -1) problems.push(element.getAttribute("aria-label") || element.textContent || element.tagName);
            const label = element.shadowRoot?.querySelector<HTMLElement>(".label");
            if (label && (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1)) problems.push(`Clipped: ${element.textContent?.trim()}`);
          }
          const heading = root.querySelector(".page-heading");
          if (/[\u3400-\u9fff]/.test(heading?.textContent || "")) problems.push("Untranslated page heading");
          return problems;
        });
        issues.push(...current.map((label) => ({ section, label })));
      }
      await manager.screenshot({ path: testInfo.outputPath(`english-narrow-${colorScheme}.png`) });
      expect(issues).toEqual([]);
    } finally { await context?.close(); }
  });
}
