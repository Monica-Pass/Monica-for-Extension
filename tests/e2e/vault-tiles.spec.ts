import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test as base, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoginItem, TotpItem, VaultItem } from "../../src/core/model";
import { dialogContent } from "./fixtures/material";
import { homeItems } from "./fixtures/vault-home";

const time = new Date("2026-01-01T00:00:15.000Z");
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const common = { favorite: false, notes: "", createdAt: time.toISOString(), updatedAt: time.toISOString(), providerRefs: [] };
const otp: TotpItem = { ...common, id: "tile-otp", kind: "totp", title: "Studio authenticator", issuer: "Example", accountName: "studio@example.test", secret, algorithm: "SHA1", digits: 6, period: 30, otpType: "TOTP" };
const wallet = homeItems.filter(item => ["card", "identity", "billing-address", "payment-account"].includes(item.kind)).map(item => ({ ...item, providerRefs: [] }));

const test = base.extend<{ manager: Page }>({
  manager: async ({}, use) => {
    // Short, isolated profiles avoid Windows IndexedDB path limits.
    const profile = await mkdtemp(path.join(tmpdir(), "mtile-"));
    const extension = path.resolve("dist");
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true, locale: "zh-CN", reducedMotion: "reduce",
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    try {
      await context.route(/^https?:\/\//, route => route.abort());
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const page = await context.newPage();
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "Synthetic tile layout master password" }))).toMatchObject({ ok: true });
      await use(page);
    } finally {
      await context.close();
      const resolved = await realpath(profile);
      if (path.dirname(resolved) !== await realpath(tmpdir()) || !path.basename(resolved).startsWith("mtile-")) throw new Error("Unexpected tile profile path");
      await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});

async function importItems(page: Page, items: VaultItem[]) {
  expect(await page.evaluate(items => chrome.runtime.sendMessage({ type: "VAULT_IMPORT_ITEMS", items }), items)).toMatchObject({ ok: true });
  await page.reload();
}

async function navigate(page: Page, name: string) {
  const navigation = page.getByRole("button", { name: "打开导航", exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.locator("button.nav-item").filter({ hasText: name }).click();
}

function tile(page: Page, id: string) { return page.locator(`.vault-tile[data-item-id="${id}"]`); }
const grouped = (code: string) => `${code.slice(0, code.length / 2)} ${code.slice(code.length / 2)}`;

// Independent RFC 4226 oracle, rather than the application's generator.
function expectedCode(counter: number, digits = 6) {
  const movingFactor = Buffer.alloc(8);
  movingFactor.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", "12345678901234567890").update(movingFactor).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}

test("wallet tiles keep secrets masked and preserve menu detail and editing actions", async ({ manager }) => {
  await importItems(manager, wallet);
  await navigate(manager, "钱包与身份");
  await expect(manager.locator(".vault-tile")).toHaveCount(4);
  const card = tile(manager, "home-card");
  await expect(card).toContainText("•••• 1111");
  await expect(card).toContainText("MONICA DESIGN");
  await expect(card).not.toContainText("4111111111111111");
  await expect(card).not.toContainText("937");
  await expect(tile(manager, "home-identity")).toContainText("•••• 9876");
  await expect(tile(manager, "home-identity")).not.toContainText("SYNTHETIC9876");
  await card.locator(".vault-tile-menu-trigger").click();
  const menu = manager.locator(".vault-tile-menu:popover-open");
  await menu.getByRole("menuitem", { name: "查看详情", exact: true }).click();
  await expect(dialogContent(manager)).toBeVisible();
  await dialogContent(manager).getByRole("button", { name: "关闭", exact: true }).click();
  await card.locator(".vault-tile-menu-trigger").click();
  await menu.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const editor = dialogContent(manager);
  await editor.getByLabel("名称 *").fill("Updated everyday card");
  await editor.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(card).toContainText("Updated everyday card");
  expect(await manager.evaluate(async () => (await chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: "home-card" })).data)).toMatchObject({ kind: "card", number: "4111111111111111", securityCode: "937", title: "Updated everyday card" });
  await card.locator(".vault-tile-menu-trigger").click();
  manager.once("dialog", dialog => void dialog.accept());
  await menu.getByRole("menuitem", { name: "移到回收站", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(manager.locator(".vault-tile")).toHaveCount(3);
  await navigate(manager, "回收站");
  await expect(manager.getByRole("button", { name: "查看Updated everyday card详情", exact: true })).toBeVisible();
});

test("OTP tiles preview the next window, copy raw digits and refresh together", async ({ manager }) => {
  await importItems(manager, [otp, { ...otp, id: "tile-otp-8", title: "Eight digit authenticator", digits: 8 }]);
  const sourceUpdatedAt = await manager.evaluate(async id => (await chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: id })).data.updatedAt, otp.id);
  await manager.clock.install({ time: new Date(time.getTime() - 1000) });
  await manager.clock.pauseAt(time);
  await navigate(manager, "动态验证码");
  const current = expectedCode(Math.floor(time.getTime() / 30_000));
  const next = expectedCode(Math.floor(time.getTime() / 30_000) + 1);
  const card = tile(manager, otp.id);
  const copy = card.getByRole("button", { name: "复制验证码", exact: true });
  await expect(copy.locator("strong")).toHaveText(grouped(current));
  await expect(card.locator(".otp-next-code strong")).toHaveText(grouped(next));
  await expect(manager.locator(".tile-countdown")).toContainText("15 秒");
  await expect(manager.locator(".tile-countdown m3e-linear-progress-indicator")).toHaveJSProperty("value", 15);
  await copy.click();
  expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe(current);
  await manager.clock.runFor(15_000);
  await expect(copy.locator("strong")).toHaveText(grouped(next));
  await expect(manager.locator(".tile-countdown")).toContainText("30 秒");
  expect(await manager.evaluate(async id => (await chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: id })).data.updatedAt, otp.id)).toBe(sourceUpdatedAt);
});

