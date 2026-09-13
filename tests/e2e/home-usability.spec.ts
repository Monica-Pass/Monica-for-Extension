import { chromium, expect, test as base, type Page } from "@playwright/test";
import path from "node:path";
import { normalizeHomePreferences, type HomePreferences } from "../../src/core/home-preferences";
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
      expect(await page.evaluate(({ backup, password }) => chrome.runtime.sendMessage({ type: "VAULT_RESTORE_ENCRYPTED", backup, backupPassword: password }), { backup: await homeBackup(true), password: homePassword })).toMatchObject({ ok: true });
      await page.reload(); await ready(page);
      await use(page);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
});
async function ready(page: Page) { await expect(page.locator(".home-toolbar").getByRole("button", { name: "Customize home", exact: true })).toBeEnabled(); }
async function preferences(page: Page) { return (await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_HOME_GET" }))).data as HomePreferences; }
async function setPreferences(page: Page, value: Partial<HomePreferences>) {
  expect(await page.evaluate(preferences => chrome.runtime.sendMessage({ type: "VAULT_HOME_SET", preferences }), normalizeHomePreferences({ ...await preferences(page), ...value }))).toMatchObject({ ok: true });
  await page.reload(); await ready(page);
}
async function clipboard(page: Page) {
  await page.evaluate(() => {
    (window as any).homeCopies = [];
    (window as any).homeClipboardFails = false;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value: string) => {
        if ((window as any).homeClipboardFails) throw new Error("Synthetic clipboard denial");
        (window as any).homeCopies.push(value);
      }
    } });
  });
}

test("scope memory supports last, all and fixed sources without resetting in-page navigation", async ({ home }) => {
  const scope = home.getByLabel("Database scope", { exact: true });
  await scope.selectOption("work-db"); await ready(home);
  await home.reload(); await ready(home);
  await expect(scope).toHaveValue("work-db");
  await home.locator('.sidebar').getByRole("button", { name: "Lock now", exact: true }).click();
  await home.getByLabel("Master password", { exact: true }).fill(homePassword);
  await home.getByRole("button", { name: "Unlock", exact: true }).click();
  await ready(home);
  await expect(scope).toHaveValue("work-db");

  const panel = home.locator("#home-customization");
  await home.getByRole("button", { name: "Customize home", exact: true }).click();
  await panel.getByLabel("When opening home", { exact: true }).selectOption("fixed");
  await panel.getByLabel("Default database", { exact: true }).selectOption("personal-db");
  await panel.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await home.reload(); await ready(home);
  await expect(scope).toHaveValue("personal-db");
  await scope.selectOption("local"); await ready(home);
  await home.locator('[data-home-kind="login"]').click();
  await home.getByRole("button", { name: "Back to overview", exact: true }).click();
  await ready(home);
  await expect(scope).toHaveValue("local");
  await home.reload(); await ready(home);
  await expect(scope).toHaveValue("personal-db");
  await setPreferences(home, { startupSource: "all" });
  await expect(scope).toHaveValue("all");
  await setPreferences(home, { startupSource: "fixed", preferredSourceId: "removed-database" });
  await expect(scope).toHaveValue("all");
  await expect(home.locator(".home-status")).toContainText("previous database is unavailable");
});

test("compact density brings browse controls higher and cancel restores the saved appearance", async ({ home }, testInfo) => {
  const root = home.locator(".vault-home");
  const position = () => home.locator('[data-home-module="types"]').evaluate(node => node.getBoundingClientRect().top + window.scrollY);
  const compact = await position();
  await expect(root).toHaveAttribute("data-density", "compact");
  await home.getByRole("button", { name: "Customize home", exact: true }).click();
  const panel = home.locator("#home-customization");
  await panel.getByLabel("Home density", { exact: true }).selectOption("comfortable");
  await expect(root).toHaveAttribute("data-density", "comfortable");
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(root).toHaveAttribute("data-density", "compact");
  await home.getByRole("button", { name: "Customize home", exact: true }).click();
  await panel.getByLabel("Home density", { exact: true }).selectOption("comfortable");
  await panel.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await position()).toBeGreaterThan(compact + 50);
  await home.reload(); await ready(home);
  await expect(root).toHaveAttribute("data-density", "comfortable");
  await home.screenshot({ path: testInfo.outputPath("home-comfortable.png"), fullPage: true });
  await setPreferences(home, { density: "compact", pinnedItemIds: ["home-login-local"], suggestFrequent: false });
  await home.evaluate(() => chrome.storage.local.set({ "monica.locale": "zh-CN" }));
  await expect(home.locator("html")).toHaveAttribute("lang", "zh-CN");
  await home.evaluate(() => document.fonts.ready);
  await home.screenshot({ path: testInfo.outputPath("home-compact-quick-actions.png"), fullPage: true });
});

