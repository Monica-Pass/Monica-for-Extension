import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

test("popup blocks and restores the focused field through the encrypted background policy", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("field-policy-profile"), {
      channel: "chromium", headless: true, viewport: { width: 390, height: 720 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await context.route("https://fields.example.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Field policy</title><form><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button id="submit">登录</button></form><script>document.querySelector("form").addEventListener("submit",event=>event.preventDefault())</script>'
    }));

    const target = await context.newPage();
    await target.goto("https://fields.example.test/login");
    await target.locator("#username").focus();
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "field policy password" }))).toMatchObject({ ok: true });
    const now = new Date().toISOString();
    const itemId = "field-policy-login";
    expect(await manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
      id: itemId, kind: "login", title: "Field account", favorite: false, notes: "", createdAt: now, updatedAt: now,
      providerRefs: [], username: "field-user", password: "field-secret", uris: ["fields.example.test"],
      uriRules: [{ uri: "fields.example.test", matchType: "base-domain" }], customFields: []
    })).toMatchObject({ ok: true });

    await target.bringToFront();
    await target.locator("#username").focus();
    const popup = await context.newPage();
    await target.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole("button", { name: "此字段不再填充" })).toBeVisible();
    await popup.getByRole("button", { name: "此字段不再填充" }).click();
    await expect(popup.getByText("此字段已排除", { exact: true })).toBeVisible();
    await expect(popup.getByText("Field account", { exact: true })).toHaveCount(0);
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await popup.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    const tabId = await manager.evaluate(async () => (await chrome.tabs.query({ url: "https://fields.example.test/*" }))[0].id);
    const directFill = await manager.evaluate(async ({ id, tab }) => chrome.runtime.sendMessage({ type: "VAULT_FILL_LOGIN", itemId: id, tabId: tab }), { id: itemId, tab: tabId });
    expect(directFill).toMatchObject({ ok: false });
    await expect(target.locator("#username")).toHaveValue("");
    await expect(target.locator("#password")).toHaveValue("");
    await target.locator("#username").fill("new-user");
    await target.locator("#password").fill("new-secret");
    await target.locator("#submit").click();
    await target.waitForTimeout(300);
    await expect(target.locator("#monica-save-prompt-host")).toHaveCount(0);

    const records = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "AUTOFILL_FIELD_POLICY_LIST" })) as { ok: boolean; data: Array<{ hostname: string; role: string; signature: string }> };
    expect(records).toMatchObject({ ok: true, data: [expect.objectContaining({ hostname: "fields.example.test", role: "username" })] });
    expect(await manager.evaluate(async (signature) => chrome.runtime.sendMessage({ type: "AUTOFILL_FIELD_POLICY_REMOVE", signature }), records.data[0].signature)).toMatchObject({ ok: true, data: true });

    await target.bringToFront();
    await target.locator("#username").focus();
    await popup.reload();
    await expect(popup.getByText("Field account", { exact: true })).toBeVisible();
    await popup.getByRole("button", { name: /Field account/ }).click();
    await expect(target.locator("#username")).toHaveValue("field-user");
    await expect(target.locator("#password")).toHaveValue("field-secret");
  } finally {
    await context?.close();
  }
});
