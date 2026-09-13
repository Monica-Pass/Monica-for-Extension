import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { selectUiLocale, updateUiLocale } from "../i18n/runtime";
import english from "../i18n/ui-en.json";
import { renderSavePrompt, savePromptRootForTest } from "./save-prompt";
import { renderPasskeyPrompt, passkeyPromptRootForTest } from "./passkey-prompt";

afterEach(() => { updateUiLocale("zh-CN"); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.stubGlobal("chrome", { runtime: { getURL: (value: string) => `chrome-extension://test/${value}` } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(readFileSync(`public${new URL(url).pathname}`, "utf8"))));
});
const languages = ["en", "ja", "ko", "de", "es", "ru", "vi"] as const;
const catalog = (language: typeof languages[number]): Record<string, string> => language === "en" ? english : JSON.parse(readFileSync(`public/locales/ui-${language}.json`, "utf8"));

it.each(languages)("updates an open save prompt to %s without resetting choices or translating user content", async (language) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test", pretendToBeVisual: true });
  vi.stubGlobal("chrome", { runtime: { getURL: (value: string) => `chrome-extension://test/${value}` } });
  const accept = vi.fn();
  const host = renderSavePrompt({
    candidateId: "save", action: "choose", title: "个人账号", username: "中文用户名", host: "example.test",
    providers: [{ id: "local", name: "Monica 本地库", kind: "local", isDefault: true }, { id: "remote", name: "我的远端", kind: "bitwarden", isDefault: false }],
    defaultProviderId: "local", updateTargets: [], expiresAt: Date.now() + 60_000
  }, { accept, dismiss: vi.fn(async () => undefined) }, dom.window.document, { allowUntrustedEvents: true });
  try {
    const shadow = savePromptRootForTest(host)!;
    const [strategy, provider] = [...shadow.querySelectorAll("select")];
    strategy.value = "new";
    strategy.dispatchEvent(new dom.window.Event("change"));
    provider.value = "remote";
    provider.dispatchEvent(new dom.window.Event("change"));
    await selectUiLocale(language);
    expect(shadow.querySelector(".title")?.textContent).toBe(catalog(language)["选择如何保存密码"]);
    expect(shadow.querySelector(".primary")?.textContent).toBe(catalog(language)["保存为新登录项"]);
    expect(shadow.querySelector(".account-name")?.textContent).toBe("中文用户名");
    expect(strategy.value).toBe("new");
    expect(provider.value).toBe("remote");
    expect(provider.selectedOptions[0].textContent).toBe("我的远端");
    expect(shadow.querySelector("section")?.lang).toBe(language);
    expect(accept).not.toHaveBeenCalled();
  } finally { host.remove(); await Promise.resolve(); dom.window.close(); }
});

it.each(languages)("updates Passkey consent to %s while retaining the explicitly selected credential", async (language) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test", pretendToBeVisual: true });
  const accept = vi.fn();
  const host = renderPasskeyPrompt({
    candidateId: "passkey", operation: "get", rpId: "example.test", rpName: "网站名", origin: "https://example.test", userName: "",
    saveTargets: [], credentials: [
      { itemId: "one", title: "个人账号", userName: "me", userDisplayName: "个人", providerName: "我的设备", sourceMode: "browser-local", credentialConflict: false, useCount: 0 },
      { itemId: "two", title: "工作账号", userName: "work", userDisplayName: "工作", providerName: "公司的密码库", sourceMode: "bitwarden", credentialConflict: false, useCount: 1 }
    ], expiresAt: Date.now() + 60_000
  }, accept, vi.fn(async () => undefined), dom.window.document, { allowUntrustedEvents: true });
  try {
    const shadow = passkeyPromptRootForTest(host)!;
    const choice = shadow.querySelectorAll<HTMLButtonElement>(".choice")[1];
    choice.click();
    await selectUiLocale(language);
    expect(choice.getAttribute("aria-checked")).toBe("true");
    expect(choice.querySelector("strong")?.textContent).toBe("工作账号");
    expect(shadow.querySelector(".title")?.textContent).toBe(catalog(language)["使用 Monica Passkey 登录？"]);
    expect(shadow.querySelector(".security-label")?.textContent).toBe(catalog(language)["已验证 Passkey 范围"]);
    expect(shadow.querySelector(".secondary")?.textContent).toBe(catalog(language)["取消"]);
    expect(shadow.querySelector("section")?.lang).toBe(language);
    expect(accept).not.toHaveBeenCalled();
  } finally { host.remove(); await Promise.resolve(); dom.window.close(); }
});
