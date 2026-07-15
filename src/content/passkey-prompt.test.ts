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
    expect(shadow.querySelector(".icon svg")).not.toBeNull();
    expect(shadow.textContent).not.toContain("🔑");
    (shadow.querySelector("button.primary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith(undefined));
    await vi.waitFor(() => expect(host.isConnected).toBe(false));
    dom.window.close();
  });
});
