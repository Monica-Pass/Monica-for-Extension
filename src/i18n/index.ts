import { computed, ref } from "vue";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export type Locale = "en" | "zh-CN";
export type MessageKey = keyof typeof en;

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  en,
  "zh-CN": zhCN
};

const storageKey = "monica.locale";
const defaultLocale: Locale = navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";

export const locale = ref<Locale>(readLocale());
export const locales: Locale[] = ["zh-CN", "en"];

export const languageLabel = computed(() => ({
  en: "English",
  "zh-CN": "简体中文"
}));

export function setLocale(value: Locale) {
  locale.value = value;
  localStorage.setItem(storageKey, value);
  document.documentElement.lang = value;
}

export function t(key: MessageKey, params: Record<string, string | number> = {}) {
  const template = dictionaries[locale.value][key] ?? dictionaries.en[key] ?? key;
  return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), template);
}

function readLocale(): Locale {
  const stored = localStorage.getItem(storageKey);
  return stored === "en" || stored === "zh-CN" ? stored : defaultLocale;
}

document.documentElement.lang = locale.value;
