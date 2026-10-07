import { dialogContent } from "./fixtures/material";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test as base, type Locator, type Page } from "@playwright/test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoginItem, VaultItem } from "../../src/core/model";

const common = { favorite: false, notes: "", createdAt: "2026-01-01T08:00:00Z", updatedAt: "2026-09-01T08:00:00Z", providerRefs: [] };
const login: LoginItem = { ...common, id: "layout-login", kind: "login", title: "工作邮箱 / 基础设施与运营团队的统一账号", username: "workspace.operations@example.test", password: "synthetic-password-end", uris: ["https://accounts.example.test/" + "a-long-path-without-spaces/".repeat(5), "https://mail.example.test"], totpSecret: "JBSWY3DPEHPK3PXP", categoryName: "工作 / 基础设施", favorite: true, notes: "仅用于浏览器布局测试的示例账号。\n所有内容均为虚构测试数据。", customFields: [{ name: "所属项目", value: "Monica Studio", protected: false }, { name: "恢复密钥", value: "first-synthetic-recovery-secret", protected: true }, { name: "恢复密钥", value: "second-synthetic-recovery-secret", protected: true }] };
const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "synthetic-private-key-for-layout-only".repeat(8) + "\n-----END OPENSSH PRIVATE KEY-----";
const noteContent = "# 项目恢复说明\n\n01 / 取回资料\n从加密备份中恢复工作资料，并核对账号和授权范围。\n\n02 / 验证配置\n" + "这是一段用来检验长内容换行的虚构说明。".repeat(12) + "\n\n03 / 本地测试路径\nhttps://notes.example.test/" + "long-unbroken-segment-".repeat(12);
const items: VaultItem[] = [
  login,
  { ...common, id: "layout-card", kind: "card", title: "日常消费 / 示例银行卡", cardholderName: "LIN DESIGN", number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", securityCode: "937", pin: "8421", brand: "Visa", bankName: "Monica 示例银行", cardType: "CREDIT", currency: "CNY", customFields: [{ name: "用途", value: "仅用于界面演示", protected: false }] },
  { ...common, id: "layout-identity", kind: "identity", title: "旅行证件 / 示例护照", documentType: "PASSPORT", documentNumber: "P99887766", firstName: "DESIGN", middleName: "", lastName: "LIN", fullName: "LIN DESIGN", nationality: "中国", birthDate: "1990-01-01", issuedDate: "2025-01-01", expiryDate: "2035-01-01", issuedBy: "示例签发机关", email: "travel@example.test", phone: "+86 138 0000 0000", additionalInfo: "此证件仅用于界面演示。" },
  { ...common, id: "layout-address", kind: "billing-address", title: "工作室 / 账单地址", fullName: "林设计", company: "Monica Studio", streetAddress: "示例市创意园区工业设计大道 128 号，北区第三栋办公楼", apartment: "8 楼 801 室", city: "示例市", stateProvince: "示例省", postalCode: "200000", country: "中国", phone: "+86 138 0000 0000", email: "billing@example.test", isDefault: true },
  { ...common, id: "layout-payment", kind: "payment-account", title: "项目结算 / 支付账户", paymentType: "BANK", provider: "Monica 示例银行", accountName: "工作室结算", accountHolderName: "LIN DESIGN", username: "studio-payments", email: "billing@example.test", phone: "+86 138 0000 0000", accountId: "acct-synthetic-001", maskedAccountNumber: "**** 4321", routingNumber: "021000021", iban: "DE89370400440532013000", swiftBic: "COBADEFFXXX", website: "https://bank.example.test/business/payments", currency: "EUR", paymentNotes: "仅用于界面测试的虚构账号。" },
  { ...common, id: "layout-note", kind: "secure-note", title: "项目恢复 / 安全笔记", content: noteContent, tags: ["工作资料", "恢复流程"], isMarkdown: true, customFields: [{ name: "笔记恢复码", value: "synthetic-note-secret", protected: true }] },
  { ...common, id: "layout-totp", kind: "totp", title: "工作邮箱 / 验证码", secret: "JBSWY3DPEHPK3PXP", issuer: "Monica Studio", accountName: "workspace.operations@example.test", algorithm: "SHA1", digits: 6, period: 30, otpType: "TOTP" },
  { ...common, id: "layout-hotp", kind: "totp", title: "恢复设备 / 计数验证码", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", algorithm: "SHA1", digits: 6, period: 30, otpType: "HOTP", counter: 0 },
  { ...common, id: "layout-passkey", kind: "passkey", title: "设计平台 / Passkey", credentialId: "c3ludGhldGljLWNyZWRlbnRpYWwtZm9yLWxheW91dC1wcmV2aWV3".repeat(3), rpId: "design.example.test", rpName: "Monica Design", userHandle: "c3ludGhldGljLXVzZXI", userName: "design@example.test", userDisplayName: "LIN DESIGN", algorithm: -7, publicKey: "", signCount: 0, discoverable: true, userVerificationRequired: true, transports: ["internal", "hybrid"], sourceMode: "android-metadata-only", useCount: 12, lastUsedAt: "2026-08-31T08:00:00Z" },
  { ...login, id: "layout-wifi", title: "工作室 / Wi-Fi", username: "designer", password: "synthetic-wifi-password", loginType: "WIFI", wifiMetadata: JSON.stringify({ ssid: "Monica Studio / 设计网络", hiddenNetwork: true, security: "WPA2_ENTERPRISE", bssid: "00:11:22:33:44:55" }), uris: [], totpSecret: "", customFields: [], notes: "" },
  { ...login, id: "layout-ssh", title: "生产环境 / SSH 密钥", username: "", password: "", loginType: "SSH_KEY", sshKeyData: JSON.stringify({ algorithm: "ED25519", keySize: 256, publicKeyOpenSsh: "ssh-ed25519 " + "synthetic-public-key-".repeat(10) + " designer@example.test", privateKeyOpenSsh: privateKey, fingerprintSha256: "SHA256:" + "synthetic-fingerprint".repeat(3), comment: "designer@example.test", format: "OPENSSH" }), uris: [], totpSecret: "", customFields: [], notes: "用于布局测试的虚构密钥。" },
  { ...login, id: "layout-barcode", title: "工作室 / 会员条码", username: "", password: "MONICA-SYNTHETIC-BARCODE-123456789", loginType: "BARCODE", uris: [], totpSecret: "", customFields: [], notes: "" },
  { ...login, id: "layout-sso", title: "团队平台 / SSO", loginType: "SSO", ssoProvider: "GitHub", ssoRefEntryId: 42, password: "", uris: ["https://sso.example.test"], totpSecret: "", customFields: [], notes: "" }
];

const test = base.extend<{ manager: Page }>({
  manager: async ({}, use) => {
    const profile = await mkdtemp(path.join(tmpdir(), "monica-details-"));
    const extension = path.resolve("dist");
    const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "Synthetic detail layout master password" }))).toMatchObject({ ok: true });
      expect(await page.evaluate(items => chrome.runtime.sendMessage({ type: "VAULT_IMPORT_ITEMS", items }), items)).toMatchObject({ ok: true });
      await page.reload();
      await use(page);
    } finally {
      await context.close();
      const resolved = await realpath(profile);
      if (path.dirname(resolved) !== await realpath(tmpdir()) || !path.basename(resolved).startsWith("monica-details-")) throw new Error("Unexpected detail fixture path");
      await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});

