import { chooseOption, dialogContent } from "./fixtures/material";
import { launchTestContext } from "./fixtures/edge";
import { expect, test, type BrowserContext, type Route } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";

const VAULT_URL = "https://bitwarden-auth.example.test";
const EMAIL = "alice@example.com";
const MASTER_PASSWORD = "bitwarden new device password";

for (const keyResponse of ['legacy', 'nested'] as const) {
test(`Bitwarden login completes current prelogin and new-device email verification (${keyResponse})`, async ({}, testInfo) => {
  const masterKey = await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 1 });
  const stretchedKey = await stretchBitwardenMasterKey(masterKey);
  const vaultKey: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };
  const protectedKey = await new BitwardenClient().protectVaultKey(vaultKey, stretchedKey, new Uint8Array(16));
  const requestedPaths: string[] = [];
  let challengedDevice: string | undefined;
  const submittedDevices: string[] = [];
  let context: BrowserContext | undefined;

  try {
    context = await launchTestContext(testInfo.outputPath("bitwarden-auth-profile"), {
      channel: "chromium",
      headless: true, locale: "zh-CN",
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`]
    });
    await context.route(`${VAULT_URL}/**`, async (route) => {
      const requestUrl = new URL(route.request().url());
      requestedPaths.push(requestUrl.pathname);
      if (requestUrl.pathname === "/identity/accounts/prelogin/password") {
        return jsonRoute(route, { Kdf: 0, KdfIterations: 1 });
      }
      if (requestUrl.pathname === "/identity/connect/token") {
        const form = new URLSearchParams(route.request().postData() || "");
        const otp = form.get("newDeviceOtp");
        const device = form.get("deviceIdentifier") || "";
        submittedDevices.push(device);
        challengedDevice ??= device;
        // Official-style verification is bound to the device receiving the challenge.
        if (otp !== "654321" || device !== challengedDevice) {
          return jsonRoute(route, { ErrorModel: { Message: "new device verification required" }, DeviceVerified: false }, 400);
        }
        return jsonRoute(route, { access_token: "access", refresh_token: "refresh", expires_in: 3600,
          ...(keyResponse === 'legacy' ? { Key: protectedKey } : { UserDecryptionOptions: {
            HasMasterPassword: true, MasterPasswordUnlock: {
              Salt: EMAIL, Kdf: { KdfType: 0, Iterations: 1 }, MasterKeyEncryptedUserKey: protectedKey
            }
          } })
        });
      }
      return route.abort("failed");
    });

    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "bitwarden auth ui password" }))).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: /连接 Bitwarden/ }).click();

    const dialog = dialogContent(page, { name: "连接 Bitwarden" });
    const region = dialog.locator("#bitwarden-server-region");
    await chooseOption(region, "eu");
    await expect(dialog.getByLabel("服务器地址 *")).toHaveValue("https://vault.bitwarden.eu");
    await chooseOption(region, "us");
    await expect(dialog.getByLabel("服务器地址 *")).toHaveValue("https://vault.bitwarden.com");
    await chooseOption(region, "custom");
    await dialog.getByLabel("服务器地址 *").fill(VAULT_URL);
    await chooseOption(region, "us");
    await chooseOption(region, "custom");
    await expect(dialog.getByLabel("服务器地址 *")).toHaveValue(VAULT_URL);
    await dialog.getByLabel("邮箱 *").fill(EMAIL);
    await dialog.getByLabel("主密码 *").fill(MASTER_PASSWORD);
    await dialog.getByRole("button", { name: "登录并连接" }).click();

    const otp = dialog.getByLabel("新设备验证码 *");
    await expect(otp).toBeVisible();
    await expect(dialog).toContainText("Bitwarden 已向账号邮箱发送新设备验证码");
    await otp.fill("111111");
    await dialog.getByRole("button", { name: "验证新设备并连接" }).click();
    await expect(dialog.getByRole("alert")).toContainText("新设备验证码错误或已过期");
    // Switching the server invalidates a code issued for the previous form binding.
    await chooseOption(region, "eu");
    await expect(otp).toHaveCount(0);
    await chooseOption(region, "custom");
    await dialog.getByRole("button", { name: "登录并连接" }).click();
    await expect(otp).toBeVisible();
    await expect(otp).toHaveValue("");
    await fs.mkdir("docs/design/bitwarden-login-20261030", { recursive: true });
    await page.screenshot({ path: "docs/design/bitwarden-login-20261030/edge-login.png", fullPage: true });
    await otp.fill("654321");
    await dialog.getByRole("button", { name: "验证新设备并连接" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Bitwarden 已连接；点击立即同步导入密码库。", { exact: true })).toBeVisible();
    expect(requestedPaths).toContain("/identity/accounts/prelogin/password");
    expect(requestedPaths).not.toContain("/identity/accounts/prelogin");
    expect(new Set(submittedDevices).size).toBe(1);
  } finally {
    await context?.close();
  }
});
}

for (const reset of ["none", "password", "server", "email", "close"] as const) {
  test(`Bitwarden retains new-device verification through subsequent email two-factor retries (${reset})`, async ({}, testInfo) => {
    const masterKey = await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 1 });
    const stretchedKey = await stretchBitwardenMasterKey(masterKey);
    const protectedKey = await new BitwardenClient().protectVaultKey({ encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) }, stretchedKey, new Uint8Array(16));
    const tokenRequests: URLSearchParams[] = [];
    let emailRequests = 0;
    let context: BrowserContext | undefined;
    try {
      context = await launchTestContext(testInfo.outputPath("bitwarden-combined-auth-profile"), {
        channel: "chromium", headless: true, locale: "zh-CN",
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`]
      });
      await context.route(`${VAULT_URL}/**`, async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: 1 });
        if (pathname === "/api/two-factor/send-email-login") {
          emailRequests++;
          expect(route.request().postDataJSON().deviceIdentifier).toBe(tokenRequests[0].get("deviceIdentifier"));
          return route.fulfill({ status: 200, body: "" });
        }
        if (pathname !== "/identity/connect/token") return route.abort("failed");
        const form = new URLSearchParams(route.request().postData() || "");
        tokenRequests.push(form);
        if (form.get("newDeviceOtp") !== "654321") {
          return jsonRoute(route, { error: "device_error", ErrorModel: { Message: "new device verification required" } }, 400);
        }
        if (form.get("twoFactorProvider") !== "1" || form.get("twoFactorToken") !== "246810") {
          // The official protocol can return the providers again for an invalid code.
          return jsonRoute(route, { error: "invalid_grant", TwoFactorProviders2: { "0": {}, "1": { Email: "a***@example.com" } } }, 400);
        }
        return jsonRoute(route, { access_token: "access", refresh_token: "refresh", expires_in: 3600, Key: protectedKey });
      });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const page = await context.newPage();
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      const setup = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "combined auth ui password" }));
      expect(setup, JSON.stringify(setup)).toMatchObject({ ok: true });
      await page.reload();
      await page.getByRole("button", { name: "密码源" }).click();
      await page.getByRole("button", { name: /连接 Bitwarden/ }).click();
      const dialog = dialogContent(page, { name: "连接 Bitwarden" });
      await chooseOption(dialog.locator("#bitwarden-server-region"), "custom");
      await dialog.getByLabel("服务器地址 *").fill(VAULT_URL);
      await dialog.getByLabel("邮箱 *").fill(EMAIL);
      await dialog.getByLabel("主密码 *").fill(MASTER_PASSWORD);
      await dialog.getByRole("button", { name: "登录并连接" }).click();
      await dialog.getByLabel("新设备验证码 *").fill("654321");
      await dialog.getByRole("button", { name: "验证新设备并连接" }).click();
      const method = dialog.getByRole("combobox", { name: "两步验证方式" });
      await chooseOption(method, { label: "邮箱" });
      await dialog.getByRole("button", { name: "发送邮箱验证码" }).click();
      await expect.poll(() => emailRequests).toBe(1);
      if (reset !== "none") {
        if (reset === "close") {
          await dialog.getByRole("button", { name: "取消", exact: true }).click();
          await expect(dialog).toHaveCount(0);
          await page.getByRole("button", { name: /连接 Bitwarden/ }).click();
          await chooseOption(dialog.locator("#bitwarden-server-region"), "custom");
          await dialog.getByLabel("服务器地址 *").fill(VAULT_URL);
          await dialog.getByLabel("邮箱 *").fill(EMAIL);
          await dialog.getByLabel("主密码 *").fill(MASTER_PASSWORD);
        } else {
          const binding = reset === "password" ? dialog.getByLabel("主密码 *") : reset === "email" ? dialog.getByLabel("邮箱 *") : dialog.getByLabel("服务器地址 *");
          const value = await binding.inputValue();
          await binding.fill(reset === "server" ? "https://another-auth.example.test" : `${value}x`);
          await expect(method).toHaveCount(0);
          await binding.fill(value);
        }
        await expect(dialog.getByLabel("新设备验证码 *")).toHaveCount(0);
        await dialog.getByRole("button", { name: "登录并连接" }).click();
        await dialog.getByLabel("新设备验证码 *").fill("654321");
        expect(tokenRequests.at(-1)?.get("newDeviceOtp")).toBeNull();
        expect(tokenRequests.at(-1)?.get("twoFactorToken")).toBeNull();
        await dialog.getByRole("button", { name: "验证新设备并连接" }).click();
        await chooseOption(method, { label: "邮箱" });
      }
      const challengedRequests = tokenRequests.length;
      await dialog.getByLabel("验证码 *", { exact: true }).fill("111111");
      await dialog.getByRole("button", { name: "验证并连接" }).click();
      await expect.poll(() => tokenRequests.length).toBe(challengedRequests + 1);
      expect(tokenRequests.at(-1)?.get("newDeviceOtp")).toBe("654321");
      await expect(dialog.getByRole("alert")).toContainText("两步验证码错误或已过期");
      await expect(method).toHaveJSProperty("value", 1);
      await dialog.getByLabel("验证码 *", { exact: true }).fill("246810");
      await dialog.getByRole("button", { name: "验证并连接" }).click();
      await expect(dialog).toHaveCount(0);
      expect(tokenRequests).toHaveLength(challengedRequests + 2);
      expect(new Set(tokenRequests.map(form => form.get("deviceIdentifier"))).size).toBe(1);
      expect(tokenRequests.filter(form => form.has("twoFactorToken")).every(form => form.get("newDeviceOtp") === "654321")).toBe(true);
      // Codes belong only to this login attempt, never persistent extension storage.
      const storage = await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
      expect(storage).not.toContain("654321");
      expect(storage).not.toContain("246810");
    } finally {
      await context?.close();
    }
  });
}

test("Bitwarden retains email two-factor verification when the device challenge follows it", async ({}, testInfo) => {
  const masterKey = await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 1 });
  const stretchedKey = await stretchBitwardenMasterKey(masterKey);
  const protectedKey = await new BitwardenClient().protectVaultKey({ encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) }, stretchedKey, new Uint8Array(16));
  const tokenRequests: URLSearchParams[] = [];
  let context: BrowserContext | undefined;
  try {
    context = await launchTestContext(testInfo.outputPath("bitwarden-factor-first-profile"), {
      channel: "chromium", headless: true, locale: "zh-CN",
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`]
    });
    await context.route(`${VAULT_URL}/**`, async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: 1 });
      if (pathname !== "/identity/connect/token") return route.abort("failed");
      const form = new URLSearchParams(route.request().postData() || "");
      tokenRequests.push(form);
      if (form.get("twoFactorProvider") !== "1" || form.get("twoFactorToken") !== "246810") {
        return jsonRoute(route, { error: "invalid_grant", TwoFactorProviders2: { "1": {} } }, 400);
      }
      if (form.get("newDeviceOtp") !== "654321") return jsonRoute(route, { ErrorModel: { Message: "new device verification required" } }, 400);
      return jsonRoute(route, { access_token: "access", refresh_token: "refresh", expires_in: 3600, Key: protectedKey });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "factor first auth ui password" }))).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: /连接 Bitwarden/ }).click();
    const dialog = dialogContent(page, { name: "连接 Bitwarden" });
    await chooseOption(dialog.locator("#bitwarden-server-region"), "custom");
    await dialog.getByLabel("服务器地址 *").fill(VAULT_URL);
    await dialog.getByLabel("邮箱 *").fill(EMAIL);
    await dialog.getByLabel("主密码 *").fill(MASTER_PASSWORD);
    await dialog.getByRole("button", { name: "登录并连接" }).click();
    await dialog.getByLabel("验证码 *", { exact: true }).fill("246810");
    await dialog.getByRole("button", { name: "验证并连接" }).click();
    await dialog.getByLabel("新设备验证码 *").fill("654321");
    await dialog.getByRole("button", { name: "验证新设备并连接" }).click();
    await expect(dialog).toHaveCount(0);
    expect(tokenRequests).toHaveLength(3);
    expect(tokenRequests[2].get("twoFactorProvider")).toBe("1");
    expect(tokenRequests[2].get("twoFactorToken")).toBe("246810");
    expect(tokenRequests[2].get("newDeviceOtp")).toBe("654321");
    expect(new Set(tokenRequests.map(form => form.get("deviceIdentifier"))).size).toBe(1);
  } finally {
    await context?.close();
  }
});

function jsonRoute(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
