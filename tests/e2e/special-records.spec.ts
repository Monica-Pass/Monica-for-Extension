import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";

async function openLoginEditor(manager: Page): Promise<void> {
  await manager.getByRole("button", { name: /^登录项/ }).click();
  await manager.getByRole("button", { name: "添加登录项" }).first().click();
}

test("manager edits Android Wi-Fi SSH key and barcode records with local QR operations", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("special-records-profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "special records password" }))).toMatchObject({ ok: true });
    await manager.reload();

    await openLoginEditor(manager);
    await manager.getByLabel("名称 *", { exact: true }).fill("Monica Lab Wi-Fi");
    await manager.getByLabel("Wi-Fi", { exact: true }).check();
    await manager.getByLabel("SSID", { exact: true }).fill("Monica;Lab");
    await manager.getByLabel("BSSID", { exact: true }).fill("00:11:22:33:44:55");
    await manager.getByLabel("隐藏网络", { exact: true }).check();
    await manager.getByLabel("企业身份（Identity）", { exact: true }).fill("joy");
    await manager.getByRole("button", { name: "生成二维码" }).click();
    await expect(manager.getByAltText("WIFI 二维码")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await manager.getByRole("button", { name: "复制", exact: true }).click();
    await manager.getByRole("button", { name: "加密保存" }).click();

    await openLoginEditor(manager);
    await manager.getByLabel("名称 *", { exact: true }).fill("Monica SSH");
    await manager.getByLabel("SSH 密钥", { exact: true }).check();
    await manager.getByLabel("算法", { exact: true }).fill("ED25519");
    await manager.getByLabel("密钥位数", { exact: true }).fill("256");
    await manager.getByLabel("OpenSSH 公钥", { exact: true }).fill("ssh-ed25519 AAAAC3Nza monica");
    await manager.getByLabel("OpenSSH 私钥", { exact: true }).fill("-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----");
    await manager.getByLabel("SHA-256 指纹", { exact: true }).fill("SHA256:monica");
    await manager.getByLabel("注释", { exact: true }).fill("joy@monica");
    await manager.getByRole("button", { name: "生成二维码" }).click();
    await expect(manager.getByAltText("SSH_KEY 二维码")).toBeVisible();
    await manager.getByRole("button", { name: "加密保存" }).click();

    await openLoginEditor(manager);
    await manager.getByLabel("名称 *", { exact: true }).fill("Membership Barcode");
    await manager.getByLabel("条码", { exact: true }).check();
    await manager.getByRole("button", { name: "加密保存" }).click();

    const response = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<Record<string, unknown>> };
    expect(response.ok).toBe(true);
    const wifi = response.data.find((item) => item.title === "Monica Lab Wi-Fi")!;
    expect(wifi).toMatchObject({ loginType: "WIFI", username: "joy", password: "" });
    expect(JSON.parse(String(wifi.wifiMetadata))).toMatchObject({ ssid: "Monica;Lab", security: "WPA2_WPA3", hiddenNetwork: true, bssid: "00:11:22:33:44:55" });
    expect(await manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: { ...item, password: "wifi-secret" } }), wifi)).toMatchObject({ ok: true });
    const passwordRoundTrip = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<Record<string, unknown>> };
    expect(passwordRoundTrip.data.find((item) => item.title === "Monica Lab Wi-Fi")).toMatchObject({ password: "wifi-secret" });
    const ssh = response.data.find((item) => item.title === "Monica SSH")!;
    expect(ssh.loginType).toBe("SSH_KEY");
    expect(JSON.parse(String(ssh.sshKeyData))).toMatchObject({ algorithm: "ED25519", keySize: 256, publicKeyOpenSsh: "ssh-ed25519 AAAAC3Nza monica", fingerprintSha256: "SHA256:monica" });
    const barcode = response.data.find((item) => item.title === "Membership Barcode")!;
    expect(barcode).toMatchObject({ loginType: "BARCODE", password: "" });
    expect(await manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: { ...item, password: "MONICA-123456789" } }), barcode)).toMatchObject({ ok: true });
    await manager.reload();
    await manager.getByRole("button", { name: /^登录项/ }).click();
    await manager.getByRole("row").filter({ hasText: "Membership Barcode" }).getByRole("button", { name: "编辑登录项" }).click();
    await manager.getByRole("button", { name: "生成二维码" }).click();
    await expect(manager.getByAltText("BARCODE 二维码")).toBeVisible();

    await manager.setViewportSize({ width: 375, height: 760 });
    expect(await manager.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await context?.close();
  }
});
