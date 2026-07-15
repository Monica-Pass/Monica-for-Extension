import { describe, expect, it } from "vitest";
import { assertTrustedExtensionPage, isSecureSensitivePageUrl, requireTrustedWebPageSender } from "./sender-policy";

const runtimeId = "monica-extension-id";
const extensionRoot = `chrome-extension://${runtimeId}/`;

function sender(value: Partial<chrome.runtime.MessageSender>): chrome.runtime.MessageSender {
  return value as chrome.runtime.MessageSender;
}

describe("runtime sender policy", () => {
  it("accepts only a same-extension page for privileged commands", () => {
    expect(() => assertTrustedExtensionPage(sender({ id: runtimeId, url: `${extensionRoot}index.html` }), runtimeId, extensionRoot)).not.toThrow();
    expect(() => assertTrustedExtensionPage(sender({ id: "other", url: `${extensionRoot}index.html` }), runtimeId, extensionRoot)).toThrow();
    expect(() => assertTrustedExtensionPage(sender({ id: runtimeId, url: "https://example.com" }), runtimeId, extensionRoot)).toThrow();
    expect(() => assertTrustedExtensionPage(sender({ id: runtimeId, url: `${extensionRoot}index.html`, tab: { id: 1 } as chrome.tabs.Tab }), runtimeId, extensionRoot)).not.toThrow();
  });

  it("binds page commands to a same-extension content script and consistent origin", () => {
    expect(requireTrustedWebPageSender(sender({ id: runtimeId, url: "https://login.example/path", origin: "https://login.example", tab: { id: 7 } as chrome.tabs.Tab, frameId: 2 }), runtimeId)).toEqual({
      tabId: 7,
      frameId: 2,
      url: "https://login.example/path",
      origin: "https://login.example"
    });
    expect(() => requireTrustedWebPageSender(sender({ id: "other", url: "https://login.example", tab: { id: 7 } as chrome.tabs.Tab }), runtimeId)).toThrow();
    expect(() => requireTrustedWebPageSender(sender({ id: runtimeId, url: "https://login.example", origin: "https://attacker.example", tab: { id: 7 } as chrome.tabs.Tab }), runtimeId)).toThrow();
    expect(() => requireTrustedWebPageSender(sender({ id: runtimeId, url: `${extensionRoot}index.html`, tab: { id: 7 } as chrome.tabs.Tab }), runtimeId)).toThrow();
  });

  it("allows sensitive operations only on HTTPS or exact loopback HTTP", () => {
    expect(isSecureSensitivePageUrl("https://login.example")).toBe(true);
    expect(isSecureSensitivePageUrl("http://localhost:3000")).toBe(true);
    expect(isSecureSensitivePageUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isSecureSensitivePageUrl("http://login.example")).toBe(false);
    expect(isSecureSensitivePageUrl("ftp://login.example")).toBe(false);
  });
});
