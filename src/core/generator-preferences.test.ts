import { describe, expect, it } from "vitest";
import { DEFAULT_SYMBOLS, generatePassword } from "./credential-generator";
import { GENERATOR_PREFERENCES_STORAGE_KEY, GeneratorPreferencesStore, normalizeGeneratorPreferences, resolveAllowedSymbols } from "./generator-preferences";

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(key: string) { return { [key]: data[key] }; },
    async set(key: string, value: unknown) { data[key] = JSON.parse(JSON.stringify(value)); }
  };
}

describe("generator preferences parity", () => {
  it("keeps browser first-run defaults aligned with the current manager", () => {
    const preferences = normalizeGeneratorPreferences(undefined);
    expect(preferences).toMatchObject({ selectedGenerator: "SYMBOL", symbolLength: 20, includeUppercase: true, includeLowercase: true, includeNumbers: true, includeSymbols: true, useSymbolExclusionMode: true, excludedSymbols: "", customSymbols: DEFAULT_SYMBOLS, excludeSimilar: true, excludeAmbiguous: false, uppercaseMin: 1, lowercaseMin: 1, numbersMin: 1, symbolsMin: 1, passphraseWordCount: 4, passphraseDelimiter: "-", passphraseCapitalize: false, passphraseIncludeNumber: false, passphraseCustomWord: "", pinLength: 6, passwordLength: 12, firstLetterUppercase: false, includeNumbersInPassword: true, customSeparator: "", separatorCountsTowardsLength: false, segmentLength: 0 });
  });

  it("normalizes word-password preferences within Android UI ranges", () => {
    const preferences = normalizeGeneratorPreferences({ selectedGenerator: "PASSWORD", passwordLength: 999, firstLetterUppercase: true, includeNumbersInPassword: false, customSeparator: "_-=", separatorCountsTowardsLength: "no", segmentLength: -3 });
    expect(preferences.selectedGenerator).toBe("PASSWORD");
    expect(preferences.passwordLength).toBe(128);
    expect(preferences.firstLetterUppercase).toBe(true);
    expect(preferences.includeNumbersInPassword).toBe(false);
    expect(preferences.customSeparator).toBe("_-=");
    expect(preferences.separatorCountsTowardsLength).toBe(false);
    expect(preferences.segmentLength).toBe(0);
  });

  it("falls back to defaults for corrupt or mistyped stored values", () => {
    expect(normalizeGeneratorPreferences("garbage")).toEqual(normalizeGeneratorPreferences(undefined));
    expect(normalizeGeneratorPreferences(42)).toEqual(normalizeGeneratorPreferences(undefined));
    const defaults = normalizeGeneratorPreferences(undefined);
    const corrupted = normalizeGeneratorPreferences({ selectedGenerator: "RSA", symbolLength: "long", includeUppercase: "yes", passphraseDelimiter: 9 });
    expect(corrupted.selectedGenerator).toBe("SYMBOL");
    expect(corrupted.symbolLength).toBe(defaults.symbolLength);
    expect(corrupted.includeUppercase).toBe(true);
    expect(corrupted.passphraseDelimiter).toBe("-");
    expect(normalizeGeneratorPreferences({ uppercaseMin: -5 }).uppercaseMin).toBe(0);
    expect(normalizeGeneratorPreferences({ symbolsMin: 9999 }).symbolsMin).toBe(256);
  });

  it("clamps lengths and minimums like Android SymbolPasswordGeneratorOptions", () => {
    const defaults = normalizeGeneratorPreferences(undefined);
    const preferences = normalizeGeneratorPreferences({ symbolLength: 999, uppercaseMin: 3.7, lowercaseMin: -1, numbersMin: "12", symbolsMin: null, passphraseWordCount: 0, passphraseCustomWord: "  " });
    expect(preferences.symbolLength).toBe(128);
    expect(preferences.uppercaseMin).toBe(3);
    expect(preferences.lowercaseMin).toBe(0);
    expect(preferences.numbersMin).toBe(12);
    expect(preferences.symbolsMin).toBe(defaults.symbolsMin);
    expect(preferences.passphraseWordCount).toBe(1);
    expect(preferences.passphraseCustomWord).toBe("");
  });

  it("de-duplicates symbol sets and bounds their size", () => {
    const preferences = normalizeGeneratorPreferences({ excludedSymbols: "!@!@ x?", customSymbols: "!?!!??\u0000" });
    expect([...preferences.excludedSymbols].sort()).toEqual(["!", "?", "@"]);
    expect(preferences.customSymbols).toBe("!?");
    expect(normalizeGeneratorPreferences({ customSymbols: "x".repeat(600) }).customSymbols.length).toBeLessThanOrEqual(256);
  });

  it("resolves allowed symbols through exclusion or explicit custom sets", () => {
    const base = normalizeGeneratorPreferences(undefined);
    expect(resolveAllowedSymbols({ ...base, useSymbolExclusionMode: true, excludedSymbols: "!@" })).toBe(DEFAULT_SYMBOLS.replace(/[!@]/g, ""));
    expect(resolveAllowedSymbols({ ...base, useSymbolExclusionMode: false, customSymbols: "!?" })).toBe("!?");
    expect(resolveAllowedSymbols(base)).toBe(DEFAULT_SYMBOLS);
  });

  it("generates passwords honoring persisted symbol mode and minimum counts", () => {
    const base = normalizeGeneratorPreferences(undefined);
    const symbols = resolveAllowedSymbols({ ...base, useSymbolExclusionMode: true, excludedSymbols: "!@#$%^&*()" });
    const output = generatePassword({ length: 32, symbolChars: symbols, symbolsMin: 8, excludeSimilar: true }, (limit) => limit - 1);
    expect(output.length).toBe(32);
    expect(output).not.toMatch(/[!@#$%^&*()]/);
  });

  it("round-trips preferences through storage and repairs damaged entries", async () => {
    const storage = fakeStorage();
    const store = new GeneratorPreferencesStore(storage);
    expect(await store.load()).toEqual(normalizeGeneratorPreferences(undefined));
    await store.save(normalizeGeneratorPreferences({ symbolLength: 48, includeSymbols: false, symbolsMin: 2, selectedGenerator: "PIN" }));
    expect(Object.keys(storage.data)).toContain(GENERATOR_PREFERENCES_STORAGE_KEY);
    expect(await new GeneratorPreferencesStore(storage).load()).toMatchObject({ selectedGenerator: "PIN", symbolLength: 48, includeSymbols: false, symbolsMin: 2 });
    storage.data[GENERATOR_PREFERENCES_STORAGE_KEY] = "{broken";
    expect(await store.load()).toEqual(normalizeGeneratorPreferences(undefined));
  });
});
