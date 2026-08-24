import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { passkeyPromptRootForTest, renderPasskeyPrompt } from "./passkey-prompt";

describe("Passkey confirmation prompt", () => {
  it("announces Windows Hello before a UV-required operation", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://passkey.example.test" });
    const host = renderPasskeyPrompt({
      candidateId: "candidate-uv", operation: "create", rpId: "passkey.example.test", rpName: "示例网站",
      origin: "https://passkey.example.test", userName: "demo", userVerificationRequired: true,
      saveTargets: [{ providerId: "local", name: "Monica 本地库", sourceMode: "browser-local" }], defaultSaveTargetId: "local",
      credentials: [], expiresAt: Date.now() + 10_000
    }, vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined), dom.window.document, { allowUntrustedEvents: true });
    expect(passkeyPromptRootForTest(host)?.textContent).toContain("Windows Hello 验证身份");
    dom.window.close();
  });

  it("uses a stable vector icon and confirms an explicit create request", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://passkey.example.test" });
    const accept = vi.fn().mockResolvedValue(undefined);
    renderPasskeyPrompt({
      candidateId: "candidate",
      operation: "create",
      rpId: "passkey.example.test",
      rpName: "示例网站",
      origin: "https://passkey.example.test",
      userName: "demo@example.test",
      userDisplayName: "Demo",
      saveTargets: [{ providerId: "local", name: "Monica 本地库", sourceMode: "browser-local" }],
      defaultSaveTargetId: "local",
      credentials: [],
      expiresAt: Date.now() + 10_000
    }, accept, vi.fn().mockResolvedValue(undefined), dom.window.document, { allowUntrustedEvents: true });

    const host = dom.window.document.getElementById("monica-passkey-prompt-host")!;
    expect(host.shadowRoot).toBeNull();
    const shadow = passkeyPromptRootForTest(host)!;
    expect(shadow.querySelector(".brand-icon svg")).not.toBeNull();
    expect(shadow.textContent).not.toContain("🔑");
    (shadow.querySelector("button.primary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith(undefined, "local"));
    await vi.waitFor(() => expect(host.isConnected).toBe(false));
    dom.window.close();
  });

  it("exposes credential choices as a keyboard-friendly radio group", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://passkey.example.test", pretendToBeVisual: true });
    const accept = vi.fn().mockResolvedValue(undefined);
    const host = renderPasskeyPrompt({
      candidateId: "candidate",
      operation: "get",
      rpId: "passkey.example.test",
      rpName: "示例网站",
      origin: "https://login.passkey.example.test",
      userName: "demo@example.test",
      saveTargets: [],
      credentials: [
        { itemId: "local", title: "本地凭据", userName: "demo", userDisplayName: "Demo", sourceMode: "browser-local", useCount: 0 },
        { itemId: "bw", title: "工作凭据", userName: "work", userDisplayName: "Work", sourceMode: "bitwarden", useCount: 3 }
      ],
      expiresAt: Date.now() + 10_000
    }, accept, vi.fn().mockResolvedValue(undefined), dom.window.document, { allowUntrustedEvents: true });
    const shadow = passkeyPromptRootForTest(host)!;
    const choices = shadow.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(choices).toHaveLength(2);
    expect(choices[0].getAttribute("aria-checked")).toBe("true");
    choices[1].click();
    expect(choices[1].getAttribute("aria-checked")).toBe("true");
    choices[1].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(choices[0].getAttribute("aria-checked")).toBe("true");
    choices[1].click();
    (shadow.querySelector(".primary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith("bw", undefined));
    dom.window.close();
  });

  it("dismisses an expired request and restores the previous focus", async () => {
    const dom = new JSDOM("<!doctype html><html><body><button id=before>Before</button></body></html>", { url: "https://passkey.example.test", pretendToBeVisual: true });
    const previous = dom.window.document.querySelector<HTMLButtonElement>("#before")!;
    previous.focus();
    const dismiss = vi.fn().mockResolvedValue(undefined);
    const host = renderPasskeyPrompt({
      candidateId: "candidate",
      operation: "create",
      rpId: "passkey.example.test",
      rpName: "示例网站",
      origin: "https://passkey.example.test",
      userName: "demo@example.test",
      saveTargets: [{ providerId: "local", name: "Monica 本地库", sourceMode: "browser-local" }],
      defaultSaveTargetId: "local",
      credentials: [],
      expiresAt: Date.now() - 1_000
    }, vi.fn().mockResolvedValue(undefined), dismiss, dom.window.document, { allowUntrustedEvents: true });

    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
    expect(host.isConnected).toBe(false);
    expect(dom.window.document.activeElement).toBe(previous);
    dom.window.close();
  });

  it("rejects synthetic webpage clicks even when test code can inspect the closed root", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://passkey.example.test", pretendToBeVisual: true });
    const accept = vi.fn().mockResolvedValue(undefined);
    const host = renderPasskeyPrompt({ candidateId: "candidate", operation: "create", rpId: "passkey.example.test", rpName: "Example", origin: "https://passkey.example.test", userName: "joy", saveTargets: [{ providerId: "local", name: "Local", sourceMode: "browser-local" }], defaultSaveTargetId: "local", credentials: [], expiresAt: Date.now() + 10_000 }, accept, vi.fn().mockResolvedValue(undefined), dom.window.document);
    (passkeyPromptRootForTest(host)!.querySelector(".primary") as HTMLButtonElement).click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(accept).not.toHaveBeenCalled();
    dom.window.close();
  });

  it("cancels when the webpage removes the protected prompt host", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://passkey.example.test", pretendToBeVisual: true });
    const dismiss = vi.fn().mockResolvedValue(undefined);
    const host = renderPasskeyPrompt({ candidateId: "candidate", operation: "create", rpId: "passkey.example.test", rpName: "Example", origin: "https://passkey.example.test", userName: "joy", saveTargets: [{ providerId: "local", name: "Local", sourceMode: "browser-local" }], defaultSaveTargetId: "local", credentials: [], expiresAt: Date.now() + 10_000 }, vi.fn().mockResolvedValue(undefined), dismiss, dom.window.document);
    host.remove();
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
    expect(host.isConnected).toBe(false);
    dom.window.close();
  });

  it("announces a signing failure and restores focus for retry", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://passkey.example.test", pretendToBeVisual: true });
    const accept = vi.fn().mockRejectedValue(new Error("签名暂时失败"));
    const host = renderPasskeyPrompt({ candidateId: "candidate", operation: "create", rpId: "passkey.example.test", rpName: "Example", origin: "https://passkey.example.test", userName: "joy", saveTargets: [{ providerId: "local", name: "Local", sourceMode: "browser-local" }], defaultSaveTargetId: "local", credentials: [], expiresAt: Date.now() + 10_000 }, accept, vi.fn().mockResolvedValue(undefined), dom.window.document, { allowUntrustedEvents: true });
    const shadow = passkeyPromptRootForTest(host)!;
    const confirm = shadow.querySelector<HTMLButtonElement>(".primary")!;
    confirm.focus();
    confirm.click();
    await vi.waitFor(() => expect(shadow.querySelector(".status")?.textContent).toBe("签名暂时失败"));
    expect(shadow.querySelector(".status")?.getAttribute("role")).toBe("alert");
    expect(shadow.activeElement).toBe(confirm);
    confirm.click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(2));
    dom.window.close();
  });

  it("styles the closed-root dismiss control as a centered 24px vector icon", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://passkey.example.test" });
    const host = renderPasskeyPrompt({ candidateId: "candidate", operation: "create", rpId: "passkey.example.test", rpName: "Example", origin: "https://passkey.example.test", userName: "joy", saveTargets: [{ providerId: "local", name: "Local", sourceMode: "browser-local" }], defaultSaveTargetId: "local", credentials: [], expiresAt: Date.now() + 10_000 }, vi.fn(), vi.fn(), dom.window.document, { allowUntrustedEvents: true });
    const styles = passkeyPromptRootForTest(host)!.querySelector("style")!.textContent!;
    expect(styles).toContain(".brand-icon svg, .icon-button svg");
    expect(styles).toContain("display: grid; place-items: center");
    expect(styles).toContain("font: 0.875rem/1.45");
    dom.window.close();
  });
});
