import { DEFAULT_SYMBOLS } from "./credential-generator";

export const GENERATOR_PREFERENCES_STORAGE_KEY = "generator_preferences_v1";

export type GeneratorMode = "SYMBOL" | "PASSWORD" | "PIN" | "PASSPHRASE" | "SSH_KEY";

export interface GeneratorPreferences {
  selectedGenerator: GeneratorMode;
  symbolLength: number;
  includeUppercase: boolean;
  includeLowercase: boolean;
  includeNumbers: boolean;
  includeSymbols: boolean;
  useSymbolExclusionMode: boolean;
  excludedSymbols: string;
  customSymbols: string;
  excludeSimilar: boolean;
  excludeAmbiguous: boolean;
  uppercaseMin: number;
  lowercaseMin: number;
  numbersMin: number;
  symbolsMin: number;
  passphraseWordCount: number;
  passphraseDelimiter: string;
  passphraseCapitalize: boolean;
  passphraseIncludeNumber: boolean;
  passphraseCustomWord: string;
  pinLength: number;
  passwordLength: number;
  firstLetterUppercase: boolean;
  includeNumbersInPassword: boolean;
  customSeparator: string;
  separatorCountsTowardsLength: boolean;
  segmentLength: number;
  sshKeyAlgorithm: "ED25519" | "RSA";
  sshKeyRsaSize: number;
}

export const DEFAULT_GENERATOR_PREFERENCES: GeneratorPreferences = {
  selectedGenerator: "SYMBOL",
  symbolLength: 20,
  includeUppercase: true,
  includeLowercase: true,
  includeNumbers: true,
  includeSymbols: true,
  useSymbolExclusionMode: true,
  excludedSymbols: "",
  customSymbols: DEFAULT_SYMBOLS,
  excludeSimilar: true,
  excludeAmbiguous: false,
  uppercaseMin: 1,
  lowercaseMin: 1,
  numbersMin: 1,
  symbolsMin: 1,
  passphraseWordCount: 4,
  passphraseDelimiter: "-",
  passphraseCapitalize: false,
  passphraseIncludeNumber: false,
  passphraseCustomWord: "",
  pinLength: 6,
  passwordLength: 12,
  firstLetterUppercase: false,
  includeNumbersInPassword: true,
  customSeparator: "",
  separatorCountsTowardsLength: false,
  segmentLength: 0,
  sshKeyAlgorithm: "ED25519",
  sshKeyRsaSize: 3072
};

const GENERATOR_MODES: GeneratorMode[] = ["SYMBOL", "PASSWORD", "PIN", "PASSPHRASE", "SSH_KEY"];
const SSH_RSA_SIZES = [2048, 3072, 4096];
const MAX_SYMBOL_SET_LENGTH = 256;

