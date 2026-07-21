import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { SavePromptContext } from "../runtime/messages";
import { renderSavePrompt } from "./save-prompt";

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
  defaultProviderId: "local",
  expiresAt: Date.now() + 60_000
};

describe("save prompt", () => {
  it("renders in Shadow DOM and accepts the selected provider", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } });
    const accept = vi.fn(async () => ({ action: "saved" as const, title: "Example", providerName: "Android WebDAV", syncPending: true }));
    const host = renderSavePrompt(context, { accept, dismiss: vi.fn(async () => undefined) }, dom.window.document);
    const shadow = host.shadowRoot!;
    const select = shadow.querySelector("select")!;
    select.value = "webdav";
    (shadow.querySelector(".primary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith("webdav"));
    expect(shadow.querySelector(".status")?.textContent).toContain("等待同步");
    vi.unstubAllGlobals();
  });

  it("renders update copy without a provider selector", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
    const host = renderSavePrompt({ ...context, action: "update", existingTitle: "Existing" }, { accept: vi.fn(), dismiss: vi.fn() }, dom.window.document);
    expect(host.shadowRoot?.querySelector(".title")?.textContent).toContain("更新");
    expect(host.shadowRoot?.querySelector("select")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("dismisses with Escape and restores control to the page", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com", pretendToBeVisual: true });
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
    const dismiss = vi.fn(async () => undefined);
    const host = renderSavePrompt(context, { accept: vi.fn(), dismiss }, dom.window.document);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
    expect(host.isConnected).toBe(false);
    vi.unstubAllGlobals();
    dom.window.close();
  });
});
