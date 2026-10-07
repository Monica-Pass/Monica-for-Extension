import { describe, expect, it, vi } from "vitest";
import { openVaultSidePanel } from "./side-panel";

describe("real Edge side panel user gesture", () => {
  it("calls the browser API synchronously within the click gesture", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const result = openVaultSidePanel({ open }, 42);
    expect(open).toHaveBeenCalledWith({ windowId: 42 });
    await result;
  });

  it.each([null, -1, NaN, 1.5])("fails closed for an unavailable window %s", async windowId => {
    const open = vi.fn();
    await expect(openVaultSidePanel({ open }, windowId)).rejects.toThrow(/窗口/);
    expect(open).not.toHaveBeenCalled();
  });
});
