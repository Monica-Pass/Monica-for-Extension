import { chromium, expect, test, type BrowserContext, type Route } from "@playwright/test";
import path from "node:path";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";

const VAULT_URL = "https://bitwarden-auth.example.test";
const EMAIL = "alice@example.com";
const MASTER_PASSWORD = "bitwarden new device password";

test("Bitwarden login completes current prelogin and new-device email verification", async ({}, testInfo) => {
  const masterKey = await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 1 });
  const stretchedKey = await stretchBitwardenMasterKey(masterKey);
  const vaultKey: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };
  const protectedKey = await new BitwardenClient().protectVaultKey(vaultKey, stretchedKey, new Uint8Array(16));
  const requestedPaths: string[] = [];
  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("bitwarden-auth-profile"), {
      channel: "chromium",
      headless: true,
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
        if (otp !== "654321") {
          return jsonRoute(route, { ErrorModel: { Message: "new device verification required" }, DeviceVerified: false }, 400);
        }
        return jsonRoute(route, { access_token: "access", refresh_token: "refresh", expires_in: 3600, Key: protectedKey });
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

    const dialog = page.getByRole("dialog", { name: "连接 Bitwarden" });
    await dialog.getByLabel("服务器地址 *").fill(VAULT_URL);
    await dialog.getByLabel("邮箱 *").fill(EMAIL);
    await dialog.getByLabel("主密码 *").fill(MASTER_PASSWORD);
    await dialog.getByRole("button", { name: "登录并连接" }).click();

    const otp = dialog.getByLabel("新设备验证码 *");
    await expect(otp).toBeVisible();
    await expect(dialog).toContainText("Bitwarden 已向账号邮箱发送新设备验证码");
    await otp.fill("111111");
    await dialog.getByRole("button", { name: "验证新设备并连接" }).click();
    await expect(dialog.getByRole("alert")).toContainText("新设备验证码错误或已过期");
    await otp.fill("654321");
    await dialog.getByRole("button", { name: "验证新设备并连接" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Bitwarden 已连接；点击立即同步导入密码库。", { exact: true })).toBeVisible();
    expect(requestedPaths).toContain("/identity/accounts/prelogin/password");
    expect(requestedPaths).not.toContain("/identity/accounts/prelogin");
  } finally {
    await context?.close();
  }
});

function jsonRoute(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
