export const HOME_MODULES = ["frequent", "favorites", "types", "folders", "databases", "lifecycle"] as const;
export type HomeModuleId = typeof HOME_MODULES[number];
export const MAX_HOME_PINS = 24;

export interface HomePreferences {
  version: 1;
  order: HomeModuleId[];
  hidden: HomeModuleId[];
  collapsedModules: HomeModuleId[];
  pinnedItemIds: string[];
  suggestFrequent: boolean;
  favoritesExpanded: boolean;
  density: "comfortable" | "compact";
  startupSource: "all" | "fixed" | "last";
  preferredSourceId: string;
  lastSourceId: string;
}

/** Preferences contain identifiers only and live inside the encrypted vault. */
export function normalizeHomePreferences(input?: unknown): HomePreferences {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const modules = (value: unknown): HomeModuleId[] => Array.isArray(value)
    ? [...new Set(value.filter((id): id is HomeModuleId => HOME_MODULES.includes(id as HomeModuleId)))] : [];
  const order = modules(raw.order);
  const sourceId = (value: unknown, fallback: string) => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : fallback;
  return {
    version: 1,
    order: [...order, ...HOME_MODULES.filter(id => !order.includes(id))],
    hidden: modules(raw.hidden),
    collapsedModules: modules(raw.collapsedModules ?? ["databases"]).filter(id => id !== "favorites" && id !== "lifecycle"),
    pinnedItemIds: Array.isArray(raw.pinnedItemIds)
      ? [...new Set(raw.pinnedItemIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256))].slice(0, MAX_HOME_PINS) : [],
    suggestFrequent: raw.suggestFrequent !== false,
    favoritesExpanded: raw.favoritesExpanded !== false,
    density: raw.density === "comfortable" ? "comfortable" : "compact",
    startupSource: raw.startupSource === "all" || raw.startupSource === "fixed" ? raw.startupSource : "last",
    preferredSourceId: sourceId(raw.preferredSourceId, "local"),
    lastSourceId: sourceId(raw.lastSourceId, "all")
  };
}

export function homeStartupSource(preferences: HomePreferences, availableIds: readonly string[]): { id: string; missing: boolean } {
  const requested = preferences.startupSource === "fixed" ? preferences.preferredSourceId : preferences.startupSource === "last" ? preferences.lastSourceId : "all";
  const missing = requested !== "all" && !availableIds.includes(requested);
  return { id: missing ? "all" : requested, missing };
}
