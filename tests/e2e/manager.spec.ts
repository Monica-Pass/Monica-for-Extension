import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

test("manager UI creates edits imports and deletes non-login vault records", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("manager-profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);

    await expect(manager.getByRole("heading", { name: "创建加密密码库" })).toBeVisible();
    await manager.getByLabel("主密码", { exact: true }).fill("manager e2e master password");
    await manager.getByLabel("确认主密码", { exact: true }).fill("manager e2e master password");
    await manager.getByRole("button", { name: "创建并解锁" }).click();
    await expect(manager.getByRole("heading", { name: "密码库概览" })).toBeVisible();

    await manager.getByRole("button", { name: /钱包与身份/ }).click();
    await manager.getByRole("button", { name: "添加钱包项目" }).click();
    await expect(manager.getByRole("heading", { name: "添加银行卡" })).toBeVisible();
    await manager.getByLabel("名称 *").fill("Daily Visa");
    await manager.getByLabel("持卡人").fill("JOY LIN");
    await manager.getByLabel("卡组织").fill("Visa");
    await manager.getByLabel("银行卡号 *").fill("4111111111111111");
    await manager.getByLabel("到期月").fill("12");
    await manager.getByLabel("到期年").fill("2030");
    await manager.getByLabel("安全码").fill("123");
    await manager.getByRole("button", { name: "加密保存" }).click();
    await expect(manager.getByText("Daily Visa", { exact: true })).toBeVisible();
    await expect(manager.getByText(/•••• 1111/)).toBeVisible();
    await expect(manager.getByText("4111111111111111", { exact: true })).toHaveCount(0);

    await manager.getByRole("button", { name: "编辑银行卡" }).click();
    await manager.getByLabel("名称 *").fill("Daily Visa Updated");
    await manager.getByRole("button", { name: "加密保存" }).click();
    await expect(manager.getByText("Daily Visa Updated", { exact: true })).toBeVisible();

    await manager.getByRole("button", { name: /笔记与验证码/ }).click();
    await manager.getByRole("button", { name: "添加笔记或验证码" }).click();
    await manager.getByLabel("名称 *").fill("Private Note");
    await manager.getByLabel("笔记内容 *").fill("Recovery instructions stored safely.");
    await manager.getByRole("button", { name: "加密保存" }).click();
    await expect(manager.getByText("Private Note", { exact: true })).toBeVisible();

    await manager.getByRole("button", { name: "添加笔记或验证码" }).click();
    await manager.getByLabel("项目类型").selectOption("totp");
    await manager.getByLabel("名称 *").fill("Example OTP");
    await manager.getByLabel("TOTP 密钥 *").fill("JBSWY3DPEHPK3PXP");
    await manager.getByLabel("签发方").fill("Example");
    await manager.getByLabel("账户").fill("joy@example.com");
    await manager.getByRole("button", { name: "加密保存" }).click();
    await expect(manager.getByText("Example OTP", { exact: true })).toBeVisible();

    const noteRow = manager.getByRole("row").filter({ hasText: "Private Note" });
    manager.once("dialog", (dialog) => void dialog.accept());
    await noteRow.getByRole("button", { name: "删除安全笔记" }).click();
    await expect(manager.getByText("Private Note", { exact: true })).toHaveCount(0);

    const now = new Date().toISOString();
    const common = { favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [] };
    const importPath = testInfo.outputPath("manager-import.json");
    await writeFile(importPath, JSON.stringify({ version: 1, items: [
      { ...common, id: "import-identity", kind: "identity", title: "Imported Passport", documentType: "PASSPORT", documentNumber: "P99887766", firstName: "Joy", middleName: "", lastName: "Lin", fullName: "Joy Lin" },
      { ...common, id: "import-address", kind: "billing-address", title: "Imported Home", fullName: "Joy Lin", company: "", streetAddress: "1 Monica Road", apartment: "", city: "Shanghai", stateProvince: "Shanghai", postalCode: "200000", country: "China", phone: "", email: "" },
      { ...common, id: "import-payment", kind: "payment-account", title: "Imported Bank", paymentType: "BANK", provider: "Monica Bank", accountName: "Main", accountHolderName: "Joy Lin", email: "", phone: "", username: "", accountId: "acct-1", maskedAccountNumber: "****7890", routingNumber: "", iban: "DE89370400440532013000", swiftBic: "COBADEFFXXX", website: "", currency: "EUR" },
      { ...common, id: "import-passkey", kind: "passkey", title: "Imported Passkey", credentialId: "credential", rpId: "example.com", rpName: "Example", userHandle: "user", userName: "joy@example.com", userDisplayName: "Joy", algorithm: -7, publicKey: "", signCount: 3, discoverable: true, sourceMode: "android-metadata-only" }
    ] }), "utf8");

    await manager.getByRole("button", { name: "设置与备份" }).click();
    await manager.locator("label.file-action").filter({ hasText: "导入明文 JSON" }).locator('input[type="file"]').setInputFiles(importPath);
    await expect(manager.getByText(/已加密导入 4 个密码库项目/)).toBeVisible();
    await manager.getByRole("button", { name: /钱包与身份/ }).click();
    for (const title of ["Imported Passport", "Imported Home", "Imported Bank"]) await expect(manager.getByText(title, { exact: true })).toBeVisible();
    await manager.getByRole("button", { name: /Passkey/ }).click();
    await expect(manager.getByText("Imported Passkey", { exact: true })).toBeVisible();
    await expect(manager.getByText(/Android 元数据/)).toBeVisible();

    const response = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<{ kind: string; title: string }> };
    expect(response.ok).toBe(true);
    expect(response.data.map((item) => item.kind).sort()).toEqual(["billing-address", "card", "identity", "passkey", "payment-account", "totp"].sort());
  } finally {
    await context?.close();
  }
});