test("mixed OTP periods retain individual timers and HOTP only advances after successful copying", async ({ manager }) => {
  const hotp = { ...otp, id: "tile-hotp", title: "Recovery device", otpType: "HOTP" as const, counter: 0 };
  await importItems(manager, [
    { ...otp, period: 45 }, hotp,
    { ...otp, id: "tile-steam", title: "Steam Guard", otpType: "STEAM", period: 90, digits: 5 },
    { ...otp, id: "tile-motp", title: "Mobile OTP", otpType: "MOTP", period: 90, secret: "0123456789abcdef", pin: "1234" }
  ]);
  await manager.clock.install({ time: new Date(time.getTime() - 1000) });
  await manager.clock.pauseAt(time);
  await navigate(manager, "动态验证码");
  await expect(manager.locator(".tile-countdown")).toHaveCount(0);
  await expect(tile(manager, "tile-steam").locator(".otp-remaining")).toHaveText("15 秒");
  await expect(tile(manager, "tile-motp").locator(".otp-remaining")).toHaveText("5 秒");
  await expect(tile(manager, otp.id).locator(".otp-remaining")).toHaveText(`${45 - Math.floor(time.getTime() / 1000) % 45} 秒`);
  const card = tile(manager, hotp.id);
  await expect(card.locator(".otp-next-code")).toHaveCount(0);
  const copy = card.getByRole("button", { name: "复制验证码并将计数器加一" });
  await expect(copy.locator("strong")).toHaveText("755 224");
  await manager.clock.runFor(30_000);
  const source = () => manager.evaluate(async id => (await chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: id })).data, hotp.id);
  expect(await source()).toMatchObject({ counter: 0 });
  await manager.evaluate(() => { Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async () => { throw new Error("Synthetic clipboard denial"); } }); });
  await copy.click();
  await expect(card.locator(".otp-copy-status")).toHaveText("复制失败");
  expect(await source()).toMatchObject({ counter: 0 });
  await manager.evaluate(() => { Reflect.deleteProperty(navigator.clipboard, "writeText"); });
  await copy.click();
  expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe("755224");
  await expect(copy.locator("strong")).toHaveText("287 082");
  expect(await source()).toMatchObject({ kind: "totp", counter: 1 });
});