test("unavailable pins can be cleared across scopes without deleting archived or active records", async ({ home }) => {
  await setPreferences(home, { suggestFrequent: false, pinnedItemIds: ["home-login-local", "home-archived", "home-deleted", ...Array.from({ length: 21 }, (_, index) => `missing-${index}`)] });
  await home.getByRole("button", { name: "Manage cards", exact: true }).click();
  const picker = home.locator("#home-card-picker");
  await expect(picker.getByRole("checkbox", { name: "Pin Recovery notes", exact: true })).toBeDisabled();
  await picker.getByRole("button", { name: "Remove 23 unavailable cards", exact: true }).click();
  await picker.getByRole("checkbox", { name: "Pin Recovery notes", exact: true }).check();
  expect((await preferences(home)).pinnedItemIds).toHaveLength(24);
  await picker.getByRole("button", { name: "Save cards", exact: true }).click();
  await expect(picker).toHaveCount(0);
  expect((await preferences(home)).pinnedItemIds).toEqual(["home-login-local", "home-note"]);
  for (const itemId of ["home-login-local", "home-archived"]) {
    expect(await home.evaluate(itemId => chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId }), itemId)).toMatchObject({ ok: true, data: { id: itemId } });
  }
  expect((await home.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_DELETED_ITEMS" }))).data.some((item: { id: string }) => item.id === "home-deleted")).toBe(true);
});

test("failed card and scope writes remain retryable without losing the user's selection", async ({ home }) => {
  await home.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    (window as any).homeRejectWrites = true;
    chrome.runtime.sendMessage = ((message: any, ...args: any[]) => message.type === "VAULT_HOME_SET" && (window as any).homeRejectWrites
      ? Promise.resolve({ ok: false, error: "Synthetic preference failure" }) : (original as any)(message, ...args)) as typeof chrome.runtime.sendMessage;
  });
  await home.getByLabel("Database scope", { exact: true }).selectOption("work-db");
  await expect(home.getByRole("alert")).toContainText("Synthetic preference failure");
  await expect(home.locator(".home-browse-all")).toContainText("4");
  await home.evaluate(() => { (window as any).homeRejectWrites = false; });
  await home.getByRole("button", { name: "Retry", exact: true }).click(); await ready(home);
  expect((await preferences(home)).lastSourceId).toBe("work-db");
  await home.getByRole("button", { name: "Manage cards", exact: true }).click();
  const picker = home.locator("#home-card-picker");
  await picker.getByRole("button", { name: "Clear quick-access cards", exact: true }).click();
  await picker.getByRole("checkbox", { name: "Pin Recovery notes", exact: true }).check();
  await home.evaluate(() => { (window as any).homeRejectWrites = true; });
  await picker.getByRole("button", { name: "Save cards", exact: true }).click();
  await expect(home.getByRole("alert")).toContainText("Synthetic preference failure");
  await expect(picker.locator(".home-pin-order li")).toHaveCount(1);
  expect((await preferences(home)).suggestFrequent).toBe(true);
  await home.evaluate(() => { (window as any).homeRejectWrites = false; });
  await picker.getByRole("button", { name: "Save cards", exact: true }).click();
  await expect(picker).toHaveCount(0);
  expect((await preferences(home)).pinnedItemIds).toEqual(["home-note"]);
});