export function normalizeGeneratorPreferences(raw: unknown): GeneratorPreferences {
  const source = isRecord(raw) ? raw : {};
  return {
    selectedGenerator: pickMode(source.selectedGenerator),
    symbolLength: clampInteger(source.symbolLength, 4, 128, DEFAULT_GENERATOR_PREFERENCES.symbolLength),
    includeUppercase: pickFlag(source.includeUppercase, true),
    includeLowercase: pickFlag(source.includeLowercase, true),
    includeNumbers: pickFlag(source.includeNumbers, true),
    includeSymbols: pickFlag(source.includeSymbols, true),
    useSymbolExclusionMode: pickFlag(source.useSymbolExclusionMode, true),
    excludedSymbols: sanitizeSet(source.excludedSymbols, [...DEFAULT_SYMBOLS]),
    customSymbols: sanitizeSet(source.customSymbols) || DEFAULT_GENERATOR_PREFERENCES.customSymbols,
    excludeSimilar: pickFlag(source.excludeSimilar, true),
    excludeAmbiguous: pickFlag(source.excludeAmbiguous, false),
    uppercaseMin: clampMin(source.uppercaseMin, DEFAULT_GENERATOR_PREFERENCES.uppercaseMin),
    lowercaseMin: clampMin(source.lowercaseMin, DEFAULT_GENERATOR_PREFERENCES.lowercaseMin),
    numbersMin: clampMin(source.numbersMin, DEFAULT_GENERATOR_PREFERENCES.numbersMin),
    symbolsMin: clampMin(source.symbolsMin, DEFAULT_GENERATOR_PREFERENCES.symbolsMin),
    passphraseWordCount: clampInteger(source.passphraseWordCount, 1, 32, DEFAULT_GENERATOR_PREFERENCES.passphraseWordCount),
    passphraseDelimiter: boundedText(source.passphraseDelimiter, 8) || DEFAULT_GENERATOR_PREFERENCES.passphraseDelimiter,
    passphraseCapitalize: pickFlag(source.passphraseCapitalize, false),
    passphraseIncludeNumber: pickFlag(source.passphraseIncludeNumber, false),
    passphraseCustomWord: boundedText(source.passphraseCustomWord, 256),
    pinLength: clampInteger(source.pinLength, 1, 128, DEFAULT_GENERATOR_PREFERENCES.pinLength),
    passwordLength: clampInteger(source.passwordLength, 4, 128, DEFAULT_GENERATOR_PREFERENCES.passwordLength),
    firstLetterUppercase: pickFlag(source.firstLetterUppercase, false),
    includeNumbersInPassword: pickFlag(source.includeNumbersInPassword, true),
    customSeparator: boundedText(source.customSeparator, 8),
    separatorCountsTowardsLength: pickFlag(source.separatorCountsTowardsLength, false),
    segmentLength: clampInteger(source.segmentLength, 0, 20, DEFAULT_GENERATOR_PREFERENCES.segmentLength),
    sshKeyAlgorithm: source.sshKeyAlgorithm === "RSA" ? "RSA" : DEFAULT_GENERATOR_PREFERENCES.sshKeyAlgorithm,
    sshKeyRsaSize: SSH_RSA_SIZES.includes(coerceNumber(source.sshKeyRsaSize)) ? coerceNumber(source.sshKeyRsaSize) : DEFAULT_GENERATOR_PREFERENCES.sshKeyRsaSize
  };
}

export function resolveAllowedSymbols(preferences: GeneratorPreferences): string {
  if (!preferences.useSymbolExclusionMode) return preferences.customSymbols;
  return [...DEFAULT_SYMBOLS].filter((symbol) => !preferences.excludedSymbols.includes(symbol)).join("");
}

interface PreferencesStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(key: string, value: unknown): Promise<void>;
}

function chromeStorageLocal(): PreferencesStorage {
  return {
    async get(key) { return chrome.storage.local.get(key) as Promise<Record<string, unknown>>; },
    async set(key, value) { await chrome.storage.local.set({ [key]: value }); }
  };
}

export class GeneratorPreferencesStore {
  private readonly storage: PreferencesStorage;

  constructor(storage: PreferencesStorage = chromeStorageLocal()) { this.storage = storage; }

  async load(): Promise<GeneratorPreferences> {
    try {
      const stored = (await this.storage.get(GENERATOR_PREFERENCES_STORAGE_KEY))[GENERATOR_PREFERENCES_STORAGE_KEY];
      if (stored === undefined || stored === null || typeof stored === "string") {
        if (typeof stored !== "string") return normalizeGeneratorPreferences(undefined);
        try { return normalizeGeneratorPreferences(JSON.parse(stored)); } catch { return normalizeGeneratorPreferences(undefined); }
      }
      return normalizeGeneratorPreferences(stored);
    } catch {
      return normalizeGeneratorPreferences(undefined);
    }
  }

  async save(preferences: GeneratorPreferences): Promise<void> {
    await this.storage.set(GENERATOR_PREFERENCES_STORAGE_KEY, normalizeGeneratorPreferences(preferences));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickMode(value: unknown): GeneratorMode {
  return GENERATOR_MODES.includes(value as GeneratorMode) ? value as GeneratorMode : DEFAULT_GENERATOR_PREFERENCES.selectedGenerator;
}

function pickFlag(value: unknown, fallback: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

function coerceNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Math.trunc(Number(value));
  return Number.NaN;
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = coerceNumber(value);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function clampMin(value: unknown, fallback: number): number {
  const parsed = coerceNumber(value);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0, Math.min(256, parsed));
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function sanitizeSet(value: unknown, allowed?: string[]): string {
  if (typeof value !== "string") return "";
  const seen = new Set<string>();
  const output: string[] = [];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || seen.has(character)) continue;
    if (allowed && !allowed.includes(character)) continue;
    seen.add(character);
    output.push(character);
    if (output.length >= MAX_SYMBOL_SET_LENGTH) break;
  }
  return output.join("");
}
