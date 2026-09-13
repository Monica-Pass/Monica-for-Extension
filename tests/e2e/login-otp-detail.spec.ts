import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test as base, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoginItem, TotpItem, VaultItem } from "../../src/core/model";

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const time = new Date("2026-01-01T00:00:15.000Z");
const common = { favorite: false, notes: "", createdAt: time.toISOString(), updatedAt: time.toISOString(), providerRefs: [] };
const login: LoginItem = { ...common, id: "login-with-otp", kind: "login", title: "Login with OTP", username: "synthetic-user", password: "synthetic-password", uris: ["https://otp.example.test"], customFields: [] };
const authenticator: TotpItem = { ...common, id: "linked-otp", kind: "totp", title: "Linked authenticator", secret, algorithm: "SHA1", digits: 6, period: 30, otpType: "TOTP" };

// Independent RFC 4226 oracle: do not compare the display with its own generator.
function expectedCode(counter: number, algorithm = "sha1", digits = 6): string {
  const movingFactor = Buffer.alloc(8);
  movingFactor.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, "12345678901234567890").update(movingFactor).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}

const test = base.extend<{ manager: Page }>({
  manager: async ({}, use) => {
    const profile = await mkdtemp(path.join(tmpdir(), "monica-otp-"));
    const extension = path.resolve("dist");
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true, locale: "zh-CN", reducedMotion: "reduce",
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const origin = `chrome-extension://${new URL(worker.url()).host}`;
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const page = await context.newPage();
      await page.goto(`${origin}/index.html`);
      expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "OTP detail synthetic master password" }))).toMatchObject({ ok: true });
      await use(page);
    } finally {
      await context.close();
      const resolved = await realpath(profile);
      const temp = await realpath(tmpdir());
      if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith("monica-otp-")) throw new Error("Unexpected OTP fixture path");
      await rm(resolved, { recursive: true, force: true });
    }
  }
});

async function openLogin(page: Page, items: VaultItem[]) {
  expect(await page.evaluate(items => chrome.runtime.sendMessage({ type: "VAULT_IMPORT_ITEMS", items }), items)).toMatchObject({ ok: true });
  await page.reload();
  await page.locator("button.nav-item").filter({ hasText: "登录项" }).click();
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.getByRole("button", { name: "查看Login with OTP详情", exact: true }).click();
  return page.getByRole("dialog", { name: /Login with OTP/ });
}

