import { describe, expect, it } from "vitest";
import { inlineMenuPosition } from "./inline-position";

const viewport = { left: 0, top: 0, width: 1024, height: 768 };
const field = { left: 100, right: 460, top: 120, bottom: 164, width: 360 };

describe("field anchored autofill placement", () => {
  it("keeps the menu six pixels below a field when space is available", () => {
    expect(inlineMenuPosition(field, viewport, 200)).toMatchObject({ left: 100, top: 170, width: 360, placement: "below" });
  });
  it("flips above a field near the bottom without covering that field", () => {
    expect(inlineMenuPosition({ ...field, top: 690, bottom: 734 }, viewport, 240)).toMatchObject({ top: 444, placement: "above" });
  });
  it("clamps a right-aligned menu within a narrow window", () => {
    const result = inlineMenuPosition({ ...field, left: 210, right: 310, width: 100 }, { ...viewport, width: 320 });
    expect(result?.left).toBe(32);
    expect(result!.left + result!.width).toBeLessThanOrEqual(312);
  });
  it("uses the visible viewport offsets when the page is zoomed", () => {
    const result = inlineMenuPosition({ ...field, top: 300, bottom: 344 }, { left: 80, top: 150, width: 240, height: 400 }, 180);
    expect(result).toMatchObject({ left: 88, top: 350, width: 224, placement: "below" });
  });
  it("limits height to the available space and hides an offscreen or unusable menu", () => {
    expect(inlineMenuPosition({ ...field, top: 120, bottom: 164 }, { ...viewport, height: 320 }, 320)?.maxHeight).toBe(142);
    expect(inlineMenuPosition({ ...field, top: 800, bottom: 844 }, viewport)).toBeUndefined();
    expect(inlineMenuPosition({ ...field, width: 0 }, viewport)).toBeUndefined();
    expect(inlineMenuPosition(field, { ...viewport, width: 180 })).toBeUndefined();
    expect(inlineMenuPosition(field, { ...viewport, height: 200 })).toBeDefined();
    expect(inlineMenuPosition({ ...field, top: 30, bottom: 74 }, { ...viewport, height: 130 })).toBeUndefined();
  });
});
