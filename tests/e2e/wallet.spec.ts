import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

test("wallet popup explicitly fills identity address card and payment fields while leaving generic fields untouched", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("wallet-profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "wallet e2e master password" }))).toMatchObject({ ok: true });

    const now = new Date().toISOString();
    const base = { favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [] };
    const items = [
      {
        ...base, id: "wallet-identity", kind: "identity", title: "Joy Passport", documentType: "PASSPORT", documentNumber: "P12345678",
        firstName: "Joy", middleName: "Q", lastName: "Lin", fullName: "Joy Q Lin", birthDate: "1990-07-15", nationality: "China",
        email: "joy@example.com", phone: "+8613800000000", address: {}
      },
      {
        ...base, id: "wallet-address", kind: "billing-address", title: "Shanghai Home", fullName: "Joy Lin", company: "Monica",
        streetAddress: "1 Monica Road", apartment: "Room 1507", city: "Shanghai", stateProvince: "Shanghai", postalCode: "200000",
        country: "China", phone: "+8613800000000", email: "joy@example.com"
      },
      {
        ...base, id: "wallet-card", kind: "card", title: "Test Visa", cardholderName: "JOY LIN", number: "4111111111111111",
        expiryMonth: "12", expiryYear: "2030", securityCode: "123", brand: "Visa", pin: "7890", bankName: "Monica Card Bank",
        accountNumber: "card-account-42", routingNumber: "110000", iban: "GB82WEST12345698765432", swiftBic: "WESTGB2L", branchCode: "001", currency: "GBP"
      },
      {
        ...base, id: "wallet-payment", kind: "payment-account", title: "Euro Bank", paymentType: "BANK", provider: "Monica Bank",
        accountName: "Main EUR", accountHolderName: "Joy Lin", email: "pay@example.com", phone: "+491234567", username: "joy-pay",
        accountId: "acct-42", maskedAccountNumber: "****7890", routingNumber: "021000021", iban: "DE89370400440532013000",
        swiftBic: "COBADEFFXXX", website: "https://bank.example", currency: "EUR"
      }
    ];
    for (const item of items) {
      expect(await manager.evaluate(async (value) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: value }), item)).toMatchObject({ ok: true });
    }

    await context.route("https://checkout.example.test/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Wallet Checkout</title>
        <section id="identity"><input id="first-name" autocomplete="given-name"><input id="last-name" autocomplete="family-name"><input id="passport" name="passport_number"></section>
        <section id="address"><input id="street" autocomplete="street-address"><input id="city" autocomplete="address-level2"><input id="postal" autocomplete="postal-code"></section>
        <section id="card"><input id="cc-name" autocomplete="cc-name"><input id="cc-number" autocomplete="cc-number"><input id="cc-month" autocomplete="cc-exp-month"><input id="cc-year" autocomplete="cc-exp-year"><input id="cc-csc" autocomplete="cc-csc"><input id="card-pin" name="card_pin"><input id="card-account" name="bank_account_number"><input id="card-routing" name="routing_number"><input id="card-iban" name="iban"><input id="card-swift" name="swift_bic"><input id="card-branch" name="branch_code"><input id="card-currency" name="currency"><input id="generic-pin" name="pin"></section>
        <section id="payment"><input id="iban" name="iban"><input id="routing" name="routing_number"><input id="swift" name="swift_bic"></section>
        <input id="generic-number" name="number"><input id="generic-code" name="code">`
    }));
    const checkout = await context.newPage();
    await checkout.goto("https://checkout.example.test/pay");
    await expect(checkout.locator("#cc-number")).toBeVisible();

    const popup = await context.newPage();
    await checkout.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    for (const title of ["Joy Passport", "Shanghai Home", "Test Visa", "Euro Bank"]) await expect(popup.getByText(title, { exact: true })).toBeVisible();

    await checkout.bringToFront();
    await popup.getByRole("button", { name: /Joy Passport/ }).click();
    await expect(checkout.locator("#first-name")).toHaveValue("Joy");
    await expect(checkout.locator("#last-name")).toHaveValue("Lin");
    await expect(checkout.locator("#passport")).toHaveValue("P12345678");

    await checkout.bringToFront();
    await popup.getByRole("button", { name: /Shanghai Home/ }).click();
    await expect(checkout.locator("#street")).toHaveValue("1 Monica Road");
    await expect(checkout.locator("#city")).toHaveValue("Shanghai");
    await expect(checkout.locator("#postal")).toHaveValue("200000");

    await checkout.bringToFront();
    await popup.getByRole("button", { name: /Test Visa/ }).click();
    await expect(checkout.locator("#cc-name")).toHaveValue("JOY LIN");
    await expect(checkout.locator("#cc-number")).toHaveValue("4111111111111111");
    await expect(checkout.locator("#cc-month")).toHaveValue("12");
    await expect(checkout.locator("#cc-year")).toHaveValue("2030");
    await expect(checkout.locator("#cc-csc")).toHaveValue("123");
    await expect(checkout.locator("#card-pin")).toHaveValue("7890");
    await expect(checkout.locator("#card-account")).toHaveValue("card-account-42");
    await expect(checkout.locator("#card-routing")).toHaveValue("110000");
    await expect(checkout.locator("#card-iban")).toHaveValue("GB82WEST12345698765432");
    await expect(checkout.locator("#card-swift")).toHaveValue("WESTGB2L");
    await expect(checkout.locator("#card-branch")).toHaveValue("001");
    await expect(checkout.locator("#card-currency")).toHaveValue("GBP");
    await expect(checkout.locator("#generic-pin")).toHaveValue("");

    await checkout.bringToFront();
    await popup.getByRole("button", { name: /Euro Bank/ }).click();
    await expect(checkout.locator("#iban")).toHaveValue("DE89370400440532013000");
    await expect(checkout.locator("#routing")).toHaveValue("021000021");
    await expect(checkout.locator("#swift")).toHaveValue("COBADEFFXXX");
    await expect(checkout.locator("#generic-number")).toHaveValue("");
    await expect(checkout.locator("#generic-code")).toHaveValue("");
  } finally {
    await context?.close();
  }
});

test("manager preserves complete Android card fields and Markdown note metadata", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("wallet-editor-profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "wallet editor password" }))).toMatchObject({ ok: true });
    await manager.reload();

    await manager.getByRole("button", { name: /钱包与身份/ }).click();
    await manager.getByRole("button", { name: "添加钱包项目" }).click();
    await manager.getByLabel("名称 *").fill("Android Complete Card");
    await manager.getByLabel("银行卡号 *").fill("4111111111111111");
    await manager.getByLabel("持卡人").fill("JOY LIN");
    await manager.getByLabel("到期月").fill("12");
    await manager.getByLabel("到期年").fill("2030");
    await manager.getByLabel("安全码").fill("123");
    await manager.getByLabel("银行", { exact: true }).fill("Monica Bank");
    await manager.getByLabel("昵称", { exact: true }).fill("Travel");
    await manager.getByLabel("PIN", { exact: true }).fill("7890");
    await manager.getByLabel("生效月", { exact: true }).fill("01");
    await manager.getByLabel("生效年", { exact: true }).fill("2025");
    await manager.getByLabel("IBAN", { exact: true }).fill("DE89370400440532013000");
    await manager.getByLabel("SWIFT/BIC", { exact: true }).fill("COBADEFFXXX");
    await manager.getByLabel("路由号码", { exact: true }).fill("021000021");
    await manager.getByLabel("账户号码", { exact: true }).fill("0042");
    await manager.getByLabel("分行代码", { exact: true }).fill("001");
    await manager.getByLabel("币种", { exact: true }).fill("eur");
    await manager.getByLabel("客服电话", { exact: true }).fill("+4912345");
    await manager.getByLabel("账单地址 JSON", { exact: true }).fill('{"city":"Berlin","future":true}');
    await manager.getByRole("button", { name: "添加字段" }).click();
    await manager.getByLabel("自定义字段 1 名称").fill("virtual");
    await manager.getByLabel("自定义字段 1 值").fill("true");
    await manager.getByLabel("自定义字段 1 类型").selectOption("BOOLEAN");
    await manager.getByRole("button", { name: "加密保存" }).click();
    await expect(manager.getByText("Android Complete Card", { exact: true })).toBeVisible();

    await manager.getByRole("button", { name: /安全笔记/ }).click();
    await manager.getByRole("button", { name: "添加安全笔记" }).click();
    await manager.getByLabel("名称 *").fill("Markdown Runbook");
    await manager.getByLabel("标签").fill("工作, 恢复, Android");
    await manager.getByLabel("使用 Markdown").check();
    await manager.getByLabel("笔记内容 *").fill("# Recovery\n\n- Keep future fields");
    await manager.getByRole("button", { name: "加密保存" }).click();

    const response = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<Record<string, unknown>> };
    expect(response.ok).toBe(true);
    expect(response.data).toContainEqual(expect.objectContaining({
      kind: "card", title: "Android Complete Card", bankName: "Monica Bank", cardType: "CREDIT", pin: "7890",
      iban: "DE89370400440532013000", swiftBic: "COBADEFFXXX", routingNumber: "021000021", accountNumber: "0042",
      branchCode: "001", currency: "EUR", billingAddress: '{"city":"Berlin","future":true}',
      customFields: [{ name: "virtual", value: "true", fieldType: "BOOLEAN", protected: false }]
    }));
    expect(response.data).toContainEqual(expect.objectContaining({
      kind: "secure-note", title: "Markdown Runbook", content: "# Recovery\n\n- Keep future fields", tags: ["工作", "恢复", "Android"], isMarkdown: true
    }));
  } finally {
    await context?.close();
  }
});
