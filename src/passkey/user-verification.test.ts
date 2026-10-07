import { describe, expect, it, vi } from "vitest";
import { PasskeyUserVerification } from "./user-verification";

function harness() {
  const verify = vi.fn(async (_password: string): Promise<void> => undefined);
  const windows = { create: vi.fn(async () => ({ id: 42 })), remove: vi.fn(async () => undefined), onRemoved: { addListener: vi.fn() } };
  const root = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
  const runtime = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", getURL: (path: string) => root + path };
  const broker = new PasskeyUserVerification(verify, { runtime, windows } as unknown as Pick<typeof chrome, "runtime" | "windows">);
  const result = broker.request({ candidateId: "ceremony", operation: "get", rpId: "github.com", origin: "https://github.com", accountName: "synthetic", expiresAt: Date.now() + 60_000 });
  // A handled outcome also catches cancellation before an assertion awaits it.
  const outcome = result.then(() => "verified", () => "cancelled");
  const url = (windows.create.mock.calls[0] as unknown as [{ url: string }])[0].url;
  const id = new URL(url).searchParams.get("request")!;
  const sender = { id: runtime.id, url, frameId: 0 } as chrome.runtime.MessageSender;
  return { broker, verify, windows, id, sender, outcome, root };
}

describe("Passkey verification window boundary", () => {
  it("routes unlock through a scoped verifier, checks its method and invalidates its guard on cancel", async () => {
    const h = harness();
    h.broker.cancelAll();
    let guard!: () => void;
    const verify = vi.fn(async (_password: string, assertActive: () => void) => { guard = assertActive; assertActive(); });
    const completion = h.broker.request({ candidateId: "unlock", operation: "get", rpId: "github.com", origin: "https://github.com", accountName: "", expiresAt: Date.now() + 60_000, unlockRequired: true, method: "windows-hello" }, verify).then(() => "verified", () => "cancelled");
    const url = (h.windows.create.mock.calls[1] as unknown as [{url: string}])[0].url;
    const id = new URL(url).searchParams.get("request")!;
    const sender = { ...h.sender, url };
    expect(h.broker.context(id, sender)).toMatchObject({ unlockRequired: true, method: "windows-hello" });
    await expect(h.broker.verify(id, "password", sender)).rejects.toThrow("方式");
    expect(verify).not.toHaveBeenCalled();
    await h.broker.verify(id, "", sender, "windows-hello");
    expect(await completion).toBe("verified");
    expect(() => guard()).toThrow();
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("requires the exact extension verification window and rejects replay", async () => {
    const h = harness();
    expect(h.broker.context(h.id, h.sender)).toMatchObject({ rpId: "github.com", accountName: "synthetic" });
    expect(() => h.broker.context(h.id, { ...h.sender, url: "https://github.com/" })).toThrow();
    expect(() => h.broker.context(h.id, { ...h.sender, url: h.root + "index.html" })).toThrow();
    await expect(h.broker.verify(h.id, "password", { ...h.sender, frameId: 1 })).rejects.toThrow();
    expect(h.verify).not.toHaveBeenCalled();
    await h.broker.verify(h.id, "password", h.sender);
    expect(await h.outcome).toBe("verified");
    await expect(h.broker.verify(h.id, "password", h.sender)).rejects.toThrow();
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("does not accept a late password verification after the request was cancelled", async () => {
    const h = harness();
    let complete!: () => void;
    h.verify.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const attempt = h.broker.verify(h.id, "password", h.sender);
    h.broker.cancelCandidate("ceremony");
    complete();
    await expect(attempt).rejects.toThrow();
    expect(await h.outcome).toBe("cancelled");
  });

  it("permits retry after a wrong password and cancels after five failures", async () => {
    const h = harness();
    h.verify.mockRejectedValue(new Error("wrong password"));
    for (let attempt = 0; attempt < 5; attempt++) await expect(h.broker.verify(h.id, "wrong", h.sender)).rejects.toThrow();
    expect(await h.outcome).toBe("cancelled");
    expect(() => h.broker.context(h.id, h.sender)).toThrow();
  });

  it("cancels verification when the window is closed", async () => {
    const h = harness();
    await Promise.resolve();
    const onRemoved = (h.windows.onRemoved.addListener.mock.calls[0] as unknown as [(id: number) => void])[0];
    onRemoved(42);
    expect(await h.outcome).toBe("cancelled");
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("expires a verification without accepting a late response", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await h.outcome).toBe("cancelled");
      await expect(h.broker.verify(h.id, "password", h.sender)).rejects.toThrow();
      expect(h.verify).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