async function openItem(page: Page, id: string): Promise<Locator> {
  const item = items.find(item => item.id === id)!;
  const nav = item.kind === "login" ? "登录项" : item.kind === "secure-note" ? "安全笔记" : item.kind === "totp" ? "动态验证码" : item.kind === "passkey" ? "Passkey" : "钱包与身份";
  const menu = page.getByRole("button", { name: "打开导航", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.locator("button.nav-item").filter({ hasText: nav }).click();
  await page.getByRole("button", { name: `查看${item.title}详情`, exact: true }).click();
  const detail = dialogContent(page);
  await expect(detail).toBeVisible();
  return detail;
}

async function expectLayoutFits(page: Page, detail: Locator) {
  expect(await detail.evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    const scroll = dialog.querySelector<HTMLElement>(".detail-scroll")!;
    const footer = dialog.querySelector("footer")!.getBoundingClientRect();
    return { viewport: document.documentElement.scrollWidth <= document.documentElement.clientWidth, dialog: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1, content: scroll.scrollWidth <= scroll.clientWidth + 1, footer: footer.top >= 0 && footer.bottom <= innerHeight + 1 };
  })).toEqual({ viewport: true, dialog: true, content: true, footer: true });
  const close = detail.locator("footer").getByRole("button", { name: /关闭|Close|Schließen|閉じる|닫기|Cerrar|Закрыть|Đóng/, exact: true });
  await expect(close).toBeInViewport();
  expect(await close.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
}

for (const theme of ["dark", "light"] as const) {
  test(`all detail kinds remain readable and actionable in ${theme} mode`, async ({ manager }, testInfo) => {
    test.setTimeout(120_000);
    await manager.emulateMedia({ colorScheme: theme });
    await expect(manager.locator("html")).toHaveAttribute("data-theme", theme);
    for (const item of items) {
      await test.step(item.id, async () => {
        await manager.setViewportSize({ width: 1440, height: 1000 });
        const detail = await openItem(manager, item.id);
        await expectLayoutFits(manager, detail);
        await manager.evaluate(() => document.fonts.ready);
        await manager.screenshot({ path: testInfo.outputPath(`${item.id}-${theme}.png`), animations: "disabled" });
        if (theme === "dark") {
          const audit = await new AxeBuilder({ page: manager }).include('[role="dialog"]').analyze();
          expect(audit.violations.filter(v => v.impact === "serious" || v.impact === "critical"), item.id).toEqual([]);
        }
        await manager.setViewportSize({ width: 390, height: 844 });
        await expectLayoutFits(manager, detail);
        await manager.screenshot({ path: testInfo.outputPath(`${item.id}-${theme}-mobile.png`), animations: "disabled" });
        await manager.setViewportSize({ width: 320, height: 360 });
        await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await expectLayoutFits(manager, detail);
        await detail.locator(".detail-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
        await expect(detail.locator(".detail-meta time").last()).toBeInViewport();
        await detail.locator("footer").getByRole("button", { name: "关闭", exact: true }).click();
        await expect(detail).toHaveCount(0);
        await manager.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
      });
    }
  });
}

async function expandFieldGroup(detail: Locator, fieldLabel: string) {
  const panel = detail.locator("m3e-expansion-panel.detail-disclosure").filter({ has: detail.page().locator("dt").getByText(fieldLabel, { exact: true }) });
  if (await panel.count()) await panel.locator('[slot="header"]').click();
}

test("protected duplicate fields reveal independently, copy exactly and reset on reopening", async ({ manager }) => {
  const detail = await openItem(manager, login.id);
  await expandFieldGroup(detail, "恢复密钥");
  const recoveryRows = detail.locator(".detail-row").filter({ has: manager.locator("dt", { hasText: /^恢复密钥$/ }) });
  await expect(recoveryRows).toHaveCount(2);
  await expect(recoveryRows.nth(0).locator("code")).toHaveText("••••••••");
  await expect(recoveryRows.nth(1).locator("code")).toHaveText("••••••••");
  await recoveryRows.nth(0).getByRole("button", { name: "显示恢复密钥" }).click();
  await expect(recoveryRows.nth(0).locator("code")).toHaveText("first-synthetic-recovery-secret");
  await expect(recoveryRows.nth(1).locator("code")).toHaveText("••••••••");
  await recoveryRows.nth(1).getByRole("button", { name: "复制恢复密钥" }).click();
  expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe("second-synthetic-recovery-secret");
  await expect(recoveryRows.nth(1).locator("code")).toHaveText("••••••••");
  await manager.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(manager.getByRole("button", { name: `查看${login.title}详情`, exact: true })).toBeFocused();
  await openItem(manager, login.id);
  await expandFieldGroup(detail, "恢复密钥");
  await expect(recoveryRows.nth(0).locator("code")).toHaveText("••••••••");
  await detail.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(dialogContent(manager, { name: "编辑密码", exact: true })).toBeVisible();
  await expect(manager.getByLabel("名称 *", { exact: true })).toHaveValue(login.title);
});

test("short secrets stay fully masked, and special details expose their actual fields", async ({ manager }) => {
  let detail = await openItem(manager, "layout-card");
  for (const label of ["安全码", "PIN"]) {
    await expandFieldGroup(detail, label);
    const row = detail.locator(".detail-row").filter({ has: manager.locator("dt", { hasText: new RegExp(`^${label}$`) }) });
    await expect(row.locator("code")).toHaveText("••••••••");
    await row.getByRole("button", { name: `显示${label}` }).click();
    await expect(row.locator("code")).toHaveText(label === "PIN" ? "8421" : "937");
  }
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  detail = await openItem(manager, "layout-ssh");
  const keyRow = detail.locator(".detail-row").filter({ has: manager.locator("dt", { hasText: /^OpenSSH 私钥$/ }) });
  await expect(keyRow.locator("code")).toHaveText("••••••••");
  await keyRow.getByRole("button", { name: "显示OpenSSH 私钥" }).click();
  await expect(keyRow.locator("code")).toHaveText(privateKey);
  await manager.setViewportSize({ width: 320, height: 640 });
  await expectLayoutFits(manager, detail);
  await keyRow.getByRole("button", { name: "复制OpenSSH 私钥" }).click();
  // The Windows system clipboard normalizes multiline text to CRLF.
  expect((await manager.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(privateKey);
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  detail = await openItem(manager, "layout-note");
  await expandFieldGroup(detail, "笔记恢复码");
  await detail.getByRole("button", { name: "复制内容", exact: true }).click();
  expect((await manager.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(noteContent);
  await expect(detail.getByRole("button", { name: "显示笔记恢复码" })).toBeVisible();
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  detail = await openItem(manager, "layout-passkey");
  await expandFieldGroup(detail, "可发现凭据");
  await expect(detail.getByText("可发现凭据", { exact: true })).toBeVisible();
  await expect(detail.getByText("需要用户验证", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
  await expect(detail.getByText(/仅保留元数据/)).toBeVisible();
});

test("standalone HOTP copies and persists the counter across detail reopening", async ({ manager }) => {
  const detail = await openItem(manager, "layout-hotp");
  const code = detail.getByRole("button", { name: "复制验证码并将计数器加一" });
  await expect(code.locator("strong")).toHaveText("755224");
  await code.click();
  expect(await manager.evaluate(() => navigator.clipboard.readText())).toBe("755224");
  await expect(code.locator("strong")).toHaveText("287082");
  await expect(detail.locator(".detail-row").filter({ has: manager.locator("dt", { hasText: /^计数器$/ }) })).toContainText("1");
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  await manager.reload();
  await openItem(manager, "layout-hotp");
  await expect(code.locator("strong")).toHaveText("287082");
  expect(await manager.evaluate(async () => (await chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: "layout-hotp" })).data.counter)).toBe(1);
});

test("translated copy feedback keeps the footer usable on a short screen at 200 percent text", async ({ manager }, testInfo) => {
  const detail = await openItem(manager, login.id);
  await detail.getByRole("button", { name: "复制用户名", exact: true }).click();
  await manager.setViewportSize({ width: 320, height: 360 });
  await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  for (const locale of ["zh-CN", "en", "ja", "ko", "de", "es", "ru", "vi"]) {
    await manager.evaluate(locale => chrome.storage.local.set({ "monica.locale": locale }), locale);
    await expect(manager.locator("html")).toHaveAttribute("lang", locale);
    await expectLayoutFits(manager, detail);
    await expect(detail.locator(".detail-status")).toBeInViewport();
  }
  await manager.screenshot({ path: testInfo.outputPath("footer-320-200-percent.png"), animations: "disabled" });
});
