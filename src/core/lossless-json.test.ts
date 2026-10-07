import { describe, expect, it } from "vitest";
import { cloneLosslessJson, jsonScalarText, parseLosslessJson } from "./lossless-json";
import { nextOtpCounter, normalizeOtpCounter } from "./otp-counter";

describe("lossless provider JSON", () => {
  it("preserves numeric lexemes and literal marker/prototype keys without collisions", () => {
    const text = '{"__proto__":{"safe":true},"$serde_json::private::Number":"literal","rawJSON":"not a number","n":9007199254740993,"d":1.00000000000000001,"exp":1e999,"minusZero":-0,"values":[null,false,0,"",123456789012345678901234567890]}';
    const parsed = parseLosslessJson(text) as Record<string, unknown>;
    expect(JSON.stringify(cloneLosslessJson(parsed))).toBe(text);
    expect(jsonScalarText(parsed.n)).toBe("9007199254740993");
    expect(({} as { safe?: boolean }).safe).toBeUndefined();
  });
  it("rejects counter overflow, rounded numbers and invalid integers", () => {
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1e3", "9223372036854775808"]) expect(() => normalizeOtpCounter(invalid)).toThrow();
    expect(() => nextOtpCounter("9223372036854775807")).toThrow();
    expect(nextOtpCounter("9007199254740993")).toBe("9007199254740994");
  });
});
