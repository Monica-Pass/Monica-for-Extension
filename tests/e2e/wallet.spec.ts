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
        expiryMonth: "12", expiryYear: "2030", securityCode: "123", brand: "Visa"
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
        <section id="card"><input id="cc-name" autocomplete="cc-name"><input id="cc-number" autocomplete="cc-number"><input id="cc-month" autocomplete="cc-exp-month"><input id="cc-year" autocomplete="cc-exp-year"><input id="cc-csc" autocomplete="cc-csc"></section>
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