test("quick actions read current usernames and consume linked HOTP only after a successful copy", async ({ home }) => {
  await setPreferences(home, { pinnedItemIds: ["home-login-local"], suggestFrequent: false });
  await clipboard(home);
  const updated = { ...homeItems[0], username: "updated@example.test" };
  expect(await home.evaluate(item => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), updated)).toMatchObject({ ok: true });
  await home.getByRole("button", { name: "Copy username", exact: true }).click();
  await expect.poll(() => home.evaluate(() => (window as any).homeCopies)).toEqual(["updated@example.test"]);
  await expect(home.locator(".home-otp-badge")).toContainText("Authenticator linked");
  const otp = { ...homeItems.find(item => item.id === "home-otp")!, secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", otpType: "HOTP", counter: 0 };
  expect(await home.evaluate(item => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), otp)).toMatchObject({ ok: true });
  await home.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect.poll(async () => (await home.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: "home-otp" }))).data.counter).toBe(1);
  expect(await home.evaluate(() => (window as any).homeCopies)).toEqual(["updated@example.test", "755224"]);
  await home.evaluate(() => { (window as any).homeClipboardFails = true; });
  await home.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(home.locator(".home-copy-status")).toContainText("Copy failed");
  expect((await home.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: "home-otp" }))).data.counter).toBe(1);
  const html = await home.locator(".vault-home").innerHTML();
  for (const secret of ["private-password-sentinel", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "755224"]) expect(html).not.toContain(secret);
  await setPreferences(home, { pinnedItemIds: ["home-otp"] }); await clipboard(home);
  await home.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect.poll(() => home.evaluate(() => (window as any).homeCopies)).toEqual(["287082"]);
  await expect.poll(async () => (await home.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: "home-otp" }))).data.counter).toBe(2);
});

test("locking during a pending quick action cancels the clipboard write", async ({ home }) => {
  await setPreferences(home, { pinnedItemIds: ["home-login-local"], suggestFrequent: false }); await clipboard(home);
  await home.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((message: any, ...args: any[]) => {
      const response = (original as any)(message, ...args);
      return message.type === "VAULT_GET_ITEM" ? response.then((value: unknown) => new Promise(resolve => { (window as any).releaseHomeRead = () => resolve(value); })) : response;
    }) as typeof chrome.runtime.sendMessage;
  });
  await home.getByRole("button", { name: "Copy username", exact: true }).click();
  await expect.poll(() => home.evaluate(() => typeof (window as any).releaseHomeRead)).toBe("function");
  expect(await home.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
  await expect(home.locator(".vault-home")).toHaveCount(0);
  await home.evaluate(() => (window as any).releaseHomeRead());
  await home.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await home.evaluate(() => (window as any).homeCopies)).toEqual([]);
});

test("database status exposes safe summaries and focuses the matching management entry", async ({ home }) => {
  const root = home.locator(".vault-home");
  const toggle = root.locator('[data-home-toggle="databases"]');
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(root.locator("#home-source-results")).toHaveCount(0);
  await expect(root.locator(".home-attention-summary")).toHaveText("Sync needs attention 1");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(root.locator('[data-home-source="local"] .home-sync-state')).toHaveText("Saved in this browser");
  await expect(root.locator('[data-home-source="work-db"] .home-sync-state')).toHaveAttribute("data-state", "error");
  await expect(root.locator('[data-home-source="work-db"] .home-sync-time')).toContainText("9/12/26");
  expect(await root.innerHTML()).not.toContain("private-error-secret");
  expect(await root.innerHTML()).not.toContain("private-error-token");
  await home.getByRole("button", { name: "Review sync for Monica Studio", exact: true }).click();
  await expect(home.locator('[data-home-provider-id="work-db"] h2')).toBeFocused();
  await home.getByRole("button", { name: "Back to overview", exact: true }).click(); await ready(home);
});