for (const input of [
  { name: "Base32", value: secret, digits: 6, period: 30, algorithm: "sha1" },
  { name: "otpauth URI", value: `otpauth://totp/Example:synthetic?secret=${secret}&algorithm=SHA256&digits=8&period=45`, digits: 8, period: 45, algorithm: "sha256" }
]) {
  test(`login details show, copy and refresh an inline ${input.name} code`, async ({ manager }) => {
    const detail = await openLogin(manager, [{ ...login, totpSecret: input.value }]);
    const code = detail.getByRole("button", { name: "复制验证码", exact: true });
    const now = time.getTime() / 1000;
    const current = expectedCode(Math.floor(now / input.period), input.algorithm, input.digits);
    await expect(code.locator("strong")).toHaveText(current);
    await expect(detail.getByText("已绑定验证器", { exact: true })).toHaveCount(0);
    await expect(detail.getByText("synthetic-password", { exact: true })).toHaveCount(0);
    await expect(detail.getByText(input.value, { exact: true })).toHaveCount(0);
    await code.click();
    expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe(current);
    await expect(detail.locator('[aria-live="polite"]')).toContainText("已复制");

    const untilNext = input.period - now % input.period;
    await expect(detail.locator(".totp-code-cell")).toContainText(`${untilNext} 秒`);
    await manager.clock.runFor(1000);
    await expect(detail.locator(".totp-code-cell")).toContainText(`${untilNext - 1} 秒`);
    await manager.clock.runFor((untilNext - 1) * 1000);
    const next = expectedCode(Math.floor(now / input.period) + 1, input.algorithm, input.digits);
    await expect(code.locator("strong")).toHaveText(next);
    await code.click();
    expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe(next);

    // A click can cross the period boundary before the next scheduled tick.
    await manager.clock.setSystemTime(new Date((now + untilNext + input.period) * 1000));
    await code.click();
    expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe(expectedCode(Math.floor(now / input.period) + 2, input.algorithm, input.digits));

    await manager.clock.resume();
    const accessibility = await new AxeBuilder({ page: manager }).include('[role="dialog"]').analyze();
    expect(accessibility.violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
}

test("editing an Android legacy binding preserves its selection and an explicit unlink survives reopening", async ({ manager }) => {
  const providers = await manager.evaluate(() => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" }));
  expect(providers).toMatchObject({ ok: true });
  const providerId = providers.data.find((provider: { kind: string }) => provider.kind === "local").id;
  const references = [{ providerId, remoteId: "folders/_root/passwords/password_42_1700000000000.json" }];
  const detail = await openLogin(manager, [
    { ...login, providerRefs: references },
    { ...authenticator, boundPasswordId: 42, providerRefs: [{ providerId }] }
  ]);
  await manager.clock.resume();
  await expect(detail.locator(".totp-code-cell")).toBeVisible();
  await detail.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = manager.getByRole("dialog", { name: "编辑登录项", exact: true });
  await expect(editor.getByRole("combobox", { name: "绑定独立验证器", exact: true })).toHaveValue(authenticator.id);
  await editor.getByRole("combobox", { name: "绑定独立验证器", exact: true }).selectOption("");
  await editor.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect((await manager.evaluate(itemId => chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId }), login.id)).data).toMatchObject({ boundTotpItemId: "", password: login.password });
  await manager.reload();
  await manager.locator("button.nav-item").filter({ hasText: "登录项" }).click();
  await manager.getByRole("button", { name: "查看Login with OTP详情", exact: true }).click();
  await expect(manager.getByRole("dialog").locator(".totp-code-cell")).toHaveCount(0);
});

test("a linked authenticator takes priority and fits narrow translated details", async ({ manager }, testInfo) => {
  const detail = await openLogin(manager, [
    { ...login, boundTotpItemId: authenticator.id, totpSecret: "INVALID INLINE FALLBACK" },
    { ...authenticator, algorithm: "SHA256", digits: 8, period: 45, archivedAt: time.toISOString() }
  ]);
  const current = expectedCode(Math.floor(time.getTime() / 1000 / 45), "sha256", 8);
  const code = detail.locator(".totp-code-cell button");
  await expect(code.locator("strong")).toHaveText(current);
  await code.click();
  expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe(current);
  await manager.emulateMedia({ colorScheme: "dark" });
  await manager.clock.runFor(1600);
  await manager.screenshot({ path: testInfo.outputPath("login-otp-detail-desktop.png"), fullPage: true });
  await manager.setViewportSize({ width: 320, height: 640 });
  await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  for (const locale of ["zh-CN", "en", "ja", "ko", "de", "es", "ru", "vi"]) {
    await manager.evaluate(locale => chrome.storage.local.set({ "monica.locale": locale }), locale);
    await expect(manager.locator("html")).toHaveAttribute("lang", locale);
    await expect(code.locator("strong")).toHaveText(current);
    expect(await code.evaluate(el => {
      const bounds = el.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth && el.scrollWidth <= el.clientWidth;
    }), locale).toBe(true);
    expect(await code.locator("strong").evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    }), locale).toBe(1);
    expect(await manager.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), locale).toBe(true);
  }
  await manager.evaluate(() => { document.documentElement.style.fontSize = "100%"; return chrome.storage.local.set({ "monica.locale": "zh-CN" }); });
  await manager.setViewportSize({ width: 390, height: 844 });
  await expect(manager.locator("html")).toHaveAttribute("lang", "zh-CN");
  await manager.screenshot({ path: testInfo.outputPath("login-otp-detail-mobile.png"), fullPage: true });
  await manager.clock.resume();
  const accessibility = await new AxeBuilder({ page: manager }).include('[role="dialog"]').analyze();
  expect(accessibility.violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

for (const linked of [false, true]) {
  test(`${linked ? "linked" : "inline"} HOTP advances only after copying and persists on reopening`, async ({ manager }) => {
    const inlineUri = `otpauth://hotp/Example?secret=${secret}&counter=0`;
    const detail = await openLogin(manager, linked
      ? [{ ...login, boundTotpItemId: authenticator.id }, { ...authenticator, otpType: "HOTP", counter: 0 }]
      : [{ ...login, totpSecret: inlineUri }]);
    const code = detail.getByRole("button", { name: "复制验证码并将计数器加一" });
    await expect(code.locator("strong")).toHaveText("755224");
    const itemId = linked ? authenticator.id : login.id;
    const readSource = () => manager.evaluate(async itemId => (await chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId })).data, itemId);
    expect(await readSource()).toMatchObject(linked ? { counter: 0 } : { totpSecret: inlineUri });

    await code.click();
    expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe("755224");
    await expect(code.locator("strong")).toHaveText("287082");
    await expect(detail.locator(".totp-code-cell")).toContainText("计数 1");
    if (linked) expect(await readSource()).toMatchObject({ counter: 1 });
    else expect(new URL((await readSource()).totpSecret).searchParams.get("counter")).toBe("1");
    await code.click();
    expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe("287082");
    await expect(code.locator("strong")).toHaveText("359152");
    await detail.getByRole("button", { name: "关闭", exact: true }).click();
    await manager.reload();
    await manager.locator("button.nav-item").filter({ hasText: "登录项" }).click();
    await manager.getByRole("button", { name: "查看Login with OTP详情", exact: true }).click();
    await expect(manager.getByRole("dialog").getByRole("button", { name: "复制验证码并将计数器加一" }).locator("strong")).toHaveText("359152");
  });
}