test("manager rotates the master password and atomically restores an encrypted full backup", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("lifecycle-profile"), {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);

    const originalPassword = "manager original password";
    const rotatedPassword = "manager rotated password";
    await manager.getByLabel("主密码", { exact: true }).fill(originalPassword);
    await manager.getByLabel("确认主密码", { exact: true }).fill(originalPassword);
    await manager.getByRole("button", { name: "创建并解锁" }).click();
    await expect(manager.getByRole("heading", { name: "密码库概览" })).toBeVisible();
    const createdAt = new Date().toISOString();
    const itemId = "lifecycle-login";
    const upsert = await manager.evaluate(async ({ itemId, createdAt }) => chrome.runtime.sendMessage({
      type: "VAULT_UPSERT_ITEM",
      item: { id: itemId, kind: "login", title: "Recovered Login", username: "joy", password: "recovered-secret", uris: ["https://recover.example.com"], customFields: [], favorite: false, notes: "", createdAt, updatedAt: createdAt, providerRefs: [] }
    }), { itemId, createdAt }) as { ok: boolean; error?: string };
    expect(upsert.ok, upsert.error).toBe(true);

    await manager.getByRole("button", { name: "设置与备份" }).click();
    const downloadPromise = manager.waitForEvent("download");
    await manager.getByRole("button", { name: "导出加密整库备份" }).click();
    const download = await downloadPromise;
    const backupPath = testInfo.outputPath("encrypted-vault-backup.json");
    await download.saveAs(backupPath);

    await manager.getByLabel("当前主密码", { exact: true }).fill(originalPassword);
    await manager.getByLabel("新主密码", { exact: true }).fill(rotatedPassword);
    await manager.getByLabel("确认新主密码", { exact: true }).fill(rotatedPassword);
    await manager.getByRole("button", { name: "更改主密码" }).click();
    await expect(manager.getByText(/主密码已更改/)).toBeVisible();
    await manager.getByRole("button", { name: "立即锁定" }).click();

    await manager.getByLabel("主密码", { exact: true }).fill(originalPassword);
    await manager.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(manager.getByRole("alert")).toContainText("主密码错误");
    await manager.getByLabel("主密码", { exact: true }).fill(rotatedPassword);
    await manager.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(manager.getByRole("heading", { name: "密码库概览" })).toBeVisible();

    const removed = await manager.evaluate(async (itemId) => chrome.runtime.sendMessage({ type: "VAULT_DELETE_ITEM", itemId }), itemId) as { ok: boolean };
    expect(removed.ok).toBe(true);
    await manager.getByRole("button", { name: "设置与备份" }).click();
    await manager.locator("label.file-action").filter({ hasText: "选择加密整库备份" }).locator('input[type="file"]').setInputFiles(backupPath);
    await manager.getByLabel("备份主密码", { exact: true }).fill(originalPassword);
    await manager.getByLabel("恢复前的当前主密码", { exact: true }).fill(rotatedPassword);
    manager.once("dialog", (dialog) => void dialog.accept());
    await manager.getByRole("button", { name: "验证并替换当前密码库" }).click();
    await expect(manager.getByText(/加密整库备份已完成原子恢复/)).toBeVisible();

    const restored = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<{ id: string; title: string; password: string }> };
    expect(restored.ok).toBe(true);
    expect(restored.data).toEqual([expect.objectContaining({ id: itemId, title: "Recovered Login", password: "recovered-secret" })]);
    await manager.getByRole("button", { name: "立即锁定" }).click();
    await manager.getByLabel("主密码", { exact: true }).fill(originalPassword);
    await manager.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(manager.getByRole("heading", { name: "密码库概览" })).toBeVisible();
  } finally {
    await context?.close();
  }
});
