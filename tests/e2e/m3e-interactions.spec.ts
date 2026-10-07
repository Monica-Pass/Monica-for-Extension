import { chooseOption, dialogContent } from "./fixtures/material";
import { chromium, expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

async function start(testInfo: TestInfo) {
  const extension = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium", headless: true, locale: "zh-CN", colorScheme: "light",
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "Synthetic M3E interaction password" }))).toMatchObject({ ok: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible();
  return { page, context };
}

async function navigate(page: Page, name: RegExp) {
  await page.getByRole("navigation").getByRole("button", { name }).click();
}

test("split primary action follows each page and the menu can create another type", async ({}, testInfo) => {
  const { page, context } = await start(testInfo);
  try {
    for (const [section, button, dialog] of [
      [/^全部项目/, "新建", "添加密码"],
      [/^登录项/, "新建", "添加密码"],
      [/^API 密钥/, "新建", "添加 API 密钥"],
      [/^钱包与身份/, "添加钱包项目", "添加银行卡"],
      [/^安全笔记/, "添加安全笔记", "添加安全笔记"],
      [/^动态验证码/, "添加验证码", "添加动态验证码"]
    ] as const) {
      await navigate(page, section);
      await page.getByRole("button", { name: button, exact: true }).click();
      await expect(dialogContent(page, { name: dialog, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialogContent(page)).toHaveCount(0);
    }
    await navigate(page, /^全部项目/);
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await chooseOption(dialogContent(page, { name: "筛选密码库" }).getByRole("combobox", { name: "项目类型", exact: true }), "identity");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await expect(dialogContent(page, { name: "添加证件", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await navigate(page, /^登录项/);
    await page.getByRole("button", { name: "选择新建类型", exact: true }).click();
    const menu = page.getByRole("menu", { name: "选择新建类型" });
    await expect(menu.getByRole("menuitem")).toHaveCount(13);
    await expect(menu.getByRole("menuitem", { name: /Passkey/ })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "API Token", exact: true }).click();
    const editor = dialogContent(page, { name: "添加 API 密钥" });
    await expect(editor.getByLabel("名称 *", { exact: true })).toBeFocused();
    await editor.getByLabel("名称 *", { exact: true }).fill("Split-menu API");
    await editor.getByLabel("服务商 *", { exact: true }).fill("github");
    await editor.getByLabel("API 密钥 *", { exact: true }).fill("synthetic-split-menu-secret");
    await editor.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole("button", { name: "选择新建类型", exact: true })).toBeFocused();
    await navigate(page, /^API 密钥/);
    await expect(page.getByText("Split-menu API", { exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("split menu supports keyboard, Escape, outside dismissal and navigation", async ({}, testInfo) => {
  const { page, context } = await start(testInfo);
  try {
    const trigger = page.getByRole("button", { name: "选择新建类型", exact: true });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const menu = page.getByRole("menu", { name: "选择新建类型" });
    await expect(menu.getByRole("menuitem", { name: "密码", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "条码", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "API Key", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.press("ArrowUp");
    await expect(menu.getByRole("menuitem", { name: "条码", exact: true })).toBeFocused();
    await page.getByRole("heading", { name: "全部项目", exact: true }).click();
    await expect(menu).toBeHidden();
    await trigger.click();
    await navigate(page, /^安全笔记/);
    await expect(menu).toBeHidden();
    await expect(page.getByRole("button", { name: "添加安全笔记", exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("collapsing optional fields retains API and wallet editor drafts", async ({}, testInfo) => {
  const { page, context } = await start(testInfo);
  try {
    for (const kind of ["API Token", "银行卡"]) {
      await page.getByRole("button", { name: "选择新建类型", exact: true }).click();
      await page.getByRole("menuitem", { name: kind, exact: true }).click();
      const editor = dialogContent(page);
      const name = editor.getByLabel("名称 *", { exact: true });
      await name.fill(`Synthetic ${kind} draft`);
      const disclosure = editor.getByRole("button", { name: /^自定义字段/ });
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(editor).toBeVisible();
      await expect(name).toHaveValue(`Synthetic ${kind} draft`);
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
  } finally { await context.close(); }
});

test("a narrow enlarged menu stays reachable and transfers focus to the selected editor", async ({}, testInfo) => {
  const { page, context } = await start(testInfo);
  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    const trigger = page.getByRole("button", { name: "选择新建类型", exact: true });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "选择新建类型" });
    await expect(menu).toBeInViewport({ ratio: 1 });
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    const primaryBox = (await page.locator(".appbar-create").boundingBox())!;
    const triggerBox = (await trigger.boundingBox())!;
    const primarySurface = (await page.locator(".appbar-create .base").first().boundingBox())!;
    const triggerSurface = (await trigger.locator(".base").first().boundingBox())!;
    expect(Math.abs(primarySurface.height - triggerSurface.height)).toBeLessThan(1);
    expect(Math.abs(primarySurface.y - triggerSurface.y)).toBeLessThan(1);
    expect(primaryBox.width).toBeGreaterThanOrEqual(44);
    expect(triggerBox.width).toBeGreaterThanOrEqual(44);
    expect(primaryBox.x + primaryBox.width).toBeLessThanOrEqual(triggerBox.x + 1);
    await page.setViewportSize({ width: 320, height: 520 });
    await expect(menu).toBeInViewport({ ratio: 1 });
    await menu.getByRole("menuitem", { name: "条码", exact: true }).click();
    const editor = dialogContent(page, { name: "添加条码" });
    await expect(editor.getByLabel("名称 *", { exact: true })).toBeFocused();
    await expect(editor.getByRole("combobox", { name: "项目类型", exact: true })).toHaveJSProperty("value", "BARCODE");
    await expect(editor.getByLabel("条码内容", { exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("browsers without popovers can choose another type from the full picker", async ({}, testInfo) => {
  const { page, context } = await start(testInfo);
  try {
    await page.addInitScript(() => {
      Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: undefined });
    });
    await page.reload();
    await navigate(page, /^登录项/);
    const trigger = page.getByRole("button", { name: "选择新建类型", exact: true });
    await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await trigger.press("ArrowDown");
    const picker = dialogContent(page, { name: "新建项目", exact: true });
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await trigger.click();
    await picker.getByRole("button", { name: /API Token/ }).click();
    const editor = dialogContent(page, { name: "添加 API 密钥", exact: true });
    await expect(editor.getByLabel("名称 *", { exact: true })).toBeFocused();
  } finally { await context.close(); }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
test(`dismissing an open form picker retains the editor draft (${reducedMotion})`, async ({}, testInfo) => {
  const { page, context } = await start(testInfo);
  try {
    await page.emulateMedia({ reducedMotion });
    await navigate(page, /^登录项/);
    await page.getByRole("button", { name: "新建", exact: true }).click();
    const editor = dialogContent(page, { name: "添加密码" });
    await editor.getByLabel("名称 *", { exact: true }).fill("Keep this draft");
    const picker = editor.getByRole("combobox", { name: "项目类型", exact: true });
    await picker.click();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("名称 *", { exact: true })).toHaveValue("Keep this draft");
    await picker.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const wifiEditor = dialogContent(page, { name: "添加Wi-Fi" });
    await expect(wifiEditor.getByRole("combobox", { name: "项目类型", exact: true })).toHaveJSProperty("value", "WIFI");
    await expect(wifiEditor.getByLabel("SSID", { exact: true })).toBeVisible();
    await expect(wifiEditor.getByLabel("名称 *", { exact: true })).toHaveValue("Keep this draft");
  } finally { await context.close(); }
});
}

test("generator keyboard controls produce and retain the chosen settings", async ({}, testInfo) => {
  const { page, context } = await start(testInfo);
  try {
    await navigate(page, /^生成器/);
    const length = page.getByRole("slider", { name: /^长度：/ });
    await length.press("End");
    await length.press("ArrowLeft");
    await expect(length).toHaveJSProperty("value", 63);
    const custom = page.getByRole("radio", { name: "自定义符号集", exact: true });
    await custom.click();
    await expect(custom).toBeChecked();
    await expect(page.getByRole("radio", { name: "排除默认符号", exact: true })).not.toBeChecked();
    await page.getByRole("textbox", { name: "自定义符号集", exact: true }).fill("!@");
    await page.locator(".generator-form").getByRole("button", { name: "重新生成", exact: true }).click();
    const result = page.locator(".generator-result output");
    await expect(result).toHaveText(/^[\s\S]{63}$/);
    await expect(result).toHaveText(/[!@]/);
    await page.reload();
    await navigate(page, /^生成器/);
    await expect(length).toHaveJSProperty("value", 63);
    await expect(custom).toBeChecked();
    await expect(page.getByRole("textbox", { name: "自定义符号集", exact: true })).toHaveValue("!@");
  } finally { await context.close(); }
});

test("settings switches keep their saved state after a failed write and allow retry", async ({}, testInfo) => {
  const { page, context } = await start(testInfo);
  try {
    await navigate(page, /^设置与备份/);
    await page.evaluate(() => {
      const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
      Object.defineProperty(chrome.storage.local, "set", { configurable: true, value: (items: Record<string, unknown>) => {
        if ((window as unknown as { failSettingsWrite: boolean }).failSettingsWrite && ("monica.autofill.inline.enabled" in items || "monica.sync.preferences.v1" in items)) return Promise.reject(new Error("Synthetic settings storage failure"));
        return originalSet(items);
      } });
    });
    for (const [label, error, key, expected] of [
      ["自动同步", "未能保存同步设置，请重试。", "monica.sync.preferences.v1", { enabled: false }],
      ["表单旁自动填充", "未能保存自动填充设置，请重试。", "monica.autofill.inline.enabled", false]
    ] as const) {
      const control = page.getByRole("switch", { name: label, exact: true });
      await expect(control).toBeChecked();
      await page.evaluate(() => { (window as unknown as { failSettingsWrite: boolean }).failSettingsWrite = true; });
      await control.click();
      await expect(page.getByRole("alert").filter({ hasText: error })).toBeVisible();
      await expect(control).toBeChecked();
      expect(await page.evaluate(async key => (await chrome.storage.local.get(key))[key], key)).toBeUndefined();
      await page.evaluate(() => { (window as unknown as { failSettingsWrite: boolean }).failSettingsWrite = false; });
      await control.click();
      await expect(control).not.toBeChecked();
      await expect(page.getByRole("alert").filter({ hasText: error })).toHaveCount(0);
      expect(await page.evaluate(async key => (await chrome.storage.local.get(key))[key], key)).toEqual(expected);
    }
    await page.reload();
    await navigate(page, /^设置与备份/);
    await expect(page.getByRole("switch", { name: "自动同步", exact: true })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "表单旁自动填充", exact: true })).not.toBeChecked();
  } finally { await context.close(); }
});

test("appearance choices preserve a Nothing preference and trap keyboard focus", async ({}, testInfo) => {
  const { page, context } = await start(testInfo);
  try {
    await navigate(page, /^设置与备份/);
    const trigger = page.locator(".appearance-trigger").getByRole("button");
    await trigger.click();
    const dialog = dialogContent(page, { name: "外观", exact: true });
    const close = dialog.getByRole("button", { name: "关闭外观设置" });
    await expect(dialog.locator("m3e-button-segment").filter({ hasText: "跟随系统" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("radio", { name: "Monica", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await dialog.getByRole("radio", { name: "Nothing", exact: true }).click();
    await dialog.locator("m3e-button-segment").filter({ hasText: "深色" }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-palette", "nothing");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "选择新建类型", exact: true }).click();
    await expect(page.getByRole("menu", { name: "选择新建类型" })).toBeVisible();
  } finally { await context.close(); }
});
