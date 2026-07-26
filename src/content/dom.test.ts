import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { fillCredential, scanPage } from "./dom";

function page(html: string) {
  const dom = new JSDOM(html, { url: "https://accounts.example.com/login", pretendToBeVisual: true });
  return dom;
}

function show(input: HTMLInputElement): HTMLInputElement {
  input.getBoundingClientRect = () => ({ x: 0, y: 0, width: 240, height: 44, top: 0, right: 240, bottom: 44, left: 0, toJSON: () => ({}) });
  return input;
}

function showLightInputs(dom: JSDOM): void {
  for (const input of Array.from(dom.window.document.querySelectorAll<HTMLInputElement>("input"))) show(input);
}

describe("content autofill DOM engine", () => {
  it("scans a login form", () => {
    const dom = page('<form><input type="email"><input type="password"></form>');
    showLightInputs(dom);
    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ host: "accounts.example.com", hasUsernameField: true, hasPasswordField: true });
  });

  it("fills only after an explicit invocation", () => {
    const dom = page('<form><input id="username" autocomplete="username"><input id="password" type="password"></form>');
    showLightInputs(dom);
    const username = dom.window.document.querySelector<HTMLInputElement>("#username")!;
    const password = dom.window.document.querySelector<HTMLInputElement>("#password")!;
    expect([username.value, password.value]).toEqual(["", ""]);
    expect(fillCredential({ username: "joy@example.com", password: "correct horse" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: true, filledPassword: true });
    expect([username.value, password.value]).toEqual(["joy@example.com", "correct horse"]);
  });

  it("uses a lone unlabeled text field before a password as the username", () => {
    const dom = page('<form><input id="username"><input id="password" type="password"></form>');
    showLightInputs(dom);
    expect(fillCredential({ username: "joy", password: "secret" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: true, filledPassword: true });
    expect(dom.window.document.querySelector<HTMLInputElement>("#username")!.value).toBe("joy");
  });

  it("does not let an unrelated text field steal an explicitly identified username", () => {
    const dom = page('<form><label>Tenant<input id="tenant"></label><input id="username" autocomplete="username"><input id="password" type="password"></form>');
    showLightInputs(dom);
    expect(fillCredential({ username: "joy", password: "secret" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: true, filledPassword: true });
    expect(dom.window.document.querySelector<HTMLInputElement>("#tenant")!.value).toBe("");
    expect(dom.window.document.querySelector<HTMLInputElement>("#username")!.value).toBe("joy");
  });

  it("fills the login form that currently owns keyboard focus", () => {
    const dom = page(`
      <form id="first"><input autocomplete="username"><input type="password"></form>
      <form id="second"><input id="second-user" autocomplete="username"><input id="second-password" type="password"></form>
    `);
    showLightInputs(dom);
    const focused = dom.window.document.querySelector<HTMLInputElement>("#second-user")!;
    focused.focus();

    expect(fillCredential({ username: "focused-user", password: "focused-secret" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: true, filledPassword: true });
    expect(Array.from(dom.window.document.querySelectorAll<HTMLInputElement>("#first input")).map((input) => input.value)).toEqual(["", ""]);
    expect(focused.value).toBe("focused-user");
    expect(dom.window.document.querySelector<HTMLInputElement>("#second-password")!.value).toBe("focused-secret");
  });

  it("keeps focused-form targeting inside an open shadow root", () => {
    const dom = page('<form id="light"><input autocomplete="username"><input type="password"></form><div id="host"></div>');
    showLightInputs(dom);
    const shadow = dom.window.document.querySelector("#host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<form><input id="shadow-user" autocomplete="username"><input id="shadow-password" type="password"></form>';
    const username = show(shadow.querySelector<HTMLInputElement>("#shadow-user")!);
    const password = show(shadow.querySelector<HTMLInputElement>("#shadow-password")!);
    username.focus();

    expect(fillCredential({ username: "shadow-focused", password: "shadow-secret" }, dom.window.document)).toMatchObject({ ok: true });
    expect([username.value, password.value]).toEqual(["shadow-focused", "shadow-secret"]);
    expect(Array.from(dom.window.document.querySelectorAll<HTMLInputElement>("#light input")).map((input) => input.value)).toEqual(["", ""]);
  });

  it("never writes a real password into a masked one-time-code field", () => {
    const dom = page('<form><input id="otp" type="password" autocomplete="one-time-code"></form>');
    const otp = show(dom.window.document.querySelector<HTMLInputElement>("#otp")!);
    const observed: string[] = [];
    otp.addEventListener("input", () => observed.push(otp.value));

    expect(fillCredential({ password: "must-not-leak", totpCode: "123456" }, dom.window.document)).toMatchObject({ ok: true, filledPassword: false, filledTotp: true });
    expect(observed).toEqual(["123456"]);
  });

  it("separates a masked verification code from an unannotated current password", () => {
    const dom = page('<form><input id="password" type="password" name="password"><input id="otp" type="password" name="verification_code" inputmode="numeric" maxlength="6"></form>');
    showLightInputs(dom);
    expect(fillCredential({ password: "must-stay-in-password", totpCode: "654321" }, dom.window.document)).toMatchObject({ ok: true, filledPassword: true, filledTotp: true });
    expect(dom.window.document.querySelector<HTMLInputElement>("#password")!.value).toBe("must-stay-in-password");
    expect(dom.window.document.querySelector<HTMLInputElement>("#otp")!.value).toBe("654321");
  });

  it("does not fill existing secrets into new-password fields", () => {
    const dom = page('<form><input autocomplete="username"><input id="new" type="password" autocomplete="new-password"><input id="confirm" type="password" autocomplete="new-password"></form>');
    showLightInputs(dom);
    expect(fillCredential({ username: "joy", password: "existing-secret" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: true, filledPassword: false });
    expect(dom.window.document.querySelector<HTMLInputElement>("#new")!.value).toBe("");
    expect(dom.window.document.querySelector<HTMLInputElement>("#confirm")!.value).toBe("");
  });

  it("fills only current-password on mixed password-change forms", () => {
    const dom = page('<form><input autocomplete="username"><input id="current" type="password" autocomplete="current-password"><input id="new" type="password" autocomplete="new-password"><input id="confirm" type="password" autocomplete="new-password"></form>');
    showLightInputs(dom);
    expect(fillCredential({ username: "joy", password: "existing-secret" }, dom.window.document)).toMatchObject({ ok: true, filledPassword: true });
    expect(dom.window.document.querySelector<HTMLInputElement>("#current")!.value).toBe("existing-secret");
    expect(dom.window.document.querySelector<HTMLInputElement>("#new")!.value).toBe("");
    expect(dom.window.document.querySelector<HTMLInputElement>("#confirm")!.value).toBe("");
  });

  it("returns a recoverable error without a password field", () => {
    const dom = page('<form><input type="search"></form>');
    showLightInputs(dom);
    expect(fillCredential({ username: "joy@example.com", password: "secret" }, dom.window.document)).toMatchObject({ ok: false });
  });

  it("fills a one-time-code step without requiring a password field", () => {
    const dom = page('<form><input id="otp" autocomplete="one-time-code" inputmode="numeric"></form>');
    showLightInputs(dom);
    const otp = dom.window.document.querySelector<HTMLInputElement>("#otp")!;
    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ hasPasswordField: false, hasTotpField: true });
    expect(fillCredential({ totpCode: "123456" }, dom.window.document)).toMatchObject({ ok: true, filledTotp: true, filledPassword: false });
    expect(otp.value).toBe("123456");
  });

  it("fills custom fields only when their explicit labels match", () => {
    const dom = page('<form><label>用户名<input autocomplete="username"></label><label>租户 ID<input id="tenant"></label><label>无关字段<input id="other"></label></form>');
    showLightInputs(dom);
    const result = fillCredential({ username: "joy", customFields: [{ name: "租户 ID", value: "monica-cn" }, { name: "不存在", value: "must-not-fill" }] }, dom.window.document);
    expect(result).toMatchObject({ ok: true, filledUsername: true, filledCustomFields: 1 });
    expect(dom.window.document.querySelector<HTMLInputElement>("#tenant")!.value).toBe("monica-cn");
    expect(dom.window.document.querySelector<HTMLInputElement>("#other")!.value).toBe("");
  });

  it("recognizes phone-number usernames and explicit 2FA labels", () => {
    const dom = page('<form><label>手机号码<input type="tel"></label><label>2FA 验证码<input aria-label="2FA code"></label></form>');
    showLightInputs(dom);
    const inputs = dom.window.document.querySelectorAll<HTMLInputElement>("input");
    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ hasUsernameField: true, hasTotpField: true });
    expect(fillCredential({ username: "13800000000", totpCode: "654321" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: true, filledTotp: true });
    expect(Array.from(inputs).map((input) => input.value)).toEqual(["13800000000", "654321"]);
  });

  it("does not treat a generic code field as TOTP", () => {
    const dom = page('<form><label>验证码<input name="code"></label></form>');
    showLightInputs(dom);
    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ hasTotpField: false });
    expect(fillCredential({ totpCode: "123456" }, dom.window.document)).toMatchObject({ ok: false });
  });

  it("does not treat a generic code field before a password as the username", () => {
    const dom = page('<form><input id="code" name="code"><input id="password" type="password"></form>');
    showLightInputs(dom);
    expect(fillCredential({ username: "must-not-fill", password: "secret" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: false, filledPassword: true });
    expect(dom.window.document.querySelector<HTMLInputElement>("#code")!.value).toBe("");
  });

  it("rescans late SPA fields and fills username and password steps independently", () => {
    const dom = page('<main id="app"></main>');
    const app = dom.window.document.querySelector("#app")!;
    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ hasUsernameField: false, hasPasswordField: false });

    app.innerHTML = '<form><input id="username" autocomplete="username"></form>';
    const username = show(dom.window.document.querySelector<HTMLInputElement>("#username")!);
    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ hasUsernameField: true, hasPasswordField: false });
    expect(fillCredential({ username: "spa-user" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: true, filledPassword: false });
    expect(username.value).toBe("spa-user");

    app.innerHTML = '<form><input id="password" type="password" autocomplete="current-password"></form>';
    const password = show(dom.window.document.querySelector<HTMLInputElement>("#password")!);
    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ hasUsernameField: false, hasPasswordField: true });
    expect(fillCredential({ password: "spa-secret" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: false, filledPassword: true });
    expect(password.value).toBe("spa-secret");
  });

  it("discovers and fills login fields in nested open shadow roots", () => {
    const dom = page('<div id="outer"></div>');
    const outer = dom.window.document.querySelector("#outer")!.attachShadow({ mode: "open" });
    const innerHost = dom.window.document.createElement("div");
    outer.append(innerHost);
    const inner = innerHost.attachShadow({ mode: "open" });
    inner.innerHTML = '<form><input id="username" autocomplete="username"><input id="password" type="password"><input id="otp" autocomplete="one-time-code"></form>';
    const username = show(inner.querySelector<HTMLInputElement>("#username")!);
    const password = show(inner.querySelector<HTMLInputElement>("#password")!);
    const otp = show(inner.querySelector<HTMLInputElement>("#otp")!);

    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ hasUsernameField: true, hasPasswordField: true, hasTotpField: true });
    expect(fillCredential({ username: "shadow-user", password: "shadow-secret", totpCode: "123456" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: true, filledPassword: true, filledTotp: true });
    expect([username.value, password.value, otp.value]).toEqual(["shadow-user", "shadow-secret", "123456"]);
  });

  it("does not claim access to a closed shadow root", () => {
    const dom = page('<div id="closed-host"></div>');
    const closed = dom.window.document.querySelector("#closed-host")!.attachShadow({ mode: "closed" });
    closed.innerHTML = '<input id="password" type="password">';
    show(closed.querySelector<HTMLInputElement>("#password")!);

    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ hasUsernameField: false, hasPasswordField: false, hasTotpField: false });
    expect(fillCredential({ password: "must-not-cross-boundary" }, dom.window.document)).toMatchObject({ ok: false });
    expect(closed.querySelector<HTMLInputElement>("#password")!.value).toBe("");
  });
});
