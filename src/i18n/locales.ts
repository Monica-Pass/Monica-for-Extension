/** Native names remain readable even when the current interface language is unfamiliar. */
export const localeOptions = [
  { value: "zh-CN", label: "简体中文", manifest: "zh_CN" },
  { value: "en", label: "English", manifest: "en" },
  { value: "ja", label: "日本語", manifest: "ja" },
  { value: "ko", label: "한국어", manifest: "ko" },
  { value: "de", label: "Deutsch", manifest: "de" },
  { value: "es", label: "Español", manifest: "es" },
  { value: "ru", label: "Русский", manifest: "ru" },
  { value: "vi", label: "Tiếng Việt", manifest: "vi" }
] as const;

export type UiLocale = typeof localeOptions[number]["value"];
export type UiLocalePreference = UiLocale | "system";

export function validLocale(value: unknown): value is UiLocale {
  return localeOptions.some((option) => option.value === value);
}

export function validLocalePreference(value: unknown): value is UiLocalePreference {
  return value === "system" || validLocale(value);
}

export function browserLocale(): UiLocale {
  if (typeof navigator === "undefined") return "en";
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const language of languages) {
    const base = language.toLowerCase().replace(/_/g, "-").split("-")[0];
    if (base === "zh") return "zh-CN";
    if (validLocale(base)) return base;
  }
  return "en";
}
