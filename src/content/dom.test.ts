import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { fillCredential, scanPage } from "./dom";

function page(html: string) {
  const dom = new JSDOM(html, { url: "https://accounts.example.com/login", pretendToBeVisual: true });
  for (const input of Array.from(dom.window.document.querySelectorAll<HTMLInputElement>("input"))) {
    input.getBoundingClientRect = () => ({ x: 0, y: 0, width: 240, height: 44, top: 0, right: 240, bottom: 44, left: 0, toJSON: () => ({}) });
  }
  return dom;
}

describe("content autofill DOM engine", () => {
  it("scans a login form", () => {
    const dom = page('<form><input type="email"><input type="password"></form>');
    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ host: "accounts.example.com", hasUsernameField: true, hasPasswordField: true });
  });

  it("fills only after an explicit invocation", () => {
    const dom = page('<form><input id="username" autocomplete="username"><input id="password" type="password"></form>');
    const username = dom.window.document.querySelector<HTMLInputElement>("#username")!;
    const password = dom.window.document.querySelector<HTMLInputElement>("#password")!;
    expect([username.value, password.value]).toEqual(["", ""]);
    expect(fillCredential({ username: "joy@example.com", password: "correct horse" }, dom.window.document)).toMatchObject({ ok: true, filledUsername: true, filledPassword: true });
    expect([username.value, password.value]).toEqual(["joy@example.com", "correct horse"]);
  });

  it("returns a recoverable error without a password field", () => {
    const dom = page('<form><input type="search"></form>');
    expect(fillCredential({ username: "joy@example.com", password: "secret" }, dom.window.document)).toMatchObject({ ok: false });
  });

  it("fills a one-time-code step without requiring a password field", () => {
    const dom = page('<form><input id="otp" autocomplete="one-time-code" inputmode="numeric"></form>');
    const otp = dom.window.document.querySelector<HTMLInputElement>("#otp")!;
    expect(scanPage(dom.window.document, dom.window.location)).toMatchObject({ hasPasswordField: false, hasTotpField: true });
    expect(fillCredential({ totpCode: "123456" }, dom.window.document)).toMatchObject({ ok: true, filledTotp: true, filledPassword: false });
    expect(otp.value).toBe("123456");
  });
});
