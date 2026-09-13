import { afterEach, describe, expect, it, vi } from "vitest";
import { INLINE_AUTOFILL_ENABLED_KEY, readInlineAutofillEnabled, setInlineAutofillEnabled } from "./inline-preferences";
import { assertInlineSessionId } from "./inline-contract";

afterEach(() => vi.unstubAllGlobals());
describe("inline autofill preferences", () => {
  it("defaults on for existing installations and persists off without editing vault data", async () => {
    const data: Record<string, unknown> = {};
    const set = vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, value); });
    vi.stubGlobal("chrome", { storage: { local: { get: vi.fn(async () => data), set } } });
    expect(await readInlineAutofillEnabled()).toBe(true);
    await setInlineAutofillEnabled(false);
    expect(await readInlineAutofillEnabled()).toBe(false);
    expect(set).toHaveBeenCalledExactlyOnceWith({ [INLINE_AUTOFILL_ENABLED_KEY]: false });
    expect(Object.keys(data)).toEqual([INLINE_AUTOFILL_ENABLED_KEY]);
  });
  it("rejects invalid writes and surfaces a failed preference save", async () => {
    const set = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    vi.stubGlobal("chrome", { storage: { local: { set } } });
    await expect(setInlineAutofillEnabled("false" as unknown as boolean)).rejects.toThrow("Invalid");
    expect(set).not.toHaveBeenCalled();
    await expect(setInlineAutofillEnabled(false)).rejects.toThrow("storage unavailable");
  });
  it("accepts only bounded, generated field sessions", () => {
    expect(() => assertInlineSessionId("aaaabbbb-cccc-4ddd-8eee-ffffffffffff")).not.toThrow();
    for (const value of [undefined, {}, "", "https://example.test", "a".repeat(10000)]) {
      expect(() => assertInlineSessionId(value)).toThrow();
    }
  });
});
