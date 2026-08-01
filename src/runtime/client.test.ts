import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultClient } from "./client";

describe("extension runtime client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves a bounded background error code for MDBX2 safety recovery", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: false,
      error: "Native Host 在冲突写入后异常中断。",
      code: "conflict-resolution-state-unknown"
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await expect(vaultClient.resolveMdbx2Conflict(
      "provider-1",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "incoming-wins"
    )).rejects.toMatchObject({
      name: "ExtensionRuntimeError",
      code: "conflict-resolution-state-unknown"
    });
  });
});
