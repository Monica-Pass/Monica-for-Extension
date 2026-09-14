import { chooseOption, dialogContent } from "./fixtures/material";
import { chromium, expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const extension = path.resolve("dist");

test("large lists remain searchable, pageable and usable for filling", async ({}, testInfo) => {
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium", headless: true, locale: "en-US", reducedMotion: "reduce", viewport: { width: 1366, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${id}/index.html`);
    const setup = await manager.evaluate(async () => {
      const setup = await chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "large list synthetic password" });
      if (!setup.ok) return setup;
      const now = new Date().toISOString();
      const common = { favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], customFields: [] };
      const items = Array.from({ length: 123 }, (_, index) => ({ ...common, id: `paged-login-${index}`, kind: "login", title: `Account ${String(index).padStart(3, '0')}`, username: `user${index}@example.test`, password: `synthetic-secret-${index}`, uris: ["https://paged.example.test"] }));
      return chrome.runtime.sendMessage({ type: "VAULT_IMPORT_ITEMS", items });
    });
    expect(setup.ok).toBe(true);
    await manager.reload();
    await manager.locator(".sidebar .nav-item").nth(1).click();
    await expect(manager.locator(".credential-table tbody tr")).toHaveCount(50);
    await chooseOption(manager.getByLabel("Page", { exact: true }), "3");
    await expect(manager.locator(".credential-table tbody tr")).toHaveCount(23);
    await expect(manager.locator("#main-content")).toBeFocused();
    const search = manager.getByRole("searchbox", { name: "Search vault", exact: true });
    await search.fill("Account 077");
    await expect(manager.locator(".credential-table tbody tr")).toHaveCount(1);
    await expect(manager.getByText("Account 077", { exact: true })).toBeVisible();
    await search.fill("");
    await expect(manager.getByLabel("Page", { exact: true })).toHaveJSProperty("value", "1");
    await chooseOption(manager.getByLabel("Page", { exact: true }), "3");
    manager.on("dialog", dialog => void dialog.accept());
    for (let index = 0; index < 23; index++) {
      await manager.getByRole("button", { name: "Delete login", exact: true }).first().click();
      await expect(manager.locator(".credential-table tbody tr")).toHaveCount(index === 22 ? 50 : 22 - index);
    }
    await expect(manager.getByLabel("Page", { exact: true })).toHaveJSProperty("value", "2");
    await manager.setViewportSize({ width: 320, height: 480 });
    await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    for (const locale of ["zh-CN", "en", "ja", "ko", "de", "es", "ru", "vi"]) {
      await manager.evaluate(locale => chrome.storage.local.set({ "monica.locale": locale }), locale);
      await expect(manager.locator("html")).toHaveAttribute("lang", locale);
      const issues = await manager.locator(".list-pagination").evaluate(root => {
        const problems: string[] = [];
        for (const control of root.querySelectorAll("m3e-button, m3e-form-field")) {
          const bounds = control.getBoundingClientRect();
          if (bounds.width < 44 || bounds.height < 44 || bounds.left < 0 || bounds.right > document.documentElement.clientWidth) problems.push(control.textContent || control.tagName);
        }
        return problems;
      });
      expect(issues, locale).toEqual([]);
    }
    await manager.evaluate(() => { document.documentElement.style.fontSize = "100%"; return chrome.storage.local.set({ "monica.locale": "en" }); });
    await manager.setViewportSize({ width: 1366, height: 900 });
    await expect(manager.locator("html")).toHaveAttribute("lang", "en");

    await context.route("https://paged.example.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><label>Username<input autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label>' }));
    const site = await context.newPage();
    await site.goto("https://paged.example.test/login");
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 320, height: 480 });
    await site.bringToFront();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator("#popup-matches .credential-card")).toHaveCount(20);
    await chooseOption(popup.locator("#popup-matches").getByLabel("Page", { exact: true }), "4");
    await expect(popup.locator("#popup-matches .credential-card")).toHaveCount(20);
    const title = await popup.locator("#popup-matches .popup-item-title").first().textContent();
    await popup.getByRole("searchbox").fill(title!);
    await expect(popup.locator("#popup-matches .credential-card")).toHaveCount(1);
    await popup.locator("#popup-matches .credential-card").getByRole("button").click();
    await expect(site.locator('input[type="password"]')).toHaveValue(/^synthetic-secret-\d+$/);
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // A site with no matches still exposes all saved logins through a bounded list.
    await context.route("https://other.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Unrelated site</title>' }));
    await site.goto("https://other.test/");
    await site.bringToFront();
    await popup.reload();
    await expect(popup.locator("#popup-login-results .login-row")).toHaveCount(20);
    await chooseOption(popup.locator("#popup-login-results").getByLabel("Page", { exact: true }), "5");
    const copyTitle = await popup.locator("#popup-login-results .popup-item-title").first().textContent();
    await popup.getByRole("searchbox").fill(copyTitle!);
    await expect(popup.locator("#popup-login-results .login-row")).toHaveCount(1);
    await manager.getByRole("button", { name: "Edit login", exact: true }).first().click();
    await expect(dialogContent(manager)).toBeVisible();
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }));
    await expect(manager.getByRole("heading", { name: "Unlock Monica", exact: true })).toBeVisible();
    await expect(dialogContent(manager)).toHaveCount(0);
    await expect(manager.locator(".credential-table")).toHaveCount(0);
  } finally { await context.close(); }
});

test("removed website components do not retain shadow trees or capture listeners", async ({}, testInfo) => {
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium", headless: true, locale: "de-DE",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    await context.route("https://churn.example.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><main></main>' }));
    const requestedCatalogs: string[] = [];
    context.on("request", request => { if (request.url().includes('/locales/ui-')) requestedCatalogs.push(request.url()); });
    const site = await context.newPage();
    await site.goto("https://churn.example.test/");
    const cdp = await context.newCDPSession(site);
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await cdp.send("Memory.getDOMCounters");
    await site.evaluate(async () => {
      for (let cycle = 0; cycle < 5; cycle++) {
        const container = document.createElement("section");
        for (let index = 0; index < 100; index++) {
          const host = document.createElement("div");
          host.attachShadow({ mode: "open" }).innerHTML = '<form><input autocomplete="username"><input type="password"></form>';
          container.append(host);
        }
        document.querySelector("main")!.append(container);
        await new Promise(resolve => setTimeout(resolve, 0));
        container.remove();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    });
    await cdp.send("HeapProfiler.collectGarbage");
    const after = await cdp.send("Memory.getDOMCounters");
    expect(after.nodes).toBeLessThanOrEqual(before.nodes + 10);
    expect(after.jsEventListeners).toBeLessThanOrEqual(before.jsEventListeners + 3);
    expect(requestedCatalogs).toEqual([]);
    await cdp.detach();
  } finally { await context.close(); }
});

test("every bundled icon renders as a complete glyph", async ({}, testInfo) => {
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium", headless: true, locale: "en-US",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const symbols = JSON.parse(readFileSync("scripts/icon-font-inventory.json", "utf8")).symbols as string[];
    const missing = await page.evaluate(async symbols => {
      await document.fonts.load('24px "Material Symbols Outlined"');
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 40;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.font = '24px "Material Symbols Outlined"';
      return symbols.filter(symbol => {
        context.clearRect(0, 0, 40, 40);
        context.fillText(symbol, 4, 28);
        const width = context.measureText(symbol).width;
        return width < 23 || width > 25 || !context.getImageData(0, 0, 40, 40).data.some(value => value > 0);
      });
    }, symbols);
    expect(missing).toEqual([]);
  } finally { await context.close(); }
});
