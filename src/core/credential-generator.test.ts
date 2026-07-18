import { describe, expect, it } from "vitest";
import { generatePassphrase, generatePassword, generatePin } from "./credential-generator";

function sequence(...values: number[]) { let index = 0; return (upper: number) => values[index++ % values.length] % upper; }

describe("Android-compatible credential generators", () => {
  it("enforces per-group minimums and exclusions", () => {
    const password = generatePassword({ length: 12, uppercaseMin: 2, lowercaseMin: 2, numbersMin: 2, symbolsMin: 2, excludeSimilar: true, excludeAmbiguous: true }, sequence(0, 1, 2, 3, 4, 5));
    expect(password).toHaveLength(12);
    expect(password.match(/[A-Z]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(password.match(/[a-z]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(password.match(/\d/g)?.length).toBeGreaterThanOrEqual(2);
    expect(password).not.toMatch(/[0Ol1I{}[\]()/\\'"`~,;:.<>]/);
  });

  it("rejects impossible configurations", () => {
    expect(() => generatePassword({ length: 3, uppercaseMin: 2, lowercaseMin: 2 }, sequence(0))).toThrow("不能超过");
    expect(() => generatePassword({ length: 4, uppercaseChars: "", lowercaseChars: "", numberChars: "", symbolChars: "" }, sequence(0))).toThrow("至少启用");
  });

  it("generates PIN and Android fallback passphrases", () => {
    expect(generatePin(6, sequence(1, 2, 3))).toBe("123123");
    expect(generatePassphrase({ length: 4, delimiter: "-", capitalize: true, customWord: "monica" }, sequence(1, 0, 2, 3, 4))).toBe("Alpha-Monica-Charlie-Delta");
  });
});
