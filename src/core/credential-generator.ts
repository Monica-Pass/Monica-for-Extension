export const DEFAULT_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DEFAULT_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const DEFAULT_NUMBERS = "0123456789";
export const DEFAULT_SYMBOLS = "!@#$%^&*()_+-=[]{}|;:,.<>?";
export const SIMILAR_CHARACTERS = "0Ol1I";
export const AMBIGUOUS_CHARACTERS = "{}[]()/\\'\"`~,;:.<>";

export interface PasswordGeneratorConfig {
  length: number;
  uppercaseChars?: string;
  lowercaseChars?: string;
  numberChars?: string;
  symbolChars?: string;
  uppercaseMin?: number;
  lowercaseMin?: number;
  numbersMin?: number;
  symbolsMin?: number;
  excludeSimilar?: boolean;
  excludeAmbiguous?: boolean;
}

export interface PassphraseGeneratorConfig {
  length: number;
  delimiter?: string;
  capitalize?: boolean;
  includeNumber?: boolean;
  customWord?: string;
  wordlist?: string[];
}

export type RandomIndex = (upperExclusive: number) => number;

export function generatePassword(config: PasswordGeneratorConfig, randomIndex: RandomIndex = secureRandomIndex): string {
  const length = integer(config.length, 1, 256, "密码长度必须在 1 到 256 之间。");
  const excluded = `${config.excludeSimilar ? SIMILAR_CHARACTERS : ""}${config.excludeAmbiguous ? AMBIGUOUS_CHARACTERS : ""}`;
  const filter = (value: string) => [...new Set([...value].filter((character) => !excluded.includes(character)))].join("");
  const groups = [
    { chars: filter(config.uppercaseChars ?? DEFAULT_UPPERCASE), minimum: minimum(config.uppercaseMin) },
    { chars: filter(config.lowercaseChars ?? DEFAULT_LOWERCASE), minimum: minimum(config.lowercaseMin) },
    { chars: filter(config.numberChars ?? DEFAULT_NUMBERS), minimum: minimum(config.numbersMin) },
    { chars: filter(config.symbolChars ?? DEFAULT_SYMBOLS), minimum: minimum(config.symbolsMin) }
  ];
  const required = groups.reduce((sum, group) => sum + group.minimum, 0);
  if (required > length) throw new Error("字符最小数量之和不能超过密码长度。");
  for (const group of groups) if (group.minimum && !group.chars) throw new Error("已启用的字符类型经过排除后没有可用字符。");
  const allChars = [...new Set(groups.flatMap((group) => [...group.chars]))].join("");
  if (!allChars) throw new Error("请至少启用一种字符类型。");
  const output: string[] = [];
  for (const group of groups) for (let count = 0; count < group.minimum; count += 1) output.push(pick(group.chars, randomIndex));
  while (output.length < length) output.push(pick(allChars, randomIndex));
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = randomIndex(index + 1);
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output.join("");
}

export function generatePin(length: number, randomIndex: RandomIndex = secureRandomIndex): string {
  const resolved = integer(length, 1, 128, "PIN 长度必须在 1 到 128 之间。");
  return Array.from({ length: resolved }, () => String(randomIndex(10))).join("");
}

export function generatePassphrase(config: PassphraseGeneratorConfig, randomIndex: RandomIndex = secureRandomIndex): string {
  const length = integer(config.length, 1, 32, "短语单词数必须在 1 到 32 之间。");
  const words = (config.wordlist?.length ? config.wordlist : FALLBACK_WORDLIST).map((word) => word.trim()).filter(Boolean);
  if (!words.length) throw new Error("词表不能为空。");
  const customWord = config.customWord?.trim();
  const customIndex = customWord ? randomIndex(length) : -1;
  const phrase = Array.from({ length }, (_, index) => index === customIndex ? customWord! : pick(words, randomIndex));
  const normalized = phrase.map((word) => config.capitalize ? word.replace(/^./u, (character) => character.toLocaleUpperCase()) : word);
  if (config.includeNumber) {
    const target = randomIndex(length);
    const [start, count] = length === 1 ? [1000, 9000] : length === 2 ? [100, 900] : [10, 90];
    normalized[target] += String(start + randomIndex(count));
  }
  return normalized.join(config.delimiter ?? "-");
}

export function passwordStrengthBits(value: string): number {
  if (!value) return 0;
  let alphabet = 0;
  if (/[A-Z]/.test(value)) alphabet += 26;
  if (/[a-z]/.test(value)) alphabet += 26;
  if (/\d/.test(value)) alphabet += 10;
  if (/[^A-Za-z0-9]/.test(value)) alphabet += DEFAULT_SYMBOLS.length;
  return Math.round(value.length * Math.log2(Math.max(alphabet, 1)));
}

function secureRandomIndex(upperExclusive: number): number {
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive <= 0 || upperExclusive > 0x1_0000_0000) throw new Error("随机范围无效。");
  const limit = Math.floor(0x1_0000_0000 / upperExclusive) * upperExclusive;
  const values = new Uint32Array(1);
  do crypto.getRandomValues(values); while (values[0] >= limit);
  return values[0] % upperExclusive;
}

function pick(value: string | string[], randomIndex: RandomIndex): string { return value[randomIndex(value.length)]; }
function minimum(value: unknown): number { return integer(value ?? 0, 0, 256, "字符最小数量无效。"); }
function integer(value: unknown, min: number, max: number, message: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(message); return parsed; }

const FALLBACK_WORDLIST = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu"];
