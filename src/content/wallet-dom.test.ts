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

function show(control: HTMLElement): void {
  control.getBoundingClientRect = () => ({ x: 0, y: 0, width: 220, height: 40, top: 0, right: 220, bottom: 40, left: 0, toJSON: () => ({}) });
}

describe("wallet DOM filling", () => {
  it('keeps independent full/card names, third address lines and home/work contacts separate', () => {
    const dom = page('<input autocomplete="name"><input autocomplete="given-name"><input autocomplete="additional-name"><input autocomplete="family-name"><input autocomplete="address-line1"><input autocomplete="address-line2"><input autocomplete="address-line3"><input autocomplete="address-level3"><input autocomplete="email"><input autocomplete="home email"><input autocomplete="work email">');
    const fields = { fullName: 'Separate Full', firstName: 'Independent', middleName: '', lastName: 'Parts', streetAddress: 'One', apartment: 'Two', addressLine3: 'Three', district: 'County', email: 'default@example.test', homeEmail: '', workEmail: 'work@example.test' };
    expect(fillWallet({ kind: 'billing-address', fields }, dom.window.document).ok).toBe(true);
    expect([...dom.window.document.querySelectorAll('input')].map(x => x.value)).toEqual(['Separate Full', 'Independent', '', 'Parts', 'One', 'Two', 'Three', 'County', 'default@example.test', '', 'work@example.test']);
    const cards = page('<input autocomplete="cc-name"><input autocomplete="cc-given-name"><input autocomplete="cc-additional-name"><input autocomplete="cc-family-name">');
    fillWallet({ kind: 'card', fields: { cardholderName: 'Different Holder', cardholderFirstName: 'OnlyFirst' } }, cards.window.document);
    expect([...cards.window.document.querySelectorAll('input')].map(x => x.value)).toEqual(['Different Holder', 'OnlyFirst', '', '']);
  });
  it.each(['form', 'section', 'shipping', 'repeated'] as const)('fills only the focused %s block', mode => {
    const block = (suffix: string) => `<input id="name${suffix}" autocomplete="${mode === 'section' ? `section-${suffix} ` : mode === 'shipping' ? `${suffix === 'a' ? 'shipping' : 'billing'} ` : ''}name"><input id="email${suffix}" autocomplete="${mode === 'section' ? `section-${suffix} ` : mode === 'shipping' ? `${suffix === 'a' ? 'shipping' : 'billing'} ` : ''}email">`;
    const dom = page(mode === 'form' ? `<form>${block('a')}</form><form>${block('b')}</form>` : block('a') + block('b'));
    dom.window.document.querySelector<HTMLInputElement>('#nameb')!.focus();
    expect(fillWallet({ kind: 'identity', fields: { fullName: 'Selected', email: 'chosen@example.test' } }, dom.window.document).filledCount).toBe(2);
    expect([...dom.window.document.querySelectorAll('input')].map(x => x.value)).toEqual(['', '', 'Selected', 'chosen@example.test']);
  });
  it('declines ambiguous forms without focus and never uses a login email as a phone or a name', () => {
    const dom = page('<form><input autocomplete="name"></form><form><input autocomplete="name"></form><input type="tel" name="first_name"><input type="email" name="phone"><input name="email" autocomplete="username">');
    expect(fillWallet({ kind: 'identity', fields: { fullName: 'Name', email: 'login@example.test', firstName: 'Given', phone: '1234' } }, dom.window.document).filledCount).toBe(0);
  });
  it('limits a focused home contact to home values and leaves missing values blank', () => {
    const dom = page('<input autocomplete="email"><input id="home" autocomplete="home email"><input autocomplete="home tel"><input autocomplete="work email"><input autocomplete="work tel">');
    dom.window.document.querySelector<HTMLInputElement>('#home')!.focus();
    fillWallet({ kind: 'identity', fields: { email: 'default@example.test', phone: 'default', homeEmail: 'home@example.test', workEmail: 'work@example.test', workPhone: 'work' } }, dom.window.document);
    expect([...dom.window.document.querySelectorAll('input')].map(x => x.value)).toEqual(['', 'home@example.test', '', '', '']);
  });
  it.each(['input', 'textarea'])('formats a combined street-address correctly for %s', tag => {
    const dom = page(`<${tag} autocomplete="street-address"></${tag}>`);
    fillWallet({ kind: 'billing-address', fields: { streetAddress: 'One', apartment: 'Two', addressLine3: 'Three' } }, dom.window.document);
    expect(dom.window.document.querySelector<HTMLInputElement>(tag)!.value).toBe(tag === 'input' ? 'One, Two, Three' : 'One\nTwo\nThree');
  });
  it('matches valid country/month/year options and skips duplicate or disabled options', () => {
    const dom = page('<select autocomplete="country"><option value="">Choose</option><option value="United States">United States</option></select><select autocomplete="cc-exp-month"><option value="">Choose</option><option value="dec">12 - December</option></select><select autocomplete="cc-exp-year"><option value="">Choose</option><option value="30">2030</option></select>');
    fillWallet({ kind: 'billing-address', fields: { country: 'US' } }, dom.window.document);
    fillWallet({ kind: 'card', fields: { cardExpiryMonth: '12', cardExpiryYear: '2030' } }, dom.window.document);
    expect([...dom.window.document.querySelectorAll('select')].map(x => x.value)).toEqual(['United States', 'dec', '30']);
    const duplicate = page('<select autocomplete="cc-exp-month"><option value="">Choose</option><option value="12">December</option><option value="dup">December</option></select><input autocomplete="cc-number">');
    expect(fillWallet({ kind: 'card', fields: { cardExpiryMonth: '12', cardNumber: '4111' } }, duplicate.window.document).filledCount).toBe(1);
    expect(duplicate.window.document.querySelector('select')!.value).toBe('');
  });
  it('parses phone parts using the stored region and keeps home/work segments independent', () => {
    const dom = page('<input autocomplete="tel-country-code"><input autocomplete="tel-national"><input autocomplete="tel-area-code"><input autocomplete="tel-local-prefix"><input autocomplete="tel-local-suffix"><input autocomplete="home tel-national"><input autocomplete="work tel-national">');
    fillWallet({ kind: 'identity', fields: { phone: '(202) 555-0142', country: 'US', workPhone: '+12025550144', email: 'not-a-phone@example.test' } }, dom.window.document);
    expect([...dom.window.document.querySelectorAll('input')].map(x => x.value)).toEqual(['+1', '2025550142', '202', '555', '0142', '', '2025550144']);
  });
  it('rescans controls added by a previous fill without crossing into another form', () => {
    const dom = page('<form id="target"><input id="country" autocomplete="country"></form><form><input autocomplete="address-line1"></form>');
    const country = dom.window.document.querySelector<HTMLInputElement>('#country')!; country.focus();
    country.addEventListener('change', () => { const next = dom.window.document.createElement('input'); next.autocomplete = 'address-line1'; next.id = 'dynamic'; show(next); country.after(next); }, { once: true });
    const payload = { kind: 'billing-address' as const, fields: { country: 'US', streetAddress: 'Dynamic street' } };
    fillWallet(payload, dom.window.document);
    const dynamic = dom.window.document.querySelector<HTMLInputElement>('#dynamic')!; dynamic.focus();
    fillWallet(payload, dom.window.document);
    expect(dynamic.value).toBe('Dynamic street'); expect(dom.window.document.querySelectorAll<HTMLInputElement>('form')[1].querySelector('input')!.value).toBe('');
  });
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
    expect(scanWalletKinds(dom.window.document)).toEqual(["identity", "card", "payment-account"]);
    expect(fillWallet({ kind: "payment-account", fields: { iban: "DE89370400440532013000", routingNumber: "021000021" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 2 });
  });

  it("fills document-specific fields only from explicit labels", () => {
    const dom = page('<input name="passport_number"><input name="document_expiry_date"><input name="issuing_authority"><input name="license_number"><input name="ssn">');
    expect(fillWallet({ kind: "identity", fields: { passportNumber: "P123", documentExpiryDate: "2030-01-01", documentIssuedBy: "Monica Authority", licenseNumber: "DL9", ssn: "SS1" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 5 });
  });

  it("fills card banking fields only from explicit international labels", () => {
    const dom = page('<input name="card_pin"><input name="bank_account_number"><input name="routing_number"><input name="iban"><input name="swift_bic"><input name="branch_code"><input name="currency"><input name="pin">');
    expect(fillWallet({ kind: "card", fields: { cardPin: "7890", paymentAccountNumber: "0042", routingNumber: "021000021", iban: "DE89", swiftBic: "BICCODE", branchCode: "001", currency: "EUR" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 7 });
    expect(dom.window.document.querySelector<HTMLInputElement>('input[name="pin"]')!.value).toBe("");
  });

  it("does not guess generic number code or password fields", () => {
    const dom = page('<label>号码<input name="number"></label><label>验证码<input name="code"></label><input name="pin"><input name="secret" type="password">');
    expect(scanWalletKinds(dom.window.document)).toEqual([]);
    expect(fillWallet({ kind: "card", fields: { cardNumber: "4111111111111111", cardSecurityCode: "123" } }, dom.window.document)).toMatchObject({ ok: false, filledCount: 0 });
  });

  it("does not report success or throw when a hostile page breaks the native value setter", () => {
    // jsdom pages live in a separate vm realm: defineProperty on a cross-realm object
    // merges a partial accessor descriptor with the existing one instead of replacing it,
    // so both halves must be spelled out for the hostile override to take effect.
    for (const descriptor of [
      { configurable: true, get: () => "", set: undefined },
      { configurable: true, get: undefined, set: () => { throw new Error("hostile"); } }
    ]) {
      const dom = page('<form><input autocomplete="name"></form>');
      Object.defineProperty(dom.window.HTMLInputElement.prototype, "value", descriptor);
      let events = 0;
      dom.window.document.querySelector("input")!.addEventListener("input", () => { events += 1; });
      dom.window.document.querySelector("input")!.addEventListener("change", () => { events += 1; });
      expect(fillWallet({ kind: "identity", fields: { fullName: "Hostile" } }, dom.window.document)).toMatchObject({ ok: false, filledCount: 0 });
      expect(events).toBe(0);
    }
  });

  it("recognizes Android-derived Chinese card labels", () => {
    const dom = page('<label>持卡人姓名<input></label><label>银行卡号<input></label><label>信用卡有效期<input></label><label>信用卡安全码<input></label>');
    expect(scanWalletKinds(dom.window.document)).toEqual(["card"]);
    expect(fillWallet({ kind: "card", fields: { cardholderName: "Joy Lin", cardNumber: "4111111111111111", cardExpiry: "12/30", cardSecurityCode: "123" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 4 });
  });

  it("recognizes Chinese identity and address labels", () => {
    const dom = page('<label>姓<input></label><label>名<input></label><label>身份证号码<input></label><label>出生日期<input></label><label>详细地址<input></label><label>省份<input></label><label>城市<input></label><label>邮政编码<input></label><label>国家或地区<input></label><label>手机号码<input></label><label>电子邮箱<input></label>');
    expect(scanWalletKinds(dom.window.document)).toEqual(["identity", "billing-address", "payment-account"]);
    expect(fillWallet({ kind: "identity", fields: { firstName: "Joy", lastName: "Lin", documentNumber: "310000000000000000", birthDate: "2000-01-01", streetAddress: "Monica 路 1 号", stateProvince: "上海", city: "上海", postalCode: "200000", country: "中国", phone: "13800000000", email: "joy@example.com" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 11 });
  });

  it("allows an identity record to fill organization fields", () => {
    const dom = page('<label>公司名称<input name="organization"></label>');
    expect(scanWalletKinds(dom.window.document)).toContain("identity");
    expect(fillWallet({ kind: "identity", fields: { company: "Monica Labs" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 1 });
    expect(dom.window.document.querySelector<HTMLInputElement>('input[name="organization"]')!.value).toBe("Monica Labs");
  });

  it("recognizes Chinese and legacy bank-account labels", () => {
    const dom = page('<label>银行名称<input></label><label>账户名称<input></label><label>账户持有人<input></label><label>银行账号<input></label><label>路由号码<input></label><label>国际银行账号<input></label><label>SWIFT代码<input></label><label>币种<input></label>');
    expect(scanWalletKinds(dom.window.document)).toEqual(["card", "payment-account"]);
    expect(fillWallet({ kind: "payment-account", fields: { paymentProvider: "Example Bank", paymentAccountName: "Daily", paymentAccountHolder: "Joy Lin", paymentAccountNumber: "0042", routingNumber: "021000021", iban: "DE89370400440532013000", swiftBic: "EXAMPLEBIC", currency: "CNY" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 8 });
  });

  it("discovers and fills wallet controls in nested open shadow roots", () => {
    const dom = page('<payment-shell id="payment"></payment-shell>');
    const outer = dom.window.document.querySelector("#payment")!.attachShadow({ mode: "open" });
    const innerHost = dom.window.document.createElement("section");
    outer.append(innerHost);
    const inner = innerHost.attachShadow({ mode: "open" });
    inner.innerHTML = '<input id="number" autocomplete="cc-number"><input id="csc" autocomplete="cc-csc"><input id="generic" name="number">';
    for (const control of Array.from(inner.querySelectorAll<HTMLElement>("input"))) show(control);

    expect(scanWalletKinds(dom.window.document)).toEqual(["card"]);
    expect(fillWallet({ kind: "card", fields: { cardNumber: "4111111111111111", cardSecurityCode: "123" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 2 });
    expect(inner.querySelector<HTMLInputElement>("#number")!.value).toBe("4111111111111111");
    expect(inner.querySelector<HTMLInputElement>("#csc")!.value).toBe("123");
    expect(inner.querySelector<HTMLInputElement>("#generic")!.value).toBe("");
  });
});
