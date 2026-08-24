import { describe, expect, it } from "vitest";
import { createCode128DataUrl } from "./barcode";

describe("local barcode rendering", () => {
  it("renders a Code 128 payload as a local SVG data URL", async () => {
    const dataUrl = await createCode128DataUrl("MONICA-123456789");
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(atob(dataUrl.split(",")[1])).toContain("<svg");
  });

  it("rejects an empty or oversized payload", async () => {
    await expect(createCode128DataUrl(" ")).rejects.toThrow(/为空/);
    await expect(createCode128DataUrl("x".repeat(4_097))).rejects.toThrow(/过长/);
  });
});
