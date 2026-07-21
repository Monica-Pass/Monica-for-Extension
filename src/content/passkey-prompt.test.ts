import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { renderPasskeyPrompt } from "./passkey-prompt";

describe("Passkey confirmation prompt", () => {
  it("uses a stable vector icon and confirms an explicit create request", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://passkey.example.test" });
    const accept = vi.fn().mockResolvedValue(undefined);
    renderPasskeyPrompt({
      candidateId: "candidate",
      operation: "create",
      rpId: "passkey.example.test",
      rpName: "示例网站",
      userName: "demo@example.test",
      saveTargetName: "Monica 本地库",
      credentials: [],
      expiresAt: Date.now() + 10_000
    }, accept, vi.fn().mockResolvedValue(undefined), dom.window.document);

    const host = dom.window.document.getElementById("monica-passkey-prompt-host")!;
    const shadow = host.shadowRoot!;
    expect(shadow.querySelector(".brand-icon svg")).not.toBeNull();
    expect(shadow.textContent).not.toContain("🔑");
    (shadow.querySelector("button.primary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith(undefined));
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
      userName: "demo@example.test",
      credentials: [
        { itemId: "local", title: "本地凭据", userName: "demo", sourceMode: "browser-local" },
        { itemId: "bw", title: "工作凭据", userName: "work", sourceMode: "bitwarden" }
      ],
      expiresAt: Date.now() + 10_000
    }, accept, vi.fn().mockResolvedValue(undefined), dom.window.document);
    const choices = host.shadowRoot!.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(choices).toHaveLength(2);
    expect(choices[0].getAttribute("aria-checked")).toBe("true");
    choices[1].click();
    expect(choices[1].getAttribute("aria-checked")).toBe("true");
    (host.shadowRoot!.querySelector(".primary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith("bw"));
    dom.window.close();
  });
});