test("tiles reflow across themes and enlarged text with whole-card focus and keyboard menus", async ({ manager }, testInfo) => {
  await importItems(manager, [...wallet, ...Array.from({ length: 6 }, (_, index) => ({ ...otp, id: `grid-otp-${index}`, title: ["Studio account", "Work email", "Cloud backup", "Project workspace", "Eight digit authenticator", "Travel account"][index]!, digits: index === 4 ? 8 : 6 }))]);
  for (const section of ["钱包与身份", "动态验证码"]) {
    await navigate(manager, section);
    await manager.setViewportSize({ width: 1280, height: 900 });
    expect(await manager.locator(".vault-tile-grid").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBeGreaterThan(1);
    for (const scheme of ["light", "dark"] as const) {
      await manager.emulateMedia({ colorScheme: scheme });
      await manager.screenshot({ path: testInfo.outputPath(`${section === "动态验证码" ? "otp" : "wallet"}-${scheme}-desktop.png`), fullPage: true });
    }
    await manager.setViewportSize({ width: 390, height: 844 });
    if (section === "动态验证码") expect(await manager.locator(".vault-tile-grid").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(2);
    await manager.screenshot({ path: testInfo.outputPath(`${section === "动态验证码" ? "otp" : "wallet"}-mobile.png`), fullPage: true });
    await manager.setViewportSize({ width: 320, height: 640 });
    await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await manager.screenshot({ path: testInfo.outputPath(`${section === "动态验证码" ? "otp" : "wallet"}-large-text.png`), fullPage: true });
    expect(await manager.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const value of await manager.locator(".vault-tile").evaluateAll(cards => cards.map(card => {
      const bounds = card.getBoundingClientRect();
      return { id: card.getAttribute("data-item-id"), width: card.clientWidth, scroll: card.scrollWidth, fits: bounds.left >= 0 && bounds.right <= innerWidth + 1, contentFits: card.scrollWidth <= card.clientWidth + 1 };
    }))) expect(value, JSON.stringify(value)).toMatchObject({ fits: true, contentFits: true });
    for (const fits of await manager.locator(".otp-copy-button").evaluateAll(buttons => buttons.map(button => {
      const text = button.querySelector("strong")!.getBoundingClientRect();
      const wrapper = button.shadowRoot!.querySelector(".wrapper")!.getBoundingClientRect();
      return text.left >= wrapper.left - 1 && text.right <= wrapper.right + 1;
    }))) expect(fits, "Every code digit remains visible at 200% text size").toBe(true);
    await manager.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
  }
  await manager.setViewportSize({ width: 1280, height: 900 });
  const first = manager.locator(".vault-tile").first();
  await first.locator(".vault-tile-open").getByRole("button").focus();
  const focus = await first.evaluate(card => {
    const outer = card.getBoundingClientRect();
    const ring = card.querySelector(".vault-tile-focus")!.getBoundingClientRect();
    return { width: Math.abs(outer.width - ring.width), height: Math.abs(outer.height - ring.height) };
  });
  expect(focus.width).toBeLessThanOrEqual(1);
  expect(focus.height).toBeLessThanOrEqual(1);
  const trigger = first.locator(".vault-tile-menu-trigger");
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(manager.locator(".vault-tile-menu:popover-open")).toBeVisible();
  await manager.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  const accessibility = await new AxeBuilder({ page: manager }).include(".tile-page").analyze();
  expect(accessibility.violations.filter(violation => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
});

test("Steam tiles open on demand and edit the canonical Android login item", async ({ manager }, testInfo) => {
  const steam: LoginItem = { ...common, id: "tile-steam-login", kind: "login", title: "Steam imported account", username: "synthetic-player", password: "synthetic-password", uris: ["https://steamcommunity.com"], customFields: [], totpSecret: `steam://${secret}` };
  await importItems(manager, [steam, { ...otp, id: "steam-second", title: "Steam second account", otpType: "STEAM", digits: 5 }]);
  await navigate(manager, "Steam");
  await expect(manager.locator(".vault-tile")).toHaveCount(2);
  await expect(manager.locator(".steam-account-panel")).toHaveCount(0);
  await manager.screenshot({ path: testInfo.outputPath("steam-tiles.png"), fullPage: true });
  const card = tile(manager, steam.id);
  await card.getByRole("button", { name: `查看${steam.title}详情`, exact: true }).click();
  await expect(manager.locator(".steam-account-panel")).toHaveCount(1);
  for (const tab of ["批准", "库存", "市场", "设备"]) await expect(manager.getByRole("tab", { name: tab, exact: true })).toBeVisible();
  await manager.getByRole("button", { name: "关闭 Steam 账号", exact: true }).click();
  await expect(manager.locator(".steam-account-panel")).toHaveCount(0);
  await card.locator(".vault-tile-menu-trigger").click();
  await manager.locator(".vault-tile-menu:popover-open").getByRole("menuitem", { name: "编辑", exact: true }).click();
  const editor = dialogContent(manager);
  await expect(editor.getByLabel("用户名", { exact: true })).toHaveValue(steam.username);
  await editor.getByRole("button", { name: /保存/ }).click();
  expect(await manager.evaluate(async id => (await chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: id })).data, steam.id)).toMatchObject({ kind: "login", username: steam.username, totpSecret: steam.totpSecret });
  await expect(manager.locator(".vault-tile")).toHaveCount(2);
});
