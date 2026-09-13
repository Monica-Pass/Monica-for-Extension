import { ref } from "vue";
import { en } from "./en";
import { zhCN } from "./zh-CN";
import { browserLocale, getUiLocale, getUiLocalePreference, initializeUiLocale, localeOptions, observeUiLocale, selectUiLocale, tr as translateUi, UI_LOCALE_KEY, updateUiLocale, validLocalePreference, type UiLocale, type UiLocalePreference } from "./runtime";

export type Locale = UiLocale;
export type LocalePreference = UiLocalePreference;
export type MessageKey = keyof typeof en;

const storageKey = UI_LOCALE_KEY;

export const localePreference = ref<LocalePreference>(readPreference());
export const locale = ref<Locale>(typeof window === "undefined" ? getUiLocale() : localePreference.value === "system" ? browserLocale() : localePreference.value);
updateUiLocale(locale.value, localePreference.value);
observeUiLocale((value, preference) => {
  locale.value = value;
  localePreference.value = preference;
  if (typeof document !== "undefined") document.documentElement.lang = value;
});
export { localeOptions };
export const locales: Locale[] = localeOptions.map((option) => option.value);

export async function setLocale(value: LocalePreference) {
  if (!validLocalePreference(value) || !await selectUiLocale(value)) return;
  try { localStorage.setItem(storageKey, value); } catch { /* Memory preference remains usable. */ }
  if (typeof chrome !== "undefined" && chrome.storage?.local) void chrome.storage.local.set({ [storageKey]: value }).catch(() => undefined);
}

export async function initializeI18n() {
  let legacyPreference: string | null = null;
  try { legacyPreference = localStorage.getItem(storageKey); } catch { /* No legacy preference in this environment. */ }
  await initializeUiLocale(legacyPreference);
}
export function tr(source: string, params: Record<string, unknown> = {}): string { return translateUi(source, params, locale.value); }

export function t(key: MessageKey, params: Record<string, string | number> = {}) {
  const template = locale.value === "en" ? en[key] : translateUi(zhCN[key] ?? key, {}, locale.value);
  return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), template);
}

function readPreference(): LocalePreference {
  if (typeof window === "undefined") return getUiLocalePreference();
  try { const stored = localStorage.getItem(storageKey); if (validLocalePreference(stored)) return stored; } catch { /* Fall back to the browser. */ }
  return "system";
}

if (typeof document !== "undefined") document.documentElement.lang = locale.value;
