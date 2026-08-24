import { describe, expect, it } from "vitest";
import { DEFAULT_WORD_PASSWORD_WORDS, generatePassphrase, generatePassword, generatePin, generateWordPassword } from "./credential-generator";

function sequence(...values: number[]) { let index = 0; return (upper: number) => values[index++ % values.length] % upper; }
const zeros = () => 0;

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

  it("keeps the Android fruit wordlist for word passwords", () => {
    expect(DEFAULT_WORD_PASSWORD_WORDS).toEqual(["apple", "banana", "cherry", "date", "elderberry", "fig", "grape", "honeydew", "kiwi", "lemon", "mango", "nectarine", "orange", "papaya", "quince", "raspberry", "strawberry", "tangerine", "watermelon", "blueberry"]);
  });

  it("concatenates words with digit padding like Android", () => {
    expect(generateWordPassword({ length: 20, includeNumbers: true }, zeros)).toBe("appleappleapple00000");
    expect(generateWordPassword({ length: 20, includeNumbers: true, firstLetterUppercase: true }, zeros)).toBe("Appleappleapple00000");
    expect(generateWordPassword({ length: 10, includeNumbers: false }, zeros)).toBe("appleapple");
  });

  it("inserts separators without counting them towards the length", () => {
    expect(generateWordPassword({ length: 12, includeNumbers: true, separator: "-", segmentLength: 4 }, zeros)).toBe("appl-eapp-le00");
    expect(generateWordPassword({ length: 12, includeNumbers: true, separator: "-#", segmentLength: 4 }, zeros)).toBe("appl-eapp-le00");
  });

  it("accounts separators towards the length like Android", () => {
    expect(generateWordPassword({ length: 13, includeNumbers: true, separator: "-", segmentLength: 4, separatorCountsTowardsLength: true }, zeros)).toBe("appl-eapp-le");
  });

  it("falls back to unsegmented generation for invalid segments", () => {
    expect(generateWordPassword({ length: 12, includeNumbers: false, separator: "-", segmentLength: 12 }, zeros)).toBe("appleapple");
    expect(generateWordPassword({ length: 12, includeNumbers: false, segmentLength: 4 }, zeros)).toBe("appleapple");
    expect(generateWordPassword({ length: 6, includeNumbers: false }, zeros)).toBe("applea");
  });

  it("honors a custom injected wordlist", () => {
    expect(generateWordPassword({ length: 9, includeNumbers: false, wordlist: ["alpha", "beta"] }, sequence(0, 1))).toBe("alphabeta");
  });
});
