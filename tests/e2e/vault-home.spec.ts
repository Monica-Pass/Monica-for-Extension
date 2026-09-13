import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test as base, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { HOME_MODULES, normalizeHomePreferences } from "../../src/core/home-preferences";
import { homeBackup, homeItems, homePassword } from "./fixtures/vault-home";

const test = base.extend<{ home: Page }>({
  home: async ({}, use, testInfo) => {
    const extension = path.resolve("dist");
    const context = await chromium.launchPersistentContext(testInfo.outputPath("p"), {
      channel: "chromium", headless: true, locale: "en-US", reducedMotion: "reduce", viewport: { width: 1440, height: 1000 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      expect(await page.evaluate(({ backup, password }) => chrome.runtime.sendMessage({ type: "VAULT_RESTORE_ENCRYPTED", backup, backupPassword: password }), { backup: await homeBackup(), password: homePassword })).toMatchObject({ ok: true });
      await page.reload();
      await ready(page);
      await use(page);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
});

async function ready(page: Page) { await expect(page.locator(".home-toolbar").getByRole("button", { name: "Customize home", exact: true })).toBeEnabled(); }
async function back(page: Page) { await page.getByRole("button", { name: "Back to overview", exact: true }).click(); await ready(page); }
async function preferences(page: Page) { return (await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_HOME_GET" }))).data; }
async function moduleOrder(page: Page) { return page.locator(".home-module").evaluateAll(elements => elements.map(element => element.getAttribute("data-home-module"))); }
async function fits(page: Page, root: Locator) {
  const problems = await root.evaluate(root => {
    const problems: string[] = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1) problems.push("Horizontal page overflow");
    for (const control of root.querySelectorAll<HTMLElement>("button, input, select, m3e-button, m3e-icon-button")) {
      if (!control.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || control.closest("[inert]")) continue;
      const rect = control.getBoundingClientRect();
      const name = control.getAttribute("aria-label") || control.textContent?.trim().slice(0, 60);
      if (rect.left < -1 || rect.right > width + 1) problems.push(`Outside viewport: ${name}`);
      if (control.matches("button, m3e-button, m3e-icon-button") && (rect.width < 43.5 || rect.height < 43.5)) problems.push(`Small target: ${name}`);
    }
    return problems;
  });
  expect(problems).toEqual([]);
}

test("home opens existing details, scopes databases, and keeps folder identities separate", async ({ home }, testInfo) => {
  const root = home.locator(".vault-home");
  expect(await moduleOrder(home)).toEqual(HOME_MODULES);
  await expect(root.locator(".home-featured-card")).toHaveCount(1);
  await expect(root.locator(".home-browse-all")).toContainText("10");
  const html = await root.innerHTML();
  for (const secret of ["private-password-sentinel", "private-uri-secret-sentinel", "private-note-content-sentinel", "JBSWY3DPEHPK3PXP", "4111111111111111"]) expect(html).not.toContain(secret);
  const firstCard = await root.locator(".home-featured-title").innerText();
  await root.getByRole("button", { name: "Next card", exact: true }).click();
  await expect(root.locator(".home-featured-title")).not.toHaveText(firstCard);
  await root.getByRole("button", { name: "Previous card", exact: true }).click();
  await expect(root.locator(".home-featured-title")).toHaveText(firstCard);
  await root.locator(".home-featured-card").click();
  await expect(home.getByRole("dialog")).toBeVisible();
  await home.keyboard.press("Escape");
  await expect(root.locator(".home-featured-card")).toBeFocused();
  const favorites = root.locator('[data-home-module="favorites"]');
  await favorites.locator(".home-disclosure").click();
  await expect(favorites.locator(".home-item-row")).toHaveCount(0);
  await home.reload(); await ready(home);
  await expect(favorites.locator(".home-disclosure")).toHaveAttribute("aria-expanded", "false");
  await favorites.locator(".home-disclosure").click();
  await expect(favorites.locator(".home-item-row")).toHaveCount(3);
  await home.getByLabel("Database scope", { exact: true }).selectOption("work-db");
  await expect(root.locator(".home-browse-all")).toContainText("4");
  await expect(favorites.locator(".home-item-row")).toHaveCount(1);
  await expect(root.locator('[data-home-lifecycle="archive"] .home-count')).toHaveText("1");
  await expect(root.locator('[data-home-lifecycle="trash"] .home-count')).toHaveText("0");
  await home.getByLabel("Database scope", { exact: true }).selectOption("all");
  const folders = root.locator("#home-folder-results");
  const accounts = folders.locator(".home-item-row").filter({ has: home.locator("strong", { hasText: /^Accounts$/ }) });
  await expect(accounts).toHaveCount(3);
  await accounts.filter({ has: home.locator('small', { hasText: /^Monica Studio$/ }) }).click();
  await expect(home.locator(".item-card-main strong")).toHaveText(["GitHub · Monica Studio"]);
  await expect(home.locator(".home-context")).toContainText("Monica Studio");
  await back(home);
  await root.locator('[data-home-toggle="databases"]').click();
  await root.locator('[data-home-source="local"]').click();
  await expect(home.locator(".item-card")).toHaveCount(3);
  await home.getByRole("button", { name: "Edit login", exact: true }).click();
  await expect(home.getByRole("dialog")).toBeVisible();
  await home.keyboard.press("Escape");
  await back(home);
  await root.locator('[data-home-source="empty-db"]').click();
  await expect(home.locator(".item-card")).toHaveCount(0);
  await expect(home.locator(".empty-state")).toBeVisible();
  await back(home);
  await home.evaluate(() => chrome.storage.local.set({ "monica.locale": "zh-CN" }));
  await expect(home.locator("html")).toHaveAttribute("lang", "zh-CN");
  await home.evaluate(() => document.fonts.ready);
  await home.screenshot({ path: testInfo.outputPath("home-light-zh.png"), fullPage: true, animations: "disabled" });
});

test("every type, favorites, archive, trash and search opens the matching existing list", async ({ home }) => {
  const active = homeItems.filter(item => !item.archivedAt && !item.deletedAt);
  const root = home.locator(".vault-home");
  for (const kind of ["login", "card", "identity", "billing-address", "payment-account", "secure-note", "totp", "passkey"]) {
    await root.locator(`[data-home-kind="${kind}"]`).click();
    const expected = active.filter(item => item.kind === kind).map(item => item.title);
    const titles = await home.locator(kind === "login" ? ".credential-table .row-title strong" : ".item-card-main strong").allTextContents();
    expect(titles.sort()).toEqual(expected.sort());
    if (kind === "identity") {
      await home.locator(".appbar-create").click();
      await expect(home.getByRole("dialog")).toContainText("Document");
      await home.keyboard.press("Escape");
    }
    await back(home);
  }
  await root.getByRole("button", { name: "All favorites", exact: true }).click();
  await expect(home.locator(".item-card")).toHaveCount(3);
  await back(home);
  for (const [section, title] of [["archive", "Previous workspace"], ["trash", "Retired account"]]) {
    await root.locator(`[data-home-lifecycle="${section}"]`).click();
    await expect(home.locator(".item-card-main strong")).toHaveText([title]);
    await back(home);
  }
  await home.getByRole("textbox", { name: "Search vault", exact: true }).fill("Everyday Visa");
  await home.getByRole("textbox", { name: "Search vault", exact: true }).press("Enter");
  await expect(home.locator(".item-card-main strong")).toHaveText(["Everyday Visa"]);
  await home.locator(".sidebar").getByRole("button", { name: /^Login/ }).click();
  await expect(home.locator(".credential-table tbody tr")).toHaveCount(3);
});

test("layout preview, cancel, save, relock, all-hidden recovery and reset preserve user choices", async ({ home }, testInfo) => {
  const customize = home.locator(".home-toolbar").getByRole("button", { name: "Customize home", exact: true });
  await customize.click();
  const panel = home.locator("#home-customization");
  await panel.getByRole("button", { name: "Move Quick access down", exact: true }).focus();
  await home.keyboard.press("Enter");
  await panel.getByLabel("Browse by type", { exact: true }).uncheck();
  expect(await moduleOrder(home)).toEqual(["favorites", "frequent", "folders", "databases", "lifecycle"]);
  expect((await preferences(home)).hidden).toEqual([]);
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await moduleOrder(home)).toEqual(HOME_MODULES);
  await expect(customize).toBeFocused();
  await customize.click();
  await panel.getByRole("button", { name: "Move Quick access down", exact: true }).click();
  await panel.getByLabel("Browse by type", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await home.reload(); await ready(home);
  expect(await moduleOrder(home)).toEqual(["favorites", "frequent", "folders", "databases", "lifecycle"]);
  await home.locator(".sidebar").getByRole("button", { name: "Lock now", exact: true }).click();
  await expect(home.locator(".vault-home")).toHaveCount(0);
  await home.getByLabel("Master password", { exact: true }).fill(homePassword);
  await home.getByRole("button", { name: "Unlock", exact: true }).click(); await ready(home);
  expect(await moduleOrder(home)).toEqual(["favorites", "frequent", "folders", "databases", "lifecycle"]);
  await customize.click();
  for (const box of await panel.getByRole("checkbox").all()) await box.uncheck();
  await panel.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(home.locator(".home-module")).toHaveCount(0);
  await home.reload(); await ready(home);
  await expect(home.locator(".home-empty-layout")).toBeVisible();
  await home.getByRole("button", { name: "Choose sections", exact: true }).click();
  await panel.getByRole("button", { name: "Reset layout", exact: true }).click();
  await home.screenshot({ path: testInfo.outputPath("customize-home.png"), animations: "disabled" });
  await panel.getByRole("button", { name: "Save layout", exact: true }).click();
  expect(await moduleOrder(home)).toEqual(HOME_MODULES);
});

test("manual cards support a cancelable batch, ordering, scoping and an explicitly empty deck", async ({ home }, testInfo) => {
  const root = home.locator(".vault-home");
  const picker = home.locator("#home-card-picker");
  await home.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    (window as any).homeSaveCalls = 0;
    chrome.runtime.sendMessage = ((message: any, ...args: any[]) => {
      if (message.type === "VAULT_HOME_SET") (window as any).homeSaveCalls++;
      return (original as any)(message, ...args);
    }) as typeof chrome.runtime.sendMessage;
  });
  await root.getByRole("button", { name: "Manage cards", exact: true }).click();
  await picker.getByRole("button", { name: "Clear quick-access cards", exact: true }).click();
  await picker.getByRole("searchbox").fill("Recovery notes");
  await picker.getByRole("checkbox", { name: "Pin Recovery notes", exact: true }).check();
  await picker.getByRole("searchbox").fill("Proton Mail");
  await picker.getByRole("checkbox", { name: "Pin Proton Mail", exact: true }).check();
  await picker.getByRole("button", { name: "Move Proton Mail up", exact: true }).click();
  expect(await picker.locator(".home-pin-order li").evaluateAll(rows => rows.map(row => row.getAttribute("data-pin-id")))).toEqual(["home-login-local", "home-note"]);
  await picker.locator('[data-pin-id="home-note"] .home-pin-drag').dragTo(picker.locator('[data-pin-id="home-login-local"]'));
  expect(await picker.locator(".home-pin-order li").evaluateAll(rows => rows.map(row => row.getAttribute("data-pin-id")))).toEqual(["home-note", "home-login-local"]);
  expect(await home.evaluate(() => (window as any).homeSaveCalls)).toBe(0);
  expect((await preferences(home)).suggestFrequent).toBe(true);
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await preferences(home)).suggestFrequent).toBe(true);
  await root.getByRole("button", { name: "Manage cards", exact: true }).click();
  await picker.getByRole("button", { name: "Clear quick-access cards", exact: true }).click();
  await picker.getByRole("searchbox").fill("Recovery notes");
  await picker.getByRole("checkbox", { name: "Pin Recovery notes", exact: true }).check();
  await picker.getByRole("searchbox").fill("Proton Mail");
  await picker.getByRole("checkbox", { name: "Pin Proton Mail", exact: true }).check();
  await picker.getByRole("button", { name: "Save cards", exact: true }).click();
  await expect(picker).toHaveCount(0);
  expect(await home.evaluate(() => (window as any).homeSaveCalls)).toBe(1);
  await expect(root.locator(".home-featured-title")).toHaveText("Recovery notes");
  await expect(root.locator(".home-card-position")).toHaveText("Card 1 of 2");
  await home.getByLabel("Database scope", { exact: true }).selectOption("local");
  await expect(root.locator(".home-featured-title")).toHaveText("Proton Mail");
  await home.getByLabel("Database scope", { exact: true }).selectOption("work-db");
  await expect(root.locator(".home-featured-title")).toHaveText("Recovery notes");
  await ready(home);
  await home.reload(); await ready(home);
  expect((await preferences(home)).pinnedItemIds).toEqual(["home-note", "home-login-local"]);
  await home.getByLabel("Database scope", { exact: true }).selectOption("all");
  await root.getByRole("button", { name: "Manage cards", exact: true }).click();
  await picker.getByRole("searchbox").fill("Recovery notes");
  await picker.getByRole("checkbox", { name: "Pin Recovery notes", exact: true }).uncheck();
  await picker.getByRole("searchbox").fill("");
  await home.screenshot({ path: testInfo.outputPath("manage-cards.png"), animations: "disabled" });
  await picker.getByRole("button", { name: "Save cards", exact: true }).click();
  await expect(root.locator(".home-featured-title")).toHaveText("Proton Mail");
  await root.getByRole("button", { name: "Manage cards", exact: true }).click();
  await picker.getByRole("button", { name: "Clear quick-access cards", exact: true }).click();
  await picker.getByRole("button", { name: "Save cards", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await home.reload(); await ready(home);
  await expect(root.locator(".home-featured-card")).toHaveCount(0);
  expect((await preferences(home)).suggestFrequent).toBe(false);
  await expect(root.locator(".home-browse-all")).toContainText("10");
  await root.getByRole("button", { name: "Manage cards", exact: true }).click();
  await picker.getByRole("button", { name: "Use suggested cards", exact: true }).click();
  await picker.getByRole("button", { name: "Save cards", exact: true }).click();
  await expect(root.locator(".home-featured-card")).toHaveCount(1);
});

test("failed settings saves keep the draft reviewable and can be retried", async ({ home }) => {
  await home.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    (window as any).restoreHomeRuntime = () => { chrome.runtime.sendMessage = original; };
    chrome.runtime.sendMessage = ((message: any, ...args: any[]) => message.type === "VAULT_HOME_SET" ? Promise.resolve({ ok: false, error: "Synthetic settings write failure" }) : (original as any)(message, ...args)) as typeof chrome.runtime.sendMessage;
  });
  await home.getByRole("button", { name: "Customize home", exact: true }).click();
  const panel = home.locator("#home-customization");
  await panel.getByLabel("Databases", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(home.getByRole("alert")).toHaveText("Synthetic settings write failure");
  await expect(panel).toBeVisible();
  expect((await preferences(home)).hidden).toEqual([]);
  await home.evaluate(() => (window as any).restoreHomeRuntime());
  await panel.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await home.reload(); await ready(home);
  expect((await preferences(home)).hidden).toEqual(["databases"]);
});

test("home preferences are manager-only and inaccessible after locking", async ({ home }) => {
  const popup = await home.context().newPage();
  await popup.goto(new URL("popup.html", home.url()).href);
  for (const request of [{ type: "VAULT_HOME_GET" }, { type: "VAULT_HOME_SET", preferences: normalizeHomePreferences({ hidden: HOME_MODULES }) }]) {
    expect(await popup.evaluate(request => chrome.runtime.sendMessage(request), request)).toMatchObject({ ok: false });
  }
  await home.context().route("https://home-boundary.example.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Synthetic content boundary</title><input autocomplete="username"><input type="password" autocomplete="current-password">' }));
  const site = await home.context().newPage();
  await site.goto("https://home-boundary.example.test/");
  const cdp = await home.context().newCDPSession(site);
  const contexts: number[] = [];
  cdp.on("Runtime.executionContextCreated", event => contexts.push(event.context.id));
  await cdp.send("Runtime.enable");
  let contentWorld: number | undefined;
  await expect.poll(async () => {
    for (const contextId of contexts) {
      const probe = await cdp.send("Runtime.evaluate", { contextId, expression: "typeof globalThis.chrome?.runtime?.sendMessage === 'function'", returnByValue: true }).catch(() => null);
      if (probe?.result.value === true) { contentWorld = contextId; return true; }
    }
    return false;
  }).toBe(true);
  for (const request of [{ type: "VAULT_HOME_GET" }, { type: "VAULT_HOME_SET", preferences: normalizeHomePreferences({ hidden: HOME_MODULES }) }]) {
    const response = await cdp.send("Runtime.evaluate", { contextId: contentWorld!, expression: `chrome.runtime.sendMessage(${JSON.stringify(request)})`, awaitPromise: true, returnByValue: true });
    expect(response.result.value).toMatchObject({ ok: false });
  }
  await cdp.detach();
  expect((await preferences(home)).hidden).toEqual([]);
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }));
  await expect(home.locator(".vault-home")).toHaveCount(0);
  expect(await home.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_HOME_GET" }))).toMatchObject({ ok: false });
  expect(await home.evaluate(preferences => chrome.runtime.sendMessage({ type: "VAULT_HOME_SET", preferences }), normalizeHomePreferences())).toMatchObject({ ok: false });
});

test("large catalogs keep cards and folders bounded while the original lists retain pagination", async ({ home }) => {
  const items = Array.from({ length: 2000 }, (_, index) => ({ ...homeItems[0], id: `large-home-${index}`, title: `Catalog ${String(index).padStart(4, "0")}`, boundTotpItemId: undefined, categoryId: 100 + index % 80, categoryName: `Folder ${index % 80}` }));
  expect(await home.evaluate(items => chrome.runtime.sendMessage({ type: "VAULT_IMPORT_ITEMS", items }), items)).toMatchObject({ ok: true });
  await home.reload(); await ready(home);
  await expect(home.locator(".home-browse-all")).toContainText("2010");
  await expect(home.locator(".home-featured-card")).toHaveCount(1);
  await expect(home.locator("#home-favorites .home-item-row")).toHaveCount(6);
  await expect(home.locator("#home-folder-results .home-item-row")).toHaveCount(6);
  await home.getByRole("button", { name: "Manage cards", exact: true }).click();
  await expect(home.locator(".home-picker-item")).toHaveCount(8);
  await home.getByRole("button", { name: "Clear quick-access cards", exact: true }).click();
  await home.locator("#home-card-picker").getByRole("searchbox").fill("Catalog 1999");
  await expect(home.locator(".home-picker-item")).toHaveCount(1);
  await home.locator(".home-picker-item input").check();
  await home.getByRole("button", { name: "Save cards", exact: true }).click();
  await expect(home.locator(".home-featured-title")).toHaveText("Catalog 1999");
  await home.locator("[data-home-kind='login']").click();
  await expect(home.locator(".credential-table tbody tr")).toHaveCount(50);
  await home.getByLabel("Page", { exact: true }).selectOption("41");
  await expect(home.locator(".credential-table tbody tr")).toHaveCount(3);
  await back(home);
  await home.getByRole("searchbox", { name: "Search folders", exact: true }).fill("Folder 79");
  await expect(home.locator("#home-folder-results .home-item-row")).toHaveCount(1);
  await home.locator("#home-folder-results .home-item-row").click();
  await expect(home.locator(".item-card")).toHaveCount(25);
});

for (const theme of ["light", "dark"] as const) {
  test(`home and editing controls fit eight languages, small screens and 200% text in ${theme}`, async ({ home }, testInfo) => {
    test.setTimeout(120_000);
    await home.emulateMedia({ colorScheme: theme });
    await expect(home.locator("html")).toHaveAttribute("data-theme", theme);
    const root = home.locator(".vault-home");
    for (const language of ["zh-CN", "en", "ja", "ko", "de", "es", "ru", "vi"]) {
      await home.evaluate(language => chrome.storage.local.set({ "monica.locale": language }), language);
      await expect(home.locator("html")).toHaveAttribute("lang", language);
      await home.setViewportSize({ width: 1440, height: 1000 });
      await home.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
      await home.evaluate(() => document.fonts.ready);
      await fits(home, root);
      if (["zh-CN", "en"].includes(language)) await home.screenshot({ path: testInfo.outputPath(`home-${theme}-${language}.png`), fullPage: true, animations: "disabled" });
      if (language === "zh-CN") {
        await root.locator(".home-toolbar-actions > button").last().click();
        await home.screenshot({ path: testInfo.outputPath(`customize-${theme}-zh-CN.png`), animations: "disabled" });
        await root.locator("#home-customization").press("Escape");
        await root.locator("#home-manage-cards").click();
        await home.screenshot({ path: testInfo.outputPath(`cards-${theme}-zh-CN.png`), animations: "disabled" });
        await root.locator("#home-card-picker").press("Escape");
        await home.setViewportSize({ width: 390, height: 844 });
        await home.screenshot({ path: testInfo.outputPath(`home-mobile-${theme}.png`), animations: "disabled" });
      }
      await home.setViewportSize({ width: 320, height: 568 });
      await home.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await fits(home, root);
      if (language === "zh-CN") await home.screenshot({ path: testInfo.outputPath(`home-narrow-${theme}.png`), animations: "disabled" });
      await root.locator(".home-toolbar-actions > button").last().click();
      await fits(home, root);
      await root.locator("#home-customization").press("Escape");
      await root.locator("#home-manage-cards").click();
      await fits(home, root);
      await home.screenshot({ path: testInfo.outputPath(`home-small-${theme}-${language}.png`), animations: "disabled" });
      await root.locator("#home-card-picker").press("Escape");
    }
    await home.setViewportSize({ width: 1440, height: 1000 });
    await home.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    const result = await new AxeBuilder({ page: home }).include(".vault-home").analyze();
    expect(result.violations.filter(issue => issue.impact === "serious" || issue.impact === "critical")).toEqual([]);
  });
}
