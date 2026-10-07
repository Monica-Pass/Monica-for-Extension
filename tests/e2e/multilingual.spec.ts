import { chooseOption, dialogContent } from "./fixtures/material";
import { chromium, expect, test, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { localeOptions } from "../../src/i18n/locales";

const extension = path.resolve("dist");
const password = "multilingual synthetic vault password";
const extraLanguages = localeOptions.filter((option) => option.value !== "zh-CN" && option.value !== "en");

async function usable(root: Locator) {
  await root.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
  const issues = await root.evaluate((root) => {
    const issues: string[] = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1) issues.push("Page scrolls horizontally");
    for (const control of root.querySelectorAll<HTMLElement>("button, m3e-button, m3e-icon-button, m3e-list-action, m3e-list-option, input, select, m3e-select, textarea, h1, h2, h3, p")) {
      const box = control.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || getComputedStyle(control).visibility === "hidden") continue;
      const name = control.getAttribute("aria-label") || control.textContent?.trim().slice(0, 80) || control.tagName;
      if (box.left < -1 || box.right > width + 1) issues.push(`Outside window: ${name}`);
      if (control.matches("button, m3e-button, m3e-icon-button, m3e-list-action, m3e-list-option") && (box.width < 43.5 || box.height < 43.5)) issues.push(`Small target: ${name}`);
      const label = control.shadowRoot?.querySelector<HTMLElement>(".label, .content") ?? control.shadowRoot?.querySelector("m3e-list-item-button")?.shadowRoot?.querySelector<HTMLElement>(".content");
      if (label && (label.scrollHeight > label.clientHeight + 1 || label.scrollWidth > label.clientWidth + 1)) issues.push(`Clipped label: ${name}`);
      const touch = control.shadowRoot?.querySelector(".touch")?.getBoundingClientRect();
      if (touch && (touch.left < box.left - 1 || touch.right > box.right + 1 || touch.top < box.top - 1 || touch.bottom > box.bottom + 1)) issues.push(`Overlapping target: ${name}`);
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

test("language names stay readable in settings on narrow screens", async ({}, testInfo) => {
  const context = await chromium.launchPersistentContext(testInfo.outputPath("language-picker-profile"), {
    channel: "chromium", headless: true, locale: "zh-CN", reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const manager = await context.newPage();
    await context.setOffline(true);
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await expect(manager.getByRole("heading", { name: "创建加密密码库", exact: true })).toBeVisible();
    await expect(manager.locator(".language-picker")).toHaveCount(0);
    expect(await manager.evaluate(password => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: password }), password)).toMatchObject({ ok: true });
    await manager.reload();
    await manager.getByRole("navigation").getByRole("button", { name: "设置与备份", exact: true }).click();
    const picker = manager.locator(".settings-page .language-picker").getByRole("combobox");
    for (const [width, height, scale] of [[390, 640, 100], [320, 480, 200]]) {
      await manager.setViewportSize({ width, height });
      await manager.evaluate((scale) => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
      for (const { value } of localeOptions) {
        await chooseOption(picker, value);
        await expect(manager.locator("html")).toHaveAttribute("lang", value);
        await manager.evaluate(() => document.fonts.ready);
        const metrics = await picker.evaluate((element) => {
          const select = element as HTMLSelectElement & { selected?: Array<{ label: string }> };
          const style = getComputedStyle(select);
          const label = document.createElement("span");
          Object.assign(label.style, { position: "fixed", visibility: "hidden", whiteSpace: "pre", font: style.font, letterSpacing: style.letterSpacing });
          label.textContent = select.selectedOptions?.[0]?.text ?? select.selected?.[0]?.label ?? "";
          document.body.append(label);
          const labelWidth = label.getBoundingClientRect().width;
          label.remove();
          const box = select.getBoundingClientRect();
          const value = select.shadowRoot?.querySelector("m3e-text-overflow");
          return { labelWidth, available: value?.clientWidth ?? select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), left: box.left, right: box.right };
        });
        expect(metrics.labelWidth, `${value} at ${width}px / ${scale}%`).toBeLessThanOrEqual(metrics.available + 1);
        expect(metrics.left).toBeGreaterThanOrEqual(0);
        expect(metrics.right).toBeLessThanOrEqual(width);
      }
    }
  } finally { await context.close(); }
});

for (const language of extraLanguages) {
  test(`${language.label}: offline pages, narrow controls, editing and locked autofill`, async ({}, testInfo) => {
    const catalog: Record<string, string> = JSON.parse(readFileSync(`public/locales/ui-${language.value}.json`, "utf8"));
    const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
      channel: "chromium", headless: true, locale: language.value, colorScheme: "dark", reducedMotion: "reduce",
      viewport: { width: 390, height: 640 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const id = new URL(worker.url()).host;
      const requestedCatalogs = new Set<string>();
      context.on("request", (request) => {
        if (request.url().includes("/locales/ui-")) requestedCatalogs.add(request.url());
      });
      await context.setOffline(true);
      const manager = await context.newPage();
      await manager.goto(`chrome-extension://${id}/index.html`);
      await expect(manager.locator("html")).toHaveAttribute("lang", language.value);
      await expect(manager.getByRole("heading", { name: catalog["创建加密密码库"], exact: true })).toBeVisible();
      await expect(manager.locator(".language-picker")).toHaveCount(0);
      await manager.getByLabel(catalog["主密码"], { exact: true }).fill(password);
      await manager.getByLabel(catalog["确认主密码"], { exact: true }).fill(password);
      await manager.getByRole("button", { name: catalog["创建并解锁"], exact: true }).click();
      await expect(manager.locator(".page-heading h1")).toBeVisible();
      const now = new Date().toISOString();
      const fixture = { id: "language-login", kind: "login", title: "保留原始标题 / example", username: "user@example.test", password: "synthetic-fill-secret", uris: ["https://language.example.test"], favorite: false, notes: "原始备注 <>& {0}", createdAt: now, updatedAt: now, providerRefs: [], customFields: [] };
      expect(await manager.evaluate((item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item, allowLockedAutofill: true }), fixture)).toMatchObject({ ok: true });
      await manager.reload();
      await expect(manager.locator(".page-heading h1")).toBeVisible();
      const navigate = async (index: number) => {
        await manager.getByRole("button", { name: catalog["打开导航"], exact: true }).click();
        await manager.locator(".sidebar .nav-item").nth(index).click();
        await expect(manager.locator(".page-heading h1")).toBeVisible();
      };
      const pages = await manager.locator(".sidebar .nav-item").count();
      expect(pages).toBeGreaterThanOrEqual(14);
      for (const [width, height, scale] of [[390, 640, 100], [320, 480, 200]]) {
        await manager.setViewportSize({ width, height });
        await manager.evaluate((scale) => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        for (let index = 0; index < pages; index++) {
          await navigate(index);
          await manager.locator(".settings-disclosure").evaluateAll((items) => items.forEach((item) => { (item as HTMLDetailsElement).open = true; }));
          await usable(manager.locator("#main-content"));
        }
      }
      await navigate(1);
      await manager.getByRole("button", { name: catalog["新建"], exact: true }).click();
      const editor = dialogContent(manager, { name: catalog["添加{0}"].replace("{0}", catalog["密码"]), exact: true });
      const save = editor.getByRole("button", { name: catalog["加密保存"], exact: true });
      await expect(save).toBeInViewport({ ratio: 1 });
      await editor.getByLabel(catalog["名称 *"], { exact: true }).fill("多语言编辑 / " + language.value);
      await editor.getByLabel("恢复备注与笔记", { exact: true }).fill("保留原文 <>& {0}");
      await usable(editor);
      await expect(save).toBeInViewport({ ratio: 1 });
      await manager.screenshot({ path: testInfo.outputPath(`editor-${language.value}-200.png`), animations: "disabled" });
      await save.click();
      await expect(editor).toHaveCount(0);
      await expect(manager.getByText("多语言编辑 / " + language.value, { exact: true })).toBeVisible();

      await context.route("https://language.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Language test</title><label>Username<input autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label>' }));
      const site = await context.newPage();
      await site.goto("https://language.example.test/login");
      await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }));
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 320, height: 360 });
      await site.bringToFront();
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await expect(popup.locator("html")).toHaveAttribute("lang", language.value);
      await expect(popup.locator(".language-picker")).toHaveCount(0);
      await popup.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      const marked = popup.locator(".locked-autofill-section").getByRole("button", { name: /保留原始标题/ });
      await expect(marked).toBeVisible();
      await usable(popup.locator("#popup-root"));
      await marked.click();
      await expect(site.locator('input[type="password"]')).toHaveValue(fixture.password);
      expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_STATUS" }))).toMatchObject({ ok: true, data: "locked" });
      await popup.getByLabel(catalog["主密码"], { exact: true }).fill(password);
      await popup.getByRole("button", { name: catalog["解锁"], exact: true }).click();
      await expect(popup.locator(".popup-unlock")).toHaveCount(0);
      expect([...requestedCatalogs].every((url) => url.startsWith("chrome-extension://") && url.endsWith(`/locales/ui-${language.value}.json`))).toBe(true);
      expect(requestedCatalogs.size).toBeGreaterThan(0);

      await manager.bringToFront();
      // Reopen the manager using the session unlocked by the independent Popup.
      await manager.reload();
      await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await expect(manager.locator(".page-heading h1")).toBeVisible();
      await manager.getByRole("button", { name: catalog["打开导航"], exact: true }).click();
      await manager.getByRole("navigation").getByRole("button", { name: catalog["设置与备份"], exact: true }).click();
      await expect(manager.locator(".settings-page").getByLabel(catalog["界面语言"])).toHaveJSProperty("value", "system");
      await chooseOption(manager.locator(".settings-page").getByLabel(catalog["界面语言"]), "en");
      await expect(manager.locator("html")).toHaveAttribute("lang", "en");
      await expect(popup.locator("html")).toHaveAttribute("lang", "en");
      await chooseOption(manager.locator(".settings-page").getByLabel("Interface language"), "system");
      await expect(manager.locator("html")).toHaveAttribute("lang", language.value);
      await expect(popup.locator("html")).toHaveAttribute("lang", language.value);
      const items = await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
      expect(items).toMatchObject({ ok: true, data: expect.arrayContaining([expect.objectContaining({ id: fixture.id, title: fixture.title, notes: fixture.notes, password: fixture.password }), expect.objectContaining({ title: "多语言编辑 / " + language.value, notes: "保留原文 <>& {0}" })]) });
      await manager.reload();
      await expect(manager.locator("html")).toHaveAttribute("lang", language.value);
    } finally { await context.close(); }
  });
}
