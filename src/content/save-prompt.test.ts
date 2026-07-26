import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { SavePromptContext } from "../runtime/messages";
import { renderSavePrompt, savePromptRootForTest } from "./save-prompt";

const context: SavePromptContext = {
  candidateId: "candidate",
  action: "save",
  title: "Example",
  username: "joy@example.com",
  host: "example.com",
  providers: [
    { id: "local", name: "Monica 本地库", kind: "local", isDefault: true },
    { id: "webdav", name: "Android WebDAV", kind: "monica-webdav", isDefault: false }
  ],
  updateTargets: [],
  defaultProviderId: "local",
  expiresAt: Date.now() + 60_000
};

describe("save prompt", () => {
  it("renders in Shadow DOM and accepts the selected provider", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } });
    const accept = vi.fn(async () => ({ action: "saved" as const, title: "Example", providerName: "Android WebDAV", syncPending: true }));
    const host = renderSavePrompt(context, { accept, dismiss: vi.fn(async () => undefined) }, dom.window.document, { allowUntrustedEvents: true });
    expect(host.shadowRoot).toBeNull();
    const shadow = savePromptRootForTest(host)!;
    const select = shadow.querySelector("select")!;
    select.value = "webdav";
    (shadow.querySelector(".primary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith("webdav", undefined));
    expect(shadow.querySelector(".status")?.textContent).toContain("等待同步");
    vi.unstubAllGlobals();
  });

  it("renders update copy without a provider selector", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
    const host = renderSavePrompt({ ...context, action: "update", existingTitle: "Existing" }, { accept: vi.fn(), dismiss: vi.fn() }, dom.window.document, { allowUntrustedEvents: true });
    const shadow = savePromptRootForTest(host)!;
    expect(shadow.querySelector(".title")?.textContent).toContain("更新");
    expect(shadow.querySelector("select")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("requires an explicit choice when several same-username logins can be updated", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
    const accept = vi.fn(async () => ({ action: "updated" as const, title: "Work", providerName: "Bitwarden", syncPending: true }));
    const host = renderSavePrompt({
      ...context,
      action: "choose",
      updateTargets: [
        { id: "local-login", title: "Personal", username: "joy@example.com", providerName: "Monica 本地库" },
        { id: "work-login", title: "Work", username: "joy@example.com", providerName: "Bitwarden" }
      ]
    }, { accept, dismiss: vi.fn() }, dom.window.document, { allowUntrustedEvents: true });
    const shadow = savePromptRootForTest(host)!;
    const strategy = shadow.querySelector<HTMLSelectElement>('select[aria-label="选择更新目标或另存为新项"]')!;
    const confirm = shadow.querySelector<HTMLButtonElement>(".primary")!;
    expect(confirm.disabled).toBe(true);
    strategy.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(strategy.value).toBe("work-login");
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toBe("更新所选密码");
    confirm.click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith(undefined, "work-login"));
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("dismisses with Escape and restores control to the page", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
    const dismiss = vi.fn(async () => undefined);
    const host = renderSavePrompt(context, { accept: vi.fn(), dismiss }, dom.window.document, { allowUntrustedEvents: true });
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
    expect(host.isConnected).toBe(false);
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("does not allow a synthetic webpage click to save or update", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
    const accept = vi.fn();
    const host = renderSavePrompt(context, { accept, dismiss: vi.fn() }, dom.window.document);
    (savePromptRootForTest(host)!.querySelector(".primary") as HTMLButtonElement).click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(accept).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("fails closed when the webpage tampers with the prompt host", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
    const dismiss = vi.fn(async () => undefined);
    const host = renderSavePrompt(context, { accept: vi.fn(), dismiss }, dom.window.document);
    host.setAttribute("style", "display:none");
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
    expect(host.isConnected).toBe(false);
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("announces an async error and restores focus for a keyboard retry", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
    const accept = vi.fn().mockRejectedValue(new Error("保存位置暂时不可用"));
    const host = renderSavePrompt(context, { accept, dismiss: vi.fn() }, dom.window.document, { allowUntrustedEvents: true });
    const shadow = savePromptRootForTest(host)!;
    const confirm = shadow.querySelector<HTMLButtonElement>(".primary")!;
    confirm.focus();
    confirm.click();
    await vi.waitFor(() => expect(shadow.querySelector(".status")?.textContent).toBe("保存位置暂时不可用"));
    expect(shadow.querySelector(".status")?.getAttribute("role")).toBe("alert");
    expect(shadow.activeElement).toBe(confirm);
    confirm.click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(2));
    vi.unstubAllGlobals();
    dom.window.close();
  });
});
