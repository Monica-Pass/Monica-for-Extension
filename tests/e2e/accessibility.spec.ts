import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function launch(testInfo: TestInfo, profile: string, options: { reducedMotion?: "reduce"; colorScheme?: "dark"; viewport?: { width: number; height: number } } = {}) {
  const extensionPath = path.resolve("dist");
  const profileDir = await mkdtemp(path.join(tmpdir(), `monica-a11y-${profile.slice(0, 8)}-`));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    reducedMotion: options.reducedMotion,
    colorScheme: options.colorScheme,
    viewport: options.viewport,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  return { context, page, extensionId, profileDir };
}

async function closeContext(context: BrowserContext | undefined, profileDir: string | undefined): Promise<void> {
  await context?.close();
  if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 3 });
}

test("auth and unlocked manager have no serious axe violations", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  let profileDir: string | undefined;
  try {
    const launched = await launch(testInfo, "manager-a11y-profile", { colorScheme: "dark" });
    context = launched.context;
    profileDir = launched.profileDir;
    await expectA11y(launched.page, "manager auth");
    await ensureVault(launched.page, "accessibility master password");
    await launched.page.reload();
    await expectA11y(launched.page, "manager overview");
    await launched.page.getByRole("button", { name: "密码源" }).click();
    await expectA11y(launched.page, "manager providers");
    await launched.page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).click();
    await expect(launched.page.getByRole("dialog", { name: "连接 Monica Android WebDAV" })).toBeVisible();
    await expectA11y(launched.page, "WebDAV dialog");
  } finally {
    await closeContext(context, profileDir);
  }
});

test("manager navigation and dialogs expose a complete keyboard focus lifecycle", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  let profileDir: string | undefined;
  try {
    const launched = await launch(testInfo, "manager-keyboard-profile");
    context = launched.context;
    profileDir = launched.profileDir;
    await ensureVault(launched.page, "keyboard focus master password");
    await launched.page.reload();
    const skipLink = launched.page.getByRole("link", { name: "跳到主内容" });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    await skipLink.press("Enter");
    await expect(launched.page.locator("#main-content")).toBeFocused();

    const providers = launched.page.getByRole("button", { name: "密码源" });
    await providers.focus();
    await providers.press("Enter");
    await expect(providers).toHaveAttribute("aria-current", "page");

    const trigger = launched.page.getByRole("button", { name: /连接 Monica Android WebDAV/ });
    await trigger.focus();
    await trigger.press("Enter");
    const dialog = launched.page.getByRole("dialog", { name: "连接 Monica Android WebDAV" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => launched.page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);

    const firstControl = dialog.getByLabel("关闭 WebDAV 设置");
    const lastControl = dialog.getByRole("button", { name: "加密保存" });
    await lastControl.focus();
    await launched.page.keyboard.press("Tab");
    await expect(firstControl).toBeFocused();
    await launched.page.keyboard.press("Shift+Tab");
    await expect(lastControl).toBeFocused();

    await launched.page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => trigger.evaluate((element) => document.activeElement === element)).toBe(true);
  } finally {
    await closeContext(context, profileDir);
  }
});

test("locked and unlocked popup states have no serious axe violations", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  let profileDir: string | undefined;
  try {
    const launched = await launch(testInfo, "popup-a11y-profile", { colorScheme: "dark" });
    context = launched.context;
    profileDir = launched.profileDir;
    const password = "popup accessibility master password";
    await ensureVault(launched.page, password);
    expect(await launched.page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });

    await context.route("https://popup-a11y.example.test/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html lang=\"zh-CN\"><title>Popup accessibility</title><label>用户名<input autocomplete=\"username\"></label><label>密码<input type=\"password\" autocomplete=\"current-password\"></label></html>"
    }));
    const site = await context.newPage();
    await site.goto("https://popup-a11y.example.test/login");
    const popup = await context.newPage();
    await site.bringToFront();
    await popup.goto(`chrome-extension://${launched.extensionId}/popup.html`);

    await expect(popup.getByText("密码库已锁定", { exact: true })).toBeVisible();
    await expectA11y(popup, "locked popup");
    await popup.getByLabel("主密码").fill(password);
    await popup.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(popup.getByText("没有匹配项", { exact: true })).toBeVisible();
    await expectA11y(popup, "unlocked empty popup");
  } finally {
    await closeContext(context, profileDir);
  }
});

test("manager remains operable with reduced motion, large text, and a narrow viewport", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  let profileDir: string | undefined;
  try {
    const launched = await launch(testInfo, "manager-responsive-a11y-profile", { reducedMotion: "reduce", viewport: { width: 375, height: 667 } });
    context = launched.context;
    profileDir = launched.profileDir;
    await ensureVault(launched.page, "responsive a11y password");
    await launched.page.reload();
    await launched.page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expect(launched.page.getByRole("heading", { name: "密码库概览" })).toBeVisible();
    const layout = await launched.page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const overflowing = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.width > 0 && bounds.right > viewportWidth + 1;
        })
        .map((element) => `${element.tagName.toLowerCase()}.${element.className || "(no-class)"}`)
        .slice(0, 20);
      return { clientWidth: viewportWidth, scrollWidth: document.documentElement.scrollWidth, overflowing };
    });
    expect(layout.scrollWidth, `right overflow: ${layout.overflowing.join(", ")}`).toBeLessThanOrEqual(layout.clientWidth);
    const motion = await launched.page.locator(".motion-card").first().evaluate((element) => getComputedStyle(element).animationDuration);
    expect(Number.parseFloat(motion) || 0).toBeLessThanOrEqual(0.001);
    await expectA11y(launched.page, "narrow 200 percent manager");
  } finally {
    await closeContext(context, profileDir);
  }
});

async function expectA11y(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const blocking = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking, `${label}: ${blocking.map((violation) => `${violation.id} (${violation.nodes.length})`).join(", ")}`).toEqual([]);
}

async function ensureVault(page: Page, password: string): Promise<void> {
  const response = await page.evaluate(async (value) => {
    const status = await chrome.runtime.sendMessage({ type: "VAULT_STATUS" }) as { ok: boolean; data?: "uninitialized" | "locked" | "unlocked" };
    if (status.data === "uninitialized") return chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: value });
    if (status.data === "locked") return chrome.runtime.sendMessage({ type: "VAULT_UNLOCK", masterPassword: value });
    return { ok: true };
  }, password);
  expect(response).toMatchObject({ ok: true });
}
