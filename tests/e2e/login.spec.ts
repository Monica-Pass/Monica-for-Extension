import { expect, test, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";

test("login popup fills username, password, and TOTP through the MV3 background boundary", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;

    await context.route("https://login.example.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Example Login</title><form>
        <label>Email <input id="username" autocomplete="username"></label>
        <label>Password <input id="password" type="password" autocomplete="current-password"></label>
        <label>Code <input id="otp" autocomplete="one-time-code"></label>
        <label>Tenant ID <input id="tenant" aria-label="Tenant ID"></label>
      </form>`
    }));

    const loginPage = await context.newPage();
    await loginPage.goto("https://login.example.test/sign-in");
    await expect(loginPage.locator("#password")).toBeVisible();

    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    const setupResult = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "e2e master password" }));
    expect(setupResult).toMatchObject({ ok: true });
    const now = new Date().toISOString();
    const item = {
      id: "e2e-login",
      kind: "login",
      title: "Example account",
      favorite: true,
      notes: "",
      createdAt: now,
      updatedAt: now,
      providerRefs: [],
      username: "joy@example.com",
      password: "correct horse battery staple",
      uris: ["login.example.test"],
      uriRules: [{ uri: "https://login.example.test/sign-in", matchType: "exact" }],
      totpSecret: "JBSWY3DPEHPK3PXP",
      customFields: [{ name: "Tenant ID", value: "monica-cn", protected: false }]
    };
    const saveResult = await manager.evaluate(async (value) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: value }), item);
    expect(saveResult).toMatchObject({ ok: true });

    await loginPage.bringToFront();
    const popup = await context.newPage();
    await loginPage.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByText("Example account")).toBeVisible();
    await popup.getByRole("button", { name: /Example account/ }).click();

    await expect(loginPage.locator("#username")).toHaveValue("joy@example.com");
    await expect(loginPage.locator("#password")).toHaveValue("correct horse battery staple");
    await expect(loginPage.locator("#otp")).toHaveValue(/^\d{6}$/);
    await expect(loginPage.locator("#tenant")).toHaveValue("monica-cn");
  } finally {
    await context?.close();
  }
});

test("manager saves a metadata-only SSO login with empty username, password, and URI", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("empty-sso-profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "metadata login password" }))).toMatchObject({ ok: true });
    await manager.reload();
    await manager.getByRole("button", { name: "添加登录项" }).click();
    await manager.getByLabel("名称 *").fill("Company SSO");
    await manager.getByRole("radio", { name: "SSO", exact: true }).check();
    await manager.getByLabel("SSO 提供商").fill("GOOGLE");
    await manager.screenshot({ path: testInfo.outputPath("metadata-login-editor.png"), fullPage: true });
    await manager.getByRole("button", { name: "加密保存" }).click();
    await manager.getByRole("button", { name: /^登录项/ }).click();
    await expect(manager.getByText("Company SSO", { exact: true })).toBeVisible();

    const response = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<Record<string, unknown>> };
    expect(response).toMatchObject({ ok: true });
    expect(response.data).toEqual([expect.objectContaining({ title: "Company SSO", username: "", password: "", uris: [], uriRules: [], loginType: "SSO", ssoProvider: "GOOGLE" })]);
  } finally {
    await context?.close();
  }
});

test("popup shows top-level parent-RP Passkey status without exposing a signing action", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("passkey-status-profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await context.route("https://login.accounts.example.co.uk/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Passkey-only site</title>" }));
    const page = await context.newPage();
    await page.goto("https://login.accounts.example.co.uk/");
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "passkey status password" }))).toMatchObject({ ok: true });
    const now = new Date().toISOString();
    for (const item of [
      { id: "ready-parent-passkey", kind: "passkey", title: "Ready parent account", favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], credentialId: "AQID", rpId: "example.co.uk", rpName: "Example", userHandle: "dXNlcg", userName: "joy", userDisplayName: "Joy", algorithm: -7, publicKey: "public", privateKeyPkcs8: "private", signCount: 0, discoverable: true, useCount: 2, sourceMode: "browser-local" },
      { id: "android-parent-passkey", kind: "passkey", title: "Android reference", favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], credentialId: "BAUG", rpId: "example.co.uk", rpName: "Example", userHandle: "dXNlcg", userName: "android", userDisplayName: "Android", algorithm: -7, publicKey: "public", signCount: 0, discoverable: true, sourceMode: "android-metadata-only" }
    ]) expect(await manager.evaluate(async (value) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: value }), item)).toMatchObject({ ok: true });
    await page.bringToFront();
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 375, height: 667 });
    await page.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByText("Ready parent account", { exact: true })).toBeVisible();
    await expect(popup.getByText("已保存，等待网站请求", { exact: true })).toBeVisible();
    await expect(popup.getByText("仅兼容保留，不能登录", { exact: true })).toBeVisible();
    await expect(popup.getByRole("button", { name: /Ready parent account/ })).toHaveCount(0);
    expect(await popup.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))).toMatchObject({ client: 375, scroll: 375 });
    await popup.setViewportSize({ width: 500, height: 667 });
    expect(await popup.locator(".popup-shell").evaluate((element) => element.getBoundingClientRect().width)).toBe(390);
  } finally {
    await context?.close();
  }
});

test("login popup discovers and safely fills a cross-origin login frame", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("frame-profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await context.route("https://app.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<title>Example App</title><iframe id="login-frame" src="https://auth.example.test/frame"></iframe>' }));
    await context.route("https://auth.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<title>Embedded Login</title><form><input id="username" autocomplete="username"><input id="password" type="password"></form>' }));

    const appPage = await context.newPage();
    await appPage.goto("https://app.example.test/");
    await expect(appPage.frameLocator("#login-frame").locator("#password")).toBeVisible();
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "frame master password" }));
    const now = new Date().toISOString();
    await manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
      id: "frame-login",
      kind: "login",
      title: "Embedded account",
      favorite: false,
      notes: "",
      createdAt: now,
      updatedAt: now,
      providerRefs: [],
      username: "frame-user",
      password: "frame-secret",
      uris: ["auth.example.test"],
      customFields: []
    });

    await appPage.bringToFront();
    const popup = await context.newPage();
    await appPage.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByText("嵌入登录框", { exact: false })).toBeVisible();
    await popup.getByRole("button", { name: /Embedded account/ }).click();
    await expect(appPage.frameLocator("#login-frame").locator("#username")).toHaveValue("frame-user");
    await expect(appPage.frameLocator("#login-frame").locator("#password")).toHaveValue("frame-secret");
  } finally {
    await context?.close();
  }
});
