import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { captureCredentialInput, captureRootForEvent } from "./credential-capture";

function page(html: string) {
  return new JSDOM(html, { url: "https://accounts.example.com/login", pretendToBeVisual: true });
}

describe("credential submit capture", () => {
  it("captures a standard login form", () => {
    const dom = page('<title>Example</title><form id="login"><input type="email" value="joy@example.com"><input type="password" autocomplete="current-password" value="secret"></form>');
    const form = dom.window.document.querySelector("form")!;
    expect(captureCredentialInput(form, dom.window.document, dom.window.location)).toEqual({
      username: "joy@example.com",
      password: "secret",
      pageUrl: "https://accounts.example.com/login",
      pageTitle: "Example",
      captureKind: "login"
    });
  });

  it("chooses the confirmed new password on password-change forms", () => {
    const dom = page(`<form><input autocomplete="username" value="joy"><input type="password" autocomplete="current-password" value="old">
      <input type="password" autocomplete="new-password" value="new-secret"><input type="password" autocomplete="new-password" value="new-secret"></form>`);
    expect(captureCredentialInput(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location)).toMatchObject({ username: "joy", password: "new-secret", captureKind: "password-change" });
  });

  it("supports button-driven SPA forms and ignores empty passwords", () => {
    const dom = page('<form><input id="user" value="joy"><input type="password" value=""><button id="login">Login</button></form>');
    const button = dom.window.document.querySelector("button")!;
    expect(captureRootForEvent(button, dom.window.document)).toBe(button.closest("form"));
    expect(captureCredentialInput(button.closest("form")!, dom.window.document, dom.window.location)).toBeNull();
  });
});