test("invalid secrets and missing bindings show unavailable, never a copyable placeholder", async ({ manager }) => {
  const detail = await openLogin(manager, [{ ...login, totpSecret: "not a valid OTP secret!" }]);
  await expect(detail.getByText("不可用", { exact: true })).toBeVisible();
  await expect(detail.locator(".totp-code-cell button:enabled")).toHaveCount(0);
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  expect(await manager.evaluate(item => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), { ...login, boundTotpItemId: "missing-authenticator" })).toMatchObject({ ok: true });
  await manager.reload();
  await manager.locator("button.nav-item").filter({ hasText: "登录项" }).click();
  await manager.getByRole("button", { name: "查看Login with OTP详情", exact: true }).click();
  await expect(detail.getByText("不可用", { exact: true })).toBeVisible();
  await expect(detail.locator(".totp-code-cell button:enabled")).toHaveCount(0);
});

test("a failed clipboard write leaves the HOTP counter unchanged", async ({ manager }) => {
  const detail = await openLogin(manager, [{ ...login, boundTotpItemId: authenticator.id }, { ...authenticator, otpType: "HOTP", counter: 0 }]);
  const code = detail.getByRole("button", { name: "复制验证码并将计数器加一" });
  await expect(code.locator("strong")).toHaveText("755224");
  await manager.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new DOMException("Fixture clipboard denial", "NotAllowedError")) });
  });
  await code.click();
  await expect(detail.locator(".otp-copy-status")).toHaveText("复制失败");
  expect(await manager.evaluate(async itemId => (await chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId })).data.counter, authenticator.id)).toBe(0);
  await manager.evaluate(() => { Reflect.deleteProperty(navigator.clipboard, "writeText"); });
  await code.click();
  expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe("755224");
  await expect(code.locator("strong")).toHaveText("287082");
});

test("HOTP copying waits for a pending counter save before allowing another use", async ({ manager }) => {
  const detail = await openLogin(manager, [{ ...login, boundTotpItemId: authenticator.id }, { ...authenticator, otpType: "HOTP", counter: 0 }]);
  const code = detail.getByRole("button", { name: "复制验证码并将计数器加一" });
  await expect(code.locator("strong")).toHaveText("755224");
  await manager.evaluate(() => {
    const fixture = window as unknown as { otpCounterSave: { writes: number; release?: () => Promise<void> } };
    fixture.otpCounterSave = { writes: 0 };
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((message: { type: string }) => {
      if (message.type !== "VAULT_UPSERT_ITEM") return send(message);
      fixture.otpCounterSave.writes++;
      return new Promise(resolve => { fixture.otpCounterSave.release = async () => { resolve(await send(message)); }; });
    }) as typeof chrome.runtime.sendMessage;
  });
  await code.click();
  await expect(code).toBeDisabled();
  expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe("755224");
  await code.evaluate(button => (button as HTMLButtonElement).click());
  expect(await manager.evaluate(() => (window as unknown as { otpCounterSave: { writes: number } }).otpCounterSave.writes)).toBe(1);
  await manager.evaluate(() => (window as unknown as { otpCounterSave: { release: () => Promise<void> } }).otpCounterSave.release());
  await expect(code).toBeEnabled();
  await expect(code.locator("strong")).toHaveText("287082");
  expect(await manager.evaluate(async itemId => (await chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId })).data.counter, authenticator.id)).toBe(1);
});

test("login OTP clears while hidden, refreshes on return and is removed when locked", async ({ manager }) => {
  const detail = await openLogin(manager, [{ ...login, totpSecret: secret }]);
  const code = detail.getByRole("button", { name: "复制验证码", exact: true });
  await expect(code.locator("strong")).toHaveText(expectedCode(Math.floor(time.getTime() / 1000 / 30)));
  await manager.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(code).toBeDisabled();
  await expect(code.locator("strong")).toHaveText("•••••");
  await manager.clock.runFor(60_000);
  await expect(code.locator("strong")).toHaveText("•••••");
  await manager.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(code).toBeEnabled();
  await expect(code.locator("strong")).toHaveText(expectedCode(Math.floor(time.getTime() / 1000 / 30) + 2));
  expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
  await expect(detail).toHaveCount(0);
  await expect(manager.locator(".totp-code-cell")).toHaveCount(0);
});
