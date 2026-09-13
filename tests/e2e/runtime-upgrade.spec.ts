import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

for (const surface of ["index.html", "popup.html"]) {
  test(`${surface} recovers from an older running background without losing the vault`, async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "monica-upgrade-"));
    const extension = path.join(fixtureRoot, "extension");
    const password = "runtime upgrade synthetic password";
    let context: BrowserContext | undefined;
    try {
      await cp(path.resolve("dist"), extension, { recursive: true });
      const workerPath = path.join(extension, "background.js");
      const currentWorker = await readFile(workerPath, "utf8");
      // Keep the real dispatcher, crypto and storage. Omit only routes that an
      // older running worker does not understand, retaining the same manifest.
      expect(currentWorker).toContain('"VAULT_LOCKED_AUTOFILL_IDS"');
      const olderWorker = currentWorker
        .replaceAll('"VAULT_LOCKED_AUTOFILL_IDS"', '"LEGACY_LOCKED_AUTOFILL_IDS"')
        .replaceAll('"RUNTIME_INFO"', '"LEGACY_RUNTIME_INFO"');
      await writeFile(workerPath, olderWorker);
      context = await chromium.launchPersistentContext(path.join(fixtureRoot, "profile"), {
        channel: "chromium", headless: true, locale: "zh-CN",
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
      });
      // Command-line loading bypasses the developer-mode check, but a later
      // runtime.reload() does not. Match a user's unpacked installation.
      const extensionsPage = await context.newPage();
      await extensionsPage.goto("chrome://extensions/");
      await extensionsPage.evaluate(() => (chrome as unknown as { developerPrivate: {
        updateProfileConfiguration: (config: { inDeveloperMode: boolean }) => Promise<void>;
      } }).developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).host;
      const manager = await context.newPage();
      await manager.goto(`chrome-extension://${extensionId}/index.html`);
      const setup = await manager.evaluate(masterPassword => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword }), password);
      expect(setup, setup.error).toMatchObject({ ok: true });
      const now = new Date().toISOString();
      expect(await manager.evaluate(item => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
        id: "before-upgrade", kind: "login", title: "Saved before update", username: "synthetic-user",
        password: "synthetic-account-secret", uris: ["https://upgrade.example.test"],
        favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], customFields: []
      })).toMatchObject({ ok: true });
      expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
      await manager.close();

      await context.route("https://upgrade.example.test/**", route => route.fulfill({
        contentType: "text/html", body: '<!doctype html><title>Upgrade fixture</title><input autocomplete="username"><input type="password" autocomplete="current-password">'
      }));
      const site = await context.newPage();
      await site.goto("https://upgrade.example.test/");
      const page = await context.newPage();
      await site.bringToFront();
      await page.goto(`chrome-extension://${extensionId}/${surface}`);
      await expect(page.locator(surface === "index.html" ? ".login-card" : ".popup-unlock, .runtime-reload")).toBeVisible();
      const passwordField = page.getByLabel("主密码", { exact: true });
      // The old UI exposes this form and fails only after a successful unlock.
      // The repaired UI identifies the mismatch before accepting a password.
      if (await passwordField.isVisible()) {
        await passwordField.fill(password);
        await passwordField.press("Enter");
      }
      const reload = page.getByRole("button", { name: "重新加载扩展", exact: true });
      await expect(reload).toBeVisible();
      await expect(page.getByText("不支持的 Monica 运行时命令。", { exact: true })).toHaveCount(0);
      await expect(passwordField).toHaveCount(0);
      expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_STATUS" }))).toMatchObject({ ok: true, data: "locked" });

      await page.setViewportSize({ width: 320, height: 480 });
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      const reloadMessage = "Monica 已更新，请重新加载扩展后再解锁。";
      for (const locale of ["en", "de", "es", "ja", "ko", "ru", "vi", "zh-CN"]) {
        await page.evaluate(value => chrome.storage.local.set({ "monica.locale": value }), locale);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        const messages = locale === "zh-CN" ? { [reloadMessage]: reloadMessage } : JSON.parse(await readFile(locale === "en" ? "src/i18n/ui-en.json" : `public/locales/ui-${locale}.json`, "utf8"));
        await expect(page.locator(".runtime-reload").getByText(messages[reloadMessage], { exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      }
      await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
      await page.setViewportSize({ width: 1280, height: 720 });

      // Also cover the original partial-success state: an old UI has already
      // unlocked the background before its follow-up command failed.
      expect(await page.evaluate(masterPassword => chrome.runtime.sendMessage({ type: "VAULT_UNLOCK", masterPassword }), password)).toMatchObject({ ok: true });

      // Replacing files alone leaves the already running worker unchanged.
      await writeFile(workerPath, currentWorker);
      // Reload closes extension pages, sometimes before the click response.
      // Opening the manager again also wakes a lazily started MV3 worker.
      await reload.click().catch(error => { if (!page.isClosed()) throw error; });
      const reopened = await context.newPage();
      await expect(async () => {
        await reopened.goto(`chrome-extension://${extensionId}/index.html`);
        await expect(reopened.getByRole("heading", { name: "解锁 Monica", exact: true })).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 15_000 });
      await reopened.getByLabel("主密码", { exact: true }).fill("incorrect synthetic password");
      await reopened.getByLabel("主密码", { exact: true }).press("Enter");
      await expect(reopened.locator(".form-error")).toBeVisible();
      expect(await reopened.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_STATUS" }))).toMatchObject({ ok: true, data: "locked" });
      await reopened.getByLabel("主密码", { exact: true }).fill(password);
      await reopened.getByLabel("主密码", { exact: true }).press("Enter");
      await expect(reopened.getByRole("heading", { name: "密码库概览", exact: true })).toBeVisible();
      const saved = await reopened.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
      expect(saved).toMatchObject({ ok: true, data: [expect.objectContaining({ id: "before-upgrade", username: "synthetic-user", password: "synthetic-account-secret" })] });
    } finally {
      await context?.close();
      const resolved = await realpath(fixtureRoot);
      const tempRoot = await realpath(tmpdir());
      if (path.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase() || !path.basename(resolved).startsWith("monica-upgrade-")) throw new Error("Unexpected upgrade fixture path");
      await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