test("collapsed sections survive reopening and stay independent of hidden modules", async ({ home }) => {
  const types = home.locator('[data-home-toggle="types"]');
  const databases = home.locator('[data-home-toggle="databases"]');
  const favorites = home.locator('[data-home-toggle="favorites"]');
  await types.click(); await ready(home);
  await databases.click(); await ready(home);
  await favorites.click(); await ready(home);
  await home.reload(); await ready(home);
  await expect(types).toHaveAttribute("aria-expanded", "false");
  await expect(databases).toHaveAttribute("aria-expanded", "true");
  await expect(favorites).toHaveAttribute("aria-expanded", "false");
  await expect(home.locator("#home-content-types")).toHaveCount(0);
  await expect(home.locator("#home-favorites")).toHaveCount(0);
  const panel = home.locator("#home-customization");
  await home.getByRole("button", { name: "Customize home", exact: true }).click();
  await panel.getByLabel("Browse by type", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await home.reload(); await ready(home);
  await expect(types).toHaveCount(0);
  expect(await preferences(home)).toMatchObject({ hidden: ["types"], collapsedModules: ["types"], favoritesExpanded: false });
  await home.getByRole("button", { name: "Customize home", exact: true }).click();
  await panel.getByLabel("Browse by type", { exact: true }).check();
  await panel.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(types).toHaveAttribute("aria-expanded", "false");
  await types.focus();
  await home.keyboard.press("Enter"); await ready(home);
  await expect(types).toHaveAttribute("aria-expanded", "true");
  await expect(home.locator('[data-home-kind="login"]')).toBeVisible();
  expect(await preferences(home)).toMatchObject({ hidden: [], collapsedModules: [], favoritesExpanded: false });
});

test("editors contain keyboard focus and keep saving reachable in a short window with enlarged text", async ({ home }) => {
  await home.setViewportSize({ width: 320, height: 568 });
  await home.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const customize = home.getByRole("button", { name: "Customize home", exact: true });
  await customize.click();
  const dialog = home.getByRole("dialog");
  expect(await dialog.evaluate(node => node.matches(":modal"))).toBe(true);
  const panel = home.locator("#home-customization");
  const saveLayout = panel.getByRole("button", { name: "Save layout", exact: true });
  await panel.getByLabel("Browse by type", { exact: true }).uncheck();
  await expect(saveLayout).toBeInViewport({ ratio: 1 });
  expect(await panel.locator(".home-panel-body").evaluate(node => node.clientHeight)).toBeGreaterThan(140);
  await saveLayout.focus();
  await customize.evaluate(node => node.focus());
  await expect(saveLayout).toBeFocused();
  await home.keyboard.press("Tab");
  // Native dialogs may include the browser chrome in sequential navigation.
  if (await home.evaluate(() => document.activeElement === document.body)) await home.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await home.keyboard.press("Shift+Tab");
  if (await home.evaluate(() => document.activeElement === document.body)) await home.keyboard.press("Shift+Tab");
  await expect(saveLayout).toBeFocused();
  await home.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(customize).toBeFocused();
  expect((await preferences(home)).hidden).toEqual([]);

  const manage = home.getByRole("button", { name: "Manage cards", exact: true });
  await manage.click();
  expect(await dialog.evaluate(node => node.matches(":modal"))).toBe(true);
  const picker = home.locator("#home-card-picker");
  const saveCards = picker.getByRole("button", { name: "Save cards", exact: true });
  await picker.getByRole("button", { name: "Clear quick-access cards", exact: true }).click();
  await picker.getByRole("searchbox").fill("Proton Mail");
  await picker.getByRole("checkbox", { name: "Pin Proton Mail", exact: true }).check();
  await expect(saveCards).toBeInViewport({ ratio: 1 });
  expect(await picker.locator(".home-pin-columns").evaluate(node => node.clientHeight)).toBeGreaterThan(140);
  await saveCards.focus();
  await manage.evaluate(node => node.focus());
  await expect(saveCards).toBeFocused();
  await home.keyboard.press("Tab");
  if (await home.evaluate(() => document.activeElement === document.body)) await home.keyboard.press("Tab");
  await expect(picker.getByRole("button", { name: "Close card picker", exact: true })).toBeFocused();
  await home.keyboard.press("Shift+Tab");
  if (await home.evaluate(() => document.activeElement === document.body)) await home.keyboard.press("Shift+Tab");
  await expect(saveCards).toBeFocused();
  await saveCards.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(manage).toBeFocused();
  expect((await preferences(home)).pinnedItemIds).toEqual(["home-login-local"]);
});
