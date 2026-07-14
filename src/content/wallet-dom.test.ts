import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { fillWallet, scanWalletKinds } from "./wallet-dom";

function page(html: string) {
  const dom = new JSDOM(html, { url: "https://checkout.example.com", pretendToBeVisual: true });
  for (const control of Array.from(dom.window.document.querySelectorAll<HTMLElement>("input,select,textarea"))) {
    control.getBoundingClientRect = () => ({ x: 0, y: 0, width: 220, height: 40, top: 0, right: 220, bottom: 40, left: 0, toJSON: () => ({}) });
  }
  return dom;
}

describe("wallet DOM filling", () => {
  it("discovers and fills standard identity and address autocomplete fields", () => {
    const dom = page('<input autocomplete="given-name"><input autocomplete="family-name"><input autocomplete="street-address"><input autocomplete="postal-code">');
    expect(scanWalletKinds(dom.window.document)).toEqual(["identity", "billing-address"]);
    expect(fillWallet({ kind: "identity", fields: { firstName: "Joy", lastName: "Lin", streetAddress: "1 Monica Road", postalCode: "200000" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 4 });
    expect(Array.from(dom.window.document.querySelectorAll<HTMLInputElement>("input")).map((input) => input.value)).toEqual(["Joy", "Lin", "1 Monica Road", "200000"]);
  });

  it("fills card fields only after an explicit card payload", () => {
    const dom = page('<input autocomplete="cc-name"><input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc">');
    expect(scanWalletKinds(dom.window.document)).toContain("card");
    expect(fillWallet({ kind: "card", fields: { cardholderName: "Joy Lin", cardNumber: "4111111111111111", cardExpiry: "12/30", cardSecurityCode: "123" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 4 });
  });

  it("uses conservative exact heuristics for document and bank account fields", () => {
    const dom = page('<label>Passport number<input name="passport_number"></label><input name="iban"><input name="routing_number">');
    expect(scanWalletKinds(dom.window.document)).toEqual(["identity", "payment-account"]);
    expect(fillWallet({ kind: "payment-account", fields: { iban: "DE89370400440532013000", routingNumber: "021000021" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 2 });
  });

  it("does not guess generic number code or password fields", () => {
    const dom = page('<input name="number"><input name="code"><input name="secret" type="password">');
    expect(scanWalletKinds(dom.window.document)).toEqual([]);
    expect(fillWallet({ kind: "card", fields: { cardNumber: "4111111111111111", cardSecurityCode: "123" } }, dom.window.document)).toMatchObject({ ok: false, filledCount: 0 });
  });
});
