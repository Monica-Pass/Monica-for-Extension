import english from "./ui-en.json";
import { browserLocale, validLocalePreference, type UiLocale, type UiLocalePreference } from "./locales";

export { browserLocale, validLocale, validLocalePreference, localeOptions, type UiLocale, type UiLocalePreference } from "./locales";
export const UI_LOCALE_KEY = "monica.locale";
let currentLocale: UiLocale = "zh-CN";
let currentPreference: UiLocalePreference = "system";
let requestedPreference: UiLocalePreference = "system";
let revision = 0;
const listeners = new Set<(locale: UiLocale, preference: UiLocalePreference) => void>();
const englishDictionary = english as Record<string, string>;
const catalogs = new Map<UiLocale, Record<string, string>>([["en", englishDictionary]]);
const pendingCatalogs = new Map<UiLocale, Promise<void>>();

function pruneCatalogs(latest: UiLocale): void {
  for (const language of catalogs.keys()) {
    if (catalogs.size <= 3) break;
    if (language !== "en" && language !== currentLocale && language !== latest) catalogs.delete(language);
  }
}

export function getUiLocale(): UiLocale { return currentLocale; }
export function getUiLocalePreference(): UiLocalePreference { return currentPreference; }

function publishLocale(value: UiLocale, preference: UiLocalePreference): void {
  currentLocale = value;
  currentPreference = requestedPreference = preference;
  listeners.forEach((listener) => listener(value, preference));
}

/** Synchronous updates are used for already loaded languages and test fixtures. */
export function updateUiLocale(value: UiLocale, preference: UiLocalePreference = value): void {
  revision++;
  publishLocale(value, preference);
}
export function observeUiLocale(listener: (locale: UiLocale, preference: UiLocalePreference) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const parameters = (text: string) => (text.match(/\{\w+\}/g) || []).sort().join("|");

/** Catalogs are extension-owned, offline resources. Never request a translation service. */
export function loadUiLocale(language: UiLocale): Promise<void> {
  if (language === "zh-CN" || catalogs.has(language)) return Promise.resolve();
  let pending = pendingCatalogs.get(language);
  if (!pending) {
    pending = (async () => {
      const resource = `locales/ui-${language}.json`;
      const url = typeof chrome !== "undefined" && chrome.runtime?.getURL
        ? chrome.runtime.getURL(resource)
        : new URL(resource, document.baseURI).href;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("The selected language could not be loaded.");
      const catalog: unknown = await response.json();
      if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("Invalid language catalog.");
      const validated: Record<string, string> = Object.create(null);
      for (const [key, source] of Object.entries(englishDictionary)) {
        const value = Object.prototype.hasOwnProperty.call(catalog, key) ? (catalog as Record<string, unknown>)[key] : undefined;
        if (typeof value !== "string" || !value.trim() || parameters(value) !== parameters(source)) throw new Error("Incomplete language catalog.");
        validated[key] = value;
      }
      catalogs.set(language, validated);
      pruneCatalogs(language);
    })().finally(() => { pendingCatalogs.delete(language); });
    pendingCatalogs.set(language, pending);
  }
  return pending;
}

/** A slower previous request must not replace the user's most recent selection. */
export async function selectUiLocale(preference: UiLocalePreference): Promise<boolean> {
  const request = ++revision;
  requestedPreference = preference;
  const language = preference === "system" ? browserLocale() : preference;
  try { await loadUiLocale(language); }
  catch (error) {
    if (request === revision) requestedPreference = currentPreference;
    throw error;
  }
  if (request !== revision) return false;
  publishLocale(language, preference);
  return true;
}

function translatedMessage(source: string, language: UiLocale): string | undefined {
  const catalog = catalogs.get(language);
  if (catalog && Object.prototype.hasOwnProperty.call(catalog, source)) return catalog[source];
  return Object.prototype.hasOwnProperty.call(englishDictionary, source) ? englishDictionary[source] : undefined;
}

/** Translate only application-owned text. Vault titles, notes and secrets are never passed here. */
export function tr(source: string, params: Record<string, unknown> = {}, language: UiLocale = currentLocale): string {
  const template = language === "zh-CN" ? source : translatedMessage(source, language) ?? source;
  return template.replace(/\{(\w+)\}/g, (token, name: string) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token);
}

let initialization: Promise<void> | undefined;
export function initializeUiLocale(legacyPreference?: unknown): Promise<void> {
  return initialization ||= (async () => {
    const initialRevision = revision;
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[UI_LOCALE_KEY]) {
          const next = changes[UI_LOCALE_KEY].newValue;
          void selectUiLocale(validLocalePreference(next) ? next : "system").catch(() => undefined);
        }
      });
    }
    if (typeof window !== "undefined") {
      window.addEventListener("languagechange", () => {
        if (requestedPreference === "system") void selectUiLocale("system").catch(() => undefined);
      });
    }
    let value: UiLocalePreference = "system";
    try {
      const saved = await chrome.storage.local.get(UI_LOCALE_KEY);
      if (validLocalePreference(saved[UI_LOCALE_KEY])) value = saved[UI_LOCALE_KEY];
      else if (validLocalePreference(legacyPreference)) {
        value = legacyPreference;
        await chrome.storage.local.set({ [UI_LOCALE_KEY]: value });
      }
    } catch { /* Browser language also works in an offline preview. */ }
    if (revision === initialRevision) {
      try { await selectUiLocale(value); }
      catch { await selectUiLocale("en"); }
    }
  })();
}

export function translateRuntimeError(message: string): string {
  if (currentLocale === "zh-CN") return message;
  const exact = translatedMessage(message, currentLocale);
  if (exact) return exact;
  // Templates are anchored and bounded. Interpolated provider data is left verbatim.
  if (message.length > 4096) return message;
  for (const source of Object.keys(englishDictionary)) {
    if (!/\{\d+\}/.test(source)) continue;
    const names: string[] = [];
    const pattern = source.split(/(\{\d+\})/).map((part) => {
      if (/^\{\d+\}$/.test(part)) { names.push(part.slice(1, -1)); return "([\\s\\S]*?)"; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    const match = new RegExp(`^${pattern}$`).exec(message);
    if (match) return (translatedMessage(source, currentLocale) ?? source).replace(/\{(\d+)\}/g, (token, name: string) => match[names.indexOf(name) + 1] ?? token);
  }
  return message;
}
